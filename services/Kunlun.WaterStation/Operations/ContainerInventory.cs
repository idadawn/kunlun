using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Kunlun.WaterStation.Auth;
using Npgsql;
using static Kunlun.WaterStation.Operations.TicketBatches;

namespace Kunlun.WaterStation.Operations;

/// <summary>
/// Single stock changes: RECEIVE (新购) adds to the store, SCRAP moves store stock to scrapped. A 新购 may say what the
/// purchase cost (Cost, PayMethod); that records a 买桶袋 expense in the same transaction and needs expense:manage.
/// </summary>
public sealed record InventoryRequest(string ContainerType, string Action, string Reason, string IdempotencyKey, int Quantity = 0, decimal? Cost = null, string? PayMethod = null);
/// <summary>
/// 修改数量：店里、客户手里、累计报废直接填现在的数，没填（null）的不动；WarnThreshold 是店里少于多少个时提醒，0 表示不提醒。
/// </summary>
public sealed record UpdateStockRequest(string ContainerType, string IdempotencyKey, int? InStationQty = null, int? WithCustomersQty = null,
    int? ScrappedQty = null, int? WarnThreshold = null, string? Note = null);
/// <summary>
/// 一种桶袋的三个数：店里、客户手里、累计报废，随时可以改。MemberHeldQty 是登记在会员名下的数量，只作客户手里的参考；
/// 会员退回的破损在确认报废前记为 DamagedQty。现存总量 = 店里 + 客户手里 + 待确认报废，累计报废不算在内。
/// </summary>
public sealed record InventoryBalance(int InStationQty, int WithCustomersQty, int MemberHeldQty, int DamagedQty, int ScrappedQty)
{
    public int TotalQty => InStationQty + WithCustomersQty + DamagedQty;
}

public static class ContainerInventory
{
    private const int MaxQty = 1_000_000;
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private static bool Authorized(ClaimsPrincipal user) => user.FindFirstValue("subject_type") == "STAFF" && user.HasClaim("perm", KunlunPermissions.ContainerInventoryManage);

    public static async Task EnsureSchema(NpgsqlDataSource db, Guid tid, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct); await using var tx = await conn.BeginTransactionAsync(ct);
        await Exec(conn, tx, """
            SELECT pg_advisory_xact_lock(88482026);
            ALTER TABLE plugin_kunlun_waterstation.container_configs ADD COLUMN IF NOT EXISTS damaged_qty INT NOT NULL DEFAULT 0;
            ALTER TABLE plugin_kunlun_waterstation.container_configs ADD COLUMN IF NOT EXISTS scrapped_qty INT NOT NULL DEFAULT 0;
            ALTER TABLE plugin_kunlun_waterstation.container_configs ADD COLUMN IF NOT EXISTS with_customers_qty INT NOT NULL DEFAULT 0;
            ALTER TABLE plugin_kunlun_waterstation.container_configs ADD COLUMN IF NOT EXISTS counted_at TIMESTAMPTZ;
            DO $$ BEGIN
              -- Transit, inspecting, abnormal and store-damaged stock no longer exist: fold them into store-available
              -- (total unchanged) so damaged_qty only holds member returns awaiting scrap.
              IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='plugin_kunlun_waterstation' AND table_name='container_configs' AND column_name='inspecting_qty') THEN
                ALTER TABLE plugin_kunlun_waterstation.container_configs DROP CONSTRAINT IF EXISTS container_configs_check,
                  DROP CONSTRAINT IF EXISTS container_assets_balance, DROP CONSTRAINT IF EXISTS container_quantities_nonnegative;
                UPDATE plugin_kunlun_waterstation.container_configs
                SET in_station_qty=in_station_qty+in_transit_qty+inspecting_qty+abnormal_qty+damaged_qty,damaged_qty=0;
                IF to_regclass('plugin_kunlun_waterstation.container_damages') IS NOT NULL THEN
                  UPDATE plugin_kunlun_waterstation.container_configs c SET in_station_qty=c.in_station_qty-d.qty,damaged_qty=d.qty
                  FROM (SELECT tenant_id,container_type,sum(quantity)::int AS qty FROM plugin_kunlun_waterstation.container_damages WHERE status='PENDING' GROUP BY 1,2) d
                  WHERE c.tenant_id=d.tenant_id AND c.container_type=d.container_type;
                END IF;
                ALTER TABLE plugin_kunlun_waterstation.container_configs DROP COLUMN in_transit_qty,DROP COLUMN inspecting_qty,DROP COLUMN abnormal_qty;
              END IF;
              -- 客户手里 becomes a count of its own: what members hold plus what stock-takes found unregistered.
              -- The 待核实 flags go too: every figure is simply the last one written down and can be corrected at any time.
              IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='plugin_kunlun_waterstation.container_configs'::regclass AND conname='container_stock_balance_v3') THEN
                ALTER TABLE plugin_kunlun_waterstation.container_configs DROP CONSTRAINT IF EXISTS container_configs_check,
                  DROP CONSTRAINT IF EXISTS container_stock_balance, DROP CONSTRAINT IF EXISTS container_stock_nonnegative,
                  DROP CONSTRAINT IF EXISTS container_stock_balance_v2, DROP CONSTRAINT IF EXISTS container_stock_nonnegative_v2;
                IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='plugin_kunlun_waterstation' AND table_name='container_configs' AND column_name='unregistered_out_qty') THEN
                  UPDATE plugin_kunlun_waterstation.container_configs SET with_customers_qty=member_held_qty+unregistered_out_qty;
                ELSE
                  UPDATE plugin_kunlun_waterstation.container_configs SET with_customers_qty=member_held_qty;
                END IF;
                UPDATE plugin_kunlun_waterstation.container_configs SET total_qty=in_station_qty+with_customers_qty+damaged_qty;
                ALTER TABLE plugin_kunlun_waterstation.container_configs DROP COLUMN IF EXISTS unregistered_out_qty,
                  DROP COLUMN IF EXISTS in_station_unknown, DROP COLUMN IF EXISTS out_unknown,
                  ADD CONSTRAINT container_stock_balance_v3 CHECK(total_qty=in_station_qty+with_customers_qty+damaged_qty),
                  ADD CONSTRAINT container_stock_nonnegative_v3 CHECK(total_qty>=0 AND in_station_qty>=0 AND with_customers_qty>=0
                    AND member_held_qty>=0 AND damaged_qty>=0 AND scrapped_qty>=0 AND warn_threshold>=0);
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
        app.MapPost("/api/containers/stock", UpdateStock).RequireAuthorization();
        app.MapGet("/api/containers/inventory-operations", async (string? containerType, ClaimsPrincipal user, NpgsqlDataSource db, KunlunAuthRepository repo, CancellationToken ct) =>
        {
            if (!Authorized(user)) return Results.Forbid();
            if (containerType is not null && !ProductContainers.ValidId(containerType)) throw new BusinessRuleException("容器类型无效");
            await using var conn = await db.OpenConnectionAsync(ct);
            await using var cmd = Command(conn, null, """
                SELECT o.receipt::text,COALESCE(m.name,'')
                FROM plugin_kunlun_waterstation.container_inventory_operations o
                LEFT JOIN plugin_kunlun_waterstation.members m ON m.id=o.member_id AND m.tenant_id=o.tenant_id
                WHERE o.tenant_id=@tid AND o.action IN ('RECEIVE','SCRAP','COUNT','ADJUST') AND (@type='' OR o.container_type=@type)
                ORDER BY o.created_at DESC,o.id DESC LIMIT 100
                """, ("tid", repo.DefaultTenantId), ("type", containerType ?? ""));
            var rows = new List<object>(); await using var r = await cmd.ExecuteReaderAsync(ct);
            while (await r.ReadAsync(ct)) rows.Add(new { operation = JsonSerializer.Deserialize<JsonElement>(r.GetString(0)), memberName = r.GetString(1) });
            return Results.Ok(rows);
        }).RequireAuthorization();
    }

    internal static async Task<InventoryBalance> ReadBalance(NpgsqlConnection conn, NpgsqlTransaction tx, Guid tid, string type, CancellationToken ct)
    {
        await ProductContainers.Require(conn, tx, tid, type, ct);
        await using var cmd = Command(conn, tx, """
            SELECT in_station_qty,with_customers_qty,member_held_qty,damaged_qty,scrapped_qty
            FROM plugin_kunlun_waterstation.container_configs WHERE tenant_id=@tid AND container_type=@type FOR UPDATE
            """, ("tid", tid), ("type", type));
        await using var r = await cmd.ExecuteReaderAsync(ct);
        if (!await r.ReadAsync(ct)) throw new BusinessRuleException("容器配置不存在", 404);
        return new(r.GetInt32(0), r.GetInt32(1), r.GetInt32(2), r.GetInt32(3), r.GetInt32(4));
    }

    internal static Task<int> SaveBalance(NpgsqlConnection conn, NpgsqlTransaction tx, Guid tid, string type, InventoryBalance b, CancellationToken ct) => Exec(conn, tx, """
        UPDATE plugin_kunlun_waterstation.container_configs SET total_qty=@total,in_station_qty=@store,with_customers_qty=@customers,
        member_held_qty=@held,damaged_qty=@damaged,scrapped_qty=@scrapped
        WHERE tenant_id=@tid AND container_type=@type
        """, ct, ("tid", tid), ("type", type), ("total", b.TotalQty), ("store", b.InStationQty), ("customers", b.WithCustomersQty),
        ("held", b.MemberHeldQty), ("damaged", b.DamagedQty), ("scrapped", b.ScrappedQty));

    /// <summary>
    /// Hands containers from the store to a member (delta &gt; 0) or takes empties back (delta &lt; 0): 店里 and 客户手里 move by
    /// the same amount. Both are written-down figures, so neither blocks the hand-over; each simply stops at zero until corrected.
    /// Only the registered member total must stay consistent with the members' own balances.
    /// </summary>
    internal static async Task<bool> MoveToMembers(NpgsqlConnection conn, NpgsqlTransaction tx, Guid tid, string type, int delta, CancellationToken ct) =>
        await Exec(conn, tx, """
            UPDATE plugin_kunlun_waterstation.container_configs
            SET in_station_qty=GREATEST(in_station_qty-@delta,0),
                with_customers_qty=GREATEST(with_customers_qty+@delta,0),
                member_held_qty=member_held_qty+@delta,
                total_qty=GREATEST(in_station_qty-@delta,0)+GREATEST(with_customers_qty+@delta,0)+damaged_qty
            WHERE tenant_id=@tid AND container_type=@type AND member_held_qty+@delta>=0
            """, ct, ("tid", tid), ("type", type), ("delta", delta)) == 1;

    internal static string Hash(object value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(value, JsonOptions))));
    internal static string Json(object value) => JsonSerializer.Serialize(value, JsonOptions);

    internal static async Task<JsonElement> RecordOperation(NpgsqlConnection conn, NpgsqlTransaction tx, Guid tid, string key, string hash,
        string type, string action, string source, int qty, string reason, Guid? memberId, ClaimsPrincipal user,
        InventoryBalance before, InventoryBalance after, CancellationToken ct, object? warnThreshold = null, object? expense = null)
    {
        var id = Guid.NewGuid(); var no = "CK" + id.ToString("N")[..28];
        var actor = user.FindFirstValue("display_name") ?? "管理员";
        var receipt = new { id, operationNo = no, containerType = type, action, sourceState = source, quantity = qty, deltaTotal = after.TotalQty - before.TotalQty,
            memberId, reason, operatorName = actor, before, after, warnThreshold, expense, createdAt = DateTimeOffset.UtcNow };
        var json = Json(receipt);
        await Exec(conn, tx, """
            INSERT INTO plugin_kunlun_waterstation.container_inventory_operations
            (id,tenant_id,operation_no,idempotency_key,request_hash,container_type,action,source_state,quantity,delta_total,member_id,reason,operator_id,operator_name,before_state,after_state,receipt)
            VALUES(@id,@tid,@no,@key,@hash,@type,@action,@source,@qty,@delta,NULLIF(@member,'')::uuid,@reason,@operator,@actor,@before::jsonb,@after::jsonb,@receipt::jsonb)
            """, ct, ("id", id), ("tid", tid), ("no", no), ("key", key), ("hash", hash), ("type", type), ("action", action), ("source", source),
            ("qty", qty), ("delta", after.TotalQty - before.TotalQty), ("member", memberId?.ToString() ?? ""), ("reason", reason),
            ("operator", Guid.Parse(user.FindFirstValue("sub")!)), ("actor", actor), ("before", Json(before)), ("after", Json(after)), ("receipt", json));
        return JsonSerializer.Deserialize<JsonElement>(json);
    }

    private static async Task<IResult> Execute(InventoryRequest req, ClaimsPrincipal user, NpgsqlDataSource db, KunlunAuthRepository repo, CancellationToken ct)
    {
        if (!Authorized(user)) return Results.Forbid();
        if (!ProductContainers.ValidId(req.ContainerType) || req.Action is not ("RECEIVE" or "SCRAP"))
            throw new BusinessRuleException("库存只办理新购和报废；会员破损请到袋桶台账登记");
        if (string.IsNullOrWhiteSpace(req.Reason) || req.Reason.Length > 500 || req.Quantity is <= 0 or > MaxQty)
            throw new BusinessRuleException("请填写有效数量和不超过 500 字的原因");
        if (req.Action == "SCRAP" && (req.Cost is not null || req.PayMethod is not null)) throw new BusinessRuleException("报废不记花费");
        var cost = Expenses.ReceiveCost(req.Cost, req.PayMethod);
        if (cost is not null && !Expenses.CanManage(user)) return Results.Json(new { error = "当前账号没有登记费用支出的权限，新购时不能填花费" }, statusCode: StatusCodes.Status403Forbidden);
        var hash = Hash(req with { Reason = req.Reason.Trim() }); var tid = repo.DefaultTenantId;
        await using var conn = await db.OpenConnectionAsync(ct); await using var tx = await conn.BeginTransactionAsync(ct);
        if (await Replay(conn, tx, tid, req.IdempotencyKey, hash, ct) is JsonElement replay) return Results.Ok(replay);
        var before = await ReadBalance(conn, tx, tid, req.ContainerType, ct); InventoryBalance after;
        if (req.Action == "RECEIVE")
        {
            if (before.InStationQty + req.Quantity > MaxQty) throw new BusinessRuleException("库存数量超出允许范围");
            after = before with { InStationQty = before.InStationQty + req.Quantity };
        }
        else
        {
            if (before.InStationQty < req.Quantity) throw new BusinessRuleException($"店里只有 {before.InStationQty} 个，报废数量不能超过；会员归还的破损请在袋桶台账办理");
            after = before with { InStationQty = before.InStationQty - req.Quantity, ScrappedQty = before.ScrappedQty + req.Quantity };
        }
        await SaveBalance(conn, tx, tid, req.ContainerType, after, ct);
        // The money for a 新购 goes to 费用支出 as 买桶袋, and each record carries the other's number.
        (Guid Id, string No)? expense = null;
        if (cost is { } paid)
        {
            await using var named = Command(conn, tx, "SELECT name,container_type FROM plugin_kunlun_waterstation.water_products WHERE tenant_id=@tid AND container_id=@id", ("tid", tid), ("id", req.ContainerType));
            string item;
            await using (var r = await named.ExecuteReaderAsync(ct))
                item = await r.ReadAsync(ct) ? $"{r.GetString(0)} · 配套{(r.GetString(1) == "BAG" ? "水袋" : "桶")}" : req.ContainerType;
            expense = await Expenses.RecordReceive(conn, tx, tid, req.IdempotencyKey,
                new ExpenseOnReceive(item, req.ContainerType, req.Quantity, paid.Amount, paid.PayMethod, req.Reason.Trim()), user, ct);
        }
        var receipt = await RecordOperation(conn, tx, tid, req.IdempotencyKey, hash, req.ContainerType, req.Action, req.Action == "RECEIVE" ? "EXTERNAL" : "AVAILABLE", req.Quantity, req.Reason.Trim(), null, user, before, after, ct,
            expense: expense is { } e ? new { expenseNo = e.No, amount = cost!.Value.Amount, payMethod = cost.Value.PayMethod } : null);
        if (expense is { } linked) await Expenses.LinkOperation(conn, tx, linked.Id, receipt.GetProperty("operationNo").GetString()!);
        await tx.CommitAsync(ct); return Results.Ok(receipt);
    }

    // Locks the request key; a retry with the same payload gets the first receipt back.
    private static async Task<JsonElement?> Replay(NpgsqlConnection conn, NpgsqlTransaction tx, Guid tid, string key, string hash, CancellationToken ct)
    {
        await LockRequest(conn, tx, tid, "inventory", key, ct);
        await using var cmd = Command(conn, tx, "SELECT request_hash,receipt::text FROM plugin_kunlun_waterstation.container_inventory_operations WHERE tenant_id=@tid AND idempotency_key=@key", ("tid", tid), ("key", key));
        await using var r = await cmd.ExecuteReaderAsync(ct);
        if (!await r.ReadAsync(ct)) return null;
        if (r.GetString(0) != hash) throw new BusinessRuleException("该请求标识已用于其他库存操作", 409);
        return JsonSerializer.Deserialize<JsonElement>(r.GetString(1));
    }

    /// <summary>
    /// 修改数量：店里、客户手里、累计报废照填的数改，没填的不动，所以改报废时刚好有人领桶也不会冲掉店里的数。
    /// 客户手里可以多于或少于登记在会员名下的数量；会员名下的数量只跟着领还、破损登记变化。
    /// </summary>
    private static async Task<IResult> UpdateStock(UpdateStockRequest req, ClaimsPrincipal user, NpgsqlDataSource db, KunlunAuthRepository repo, CancellationToken ct)
    {
        if (!Authorized(user)) return Results.Forbid();
        if (!ProductContainers.ValidId(req.ContainerType)) throw new BusinessRuleException("容器类型无效");
        int?[] values = [req.InStationQty, req.WithCustomersQty, req.ScrappedQty, req.WarnThreshold];
        if (values.All(v => v is null)) throw new BusinessRuleException("请填写要修改的数量");
        if (values.Any(v => v is < 0 or > MaxQty) || req.Note?.Length > 500)
            throw new BusinessRuleException("数量要在 0 到 1000000 之间，备注不超过 500 字");
        var note = string.IsNullOrWhiteSpace(req.Note) ? null : req.Note.Trim();
        var hash = Hash(req with { Note = note }); var tid = repo.DefaultTenantId;
        await using var conn = await db.OpenConnectionAsync(ct); await using var tx = await conn.BeginTransactionAsync(ct);
        if (await Replay(conn, tx, tid, req.IdempotencyKey, hash, ct) is JsonElement replay) return Results.Ok(replay);
        var before = await ReadBalance(conn, tx, tid, req.ContainerType, ct);
        var after = before with
        {
            InStationQty = req.InStationQty ?? before.InStationQty,
            WithCustomersQty = req.WithCustomersQty ?? before.WithCustomersQty,
            ScrappedQty = req.ScrappedQty ?? before.ScrappedQty,
        };
        await SaveBalance(conn, tx, tid, req.ContainerType, after, ct);
        int threshold;
        await using (var read = Command(conn, tx, "SELECT warn_threshold FROM plugin_kunlun_waterstation.container_configs WHERE tenant_id=@tid AND container_type=@type", ("tid", tid), ("type", req.ContainerType)))
            threshold = Convert.ToInt32(await read.ExecuteScalarAsync(ct));
        await Exec(conn, tx, "UPDATE plugin_kunlun_waterstation.container_configs SET counted_at=now(),warn_threshold=@warn WHERE tenant_id=@tid AND container_type=@type",
            ct, ("tid", tid), ("type", req.ContainerType), ("warn", req.WarnThreshold ?? threshold));
        var warn = req.WarnThreshold is int next && next != threshold ? new { before = threshold, after = next } : null;
        var receipt = await RecordOperation(conn, tx, tid, req.IdempotencyKey, hash, req.ContainerType, "ADJUST", "MANUAL", 0, note ?? "修改数量", null, user, before, after, ct, warn);
        await tx.CommitAsync(ct); return Results.Ok(receipt);
    }
}
