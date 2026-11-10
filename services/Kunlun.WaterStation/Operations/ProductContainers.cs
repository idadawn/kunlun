using Npgsql;
using static Kunlun.WaterStation.Operations.TicketBatches;

namespace Kunlun.WaterStation.Operations;

/// <summary>One reusable-container account per water product. Legacy container_type fields carry this account's ID, not its physical kind.</summary>
public static class ProductContainers
{
    public static string JsonOf(string member) => $"""
        COALESCE((SELECT jsonb_agg(jsonb_build_object('containerType',h.container_type,'name',p.name,'containerKind',p.container_type,'quantity',h.quantity) ORDER BY p.created_at,p.water_type)
          FROM plugin_kunlun_waterstation.member_container_holdings h
          JOIN plugin_kunlun_waterstation.water_products p ON p.tenant_id=h.tenant_id AND p.container_id=h.container_type
          WHERE h.tenant_id={member}.tenant_id AND h.member_id={member}.id AND h.quantity>0),'[]'::jsonb)::text
        """;

    public static bool ValidId(string? id) => id is not null && System.Text.RegularExpressions.Regex.IsMatch(id, "^[A-Z0-9_]{1,16}$");

    public static async Task EnsureSchema(NpgsqlDataSource db, Guid tid)
    {
        await using var conn = await db.OpenConnectionAsync();
        await using var tx = await conn.BeginTransactionAsync();
        await Exec(conn, tx, "SELECT pg_advisory_xact_lock(88482026)", default);
        await Exec(conn, tx, """
            CREATE TABLE IF NOT EXISTS plugin_kunlun_waterstation.member_container_holdings (
              tenant_id UUID NOT NULL, member_id UUID NOT NULL REFERENCES plugin_kunlun_waterstation.members(id),
              container_type VARCHAR(16) NOT NULL, quantity INT NOT NULL DEFAULT 0 CHECK(quantity>=0),
              PRIMARY KEY(tenant_id,member_id,container_type),
              FOREIGN KEY(tenant_id,container_type) REFERENCES plugin_kunlun_waterstation.container_configs(tenant_id,container_type)
            );
            ALTER TABLE plugin_kunlun_waterstation.container_damages DROP CONSTRAINT IF EXISTS container_damages_container_type_check;
            ALTER TABLE plugin_kunlun_waterstation.refund_requests DROP CONSTRAINT IF EXISTS refund_requests_container_type_check;
            """, default);
        var first = await Exec(conn, tx, "INSERT INTO plugin_kunlun_waterstation.finance_migrations VALUES(@tid,'product-containers-v1') ON CONFLICT DO NOTHING", default, ("tid", tid));
        if (first > 0)
        {
            // A shared historical pool cannot be arbitrarily split between multiple products.
            await using var ambiguous = Command(conn, tx, """
                SELECT EXISTS(SELECT 1 FROM plugin_kunlun_waterstation.water_products p
                  WHERE p.tenant_id=@tid AND p.water_type NOT IN ('BUCKET_18_9L','BAG_7_5L')
                  AND (EXISTS(SELECT 1 FROM plugin_kunlun_waterstation.water_orders o
                    WHERE o.tenant_id=p.tenant_id AND o.water_type=p.water_type)
                    OR EXISTS(SELECT 1 FROM plugin_kunlun_waterstation.container_configs c
                      WHERE c.tenant_id=p.tenant_id AND c.container_type=p.container_type AND (c.total_qty>0 OR c.scrapped_qty>0))
                    OR EXISTS(SELECT 1 FROM plugin_kunlun_waterstation.deposit_lots l
                      WHERE l.tenant_id=p.tenant_id AND l.container_type=p.container_type)
                    OR EXISTS(SELECT 1 FROM plugin_kunlun_waterstation.container_ledgers l
                      WHERE l.tenant_id=p.tenant_id AND l.container_type=p.container_type)))
                """, ("tid", tid));
            if ((bool)(await ambiguous.ExecuteScalarAsync())!)
                throw new InvalidOperationException("旧水品曾共用容器且已有库存或业务记录，需核对旧桶袋归属后再迁移，不能自动分摊库存和押金。");
            await Exec(conn, tx, """
                INSERT INTO plugin_kunlun_waterstation.container_configs(tenant_id,container_type,unit_deposit,total_qty,in_station_qty,member_held_qty,damaged_qty,scrapped_qty,unregistered_out_qty)
                SELECT p.tenant_id,p.container_id,c.unit_deposit,0,0,0,0,0,0 FROM plugin_kunlun_waterstation.water_products p
                JOIN plugin_kunlun_waterstation.container_configs c ON c.tenant_id=p.tenant_id AND c.container_type=p.container_type
                WHERE p.tenant_id=@tid AND NOT EXISTS(SELECT 1 FROM plugin_kunlun_waterstation.container_configs existing
                  WHERE existing.tenant_id=p.tenant_id AND existing.container_type=p.container_id);
                INSERT INTO plugin_kunlun_waterstation.member_container_holdings(tenant_id,member_id,container_type,quantity)
                SELECT tenant_id,id,'BUCKET',held_buckets FROM plugin_kunlun_waterstation.members WHERE tenant_id=@tid
                UNION ALL SELECT tenant_id,id,'BAG',held_bags FROM plugin_kunlun_waterstation.members WHERE tenant_id=@tid;
                """, default, ("tid", tid));
        }
        await tx.CommitAsync();
    }

    public static async Task Require(NpgsqlConnection conn, NpgsqlTransaction? tx, Guid tid, string id, CancellationToken ct)
    {
        await using var cmd = Command(conn, tx, "SELECT 1 FROM plugin_kunlun_waterstation.water_products WHERE tenant_id=@tid AND container_id=@id" + (tx is null ? "" : " FOR KEY SHARE"), ("tid", tid), ("id", id));
        if (await cmd.ExecuteScalarAsync(ct) is null) throw new BusinessRuleException("配套容器不存在，请选择水品对应的桶或袋");
    }

    public static async Task<int> Held(NpgsqlConnection conn, NpgsqlTransaction? tx, Guid tid, Guid mid, string id, CancellationToken ct)
    {
        await Require(conn, tx, tid, id, ct);
        await using var cmd = Command(conn, tx, "SELECT quantity FROM plugin_kunlun_waterstation.member_container_holdings WHERE tenant_id=@tid AND member_id=@mid AND container_type=@id", ("tid", tid), ("mid", mid), ("id", id));
        return Convert.ToInt32(await cmd.ExecuteScalarAsync(ct));
    }

    /// <summary>Caller holds the member lock. Keep kind totals for older read-only clients; business rules use the per-product balance.</summary>
    public static async Task SetHeld(NpgsqlConnection conn, NpgsqlTransaction tx, Guid tid, Guid mid, string id, int quantity, CancellationToken ct)
    {
        await Exec(conn, tx, """
            INSERT INTO plugin_kunlun_waterstation.member_container_holdings(tenant_id,member_id,container_type,quantity)
            VALUES(@tid,@mid,@id,@qty) ON CONFLICT(tenant_id,member_id,container_type) DO UPDATE SET quantity=excluded.quantity;
            UPDATE plugin_kunlun_waterstation.members m SET
              held_buckets=(SELECT COALESCE(sum(h.quantity),0) FROM plugin_kunlun_waterstation.member_container_holdings h
                JOIN plugin_kunlun_waterstation.water_products p ON p.tenant_id=h.tenant_id AND p.container_id=h.container_type
                WHERE h.tenant_id=m.tenant_id AND h.member_id=m.id AND p.container_type='BUCKET'),
              held_bags=(SELECT COALESCE(sum(h.quantity),0) FROM plugin_kunlun_waterstation.member_container_holdings h
                JOIN plugin_kunlun_waterstation.water_products p ON p.tenant_id=h.tenant_id AND p.container_id=h.container_type
                WHERE h.tenant_id=m.tenant_id AND h.member_id=m.id AND p.container_type='BAG')
            WHERE m.tenant_id=@tid AND m.id=@mid;
            """, ct, ("tid", tid), ("mid", mid), ("id", id), ("qty", quantity));
    }
}
