using System.Security.Claims;
using System.Text.Json;
using Kunlun.WaterStation.Auth;
using Npgsql;
using static Kunlun.WaterStation.Operations.TicketBatches;

namespace Kunlun.WaterStation.Operations;

public sealed record CreateExpenseRequest(
    string Category,      // CONTAINER 买桶袋 | PARTS 配件耗材 | REPAIR 维修 | OTHER 其他
    string Item,          // what was bought, e.g. 15L 空桶、桶盖、压水器
    decimal Amount,       // the whole purchase in yuan, to the cent
    string PayMethod,
    string IdempotencyKey,
    int Quantity = 1,
    DateOnly? SpentOn = null, // the day it was bought; today in Beijing when omitted
    string? Remark = null);

public sealed record VoidExpenseRequest(string Reason);

/// <summary>A purchase recorded with 新购: the money that went with the containers that arrived.</summary>
public sealed record ExpenseOnReceive(string Item, string ContainerType, int Quantity, decimal Amount, string PayMethod, string Remark);

/// <summary>
/// 费用支出：水站平时花出去的钱——买桶买袋、配件耗材、维修和其他杂费，一笔一条，与水费、押金分开记账。
/// 登记错了不删除，作废并写明原因，作废的不计入统计。在袋桶库存「新购」时填了花费，会同时记一笔「买桶袋」支出，
/// 与库存记录互相带单号；作废这笔支出不改库存。登记、作废需 expense:manage，查看还可用报表权限 report:export。
/// </summary>
public static class Expenses
{
    public static readonly IReadOnlyDictionary<string, string> Categories = new Dictionary<string, string>
    {
        ["CONTAINER"] = "买桶袋",
        ["PARTS"] = "配件耗材",
        ["REPAIR"] = "维修",
        ["OTHER"] = "其他",
    };

    private const decimal MaxAmount = 10_000_000m;
    private const int MaxQuantity = 1_000_000;
    private static readonly DateOnly Earliest = new(2020, 1, 1);

    private static bool IsStaff(ClaimsPrincipal u) => u.FindFirstValue("subject_type") == "STAFF";
    public static bool CanManage(ClaimsPrincipal u) => IsStaff(u) && u.HasClaim("perm", KunlunPermissions.ExpenseManage);
    private static bool CanRead(ClaimsPrincipal u) => CanManage(u) || IsStaff(u) && u.HasClaim("perm", KunlunPermissions.ReportExport);
    private static bool Payment(string? value) => value is "CASH" or "WECHAT" or "ALIPAY" or "BANK";
    private static string Actor(ClaimsPrincipal u) => u.FindFirstValue("display_name") ?? "管理员";
    private static IResult Denied(string message) => Results.Json(new { error = message }, statusCode: StatusCodes.Status403Forbidden);

    /// <summary>Today's date at the station (Asia/Shanghai keeps UTC+8 all year).</summary>
    private static DateOnly StationToday() => DateOnly.FromDateTime(DateTimeOffset.UtcNow.ToOffset(TimeSpan.FromHours(8)).DateTime);

    public static async Task EnsureSchema(NpgsqlDataSource db, Guid tid, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var tx = await conn.BeginTransactionAsync(ct);
        await Exec(conn, tx, """
            SELECT pg_advisory_xact_lock(88482026);
            CREATE TABLE IF NOT EXISTS plugin_kunlun_waterstation.expenses(
              id UUID PRIMARY KEY, tenant_id UUID NOT NULL, expense_no VARCHAR(32) NOT NULL UNIQUE,
              idempotency_key VARCHAR(80) NOT NULL, request_hash VARCHAR(64) NOT NULL,
              category VARCHAR(16) NOT NULL CHECK(category IN ('CONTAINER','PARTS','REPAIR','OTHER')),
              item VARCHAR(80) NOT NULL, quantity INT NOT NULL CHECK(quantity > 0),
              amount NUMERIC(12,2) NOT NULL CHECK(amount > 0),
              pay_method VARCHAR(24) NOT NULL, spent_on DATE NOT NULL, remark TEXT NOT NULL DEFAULT '',
              container_type VARCHAR(16), inventory_operation_no VARCHAR(32),
              status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','VOIDED')),
              operator_id UUID NOT NULL, operator_name VARCHAR(64) NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
              voided_by VARCHAR(64), voided_at TIMESTAMPTZ, void_reason TEXT,
              UNIQUE(tenant_id, idempotency_key)
            );
            CREATE INDEX IF NOT EXISTS expenses_spent ON plugin_kunlun_waterstation.expenses(tenant_id, spent_on DESC, created_at DESC);
            -- Administrators keep every permission. No token bump: claims are re-read from this row on every request.
            UPDATE plugin_kunlun_waterstation.staff
            SET permissions = permissions || '["kunlun.waterstation:expense:manage"]'::jsonb
            WHERE tenant_id = @tid AND role = 'ADMIN' AND NOT (permissions ? 'kunlun.waterstation:expense:manage');
            """, ct, ("tid", tid));
        await tx.CommitAsync(ct);
    }

    public static void MapExpenses(this WebApplication app)
    {
        app.MapPost("/api/expenses", Create).RequireAuthorization();
        app.MapPost("/api/expenses/{id:guid}/void", Void).RequireAuthorization();
        app.MapGet("/api/expenses", List).RequireAuthorization();
        app.MapGet("/api/expenses/summary", Summary).RequireAuthorization();
    }

    private static async Task<IResult> Create(CreateExpenseRequest req, ClaimsPrincipal user, NpgsqlDataSource db, KunlunAuthRepository repo, CancellationToken ct)
    {
        if (!CanManage(user)) return Denied("当前账号没有登记费用支出的权限");
        var item = req.Item?.Trim() ?? "";
        var remark = req.Remark?.Trim() ?? "";
        if (!Categories.ContainsKey(req.Category ?? "")) throw new BusinessRuleException("请选择支出类别");
        if (item.Length is 0 or > 80) throw new BusinessRuleException("请填写买了什么（不超过 80 字）");
        if (req.Amount <= 0 || req.Amount > MaxAmount || decimal.Round(req.Amount, 2) != req.Amount) throw new BusinessRuleException("请填写花了多少钱，精确到分");
        if (req.Quantity is <= 0 or > MaxQuantity) throw new BusinessRuleException("数量要大于 0");
        if (!Payment(req.PayMethod)) throw new BusinessRuleException("请选择付款方式");
        if (remark.Length > 500) throw new BusinessRuleException("备注不能超过 500 字");
        if (string.IsNullOrWhiteSpace(req.IdempotencyKey) || req.IdempotencyKey.Length > 80) throw new BusinessRuleException("请求标识无效");
        var spentOn = req.SpentOn ?? StationToday();
        if (spentOn > StationToday() || spentOn < Earliest) throw new BusinessRuleException("购买日期不能晚于今天");

        var tid = repo.DefaultTenantId;
        var hash = ContainerInventory.Hash(new { req.Category, item, req.Amount, req.PayMethod, req.Quantity, spentOn, remark });
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var tx = await conn.BeginTransactionAsync(ct);
        await LockRequest(conn, tx, tid, "expense", req.IdempotencyKey, ct);
        (string Hash, Guid Id)? earlier = null;
        await using (var replay = Command(conn, tx, "SELECT request_hash,id FROM plugin_kunlun_waterstation.expenses WHERE tenant_id=@tid AND idempotency_key=@key", ("tid", tid), ("key", req.IdempotencyKey)))
        await using (var r = await replay.ExecuteReaderAsync(ct))
            if (await r.ReadAsync(ct)) earlier = (r.GetString(0), r.GetGuid(1));
        if (earlier is { } seen)
        {
            if (seen.Hash != hash) throw new BusinessRuleException("请求标识已用于其他支出", 409);
            return Results.Ok(await Read(conn, tx, tid, seen.Id, ct));
        }
        var id = await Insert(conn, tx, tid, req.IdempotencyKey, hash, req.Category!, item, req.Quantity, req.Amount, req.PayMethod, spentOn, remark, null, null, user, ct);
        var row = await Read(conn, tx, tid, id, ct);
        await tx.CommitAsync(ct);
        return Results.Ok(row);
    }

    /// <summary>
    /// The 买桶袋 expense of a 新购 that said what it cost, written in the stock change's transaction and keyed by its
    /// request so a retried 新购 never records the money twice. The caller has checked <see cref="CanManage"/> and links
    /// the stock record with <see cref="LinkOperation"/> once it has its number.
    /// </summary>
    internal static async Task<(Guid Id, string No)> RecordReceive(NpgsqlConnection conn, NpgsqlTransaction tx, Guid tid, string inventoryKey, ExpenseOnReceive e, ClaimsPrincipal user, CancellationToken ct)
    {
        var key = "inventory:" + inventoryKey;
        var hash = ContainerInventory.Hash(new { e.ContainerType, e.Quantity, e.Amount, e.PayMethod });
        var id = await Insert(conn, tx, tid, key, hash, "CONTAINER", e.Item, e.Quantity, e.Amount, e.PayMethod, StationToday(), e.Remark, e.ContainerType, null, user, ct);
        await using var cmd = Command(conn, tx, "SELECT expense_no FROM plugin_kunlun_waterstation.expenses WHERE id=@id", ("id", id));
        return (id, (string)(await cmd.ExecuteScalarAsync(ct))!);
    }

    internal static Task<int> LinkOperation(NpgsqlConnection conn, NpgsqlTransaction tx, Guid id, string operationNo) =>
        Exec(conn, tx, "UPDATE plugin_kunlun_waterstation.expenses SET inventory_operation_no=@no WHERE id=@id", default, ("no", operationNo), ("id", id));

    /// <summary>Checks what a 新购 says it cost; null when it gave no cost.</summary>
    internal static (decimal Amount, string PayMethod)? ReceiveCost(decimal? cost, string? payMethod)
    {
        if (cost is null) return null;
        if (cost <= 0 || cost > MaxAmount || decimal.Round(cost.Value, 2) != cost) throw new BusinessRuleException("花费要大于 0，精确到分");
        if (!Payment(payMethod)) throw new BusinessRuleException("请选择付款方式");
        return (cost.Value, payMethod!);
    }

    private static async Task<Guid> Insert(NpgsqlConnection conn, NpgsqlTransaction tx, Guid tid, string key, string hash, string category, string item,
        int quantity, decimal amount, string pay, DateOnly spentOn, string remark, string? containerType, string? operationNo, ClaimsPrincipal user, CancellationToken ct)
    {
        var id = Guid.NewGuid();
        var no = await BusinessNumbers.ExpenseNo(conn, tx, ct);
        await Exec(conn, tx, """
            INSERT INTO plugin_kunlun_waterstation.expenses
              (id,tenant_id,expense_no,idempotency_key,request_hash,category,item,quantity,amount,pay_method,spent_on,remark,container_type,inventory_operation_no,operator_id,operator_name)
            VALUES(@id,@tid,@no,@key,@hash,@category,@item,@qty,@amount,@pay,@spent,@remark,@container,@operation,@operator,@actor)
            """, ct, ("id", id), ("tid", tid), ("no", no), ("key", key), ("hash", hash), ("category", category), ("item", item), ("qty", quantity),
            ("amount", amount), ("pay", pay), ("spent", spentOn), ("remark", remark), ("container", (object?)containerType ?? DBNull.Value),
            ("operation", (object?)operationNo ?? DBNull.Value), ("operator", Guid.Parse(user.FindFirstValue("sub")!)), ("actor", Actor(user)));
        return id;
    }

    private const string Columns = """
        e.id,e.expense_no,e.category,e.item,e.quantity,e.amount,e.pay_method,e.spent_on,e.remark,e.container_type,e.inventory_operation_no,
        e.status,e.operator_name,e.created_at,e.voided_by,e.voided_at,e.void_reason
        """;

    private static object Row(NpgsqlDataReader r) => new
    {
        id = r.GetGuid(0),
        expenseNo = r.GetString(1),
        category = r.GetString(2),
        item = r.GetString(3),
        quantity = r.GetInt32(4),
        amount = r.GetDecimal(5),
        payMethod = r.GetString(6),
        spentOn = r.GetFieldValue<DateOnly>(7).ToString("yyyy-MM-dd"),
        remark = r.GetString(8),
        containerType = r.IsDBNull(9) ? null : r.GetString(9),
        inventoryOperationNo = r.IsDBNull(10) ? null : r.GetString(10),
        status = r.GetString(11),
        operatorName = r.GetString(12),
        createdAt = r.GetDateTime(13),
        voidedBy = r.IsDBNull(14) ? null : r.GetString(14),
        voidedAt = r.IsDBNull(15) ? (DateTime?)null : r.GetDateTime(15),
        voidReason = r.IsDBNull(16) ? null : r.GetString(16),
    };

    private static async Task<object> Read(NpgsqlConnection conn, NpgsqlTransaction? tx, Guid tid, Guid id, CancellationToken ct)
    {
        await using var cmd = Command(conn, tx, $"SELECT {Columns} FROM plugin_kunlun_waterstation.expenses e WHERE e.tenant_id=@tid AND e.id=@id", ("tid", tid), ("id", id));
        await using var r = await cmd.ExecuteReaderAsync(ct);
        if (!await r.ReadAsync(ct)) throw new BusinessRuleException("支出记录不存在", 404);
        return Row(r);
    }

    private static async Task<IResult> Void(Guid id, VoidExpenseRequest req, ClaimsPrincipal user, NpgsqlDataSource db, KunlunAuthRepository repo, CancellationToken ct)
    {
        if (!CanManage(user)) return Denied("当前账号没有作废费用支出的权限");
        var reason = req.Reason?.Trim() ?? "";
        if (reason.Length is 0 or > 500) throw new BusinessRuleException("请填写作废原因");
        var tid = repo.DefaultTenantId;
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var tx = await conn.BeginTransactionAsync(ct);
        await using (var cmd = Command(conn, tx, "SELECT status FROM plugin_kunlun_waterstation.expenses WHERE tenant_id=@tid AND id=@id FOR UPDATE", ("tid", tid), ("id", id)))
        {
            var status = await cmd.ExecuteScalarAsync(ct) as string ?? throw new BusinessRuleException("支出记录不存在", 404);
            // Voiding twice keeps the first reason.
            if (status == "VOIDED") return Results.Ok(await Read(conn, tx, tid, id, ct));
        }
        await Exec(conn, tx, "UPDATE plugin_kunlun_waterstation.expenses SET status='VOIDED',voided_by=@actor,voided_at=now(),void_reason=@reason WHERE tenant_id=@tid AND id=@id",
            ct, ("actor", Actor(user)), ("reason", reason), ("tid", tid), ("id", id));
        var row = await Read(conn, tx, tid, id, ct);
        await tx.CommitAsync(ct);
        return Results.Ok(row);
    }

    // A business-time window from the console's date filter: from/to are instants, compared with the Beijing purchase date.
    private const string Window = """
        (@from IS NULL OR e.spent_on >= (@from AT TIME ZONE 'Asia/Shanghai')::date)
        AND (@to IS NULL OR e.spent_on < (@to AT TIME ZONE 'Asia/Shanghai')::date)
        """;

    private static async Task<IResult> List(string? q, string? category, string? status, DateTimeOffset? from, DateTimeOffset? to, int? page, int? pageSize,
        ClaimsPrincipal user, NpgsqlDataSource db, KunlunAuthRepository repo, CancellationToken ct)
    {
        if (!CanRead(user)) return Denied("需要费用支出或报表权限");
        if (category is not (null or "") && !Categories.ContainsKey(category)) throw new BusinessRuleException("支出类别无效");
        if (status is not (null or "" or "ACTIVE" or "VOIDED")) throw new BusinessRuleException("状态无效");
        await using var conn = await db.OpenConnectionAsync(ct);
        return await Paging.From(page, pageSize ?? Paging.DefaultPageSize, legacyLimit: Paging.DefaultPageSize).Query(conn, Columns, $"""
            plugin_kunlun_waterstation.expenses e
            WHERE e.tenant_id = @tid AND {Window}
              AND (@category IS NULL OR e.category = @category)
              AND (@status IS NULL OR e.status = @status)
              AND (@q IS NULL OR e.expense_no ILIKE @q OR e.item ILIKE @q OR e.remark ILIKE @q OR e.operator_name ILIKE @q)
            """, "e.spent_on DESC, e.created_at DESC, e.id", p =>
        {
            p.AddWithValue("tid", repo.DefaultTenantId);
            p.Add(Paging.Time("from", from));
            p.Add(Paging.Time("to", to));
            p.Add(Paging.Text("category", category));
            p.Add(Paging.Text("status", status));
            p.Add(Paging.Like("q", q));
        }, Row, ct);
    }

    /// <summary>
    /// 一段时间的收支：费用支出合计与分类（不含作废的），同期水费实收、水费退款和净收，以及结余 = 水费净收 − 费用支出。
    /// 押金是会员的钱，不算收入也不算支出。不给时间就是全部。
    /// </summary>
    private static async Task<IResult> Summary(DateTimeOffset? from, DateTimeOffset? to, ClaimsPrincipal user, NpgsqlDataSource db, KunlunAuthRepository repo, CancellationToken ct)
    {
        if (!CanRead(user)) return Denied("需要费用支出或报表权限");
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = new NpgsqlCommand($$"""
            SELECT json_build_object(
              'expenseTotal', (SELECT COALESCE(sum(amount),0) FROM plugin_kunlun_waterstation.expenses e WHERE e.tenant_id=@tid AND e.status='ACTIVE' AND {{Window}}),
              'expenseCount', (SELECT count(*) FROM plugin_kunlun_waterstation.expenses e WHERE e.tenant_id=@tid AND e.status='ACTIVE' AND {{Window}}),
              'voidedCount', (SELECT count(*) FROM plugin_kunlun_waterstation.expenses e WHERE e.tenant_id=@tid AND e.status='VOIDED' AND {{Window}}),
              'categories', COALESCE((SELECT json_agg(json_build_object('category',category,'total',total,'count',n) ORDER BY total DESC)
                 FROM (SELECT category, sum(amount) AS total, count(*) AS n FROM plugin_kunlun_waterstation.expenses e
                       WHERE e.tenant_id=@tid AND e.status='ACTIVE' AND {{Window}} GROUP BY category) c), '[]'::json),
              'rechargeRevenue', (SELECT COALESCE(sum(paid_amount),0) FROM plugin_kunlun_waterstation.recharge_orders
                 WHERE tenant_id=@tid AND (@from IS NULL OR created_at >= @from) AND (@to IS NULL OR created_at < @to)),
              'rechargeRefunded', (SELECT COALESCE(sum(amount),0) FROM plugin_kunlun_waterstation.recharge_refunds
                 WHERE tenant_id=@tid AND (@from IS NULL OR created_at >= @from) AND (@to IS NULL OR created_at < @to))
            )::text
            """, conn);
        cmd.Parameters.AddWithValue("tid", repo.DefaultTenantId);
        cmd.Parameters.Add(Paging.Time("from", from));
        cmd.Parameters.Add(Paging.Time("to", to));
        using var doc = JsonDocument.Parse((string)(await cmd.ExecuteScalarAsync(ct))!);
        var root = doc.RootElement;
        var expense = root.GetProperty("expenseTotal").GetDecimal();
        var revenue = root.GetProperty("rechargeRevenue").GetDecimal();
        var refunded = root.GetProperty("rechargeRefunded").GetDecimal();
        return Results.Ok(new
        {
            expenseTotal = expense,
            expenseCount = root.GetProperty("expenseCount").GetInt64(),
            voidedCount = root.GetProperty("voidedCount").GetInt64(),
            categories = root.GetProperty("categories").EnumerateArray().Select(c => new
            {
                category = c.GetProperty("category").GetString(),
                total = c.GetProperty("total").GetDecimal(),
                count = c.GetProperty("count").GetInt64()
            }).ToArray(),
            rechargeRevenue = revenue,
            rechargeRefunded = refunded,
            rechargeNet = revenue - refunded,
            balance = revenue - refunded - expense
        });
    }
}
