using Npgsql;
using static Kunlun.WaterStation.Operations.TicketBatches;

namespace Kunlun.WaterStation.Operations;

/// <summary>
/// 会员水票余额：每种水品、每种领取方式一行（可用 + 预占），各水品互不通用。批次 ticket_batches 记来源和原价，
/// 这里是余额汇总，两者在同一事务里一起变；调用方先锁会员行。
/// </summary>
public static class MemberTickets
{
    // The four balances members carried as columns before the station could add water products.
    private static readonly (string Water, string Mode, string Available, string Reserved)[] Legacy =
    [
        ("BUCKET_18_9L", "DELIVERY", "bucket_delivery_tickets", "reserved_bucket_delivery_tickets"),
        ("BUCKET_18_9L", "PICKUP", "bucket_pickup_tickets", "reserved_bucket_pickup_tickets"),
        ("BAG_7_5L", "PICKUP", "bag_pickup_tickets", "reserved_bag_pickup_tickets"),
        ("BAG_7_5L", "DELIVERY", "bag_delivery_tickets", "reserved_bag_delivery_tickets"),
    ];

    /// <summary>The retired member columns of one balance; only migrations that run before <see cref="EnsureSchema"/> use them.</summary>
    public static (string Available, string Reserved) LegacyColumns(string water, string mode)
    {
        var c = Legacy.Single(l => l.Water == water && l.Mode == mode);
        return (c.Available, c.Reserved);
    }

    /// <summary>
    /// Creates member_tickets and moves the old per-member columns into it once, then drops them. Fresh databases still
    /// start with those columns (members table, demo data), so they take the same path.
    /// </summary>
    public static async Task EnsureSchema(NpgsqlConnection conn, NpgsqlTransaction tx, Guid tid, CancellationToken ct)
    {
        await Exec(conn, tx, """
            CREATE TABLE IF NOT EXISTS plugin_kunlun_waterstation.member_tickets (
              tenant_id UUID NOT NULL, member_id UUID NOT NULL REFERENCES plugin_kunlun_waterstation.members(id),
              water_type VARCHAR(24) NOT NULL, fulfill_mode VARCHAR(16) NOT NULL CHECK(fulfill_mode IN ('PICKUP','DELIVERY')),
              available INT NOT NULL DEFAULT 0 CHECK(available>=0), reserved INT NOT NULL DEFAULT 0 CHECK(reserved>=0),
              PRIMARY KEY(tenant_id,member_id,water_type,fulfill_mode)
            );
            """, ct);
        if (await Exec(conn, tx, "INSERT INTO plugin_kunlun_waterstation.membership_migrations VALUES(@tid,'member-tickets-v1') ON CONFLICT DO NOTHING", ct, ("tid", tid)) == 0) return;
        // The columns are table-wide, so every tenant's balances move before they are dropped.
        foreach (var c in Legacy)
            await Exec(conn, tx, $"""
                INSERT INTO plugin_kunlun_waterstation.member_tickets(tenant_id,member_id,water_type,fulfill_mode,available,reserved)
                SELECT tenant_id,id,@water,@mode,{c.Available},{c.Reserved} FROM plugin_kunlun_waterstation.members WHERE {c.Available}+{c.Reserved}>0
                ON CONFLICT DO NOTHING
                """, ct, ("water", c.Water), ("mode", c.Mode));
        await Exec(conn, tx, "ALTER TABLE plugin_kunlun_waterstation.members "
            + string.Join(",", Legacy.SelectMany(c => new[] { c.Available, c.Reserved }).Select(column => "DROP COLUMN IF EXISTS " + column)), ct);
    }

    /// <summary>Locks one balance; a member who never had these tickets has 0 available and 0 reserved.</summary>
    public static async Task<(int Available, int Reserved)> Lock(NpgsqlConnection conn, NpgsqlTransaction tx, Guid tid, Guid mid, string water, string mode, CancellationToken ct)
    {
        await using var cmd = Command(conn, tx, """
            SELECT available,reserved FROM plugin_kunlun_waterstation.member_tickets
            WHERE tenant_id=@tid AND member_id=@mid AND water_type=@water AND fulfill_mode=@mode FOR UPDATE
            """, ("tid", tid), ("mid", mid), ("water", water), ("mode", mode));
        await using var r = await cmd.ExecuteReaderAsync(ct);
        return await r.ReadAsync(ct) ? (r.GetInt32(0), r.GetInt32(1)) : (0, 0);
    }

    /// <summary>Applies both deltas and returns the new balance. Callers check that neither goes below zero; the table refuses it anyway.</summary>
    public static async Task<(int Available, int Reserved)> Add(NpgsqlConnection conn, NpgsqlTransaction tx, Guid tid, Guid mid, string water, string mode, int available, int reserved, CancellationToken ct)
    {
        // Update first: an INSERT .. ON CONFLICT would check its proposed row, which is negative when tickets are taken away.
        await using (var update = Command(conn, tx, """
            UPDATE plugin_kunlun_waterstation.member_tickets SET available=available+@available,reserved=reserved+@reserved
            WHERE tenant_id=@tid AND member_id=@mid AND water_type=@water AND fulfill_mode=@mode RETURNING available,reserved
            """, ("tid", tid), ("mid", mid), ("water", water), ("mode", mode), ("available", available), ("reserved", reserved)))
        await using (var r = await update.ExecuteReaderAsync(ct))
            if (await r.ReadAsync(ct)) return (r.GetInt32(0), r.GetInt32(1));
        await Exec(conn, tx, """
            INSERT INTO plugin_kunlun_waterstation.member_tickets(tenant_id,member_id,water_type,fulfill_mode,available,reserved)
            VALUES(@tid,@mid,@water,@mode,@available,@reserved)
            """, ct, ("tid", tid), ("mid", mid), ("water", water), ("mode", mode), ("available", available), ("reserved", reserved));
        return (available, reserved);
    }

    /// <summary>
    /// SQL for one member's non-empty balances as a JSON array (product name, container and unit included), oldest product first.
    /// <paramref name="member"/> is the alias of a members row in the enclosing query.
    /// </summary>
    public static string JsonOf(string member) => $"""
        COALESCE((SELECT json_agg(json_build_object('waterType',t.water_type,'name',COALESCE(p.name,t.water_type),
            'containerType',COALESCE(p.container_type,'BUCKET'),'unit',CASE p.container_type WHEN 'BAG' THEN '袋' ELSE '桶' END,
            'fulfillMode',t.fulfill_mode,'available',t.available,'reserved',t.reserved) ORDER BY p.created_at,t.water_type,t.fulfill_mode DESC)
          FROM plugin_kunlun_waterstation.member_tickets t
          LEFT JOIN plugin_kunlun_waterstation.water_products p ON p.tenant_id=t.tenant_id AND p.water_type=t.water_type
          WHERE t.tenant_id={member}.tenant_id AND t.member_id={member}.id AND t.available+t.reserved>0),'[]')::text
        """;
}
