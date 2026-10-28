using System.Security.Claims;
using System.Text.Json;
using Kunlun.WaterStation.Auth;
using Npgsql;
using static Kunlun.WaterStation.Operations.TicketBatches;

namespace Kunlun.WaterStation.Operations;

public sealed record CreateMiniPayment(Guid PlanId, string IdempotencyKey);
public sealed record SimulateMiniPayment(string Outcome);
public sealed record MiniPaymentPlan(Guid PlanId, string Name, string WaterType, string FulfillMode,
    decimal Price, int BuyQty, int GiftQty, string WaterLabel, decimal CapacityLiters);
public sealed record MiniPaymentView(Guid Id, Guid MemberId, Guid PlanId, MiniPaymentPlan Plan,
    int AmountFen, string Status, string Provider, DateTime CreatedAt);

/// <summary>
/// Explicitly test-only payment service. It never calls WeChat or handles money.
/// The production provider is deliberately unavailable until merchant onboarding and acceptance.
/// Payment snapshot, recharge batch, ledger and balance commit in one database transaction.
/// </summary>
public static class MiniPayments
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public static bool IsEnabled(IConfiguration config, IHostEnvironment env, string connection)
    {
        var mode = config["Kunlun:MiniPayments:Mode"] ?? "Disabled";
        if (mode == "Disabled") return false;
        if (mode != "Mock") throw new InvalidOperationException("MiniPayments currently supports only Disabled or Mock. Real WeChat collection is not enabled in this test delivery.");
        var database = new NpgsqlConnectionStringBuilder(connection).Database;
        if (!(env.IsDevelopment() || env.IsEnvironment("Testing")) || database is null || !database.Contains("test", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Mock payments require Development/Testing and an isolated database whose name contains test.");
        return true;
    }

    public static async Task EnsureSchema(NpgsqlDataSource db, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        await Exec(conn, null, """
            CREATE TABLE IF NOT EXISTS plugin_kunlun_waterstation.mini_test_payments (
              id UUID PRIMARY KEY, tenant_id UUID NOT NULL,
              member_id UUID NOT NULL REFERENCES plugin_kunlun_waterstation.members(id),
              plan_id UUID NOT NULL REFERENCES plugin_kunlun_waterstation.recharge_plans(id),
              idempotency_key VARCHAR(80) NOT NULL, plan_snapshot JSONB NOT NULL,
              amount_fen INT NOT NULL CHECK(amount_fen > 0),
              status VARCHAR(16) NOT NULL DEFAULT 'NOTPAY' CHECK(status IN ('NOTPAY','SUCCESS')),
              created_at TIMESTAMPTZ NOT NULL DEFAULT now(), paid_at TIMESTAMPTZ,
              UNIQUE(tenant_id, member_id, idempotency_key)
            );
            CREATE INDEX IF NOT EXISTS mini_test_payment_member ON plugin_kunlun_waterstation.mini_test_payments(tenant_id, member_id, created_at DESC);
            """, ct);
    }

    private static Guid Member(ClaimsPrincipal user)
    {
        if (user.FindFirstValue("subject_type") != "MEMBER") throw new BusinessRuleException("仅会员可购买本人水票", 403);
        return Guid.Parse(user.FindFirstValue("sub")!);
    }

    private const string Select = "SELECT id,member_id,plan_id,plan_snapshot::text,amount_fen,status,created_at FROM plugin_kunlun_waterstation.mini_test_payments";
    private static MiniPaymentView Read(NpgsqlDataReader r) => new(r.GetGuid(0), r.GetGuid(1), r.GetGuid(2),
        JsonSerializer.Deserialize<MiniPaymentPlan>(r.GetString(3), JsonOptions)!, r.GetInt32(4), r.GetString(5), "MOCK", r.GetDateTime(6));

    public static void MapMiniPayments(this WebApplication app, bool enabled)
    {
        var group = app.MapGroup("/api/mini-payments").RequireAuthorization();
        group.AddEndpointFilter(async (context, next) =>
        {
            if (!enabled) return Results.Json(new { error = "小程序测试支付尚未启用；需使用独立测试后端" }, statusCode: 503);
            return await next(context);
        });
        group.MapPost("", async (CreateMiniPayment req, ClaimsPrincipal user, NpgsqlDataSource db, KunlunAuthRepository auth, CancellationToken ct) =>
        {
            var mid = Member(user); var tid = auth.DefaultTenantId;
            await using var conn = await db.OpenConnectionAsync(ct); await using var tx = await conn.BeginTransactionAsync(ct);
            await LockRequest(conn, tx, tid, "mini-payment-" + mid, req.IdempotencyKey, ct);
            await LockMember(conn, tx, tid, mid, ct);
            await using (var cmd = Command(conn, tx, Select + " WHERE tenant_id=@tid AND member_id=@mid AND idempotency_key=@key", ("tid", tid), ("mid", mid), ("key", req.IdempotencyKey)))
            await using (var r = await cmd.ExecuteReaderAsync(ct))
                if (await r.ReadAsync(ct))
                {
                    var old = Read(r);
                    if (old.PlanId != req.PlanId) throw new BusinessRuleException("请求标识已用于其他套餐", 409);
                    return Results.Ok(old);
                }
            string name, water, mode; decimal price; int qty, gift;
            await using (var cmd = Command(conn, tx, "SELECT name,water_type,fulfill_mode,price,buy_qty,gift_qty,status FROM plugin_kunlun_waterstation.recharge_plans WHERE tenant_id=@tid AND id=@id FOR SHARE", ("tid", tid), ("id", req.PlanId)))
            await using (var r = await cmd.ExecuteReaderAsync(ct))
            {
                if (!await r.ReadAsync(ct)) throw new BusinessRuleException("套餐不存在", 404);
                if (r.GetString(6) != "ACTIVE") throw new BusinessRuleException("套餐已停用");
                name = r.GetString(0); water = r.GetString(1); mode = r.GetString(2); price = r.GetDecimal(3); qty = r.GetInt32(4); gift = r.GetInt32(5);
            }
            // Provider amount is integer fen; never accept a client-supplied amount.
            if (price <= 0 || price * 100 > int.MaxValue || decimal.Truncate(price * 100) != price * 100)
                throw new BusinessRuleException("套餐金额超出支付范围");
            var product = await WaterProducts.Read(conn, tx, tid, water, ct);
            var snapshot = new MiniPaymentPlan(req.PlanId, name, water, mode, price, qty, gift, product.Name, product.CapacityLiters);
            var id = Guid.NewGuid(); var created = DateTime.UtcNow;
            await Exec(conn, tx, """
                INSERT INTO plugin_kunlun_waterstation.mini_test_payments
                (id,tenant_id,member_id,plan_id,idempotency_key,plan_snapshot,amount_fen,created_at)
                VALUES(@id,@tid,@mid,@plan,@key,@snapshot::jsonb,@amount,@created)
                """, ct, ("id", id), ("tid", tid), ("mid", mid), ("plan", req.PlanId), ("key", req.IdempotencyKey),
                ("snapshot", JsonSerializer.Serialize(snapshot, JsonOptions)), ("amount", (int)(price * 100)), ("created", created));
            await tx.CommitAsync(ct);
            return Results.Ok(new MiniPaymentView(id, mid, req.PlanId, snapshot, (int)(price * 100), "NOTPAY", "MOCK", created));
        });
        group.MapGet("", async (ClaimsPrincipal user, NpgsqlDataSource db, KunlunAuthRepository auth, CancellationToken ct) =>
        {
            var mid = Member(user);
            await using var conn = await db.OpenConnectionAsync(ct);
            await using var cmd = Command(conn, null, Select + " WHERE tenant_id=@tid AND member_id=@mid ORDER BY created_at DESC LIMIT 100", ("tid", auth.DefaultTenantId), ("mid", mid));
            var rows = new List<MiniPaymentView>(); await using var r = await cmd.ExecuteReaderAsync(ct);
            while (await r.ReadAsync(ct)) rows.Add(Read(r)); return Results.Ok(rows);
        });
        group.MapGet("/{id:guid}", async (Guid id, ClaimsPrincipal user, NpgsqlDataSource db, KunlunAuthRepository auth, CancellationToken ct) =>
        {
            var mid = Member(user);
            await using var conn = await db.OpenConnectionAsync(ct);
            await using var cmd = Command(conn, null, Select + " WHERE tenant_id=@tid AND member_id=@mid AND id=@id", ("tid", auth.DefaultTenantId), ("mid", mid), ("id", id));
            await using var r = await cmd.ExecuteReaderAsync(ct);
            return await r.ReadAsync(ct) ? Results.Ok(Read(r)) : Results.NotFound();
        });
        group.MapPost("/{id:guid}/simulate", Settle);
    }

    private static async Task<IResult> Settle(Guid id, SimulateMiniPayment req, ClaimsPrincipal user, NpgsqlDataSource db, KunlunAuthRepository auth, CancellationToken ct)
    {
        var mid = Member(user); var tid = auth.DefaultTenantId;
        if (req.Outcome is not ("SUCCESS" or "CANCEL" or "FAIL")) throw new BusinessRuleException("模拟结果无效");
        await using var conn = await db.OpenConnectionAsync(ct); await using var tx = await conn.BeginTransactionAsync(ct);
        // Lock member first, matching the existing recharge/order lock order.
        await LockMember(conn, tx, tid, mid, ct);
        MiniPaymentView payment;
        await using (var cmd = Command(conn, tx, Select + " WHERE tenant_id=@tid AND member_id=@mid AND id=@id FOR UPDATE", ("tid", tid), ("mid", mid), ("id", id)))
        await using (var r = await cmd.ExecuteReaderAsync(ct))
        {
            if (!await r.ReadAsync(ct)) return Results.NotFound(); payment = Read(r);
        }
        // WeChat cancellation/failure leaves the unpaid order retryable. Never regress SUCCESS.
        if (payment.Status == "SUCCESS" || req.Outcome != "SUCCESS") return Results.Ok(payment);
        var p = payment.Plan; var no = "TM" + id.ToString("N")[..28]; var qty = checked(p.BuyQty + p.GiftQty);
        var actor = "小程序模拟支付";
        await Exec(conn, tx, """
            INSERT INTO plugin_kunlun_waterstation.recharge_orders
            (id,tenant_id,recharge_no,idempotency_key,member_id,plan_id,plan_snapshot,paid_amount,buy_qty,gift_qty,total_tickets,pay_method,operator_id,operator_name,remark)
            VALUES(@id,@tid,@no,@key,@mid,@plan,@snapshot::jsonb,@price,@buy,@gift,@qty,'MOCK',@mid,@actor,'仅测试；无真实收款')
            """, ct, ("id", id), ("tid", tid), ("no", no), ("key", "mini-mock-" + id), ("mid", mid), ("plan", p.PlanId),
            ("snapshot", JsonSerializer.Serialize(new { p.PlanId, p.Name, p.WaterType, p.FulfillMode, p.Price, p.BuyQty, p.GiftQty, p.WaterLabel, p.CapacityLiters, TotalTickets = qty }, JsonOptions)),
            ("price", payment.AmountFen / 100m), ("buy", p.BuyQty), ("gift", p.GiftQty), ("qty", qty), ("actor", actor));
        await Exec(conn, tx, """
            INSERT INTO plugin_kunlun_waterstation.ticket_batches(id,tenant_id,member_id,recharge_id,source,water_type,fulfill_mode,paid_amount,fixed_qty,gift_qty,remaining_buy,remaining_gift)
            VALUES(@id,@tid,@mid,@id,'PURCHASE',@water,@mode,@price,@buy,@gift,@buy,@gift)
            """, ct, ("id", id), ("tid", tid), ("mid", mid), ("water", p.WaterType), ("mode", p.FulfillMode), ("price", payment.AmountFen / 100m), ("buy", p.BuyQty), ("gift", p.GiftQty));
        var (column, _, _) = KunlunOrderRepository.ResolveTicketColumns(p.WaterType, p.FulfillMode);
        await using var balanceCmd = Command(conn, tx, $"UPDATE plugin_kunlun_waterstation.members SET {column}={column}+@qty WHERE tenant_id=@tid AND id=@mid RETURNING {column}", ("qty", qty), ("tid", tid), ("mid", mid));
        var balance = Convert.ToInt32(await balanceCmd.ExecuteScalarAsync(ct));
        foreach (var (kind, delta, after) in new[] { ("RECHARGE_BUY", p.BuyQty, balance - p.GiftQty), ("RECHARGE_GIFT", p.GiftQty, balance) })
        {
            if (delta == 0) continue;
            await Exec(conn, tx, """
                INSERT INTO plugin_kunlun_waterstation.ticket_ledgers(tenant_id,ledger_no,member_id,water_type,fulfill_mode,change_type,delta_qty,balance_after,ref_no,operator_name)
                VALUES(@tid,@no,@mid,@water,@mode,@kind,@delta,@balance,@no,@actor)
                """, ct, ("tid", tid), ("no", no), ("mid", mid), ("water", p.WaterType), ("mode", p.FulfillMode), ("kind", kind), ("delta", delta), ("balance", after), ("actor", actor));
        }
        await Exec(conn, tx, "UPDATE plugin_kunlun_waterstation.mini_test_payments SET status='SUCCESS',paid_at=now() WHERE id=@id", ct, ("id", id));
        await tx.CommitAsync(ct);
        return Results.Ok(payment with { Status = "SUCCESS" });
    }
}
