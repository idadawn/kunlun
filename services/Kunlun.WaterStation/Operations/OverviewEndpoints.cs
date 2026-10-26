using System.Security.Claims;
using System.Text.Json;
using Kunlun.WaterStation.Auth;
using Npgsql;
using static Kunlun.WaterStation.Operations.TicketBatches;

namespace Kunlun.WaterStation.Operations;

public static class OverviewEndpoints
{
    public static void MapOverviewEndpoints(this WebApplication app)
    {
        app.MapGet("/api/reports/overview", async (ClaimsPrincipal user, NpgsqlDataSource db, KunlunAuthRepository repo, CancellationToken ct) =>
        {
            if (!user.HasClaim("perm", KunlunPermissions.ReportExport)) return Results.Forbid();
            await using var conn = await db.OpenConnectionAsync(ct);
            await using var cmd = Command(conn, null, """
                WITH days AS (
                  SELECT generate_series((now() AT TIME ZONE 'Asia/Shanghai')::date-6,
                    (now() AT TIME ZONE 'Asia/Shanghai')::date,interval '1 day')::date AS day
                ), charges AS (
                  SELECT (created_at AT TIME ZONE 'Asia/Shanghai')::date AS day,sum(paid_amount) AS amount
                  FROM plugin_kunlun_waterstation.recharge_orders WHERE tenant_id=@tid GROUP BY 1
                ), usage AS (
                  SELECT (completed_at AT TIME ZONE 'Asia/Shanghai')::date AS day,sum(actual_qty) AS qty
                  FROM plugin_kunlun_waterstation.water_orders WHERE tenant_id=@tid AND status='COMPLETED' GROUP BY 1
                ), deposit_rows AS (
                  SELECT l.remaining_qty,l.unit_price,
                    CASE l.container_type WHEN 'BUCKET' THEN m.held_buckets ELSE m.held_bags END AS held,
                    sum(l.remaining_qty) OVER (PARTITION BY l.member_id,l.container_type) AS total,
                    COALESCE(sum(l.remaining_qty) OVER (PARTITION BY l.member_id,l.container_type ORDER BY l.created_at,l.id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) AS prior
                  FROM plugin_kunlun_waterstation.deposit_lots l JOIN plugin_kunlun_waterstation.members m ON m.id=l.member_id
                  WHERE l.tenant_id=@tid AND m.tenant_id=@tid
                )
                SELECT json_build_object(
                  'pendingDelivery',(SELECT count(*) FROM plugin_kunlun_waterstation.water_orders WHERE tenant_id=@tid AND status='PENDING' AND fulfill_mode='DELIVERY'),
                  'pendingPickup',(SELECT count(*) FROM plugin_kunlun_waterstation.water_orders WHERE tenant_id=@tid AND status='PENDING' AND fulfill_mode='PICKUP'),
                  'dispatched',(SELECT count(*) FROM plugin_kunlun_waterstation.water_orders WHERE tenant_id=@tid AND status='DISPATCHED'),
                  'completedOrders',(SELECT count(*) FROM plugin_kunlun_waterstation.water_orders WHERE tenant_id=@tid AND status='COMPLETED'),
                  'completedBuckets',(SELECT COALESCE(sum(actual_qty),0) FROM plugin_kunlun_waterstation.water_orders WHERE tenant_id=@tid AND status='COMPLETED' AND water_type='BUCKET_18_9L'),
                  'completedBags',(SELECT COALESCE(sum(actual_qty),0) FROM plugin_kunlun_waterstation.water_orders WHERE tenant_id=@tid AND status='COMPLETED' AND water_type='BAG_7_5L'),
                  'memberCount',(SELECT count(*) FROM plugin_kunlun_waterstation.members WHERE tenant_id=@tid),
                  'newMembersMonth',(SELECT count(*) FROM plugin_kunlun_waterstation.members WHERE tenant_id=@tid AND created_at AT TIME ZONE 'Asia/Shanghai'>=date_trunc('month',now() AT TIME ZONE 'Asia/Shanghai')),
                  'membersWithTickets',(SELECT count(*) FROM plugin_kunlun_waterstation.members WHERE tenant_id=@tid AND bucket_delivery_tickets+bucket_pickup_tickets+bag_pickup_tickets+bag_delivery_tickets+reserved_bucket_delivery_tickets+reserved_bucket_pickup_tickets+reserved_bag_pickup_tickets+reserved_bag_delivery_tickets>0),
                  'membersWithContainers',(SELECT count(*) FROM plugin_kunlun_waterstation.members WHERE tenant_id=@tid AND held_buckets+held_bags>0),
                  'refundableDeposit',(SELECT COALESCE(sum(unit_price*greatest(0,least(remaining_qty,total-held-prior))),0) FROM deposit_rows),
                  'trend',(SELECT json_agg(json_build_object('date',to_char(d.day,'YYYY-MM-DD'),'rechargeAmount',COALESCE(c.amount,0),'waterQty',COALESCE(u.qty,0)) ORDER BY d.day) FROM days d LEFT JOIN charges c USING(day) LEFT JOIN usage u USING(day))
                )::text
                """, ("tid", repo.DefaultTenantId));
            return Results.Ok(JsonSerializer.Deserialize<JsonElement>((string)(await cmd.ExecuteScalarAsync(ct))!));
        }).RequireAuthorization();
    }
}
