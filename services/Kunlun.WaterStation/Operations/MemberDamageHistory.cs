using Npgsql;
using static Kunlun.WaterStation.Operations.TicketBatches;

namespace Kunlun.WaterStation.Operations;

/// <summary>Each physical damage is counted once. An order, its waiver request and its stock return can all describe the same damage.</summary>
internal static class MemberDamageHistory
{
    internal sealed record Item(string Reference, string ContainerType, string Name, int Quantity, string Status, string Reason, decimal UnitDeposit, bool NeedsDecision);

    internal readonly record struct Breakdown(int Waived, int Paid, int Pending, int AwaitingReview, int AwaitingScrap, int Unverified, int Returned)
    {
        public int Total => Waived + Paid + Pending + AwaitingReview + AwaitingScrap + Unverified + Returned;
    }

    private const string Facts = $"""
        WITH reviews AS (
          SELECT rr.request_no,rr.order_no,rr.container_type,rr.quantity,rr.status,rr.reason,rr.movement_id,mv.ledger_no AS movement_no,d.status AS damage_status
          FROM plugin_kunlun_waterstation.refund_requests rr
          LEFT JOIN plugin_kunlun_waterstation.container_damages d ON {ContainerCirculation.ReviewLink}
          LEFT JOIN plugin_kunlun_waterstation.container_ledgers mv ON mv.id=rr.movement_id AND mv.tenant_id=rr.tenant_id
          WHERE rr.tenant_id=@tid AND rr.member_id=@mid AND rr.kind='DAMAGE'
        ), independent_returns AS (
          SELECT d.*,mv.ledger_no AS movement_no,
            CASE WHEN fee_paid IS TRUE THEN quantity
                 WHEN fee_paid IS FALSE THEN 0
                 ELSE (CASE WHEN status='SCRAPPED' AND NOT deposit_waived THEN quantity-uncovered_qty ELSE 0 END)
                    + (CASE WHEN uncovered_note LIKE '报废费用给了；%' THEN uncovered_qty ELSE 0 END) END AS paid_qty
          FROM plugin_kunlun_waterstation.container_damages d
          LEFT JOIN plugin_kunlun_waterstation.container_ledgers mv ON mv.id=d.movement_id AND mv.tenant_id=d.tenant_id
          WHERE d.tenant_id=@tid AND d.member_id=@mid AND handover_order_no IS NULL
            AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.movement_id=d.movement_id)
            AND idempotency_key NOT LIKE '%:lost' AND idempotency_key NOT LIKE 'settlement:%:kept'
        ), facts AS (
          SELECT request_no AS ref,container_type,quantity,
                 CASE status WHEN 'APPROVED' THEN 'WAIVED' WHEN 'REJECTED' THEN CASE WHEN damage_status='RETURNED' THEN 'RETURNED' ELSE 'REJECTED' END ELSE 'PENDING' END AS status,
                 concat_ws(' · ',order_no,movement_no,reason) AS reason, status='REJECTED' AND damage_status IS DISTINCT FROM 'RETURNED' AS needs_decision
          FROM reviews
          UNION ALL
          -- Includes older paid orders without a waiver request. A pre-structured order with only a request is counted above.
          SELECT o.order_no,p.container_id,
                 o.handover_damage_qty-COALESCE(r.qty,0),
                 CASE WHEN o.damage_compensated IS TRUE THEN 'PAID' ELSE 'UNREVIEWED' END,
                 COALESCE(NULLIF(o.damage_reason,''),''),false
          FROM plugin_kunlun_waterstation.water_orders o
          JOIN plugin_kunlun_waterstation.water_products p ON p.tenant_id=o.tenant_id AND p.water_type=o.water_type
          LEFT JOIN (SELECT order_no,container_type,sum(quantity) AS qty FROM reviews GROUP BY order_no,container_type) r
            ON r.order_no=o.order_no AND r.container_type=p.container_id
          WHERE o.tenant_id=@tid AND o.member_id=@mid AND o.handover_damage_qty>0
          UNION ALL
          -- An older scrap may have been partially covered by a deposit; only its unpaid portion can be decided later.
          SELECT d.damage_no,d.container_type,part.qty,part.status,concat_ws(' · ',d.movement_no,d.reason,NULLIF(d.uncovered_note,''),d.scrap_reason),part.needs_decision
          FROM independent_returns d CROSS JOIN LATERAL (VALUES
            (d.paid_qty, CASE WHEN d.idempotency_key LIKE 'settlement:%' THEN 'SETTLED_CHARGED' ELSE 'PAID' END, false),
            (d.quantity-d.paid_qty, CASE WHEN d.idempotency_key LIKE 'settlement:%' THEN 'SETTLED_WAIVED'
                WHEN d.fee_paid IS NULL AND d.status='PENDING' THEN 'PENDING_SCRAP' ELSE 'UNREVIEWED' END,
             d.idempotency_key NOT LIKE 'settlement:%' AND (d.fee_paid IS FALSE OR d.status='SCRAPPED'))
          ) part(qty,status,needs_decision)
        ), history AS (
          SELECT f.ref,f.container_type,f.quantity,f.reason,
                 CASE WHEN s.charge IS TRUE THEN 'SETTLED_CHARGED' WHEN s.charge IS FALSE THEN 'SETTLED_WAIVED' ELSE f.status END AS status,
                 f.needs_decision AND s.reference IS NULL AS needs_decision
          FROM facts f
          LEFT JOIN plugin_kunlun_waterstation.settlement_damage_decisions s ON s.tenant_id=@tid AND s.reference=f.ref AND f.status<>'PAID'
          WHERE f.quantity>0
        )
        """;

    internal static async Task<Dictionary<string, Breakdown>> CountByContainer(NpgsqlConnection conn, Guid tid, Guid mid, CancellationToken ct)
    {
        await using var cmd = Command(conn, null, Facts + "\n" + """
            SELECT container_type,
              COALESCE(sum(quantity) FILTER (WHERE status IN ('WAIVED','SETTLED_WAIVED')),0)::int,
              COALESCE(sum(quantity) FILTER (WHERE status IN ('PAID','SETTLED_CHARGED')),0)::int,
              COALESCE(sum(quantity) FILTER (WHERE needs_decision),0)::int,
              COALESCE(sum(quantity) FILTER (WHERE status='PENDING'),0)::int,
              COALESCE(sum(quantity) FILTER (WHERE status='PENDING_SCRAP'),0)::int,
              COALESCE(sum(quantity) FILTER (WHERE status='UNREVIEWED' AND NOT needs_decision),0)::int,
              COALESCE(sum(quantity) FILTER (WHERE status='RETURNED'),0)::int
            FROM history GROUP BY container_type
            """, ("tid", tid), ("mid", mid));
        var counts = new Dictionary<string, Breakdown>();
        await using var r = await cmd.ExecuteReaderAsync(ct);
        while (await r.ReadAsync(ct))
            counts.Add(r.GetString(0), new(r.GetInt32(1), r.GetInt32(2), r.GetInt32(3), r.GetInt32(4), r.GetInt32(5), r.GetInt32(6), r.GetInt32(7)));
        return counts;
    }

    internal static async Task<List<Item>> Read(NpgsqlConnection conn, NpgsqlTransaction? tx, Guid tid, Guid mid, CancellationToken ct)
    {
        await using var cmd = Command(conn, tx, Facts + "\n" + """
            SELECT h.ref,h.container_type,p.name,h.quantity::int,h.status,h.reason,c.unit_deposit,h.needs_decision
            FROM history h
            JOIN plugin_kunlun_waterstation.water_products p ON p.tenant_id=@tid AND p.container_id=h.container_type
            JOIN plugin_kunlun_waterstation.container_configs c ON c.tenant_id=@tid AND c.container_type=h.container_type
            ORDER BY h.ref,h.status
            """, ("tid",tid), ("mid",mid));
        var rows = new List<Item>();
        await using var r = await cmd.ExecuteReaderAsync(ct);
        while (await r.ReadAsync(ct))
            rows.Add(new(r.GetString(0), r.GetString(1), r.GetString(2), r.GetInt32(3), r.GetString(4), r.GetString(5), r.GetDecimal(6), r.GetBoolean(7)));
        return rows;
    }
}
