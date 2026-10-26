using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Kunlun.WaterStation.Auth;
using Npgsql;
using static Kunlun.WaterStation.Operations.TicketBatches;

namespace Kunlun.WaterStation.Operations;

public sealed record InventoryRequest(string ContainerType, string Action, string Reason, string IdempotencyKey,
    int Quantity = 0, string SourceState = "AVAILABLE", Guid? MemberId = null, int? CountedQuantity = null, int? ExpectedQuantity = null);
public sealed record InventoryBalance(int TotalQty, int InStationQty, int InTransitQty, int MemberHeldQty,
    int InspectingQty, int AbnormalQty, int DamagedQty, int ScrappedQty)
{
    public int At(string source) => source switch {
        "AVAILABLE" => InStationQty, "TRANSIT" => InTransitQty, "INSPECTING" => InspectingQty,
        "ABNORMAL" => AbnormalQty, "DAMAGED" => DamagedQty, "MEMBER" => MemberHeldQty, _ => throw new BusinessRuleException("破损来源无效")
    };
    public InventoryBalance Remove(string source, int qty) => source switch {
        "AVAILABLE" => this with { InStationQty = InStationQty - qty },
        "TRANSIT" => this with { InTransitQty = InTransitQty - qty },
        "INSPECTING" => this with { InspectingQty = InspectingQty - qty },
        "ABNORMAL" => this with { AbnormalQty = AbnormalQty - qty },
        "MEMBER" => this with { MemberHeldQty = MemberHeldQty - qty },
        "DAMAGED" => this with { DamagedQty = DamagedQty - qty },
        _ => throw new BusinessRuleException("破损来源无效")
    };
}

public static class ContainerInventory
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private static bool Authorized(ClaimsPrincipal user) => user.FindFirstValue("subject_type") == "STAFF" && user.HasClaim("perm", KunlunPermissions.ContainerInventoryManage);

    public static async Task EnsureSchema(NpgsqlDataSource db, Guid tid, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct); await using var tx = await conn.BeginTransactionAsync(ct);
        await Exec(conn, tx, """
            SELECT pg_advisory_xact_lock(88482026);
            ALTER TABLE plugin_kunlun_waterstation.container_configs ADD COLUMN IF NOT EXISTS damaged_qty INT NOT NULL DEFAULT 0;
            ALTER TABLE plugin_kunlun_waterstation.container_configs ADD COLUMN IF NOT EXISTS scrapped_qty INT NOT NULL DEFAULT 0;
            DO $$ BEGIN
              IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='plugin_kunlun_waterstation.container_configs'::regclass AND conname='container_assets_balance') THEN
                ALTER TABLE plugin_kunlun_waterstation.container_configs DROP CONSTRAINT IF EXISTS container_configs_check;
                ALTER TABLE plugin_kunlun_waterstation.container_configs ADD CONSTRAINT container_assets_balance
                  CHECK(total_qty=in_station_qty+in_transit_qty+member_held_qty+inspecting_qty+abnormal_qty+damaged_qty);
                ALTER TABLE plugin_kunlun_waterstation.container_configs ADD CONSTRAINT container_quantities_nonnegative
                  CHECK(total_qty>=0 AND in_station_qty>=0 AND in_transit_qty>=0 AND member_held_qty>=0 AND inspecting_qty>=0 AND abnormal_qty>=0 AND damaged_qty>=0 AND scrapped_qty>=0);
              END IF;
            END $$;
            CREATE TABLE IF NOT EXISTS plugin_kunlun_waterstation.container_inventory_operations (
              id UUID PRIMARY KEY, tenant_id UUID NOT NULL, operation_no VARCHAR(32) NOT NULL UNIQUE,
              idempotency_key VARCHAR(80) NOT NULL, request_hash VARCHAR(64) NOT NULL,
              container_type VARCHAR(16) NOT NULL, action VARCHAR(16) NOT NULL, source_state VARCHAR(16) NOT NULL,
              quantity INT NOT NULL, delta_total INT NOT NULL, member_id UUID,
              reason TEXT NOT NULL, operator_id UUID NOT NULL, operator_name VARCHAR(64) NOT NULL,
              before_state JSONB NOT NULL, after_state JSONB NOT NULL, receipt JSONB NOT NULL,
              created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(tenant_id,idempotency_key)
            );
            CREATE INDEX IF NOT EXISTS inventory_operations_recent ON plugin_kunlun_waterstation.container_inventory_operations(tenant_id,created_at DESC);
            WITH first_run AS (
              INSERT INTO plugin_kunlun_waterstation.finance_migrations VALUES(@tid,'reusable-bag-deposit-five-v1') ON CONFLICT DO NOTHING RETURNING 1
            )
            UPDATE plugin_kunlun_waterstation.container_configs SET unit_deposit=5
            WHERE tenant_id=@tid AND container_type='BAG' AND EXISTS(SELECT 1 FROM first_run);
            UPDATE plugin_kunlun_waterstation.staff
            SET permissions=permissions || '["kunlun.waterstation:container:inventory_manage"]'::jsonb,token_version=token_version+1
            WHERE tenant_id=@tid AND role='ADMIN' AND NOT(permissions ? 'kunlun.waterstation:container:inventory_manage');
            """, ct, ("tid", tid));
        await tx.CommitAsync(ct);
    }

    public static void MapContainerInventory(this WebApplication app)
    {
        app.MapPost("/api/containers/inventory", Execute).RequireAuthorization();
        app.MapGet("/api/containers/inventory-operations", async (string? containerType, ClaimsPrincipal user, NpgsqlDataSource db, KunlunAuthRepository repo, CancellationToken ct) =>
        {
            if (!Authorized(user)) return Results.Forbid();
            if (containerType is not (null or "BUCKET" or "BAG")) throw new BusinessRuleException("容器类型无效");
            await using var conn = await db.OpenConnectionAsync(ct);
            await using var cmd = Command(conn, null, """
                SELECT o.receipt::text,COALESCE(m.name,'')
                FROM plugin_kunlun_waterstation.container_inventory_operations o
                LEFT JOIN plugin_kunlun_waterstation.members m ON m.id=o.member_id AND m.tenant_id=o.tenant_id
                WHERE o.tenant_id=@tid AND (@type='' OR o.container_type=@type)
                ORDER BY o.created_at DESC,o.id DESC LIMIT 100
                """, ("tid", repo.DefaultTenantId), ("type", containerType ?? ""));
            var rows = new List<object>(); await using var r = await cmd.ExecuteReaderAsync(ct);
            while (await r.ReadAsync(ct)) rows.Add(new { operation = JsonSerializer.Deserialize<JsonElement>(r.GetString(0)), memberName = r.GetString(1) });
            return Results.Ok(rows);
        }).RequireAuthorization();
    }

    private static async Task<IResult> Execute(InventoryRequest req, ClaimsPrincipal user, NpgsqlDataSource db, KunlunAuthRepository repo, CancellationToken ct)
    {
        if (!Authorized(user)) return Results.Forbid();
        if (req.ContainerType is not ("BUCKET" or "BAG") || req.Action is not ("RECEIVE" or "DAMAGE" or "REPAIR" or "SCRAP" or "COUNT")
            || string.IsNullOrWhiteSpace(req.Reason) || req.Reason.Length > 500)
            throw new BusinessRuleException("请填写有效容器类型、业务类型和操作原因");
        if (req.Action == "COUNT")
        {
            if (req.CountedQuantity is null or < 0 or > 1000000 || req.ExpectedQuantity is null or < 0 || req.Quantity != 0)
                throw new BusinessRuleException("请填写实盘数量，并保留本次读取的账面数量");
        }
        else if (req.Quantity <= 0 || req.Quantity > 1000000) throw new BusinessRuleException("操作数量应为 1 至 1000000 的整数");
        if (req.Action == "DAMAGE" && req.SourceState is not ("AVAILABLE" or "TRANSIT" or "INSPECTING" or "ABNORMAL" or "MEMBER")) throw new BusinessRuleException("破损来源无效");
        if (req.Action == "COUNT" && req.SourceState is not ("AVAILABLE" or "TRANSIT" or "INSPECTING" or "ABNORMAL" or "DAMAGED")) throw new BusinessRuleException("盘点位置无效，会员持有应通过领还或破损归还登记处理");
        var fromMember = req.Action == "DAMAGE" && req.SourceState == "MEMBER";
        if (fromMember != req.MemberId.HasValue) throw new BusinessRuleException("会员归还破损需选择对应会员，其他操作不关联会员");
        var normalized = req with { Reason = req.Reason.Trim() };
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(normalized, JsonOptions))));
        var tid = repo.DefaultTenantId;
        await using var conn = await db.OpenConnectionAsync(ct); await using var tx = await conn.BeginTransactionAsync(ct);
        await LockRequest(conn, tx, tid, "inventory", req.IdempotencyKey, ct);
        await using (var replay = Command(conn, tx, "SELECT request_hash,receipt::text FROM plugin_kunlun_waterstation.container_inventory_operations WHERE tenant_id=@tid AND idempotency_key=@key", ("tid", tid), ("key", req.IdempotencyKey)))
        await using (var r = await replay.ExecuteReaderAsync(ct))
            if (await r.ReadAsync(ct))
            {
                if (r.GetString(0) != hash) throw new BusinessRuleException("该请求标识已用于其他库存操作", 409);
                return Results.Ok(JsonSerializer.Deserialize<JsonElement>(r.GetString(1)));
            }
        var heldColumn = req.ContainerType == "BUCKET" ? "held_buckets" : "held_bags";
        var memberHeld = 0;
        // Same lock order as fulfillment: member first, then container configuration.
        if (fromMember)
        {
            await using var member = Command(conn, tx, $"SELECT {heldColumn} FROM plugin_kunlun_waterstation.members WHERE tenant_id=@tid AND id=@id FOR UPDATE", ("tid", tid), ("id", req.MemberId!.Value));
            var value = await member.ExecuteScalarAsync(ct);
            if (value is null) throw new BusinessRuleException("会员不存在", 404);
            memberHeld = (int)value;
            if (memberHeld < req.Quantity) throw new BusinessRuleException("破损归还数量超过该会员持有数量");
        }
        InventoryBalance before;
        await using (var read = Command(conn, tx, """
            SELECT total_qty,in_station_qty,in_transit_qty,member_held_qty,inspecting_qty,abnormal_qty,damaged_qty,scrapped_qty
            FROM plugin_kunlun_waterstation.container_configs WHERE tenant_id=@tid AND container_type=@type FOR UPDATE
            """, ("tid", tid), ("type", req.ContainerType)))
        await using (var r = await read.ExecuteReaderAsync(ct))
        {
            if (!await r.ReadAsync(ct)) throw new BusinessRuleException("容器配置不存在", 404);
            before = new(r.GetInt32(0), r.GetInt32(1), r.GetInt32(2), r.GetInt32(3), r.GetInt32(4), r.GetInt32(5), r.GetInt32(6), r.GetInt32(7));
        }
        var after = before; var qty = req.Quantity;
        try
        {
            switch (req.Action)
            {
                case "RECEIVE": after = before with { TotalQty = checked(before.TotalQty + qty), InStationQty = checked(before.InStationQty + qty) }; break;
                case "DAMAGE":
                    if (before.At(req.SourceState) < qty) throw new BusinessRuleException("来源位置的数量不足");
                    after = before.Remove(req.SourceState, qty) with { DamagedQty = checked(before.DamagedQty + qty) }; break;
                case "REPAIR":
                    if (before.DamagedQty < qty) throw new BusinessRuleException("待处理破损数量不足");
                    after = before with { DamagedQty = before.DamagedQty - qty, InStationQty = checked(before.InStationQty + qty) }; break;
                case "SCRAP":
                    if (before.DamagedQty < qty) throw new BusinessRuleException("待处理破损数量不足");
                    after = before with { DamagedQty = before.DamagedQty - qty, TotalQty = before.TotalQty - qty, ScrappedQty = checked(before.ScrappedQty + qty) }; break;
                case "COUNT":
                    if (before.At(req.SourceState) != req.ExpectedQuantity) throw new BusinessRuleException("账面库存已变化，请刷新后重新盘点", 409);
                    qty = req.CountedQuantity!.Value - before.At(req.SourceState);
                    after = before.Remove(req.SourceState, -qty) with { TotalQty = checked(before.TotalQty + qty) }; break;
            }
        }
        catch (OverflowException) { throw new BusinessRuleException("库存数量超出允许范围"); }
        if (after.TotalQty < 0) throw new BusinessRuleException("调整后现存总量不能为负数");
        await Exec(conn, tx, """
            UPDATE plugin_kunlun_waterstation.container_configs
            SET total_qty=@total,in_station_qty=@available,in_transit_qty=@transit,member_held_qty=@held,
                inspecting_qty=@inspect,abnormal_qty=@abnormal,damaged_qty=@damaged,scrapped_qty=@scrapped
            WHERE tenant_id=@tid AND container_type=@type
            """, ct, ("tid", tid), ("type", req.ContainerType), ("total", after.TotalQty), ("available", after.InStationQty), ("transit", after.InTransitQty), ("held", after.MemberHeldQty), ("inspect", after.InspectingQty), ("abnormal", after.AbnormalQty), ("damaged", after.DamagedQty), ("scrapped", after.ScrappedQty));
        var id = Guid.NewGuid(); var no = "CK" + id.ToString("N")[..28];
        var actor = user.FindFirstValue("display_name") ?? "管理员";
        if (fromMember)
        {
            await Exec(conn, tx, $"UPDATE plugin_kunlun_waterstation.members SET {heldColumn}={heldColumn}-@qty WHERE id=@id AND tenant_id=@tid", ct, ("qty", req.Quantity), ("id", req.MemberId!.Value), ("tid", tid));
            await using var covered = Command(conn, tx, "SELECT COALESCE(sum(remaining_qty),0) FROM plugin_kunlun_waterstation.deposit_lots WHERE tenant_id=@tid AND member_id=@id AND container_type=@type", ("tid", tid), ("id", req.MemberId.Value), ("type", req.ContainerType));
            var paid = Convert.ToInt32(await covered.ExecuteScalarAsync(ct));
            await Exec(conn, tx, """
                INSERT INTO plugin_kunlun_waterstation.container_ledgers(tenant_id,ledger_no,member_id,container_type,order_no,full_out_qty,empty_in_qty,delta_held,held_after,covered_deposit_qty_after,operator_name,remark)
                VALUES(@tid,@no,@id,@type,@ref,0,@qty,-@qty,@held,@paid,@actor,@reason)
                """, ct, ("tid", tid), ("no", "CL" + id.ToString("N")[..28]), ("id", req.MemberId.Value), ("type", req.ContainerType), ("ref", no), ("qty", req.Quantity), ("held", memberHeld - req.Quantity), ("paid", paid), ("actor", actor), ("reason", "破损归还：" + normalized.Reason));
        }
        var source = req.Action switch { "RECEIVE" => "EXTERNAL", "REPAIR" or "SCRAP" => "DAMAGED", _ => req.SourceState };
        var receipt = new { id, operationNo = no, containerType = req.ContainerType, action = req.Action, sourceState = source, quantity = qty, deltaTotal = after.TotalQty - before.TotalQty,
            memberId = req.MemberId, reason = normalized.Reason, operatorName = actor, before, after, createdAt = DateTimeOffset.UtcNow };
        var json = JsonSerializer.Serialize(receipt, JsonOptions);
        await Exec(conn, tx, """
            INSERT INTO plugin_kunlun_waterstation.container_inventory_operations
            (id,tenant_id,operation_no,idempotency_key,request_hash,container_type,action,source_state,quantity,delta_total,member_id,reason,operator_id,operator_name,before_state,after_state,receipt)
            VALUES(@id,@tid,@no,@key,@hash,@type,@action,@source,@qty,@delta,NULLIF(@member,'')::uuid,@reason,@operator,@actor,@before::jsonb,@after::jsonb,@receipt::jsonb)
            """, ct, ("id", id), ("tid", tid), ("no", no), ("key", req.IdempotencyKey), ("hash", hash), ("type", req.ContainerType), ("action", req.Action), ("source", source), ("qty", qty), ("delta", after.TotalQty - before.TotalQty), ("member", req.MemberId?.ToString() ?? ""), ("reason", normalized.Reason), ("operator", Guid.Parse(user.FindFirstValue("sub")!)), ("actor", actor), ("before", JsonSerializer.Serialize(before, JsonOptions)), ("after", JsonSerializer.Serialize(after, JsonOptions)), ("receipt", json));
        await tx.CommitAsync(ct);
        return Results.Ok(receipt);
    }
}
