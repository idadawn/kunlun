using Npgsql;
using static Kunlun.WaterStation.Operations.TicketBatches;

namespace Kunlun.WaterStation.Operations;

/// <summary>Each physical damage is counted once. An order, its waiver request and its stock return can all describe the same damage.</summary>
internal static class MemberDamageHistory
{
    internal sealed record Item(string Reference, string ContainerType, string Name, int Quantity, string Status, string Reason, decimal UnitDeposit, bool NeedsDecision);

    private const string Facts = """
        WITH reviews AS (
          SELECT request_no,order_no,container_type,quantity,status,reason
          FROM plugin_kunlun_waterstation.refund_requests WHERE tenant_id=@tid AND member_id=@mid AND kind='DAMAGE'
        ), independent_returns AS (
          SELECT d.*,
            CASE WHEN fee_paid IS TRUE THEN quantity
                 WHEN fee_paid IS FALSE THEN 0
                 ELSE (CASE WHEN status='SCRAPPED' AND NOT deposit_waived THEN quantity-uncovered_qty ELSE 0 END)
                    + (CASE WHEN uncovered_note LIKE '报废费用给了；%' THEN uncovered_qty ELSE 0 END) END AS paid_qty
          FROM plugin_kunlun_waterstation.container_damages d
          WHERE tenant_id=@tid AND member_id=@mid AND handover_order_no IS NULL
            AND idempotency_key NOT LIKE '%:lost' AND idempotency_key NOT LIKE 'settlement:%:kept'
        ), facts AS (
          SELECT request_no AS ref,container_type,quantity,
                 CASE status WHEN 'APPROVED' THEN 'WAIVED' WHEN 'REJECTED' THEN 'REJECTED' ELSE 'PENDING' END AS status,
                 concat_ws(' · ',order_no,reason) AS reason, status='REJECTED' AS needs_decision
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
          SELECT d.damage_no,d.container_type,part.qty,part.status,concat_ws(' · ',d.reason,NULLIF(d.uncovered_note,''),d.scrap_reason),part.needs_decision
          FROM independent_returns d CROSS JOIN LATERAL (VALUES
            (d.paid_qty, 'PAID', false),
            (d.quantity-d.paid_qty, CASE WHEN d.idempotency_key LIKE 'settlement:%' THEN 'WAIVED'
                WHEN d.fee_paid IS NULL AND d.status='PENDING' THEN 'PENDING_SCRAP' ELSE 'UNREVIEWED' END,
             d.idempotency_key NOT LIKE 'settlement:%' AND (d.fee_paid IS FALSE OR d.status='SCRAPPED'))
          ) part(qty,status,needs_decision)
        )
        """;

    internal static async Task<Dictionary<string, int>> CountByContainer(NpgsqlConnection conn, Guid tid, Guid mid, CancellationToken ct)
    {
        await using var cmd = Command(conn, null, Facts + "\nSELECT container_type,sum(quantity)::int FROM facts WHERE quantity>0 GROUP BY container_type",
            ("tid", tid), ("mid", mid));
        var counts = new Dictionary<string, int>();
        await using var r = await cmd.ExecuteReaderAsync(ct);
        while (await r.ReadAsync(ct)) counts.Add(r.GetString(0), r.GetInt32(1));
        return counts;
    }

    internal static async Task<List<Item>> Read(NpgsqlConnection conn, NpgsqlTransaction? tx, Guid tid, Guid mid, CancellationToken ct)
    {
        await using var cmd = Command(conn, tx, Facts + "\n" + """
            SELECT f.ref,f.container_type,p.name,f.quantity::int,
                   CASE WHEN s.charge IS TRUE THEN 'SETTLED_CHARGED' WHEN s.charge IS FALSE THEN 'SETTLED_WAIVED' ELSE f.status END,
                   f.reason,c.unit_deposit,f.needs_decision AND s.reference IS NULL
            FROM facts f
            JOIN plugin_kunlun_waterstation.water_products p ON p.tenant_id=@tid AND p.container_id=f.container_type
            JOIN plugin_kunlun_waterstation.container_configs c ON c.tenant_id=@tid AND c.container_type=f.container_type
            LEFT JOIN plugin_kunlun_waterstation.settlement_damage_decisions s ON s.tenant_id=@tid AND s.reference=f.ref AND f.status<>'PAID'
            WHERE f.quantity>0 ORDER BY f.ref,f.status
            """, ("tid",tid), ("mid",mid));
        var rows = new List<Item>();
        await using var r = await cmd.ExecuteReaderAsync(ct);
        while (await r.ReadAsync(ct))
            rows.Add(new(r.GetString(0), r.GetString(1), r.GetString(2), r.GetInt32(3), r.GetString(4), r.GetString(5), r.GetDecimal(6), r.GetBoolean(7)));
        return rows;
    }
}
