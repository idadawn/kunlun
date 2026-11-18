using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text.Json;
using Kunlun.WaterStation.Auth;
using Npgsql;

namespace Kunlun.WaterStation.Operations;

public static class FinanceEndpoints
{
    /// <summary>Who already has the phone. A disabled member is enabled again rather than created twice.</summary>
    private static async Task<string?> PhoneTaken(NpgsqlConnection conn, NpgsqlTransaction? tx, Guid tid, string phone, CancellationToken ct)
    {
        await using var cmd = TicketBatches.Command(conn, tx, "SELECT name,member_no,status,phone FROM plugin_kunlun_waterstation.members WHERE tenant_id=@tid AND (phone=@phone OR lower(username)=@phone) ORDER BY (phone=@phone) DESC LIMIT 1",
            ("tid", tid), ("phone", phone));
        await using var r = await cmd.ExecuteReaderAsync(ct);
        if (!await r.ReadAsync(ct)) return null;
        if (r.GetString(3) != phone) return "该手机号已被用作登录账号，请核对会员档案";
        return r.GetString(2) != "ACTIVE"
            ? $"该手机号是已停用的会员{r.GetString(0)}（{r.GetString(1)}）的，请在会员管理里找到这位会员重新启用"
            : "该手机号已存在会员档案";
    }

    public static void MapFinanceEndpoints(this WebApplication app)
    {
        app.MapGet("/api/members/phone-availability", async (string phone, ClaimsPrincipal user, NpgsqlDataSource ds, KunlunFinanceRepository repo, CancellationToken ct) =>
        {
            if (!HasPerm(user, KunlunPermissions.MemberWrite)) return Results.Forbid();
            if (!ValidPhone(phone)) return Results.BadRequest(new { error = "请填写有效的 11 位手机号" });
            await using var conn = await ds.OpenConnectionAsync(ct);
            var message = await PhoneTaken(conn, null, repo.TenantId, phone, ct);
            return Results.Ok(new { available = message is null, message });
        }).RequireAuthorization();

        // 1. 新建会员 (AC-01)
        app.MapPost("/api/members", async (
            CreateMemberRequest req,
            HttpResponse response,
            ClaimsPrincipal user,
            NpgsqlDataSource ds,
            KunlunFinanceRepository finRepo,
            CancellationToken ct) =>
        {
            if (!HasPerm(user, KunlunPermissions.MemberWrite))
                return Results.Json(new { error = "无新建会员权限 (kunlun.waterstation:member:write)" }, statusCode: StatusCodes.Status403Forbidden);

            var name = req.Name?.Trim() ?? "";
            var phone = req.Phone?.Trim() ?? "";
            if (string.IsNullOrEmpty(name) || !ValidPhone(phone))
                return Results.BadRequest(new { error = "请填写有效姓名与 11 位手机号" });
            var remark = Remarks.Normalize(req.Remark, Remarks.MemberMaxLength);

            var id = Guid.NewGuid();
            var temporaryPassword = PasswordHasher.Temporary();
            await using var conn = await ds.OpenConnectionAsync(ct);
            await using var tx = await conn.BeginTransactionAsync(ct);
            // 手机号冲突时事务回滚，卡号随之退回计数器。
            var memberNo = await BusinessNumbers.MemberNo(conn, tx, finRepo.TenantId, ct);
            await using (var cmd = new NpgsqlCommand("""
                INSERT INTO plugin_kunlun_waterstation.members
                    (id, tenant_id, member_no, name, phone, status, source, remark, username, password_hash, must_change_password)
                VALUES (@id, @tid, @no, @name, @phone, 'ACTIVE', 'STAFF_CREATED', @remark, @phone, @hash, TRUE)
                ON CONFLICT DO NOTHING
                """, conn, tx))
            {
                cmd.Parameters.AddWithValue("id", id);
                cmd.Parameters.AddWithValue("tid", finRepo.TenantId);
                cmd.Parameters.AddWithValue("no", memberNo);
                cmd.Parameters.AddWithValue("hash", PasswordHasher.Hash(temporaryPassword));
                cmd.Parameters.AddWithValue("name", name);
                cmd.Parameters.AddWithValue("phone", phone);
                cmd.Parameters.AddWithValue("remark", (object?)remark ?? DBNull.Value);
                if (await cmd.ExecuteNonQueryAsync(ct) == 0)
                    return Results.Conflict(new { error = await PhoneTaken(conn, tx, finRepo.TenantId, phone, ct) ?? "该手机号已被用作登录账号，请核对会员档案" });
            }
            // 首个收货地址的联系人和手机号默认取会员本人。
            if (!string.IsNullOrWhiteSpace(req.DefaultAddress))
                await MemberAddresses.AddInitial(conn, tx, finRepo.TenantId, id, name, phone, req.DefaultAddress, req.DoorNo, ct);
            await tx.CommitAsync(ct);

            response.Headers.CacheControl = "no-store";
            return Results.Ok(new { id, memberNo, name, phone, remark, temporaryPassword });
        }).RequireAuthorization();

        // 1b. 查询会员列表与搜索 (按卡号/姓名/手机号检索，可按状态、持有水票类型筛选并分页)
        app.MapGet("/api/members", async (
            string? q,
            string? status,
            string? water,
            int? page,
            int? pageSize,
            ClaimsPrincipal user,
            NpgsqlDataSource ds,
            KunlunFinanceRepository finRepo,
            CancellationToken ct) =>
        {
            if (!HasPerm(user, KunlunPermissions.MemberRead))
                return Results.Json(new { error = "无查询会员权限 (kunlun.waterstation:member:read)" }, statusCode: StatusCodes.Status403Forbidden);

            await using var conn = await ds.OpenConnectionAsync(ct);
            // water: BUCKET / BAG — members holding usable tickets of any water carried in that container.
            return await Paging.From(page, pageSize, legacyLimit: 50).Query(conn, $"""
                m.id, m.member_no, m.name, m.phone, COALESCE(m.default_address, ''),
                m.deposit_amount, m.held_buckets, m.held_bags, m.status, m.created_at, m.remark, {MemberTickets.JsonOf("m")},
                m.disabled_at, m.disabled_by, m.disable_reason,m.card_opened_on
                """, """
                plugin_kunlun_waterstation.members m
                WHERE m.tenant_id = @tid
                  AND (@q IS NULL OR m.member_no ILIKE @q OR m.name ILIKE @q OR m.phone ILIKE @q)
                  AND (@status IS NULL OR m.status = @status)
                  AND (@water IS NULL OR EXISTS (
                       SELECT 1 FROM plugin_kunlun_waterstation.member_tickets t
                       JOIN plugin_kunlun_waterstation.water_products p ON p.tenant_id = t.tenant_id AND p.water_type = t.water_type
                       WHERE t.tenant_id = m.tenant_id AND t.member_id = m.id AND t.available > 0 AND p.container_type = @water))
                """, "m.created_at DESC, m.id", p =>
            {
                p.AddWithValue("tid", finRepo.TenantId);
                p.Add(Paging.Like("q", q));
                p.Add(Paging.Text("status", status));
                p.Add(Paging.Text("water", water));
            }, r => new
            {
                id = r.GetGuid(0),
                memberNo = r.GetString(1),
                name = r.GetString(2),
                phone = r.GetString(3),
                defaultAddress = r.GetString(4),
                depositAmount = r.GetDecimal(5),
                heldBuckets = r.GetInt32(6),
                heldBags = r.GetInt32(7),
                status = r.GetString(8),
                createdAt = r.GetDateTime(9),
                remark = r.IsDBNull(10) ? null : r.GetString(10),
                tickets = JsonSerializer.Deserialize<JsonElement>(r.GetString(11)),
                disabledAt = r.IsDBNull(12) ? (DateTime?)null : r.GetDateTime(12),
                disabledBy = r.IsDBNull(13) ? null : r.GetString(13),
                disableReason = r.IsDBNull(14) ? null : r.GetString(14),
                cardOpenedOn = r.IsDBNull(15) ? (DateOnly?)null : r.GetFieldValue<DateOnly>(15)
            }, ct);
        }).RequireAuthorization();

        // 2. 查询优惠方案列表
        app.MapGet("/api/plans", async (NpgsqlDataSource ds, KunlunFinanceRepository finRepo, CancellationToken ct) =>
        {
            await using var conn = await ds.OpenConnectionAsync(ct);
            await using var cmd = new NpgsqlCommand("""
                SELECT id, name, water_type, fulfill_mode, price, buy_qty, gift_qty, status
                FROM plugin_kunlun_waterstation.recharge_plans
                WHERE tenant_id = @tid
                ORDER BY price DESC, fulfill_mode
                """, conn);
            cmd.Parameters.AddWithValue("tid", finRepo.TenantId);
            await using var r = await cmd.ExecuteReaderAsync(ct);
            var list = new List<object>();
            while (await r.ReadAsync(ct))
            {
                list.Add(new
                {
                    id = r.GetGuid(0),
                    name = r.GetString(1),
                    waterType = r.GetString(2),
                    fulfillMode = r.GetString(3),
                    price = r.GetDecimal(4),
                    buyQty = r.GetInt32(5),
                    giftQty = r.GetInt32(6),
                    totalTickets = r.GetInt32(5) + r.GetInt32(6),
                    status = r.GetString(7)
                });
            }
            return Results.Ok(list);
        }).RequireAuthorization();

        // 5. 修改容器押金单价标准（AC-12: 修改单价只影响之后的押金收款，不影响历史批次退款原价）
        app.MapPut("/api/containers/{containerType}/unit-deposit", async (
            string containerType,
            decimal newUnitDeposit,
            ClaimsPrincipal user,
            NpgsqlDataSource ds,
            KunlunFinanceRepository finRepo,
            CancellationToken ct) =>
        {
            if (!HasPerm(user, KunlunPermissions.PlanManage))
                return Results.Json(new { error = "需要押金标准管理权限" }, statusCode: StatusCodes.Status403Forbidden);

            await using var conn = await ds.OpenConnectionAsync(ct);
            await using var cmd = new NpgsqlCommand("""
                UPDATE plugin_kunlun_waterstation.container_configs
                SET unit_deposit = @price
                WHERE tenant_id = @tid AND container_type = @ct
                RETURNING container_type, unit_deposit
                """, conn);
            if (!ProductContainers.ValidId(containerType) || newUnitDeposit <= 0 || newUnitDeposit > 99999999 || decimal.Round(newUnitDeposit,2) != newUnitDeposit)
                throw new BusinessRuleException("押金单价或容器类型无效");
            cmd.Parameters.AddWithValue("price", newUnitDeposit);
            cmd.Parameters.AddWithValue("tid", finRepo.TenantId);
            cmd.Parameters.AddWithValue("ct", containerType.ToUpperInvariant());
            await using var r = await cmd.ExecuteReaderAsync(ct);
            if (!await r.ReadAsync(ct)) return Results.NotFound();
            return Results.Ok(new { containerType = r.GetString(0), unitDeposit = r.GetDecimal(1) });
        }).RequireAuthorization();

        // 6. 独立交押金（AC-03 不触发赠水，不自动改变会员持有容器数，保存当前单价批次快照）
        app.MapPost("/api/deposits/collect", async (
            CollectDepositRequest req,
            ClaimsPrincipal user,
            NpgsqlDataSource ds,
            KunlunFinanceRepository finRepo,
            CancellationToken ct) =>
        {
            if (!HasPerm(user, KunlunPermissions.DepositCollect))
                return Results.Json(new { error = "无押金收款权限" }, statusCode: StatusCodes.Status403Forbidden);

            var ctype = req.ContainerType?.ToUpperInvariant();
            await using var conn = await ds.OpenConnectionAsync(ct);
            await using var tx = await conn.BeginTransactionAsync(ct);
            if ((ctype is null ? req.Quantity != 0 : !ProductContainers.ValidId(ctype) || req.Quantity is <= 0 or > 10000) || req.PayMethod is not ("CASH" or "WECHAT" or "WX_OFFLINE" or "ALIPAY" or "BANK"))
                throw new BusinessRuleException("押金数量、容器或收款方式无效");
            if (ctype is null) DepositPool.Positive(req.Amount);
            await TicketBatches.LockRequest(conn, tx, finRepo.TenantId, "deposit-collect", req.IdempotencyKey, ct);
            await TicketBatches.LockMember(conn, tx, finRepo.TenantId, req.MemberId, ct);
            await using (var replay = TicketBatches.Command(conn, tx, "SELECT deposit_no,member_id,container_type,paid_qty,total_amount,pay_method FROM plugin_kunlun_waterstation.deposit_lots WHERE tenant_id=@tid AND idempotency_key=@key", ("tid", finRepo.TenantId), ("key", req.IdempotencyKey)))
            await using (var r = await replay.ExecuteReaderAsync(ct))
                if (await r.ReadAsync(ct))
                {
                    if (r.GetGuid(1) != req.MemberId || (r.IsDBNull(2) ? null : r.GetString(2)) != ctype || (r.IsDBNull(3) ? 0 : r.GetInt32(3)) != req.Quantity || r.GetString(5) != req.PayMethod
                        || (req.Amount is { } typed && r.GetDecimal(4) != typed)) throw new BusinessRuleException("请求标识已用于其他收押操作", 409);
                    return Results.Ok(new { depositNo = r.GetString(0), status = "APPROVED", totalAmount = r.GetDecimal(4), idempotentReplay = true });
                }
            // Taken while deposits were reviewed: the same collect answers with its request, approved or not.
            if (await RefundRequests.CollectReplay(conn, tx, finRepo.TenantId, req.IdempotencyKey, req.MemberId, ctype, req.Quantity, req.PayMethod, ct, req.Amount) is { } pendingReplay)
                return Results.Ok(pendingReplay);

            decimal unitPrice;
            if (ctype is null) unitPrice = DepositPool.Positive(req.Amount);
            else
            {
                await ProductContainers.Require(conn, tx, finRepo.TenantId, ctype, ct);
                await using var cfg = TicketBatches.Command(conn, tx, "SELECT unit_deposit FROM plugin_kunlun_waterstation.container_configs WHERE tenant_id=@tid AND container_type=@ct",
                    ("tid", finRepo.TenantId), ("ct", ctype));
                unitPrice = req.Amount is { } typedAmount ? Money.UnitPrice(typedAmount, req.Quantity, "") : Convert.ToDecimal(await cfg.ExecuteScalarAsync(ct));
            }
            var operatorName = user.FindFirstValue("display_name") ?? "员工";
            // 收押金要审核时（不分谁收的，门店共用一个管理员账号）先记成待审核：交付照样算进押金覆盖，管理员核对到账批准后才记成押金批次。
            if ((await ReviewSettings.Read(conn, tx, finRepo.TenantId, ct)).DepositReview)
            {
                var (requestId, requestNo) = await RefundRequests.RequestCollect(conn, tx, finRepo.TenantId, req.MemberId, ctype, req.Quantity, unitPrice, req.PayMethod, req.IdempotencyKey, operatorName, ct);
                await tx.CommitAsync(ct);
                return Results.Ok(new { requestId, requestNo, status = "PENDING", containerType = ctype, unitPrice, quantity = req.Quantity, totalAmount = unitPrice * Math.Max(1, req.Quantity) });
            }

            var lot = await InsertDepositLot(conn, tx, finRepo.TenantId, req.MemberId, ctype, req.Quantity, unitPrice, req.PayMethod, req.IdempotencyKey, operatorName, null, ct);
            await tx.CommitAsync(ct);
            return Results.Ok(new { lotId = lot.LotId, depositNo = lot.DepositNo, status = "APPROVED", containerType = ctype, unitPrice, quantity = req.Quantity, totalAmount = lot.Amount });
        }).RequireAuthorization();

        // 7. 独立登记容器领还（AC-10: 归还容器减少持有量，但押金仍保留，不自动退押金）
        app.MapPost("/api/containers/movements", async (
            RegisterContainerMovementRequest req,
            ClaimsPrincipal user,
            NpgsqlDataSource ds,
            CancellationToken ct) =>
        {
            if (!HasPerm(user, KunlunPermissions.ContainerRegister) && !HasPerm(user, KunlunPermissions.OrderFulfill))
                return Results.Json(new { error = "无容器登记权限" }, statusCode: StatusCodes.Status403Forbidden);

            var tid = Guid.Parse(user.FindFirstValue("tenant_id")!);
            var ctype = req.ContainerType;
            if (!ProductContainers.ValidId(ctype) || req.FullOutN < 0 || req.EmptyInM < 0 || req.FullOutN + req.EmptyInM == 0)
                throw new BusinessRuleException("请填写有效的容器类型和领还数量");
            var key = req.IdempotencyKey ?? Guid.NewGuid().ToString("N");
            var ledgerNo = "CM" + Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(key)))[..28];
            await using var conn = await ds.OpenConnectionAsync(ct);
            await using var tx = await conn.BeginTransactionAsync(ct);
            await TicketBatches.LockRequest(conn, tx, tid, "container", key, ct);
            await TicketBatches.LockMember(conn, tx, tid, req.MemberId, ct);
            await using (var replay = TicketBatches.Command(conn, tx, "SELECT member_id,container_type,full_out_qty,empty_in_qty,held_after FROM plugin_kunlun_waterstation.container_ledgers WHERE tenant_id=@tid AND ledger_no=@no", ("tid", tid), ("no", ledgerNo)))
            await using (var r = await replay.ExecuteReaderAsync(ct))
            {
                if (await r.ReadAsync(ct))
                {
                    if (r.GetGuid(0) != req.MemberId || r.GetString(1) != ctype || r.GetInt32(2) != req.FullOutN || r.GetInt32(3) != req.EmptyInM)
                        throw new BusinessRuleException("请求标识已用于其他领还操作", 409);
                    return Results.Ok(new { ledgerNo, currentHeld = r.GetInt32(4), idempotentReplay = true });
                }
            }
            var held = await ProductContainers.Held(conn, tx, tid, req.MemberId, ctype, ct);
            await using var read = TicketBatches.Command(conn, tx, "SELECT deposit_amount FROM plugin_kunlun_waterstation.members WHERE id=@id AND tenant_id=@tid", ("id", req.MemberId), ("tid", tid));
            var deposit = (decimal)(await read.ExecuteScalarAsync(ct))!;
            var delta = req.FullOutN - req.EmptyInM;
            var nextHeld = held + delta;
            if (nextHeld < 0) throw new BusinessRuleException("归还数量超过会员当前持有和本次领出数量");
            await using var cover = TicketBatches.Command(conn, tx, "SELECT COALESCE(sum(remaining_qty-reserved_damage_qty),0) FROM plugin_kunlun_waterstation.deposit_lots WHERE tenant_id=@tid AND member_id=@mid AND container_type=@ct", ("tid", tid), ("mid", req.MemberId), ("ct", ctype));
            // Deposits taken but not yet approved count too: the customer already paid them.
            var covered = Convert.ToInt32(await cover.ExecuteScalarAsync(ct)) + await RefundRequests.PendingCollectQty(conn, tx, tid, req.MemberId, ctype, ct);
            if (!await ContainerInventory.MoveToMembers(conn, tx, tid, ctype, delta, ct))
                throw new BusinessRuleException("会员持有桶袋的汇总需要核对，请联系管理员");
            await ProductContainers.SetHeld(conn, tx, tid, req.MemberId, ctype, nextHeld, ct);
            await TicketBatches.Exec(conn, tx, """
                INSERT INTO plugin_kunlun_waterstation.container_ledgers(tenant_id,ledger_no,member_id,container_type,order_no,full_out_qty,empty_in_qty,delta_held,held_after,covered_deposit_qty_after,operator_name,remark)
                VALUES(@tid,@no,@mid,@ct,@order,@out,@in,@delta,@held,@covered,@operator,'独立领还')
                """, ct, ("tid", tid), ("no", ledgerNo), ("mid", req.MemberId), ("ct", ctype), ("order", req.OrderNo ?? ""), ("out", req.FullOutN), ("in", req.EmptyInM), ("delta", delta), ("held", nextHeld), ("covered", covered), ("operator", user.FindFirstValue("display_name") ?? "员工"));
            await tx.CommitAsync(ct);
            return Results.Ok(new { ledgerNo, memberId = req.MemberId, currentHeld = nextHeld, holdingDelta = delta, depositAmountUnchanged = deposit, idempotentReplay = false });
        }).RequireAuthorization();

        // 8. 管理员直接登记退押金（AC-11 被持有占用时阻止超额退款 + AC-12 按历史批次原收取单价计算退款金额）。
        // 店员只能提交退款申请（/api/refund-requests），由管理员审核通过后才退款；本接口仅限有审核权限的管理员，并记为已审核申请。
        app.MapPost("/api/deposits/refund", async (
            RefundDepositRequest req,
            ClaimsPrincipal user,
            NpgsqlDataSource ds,
            KunlunFinanceRepository finRepo,
            CancellationToken ct) =>
        {
            if (!HasPerm(user, KunlunPermissions.DepositRefundApprove))
                return Results.Json(new { error = "押金退款须由管理员审核，请提交退款申请" }, statusCode: StatusCodes.Status403Forbidden);

            var ctype = req.ContainerType?.ToUpperInvariant();
            await using var conn = await ds.OpenConnectionAsync(ct);
            await using var tx = await conn.BeginTransactionAsync(ct);
            if ((ctype is null ? req.Quantity != 0 : !ProductContainers.ValidId(ctype) || req.Quantity is <= 0 or > 10000))
                throw new BusinessRuleException("退款数量或容器类型无效");
            if (req.PayMethod is not (null or "CASH" or "WECHAT" or "WX_OFFLINE" or "ALIPAY" or "BANK"))
                throw new BusinessRuleException("退款方式无效");
            if (ctype is null) DepositPool.Positive(req.Amount);
            await TicketBatches.LockRequest(conn, tx, finRepo.TenantId, "deposit-refund", req.IdempotencyKey, ct);
            await TicketBatches.LockMember(conn, tx, finRepo.TenantId, req.MemberId, ct);
            await using (var replay = TicketBatches.Command(conn, tx, "SELECT refund_no,member_id,container_type,refund_qty,refund_amount,pay_method FROM plugin_kunlun_waterstation.deposit_refunds WHERE tenant_id=@tid AND idempotency_key=@key", ("tid", finRepo.TenantId), ("key", req.IdempotencyKey)))
            await using (var r = await replay.ExecuteReaderAsync(ct))
                if (await r.ReadAsync(ct))
                {
                    if (r.GetGuid(1) != req.MemberId || (r.IsDBNull(2) ? null : r.GetString(2)) != ctype || (r.IsDBNull(3) ? 0 : r.GetInt32(3)) != req.Quantity || (r.IsDBNull(5) ? null : r.GetString(5)) != req.PayMethod
                        || (req.Amount is { } typed && r.GetDecimal(4) != typed)) throw new BusinessRuleException("请求标识已用于其他退押操作", 409);
                    return Results.Ok(new { refundNo = r.GetString(0), refundAmount = r.GetDecimal(4), idempotentReplay = true });
                }

            var actor = user.FindFirstValue("display_name") ?? "员工";
            var refund = ctype is null
                ? await DepositPool.Debit(conn, tx, finRepo.TenantId, req.MemberId, req.Amount!.Value, req.Amount.Value, req.PayMethod, req.IdempotencyKey, actor, ct)
                : await ExecuteDepositRefund(conn, tx, finRepo.TenantId, req.MemberId, ctype, req.Quantity, req.PayMethod, req.IdempotencyKey, actor, ct, req.Amount);
            await RefundRequests.RecordDirect(conn, tx, finRepo.TenantId, "DEPOSIT", req.MemberId, ctype, ctype is null ? null : req.Quantity, null, req.PayMethod, "", refund.RefundNo, refund.Amount, actor, ct, refund.Value);
            await tx.CommitAsync(ct);
            return Results.Ok(new
            {
                refundNo = refund.RefundNo,
                containerType = ctype,
                refundQty = req.Quantity,
                refundAmount = refund.Amount,
                deductedAmount = refund.Deducted,
                lotBreakdown = refund.Breakdown
            });
        }).RequireAuthorization();
    }

    /// <summary>Amount is what was paid back; Value what those containers' deposit was worth at the original prices; Deducted the part kept.</summary>
    public sealed record DepositRefundResult(string RefundNo, decimal Amount, List<object> Breakdown, decimal Value, decimal Deducted);

    /// <summary>The deposit of the next <paramref name="quantity"/> refundable containers at their original prices, oldest first, after skipping <paramref name="skip"/>.</summary>
    public static decimal FifoValue(IEnumerable<(decimal Price, int Qty)> lots, int quantity, int skip = 0)
    {
        decimal amount = 0; var left = quantity;
        foreach (var (price, count) in lots)
        {
            var usable = count;
            var skipped = Math.Min(skip, usable); skip -= skipped; usable -= skipped;
            var take = Math.Min(left, usable); left -= take; amount += take * price;
            if (left == 0) break;
        }
        return amount;
    }

    /// <summary>
    /// What a deposit refund pays: the amount staff typed in, or the full deposit of those containers when they left it alone.
    /// Paying less keeps the difference as a deduction; paying more than the deposit is not possible.
    /// </summary>
    public static decimal DepositRefundAmount(decimal? entered, decimal value)
    {
        if (entered is not { } amount) return value;
        if (!Money.Valid(amount)) throw new BusinessRuleException("退押金金额要大于等于 0、精确到分");
        if (amount > value) throw new BusinessRuleException($"这几个的押金按原价一共 ¥{Money.Text(value)}，退的不能比这多");
        return amount;
    }

    /// <summary>
    /// Books a deposit as a lot at the given unit price and adds it to the member's deposit balance: straight away when deposits
    /// are not reviewed, or when an admin approves one staff took (keeping the time it was taken, so lots stay in the order paid).
    /// </summary>
    public static async Task<(Guid LotId, string DepositNo, decimal Amount)> InsertDepositLot(NpgsqlConnection conn, NpgsqlTransaction tx, Guid tid, Guid mid,
        string? ctype, int qty, decimal unitPrice, string pay, string key, string operatorName, DateTimeOffset? takenAt, CancellationToken ct, string source = "COLLECT")
    {
        var lotId = Guid.NewGuid();
        var depositNo = await BusinessNumbers.DepositNo(conn, tx, ct);
        var amount = ctype is null ? unitPrice : unitPrice * qty;
        await TicketBatches.Exec(conn, tx, """
            INSERT INTO plugin_kunlun_waterstation.deposit_lots
                (id, tenant_id, deposit_no, idempotency_key, member_id, container_type, unit_price, paid_qty, refunded_qty, remaining_qty, total_amount, pay_method, operator_name, created_at,free_amount,source)
            VALUES
                (@id, @tid, @no, @key, @mid, @ct, @unit, NULLIF(@qty,0), 0, @qty, @tot, @pay, @op, COALESCE(@at::timestamptz, now()),@free,@source)
            """, ct, ("id", lotId), ("tid", tid), ("no", depositNo), ("key", key), ("mid", mid), ("ct", (object?)ctype ?? DBNull.Value), ("unit", ctype is null ? DBNull.Value : (object)unitPrice), ("qty", qty), ("free", ctype is null ? amount : 0m), ("source", source),
            ("tot", amount), ("pay", pay), ("op", operatorName), ("at", (object?)takenAt ?? DBNull.Value));
        await TicketBatches.Exec(conn, tx, "UPDATE plugin_kunlun_waterstation.members SET deposit_amount = deposit_amount + @amt WHERE tenant_id = @tid AND id = @mid",
            ct, ("amt", amount), ("tid", tid), ("mid", mid));
        return (lotId, depositNo, amount);
    }

    /// <summary>
    /// 在调用方事务内退押金：按 FIFO 从未退批次扣减，减少会员押金余额。退的钱默认按原收款单价计算；传了 entered 就按它退，
    /// 少退的部分记为扣押金（deducted_amount），在池押金照样按原价减少。只退未被实际持有和待报废占用的数量；调用方须先锁定会员。
    /// </summary>
    public static async Task<DepositRefundResult> ExecuteDepositRefund(NpgsqlConnection conn, NpgsqlTransaction tx, Guid tid, Guid mid, string ctype,
        int quantity, string? payMethod, string idempotencyKey, string operatorName, CancellationToken ct, decimal? entered = null, Guid? requestId = null)
    {
        var currentHeld = await ProductContainers.Held(conn, tx, tid, mid, ctype, ct);

        // 读取未退押金批次（按 FIFO 顺序锁定）
        var lots = new List<(Guid Id, string No, decimal UnitPrice, int Remaining)>();
        await using (var lCmd = TicketBatches.Command(conn, tx, """
            SELECT id, deposit_no, unit_price, remaining_qty-reserved_damage_qty
            FROM plugin_kunlun_waterstation.deposit_lots
            WHERE tenant_id = @tid AND member_id = @mid AND container_type = @ct AND remaining_qty > reserved_damage_qty
            ORDER BY created_at ASC,id
            FOR UPDATE
            """, ("tid", tid), ("mid", mid), ("ct", ctype)))
        await using (var r = await lCmd.ExecuteReaderAsync(ct))
            while (await r.ReadAsync(ct)) lots.Add((r.GetGuid(0), r.GetString(1), r.GetDecimal(2), r.GetInt32(3)));

        var totalPaidRemaining = lots.Sum(x => x.Remaining);
        var refundableQty = Math.Max(0, totalPaidRemaining - currentHeld);
        // AC-11: 押金被持有容器占用时阻止超额退款并返回明确原因
        if (quantity > refundableQty)
            throw new BusinessRuleException($"可退押金数量不足：可用押金 {totalPaidRemaining} 个（已排除待报废占用），当前实际持有占用 {currentHeld} 个，最多可退 {refundableQty} 个（请先登记归还容器）");

        var pool = await DepositPool.Read(conn, tx, tid, mid, ct, requestId);
        DepositPool.Check(FifoValue(lots.Select(l => (l.UnitPrice, l.Remaining)), quantity), pool);
        // AC-12: 按历史原收款批次单价计算押金原价（不按修改后的当前单价）
        var needToRefund = quantity;
        decimal value = 0m;
        var breakdown = new List<object>();
        foreach (var lot in lots)
        {
            if (needToRefund <= 0) break;
            var take = Math.Min(lot.Remaining, needToRefund);
            var subAmt = take * lot.UnitPrice;
            value += subAmt;
            needToRefund -= take;
            await TicketBatches.Exec(conn, tx, "UPDATE plugin_kunlun_waterstation.deposit_lots SET refunded_qty = refunded_qty + @take, remaining_qty = remaining_qty - @take WHERE id = @id", ct, ("take", take), ("id", lot.Id));
            breakdown.Add(new { lotNo = lot.No, takeQty = take, originalUnitPrice = lot.UnitPrice, subAmount = subAmt });
        }
        var refundAmount = DepositRefundAmount(entered, value);
        var deducted = value - refundAmount;

        var refundNo = await BusinessNumbers.DepositRefundNo(conn, tx, ct);
        await TicketBatches.Exec(conn, tx, """
            INSERT INTO plugin_kunlun_waterstation.deposit_refunds
                (id, tenant_id, refund_no, idempotency_key, member_id, container_type, refund_qty, refund_amount, deducted_amount, lot_breakdown, operator_name, pay_method)
            VALUES (@id, @tid, @no, @key, @mid, @ct, @qty, @amt, @deducted, @bd::jsonb, @op, @pay)
            """, ct, ("id", Guid.NewGuid()), ("tid", tid), ("no", refundNo), ("key", idempotencyKey), ("mid", mid), ("ct", ctype), ("qty", quantity),
            ("amt", refundAmount), ("deducted", deducted), ("bd", JsonSerializer.Serialize(breakdown)), ("op", operatorName), ("pay", (object?)payMethod ?? DBNull.Value));
        // The pool loses the whole deposit of these containers: what was paid back plus what was kept.
        await TicketBatches.Exec(conn, tx, "UPDATE plugin_kunlun_waterstation.members SET deposit_amount = GREATEST(0, deposit_amount - @amt) WHERE id = @mid", ct, ("amt", value), ("mid", mid));
        return new DepositRefundResult(refundNo, refundAmount, breakdown, value, deducted);
    }

    private static bool ValidPhone(string phone) => phone.Length == 11 && phone[0] == '1' && phone.All(char.IsAsciiDigit);

    private static bool HasPerm(ClaimsPrincipal user, string perm) =>
        user.FindAll("perm").Any(c => c.Value == perm || c.Value == "kunlun.waterstation:*");
}
