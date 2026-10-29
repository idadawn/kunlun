using System.Security.Claims;
using System.Text.Json;
using Kunlun.WaterStation.Auth;
using Npgsql;
using static Kunlun.WaterStation.Operations.TicketBatches;

namespace Kunlun.WaterStation.Operations;

public sealed record SaveCouponRequest(string Name, Guid PlanId, int GiftQty, DateTimeOffset StartsAt, DateTimeOffset ExpiresAt, int PerMemberLimit, string Status = "ACTIVE");
public sealed record IssueCouponRequest(Guid MemberId, string IdempotencyKey);
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
            foreach (var container in new[] { "BUCKET", "BAG" })
            {
                var heldColumn = container == "BUCKET" ? "held_buckets" : "held_bags";
                await using var heldCmd = Command(conn, null, $"SELECT {heldColumn} FROM plugin_kunlun_waterstation.members WHERE tenant_id=@tid AND id=@mid", ("tid", repo.DefaultTenantId), ("mid", mid));
                var held = Convert.ToInt32(await heldCmd.ExecuteScalarAsync(ct));
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
                result.Add(new { containerType = container, unitDeposit, paidQty, paidAmount = lots.Sum(l => l.Price * l.Qty), heldQty = held, pendingDamageQty = reservedQty, pendingDamageAmount = lots.Sum(l => l.Price * l.Reserved), refundableQty = refundQty, refundableAmount = amount, pendingRefundQty });
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
                  COALESCE(f.amount,0),COALESCE(f.refund_no,''),COALESCE(r.plan_snapshot->>'waterLabel',''),q.request_no
                FROM plugin_kunlun_waterstation.ticket_batches b
                LEFT JOIN plugin_kunlun_waterstation.recharge_orders r ON r.id=b.recharge_id
                LEFT JOIN plugin_kunlun_waterstation.recharge_refunds f ON f.batch_id=b.id
                LEFT JOIN plugin_kunlun_waterstation.refund_requests q ON q.batch_id=b.id AND q.status='PENDING'
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
                pendingRequestNo = r.IsDBNull(18) ? null : r.GetString(18)
            });
            return Results.Ok(rows);
        }).RequireAuthorization();

        app.MapGet("/api/coupon-templates", async (ClaimsPrincipal user, NpgsqlDataSource db, KunlunAuthRepository repo, CancellationToken ct) =>
        {
            if (!Can(user, KunlunPermissions.MemberRead)) return Results.Forbid();
            await using var conn = await db.OpenConnectionAsync(ct);
            await using var cmd = Command(conn, null, "SELECT id,name,plan_id,gift_qty,starts_at,expires_at,per_member_limit,status FROM plugin_kunlun_waterstation.coupon_templates WHERE tenant_id=@tid ORDER BY expires_at DESC,id", ("tid", repo.DefaultTenantId));
            var rows = new List<object>(); await using var r = await cmd.ExecuteReaderAsync(ct);
            while (await r.ReadAsync(ct)) rows.Add(new { id = r.GetGuid(0), name = r.GetString(1), planId = r.GetGuid(2), giftQty = r.GetInt32(3), startsAt = r.GetDateTime(4), expiresAt = r.GetDateTime(5), perMemberLimit = r.GetInt32(6), status = r.GetString(7) });
            return Results.Ok(rows);
        }).RequireAuthorization();
        app.MapPost("/api/coupon-templates", (SaveCouponRequest req, ClaimsPrincipal user, NpgsqlDataSource db, KunlunAuthRepository repo, CancellationToken ct) => SaveCoupon(null, req, user, db, repo, ct)).RequireAuthorization();
        app.MapPut("/api/coupon-templates/{id:guid}", (Guid id, SaveCouponRequest req, ClaimsPrincipal user, NpgsqlDataSource db, KunlunAuthRepository repo, CancellationToken ct) => SaveCoupon(id, req, user, db, repo, ct)).RequireAuthorization();

        app.MapPost("/api/coupon-templates/{id:guid}/issue", async (Guid id, IssueCouponRequest req, ClaimsPrincipal user, NpgsqlDataSource db, KunlunAuthRepository repo, CancellationToken ct) =>
        {
            if (!Can(user, KunlunPermissions.RechargeCreate)) return Results.Forbid();
            await using var conn = await db.OpenConnectionAsync(ct); await using var tx = await conn.BeginTransactionAsync(ct);
            await LockRequest(conn, tx, repo.DefaultTenantId, "coupon", req.IdempotencyKey, ct);
            await LockMember(conn, tx, repo.DefaultTenantId, req.MemberId, ct);
            await using (var existing = Command(conn, tx, "SELECT id,member_id,template_id FROM plugin_kunlun_waterstation.member_coupons WHERE tenant_id=@tid AND idempotency_key=@key", ("tid", repo.DefaultTenantId), ("key", req.IdempotencyKey)))
            await using (var er = await existing.ExecuteReaderAsync(ct)) if (await er.ReadAsync(ct))
            {
                if (er.GetGuid(1) != req.MemberId || er.GetGuid(2) != id) throw new BusinessRuleException("请求标识已用于其他发券操作", 409);
                return Results.Ok(new { id = er.GetGuid(0), idempotentReplay = true });
            }
            string snapshot; int limit;
            Guid planId; string couponName; int giftQty; DateTime starts, expires;
            await using (var cmd = Command(conn, tx, "SELECT name,plan_id,gift_qty,starts_at,expires_at,per_member_limit,status FROM plugin_kunlun_waterstation.coupon_templates WHERE tenant_id=@tid AND id=@id FOR SHARE", ("tid", repo.DefaultTenantId), ("id", id)))
            await using (var r = await cmd.ExecuteReaderAsync(ct))
            {
                if (!await r.ReadAsync(ct)) return Results.NotFound();
                if (r.GetString(6) != "ACTIVE" || r.GetDateTime(4) <= DateTime.UtcNow) throw new BusinessRuleException("优惠券已停用或过期");
                limit = r.GetInt32(5);
                couponName = r.GetString(0); planId = r.GetGuid(1); giftQty = r.GetInt32(2); starts = r.GetDateTime(3); expires = r.GetDateTime(4);
            }
            await using (var plan = Command(conn, tx, "SELECT water_type,fulfill_mode,price,buy_qty FROM plugin_kunlun_waterstation.recharge_plans WHERE tenant_id=@tid AND id=@id AND status='ACTIVE' FOR SHARE", ("tid", repo.DefaultTenantId), ("id", planId)))
            await using (var pr = await plan.ExecuteReaderAsync(ct))
            {
                if (!await pr.ReadAsync(ct)) throw new BusinessRuleException("适用套餐已停用，不能发券");
                snapshot = JsonSerializer.Serialize(new { name = couponName, planId, giftQty, startsAt = starts, expiresAt = expires, waterType = pr.GetString(0), fulfillMode = pr.GetString(1), price = pr.GetDecimal(2), fixedQty = pr.GetInt32(3) });
            }
            await using (var count = Command(conn, tx, "SELECT count(*) FROM plugin_kunlun_waterstation.member_coupons WHERE tenant_id=@tid AND member_id=@mid AND template_id=@id", ("tid", repo.DefaultTenantId), ("mid", req.MemberId), ("id", id)))
                if (Convert.ToInt64(await count.ExecuteScalarAsync(ct)) >= limit) throw new BusinessRuleException("该会员已达到此优惠券领取次数上限");
            var couponId = Guid.NewGuid();
            await Exec(conn, tx, "INSERT INTO plugin_kunlun_waterstation.member_coupons(id,tenant_id,member_id,template_id,snapshot,idempotency_key) VALUES(@id,@tid,@mid,@template,@snap::jsonb,@key)", ct, ("id", couponId), ("tid", repo.DefaultTenantId), ("mid", req.MemberId), ("template", id), ("snap", snapshot), ("key", req.IdempotencyKey));
            await tx.CommitAsync(ct); return Results.Ok(new { id = couponId, idempotentReplay = false });
        }).RequireAuthorization();

        app.MapGet("/api/members/{mid:guid}/coupons", async (Guid mid, ClaimsPrincipal user, NpgsqlDataSource db, KunlunAuthRepository repo, CancellationToken ct) =>
        {
            if (!CanRead(user, mid)) return Results.Forbid();
            await using var conn = await db.OpenConnectionAsync(ct);
            await using var cmd = Command(conn, null, "SELECT id,snapshot::text,status,recharge_id FROM plugin_kunlun_waterstation.member_coupons WHERE tenant_id=@tid AND member_id=@mid ORDER BY issued_at,id", ("tid", repo.DefaultTenantId), ("mid", mid));
            var rows = new List<object>(); await using var r = await cmd.ExecuteReaderAsync(ct);
            while (await r.ReadAsync(ct)) rows.Add(new { id = r.GetGuid(0), snapshot = JsonSerializer.Deserialize<JsonElement>(r.GetString(1)), status = r.GetString(2), rechargeId = r.IsDBNull(3) ? (Guid?)null : r.GetGuid(3) });
            return Results.Ok(rows);
        }).RequireAuthorization();
    }

    private static async Task<IResult> SavePlan(Guid? id, SaveRechargePlanRequest req, ClaimsPrincipal user, NpgsqlDataSource db, KunlunAuthRepository repo, CancellationToken ct)
    {
        if (!Can(user, KunlunPermissions.PlanManage)) return Results.Forbid();
        if (string.IsNullOrWhiteSpace(req.Name) || req.Name.Length > 80 || req.Price <= 0 || req.Price > 99999999 || decimal.Round(req.Price, 2) != req.Price || req.BuyQty <= 0 || req.BuyQty > 100000 || req.GiftQty != 0 || req.Status is not ("ACTIVE" or "DISABLED") || req.WaterType is not ("BUCKET_18_9L" or "BAG_7_5L") || req.FulfillMode is not ("PICKUP" or "DELIVERY"))
            throw new BusinessRuleException("请填写有效套餐：金额精确到分，固定桶数大于零，额外赠水请通过优惠券配置");
        await using var conn = await db.OpenConnectionAsync(ct); var pid = id ?? Guid.NewGuid();
        var sql = id.HasValue ? "UPDATE plugin_kunlun_waterstation.recharge_plans SET name=@name,water_type=@water,fulfill_mode=@mode,price=@price,buy_qty=@qty,gift_qty=0,status=@status,updated_at=now() WHERE tenant_id=@tid AND id=@id"
            : "INSERT INTO plugin_kunlun_waterstation.recharge_plans(id,tenant_id,name,water_type,fulfill_mode,price,buy_qty,gift_qty,status) VALUES(@id,@tid,@name,@water,@mode,@price,@qty,0,@status)";
        try { if (await Exec(conn, null, sql, ct, ("id", pid), ("tid", repo.DefaultTenantId), ("name", req.Name.Trim()), ("water", req.WaterType), ("mode", req.FulfillMode), ("price", req.Price), ("qty", req.BuyQty), ("status", req.Status)) == 0) return Results.NotFound(); }
        catch (PostgresException e) when (e.SqlState == PostgresErrorCodes.UniqueViolation) { throw new BusinessRuleException("套餐名称已存在", 409); }
        return Results.Ok(new { id = pid, name = req.Name, waterType = req.WaterType, fulfillMode = req.FulfillMode, price = req.Price, buyQty = req.BuyQty, giftQty = 0, status = req.Status });
    }

    private static async Task<IResult> SaveCoupon(Guid? id, SaveCouponRequest req, ClaimsPrincipal user, NpgsqlDataSource db, KunlunAuthRepository repo, CancellationToken ct)
    {
        if (!Can(user, KunlunPermissions.PlanManage)) return Results.Forbid();
        if (string.IsNullOrWhiteSpace(req.Name) || req.Name.Length > 80 || req.GiftQty <= 0 || req.GiftQty > 10000 || req.PerMemberLimit <= 0 || req.PerMemberLimit > 1000 || req.ExpiresAt <= req.StartsAt || req.Status is not ("ACTIVE" or "DISABLED")) throw new BusinessRuleException("优惠券名称、赠水数量、有效期或次数无效");
        await using var conn = await db.OpenConnectionAsync(ct); await using var tx = await conn.BeginTransactionAsync(ct);
        Guid? previousPlanId = null;
        if (id.HasValue)
        {
            await using var previous = Command(conn, tx, "SELECT plan_id FROM plugin_kunlun_waterstation.coupon_templates WHERE tenant_id=@tid AND id=@id FOR UPDATE", ("tid", repo.DefaultTenantId), ("id", id.Value));
            var value = await previous.ExecuteScalarAsync(ct);
            if (value is null) return Results.NotFound();
            previousPlanId = (Guid)value;
        }
        await using (var plan = Command(conn, tx, "SELECT status FROM plugin_kunlun_waterstation.recharge_plans WHERE tenant_id=@tid AND id=@id FOR SHARE", ("tid", repo.DefaultTenantId), ("id", req.PlanId)))
        {
            var status = await plan.ExecuteScalarAsync(ct);
            if (status is null) throw new BusinessRuleException("适用套餐不存在");
            // A historical coupon may still be disabled without reassigning its old package.
            if ((string)status != "ACTIVE" && !(previousPlanId == req.PlanId && req.Status == "DISABLED"))
                throw new BusinessRuleException("请选择启用中的充值套餐；原套餐已停用时，可停用此优惠券或重新选择套餐");
        }
        var cid = id ?? Guid.NewGuid();
        var sql = id.HasValue ? "UPDATE plugin_kunlun_waterstation.coupon_templates SET name=@name,plan_id=@plan,gift_qty=@qty,starts_at=@start,expires_at=@end,per_member_limit=@limit,status=@status WHERE tenant_id=@tid AND id=@id"
            : "INSERT INTO plugin_kunlun_waterstation.coupon_templates(id,tenant_id,name,plan_id,gift_qty,starts_at,expires_at,per_member_limit,status) VALUES(@id,@tid,@name,@plan,@qty,@start,@end,@limit,@status)";
        if (await Exec(conn, tx, sql, ct, ("id", cid), ("tid", repo.DefaultTenantId), ("name", req.Name.Trim()), ("plan", req.PlanId), ("qty", req.GiftQty), ("start", req.StartsAt.UtcDateTime), ("end", req.ExpiresAt.UtcDateTime), ("limit", req.PerMemberLimit), ("status", req.Status)) == 0) return Results.NotFound();
        await tx.CommitAsync(ct); return Results.Ok(new { id = cid });
    }

    private static async Task<IResult> CreateRecharge(CreateRechargeOrderRequest req, ClaimsPrincipal user, NpgsqlDataSource db, KunlunAuthRepository repo, CancellationToken ct)
    {
        if (!Can(user, KunlunPermissions.RechargeCreate)) return Results.Forbid();
        if (!Payment(req.PayMethod)) throw new BusinessRuleException("收款方式无效");
        await using var conn = await db.OpenConnectionAsync(ct); await using var tx = await conn.BeginTransactionAsync(ct);
        var tid = repo.DefaultTenantId;
        await LockRequest(conn, tx, tid, "recharge", req.IdempotencyKey, ct);
        await LockMember(conn, tx, tid, req.MemberId, ct);
        await using (var cmd = Command(conn, tx, "SELECT id,recharge_no,paid_amount,buy_qty,gift_qty,plan_snapshot::text,member_id,plan_id,COALESCE(coupon_snapshot->>'id',''),pay_method FROM plugin_kunlun_waterstation.recharge_orders WHERE tenant_id=@tid AND idempotency_key=@key", ("tid", tid), ("key", req.IdempotencyKey)))
        await using (var r = await cmd.ExecuteReaderAsync(ct)) if (await r.ReadAsync(ct))
        {
            if (r.GetGuid(6) != req.MemberId || r.IsDBNull(7) || r.GetGuid(7) != req.PlanId || r.GetString(8) != (req.CouponId?.ToString() ?? "") || r.GetString(9) != req.PayMethod) throw new BusinessRuleException("请求标识已用于其他充值", 409);
            return Results.Ok(new { id = r.GetGuid(0), rechargeNo = r.GetString(1), paidAmount = r.GetDecimal(2), buyQty = r.GetInt32(3), giftQty = r.GetInt32(4), totalTickets = r.GetInt32(3) + r.GetInt32(4), planSnapshot = JsonSerializer.Deserialize<JsonElement>(r.GetString(5)), idempotentReplay = true });
        }
        string name, water, mode; decimal price; int qty, gift;
        await using (var cmd = Command(conn, tx, "SELECT name,water_type,fulfill_mode,price,buy_qty,gift_qty,status FROM plugin_kunlun_waterstation.recharge_plans WHERE tenant_id=@tid AND id=@id FOR SHARE", ("tid", tid), ("id", req.PlanId)))
        await using (var r = await cmd.ExecuteReaderAsync(ct))
        {
            if (!await r.ReadAsync(ct)) return Results.NotFound();
            if (r.GetString(6) != "ACTIVE") throw new BusinessRuleException("套餐已停用");
            name = r.GetString(0); water = r.GetString(1); mode = r.GetString(2); price = r.GetDecimal(3); qty = r.GetInt32(4); gift = r.GetInt32(5);
        }
        string? couponSnapshot = null;
        if (req.CouponId.HasValue)
        {
            await using var cmd = Command(conn, tx, "SELECT snapshot::text,status FROM plugin_kunlun_waterstation.member_coupons WHERE tenant_id=@tid AND member_id=@mid AND id=@id FOR UPDATE", ("tid", tid), ("mid", req.MemberId), ("id", req.CouponId.Value));
            await using var r = await cmd.ExecuteReaderAsync(ct);
            if (!await r.ReadAsync(ct) || r.GetString(1) != "AVAILABLE") throw new BusinessRuleException("优惠券不可用或不属于该会员");
            var coupon = JsonSerializer.Deserialize<JsonElement>(r.GetString(0));
            if (coupon.GetProperty("planId").GetGuid() != req.PlanId || coupon.GetProperty("waterType").GetString() != water || coupon.GetProperty("fulfillMode").GetString() != mode || coupon.GetProperty("price").GetDecimal() != price || coupon.GetProperty("fixedQty").GetInt32() != qty) throw new BusinessRuleException("优惠券不适用于此套餐");
            if (coupon.GetProperty("startsAt").GetDateTime() > DateTime.UtcNow || coupon.GetProperty("expiresAt").GetDateTime() <= DateTime.UtcNow) throw new BusinessRuleException("优惠券尚未生效或已过期");
            gift = checked(gift + coupon.GetProperty("giftQty").GetInt32());
            couponSnapshot = JsonSerializer.Serialize(new { id = req.CouponId.Value, coupon });
        }
        var id = Guid.NewGuid(); var no = Number("CZ");
        var product = await WaterProducts.Read(conn, tx, tid, water, ct);
        var snapshot = new { planId = req.PlanId, name, waterType = water, waterLabel = product.Name, capacityLiters = product.CapacityLiters, fulfillMode = mode, price, buyQty = qty, giftQty = gift, totalTickets = qty + gift };
        await Exec(conn, tx, """
            INSERT INTO plugin_kunlun_waterstation.recharge_orders
              (id,tenant_id,recharge_no,idempotency_key,member_id,plan_id,plan_snapshot,paid_amount,buy_qty,gift_qty,total_tickets,pay_method,operator_id,operator_name,remark,coupon_snapshot)
            VALUES(@id,@tid,@no,@key,@mid,@plan,@snap::jsonb,@price,@qty,@gift,@total,@pay,@actor,@name,@remark,NULLIF(@coupon,'')::jsonb)
            """, ct, ("id", id), ("tid", tid), ("no", no), ("key", req.IdempotencyKey), ("mid", req.MemberId), ("plan", req.PlanId), ("snap", JsonSerializer.Serialize(snapshot)), ("price", price), ("qty", qty), ("gift", gift), ("total", qty + gift), ("pay", req.PayMethod), ("actor", Guid.Parse(user.FindFirstValue("sub")!)), ("name", Actor(user)), ("remark", req.Remark ?? ""), ("coupon", couponSnapshot ?? ""));
        await Exec(conn, tx, """
            INSERT INTO plugin_kunlun_waterstation.ticket_batches(id,tenant_id,member_id,recharge_id,source,water_type,fulfill_mode,paid_amount,fixed_qty,gift_qty,remaining_buy,remaining_gift)
            VALUES(@id,@tid,@mid,@id,'PURCHASE',@water,@mode,@price,@qty,@gift,@qty,@gift)
            """, ct, ("id", id), ("tid", tid), ("mid", req.MemberId), ("water", water), ("mode", mode), ("price", price), ("qty", qty), ("gift", gift));
        if (req.CouponId.HasValue) await Exec(conn, tx, "UPDATE plugin_kunlun_waterstation.member_coupons SET status='USED',recharge_id=@recharge WHERE id=@id AND tenant_id=@tid", ct, ("recharge", id), ("id", req.CouponId.Value), ("tid", tid));
        var (col, _, _) = KunlunOrderRepository.ResolveTicketColumns(water, mode);
        int balance;
        await using (var cmd = Command(conn, tx, $"UPDATE plugin_kunlun_waterstation.members SET {col}={col}+@qty WHERE tenant_id=@tid AND id=@mid RETURNING {col}", ("qty", qty + gift), ("tid", tid), ("mid", req.MemberId))) balance = Convert.ToInt32(await cmd.ExecuteScalarAsync(ct));
        await Ledger(conn, tx, tid, req.MemberId, water, mode, "RECHARGE_BUY", qty, balance - gift, no, Actor(user), ct);
        if (gift > 0) await Ledger(conn, tx, tid, req.MemberId, water, mode, "RECHARGE_GIFT", gift, balance, no, Actor(user), ct);
        await tx.CommitAsync(ct);
        return Results.Ok(new { id, batchId = id, rechargeNo = no, paidAmount = price, buyQty = qty, giftQty = gift, totalTickets = qty + gift, planSnapshot = snapshot, idempotentReplay = false });
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
        var (col, _, _) = KunlunOrderRepository.ResolveTicketColumns(water, mode); int balance;
        await using (var cmd = Command(conn, tx, $"UPDATE plugin_kunlun_waterstation.members SET {col}={col}-@qty WHERE tenant_id=@tid AND id=@mid RETURNING {col}", ("qty", buy + gift), ("tid", tid), ("mid", mid))) balance = Convert.ToInt32(await cmd.ExecuteScalarAsync(ct));
        if (buy > 0) await Ledger(conn, tx, tid, mid, water, mode, "RECHARGE_REFUND", -buy, balance + gift, no, actor, ct);
        if (gift > 0) await Ledger(conn, tx, tid, mid, water, mode, "GIFT_REVOKE", -gift, balance, no, actor, ct);
        return new RechargeRefundResult(rid, no, amount, buy, gift);
    }
    private static Task<int> Ledger(NpgsqlConnection conn, NpgsqlTransaction tx, Guid tid, Guid mid, string water, string mode, string kind, int delta, int balance, string no, string actor, CancellationToken ct) =>
        Exec(conn, tx, "INSERT INTO plugin_kunlun_waterstation.ticket_ledgers(tenant_id,ledger_no,member_id,water_type,fulfill_mode,change_type,delta_qty,balance_after,ref_no,operator_name) VALUES(@tid,@no,@mid,@water,@mode,@kind,@delta,@balance,@ref,@actor)", ct, ("tid", tid), ("no", Number("TL")), ("mid", mid), ("water", water), ("mode", mode), ("kind", kind), ("delta", delta), ("balance", balance), ("ref", no), ("actor", actor));
}
