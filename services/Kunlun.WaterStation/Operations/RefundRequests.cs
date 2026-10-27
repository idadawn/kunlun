using System.Security.Claims;
using Kunlun.WaterStation.Auth;
using Npgsql;
using static Kunlun.WaterStation.Operations.TicketBatches;

namespace Kunlun.WaterStation.Operations;

public sealed record ApplyRefundRequest(string Kind, Guid MemberId, string? ContainerType, int? Quantity, Guid? BatchId, string PayMethod, string? Reason, string IdempotencyKey);
public sealed record ApproveRefundRequest(string? PayMethod, string? Note);
public sealed record RejectRefundRequest(string Note);

/// <summary>
/// 退款审核。押金退款与水费退款（退清剩余权益）都先登记为申请，管理员审核通过时才在同一事务里执行退款；驳回不动任何账目。
/// 提交申请：押金需 deposit:refund_apply，水费需 recharge:create；审核：押金需 deposit:refund_approve，水费需 recharge:refund。
/// 管理员通过旧接口直接退款时，同样记一条已审核的申请，保证每笔退款都有审核记录。
/// </summary>
public static class RefundRequests
{
    private static bool Has(ClaimsPrincipal u, string perm) =>
        u.FindFirstValue("subject_type") == "STAFF" && (u.HasClaim("perm", perm) || u.HasClaim("perm", "kunlun.waterstation:*"));
    private static bool CanApply(ClaimsPrincipal u, string kind) => kind == "DEPOSIT"
        ? Has(u, KunlunPermissions.DepositRefundApply) || Has(u, KunlunPermissions.DepositRefundApprove)
        : Has(u, KunlunPermissions.RechargeCreate) || Has(u, KunlunPermissions.RechargeRefund);
    private static bool CanReview(ClaimsPrincipal u, string kind) => Has(u, kind == "DEPOSIT" ? KunlunPermissions.DepositRefundApprove : KunlunPermissions.RechargeRefund);
    private static bool Payment(string? value) => value is "CASH" or "WECHAT" or "ALIPAY" or "BANK";
    private static string Actor(ClaimsPrincipal u) => u.FindFirstValue("display_name") ?? "员工";
    private static IResult Denied(string message) => Results.Json(new { error = message }, statusCode: StatusCodes.Status403Forbidden);

    public static async Task EnsureSchema(NpgsqlDataSource db, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var tx = await conn.BeginTransactionAsync(ct);
        await Exec(conn, tx, """
            SELECT pg_advisory_xact_lock(88482026);
            CREATE TABLE IF NOT EXISTS plugin_kunlun_waterstation.refund_requests(
              id UUID PRIMARY KEY, tenant_id UUID NOT NULL, request_no VARCHAR(32) NOT NULL UNIQUE,
              idempotency_key VARCHAR(80) NOT NULL, request_hash VARCHAR(64) NOT NULL,
              kind VARCHAR(16) NOT NULL CHECK(kind IN ('DEPOSIT','RECHARGE')),
              member_id UUID NOT NULL REFERENCES plugin_kunlun_waterstation.members(id),
              container_type VARCHAR(16) CHECK(container_type IN ('BUCKET','BAG')), quantity INT CHECK(quantity>0),
              batch_id UUID REFERENCES plugin_kunlun_waterstation.ticket_batches(id),
              estimated_amount NUMERIC(10,2) NOT NULL DEFAULT 0, pay_method VARCHAR(24), reason TEXT NOT NULL DEFAULT '',
              status VARCHAR(16) NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','APPROVED','REJECTED')),
              applicant_name VARCHAR(64) NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
              reviewer_name VARCHAR(64), reviewed_at TIMESTAMPTZ, review_note TEXT,
              refund_no VARCHAR(32), refund_amount NUMERIC(10,2),
              UNIQUE(tenant_id, idempotency_key),
              CHECK((kind='DEPOSIT' AND container_type IS NOT NULL AND quantity IS NOT NULL AND batch_id IS NULL)
                 OR (kind='RECHARGE' AND batch_id IS NOT NULL AND container_type IS NULL AND quantity IS NULL))
            );
            CREATE UNIQUE INDEX IF NOT EXISTS refund_requests_pending_batch ON plugin_kunlun_waterstation.refund_requests(batch_id) WHERE status='PENDING';
            CREATE INDEX IF NOT EXISTS refund_requests_status ON plugin_kunlun_waterstation.refund_requests(tenant_id, status, created_at DESC);
            CREATE INDEX IF NOT EXISTS refund_requests_member ON plugin_kunlun_waterstation.refund_requests(tenant_id, member_id, status);
            """, ct);
        await tx.CommitAsync(ct);
    }

    public static void MapRefundRequests(this WebApplication app)
    {
        app.MapPost("/api/refund-requests", Apply).RequireAuthorization();
        app.MapPost("/api/refund-requests/{id:guid}/approve", Approve).RequireAuthorization();
        app.MapPost("/api/refund-requests/{id:guid}/reject", Reject).RequireAuthorization();
        app.MapGet("/api/refund-requests", async (string? status, string? kind, string? q, int? page, int? pageSize,
            ClaimsPrincipal user, NpgsqlDataSource db, KunlunAuthRepository repo, CancellationToken ct) =>
        {
            if (!Has(user, KunlunPermissions.MemberRead)) return Results.Forbid();
            if (status is not (null or "" or "PENDING" or "APPROVED" or "REJECTED") || kind is not (null or "" or "DEPOSIT" or "RECHARGE"))
                throw new BusinessRuleException("筛选条件无效");
            await using var conn = await db.OpenConnectionAsync(ct);
            return await Paging.From(page, pageSize, legacyLimit: 50).Query(conn, """
                rr.id, rr.request_no, rr.kind, rr.status, m.name, m.member_no, m.phone, rr.container_type, rr.quantity, rr.batch_id,
                ro.recharge_no, ro.plan_snapshot->>'name', b.water_type, b.fulfill_mode, b.remaining_buy, b.remaining_gift,
                rr.estimated_amount, rr.pay_method, rr.reason, rr.applicant_name, rr.created_at,
                rr.reviewer_name, rr.reviewed_at, rr.review_note, rr.refund_no, rr.refund_amount, rr.member_id
                """, """
                plugin_kunlun_waterstation.refund_requests rr
                JOIN plugin_kunlun_waterstation.members m ON m.id = rr.member_id
                LEFT JOIN plugin_kunlun_waterstation.ticket_batches b ON b.id = rr.batch_id
                LEFT JOIN plugin_kunlun_waterstation.recharge_orders ro ON ro.id = b.recharge_id
                WHERE rr.tenant_id = @tid
                  AND (@status IS NULL OR rr.status = @status)
                  AND (@kind IS NULL OR rr.kind = @kind)
                  AND (@q IS NULL OR rr.request_no ILIKE @q OR m.name ILIKE @q OR m.member_no ILIKE @q OR m.phone ILIKE @q
                       OR rr.applicant_name ILIKE @q OR rr.refund_no ILIKE @q OR ro.recharge_no ILIKE @q)
                """, "rr.created_at DESC, rr.id", p =>
            {
                p.AddWithValue("tid", repo.DefaultTenantId);
                p.Add(Paging.Text("status", status));
                p.Add(Paging.Text("kind", kind));
                p.Add(Paging.Like("q", q));
            }, r => new
            {
                id = r.GetGuid(0),
                requestNo = r.GetString(1),
                kind = r.GetString(2),
                status = r.GetString(3),
                memberId = r.GetGuid(26),
                memberName = r.GetString(4),
                memberNo = r.GetString(5),
                memberPhone = r.GetString(6),
                containerType = r.IsDBNull(7) ? null : r.GetString(7),
                quantity = r.IsDBNull(8) ? (int?)null : r.GetInt32(8),
                batchId = r.IsDBNull(9) ? (Guid?)null : r.GetGuid(9),
                rechargeNo = r.IsDBNull(10) ? null : r.GetString(10),
                planName = r.IsDBNull(11) ? null : r.GetString(11),
                waterType = r.IsDBNull(12) ? null : r.GetString(12),
                fulfillMode = r.IsDBNull(13) ? null : r.GetString(13),
                remainingBuy = r.IsDBNull(14) ? (int?)null : r.GetInt32(14),
                remainingGift = r.IsDBNull(15) ? (int?)null : r.GetInt32(15),
                estimatedAmount = r.GetDecimal(16),
                payMethod = r.IsDBNull(17) ? null : r.GetString(17),
                reason = r.GetString(18),
                applicantName = r.GetString(19),
                createdAt = r.GetDateTime(20),
                reviewerName = r.IsDBNull(21) ? null : r.GetString(21),
                reviewedAt = r.IsDBNull(22) ? (DateTime?)null : r.GetDateTime(22),
                reviewNote = r.IsDBNull(23) ? null : r.GetString(23),
                refundNo = r.IsDBNull(24) ? null : r.GetString(24),
                refundAmount = r.IsDBNull(25) ? (decimal?)null : r.GetDecimal(25)
            }, ct);
        }).RequireAuthorization();
    }

    private static async Task<IResult> Apply(ApplyRefundRequest req, ClaimsPrincipal user, NpgsqlDataSource db, KunlunAuthRepository repo, CancellationToken ct)
    {
        var kind = req.Kind?.ToUpperInvariant();
        if (kind is not ("DEPOSIT" or "RECHARGE")) throw new BusinessRuleException("退款类型无效");
        if (!CanApply(user, kind)) return Denied("当前账号没有提交此类退款申请的权限");
        if (!Payment(req.PayMethod)) throw new BusinessRuleException("请选择退款方式");
        var reason = req.Reason?.Trim() ?? "";
        if (reason.Length > 500) throw new BusinessRuleException("退款原因不能超过 500 字");
        string? ctype = null; int? qty = null; Guid? batchId = null;
        if (kind == "DEPOSIT")
        {
            ctype = req.ContainerType?.ToUpperInvariant();
            if (ctype is not ("BUCKET" or "BAG") || req.Quantity is not (> 0 and <= 10000)) throw new BusinessRuleException("请选择容器并填写有效的退押数量");
            qty = req.Quantity;
        }
        else
        {
            if (req.BatchId is null) throw new BusinessRuleException("请选择要退款的充值批次");
            if (reason.Length == 0) throw new BusinessRuleException("请填写退款原因");
            batchId = req.BatchId;
        }

        var tid = repo.DefaultTenantId;
        var hash = ContainerInventory.Hash(new { kind, req.MemberId, ctype, qty, batchId, req.PayMethod, reason });
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var tx = await conn.BeginTransactionAsync(ct);
        await LockRequest(conn, tx, tid, "refund-request", req.IdempotencyKey, ct);
        await using (var replay = Command(conn, tx, "SELECT request_hash,id,request_no,status,estimated_amount FROM plugin_kunlun_waterstation.refund_requests WHERE tenant_id=@tid AND idempotency_key=@key", ("tid", tid), ("key", req.IdempotencyKey)))
        await using (var r = await replay.ExecuteReaderAsync(ct))
            if (await r.ReadAsync(ct))
            {
                if (r.GetString(0) != hash) throw new BusinessRuleException("请求标识已用于其他退款申请", 409);
                return Results.Ok(new { id = r.GetGuid(1), requestNo = r.GetString(2), status = r.GetString(3), estimatedAmount = r.GetDecimal(4), idempotentReplay = true });
            }
        await LockMember(conn, tx, tid, req.MemberId, ct);

        decimal estimate;
        if (kind == "DEPOSIT") estimate = await DepositEstimate(conn, tx, tid, req.MemberId, ctype!, qty!.Value, ct);
        else
        {
            var batch = await MembershipEndpoints.RefundableBatch(conn, tx, tid, batchId!.Value, lockRow: false, ct);
            if (batch.MemberId != req.MemberId) throw new BusinessRuleException("该充值批次不属于此会员");
            await using var pending = Command(conn, tx, "SELECT request_no FROM plugin_kunlun_waterstation.refund_requests WHERE batch_id=@bid AND status='PENDING'", ("bid", batchId.Value));
            if (await pending.ExecuteScalarAsync(ct) is string existing) throw new BusinessRuleException($"该批次已有待审核的退款申请 {existing}", 409);
            estimate = batch.Amount;
        }

        var id = Guid.NewGuid();
        var no = await BusinessNumbers.RefundRequestNo(conn, tx, ct);
        await Exec(conn, tx, """
            INSERT INTO plugin_kunlun_waterstation.refund_requests
              (id,tenant_id,request_no,idempotency_key,request_hash,kind,member_id,container_type,quantity,batch_id,estimated_amount,pay_method,reason,applicant_name)
            VALUES(@id,@tid,@no,@key,@hash,@kind,@mid,@ctype,@qty,@bid,@estimate,@pay,@reason,@actor)
            """, ct, ("id", id), ("tid", tid), ("no", no), ("key", req.IdempotencyKey), ("hash", hash), ("kind", kind), ("mid", req.MemberId),
            ("ctype", (object?)ctype ?? DBNull.Value), ("qty", (object?)qty ?? DBNull.Value), ("bid", (object?)batchId ?? DBNull.Value),
            ("estimate", estimate), ("pay", req.PayMethod), ("reason", reason), ("actor", Actor(user)));
        await tx.CommitAsync(ct);
        return Results.Ok(new { id, requestNo = no, status = "PENDING", estimatedAmount = estimate, idempotentReplay = false });
    }

    /// <summary>
    /// 押金申请的上限与预估金额：可申请 = 已交未退 − 待报废占用 − 实际持有 − 其他待审核申请。
    /// 预估按原收款单价先进先出，并跳过排在前面的待审核数量；实际金额以审核通过时为准。
    /// </summary>
    private static async Task<decimal> DepositEstimate(NpgsqlConnection conn, NpgsqlTransaction tx, Guid tid, Guid mid, string ctype, int qty, CancellationToken ct)
    {
        var heldCol = ctype == "BUCKET" ? "held_buckets" : "held_bags";
        await using var heldCmd = Command(conn, tx, $"SELECT {heldCol} FROM plugin_kunlun_waterstation.members WHERE tenant_id=@tid AND id=@mid", ("tid", tid), ("mid", mid));
        var held = Convert.ToInt32(await heldCmd.ExecuteScalarAsync(ct));
        var lots = new List<(decimal Price, int Qty)>();
        await using (var cmd = Command(conn, tx, """
            SELECT unit_price, remaining_qty-reserved_damage_qty FROM plugin_kunlun_waterstation.deposit_lots
            WHERE tenant_id=@tid AND member_id=@mid AND container_type=@ct AND remaining_qty>reserved_damage_qty ORDER BY created_at,id
            """, ("tid", tid), ("mid", mid), ("ct", ctype)))
        await using (var r = await cmd.ExecuteReaderAsync(ct))
            while (await r.ReadAsync(ct)) lots.Add((r.GetDecimal(0), r.GetInt32(1)));
        await using var pendingCmd = Command(conn, tx, "SELECT COALESCE(sum(quantity),0) FROM plugin_kunlun_waterstation.refund_requests WHERE tenant_id=@tid AND member_id=@mid AND kind='DEPOSIT' AND container_type=@ct AND status='PENDING'", ("tid", tid), ("mid", mid), ("ct", ctype));
        var pending = Convert.ToInt32(await pendingCmd.ExecuteScalarAsync(ct));
        var paid = lots.Sum(l => l.Qty);
        var available = Math.Max(0, paid - held - pending);
        if (qty > available)
            throw new BusinessRuleException($"最多可申请退 {available} 个：可退押金 {paid} 个，实际持有占用 {held} 个{(pending > 0 ? $"，另有 {pending} 个已在审核中" : "")}。请先登记归还容器");
        decimal amount = 0; var skip = pending; var left = qty;
        foreach (var (price, count) in lots)
        {
            var usable = count;
            var skipped = Math.Min(skip, usable); skip -= skipped; usable -= skipped;
            var take = Math.Min(left, usable); left -= take; amount += take * price;
            if (left == 0) break;
        }
        return amount;
    }

    private static async Task<IResult> Approve(Guid id, ApproveRefundRequest req, ClaimsPrincipal user, NpgsqlDataSource db, KunlunAuthRepository repo, CancellationToken ct)
    {
        if (req.PayMethod is not null && !Payment(req.PayMethod)) throw new BusinessRuleException("退款方式无效");
        if (req.Note?.Length > 500) throw new BusinessRuleException("审核意见不能超过 500 字");
        var tid = repo.DefaultTenantId;
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var tx = await conn.BeginTransactionAsync(ct);
        var (kind, mid) = await Find(conn, tx, tid, id, ct);
        if (!CanReview(user, kind)) return Denied("退款须由有审核权限的管理员审核");
        // Same lock order as every money path: member first, then the request and the ledgers it touches.
        await LockMember(conn, tx, tid, mid, ct);
        string status, pay, reason; string? ctype; int? qty; Guid? batchId;
        await using (var cmd = Command(conn, tx, "SELECT status,container_type,quantity,batch_id,pay_method,reason,refund_no,refund_amount FROM plugin_kunlun_waterstation.refund_requests WHERE tenant_id=@tid AND id=@id FOR UPDATE", ("tid", tid), ("id", id)))
        await using (var r = await cmd.ExecuteReaderAsync(ct))
        {
            await r.ReadAsync(ct);
            status = r.GetString(0);
            if (status == "APPROVED") return Results.Ok(new { id, status, refundNo = r.GetString(6), refundAmount = r.GetDecimal(7), idempotentReplay = true });
            if (status == "REJECTED") throw new BusinessRuleException("该申请已驳回，不能再审核通过", 409);
            ctype = r.IsDBNull(1) ? null : r.GetString(1); qty = r.IsDBNull(2) ? null : r.GetInt32(2); batchId = r.IsDBNull(3) ? null : r.GetGuid(3);
            pay = req.PayMethod ?? r.GetString(4); reason = r.GetString(5);
        }

        var actor = Actor(user);
        var key = $"refund-request:{id:N}";
        string refundNo; decimal amount;
        if (kind == "DEPOSIT")
        {
            var refund = await FinanceEndpoints.ExecuteDepositRefund(conn, tx, tid, mid, ctype!, qty!.Value, pay, key, actor, ct);
            (refundNo, amount) = (refund.RefundNo, refund.Amount);
        }
        else
        {
            var refund = await MembershipEndpoints.ExecuteRechargeRefund(conn, tx, tid, batchId!.Value, pay, reason, key, actor, ct);
            (refundNo, amount) = (refund.RefundNo, refund.Amount);
        }
        await Exec(conn, tx, """
            UPDATE plugin_kunlun_waterstation.refund_requests
            SET status='APPROVED',pay_method=@pay,reviewer_name=@actor,reviewed_at=now(),review_note=@note,refund_no=@no,refund_amount=@amount
            WHERE tenant_id=@tid AND id=@id
            """, ct, ("pay", pay), ("actor", actor), ("note", req.Note?.Trim() ?? ""), ("no", refundNo), ("amount", amount), ("tid", tid), ("id", id));
        await tx.CommitAsync(ct);
        return Results.Ok(new { id, status = "APPROVED", refundNo, refundAmount = amount, idempotentReplay = false });
    }

    private static async Task<IResult> Reject(Guid id, RejectRefundRequest req, ClaimsPrincipal user, NpgsqlDataSource db, KunlunAuthRepository repo, CancellationToken ct)
    {
        var note = req.Note?.Trim() ?? "";
        if (note.Length is 0 or > 500) throw new BusinessRuleException("请填写驳回原因");
        var tid = repo.DefaultTenantId;
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var tx = await conn.BeginTransactionAsync(ct);
        var (kind, _) = await Find(conn, tx, tid, id, ct);
        if (!CanReview(user, kind)) return Denied("退款须由有审核权限的管理员审核");
        await using (var cmd = Command(conn, tx, "SELECT status FROM plugin_kunlun_waterstation.refund_requests WHERE tenant_id=@tid AND id=@id FOR UPDATE", ("tid", tid), ("id", id)))
        {
            var status = (string)(await cmd.ExecuteScalarAsync(ct))!;
            if (status == "REJECTED") return Results.Ok(new { id, status, idempotentReplay = true });
            if (status == "APPROVED") throw new BusinessRuleException("该申请已审核通过并退款，不能驳回", 409);
        }
        await Exec(conn, tx, "UPDATE plugin_kunlun_waterstation.refund_requests SET status='REJECTED',reviewer_name=@actor,reviewed_at=now(),review_note=@note WHERE tenant_id=@tid AND id=@id",
            ct, ("actor", Actor(user)), ("note", note), ("tid", tid), ("id", id));
        await tx.CommitAsync(ct);
        return Results.Ok(new { id, status = "REJECTED", idempotentReplay = false });
    }

    private static async Task<(string Kind, Guid MemberId)> Find(NpgsqlConnection conn, NpgsqlTransaction tx, Guid tid, Guid id, CancellationToken ct)
    {
        await using var cmd = Command(conn, tx, "SELECT kind,member_id FROM plugin_kunlun_waterstation.refund_requests WHERE tenant_id=@tid AND id=@id", ("tid", tid), ("id", id));
        await using var r = await cmd.ExecuteReaderAsync(ct);
        if (!await r.ReadAsync(ct)) throw new BusinessRuleException("退款申请不存在", 404);
        return (r.GetString(0), r.GetGuid(1));
    }

    /// <summary>
    /// 管理员直接退款时补一条已审核的申请。水费批次若已有待审核申请，就把那条记为通过，而不是另起一条。
    /// </summary>
    public static async Task RecordDirect(NpgsqlConnection conn, NpgsqlTransaction tx, Guid tid, string kind, Guid mid, string? ctype, int? qty, Guid? batchId,
        string? payMethod, string reason, string refundNo, decimal amount, string actor, CancellationToken ct)
    {
        const string note = "管理员直接登记退款";
        var pay = (object?)payMethod ?? DBNull.Value;
        if (batchId is { } bid && await Exec(conn, tx, """
            UPDATE plugin_kunlun_waterstation.refund_requests
            SET status='APPROVED',pay_method=@pay,reviewer_name=@actor,reviewed_at=now(),review_note=@note,refund_no=@no,refund_amount=@amount
            WHERE tenant_id=@tid AND batch_id=@bid AND status='PENDING'
            """, ct, ("pay", pay), ("actor", actor), ("note", note), ("no", refundNo), ("amount", amount), ("tid", tid), ("bid", bid)) > 0) return;
        var no = await BusinessNumbers.RefundRequestNo(conn, tx, ct);
        await Exec(conn, tx, """
            INSERT INTO plugin_kunlun_waterstation.refund_requests
              (id,tenant_id,request_no,idempotency_key,request_hash,kind,member_id,container_type,quantity,batch_id,estimated_amount,pay_method,reason,
               status,applicant_name,reviewer_name,reviewed_at,review_note,refund_no,refund_amount)
            VALUES(@id,@tid,@no,@key,'',@kind,@mid,@ctype,@qty,@bid,@amount,@pay,@reason,'APPROVED',@actor,@actor,now(),@note,@refund,@amount)
            """, ct, ("id", Guid.NewGuid()), ("tid", tid), ("no", no), ("key", "direct:" + refundNo), ("kind", kind), ("mid", mid),
            ("ctype", (object?)ctype ?? DBNull.Value), ("qty", (object?)qty ?? DBNull.Value), ("bid", (object?)batchId ?? DBNull.Value),
            ("amount", amount), ("pay", pay), ("reason", reason), ("actor", actor), ("note", note), ("refund", refundNo));
    }
}
