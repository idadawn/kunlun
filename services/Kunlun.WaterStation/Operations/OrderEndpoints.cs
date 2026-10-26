using System.Security.Claims;
using System.Text.Json;
using Kunlun.WaterStation.Auth;
using Npgsql;

namespace Kunlun.WaterStation.Operations;

public static class OrderEndpoints
{
    public static void MapOrderEndpoints(this WebApplication app)
    {
        var api = app.MapGroup("/api");

        api.MapPost("/orders/{orderId:guid}/accept", async (Guid orderId, ClaimsPrincipal user, NpgsqlDataSource db, KunlunOrderRepository repo, CancellationToken ct) =>
        {
            if (!user.HasClaim("perm", KunlunPermissions.OrderAccept)) return Results.Forbid();
            await using var conn = await db.OpenConnectionAsync(ct);
            await using var tx = await conn.BeginTransactionAsync(ct);
            await using var cmd = TicketBatches.Command(conn, tx, "SELECT status,fulfill_mode FROM plugin_kunlun_waterstation.water_orders WHERE tenant_id=@tid AND id=@id FOR UPDATE", ("tid", repo.TenantId), ("id", orderId));
            await using var r = await cmd.ExecuteReaderAsync(ct);
            if (!await r.ReadAsync(ct)) return Results.NotFound();
            var status = r.GetString(0);
            if (r.GetString(1) != "DELIVERY" || status is not ("PENDING" or "DISPATCHED")) throw new BusinessRuleException("当前订单不能接单");
            await r.CloseAsync();
            await TicketBatches.Exec(conn, tx, "UPDATE plugin_kunlun_waterstation.water_orders SET status='DISPATCHED' WHERE tenant_id=@tid AND id=@id", ct, ("tid", repo.TenantId), ("id", orderId));
            await tx.CommitAsync(ct);
            return Results.Ok(new { id = orderId, status = "DISPATCHED" });
        }).RequireAuthorization();

        // 1. 创建用水订单 (会员自助下单 / 员工代客下单) - AC-04, AC-05, AC-15, AC-16
        api.MapPost("/orders", async (
            CreateWaterOrderRequest req,
            ClaimsPrincipal user,
            NpgsqlDataSource db,
            KunlunOrderRepository orderRepo,
            CancellationToken ct) =>
        {
            var subjectType = user.FindFirstValue("subject_type");
            var subStr = user.FindFirstValue(ClaimTypes.NameIdentifier) ?? user.FindFirstValue("sub");
            var actorName = user.FindFirstValue("display_name") ?? "未知操作人";

            if (subjectType == "MEMBER")
            {
                if (!Guid.TryParse(subStr, out var callerMemberId) || callerMemberId != req.MemberId)
                {
                    return Results.Json(new { error = "FORBIDDEN_MEMBER_ISOLATION", message = "会员仅可为本人账号发起订水或自提申请（AC-15）" }, statusCode: 403);
                }
            }
            else if (subjectType == "STAFF")
            {
                var perms = user.FindAll("perm").Select(c => c.Value).ToHashSet();
                if (!perms.Contains(KunlunPermissions.OrderCreate))
                {
                    return Results.Json(new { error = "FORBIDDEN_PERMISSION", message = "缺少代客下单权限 order.create（AC-16）" }, statusCode: 403);
                }
            }
            else
            {
                return Results.Unauthorized();
            }

            if (req.OrderQty <= 0 || string.IsNullOrWhiteSpace(req.IdempotencyKey))
            {
                return Results.BadRequest(new { error = "INVALID_ORDER", message = "订水数量必须大于 0 且必须提供幂等键" });
            }

            if (req.WaterType is not ("BUCKET_18_9L" or "BAG_7_5L") || req.FulfillMode is not ("PICKUP" or "DELIVERY"))
                throw new BusinessRuleException("水品或领取方式无效");
            (string availCol, string reservedCol, _) = KunlunOrderRepository.ResolveTicketColumns(req.WaterType, req.FulfillMode);

            await using var conn = await db.OpenConnectionAsync(ct);
            await using var tx = await conn.BeginTransactionAsync(ct);

            await TicketBatches.LockRequest(conn, tx, orderRepo.TenantId, "order", req.IdempotencyKey, ct);
            // AC-05: 幂等键检查
            await using (var idemCmd = new NpgsqlCommand("""
                SELECT id, order_no, water_type, fulfill_mode, order_qty, reserved_qty, pickup_code, status, address_snapshot, member_id
                FROM plugin_kunlun_waterstation.water_orders
                WHERE tenant_id = @tid AND idempotency_key = @key
                """, conn, tx))
            {
                idemCmd.Parameters.AddWithValue("tid", orderRepo.TenantId);
                idemCmd.Parameters.AddWithValue("key", req.IdempotencyKey);
                await using var r = await idemCmd.ExecuteReaderAsync(ct);
                if (await r.ReadAsync(ct))
                {
                    if (r.GetGuid(9) != req.MemberId || r.GetString(2) != req.WaterType || r.GetString(3) != req.FulfillMode || r.GetInt32(4) != req.OrderQty)
                        throw new BusinessRuleException("请求标识已用于其他水单", 409);
                    var existingResp = new
                    {
                        id = r.GetGuid(0),
                        orderNo = r.GetString(1),
                        waterType = r.GetString(2),
                        fulfillMode = r.GetString(3),
                        orderQty = r.GetInt32(4),
                        reservedQty = r.GetInt32(5),
                        pickupCode = r.IsDBNull(6) ? null : r.GetString(6),
                        status = r.GetString(7),
                        addressSnapshot = JsonDocument.Parse(r.GetString(8)).RootElement.Clone(),
                        idempotentReplay = true
                    };
                    await r.CloseAsync();
                    await tx.CommitAsync(ct);
                    return Results.Ok(existingResp);
                }
            }

            var product = await WaterProducts.Read(conn, tx, orderRepo.TenantId, req.WaterType, ct);
            if (req.FulfillMode == "DELIVERY" && req.OrderQty < product.DeliveryMinimum)
                throw new BusinessRuleException($"{product.Name}免费配送，{product.DeliveryMinimum}{(req.WaterType == "BAG_7_5L" ? "袋" : "桶")}起送");
            var productSnapshot = new { waterLabel = product.Name, capacityLiters = product.CapacityLiters, deliveryMinimum = product.DeliveryMinimum, deliveryFee = product.DeliveryFee };

            // 锁定会员并校验水票可用余额 (AC-04: 严禁透支为负数)
            string memberName, memberPhone;
            int currentAvail, currentReserved;
            await using (var mCmd = new NpgsqlCommand($"""
                SELECT name, phone, {availCol}, {reservedCol}, status
                FROM plugin_kunlun_waterstation.members
                WHERE tenant_id = @tid AND id = @mid
                FOR UPDATE
                """, conn, tx))
            {
                mCmd.Parameters.AddWithValue("tid", orderRepo.TenantId);
                mCmd.Parameters.AddWithValue("mid", req.MemberId);
                await using var r = await mCmd.ExecuteReaderAsync(ct);
                if (!await r.ReadAsync(ct))
                {
                    return Results.NotFound(new { error = "MEMBER_NOT_FOUND", message = "会员不存在" });
                }
                if (r.GetString(4) != "ACTIVE") throw new BusinessRuleException("会员已停用");
                memberName = r.GetString(0);
                memberPhone = r.GetString(1);
                currentAvail = r.GetInt32(2);
                currentReserved = r.GetInt32(3);
            }

            // 配送单使用会员地址簿中选定的地址（未指定时取默认地址）；自提单仅记录会员本人联系方式。
            var address = req.FulfillMode == "DELIVERY"
                ? await MemberAddresses.ForOrder(conn, tx, orderRepo.TenantId, req.MemberId, req.AddressId, ct)
                    ?? throw new BusinessRuleException("请先为会员添加收货地址后再预约配送")
                : null;

            if (currentAvail < req.OrderQty)
            {
                return Results.BadRequest(new
                {
                    error = "TICKET_INSUFFICIENT",
                    message = $"可用水票余额不足（当前可用 {currentAvail} 份，申请 {req.OrderQty} 份），系统禁止水票透支（AC-04）",
                    availableTickets = currentAvail,
                    requestedQty = req.OrderQty
                });
            }

            var newAvail = currentAvail - req.OrderQty;
            var newReserved = currentReserved + req.OrderQty;

            await using (var uCmd = new NpgsqlCommand($"""
                UPDATE plugin_kunlun_waterstation.members
                SET {availCol} = @avail,
                    {reservedCol} = @res
                WHERE tenant_id = @tid AND id = @mid
                """, conn, tx))
            {
                uCmd.Parameters.AddWithValue("avail", newAvail);
                uCmd.Parameters.AddWithValue("res", newReserved);
                uCmd.Parameters.AddWithValue("tid", orderRepo.TenantId);
                uCmd.Parameters.AddWithValue("mid", req.MemberId);
                await uCmd.ExecuteNonQueryAsync(ct);
            }

            var orderId = Guid.NewGuid();
            var orderNo = $"ORD-{DateTime.UtcNow:yyyyMMdd}-{Random.Shared.Next(100000, 999999)}";
            var pickupCode = req.FulfillMode == "PICKUP"
                ? Random.Shared.Next(100000, 999999).ToString()
                : null;

            var addressSnapshotJson = JsonSerializer.Serialize(new
            {
                addressId = address?.Id,
                contactName = address?.ContactName ?? memberName,
                contactPhone = address?.ContactPhone ?? memberPhone,
                location = address?.Location ?? "",
                doorNo = address?.DoorNo ?? "",
                address = address?.FullAddress ?? "",
                snapshotAt = DateTimeOffset.UtcNow
            });

            await using (var insCmd = new NpgsqlCommand("""
                INSERT INTO plugin_kunlun_waterstation.water_orders
                    (id, tenant_id, order_no, idempotency_key, member_id, water_type, fulfill_mode,
                     order_qty, reserved_qty, pickup_code, address_snapshot, appointment_slot,
                     status, created_by_type, created_by_name, product_snapshot)
                VALUES
                    (@id, @tid, @no, @key, @mid, @wtype, @fmode,
                     @oqty, @rqty, @pcode, @snap::jsonb, @slot,
                     'PENDING', @ctype, @cname, @product::jsonb)
                """, conn, tx))
            {
                insCmd.Parameters.AddWithValue("id", orderId);
                insCmd.Parameters.AddWithValue("tid", orderRepo.TenantId);
                insCmd.Parameters.AddWithValue("no", orderNo);
                insCmd.Parameters.AddWithValue("key", req.IdempotencyKey);
                insCmd.Parameters.AddWithValue("mid", req.MemberId);
                insCmd.Parameters.AddWithValue("wtype", req.WaterType);
                insCmd.Parameters.AddWithValue("fmode", req.FulfillMode);
                insCmd.Parameters.AddWithValue("oqty", req.OrderQty);
                insCmd.Parameters.AddWithValue("rqty", req.OrderQty);
                insCmd.Parameters.AddWithValue("pcode", (object?)pickupCode ?? DBNull.Value);
                insCmd.Parameters.AddWithValue("snap", addressSnapshotJson);
                insCmd.Parameters.AddWithValue("slot", (object?)req.AppointmentSlot ?? DBNull.Value);
                insCmd.Parameters.AddWithValue("ctype", subjectType);
                insCmd.Parameters.AddWithValue("cname", actorName);
                insCmd.Parameters.AddWithValue("product", JsonSerializer.Serialize(productSnapshot));
                await insCmd.ExecuteNonQueryAsync(ct);
            }

            await TicketBatches.Reserve(conn, tx, orderRepo.TenantId, req.MemberId, req.WaterType, req.FulfillMode, orderId, req.OrderQty, ct);
            // 写入水票预占流水 ORDER_RESERVE
            await using (var lCmd = new NpgsqlCommand("""
                INSERT INTO plugin_kunlun_waterstation.ticket_ledgers
                    (tenant_id, ledger_no, member_id, water_type, fulfill_mode, change_type, delta_qty, balance_after, ref_no, operator_name)
                VALUES
                    (@tid, @lno, @mid, @wtype, @fmode, 'ORDER_RESERVE', @delta, @bal, @ref, @op)
                """, conn, tx))
            {
                lCmd.Parameters.AddWithValue("tid", orderRepo.TenantId);
                lCmd.Parameters.AddWithValue("lno", $"TL-{orderNo}-RSV");
                lCmd.Parameters.AddWithValue("mid", req.MemberId);
                lCmd.Parameters.AddWithValue("wtype", req.WaterType);
                lCmd.Parameters.AddWithValue("fmode", req.FulfillMode);
                lCmd.Parameters.AddWithValue("delta", -req.OrderQty);
                lCmd.Parameters.AddWithValue("bal", newAvail);
                lCmd.Parameters.AddWithValue("ref", orderNo);
                lCmd.Parameters.AddWithValue("op", actorName);
                await lCmd.ExecuteNonQueryAsync(ct);
            }

            await tx.CommitAsync(ct);

            return Results.Ok(new
            {
                id = orderId,
                orderNo,
                waterType = req.WaterType,
                fulfillMode = req.FulfillMode,
                orderQty = req.OrderQty,
                reservedQty = req.OrderQty,
                availableTicketsAfter = newAvail,
                reservedTicketsAfter = newReserved,
                pickupCode,
                status = "PENDING",
                addressSnapshot = JsonDocument.Parse(addressSnapshotJson).RootElement.Clone(),
                idempotentReplay = false
            });
        }).RequireAuthorization();

        // 2. 查询订单列表 (AC-15: 会员仅看本人订单)
        api.MapGet("/orders", async (
            Guid? memberId,
            string? status,
            string? pickupCode,
            ClaimsPrincipal user,
            NpgsqlDataSource db,
            KunlunOrderRepository orderRepo,
            CancellationToken ct) =>
        {
            var subjectType = user.FindFirstValue("subject_type");
            var subStr = user.FindFirstValue(ClaimTypes.NameIdentifier) ?? user.FindFirstValue("sub");

            Guid? filterMemberId = memberId;
            if (subjectType == "MEMBER")
            {
                if (!Guid.TryParse(subStr, out var callerMemberId))
                    return Results.Unauthorized();
                if (memberId.HasValue && memberId.Value != callerMemberId)
                    return Results.Json(new { error = "FORBIDDEN_MEMBER_ISOLATION", message = "会员仅可查询本人订单（AC-15）" }, statusCode: 403);
                filterMemberId = callerMemberId;
            }

            await using var conn = await db.OpenConnectionAsync(ct);
            await using var cmd = new NpgsqlCommand("""
                SELECT id, order_no, member_id, water_type, fulfill_mode, order_qty, reserved_qty,
                       actual_qty, full_out_qty, empty_in_qty, pickup_code, address_snapshot,
                       status, diff_reason, cancel_reason, created_at, product_snapshot
                FROM plugin_kunlun_waterstation.water_orders
                WHERE tenant_id = @tid
                  AND (@mid IS NULL OR member_id = @mid)
                  AND (@st IS NULL OR status = @st)
                  AND (@pcode IS NULL OR pickup_code = @pcode)
                ORDER BY created_at DESC
                LIMIT 50
                """, conn);
            cmd.Parameters.AddWithValue("tid", orderRepo.TenantId);
            cmd.Parameters.Add(new NpgsqlParameter("mid", NpgsqlTypes.NpgsqlDbType.Uuid) { Value = (object?)filterMemberId ?? DBNull.Value });
            cmd.Parameters.Add(new NpgsqlParameter("st", NpgsqlTypes.NpgsqlDbType.Varchar) { Value = (object?)status ?? DBNull.Value });
            cmd.Parameters.Add(new NpgsqlParameter("pcode", NpgsqlTypes.NpgsqlDbType.Varchar) { Value = (object?)pickupCode ?? DBNull.Value });

            var list = new List<object>();
            await using var r = await cmd.ExecuteReaderAsync(ct);
            while (await r.ReadAsync(ct))
            {
                list.Add(new
                {
                    id = r.GetGuid(0),
                    orderNo = r.GetString(1),
                    memberId = r.GetGuid(2),
                    waterType = r.GetString(3),
                    fulfillMode = r.GetString(4),
                    orderQty = r.GetInt32(5),
                    reservedQty = r.GetInt32(6),
                    actualQty = r.IsDBNull(7) ? (int?)null : r.GetInt32(7),
                    fullOutQty = r.IsDBNull(8) ? (int?)null : r.GetInt32(8),
                    emptyInQty = r.IsDBNull(9) ? (int?)null : r.GetInt32(9),
                    pickupCode = r.IsDBNull(10) ? null : r.GetString(10),
                    addressSnapshot = JsonDocument.Parse(r.GetString(11)).RootElement.Clone(),
                    status = r.GetString(12),
                    diffReason = r.IsDBNull(13) ? null : r.GetString(13),
                    cancelReason = r.IsDBNull(14) ? null : r.GetString(14),
                    createdAt = r.GetDateTime(15),
                    productSnapshot = r.IsDBNull(16) ? (JsonElement?)null : JsonSerializer.Deserialize<JsonElement>(r.GetString(16))
                });
            }
            return Results.Ok(list);
        }).RequireAuthorization();

        // 3. 取消订单并原路释放预占水票 (AC-06)
        api.MapPost("/orders/{orderId:guid}/cancel", async (
            Guid orderId,
            CancelWaterOrderRequest req,
            ClaimsPrincipal user,
            NpgsqlDataSource db,
            KunlunOrderRepository orderRepo,
            CancellationToken ct) =>
        {
            var subjectType = user.FindFirstValue("subject_type");
            var subStr = user.FindFirstValue(ClaimTypes.NameIdentifier) ?? user.FindFirstValue("sub");
            var actorName = user.FindFirstValue("display_name") ?? "未知操作人";

            await using var conn = await db.OpenConnectionAsync(ct);
            await using var tx = await conn.BeginTransactionAsync(ct);

            string orderNo, waterType, fulfillMode, status;
            Guid memberId;
            int reservedQty;

            await using (var oCmd = new NpgsqlCommand("""
                SELECT order_no, member_id, water_type, fulfill_mode, reserved_qty, status
                FROM plugin_kunlun_waterstation.water_orders
                WHERE tenant_id = @tid AND id = @oid
                FOR UPDATE
                """, conn, tx))
            {
                oCmd.Parameters.AddWithValue("tid", orderRepo.TenantId);
                oCmd.Parameters.AddWithValue("oid", orderId);
                await using var r = await oCmd.ExecuteReaderAsync(ct);
                if (!await r.ReadAsync(ct))
                    return Results.NotFound(new { error = "ORDER_NOT_FOUND", message = "订单不存在" });

                orderNo = r.GetString(0);
                memberId = r.GetGuid(1);
                waterType = r.GetString(2);
                fulfillMode = r.GetString(3);
                reservedQty = r.GetInt32(4);
                status = r.GetString(5);
            }

            if (subjectType == "MEMBER")
            {
                if (!Guid.TryParse(subStr, out var callerMemberId) || callerMemberId != memberId)
                    return Results.Json(new { error = "FORBIDDEN_MEMBER_ISOLATION", message = "会员仅可取消本人订单（AC-15）" }, statusCode: 403);
            }

            if (status == "CANCELLED")
            {
                await tx.CommitAsync(ct);
                return Results.Ok(new { id = orderId, orderNo, status = "CANCELLED", idempotentReplay = true });
            }

            if (status != "PENDING" && status != "DISPATCHED")
            {
                return Results.BadRequest(new { error = "INVALID_ORDER_STATE", message = $"当前订单状态 {status} 不可取消" });
            }

            (string availCol, string reservedCol, _) = KunlunOrderRepository.ResolveTicketColumns(waterType, fulfillMode);

            int newAvail, newReserved;
            await using (var mCmd = new NpgsqlCommand($"""
                UPDATE plugin_kunlun_waterstation.members
                SET {availCol} = {availCol} + @rqty,
                    {reservedCol} = {reservedCol} - @rqty
                WHERE tenant_id = @tid AND id = @mid
                RETURNING {availCol}, {reservedCol}
                """, conn, tx))
            {
                mCmd.Parameters.AddWithValue("rqty", reservedQty);
                mCmd.Parameters.AddWithValue("tid", orderRepo.TenantId);
                mCmd.Parameters.AddWithValue("mid", memberId);
                await using var r = await mCmd.ExecuteReaderAsync(ct);
                await r.ReadAsync(ct);
                newAvail = r.GetInt32(0);
                newReserved = r.GetInt32(1);
            }

            await using (var uCmd = new NpgsqlCommand("""
                UPDATE plugin_kunlun_waterstation.water_orders
                SET status = 'CANCELLED',
                    reserved_qty = 0,
                    cancel_reason = @reason,
                    cancelled_at = NOW()
                WHERE tenant_id = @tid AND id = @oid
                """, conn, tx))
            {
                uCmd.Parameters.AddWithValue("reason", req.CancelReason ?? "用户/员工主动取消");
                uCmd.Parameters.AddWithValue("tid", orderRepo.TenantId);
                uCmd.Parameters.AddWithValue("oid", orderId);
                await uCmd.ExecuteNonQueryAsync(ct);
            }

            await TicketBatches.Settle(conn, tx, orderId, 0, ct);
            // 写入水票释放流水 ORDER_RELEASE (AC-06)
            await using (var lCmd = new NpgsqlCommand("""
                INSERT INTO plugin_kunlun_waterstation.ticket_ledgers
                    (tenant_id, ledger_no, member_id, water_type, fulfill_mode, change_type, delta_qty, balance_after, ref_no, operator_name)
                VALUES
                    (@tid, @lno, @mid, @wtype, @fmode, 'ORDER_RELEASE', @delta, @bal, @ref, @op)
                """, conn, tx))
            {
                lCmd.Parameters.AddWithValue("tid", orderRepo.TenantId);
                lCmd.Parameters.AddWithValue("lno", $"TL-{orderNo}-REL");
                lCmd.Parameters.AddWithValue("mid", memberId);
                lCmd.Parameters.AddWithValue("wtype", waterType);
                lCmd.Parameters.AddWithValue("fmode", fulfillMode);
                lCmd.Parameters.AddWithValue("delta", reservedQty);
                lCmd.Parameters.AddWithValue("bal", newAvail);
                lCmd.Parameters.AddWithValue("ref", orderNo);
                lCmd.Parameters.AddWithValue("op", actorName);
                await lCmd.ExecuteNonQueryAsync(ct);
            }

            await tx.CommitAsync(ct);

            return Results.Ok(new
            {
                id = orderId,
                orderNo,
                status = "CANCELLED",
                releasedTickets = reservedQty,
                availableTicketsAfter = newAvail,
                reservedTicketsAfter = newReserved
            });
        }).RequireAuthorization();

        // 4. 配送签收 / 门店自提核销 (AC-07, AC-08, AC-09, AC-10, AC-14, AC-20)
        api.MapPost("/orders/{orderId:guid}/fulfill", async (
            Guid orderId,
            FulfillWaterOrderRequest req,
            ClaimsPrincipal user,
            NpgsqlDataSource db,
            KunlunOrderRepository orderRepo,
            CancellationToken ct) =>
        {
            var perms = user.FindAll("perm").Select(c => c.Value).ToHashSet();
            if (!perms.Contains(KunlunPermissions.OrderFulfill))
                return Results.Json(new { error = "FORBIDDEN_PERMISSION", message = "缺少订单核销/签收权限 order.fulfill（AC-16）" }, statusCode: 403);

            var operatorName = user.FindFirstValue("display_name") ?? "配送员/店员";
            return await ExecuteFulfillOrderAsync(orderId, null, req, operatorName, db, orderRepo, ct);
        }).RequireAuthorization();

        // 5. 门店 6 位自提码一键核销快捷端点
        api.MapPost("/orders/pickup-verify", async (
            VerifyPickupCodeRequest req,
            ClaimsPrincipal user,
            NpgsqlDataSource db,
            KunlunOrderRepository orderRepo,
            CancellationToken ct) =>
        {
            var perms = user.FindAll("perm").Select(c => c.Value).ToHashSet();
            if (!perms.Contains(KunlunPermissions.OrderFulfill))
                return Results.Json(new { error = "FORBIDDEN_PERMISSION", message = "缺少自提核销权限 order.fulfill（AC-16）" }, statusCode: 403);

            var operatorName = user.FindFirstValue(ClaimTypes.Name) ?? "店员";
            var fulfillReq = new FulfillWaterOrderRequest(req.ActualQty, req.FullOutN, req.EmptyInM, req.PickupCode, req.DiffReason);
            return await ExecuteFulfillOrderAsync(null, req.PickupCode, fulfillReq, operatorName, db, orderRepo, ct);
        }).RequireAuthorization();

        // 6. 五维容器库存与低库存预警查询 (AC-19, AC-20)
        api.MapGet("/containers/summary", async (
            NpgsqlDataSource db,
            KunlunOrderRepository orderRepo,
            CancellationToken ct) =>
        {
            await using var conn = await db.OpenConnectionAsync(ct);
            await using var cmd = new NpgsqlCommand("""
                SELECT container_type, unit_deposit, total_qty, in_station_qty, in_transit_qty,
                       member_held_qty, inspecting_qty, abnormal_qty, warn_threshold, damaged_qty, scrapped_qty
                FROM plugin_kunlun_waterstation.container_configs
                WHERE tenant_id = @tid
                ORDER BY container_type
                """, conn);
            cmd.Parameters.AddWithValue("tid", orderRepo.TenantId);

            var list = new List<object>();
            await using var r = await cmd.ExecuteReaderAsync(ct);
            while (await r.ReadAsync(ct))
            {
                var total = r.GetInt32(2);
                var inStation = r.GetInt32(3);
                var inTransit = r.GetInt32(4);
                var memberHeld = r.GetInt32(5);
                var inspecting = r.GetInt32(6);
                var abnormal = r.GetInt32(7);
                var threshold = r.GetInt32(8);
                var damaged = r.GetInt32(9);
                var scrapped = r.GetInt32(10);
                var sumParts = (long)inStation + inTransit + memberHeld + inspecting + abnormal + damaged;

                list.Add(new
                {
                    containerType = r.GetString(0),
                    unitDeposit = r.GetDecimal(1),
                    totalQty = total,
                    inStationQty = inStation,
                    inTransitQty = inTransit,
                    memberHeldQty = memberHeld,
                    inspectingQty = inspecting,
                    abnormalQty = abnormal,
                    warnThreshold = threshold,
                    damagedQty = damaged,
                    scrappedQty = scrapped,
                    identityValid = total == sumParts,
                    lowStockWarning = inStation < threshold
                });
            }
            return Results.Ok(list);
        }).RequireAuthorization();
    }

    private static async Task<IResult> ExecuteFulfillOrderAsync(
        Guid? orderId,
        string? lookupPickupCode,
        FulfillWaterOrderRequest req,
        string operatorName,
        NpgsqlDataSource db,
        KunlunOrderRepository orderRepo,
        CancellationToken ct)
    {
        if (req.ActualQty <= 0 || req.FullOutN < 0 || req.EmptyInM < 0)
        {
            return Results.BadRequest(new { error = "INVALID_FULFILL_QTY", message = "实送数量必须大于 0，发出/收回容器数不能为负数" });
        }

        await using var conn = await db.OpenConnectionAsync(ct);
        await using var tx = await conn.BeginTransactionAsync(ct);

        Guid resolvedOrderId;
        string orderNo, waterType, fulfillMode, status;
        string? storedPickupCode;
        Guid memberId;
        int orderQty, reservedQty;

        var whereClause = orderId.HasValue
            ? "tenant_id = @tid AND id = @oid"
            : "tenant_id = @tid AND pickup_code = @pcode AND status = 'PENDING'";

        await using (var oCmd = new NpgsqlCommand($"""
            SELECT id, order_no, member_id, water_type, fulfill_mode, order_qty, reserved_qty, pickup_code, status
            FROM plugin_kunlun_waterstation.water_orders
            WHERE {whereClause}
            FOR UPDATE
            """, conn, tx))
        {
            oCmd.Parameters.AddWithValue("tid", orderRepo.TenantId);
            if (orderId.HasValue)
                oCmd.Parameters.AddWithValue("oid", orderId.Value);
            else
                oCmd.Parameters.AddWithValue("pcode", lookupPickupCode ?? "");

            await using var r = await oCmd.ExecuteReaderAsync(ct);
            if (!await r.ReadAsync(ct))
                return Results.NotFound(new { error = "ORDER_NOT_FOUND", message = "未找到待核销的订单或自提码无效" });

            resolvedOrderId = r.GetGuid(0);
            orderNo = r.GetString(1);
            memberId = r.GetGuid(2);
            waterType = r.GetString(3);
            fulfillMode = r.GetString(4);
            orderQty = r.GetInt32(5);
            reservedQty = r.GetInt32(6);
            storedPickupCode = r.IsDBNull(7) ? null : r.GetString(7);
            status = r.GetString(8);
        }

        if (status == "COMPLETED")
        {
            await tx.CommitAsync(ct);
            return Results.Ok(new { id = resolvedOrderId, orderNo, status = "COMPLETED", idempotentReplay = true });
        }

        if (status != "PENDING" && status != "DISPATCHED")
        {
            return Results.BadRequest(new { error = "INVALID_ORDER_STATE", message = $"订单当前状态 {status} 不可核销" });
        }

        if (fulfillMode == "PICKUP" && !string.IsNullOrWhiteSpace(req.PickupCode) && req.PickupCode != storedPickupCode)
        {
            return Results.BadRequest(new { error = "INVALID_PICKUP_CODE", message = "6 位自提核销码不匹配" });
        }

        // AC-14: 实送数量与下单数量不一致时必须填写原因
        if (req.ActualQty != orderQty && string.IsNullOrWhiteSpace(req.DiffReason))
        {
            return Results.BadRequest(new
            {
                error = "DIFF_REASON_REQUIRED",
                message = "实送/实提数量与下单数量不一致时，必须填写差异原因（AC-14）"
            });
        }

        (string availCol, string reservedCol, string containerType) = KunlunOrderRepository.ResolveTicketColumns(waterType, fulfillMode);
        var heldCol = containerType == "BUCKET" ? "held_buckets" : "held_bags";

        int currentAvail, currentReserved, currentHeld;
        decimal depositAmount;
        await using (var mCmd = new NpgsqlCommand($"""
            SELECT {availCol}, {reservedCol}, {heldCol}, deposit_amount
            FROM plugin_kunlun_waterstation.members
            WHERE tenant_id = @tid AND id = @mid
            FOR UPDATE
            """, conn, tx))
        {
            mCmd.Parameters.AddWithValue("tid", orderRepo.TenantId);
            mCmd.Parameters.AddWithValue("mid", memberId);
            await using var r = await mCmd.ExecuteReaderAsync(ct);
            await r.ReadAsync(ct);
            currentAvail = r.GetInt32(0);
            currentReserved = r.GetInt32(1);
            currentHeld = r.GetInt32(2);
            depositAmount = r.GetDecimal(3);
        }

        // AC-04 & AC-14: 计算实送数量与预占数量的差额 (actual_qty - reserved_qty)
        var extraNeeded = req.ActualQty - reservedQty;
        if (extraNeeded > currentAvail)
        {
            return Results.BadRequest(new
            {
                error = "TICKET_INSUFFICIENT_FOR_DIFF",
                message = $"实送 {req.ActualQty} 份超出预占 {reservedQty} 份，需补扣 {extraNeeded} 份水票，但当前可用水票仅 {currentAvail} 份，禁止透支（AC-04, AC-14）",
                availableTickets = currentAvail,
                reservedTickets = reservedQty,
                actualQty = req.ActualQty
            });
        }

        // 计算容器净变动 (N 出 - M 入) 与押金覆盖额度 (AC-08, AC-09, AC-10)
        var deltaHeld = req.FullOutN - req.EmptyInM;
        var newHeld = currentHeld + deltaHeld;
        if (newHeld < 0)
        {
            return Results.BadRequest(new
            {
                error = "INVALID_CONTAINER_RETURN",
                message = $"收回容器数 ({req.EmptyInM}) 超出会员当前持有与本次发出总和 ({currentHeld + req.FullOutN})"
            });
        }

        int coveredDepositQty;
        await using (var depCmd = new NpgsqlCommand("""
            SELECT COALESCE(SUM(remaining_qty), 0)::INT
            FROM plugin_kunlun_waterstation.deposit_lots
            WHERE tenant_id = @tid AND member_id = @mid AND container_type = @ctype
            """, conn, tx))
        {
            depCmd.Parameters.AddWithValue("tid", orderRepo.TenantId);
            depCmd.Parameters.AddWithValue("mid", memberId);
            depCmd.Parameters.AddWithValue("ctype", containerType);
            coveredDepositQty = (int)(await depCmd.ExecuteScalarAsync(ct))!;
        }

        // AC-09: 若本次履约后会员持有桶数 newHeld > 已缴押金覆盖桶数 coveredDepositQty，默认拦截要求先补押金
        if (newHeld > coveredDepositQty && !req.ForceCreditOverride)
        {
            var uncoveredGap = newHeld - coveredDepositQty;
            return Results.BadRequest(new
            {
                error = "DEPOSIT_COVERAGE_INSUFFICIENT",
                message = $"本次发出 {req.FullOutN} 桶、收回 {req.EmptyInM} 桶后，会员累计占桶将达 {newHeld} 桶，超出已缴押金覆盖额度（{coveredDepositQty} 桶），需补交 {uncoveredGap} 桶押金（AC-09）",
                currentHeld,
                fullOutN = req.FullOutN,
                emptyInM = req.EmptyInM,
                newHeld,
                coveredDepositQty,
                uncoveredGap
            });
        }

        if (extraNeeded > 0) await TicketBatches.Reserve(conn, tx, orderRepo.TenantId, memberId, waterType, fulfillMode, resolvedOrderId, extraNeeded, ct);
        await TicketBatches.Settle(conn, tx, resolvedOrderId, req.ActualQty, ct);

        // 更新会员水票（释放多余预占或扣减补差）与持有容器数（AC-10: 退桶不自动退押金，deposit_amount 保持不变）
        var newAvail = currentAvail - extraNeeded; // 若 extraNeeded < 0 (实送少于下单)，则自动加回可用水票!
        var newReserved = currentReserved - reservedQty;

        await using (var uMemCmd = new NpgsqlCommand($"""
            UPDATE plugin_kunlun_waterstation.members
            SET {availCol} = @avail,
                {reservedCol} = @res,
                {heldCol} = @held
            WHERE tenant_id = @tid AND id = @mid
            """, conn, tx))
        {
            uMemCmd.Parameters.AddWithValue("avail", newAvail);
            uMemCmd.Parameters.AddWithValue("res", newReserved);
            uMemCmd.Parameters.AddWithValue("held", newHeld);
            uMemCmd.Parameters.AddWithValue("tid", orderRepo.TenantId);
            uMemCmd.Parameters.AddWithValue("mid", memberId);
            await uMemCmd.ExecuteNonQueryAsync(ct);
        }

        // 更新五维容器库存恒等式 (AC-20: 在库 - deltaHeld, 会员持有 + deltaHeld)
        await using (var cCmd = new NpgsqlCommand("""
            UPDATE plugin_kunlun_waterstation.container_configs
            SET in_station_qty = in_station_qty - @delta,
                member_held_qty = member_held_qty + @delta
            WHERE tenant_id = @tid AND container_type = @ctype AND in_station_qty - @delta >= 0 AND member_held_qty + @delta >= 0
            """, conn, tx))
        {
            cCmd.Parameters.AddWithValue("delta", deltaHeld);
            cCmd.Parameters.AddWithValue("tid", orderRepo.TenantId);
            cCmd.Parameters.AddWithValue("ctype", containerType);
            if (await cCmd.ExecuteNonQueryAsync(ct) == 0) throw new BusinessRuleException("容器可用库存不足或持有台账需核对");
        }

        // 更新订单状态为 COMPLETED
        await using (var uOrdCmd = new NpgsqlCommand("""
            UPDATE plugin_kunlun_waterstation.water_orders
            SET status = 'COMPLETED',
                reserved_qty = 0,
                actual_qty = @actual,
                full_out_qty = @outN,
                empty_in_qty = @inM,
                diff_reason = @diff,
                override_reason = @ovr,
                fulfilled_by_name = @op,
                completed_at = NOW()
            WHERE tenant_id = @tid AND id = @oid
            """, conn, tx))
        {
            uOrdCmd.Parameters.AddWithValue("actual", req.ActualQty);
            uOrdCmd.Parameters.AddWithValue("outN", req.FullOutN);
            uOrdCmd.Parameters.AddWithValue("inM", req.EmptyInM);
            uOrdCmd.Parameters.AddWithValue("diff", (object?)req.DiffReason ?? DBNull.Value);
            uOrdCmd.Parameters.AddWithValue("ovr", (object?)req.OverrideReason ?? DBNull.Value);
            uOrdCmd.Parameters.AddWithValue("op", operatorName);
            uOrdCmd.Parameters.AddWithValue("tid", orderRepo.TenantId);
            uOrdCmd.Parameters.AddWithValue("oid", resolvedOrderId);
            await uOrdCmd.ExecuteNonQueryAsync(ct);
        }

        // 写入水票结算流水 (AC-07, AC-14)
        if (extraNeeded != 0)
        {
            var diffChangeType = extraNeeded < 0 ? "ORDER_DIFF_RELEASE" : "ORDER_DIFF_DEDUCT";
            await using var diffCmd = new NpgsqlCommand("""
                INSERT INTO plugin_kunlun_waterstation.ticket_ledgers
                    (tenant_id, ledger_no, member_id, water_type, fulfill_mode, change_type, delta_qty, balance_after, ref_no, operator_name)
                VALUES
                    (@tid, @lno, @mid, @wtype, @fmode, @ctype, @delta, @bal, @ref, @op)
                """, conn, tx);
            diffCmd.Parameters.AddWithValue("tid", orderRepo.TenantId);
            diffCmd.Parameters.AddWithValue("lno", $"TL-{orderNo}-DIF");
            diffCmd.Parameters.AddWithValue("mid", memberId);
            diffCmd.Parameters.AddWithValue("wtype", waterType);
            diffCmd.Parameters.AddWithValue("fmode", fulfillMode);
            diffCmd.Parameters.AddWithValue("ctype", diffChangeType);
            diffCmd.Parameters.AddWithValue("delta", -extraNeeded);
            diffCmd.Parameters.AddWithValue("bal", newAvail);
            diffCmd.Parameters.AddWithValue("ref", orderNo);
            diffCmd.Parameters.AddWithValue("op", operatorName);
            await diffCmd.ExecuteNonQueryAsync(ct);
        }

        await using (var conCmd = new NpgsqlCommand("""
            INSERT INTO plugin_kunlun_waterstation.ticket_ledgers
                (tenant_id, ledger_no, member_id, water_type, fulfill_mode, change_type, delta_qty, balance_after, ref_no, operator_name)
            VALUES
                (@tid, @lno, @mid, @wtype, @fmode, 'ORDER_CONSUME', @delta, @bal, @ref, @op)
            """, conn, tx))
        {
            conCmd.Parameters.AddWithValue("tid", orderRepo.TenantId);
            conCmd.Parameters.AddWithValue("lno", $"TL-{orderNo}-FIN");
            conCmd.Parameters.AddWithValue("mid", memberId);
            conCmd.Parameters.AddWithValue("wtype", waterType);
            conCmd.Parameters.AddWithValue("fmode", fulfillMode);
            conCmd.Parameters.AddWithValue("delta", -req.ActualQty);
            conCmd.Parameters.AddWithValue("bal", newAvail);
            conCmd.Parameters.AddWithValue("ref", orderNo);
            conCmd.Parameters.AddWithValue("op", operatorName);
            await conCmd.ExecuteNonQueryAsync(ct);
        }

        // 写入容器流转台账 container_ledgers
        await using (var clCmd = new NpgsqlCommand("""
            INSERT INTO plugin_kunlun_waterstation.container_ledgers
                (tenant_id, ledger_no, member_id, container_type, order_no, full_out_qty, empty_in_qty,
                 delta_held, held_after, covered_deposit_qty_after, operator_name, remark)
            VALUES
                (@tid, @lno, @mid, @ctype, @ono, @outN, @inM, @delta, @held, @cov, @op, @rmk)
            """, conn, tx))
        {
            clCmd.Parameters.AddWithValue("tid", orderRepo.TenantId);
            clCmd.Parameters.AddWithValue("lno", $"CL-{orderNo}");
            clCmd.Parameters.AddWithValue("mid", memberId);
            clCmd.Parameters.AddWithValue("ctype", containerType);
            clCmd.Parameters.AddWithValue("ono", orderNo);
            clCmd.Parameters.AddWithValue("outN", req.FullOutN);
            clCmd.Parameters.AddWithValue("inM", req.EmptyInM);
            clCmd.Parameters.AddWithValue("delta", deltaHeld);
            clCmd.Parameters.AddWithValue("held", newHeld);
            clCmd.Parameters.AddWithValue("cov", coveredDepositQty);
            clCmd.Parameters.AddWithValue("op", operatorName);
            clCmd.Parameters.AddWithValue("rmk", req.DiffReason ?? "正常履约交接");
            await clCmd.ExecuteNonQueryAsync(ct);
        }

        await tx.CommitAsync(ct);

        return Results.Ok(new
        {
            id = resolvedOrderId,
            orderNo,
            status = "COMPLETED",
            orderQty,
            actualQty = req.ActualQty,
            fullOutN = req.FullOutN,
            emptyInM = req.EmptyInM,
            deltaHeld,
            heldAfter = newHeld,
            coveredDepositQty,
            depositAmountUnchanged = depositAmount,
            availableTicketsAfter = newAvail,
            reservedTicketsAfter = newReserved
        });
    }
}
