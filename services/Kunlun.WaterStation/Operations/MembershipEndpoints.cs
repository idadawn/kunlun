using System.Security.Claims;
using System.Text.Json;
using Kunlun.WaterStation.Auth;
using Npgsql;
using static Kunlun.WaterStation.Operations.TicketBatches;

namespace Kunlun.WaterStation.Operations;

public sealed record RefundRechargeRequest(string IdempotencyKey, string PayMethod, string Reason);

public static class MembershipEndpoints
{
    private static bool Can(ClaimsPrincipal user, string permission) => user.FindFirstValue("subject_type") == "STAFF" && user.HasClaim("perm", permission);
    private static bool CanRead(ClaimsPrincipal user, Guid mid) => Can(user, KunlunPermissions.MemberRead) || (user.FindFirstValue("subject_type") == "MEMBER" && user.FindFirstValue("sub") == mid.ToString());
    private static string Actor(ClaimsPrincipal user) => user.FindFirstValue("display_name") ?? "员工";
    private static bool Payment(string value) => value is "CASH" or "WECHAT" or "ALIPAY" or "BANK";
    private static string Number(string prefix) => prefix + Guid.NewGuid().ToString("N")[..28];

    public static void MapMembershipEndpoints(this WebApplication app)
    {
        app.MapGet("/api/members/{mid:guid}/deposit-summary", async (Guid mid, ClaimsPrincipal user, NpgsqlDataSource db, KunlunAuthRepository repo, CancellationToken ct) =>
        {
            if (!CanRead(user, mid)) return Results.Forbid();
            await using var conn = await db.OpenConnectionAsync(ct);
            var result = new List<object>();
            foreach (var product in await WaterProducts.List(conn, repo.DefaultTenantId, ct))
            {
                var container = product.ContainerId;
                var held = await ProductContainers.Held(conn, null, repo.DefaultTenantId, mid, container, ct);
                var lots = new List<(int Qty, decimal Price, int Reserved)>();
                await using (var cmd = Command(conn, null, "SELECT remaining_qty,unit_price,reserved_damage_qty FROM plugin_kunlun_waterstation.deposit_lots WHERE tenant_id=@tid AND member_id=@mid AND container_type=@container ORDER BY created_at,id", ("tid", repo.DefaultTenantId), ("mid", mid), ("container", container)))
                await using (var r = await cmd.ExecuteReaderAsync(ct)) while (await r.ReadAsync(ct)) lots.Add((r.GetInt32(0), r.GetDecimal(1), r.GetInt32(2)));
                var paidQty = lots.Sum(l => l.Qty); var reservedQty = lots.Sum(l => l.Reserved); var refundQty = Math.Max(0, paidQty - reservedQty - held); var left = refundQty; decimal amount = 0;
                foreach (var lot in lots) { var take = Math.Min(left, lot.Qty - lot.Reserved); amount += take * lot.Price; left -= take; }
                // Quantity already asked back in refund requests that await review; new requests can only cover the rest.
                await using var pendingCmd = Command(conn, null, "SELECT COALESCE(sum(quantity),0) FROM plugin_kunlun_waterstation.refund_requests WHERE tenant_id=@tid AND member_id=@mid AND kind='DEPOSIT' AND container_type=@container AND status='PENDING'", ("tid", repo.DefaultTenantId), ("mid", mid), ("container", container));
                var pendingRefundQty = Convert.ToInt32(await pendingCmd.ExecuteScalarAsync(ct));
                await using var configCmd = Command(conn, null, "SELECT unit_deposit FROM plugin_kunlun_waterstation.container_configs WHERE tenant_id=@tid AND container_type=@container", ("tid", repo.DefaultTenantId), ("container", container));
                var unitDeposit = (decimal?)await configCmd.ExecuteScalarAsync(ct) ?? throw new BusinessRuleException("押金标准尚未配置", 503);
                result.Add(new { containerType = container, waterType = product.WaterType, name = product.Name, containerKind = product.ContainerType, unitDeposit, paidQty, paidAmount = lots.Sum(l => l.Price * l.Qty), heldQty = held, pendingDamageQty = reservedQty, pendingDamageAmount = lots.Sum(l => l.Price * l.Reserved), refundableQty = refundQty, refundableAmount = amount, pendingRefundQty });
            }
            return Results.Ok(result);
        }).RequireAuthorization();
        app.MapPost("/api/plans", (SaveRechargePlanRequest req, ClaimsPrincipal user, NpgsqlDataSource db, KunlunAuthRepository repo, CancellationToken ct) => SavePlan(null, req, user, db, repo, ct)).RequireAuthorization();
        app.MapPut("/api/plans/{id:guid}", (Guid id, SaveRechargePlanRequest req, ClaimsPrincipal user, NpgsqlDataSource db, KunlunAuthRepository repo, CancellationToken ct) => SavePlan(id, req, user, db, repo, ct)).RequireAuthorization();
        app.MapPost("/api/recharges", CreateRecharge).RequireAuthorization();
        app.MapPost("/api/ticket-batches/{id:guid}/refund", Refund).RequireAuthorization();

        app.MapGet("/api/members/{mid:guid}/ticket-batches", async (Guid mid, ClaimsPrincipal user, NpgsqlDataSource db, KunlunAuthRepository repo, CancellationToken ct) =>
        {
            if (!CanRead(user, mid)) return Results.Forbid();
            await using var conn = await db.OpenConnectionAsync(ct);
            await using var cmd = Command(conn, null, """
                SELECT b.id,b.source,b.water_type,b.fulfill_mode,b.paid_amount,b.fixed_qty,b.gift_qty,b.remaining_buy,b.remaining_gift,
                  b.reserved_buy,b.reserved_gift,b.status,b.created_at,COALESCE(r.recharge_no,''),COALESCE(r.plan_snapshot->>'name','历史余额待核对'),
                  COALESCE(f.amount,0),COALESCE(f.refund_no,''),COALESCE(r.plan_snapshot->>'waterLabel',''),q.request_no,COALESCE(g.quantity,0)
                FROM plugin_kunlun_waterstation.ticket_batches b
                LEFT JOIN plugin_kunlun_waterstation.recharge_orders r ON r.id=b.recharge_id
                LEFT JOIN plugin_kunlun_waterstation.recharge_refunds f ON f.batch_id=b.id
                LEFT JOIN plugin_kunlun_waterstation.refund_requests q ON q.batch_id=b.id AND q.kind='RECHARGE' AND q.status='PENDING'
                LEFT JOIN plugin_kunlun_waterstation.refund_requests g ON g.batch_id=b.id AND g.kind='GIFT' AND g.status='PENDING'
                WHERE b.tenant_id=@tid AND b.member_id=@mid ORDER BY b.created_at,b.id
                """, ("tid", repo.DefaultTenantId), ("mid", mid));
            var rows = new List<object>();
            await using var r = await cmd.ExecuteReaderAsync(ct);
            while (await r.ReadAsync(ct)) rows.Add(new
            {
                id = r.GetGuid(0),
                source = r.GetString(1),
                waterType = r.GetString(2),
                fulfillMode = r.GetString(3),
                paidAmount = r.GetDecimal(4),
                fixedQty = r.GetInt32(5),
                giftQty = r.GetInt32(6),
                remainingBuy = r.GetInt32(7),
                remainingGift = r.GetInt32(8),
                reservedBuy = r.GetInt32(9),
                reservedGift = r.GetInt32(10),
                status = r.GetString(11),
                createdAt = r.GetDateTime(12),
                rechargeNo = r.GetString(13),
                name = r.GetString(14),
                refundableAmount = r.GetString(1) == "PURCHASE" && r.GetString(11) == "ACTIVE" && r.GetInt32(9) + r.GetInt32(10) == 0 ? Math.Round(r.GetDecimal(4) * r.GetInt32(7) / r.GetInt32(5), 2, MidpointRounding.AwayFromZero) : 0,
                refundedAmount = r.GetDecimal(15),
                refundNo = r.GetString(16), waterLabel = r.GetString(17),
                pendingRequestNo = r.IsDBNull(18) ? null : r.GetString(18),
                pendingGiftQty = r.GetInt32(19)
            });
            return Results.Ok(rows);
        }).RequireAuthorization();
    }

    private static async Task<IResult> SavePlan(Guid? id, SaveRechargePlanRequest req, ClaimsPrincipal user, NpgsqlDataSource db, KunlunAuthRepository repo, CancellationToken ct)
    {
        if (!Can(user, KunlunPermissions.PlanManage)) return Results.Forbid();
        if (string.IsNullOrWhiteSpace(req.Name) || req.Name.Length > 80 || req.Price <= 0 || req.Price > 99999999 || decimal.Round(req.Price, 2) != req.Price || req.BuyQty <= 0 || req.BuyQty > 100000 || req.GiftQty != 0 || req.Status is not ("ACTIVE" or "DISABLED") || req.FulfillMode is not ("PICKUP" or "DELIVERY"))
            throw new BusinessRuleException("请填写有效套餐：金额精确到分，固定桶数大于零");
        await using var conn = await db.OpenConnectionAsync(ct); var pid = id ?? Guid.NewGuid();
        await WaterProducts.Read(conn, null, repo.DefaultTenantId, req.WaterType, ct);
        var sql = id.HasValue ? "UPDATE plugin_kunlun_waterstation.recharge_plans SET name=@name,water_type=@water,fulfill_mode=@mode,price=@price,buy_qty=@qty,gift_qty=0,status=@status,updated_at=now() WHERE tenant_id=@tid AND id=@id"
            : "INSERT INTO plugin_kunlun_waterstation.recharge_plans(id,tenant_id,name,water_type,fulfill_mode,price,buy_qty,gift_qty,status) VALUES(@id,@tid,@name,@water,@mode,@price,@qty,0,@status)";
        try { if (await Exec(conn, null, sql, ct, ("id", pid), ("tid", repo.DefaultTenantId), ("name", req.Name.Trim()), ("water", req.WaterType), ("mode", req.FulfillMode), ("price", req.Price), ("qty", req.BuyQty), ("status", req.Status)) == 0) return Results.NotFound(); }
        catch (PostgresException e) when (e.SqlState == PostgresErrorCodes.UniqueViolation) { throw new BusinessRuleException("套餐名称已存在", 409); }
        return Results.Ok(new { id = pid, name = req.Name, waterType = req.WaterType, fulfillMode = req.FulfillMode, price = req.Price, buyQty = req.BuyQty, giftQty = 0, status = req.Status });
    }

    /// <summary>The most tickets one recharge may give away by hand.</summary>
    private const int MaxGift = 1000;

    private static async Task<IResult> CreateRecharge(CreateRechargeOrderRequest req, ClaimsPrincipal user, NpgsqlDataSource db, KunlunAuthRepository repo, CancellationToken ct)
    {
        if (!Can(user, KunlunPermissions.RechargeCreate)) return Results.Forbid();
        if (!Payment(req.PayMethod)) throw new BusinessRuleException("收款方式无效");
        if (req.GiftQty is < 0 or > MaxGift) throw new BusinessRuleException($"赠送数量须在 0 到 {MaxGift} 之间");
        await using var conn = await db.OpenConnectionAsync(ct); await using var tx = await conn.BeginTransactionAsync(ct);
        var tid = repo.DefaultTenantId;
        await LockRequest(conn, tx, tid, "recharge", req.IdempotencyKey, ct);
        await LockMember(conn, tx, tid, req.MemberId, ct);
        await using (var cmd = Command(conn, tx, """
            SELECT r.id,r.recharge_no,r.paid_amount,r.buy_qty,r.gift_qty,r.plan_snapshot::text,r.member_id,r.plan_id,r.pay_method,r.manual_gift_qty,g.quantity,g.request_no
            FROM plugin_kunlun_waterstation.recharge_orders r
            LEFT JOIN plugin_kunlun_waterstation.refund_requests g ON g.batch_id=r.id AND g.kind='GIFT' AND g.status='PENDING'
            WHERE r.tenant_id=@tid AND r.idempotency_key=@key
            """, ("tid", tid), ("key", req.IdempotencyKey)))
        await using (var r = await cmd.ExecuteReaderAsync(ct)) if (await r.ReadAsync(ct))
        {
            if (r.GetGuid(6) != req.MemberId || r.IsDBNull(7) || r.GetGuid(7) != req.PlanId || r.GetString(8) != req.PayMethod || r.GetInt32(9) != req.GiftQty) throw new BusinessRuleException("请求标识已用于其他充值", 409);
            return Results.Ok(new
            {
                id = r.GetGuid(0), rechargeNo = r.GetString(1), paidAmount = r.GetDecimal(2), buyQty = r.GetInt32(3), giftQty = r.GetInt32(4),
                pendingGiftQty = r.IsDBNull(10) ? 0 : r.GetInt32(10), giftRequestNo = r.IsDBNull(11) ? null : r.GetString(11),
                totalTickets = r.GetInt32(3) + r.GetInt32(4), planSnapshot = JsonSerializer.Deserialize<JsonElement>(r.GetString(5)), idempotentReplay = true
            });
        }
        string name, water, mode; decimal price; int qty, planGift;
        await using (var cmd = Command(conn, tx, "SELECT name,water_type,fulfill_mode,price,buy_qty,gift_qty,status FROM plugin_kunlun_waterstation.recharge_plans WHERE tenant_id=@tid AND id=@id FOR SHARE", ("tid", tid), ("id", req.PlanId)))
        await using (var r = await cmd.ExecuteReaderAsync(ct))
        {
            if (!await r.ReadAsync(ct)) return Results.NotFound();
            if (r.GetString(6) != "ACTIVE") throw new BusinessRuleException("套餐已停用");
            name = r.GetString(0); water = r.GetString(1); mode = r.GetString(2); price = r.GetDecimal(3); qty = r.GetInt32(4); planGift = r.GetInt32(5);
        }
        // A gift typed in by a clerk waits for an admin while the station reviews gifts; an admin's own gift arrives at once.
        var settings = await ReviewSettings.Read(conn, tx, tid, ct);
        var pendingGift = settings.GiftReview && !Can(user, KunlunPermissions.RechargeRefund) ? req.GiftQty : 0;
        var gift = planGift + req.GiftQty - pendingGift;
        var id = Guid.NewGuid(); var no = Number("CZ");
        var product = await WaterProducts.Read(conn, tx, tid, water, ct);
        var snapshot = new { planId = req.PlanId, name, waterType = water, waterLabel = product.Name, capacityLiters = product.CapacityLiters, fulfillMode = mode, price, buyQty = qty, giftQty = planGift, totalTickets = qty + planGift };
        await Exec(conn, tx, """
            INSERT INTO plugin_kunlun_waterstation.recharge_orders
              (id,tenant_id,recharge_no,idempotency_key,member_id,plan_id,plan_snapshot,paid_amount,buy_qty,gift_qty,total_tickets,pay_method,operator_id,operator_name,remark,manual_gift_qty)
            VALUES(@id,@tid,@no,@key,@mid,@plan,@snap::jsonb,@price,@qty,@gift,@total,@pay,@actor,@name,@remark,@manual)
            """, ct, ("id", id), ("tid", tid), ("no", no), ("key", req.IdempotencyKey), ("mid", req.MemberId), ("plan", req.PlanId), ("snap", JsonSerializer.Serialize(snapshot)), ("price", price), ("qty", qty), ("gift", gift), ("total", qty + gift), ("pay", req.PayMethod), ("actor", Guid.Parse(user.FindFirstValue("sub")!)), ("name", Actor(user)), ("remark", req.Remark ?? ""), ("manual", req.GiftQty));
        await Exec(conn, tx, """
            INSERT INTO plugin_kunlun_waterstation.ticket_batches(id,tenant_id,member_id,recharge_id,source,water_type,fulfill_mode,paid_amount,fixed_qty,gift_qty,remaining_buy,remaining_gift)
            VALUES(@id,@tid,@mid,@id,'PURCHASE',@water,@mode,@price,@qty,@gift,@qty,@gift)
            """, ct, ("id", id), ("tid", tid), ("mid", req.MemberId), ("water", water), ("mode", mode), ("price", price), ("qty", qty), ("gift", gift));
        var (balance, _) = await MemberTickets.Add(conn, tx, tid, req.MemberId, water, mode, qty + gift, 0, ct);
        await Ledger(conn, tx, tid, req.MemberId, water, mode, "RECHARGE_BUY", qty, balance - gift, no, Actor(user), ct);
        if (gift > 0) await Ledger(conn, tx, tid, req.MemberId, water, mode, "RECHARGE_GIFT", gift, balance, no, Actor(user), ct);
        var giftRequestNo = pendingGift > 0 ? await RefundRequests.RequestGift(conn, tx, tid, req.MemberId, id, pendingGift, Actor(user), ct) : null;
        await tx.CommitAsync(ct);
        return Results.Ok(new { id, batchId = id, rechargeNo = no, paidAmount = price, buyQty = qty, giftQty = gift, pendingGiftQty = pendingGift, giftRequestNo, totalTickets = qty + gift, planSnapshot = snapshot, idempotentReplay = false });
    }

    /// <summary>Adds an approved gift to its recharge batch; a refunded recharge takes no more gifts. The caller holds the member lock.</summary>
    public static async Task GrantGift(NpgsqlConnection conn, NpgsqlTransaction tx, Guid tid, Guid batchId, int qty, string actor, CancellationToken ct)
    {
        Guid mid; string water, mode, no;
        await using (var cmd = Command(conn, tx, """
            SELECT b.member_id,b.water_type,b.fulfill_mode,b.status,r.recharge_no
            FROM plugin_kunlun_waterstation.ticket_batches b JOIN plugin_kunlun_waterstation.recharge_orders r ON r.id=b.recharge_id
            WHERE b.tenant_id=@tid AND b.id=@id FOR UPDATE OF b
            """, ("tid", tid), ("id", batchId)))
        await using (var r = await cmd.ExecuteReaderAsync(ct))
        {
            if (!await r.ReadAsync(ct)) throw new BusinessRuleException("充值批次不存在", 404);
            if (r.GetString(3) != "ACTIVE") throw new BusinessRuleException("这笔充值已退款，赠送不能再到账，请驳回", 409);
            mid = r.GetGuid(0); water = r.GetString(1); mode = r.GetString(2); no = r.GetString(4);
        }
        await Exec(conn, tx, "UPDATE plugin_kunlun_waterstation.ticket_batches SET gift_qty=gift_qty+@qty,remaining_gift=remaining_gift+@qty WHERE tenant_id=@tid AND id=@id", ct, ("qty", qty), ("tid", tid), ("id", batchId));
        await Exec(conn, tx, "UPDATE plugin_kunlun_waterstation.recharge_orders SET gift_qty=gift_qty+@qty,total_tickets=total_tickets+@qty WHERE tenant_id=@tid AND id=@id", ct, ("qty", qty), ("tid", tid), ("id", batchId));
        var (balance, _) = await MemberTickets.Add(conn, tx, tid, mid, water, mode, qty, 0, ct);
        await Ledger(conn, tx, tid, mid, water, mode, "RECHARGE_GIFT", qty, balance, no, actor, ct);
    }

    // 管理员直接退清剩余权益（RechargeRefund 即审核权限），并记为已审核申请；店员通过 /api/refund-requests 提交申请。
    private static async Task<IResult> Refund(Guid id, RefundRechargeRequest req, ClaimsPrincipal user, NpgsqlDataSource db, KunlunAuthRepository repo, CancellationToken ct)
    {
        if (!Can(user, KunlunPermissions.RechargeRefund)) return Results.Forbid();
        if (!Payment(req.PayMethod) || string.IsNullOrWhiteSpace(req.Reason) || req.Reason.Length > 500) throw new BusinessRuleException("请填写退款方式和退款原因");
        await using var conn = await db.OpenConnectionAsync(ct); await using var tx = await conn.BeginTransactionAsync(ct); var tid = repo.DefaultTenantId;
        await LockRequest(conn, tx, tid, "refund", req.IdempotencyKey, ct);
        Guid mid;
        await using (var cmd = Command(conn, tx, "SELECT member_id FROM plugin_kunlun_waterstation.ticket_batches WHERE tenant_id=@tid AND id=@id", ("tid", tid), ("id", id)))
        { var value = await cmd.ExecuteScalarAsync(ct); if (value is null) return Results.NotFound(); mid = (Guid)value; }
        await LockMember(conn, tx, tid, mid, ct);
        await using (var cmd = Command(conn, tx, "SELECT id,refund_no,batch_id,amount,refund_buy_qty,revoked_gift_qty,pay_method,reason FROM plugin_kunlun_waterstation.recharge_refunds WHERE tenant_id=@tid AND idempotency_key=@key", ("tid", tid), ("key", req.IdempotencyKey)))
        await using (var r = await cmd.ExecuteReaderAsync(ct)) if (await r.ReadAsync(ct))
        {
            if (r.GetGuid(2) != id || r.GetString(6) != req.PayMethod || r.GetString(7) != req.Reason.Trim()) throw new BusinessRuleException("请求标识已用于其他退款", 409);
            return Results.Ok(new { id = r.GetGuid(0), refundNo = r.GetString(1), refundAmount = r.GetDecimal(3), refundBuyQty = r.GetInt32(4), revokedGiftQty = r.GetInt32(5), idempotentReplay = true });
        }
        var refund = await ExecuteRechargeRefund(conn, tx, tid, id, req.PayMethod, req.Reason.Trim(), req.IdempotencyKey, Actor(user), ct);
        await RefundRequests.RecordDirect(conn, tx, tid, "RECHARGE", mid, null, null, id, req.PayMethod, req.Reason.Trim(), refund.RefundNo, refund.Amount, Actor(user), ct);
        await tx.CommitAsync(ct); return Results.Ok(new { id = refund.Id, refundNo = refund.RefundNo, refundAmount = refund.Amount, refundBuyQty = refund.BuyQty, revokedGiftQty = refund.GiftQty, idempotentReplay = false });
    }

    public sealed record RechargeRefundResult(Guid Id, string RefundNo, decimal Amount, int BuyQty, int GiftQty);

    /// <summary>Checks a batch can be refunded and returns its amount at the original paid price; the caller holds the member lock.</summary>
    public static async Task<(Guid MemberId, string Water, string Mode, decimal Amount, int Buy, int Gift)> RefundableBatch(NpgsqlConnection conn, NpgsqlTransaction tx, Guid tid, Guid batchId, bool lockRow, CancellationToken ct)
    {
        await using var cmd = Command(conn, tx, "SELECT source,water_type,fulfill_mode,paid_amount,fixed_qty,remaining_buy,remaining_gift,reserved_buy,reserved_gift,status,member_id FROM plugin_kunlun_waterstation.ticket_batches WHERE tenant_id=@tid AND id=@id" + (lockRow ? " FOR UPDATE" : ""), ("tid", tid), ("id", batchId));
        await using var r = await cmd.ExecuteReaderAsync(ct);
        if (!await r.ReadAsync(ct)) throw new BusinessRuleException("充值批次不存在", 404);
        if (r.GetString(0) != "PURCHASE") throw new BusinessRuleException("历史余额缺少原单扣票来源，需先核对，不能自动退款");
        if (r.GetString(9) != "ACTIVE") throw new BusinessRuleException("该批次已退款", 409);
        if (r.GetInt32(7) + r.GetInt32(8) > 0) throw new BusinessRuleException("该批次有未完成水单，请先完成或取消订单", 409);
        int buy = r.GetInt32(5), gift = r.GetInt32(6);
        if (buy + gift == 0) throw new BusinessRuleException("该批次已用完，无剩余权益");
        var amount = Math.Round(r.GetDecimal(3) * buy / r.GetInt32(4), 2, MidpointRounding.AwayFromZero);
        return (r.GetGuid(10), r.GetString(1), r.GetString(2), amount, buy, gift);
    }

    /// <summary>退清一个充值批次的剩余权益：按原实付单价退付费票，收回赠票。调用方须先锁定会员。</summary>
    public static async Task<RechargeRefundResult> ExecuteRechargeRefund(NpgsqlConnection conn, NpgsqlTransaction tx, Guid tid, Guid id, string payMethod, string reason, string idempotencyKey, string actor, CancellationToken ct)
    {
        var (mid, water, mode, amount, buy, gift) = await RefundableBatch(conn, tx, tid, id, lockRow: true, ct);
        var rid = Guid.NewGuid(); var no = Number("TK");
        await Exec(conn, tx, "INSERT INTO plugin_kunlun_waterstation.recharge_refunds(id,tenant_id,refund_no,member_id,batch_id,idempotency_key,refund_buy_qty,revoked_gift_qty,amount,pay_method,reason,operator_name) VALUES(@id,@tid,@no,@mid,@bid,@key,@buy,@gift,@amount,@pay,@reason,@actor)", ct, ("id", rid), ("tid", tid), ("no", no), ("mid", mid), ("bid", id), ("key", idempotencyKey), ("buy", buy), ("gift", gift), ("amount", amount), ("pay", payMethod), ("reason", reason), ("actor", actor));
        await Exec(conn, tx, "UPDATE plugin_kunlun_waterstation.ticket_batches SET remaining_buy=0,remaining_gift=0,status='REFUNDED' WHERE id=@id AND tenant_id=@tid", ct, ("id", id), ("tid", tid));
        var (balance, _) = await MemberTickets.Add(conn, tx, tid, mid, water, mode, -(buy + gift), 0, ct);
        if (buy > 0) await Ledger(conn, tx, tid, mid, water, mode, "RECHARGE_REFUND", -buy, balance + gift, no, actor, ct);
        if (gift > 0) await Ledger(conn, tx, tid, mid, water, mode, "GIFT_REVOKE", -gift, balance, no, actor, ct);
        // A gift still waiting for review goes with the refunded recharge.
        await Exec(conn, tx, """
            UPDATE plugin_kunlun_waterstation.refund_requests SET status='REJECTED',reviewer_name=@actor,reviewed_at=now(),review_note='充值已退款，赠送作废'
            WHERE tenant_id=@tid AND batch_id=@id AND kind='GIFT' AND status='PENDING'
            """, ct, ("actor", actor), ("tid", tid), ("id", id));
        return new RechargeRefundResult(rid, no, amount, buy, gift);
    }
    private static Task<int> Ledger(NpgsqlConnection conn, NpgsqlTransaction tx, Guid tid, Guid mid, string water, string mode, string kind, int delta, int balance, string no, string actor, CancellationToken ct) =>
        Exec(conn, tx, "INSERT INTO plugin_kunlun_waterstation.ticket_ledgers(tenant_id,ledger_no,member_id,water_type,fulfill_mode,change_type,delta_qty,balance_after,ref_no,operator_name) VALUES(@tid,@no,@mid,@water,@mode,@kind,@delta,@balance,@ref,@actor)", ct, ("tid", tid), ("no", Number("TL")), ("mid", mid), ("water", water), ("mode", mode), ("kind", kind), ("delta", delta), ("balance", balance), ("ref", no), ("actor", actor));
}
