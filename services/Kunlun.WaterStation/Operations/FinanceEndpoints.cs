using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text.Json;
using Kunlun.WaterStation.Auth;
using Npgsql;

namespace Kunlun.WaterStation.Operations;

public static class FinanceEndpoints
{
    public static void MapFinanceEndpoints(this WebApplication app)
    {
        // 1. 新建会员 (AC-01)
        app.MapPost("/api/members", async (
            CreateMemberRequest req,
            ClaimsPrincipal user,
            NpgsqlDataSource ds,
            KunlunFinanceRepository finRepo,
            CancellationToken ct) =>
        {
            if (!HasPerm(user, KunlunPermissions.MemberWrite))
                return Results.Json(new { error = "无新建会员权限 (kunlun.waterstation:member:write)" }, statusCode: StatusCodes.Status403Forbidden);

            var name = req.Name?.Trim() ?? "";
            var phone = req.Phone?.Trim() ?? "";
            if (string.IsNullOrEmpty(name) || phone.Length != 11 || !phone.StartsWith('1'))
                return Results.BadRequest(new { error = "请填写有效姓名与 11 位手机号" });

            var id = Guid.NewGuid();
            var memberNo = $"No.{Random.Shared.Next(100000, 999999)}";
            await using var conn = await ds.OpenConnectionAsync(ct);
            await using var cmd = new NpgsqlCommand("""
                INSERT INTO plugin_kunlun_waterstation.members
                    (id, tenant_id, member_no, name, phone, default_address, status, source)
                VALUES (@id, @tid, @no, @name, @phone, @addr, 'ACTIVE', 'STAFF_CREATED')
                ON CONFLICT (tenant_id, phone) DO NOTHING
                RETURNING id, member_no, name, phone
                """, conn);
            cmd.Parameters.AddWithValue("id", id);
            cmd.Parameters.AddWithValue("tid", finRepo.TenantId);
            cmd.Parameters.AddWithValue("no", memberNo);
            cmd.Parameters.AddWithValue("name", name);
            cmd.Parameters.AddWithValue("phone", phone);
            cmd.Parameters.AddWithValue("addr", (object?)req.DefaultAddress ?? DBNull.Value);

            await using var r = await cmd.ExecuteReaderAsync(ct);
            if (!await r.ReadAsync(ct))
                return Results.Conflict(new { error = "该手机号已存在会员档案" });

            return Results.Ok(new
            {
                id = r.GetGuid(0),
                memberNo = r.GetString(1),
                name = r.GetString(2),
                phone = r.GetString(3)
            });
        }).RequireAuthorization();

        // 1b. 查询会员列表与搜索 (支持按卡号/姓名/手机号检索)
        app.MapGet("/api/members", async (
            string? q,
            ClaimsPrincipal user,
            NpgsqlDataSource ds,
            KunlunFinanceRepository finRepo,
            CancellationToken ct) =>
        {
            if (!HasPerm(user, KunlunPermissions.MemberRead))
                return Results.Json(new { error = "无查询会员权限 (kunlun.waterstation:member:read)" }, statusCode: StatusCodes.Status403Forbidden);

            await using var conn = await ds.OpenConnectionAsync(ct);
            await using var cmd = new NpgsqlCommand("""
                SELECT id, member_no, name, phone, COALESCE(default_address, ''),
                       bucket_delivery_tickets, bucket_pickup_tickets, bag_pickup_tickets, bag_delivery_tickets,
                       deposit_amount, held_buckets, held_bags, status,
                       reserved_bucket_delivery_tickets, reserved_bucket_pickup_tickets,
                       reserved_bag_pickup_tickets, reserved_bag_delivery_tickets, created_at
                FROM plugin_kunlun_waterstation.members
                WHERE tenant_id = @tid
                  AND (@q IS NULL OR member_no ILIKE @q OR name ILIKE @q OR phone ILIKE @q)
                ORDER BY created_at DESC
                LIMIT 50
                """, conn);
            cmd.Parameters.AddWithValue("tid", finRepo.TenantId);
            cmd.Parameters.Add(new NpgsqlParameter("q", NpgsqlTypes.NpgsqlDbType.Varchar)
            {
                Value = string.IsNullOrWhiteSpace(q) ? DBNull.Value : $"%{q.Trim()}%"
            });

            var list = new List<object>();
            await using var r = await cmd.ExecuteReaderAsync(ct);
            while (await r.ReadAsync(ct))
            {
                list.Add(new
                {
                    id = r.GetGuid(0),
                    memberNo = r.GetString(1),
                    name = r.GetString(2),
                    phone = r.GetString(3),
                    defaultAddress = r.GetString(4),
                    bucketDeliveryTickets = r.GetInt32(5),
                    bucketPickupTickets = r.GetInt32(6),
                    bagPickupTickets = r.GetInt32(7),
                    bagDeliveryTickets = r.GetInt32(8),
                    depositAmount = r.GetDecimal(9),
                    heldBuckets = r.GetInt32(10),
                    heldBags = r.GetInt32(11),
                    status = r.GetString(12),
                    reservedBucketDeliveryTickets = r.GetInt32(13),
                    reservedBucketPickupTickets = r.GetInt32(14),
                    reservedBagPickupTickets = r.GetInt32(15),
                    reservedBagDeliveryTickets = r.GetInt32(16),
                    createdAt = r.GetDateTime(17)
                });
            }
            return Results.Ok(list);
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

            var ctype = req.ContainerType.ToUpperInvariant();
            await using var conn = await ds.OpenConnectionAsync(ct);
            await using var tx = await conn.BeginTransactionAsync(ct);

            // 获取当前容器押金单价
            decimal unitPrice;
            await using (var cfgCmd = new NpgsqlCommand("""
                SELECT unit_deposit FROM plugin_kunlun_waterstation.container_configs
                WHERE tenant_id = @tid AND container_type = @ct
                """, conn, tx))
            {
                cfgCmd.Parameters.AddWithValue("tid", finRepo.TenantId);
                cfgCmd.Parameters.AddWithValue("ct", ctype);
                var val = await cfgCmd.ExecuteScalarAsync(ct);
                if (val is null) return Results.BadRequest(new { error = "无效容器类型" });
                unitPrice = Convert.ToDecimal(val);
            }

            var totalAmt = unitPrice * req.Quantity;
            var lotId = Guid.NewGuid();
            var depositNo = $"YJ{DateTime.UtcNow:yyyyMMdd}{Random.Shared.Next(1000, 9999)}";
            var operatorName = user.FindFirstValue("display_name") ?? "员工";

            await using (var insLot = new NpgsqlCommand("""
                INSERT INTO plugin_kunlun_waterstation.deposit_lots
                    (id, tenant_id, deposit_no, idempotency_key, member_id, container_type, unit_price, paid_qty, refunded_qty, remaining_qty, total_amount, pay_method, operator_name)
                VALUES
                    (@id, @tid, @no, @key, @mid, @ct, @unit, @qty, 0, @qty, @tot, @pay, @op)
                """, conn, tx))
            {
                insLot.Parameters.AddWithValue("id", lotId);
                insLot.Parameters.AddWithValue("tid", finRepo.TenantId);
                insLot.Parameters.AddWithValue("no", depositNo);
                insLot.Parameters.AddWithValue("key", req.IdempotencyKey);
                insLot.Parameters.AddWithValue("mid", req.MemberId);
                insLot.Parameters.AddWithValue("ct", ctype);
                insLot.Parameters.AddWithValue("unit", unitPrice);
                insLot.Parameters.AddWithValue("qty", req.Quantity);
                insLot.Parameters.AddWithValue("tot", totalAmt);
                insLot.Parameters.AddWithValue("pay", req.PayMethod);
                insLot.Parameters.AddWithValue("op", operatorName);
                await insLot.ExecuteNonQueryAsync(ct);
            }

            await using (var updMem = new NpgsqlCommand("""
                UPDATE plugin_kunlun_waterstation.members
                SET deposit_amount = deposit_amount + @amt
                WHERE id = @mid
                """, conn, tx))
            {
                updMem.Parameters.AddWithValue("amt", totalAmt);
                updMem.Parameters.AddWithValue("mid", req.MemberId);
                await updMem.ExecuteNonQueryAsync(ct);
            }

            await tx.CommitAsync(ct);
            return Results.Ok(new { lotId, depositNo, containerType = ctype, unitPrice, quantity = req.Quantity, totalAmount = totalAmt });
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

            var ctype = req.ContainerType.ToUpperInvariant();
            var delta = req.FullOutN - req.EmptyInM;
            var col = ctype == "BUCKET" ? "held_buckets" : "held_bags";

            await using var conn = await ds.OpenConnectionAsync(ct);
            await using var cmd = new NpgsqlCommand($"""
                UPDATE plugin_kunlun_waterstation.members
                SET {col} = GREATEST(0, {col} + @delta)
                WHERE id = @mid
                RETURNING {col}, deposit_amount
                """, conn);
            cmd.Parameters.AddWithValue("delta", delta);
            cmd.Parameters.AddWithValue("mid", req.MemberId);
            await using var r = await cmd.ExecuteReaderAsync(ct);
            if (!await r.ReadAsync(ct)) return Results.NotFound();

            return Results.Ok(new
            {
                memberId = req.MemberId,
                containerType = ctype,
                fullOutN = req.FullOutN,
                emptyInM = req.EmptyInM,
                holdingDelta = delta,
                currentHeld = r.GetInt32(0),
                depositAmountUnchanged = r.GetDecimal(1)
            });
        }).RequireAuthorization();

        // 8. 退押金核对与登记（AC-11 被持有占用时阻止超额退款 + AC-12 按历史批次原收取单价计算退款金额）
        app.MapPost("/api/deposits/refund", async (
            RefundDepositRequest req,
            ClaimsPrincipal user,
            NpgsqlDataSource ds,
            KunlunFinanceRepository finRepo,
            CancellationToken ct) =>
        {
            if (!HasPerm(user, KunlunPermissions.DepositRefundApply) && !HasPerm(user, KunlunPermissions.DepositRefundApprove))
                return Results.Json(new { error = "无押金退款权限 (AC-16)" }, statusCode: StatusCodes.Status403Forbidden);

            var ctype = req.ContainerType.ToUpperInvariant();
            var heldCol = ctype == "BUCKET" ? "held_buckets" : "held_bags";

            await using var conn = await ds.OpenConnectionAsync(ct);
            await using var tx = await conn.BeginTransactionAsync(ct);

            // 读取当前持有容器数
            int currentHeld;
            await using (var mCmd = new NpgsqlCommand($"SELECT {heldCol} FROM plugin_kunlun_waterstation.members WHERE id = @mid FOR UPDATE", conn, tx))
            {
                mCmd.Parameters.AddWithValue("mid", req.MemberId);
                var v = await mCmd.ExecuteScalarAsync(ct);
                if (v is null) return Results.NotFound();
                currentHeld = Convert.ToInt32(v);
            }

            // 读取未退押金批次（按 FIFO 顺序锁定）
            var lots = new List<(Guid Id, string No, decimal UnitPrice, int Remaining)>();
            await using (var lCmd = new NpgsqlCommand("""
                SELECT id, deposit_no, unit_price, remaining_qty
                FROM plugin_kunlun_waterstation.deposit_lots
                WHERE tenant_id = @tid AND member_id = @mid AND container_type = @ct AND remaining_qty > 0
                ORDER BY created_at ASC
                FOR UPDATE
                """, conn, tx))
            {
                lCmd.Parameters.AddWithValue("tid", finRepo.TenantId);
                lCmd.Parameters.AddWithValue("mid", req.MemberId);
                lCmd.Parameters.AddWithValue("ct", ctype);
                await using var r = await lCmd.ExecuteReaderAsync(ct);
                while (await r.ReadAsync(ct))
                {
                    lots.Add((r.GetGuid(0), r.GetString(1), r.GetDecimal(2), r.GetInt32(3)));
                }
            }

            var totalPaidRemaining = lots.Sum(x => x.Remaining);
            var refundableQty = Math.Max(0, totalPaidRemaining - currentHeld);

            // AC-11: 押金被持有容器占用时阻止超额退款并返回明确原因
            if (req.Quantity > refundableQty)
            {
                return Results.BadRequest(new
                {
                    error = $"可退押金数量不足：已交未退 {totalPaidRemaining} 个，当前实际持有占用 {currentHeld} 个，最多可退 {refundableQty} 个（请先登记归还容器）",
                    totalPaidRemaining,
                    currentHeld,
                    refundableQty
                });
            }

            // AC-12: 按历史原收款批次单价计算退款金额（不按修改后的当前单价）
            var needToRefund = req.Quantity;
            decimal refundAmount = 0m;
            var breakdown = new List<object>();

            foreach (var lot in lots)
            {
                if (needToRefund <= 0) break;
                var take = Math.Min(lot.Remaining, needToRefund);
                var subAmt = take * lot.UnitPrice;
                refundAmount += subAmt;
                needToRefund -= take;

                await using var updLot = new NpgsqlCommand("""
                    UPDATE plugin_kunlun_waterstation.deposit_lots
                    SET refunded_qty = refunded_qty + @take, remaining_qty = remaining_qty - @take
                    WHERE id = @id
                    """, conn, tx);
                updLot.Parameters.AddWithValue("take", take);
                updLot.Parameters.AddWithValue("id", lot.Id);
                await updLot.ExecuteNonQueryAsync(ct);

                breakdown.Add(new { lotNo = lot.No, takeQty = take, originalUnitPrice = lot.UnitPrice, subAmount = subAmt });
            }

            var refundNo = $"TK{DateTime.UtcNow:yyyyMMdd}{Random.Shared.Next(1000, 9999)}";
            var operatorName = user.FindFirstValue("display_name") ?? "员工";

            await using (var insRef = new NpgsqlCommand("""
                INSERT INTO plugin_kunlun_waterstation.deposit_refunds
                    (id, tenant_id, refund_no, idempotency_key, member_id, container_type, refund_qty, refund_amount, lot_breakdown, operator_name)
                VALUES (@id, @tid, @no, @key, @mid, @ct, @qty, @amt, @bd::jsonb, @op)
                """, conn, tx))
            {
                insRef.Parameters.AddWithValue("id", Guid.NewGuid());
                insRef.Parameters.AddWithValue("tid", finRepo.TenantId);
                insRef.Parameters.AddWithValue("no", refundNo);
                insRef.Parameters.AddWithValue("key", req.IdempotencyKey);
                insRef.Parameters.AddWithValue("mid", req.MemberId);
                insRef.Parameters.AddWithValue("ct", ctype);
                insRef.Parameters.AddWithValue("qty", req.Quantity);
                insRef.Parameters.AddWithValue("amt", refundAmount);
                insRef.Parameters.AddWithValue("bd", JsonSerializer.Serialize(breakdown));
                insRef.Parameters.AddWithValue("op", operatorName);
                await insRef.ExecuteNonQueryAsync(ct);
            }

            await using (var updMem = new NpgsqlCommand("""
                UPDATE plugin_kunlun_waterstation.members
                SET deposit_amount = GREATEST(0, deposit_amount - @amt)
                WHERE id = @mid
                """, conn, tx))
            {
                updMem.Parameters.AddWithValue("amt", refundAmount);
                updMem.Parameters.AddWithValue("mid", req.MemberId);
                await updMem.ExecuteNonQueryAsync(ct);
            }

            await tx.CommitAsync(ct);
            return Results.Ok(new
            {
                refundNo,
                containerType = ctype,
                refundQty = req.Quantity,
                refundAmount,
                lotBreakdown = breakdown
            });
        }).RequireAuthorization();
    }

    private static bool HasPerm(ClaimsPrincipal user, string perm) =>
        user.FindAll("perm").Any(c => c.Value == perm || c.Value == "kunlun.waterstation:*");
}
