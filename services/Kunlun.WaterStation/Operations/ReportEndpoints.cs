using System.Security.Claims;
using System.Text;
using Kunlun.WaterStation.Auth;
using Npgsql;

namespace Kunlun.WaterStation.Operations;

public static class ReportEndpoints
{
    public static void MapReportEndpoints(this WebApplication app)
    {
        var api = app.MapGroup("/api");
        api.AddEndpointFilter(async (context, next) =>
        {
            if (context.HttpContext.Request.Path.StartsWithSegments("/api/ledgers") &&
                (context.HttpContext.User.FindFirstValue("subject_type") != "STAFF" ||
                 !context.HttpContext.User.HasClaim("perm", KunlunPermissions.MemberRead))) return Results.Forbid();
            return await next(context);
        });

        // 1. 经营财务对账汇总报表 (AC-17: 充值收款、押金收款、押金退款、未退押金总额分别统计且与明细汇总一致)
        api.MapGet("/reports/finance-summary", async (
            ClaimsPrincipal user,
            NpgsqlDataSource db,
            KunlunAuthRepository authRepo,
            CancellationToken ct) =>
        {
            var perms = user.FindAll("perm").Select(c => c.Value).ToHashSet();
            if (!perms.Contains(KunlunPermissions.MemberRead))
            {
                return Results.Json(new { error = "FORBIDDEN_PERMISSION", message = "缺少权限（AC-16）" }, statusCode: 403);
            }

            var tenantId = authRepo.DefaultTenantId;
            await using var conn = await db.OpenConnectionAsync(ct);

            decimal rechargeRevenueTotal;
            long rechargeOrderCount;
            long ticketsSoldBuyQty, ticketsGiftedQty;

            await using (var rcgCmd = new NpgsqlCommand("""
                SELECT COUNT(*),
                       COALESCE(SUM(paid_amount), 0.00),
                       COALESCE(SUM(buy_qty), 0),
                       COALESCE(SUM(gift_qty), 0)
                FROM plugin_kunlun_waterstation.recharge_orders
                WHERE tenant_id = @tid
                """, conn))
            {
                rcgCmd.Parameters.AddWithValue("tid", tenantId);
                await using var r = await rcgCmd.ExecuteReaderAsync(ct);
                await r.ReadAsync(ct);
                rechargeOrderCount = r.GetInt64(0);
                rechargeRevenueTotal = r.GetDecimal(1);
                ticketsSoldBuyQty = r.GetInt64(2);
                ticketsGiftedQty = r.GetInt64(3);
            }

            decimal depositCollectedTotal, unrefundedDepositPoolFromLots;
            long depositCollectCount;
            await using (var depCmd = new NpgsqlCommand("""
                SELECT COUNT(*),
                       COALESCE(SUM(total_amount), 0.00),
                       COALESCE(SUM(remaining_qty * unit_price), 0.00)
                FROM plugin_kunlun_waterstation.deposit_lots
                WHERE tenant_id = @tid
                """, conn))
            {
                depCmd.Parameters.AddWithValue("tid", tenantId);
                await using var r = await depCmd.ExecuteReaderAsync(ct);
                await r.ReadAsync(ct);
                depositCollectCount = r.GetInt64(0);
                depositCollectedTotal = r.GetDecimal(1);
                unrefundedDepositPoolFromLots = r.GetDecimal(2);
            }

            decimal depositRefundedTotal;
            long depositRefundCount;
            await using (var refCmd = new NpgsqlCommand("""
                SELECT COUNT(*),
                       COALESCE(SUM(refund_amount), 0.00)
                FROM plugin_kunlun_waterstation.deposit_refunds
                WHERE tenant_id = @tid
                """, conn))
            {
                refCmd.Parameters.AddWithValue("tid", tenantId);
                await using var r = await refCmd.ExecuteReaderAsync(ct);
                await r.ReadAsync(ct);
                depositRefundCount = r.GetInt64(0);
                depositRefundedTotal = r.GetDecimal(1);
            }

            long completedOrderCount, waterFulfilledTotalQty;
            await using (var ordCmd = new NpgsqlCommand("""
                SELECT COUNT(*),
                       COALESCE(SUM(actual_qty), 0)
                FROM plugin_kunlun_waterstation.water_orders
                WHERE tenant_id = @tid AND status = 'COMPLETED'
                """, conn))
            {
                ordCmd.Parameters.AddWithValue("tid", tenantId);
                await using var r = await ordCmd.ExecuteReaderAsync(ct);
                await r.ReadAsync(ct);
                completedOrderCount = r.GetInt64(0);
                waterFulfilledTotalQty = r.GetInt64(1);
            }

            decimal rechargeRefundedTotal;
            long rechargeRefundCount;
            await using (var refunds = TicketBatches.Command(conn, null, "SELECT count(*),COALESCE(sum(amount),0) FROM plugin_kunlun_waterstation.recharge_refunds WHERE tenant_id=@tid", ("tid", tenantId)))
            await using (var r = await refunds.ExecuteReaderAsync(ct))
            {
                await r.ReadAsync(ct);
                rechargeRefundCount = r.GetInt64(0);
                rechargeRefundedTotal = r.GetDecimal(1);
            }
            decimal depositDeductedTotal;
            long depositDeductCount;
            await using (var deductions = TicketBatches.Command(conn, null, "SELECT count(*),COALESCE(sum(deposit_amount),0) FROM plugin_kunlun_waterstation.container_damages WHERE tenant_id=@tid AND status='SCRAPPED' AND NOT deposit_waived", ("tid",tenantId)))
            await using (var r = await deductions.ExecuteReaderAsync(ct))
            {
                await r.ReadAsync(ct);
                depositDeductCount = r.GetInt64(0);
                depositDeductedTotal = r.GetDecimal(1);
            }
            var netDepositFromFlows = depositCollectedTotal - depositRefundedTotal - depositDeductedTotal;

            return Results.Ok(new
            {
                brand = "绿麒麟水站｜小分子团弱碱活性水",
                rechargeRevenueTotal,
                rechargeRefundedTotal,
                rechargeRefundCount,
                rechargeNetReceived = rechargeRevenueTotal - rechargeRefundedTotal,
                rechargeOrderCount,
                ticketsSoldBuyQty,
                ticketsGiftedQty,
                depositCollectedTotal,
                depositCollectCount,
                depositRefundedTotal,
                depositRefundCount,
                depositDeductedTotal,
                depositDeductCount,
                unrefundedDepositPoolTotal = unrefundedDepositPoolFromLots,
                netDepositFromFlows,
                reconciledZeroDiff = unrefundedDepositPoolFromLots == netDepositFromFlows,
                completedOrderCount,
                waterFulfilledTotalQty,
                generatedAt = DateTimeOffset.UtcNow
            });
        }).RequireAuthorization();

        // 2. 数据导出 CSV 接口 (AC-18: 会员、水票流水、押金流水、订单记录可导出，且字段与列表口径一致)
        api.MapGet("/exports/{dataset}", async (
            string dataset,
            ClaimsPrincipal user,
            NpgsqlDataSource db,
            KunlunAuthRepository authRepo,
            CancellationToken ct) =>
        {
            var perms = user.FindAll("perm").Select(c => c.Value).ToHashSet();
            if (!perms.Contains(KunlunPermissions.ReportExport))
            {
                return Results.Json(new { error = "FORBIDDEN_PERMISSION", message = "缺少报表导出权限 report.export（AC-16, AC-18）" }, statusCode: 403);
            }

            var tenantId = authRepo.DefaultTenantId;
            await using var conn = await db.OpenConnectionAsync(ct);
            var sb = new StringBuilder();
            sb.Append('\uFEFF'); // UTF-8 BOM for Excel

            switch (dataset.ToLowerInvariant())
            {
                case "members":
                {
                    sb.AppendLine("会员卡号,姓名,手机号,默认地址,桶装配送水票,桶装自提水票,袋装自提水票,袋装配送水票,在用水桶,在用水袋,押金余额(元),状态");
                    await using var cmd = new NpgsqlCommand("""
                        SELECT member_no, name, phone, COALESCE(default_address, ''),
                               bucket_delivery_tickets, bucket_pickup_tickets, bag_pickup_tickets, bag_delivery_tickets,
                               held_buckets, held_bags, deposit_amount, status
                        FROM plugin_kunlun_waterstation.members
                        WHERE tenant_id = @tid
                        ORDER BY member_no
                        """, conn);
                    cmd.Parameters.AddWithValue("tid", tenantId);
                    await using var r = await cmd.ExecuteReaderAsync(ct);
                    while (await r.ReadAsync(ct))
                    {
                        sb.AppendLine($"{Csv(r.GetString(0))},{Csv(r.GetString(1))},{Csv(r.GetString(2))},{Csv(r.GetString(3))},{r.GetInt32(4)},{r.GetInt32(5)},{r.GetInt32(6)},{r.GetInt32(7)},{r.GetInt32(8)},{r.GetInt32(9)},{r.GetDecimal(10):F2},{r.GetString(11)}");
                    }
                    break;
                }
                case "ticket-ledgers":
                {
                    sb.AppendLine("流水号,会员ID,水种,履约方式,变动类型,变动数量,变动后可用余额,关联单号,操作人,时间");
                    await using var cmd = new NpgsqlCommand("""
                        SELECT ledger_no, member_id, water_type, fulfill_mode, change_type, delta_qty, balance_after, ref_no, operator_name, created_at
                        FROM plugin_kunlun_waterstation.ticket_ledgers
                        WHERE tenant_id = @tid
                        ORDER BY id DESC
                        """, conn);
                    cmd.Parameters.AddWithValue("tid", tenantId);
                    await using var r = await cmd.ExecuteReaderAsync(ct);
                    while (await r.ReadAsync(ct))
                    {
                        sb.AppendLine($"{Csv(r.GetString(0))},{r.GetGuid(1)},{r.GetString(2)},{r.GetString(3)},{r.GetString(4)},{r.GetInt32(5)},{r.GetInt32(6)},{Csv(r.GetString(7))},{Csv(r.GetString(8))},{r.GetDateTime(9):O}");
                    }
                    break;
                }
                case "deposit-ledgers":
                {
                    sb.AppendLine("单据号,流转类型,会员ID,容器类型,数量,批次单价(元),金额(元),剩余未退数量,操作人,时间,收付方式");
                    await using var cmd = new NpgsqlCommand("""
                        SELECT deposit_no AS doc_no, 'COLLECT' AS flow_type, member_id, container_type, paid_qty AS qty,
                               unit_price, total_amount AS amount, remaining_qty, operator_name, created_at, pay_method
                        FROM plugin_kunlun_waterstation.deposit_lots
                        WHERE tenant_id = @tid
                        UNION ALL
                        SELECT refund_no AS doc_no, 'REFUND' AS flow_type, member_id, container_type, refund_qty AS qty,
                               ROUND(refund_amount / refund_qty, 2) AS unit_price, refund_amount AS amount, 0 AS remaining_qty, operator_name, created_at, pay_method
                        FROM plugin_kunlun_waterstation.deposit_refunds
                        WHERE tenant_id = @tid
                        UNION ALL
                        SELECT scrap_no AS doc_no,'DEDUCT' AS flow_type,member_id,container_type,quantity AS qty,
                               ROUND(deposit_amount/quantity,2) AS unit_price,deposit_amount AS amount,0 AS remaining_qty,scrap_operator AS operator_name,scrapped_at AS created_at,NULL
                        FROM plugin_kunlun_waterstation.container_damages WHERE tenant_id=@tid AND status='SCRAPPED' AND NOT deposit_waived
                        ORDER BY created_at DESC
                        """, conn);
                    cmd.Parameters.AddWithValue("tid", tenantId);
                    await using var r = await cmd.ExecuteReaderAsync(ct);
                    while (await r.ReadAsync(ct))
                    {
                        sb.AppendLine($"{Csv(r.GetString(0))},{r.GetString(1)},{r.GetGuid(2)},{r.GetString(3)},{r.GetInt32(4)},{r.GetDecimal(5):F2},{r.GetDecimal(6):F2},{r.GetInt32(7)},{Csv(r.GetString(8))},{r.GetDateTime(9):O},{(r.IsDBNull(10) ? "" : r.GetString(10))}");
                    }
                    break;
                }
                case "orders":
                {
                    sb.AppendLine("订单号,会员ID,水种,履约方式,下单数量,实送数量,发出重桶N,收回空桶M,自提码,状态,差异原因,备注,创建时间");
                    await using var cmd = new NpgsqlCommand("""
                        SELECT order_no, member_id, water_type, fulfill_mode, order_qty,
                               COALESCE(actual_qty, 0), COALESCE(full_out_qty, 0), COALESCE(empty_in_qty, 0),
                               COALESCE(pickup_code, ''), status, COALESCE(diff_reason, ''), created_at, COALESCE(remark, '')
                        FROM plugin_kunlun_waterstation.water_orders
                        WHERE tenant_id = @tid
                        ORDER BY created_at DESC
                        """, conn);
                    cmd.Parameters.AddWithValue("tid", tenantId);
                    await using var r = await cmd.ExecuteReaderAsync(ct);
                    while (await r.ReadAsync(ct))
                    {
                        sb.AppendLine($"{Csv(r.GetString(0))},{r.GetGuid(1)},{r.GetString(2)},{r.GetString(3)},{r.GetInt32(4)},{r.GetInt32(5)},{r.GetInt32(6)},{r.GetInt32(7)},{Csv(r.GetString(8))},{r.GetString(9)},{Csv(r.GetString(10))},{Csv(r.GetString(12))},{r.GetDateTime(11):O}");
                    }
                    break;
                }
                case "inventory-operations":
                {
                    sb.AppendLine("库存单号,容器,业务,来源,数量,总量变化,调整后现存总量,调整后破损,累计报废,原因,操作人,时间");
                    await using var cmd = TicketBatches.Command(conn, null, "SELECT operation_no,container_type,action,source_state,quantity,delta_total,after_state->>'totalQty',after_state->>'damagedQty',after_state->>'scrappedQty',reason,operator_name,created_at FROM plugin_kunlun_waterstation.container_inventory_operations WHERE tenant_id=@tid AND action IN ('RECEIVE','SCRAP') ORDER BY created_at DESC,id DESC", ("tid", tenantId));
                    await using var r = await cmd.ExecuteReaderAsync(ct);
                    while (await r.ReadAsync(ct)) sb.AppendLine($"{Csv(r.GetString(0))},{r.GetString(1)},{r.GetString(2)},{r.GetString(3)},{r.GetInt32(4)},{r.GetInt32(5)},{r.GetString(6)},{r.GetString(7)},{r.GetString(8)},{Csv(r.GetString(9))},{Csv(r.GetString(10))},{r.GetDateTime(11):O}");
                    break;
                }
                case "container-ledgers":
                {
                    sb.AppendLine("流水号,会员ID,容器类型,领出,归还,持有变化,持有余额,操作人,时间,业务类型,扣押金额,关联单号,原因,报废数量");
                    await using var cmd = TicketBatches.Command(conn, null, "SELECT ledger_no,member_id,container_type,full_out_qty,empty_in_qty,delta_held,held_after,operator_name,created_at,business_type,deposit_deducted_amount,COALESCE(order_no,''),COALESCE(remark,''),scrapped_qty FROM plugin_kunlun_waterstation.container_ledgers WHERE tenant_id=@tid ORDER BY id DESC", ("tid", tenantId));
                    await using var r = await cmd.ExecuteReaderAsync(ct);
                    while (await r.ReadAsync(ct)) sb.AppendLine($"{Csv(r.GetString(0))},{r.GetGuid(1)},{r.GetString(2)},{r.GetInt32(3)},{r.GetInt32(4)},{r.GetInt32(5)},{r.GetInt32(6)},{Csv(r.GetString(7))},{r.GetDateTime(8):O},{r.GetString(9)},{r.GetDecimal(10):F2},{Csv(r.GetString(11))},{Csv(r.GetString(12))},{r.GetInt32(13)}");
                    break;
                }
                case "recharges":
                {
                    sb.AppendLine("充值单号,会员ID,原套餐名称,实收金额,付费票,赠票,收款方式,操作人,时间");
                    await using var cmd = TicketBatches.Command(conn, null, "SELECT recharge_no,member_id,plan_snapshot->>'name',paid_amount,buy_qty,gift_qty,pay_method,operator_name,created_at FROM plugin_kunlun_waterstation.recharge_orders WHERE tenant_id=@tid ORDER BY created_at DESC", ("tid", tenantId));
                    await using var r = await cmd.ExecuteReaderAsync(ct);
                    while (await r.ReadAsync(ct)) sb.AppendLine($"{Csv(r.GetString(0))},{r.GetGuid(1)},{Csv(r.IsDBNull(2) ? "" : r.GetString(2))},{r.GetDecimal(3):F2},{r.GetInt32(4)},{r.GetInt32(5)},{r.GetString(6)},{Csv(r.GetString(7))},{r.GetDateTime(8):O}");
                    break;
                }
                case "recharge-refunds":
                {
                    sb.AppendLine("退款单号,原充值单号,会员ID,原套餐名称,退款金额,退付费票,收回赠票,退款方式,退款原因,操作人,时间");
                    await using var cmd = TicketBatches.Command(conn, null, """
                        SELECT rf.refund_no,COALESCE(ro.recharge_no,''),rf.member_id,ro.plan_snapshot->>'name',rf.amount,rf.refund_buy_qty,rf.revoked_gift_qty,rf.pay_method,rf.reason,rf.operator_name,rf.created_at
                        FROM plugin_kunlun_waterstation.recharge_refunds rf
                        JOIN plugin_kunlun_waterstation.ticket_batches b ON b.id=rf.batch_id
                        LEFT JOIN plugin_kunlun_waterstation.recharge_orders ro ON ro.id=b.recharge_id
                        WHERE rf.tenant_id=@tid ORDER BY rf.created_at DESC
                        """, ("tid", tenantId));
                    await using var r = await cmd.ExecuteReaderAsync(ct);
                    while (await r.ReadAsync(ct)) sb.AppendLine($"{Csv(r.GetString(0))},{Csv(r.GetString(1))},{r.GetGuid(2)},{Csv(r.IsDBNull(3) ? "" : r.GetString(3))},{r.GetDecimal(4):F2},{r.GetInt32(5)},{r.GetInt32(6)},{r.GetString(7)},{Csv(r.GetString(8))},{Csv(r.GetString(9))},{r.GetDateTime(10):O}");
                    break;
                }
                default:
                    return Results.BadRequest(new { error = "UNSUPPORTED_EXPORT_DATASET", message = $"不支持的导出类型: {dataset}" });
            }

            var bytes = Encoding.UTF8.GetBytes(sb.ToString());
            return Results.File(bytes, "text/csv; charset=utf-8", $"kunlun-{dataset}-{DateTime.UtcNow:yyyyMMdd}.csv");
        }).RequireAuthorization();

        // 3. 充值流水、充值退款流水、押金收支流水、容器领还流水列表查询 (供管理端 PC 与小程序端实时渲染)，可按单号/会员、业务时间、收付方式、业务类型、容器类型筛选并分页
        api.MapGet("/ledgers/recharges", async (string? q, DateTimeOffset? from, DateTimeOffset? to, string? payMethod, int? page, int? pageSize,
            NpgsqlDataSource db, KunlunAuthRepository authRepo, CancellationToken ct) =>
        {
            await using var conn = await db.OpenConnectionAsync(ct);
            return await Paging.From(page, pageSize, legacyLimit: 30).Query(conn, """
                r.recharge_no, m.name, m.member_no, r.plan_snapshot->>'name',
                r.paid_amount, r.buy_qty, r.gift_qty, r.pay_method, r.operator_name, r.created_at, r.plan_snapshot::text,
                r.coupon_snapshot->'coupon'->>'name', rf.refund_no, rf.amount, rf.created_at
                """, """
                plugin_kunlun_waterstation.recharge_orders r
                JOIN plugin_kunlun_waterstation.members m ON m.id = r.member_id
                LEFT JOIN plugin_kunlun_waterstation.ticket_batches b ON b.recharge_id = r.id
                LEFT JOIN plugin_kunlun_waterstation.recharge_refunds rf ON rf.batch_id = b.id
                WHERE r.tenant_id = @tid
                  AND (@from IS NULL OR r.created_at >= @from)
                  AND (@to IS NULL OR r.created_at < @to)
                  AND (@pay IS NULL OR r.pay_method = @pay)
                  AND (@q IS NULL OR r.recharge_no ILIKE @q OR m.name ILIKE @q OR m.member_no ILIKE @q OR m.phone ILIKE @q
                       OR r.plan_snapshot->>'name' ILIKE @q OR r.operator_name ILIKE @q)
                """, "r.created_at DESC, r.id", p =>
            {
                p.AddWithValue("tid", authRepo.DefaultTenantId);
                p.Add(Paging.Time("from", from));
                p.Add(Paging.Time("to", to));
                p.Add(Paging.Text("pay", payMethod));
                p.Add(Paging.Like("q", q));
            }, reader => new
            {
                rechargeNo = reader.GetString(0),
                memberName = reader.GetString(1),
                memberNo = reader.GetString(2),
                planName = reader.IsDBNull(3) ? "优惠水票包" : reader.GetString(3),
                planSnapshot = System.Text.Json.JsonSerializer.Deserialize<System.Text.Json.JsonElement>(reader.GetString(10)),
                paidAmount = reader.GetDecimal(4),
                buyQty = reader.GetInt32(5),
                giftQty = reader.GetInt32(6),
                payMethod = reader.GetString(7),
                operatorName = reader.GetString(8),
                createdAt = reader.GetDateTime(9),
                couponName = reader.IsDBNull(11) ? null : reader.GetString(11),
                refundNo = reader.IsDBNull(12) ? null : reader.GetString(12),
                refundAmount = reader.IsDBNull(13) ? (decimal?)null : reader.GetDecimal(13),
                refundedAt = reader.IsDBNull(14) ? (DateTime?)null : reader.GetDateTime(14)
            }, ct);
        }).RequireAuthorization();

        // 退清剩余权益的水费退款，与押金退款分开列示
        api.MapGet("/ledgers/recharge-refunds", async (string? q, DateTimeOffset? from, DateTimeOffset? to, string? payMethod, int? page, int? pageSize,
            NpgsqlDataSource db, KunlunAuthRepository authRepo, CancellationToken ct) =>
        {
            await using var conn = await db.OpenConnectionAsync(ct);
            return await Paging.From(page, pageSize, legacyLimit: 30).Query(conn, """
                rf.refund_no, COALESCE(ro.recharge_no, ''), m.name, m.member_no, ro.plan_snapshot->>'name', b.water_type, b.fulfill_mode,
                rf.amount, rf.refund_buy_qty, rf.revoked_gift_qty, rf.pay_method, rf.reason, rf.operator_name, rf.created_at
                """, """
                plugin_kunlun_waterstation.recharge_refunds rf
                JOIN plugin_kunlun_waterstation.members m ON m.id = rf.member_id
                JOIN plugin_kunlun_waterstation.ticket_batches b ON b.id = rf.batch_id
                LEFT JOIN plugin_kunlun_waterstation.recharge_orders ro ON ro.id = b.recharge_id
                WHERE rf.tenant_id = @tid
                  AND (@from IS NULL OR rf.created_at >= @from)
                  AND (@to IS NULL OR rf.created_at < @to)
                  AND (@pay IS NULL OR rf.pay_method = @pay)
                  AND (@q IS NULL OR rf.refund_no ILIKE @q OR ro.recharge_no ILIKE @q OR m.name ILIKE @q OR m.member_no ILIKE @q
                       OR m.phone ILIKE @q OR rf.reason ILIKE @q OR rf.operator_name ILIKE @q)
                """, "rf.created_at DESC, rf.id", p =>
            {
                p.AddWithValue("tid", authRepo.DefaultTenantId);
                p.Add(Paging.Time("from", from));
                p.Add(Paging.Time("to", to));
                p.Add(Paging.Text("pay", payMethod));
                p.Add(Paging.Like("q", q));
            }, reader => new
            {
                refundNo = reader.GetString(0),
                rechargeNo = reader.GetString(1),
                memberName = reader.GetString(2),
                memberNo = reader.GetString(3),
                planName = reader.IsDBNull(4) ? "历史余额" : reader.GetString(4),
                waterType = reader.GetString(5),
                fulfillMode = reader.GetString(6),
                amount = reader.GetDecimal(7),
                refundBuyQty = reader.GetInt32(8),
                revokedGiftQty = reader.GetInt32(9),
                payMethod = reader.GetString(10),
                reason = reader.GetString(11),
                operatorName = reader.GetString(12),
                createdAt = reader.GetDateTime(13)
            }, ct);
        }).RequireAuthorization();

        api.MapGet("/ledgers/deposits", async (string? q, DateTimeOffset? from, DateTimeOffset? to, string? flowType, string? containerType, int? page, int? pageSize,
            NpgsqlDataSource db, KunlunAuthRepository authRepo, CancellationToken ct) =>
        {
            await using var conn = await db.OpenConnectionAsync(ct);
            return await Paging.From(page, pageSize, legacyLimit: 30).Query(conn,
                "doc_no, member_name, flow_type, container_type, qty, unit_price, amount, remaining_qty, operator_name, created_at, member_no, pay_method", """
                (SELECT d.deposit_no AS doc_no, m.name AS member_name, m.member_no, m.phone, 'COLLECT' AS flow_type, d.container_type, d.paid_qty AS qty,
                        d.unit_price, d.total_amount AS amount, d.remaining_qty, d.operator_name, d.created_at, d.pay_method
                 FROM plugin_kunlun_waterstation.deposit_lots d
                 JOIN plugin_kunlun_waterstation.members m ON m.id = d.member_id
                 WHERE d.tenant_id = @tid
                 UNION ALL
                 SELECT rf.refund_no, m.name, m.member_no, m.phone, 'REFUND', rf.container_type, rf.refund_qty,
                        ROUND(rf.refund_amount / rf.refund_qty, 2), rf.refund_amount, 0, rf.operator_name, rf.created_at, rf.pay_method
                 FROM plugin_kunlun_waterstation.deposit_refunds rf
                 JOIN plugin_kunlun_waterstation.members m ON m.id = rf.member_id
                 WHERE rf.tenant_id = @tid
                 UNION ALL
                 SELECT d.scrap_no, m.name, m.member_no, m.phone, 'DEDUCT', d.container_type, d.quantity,
                        ROUND(d.deposit_amount / d.quantity, 2), d.deposit_amount, 0, d.scrap_operator, d.scrapped_at, NULL
                 FROM plugin_kunlun_waterstation.container_damages d
                 JOIN plugin_kunlun_waterstation.members m ON m.id = d.member_id AND m.tenant_id = d.tenant_id
                 WHERE d.tenant_id = @tid AND d.status = 'SCRAPPED' AND NOT d.deposit_waived) flows
                WHERE (@from IS NULL OR created_at >= @from)
                  AND (@to IS NULL OR created_at < @to)
                  AND (@flow IS NULL OR flow_type = @flow)
                  AND (@ctype IS NULL OR container_type = @ctype)
                  AND (@q IS NULL OR doc_no ILIKE @q OR member_name ILIKE @q OR member_no ILIKE @q OR phone ILIKE @q OR operator_name ILIKE @q)
                """, "created_at DESC, doc_no", p =>
            {
                p.AddWithValue("tid", authRepo.DefaultTenantId);
                p.Add(Paging.Time("from", from));
                p.Add(Paging.Time("to", to));
                p.Add(Paging.Text("flow", flowType));
                p.Add(Paging.Text("ctype", containerType));
                p.Add(Paging.Like("q", q));
            }, reader => new
            {
                docNo = reader.GetString(0),
                memberName = reader.GetString(1),
                memberNo = reader.GetString(10),
                flowType = reader.GetString(2),
                containerType = reader.GetString(3),
                qty = reader.GetInt32(4),
                unitPrice = reader.GetDecimal(5),
                amount = reader.GetDecimal(6),
                remainingQty = reader.GetInt32(7),
                payMethod = reader.IsDBNull(11) ? null : reader.GetString(11),
                operatorName = reader.GetString(8),
                createdAt = reader.GetDateTime(9)
            }, ct);
        }).RequireAuthorization();

        api.MapGet("/ledgers/containers", async (string? containerType, int? page, int? pageSize,
            NpgsqlDataSource db, KunlunAuthRepository authRepo, CancellationToken ct) =>
        {
            await using var conn = await db.OpenConnectionAsync(ct);
            return await Paging.From(page, pageSize, legacyLimit: 30).Query(conn, """
                c.ledger_no, m.name, COALESCE(c.order_no, '独立登记'), c.container_type,
                c.full_out_qty, c.empty_in_qty, c.delta_held, c.held_after, c.operator_name, c.created_at
                """, """
                plugin_kunlun_waterstation.container_ledgers c
                JOIN plugin_kunlun_waterstation.members m ON m.id = c.member_id
                WHERE c.tenant_id = @tid AND (@ctype IS NULL OR c.container_type = @ctype)
                """, "c.id DESC", p =>
            {
                p.AddWithValue("tid", authRepo.DefaultTenantId);
                p.Add(Paging.Text("ctype", containerType));
            }, reader => new
            {
                ledgerNo = reader.GetString(0),
                memberName = reader.GetString(1),
                orderNo = reader.GetString(2),
                containerType = reader.GetString(3),
                fullOutQty = reader.GetInt32(4),
                emptyInQty = reader.GetInt32(5),
                deltaHeld = reader.GetInt32(6),
                heldAfter = reader.GetInt32(7),
                operatorName = reader.GetString(8),
                createdAt = reader.GetDateTime(9)
            }, ct);
        }).RequireAuthorization();
    }

    private static string Csv(string? val)
    {
        if (string.IsNullOrEmpty(val)) return "";
        if ("=+-@\t\r".Contains(val[0])) val = "'" + val;
        if (val.Contains(',') || val.Contains('"') || val.Contains('\n') || val.Contains('\r'))
        {
            return $"\"{val.Replace("\"", "\"\"")}\"";
        }
        return val;
    }
}
