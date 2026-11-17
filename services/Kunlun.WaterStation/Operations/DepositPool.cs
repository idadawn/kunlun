using Npgsql;
using static Kunlun.WaterStation.Operations.TicketBatches;

namespace Kunlun.WaterStation.Operations;

/// <summary>Member-wide deposits. Legacy whole units retain their original value until used.
/// A partial debit leaves its change in the same lot as money, so every cent has a source.</summary>
internal static class DepositPool
{
    internal sealed record Balance(decimal Total, decimal Reserved, decimal Pending, decimal PendingCollect, decimal Required)
    {
        public decimal Shortfall => Math.Max(0, Required - Available - PendingCollect);
        public decimal Available => Math.Max(0, Total - Reserved - Pending);
    }

    internal static async Task<Balance> Read(NpgsqlConnection conn, NpgsqlTransaction? tx, Guid tid, Guid mid, CancellationToken ct, Guid? except = null)
    {
        await using var cmd = Command(conn, tx, """
            SELECT COALESCE(sum(COALESCE(unit_price,0)*remaining_qty + free_amount),0),
                   COALESCE(sum(unit_price*reserved_damage_qty),0),
                   (SELECT COALESCE(sum(estimated_amount),0) FROM plugin_kunlun_waterstation.refund_requests
                    WHERE tenant_id=@tid AND member_id=@mid AND kind='DEPOSIT' AND status='PENDING' AND id IS DISTINCT FROM @except::uuid),
                   (SELECT COALESCE(sum(estimated_amount),0) FROM plugin_kunlun_waterstation.refund_requests
                    WHERE tenant_id=@tid AND member_id=@mid AND kind='COLLECT' AND status='PENDING'),
                   (SELECT COALESCE(sum(h.quantity*c.unit_deposit),0) FROM plugin_kunlun_waterstation.member_container_holdings h
                    JOIN plugin_kunlun_waterstation.container_configs c USING(tenant_id,container_type) WHERE h.tenant_id=@tid AND h.member_id=@mid)
            FROM plugin_kunlun_waterstation.deposit_lots WHERE tenant_id=@tid AND member_id=@mid
            """, ("tid", tid), ("mid", mid), ("except", (object?)except ?? DBNull.Value));
        await using var r = await cmd.ExecuteReaderAsync(ct);
        await r.ReadAsync(ct);
        return new(r.GetDecimal(0), r.GetDecimal(1), r.GetDecimal(2), r.GetDecimal(3), r.GetDecimal(4));
    }

    internal static decimal Positive(decimal? amount) => amount is { } n && Money.Valid(n, false)
        ? n : throw new BusinessRuleException("请输入大于零的押金金额，最多两位小数");

    internal static void Check(decimal value, Balance balance)
    {
        if (value > balance.Available) throw new BusinessRuleException($"当前可用押金 ¥{Money.Text(balance.Available)}，金额超出余额");
    }

    // All writers hold the member lock. Reserved units belonging to unfinished damage reports are never spent here.
    internal static async Task<FinanceEndpoints.DepositRefundResult> Debit(NpgsqlConnection conn, NpgsqlTransaction tx, Guid tid, Guid mid,
        decimal value, decimal payout, string? pay, string key, string actor, CancellationToken ct, Guid? except = null)
    {
        Check(value, await Read(conn, tx, tid, mid, ct, except));
        var lots = new List<(Guid Id, string No, decimal Price, int Units, decimal Free)>();
        await using (var cmd = Command(conn, tx, """
            WITH lots AS (
              SELECT id,deposit_no,unit_price,free_amount,remaining_qty-reserved_damage_qty AS units,created_at,container_type,
                 sum(remaining_qty-reserved_damage_qty) OVER (PARTITION BY container_type ORDER BY created_at,id) AS cumulative
              FROM plugin_kunlun_waterstation.deposit_lots WHERE tenant_id=@tid AND member_id=@mid
                AND (remaining_qty>reserved_damage_qty OR free_amount>0)
            ), pending AS (
              SELECT container_type,sum(quantity) AS qty FROM plugin_kunlun_waterstation.refund_requests
              WHERE tenant_id=@tid AND member_id=@mid AND kind='DEPOSIT' AND status='PENDING' AND container_type IS NOT NULL
              GROUP BY container_type
            )
            SELECT id,deposit_no,COALESCE(unit_price,0),least(units,greatest(0,cumulative-COALESCE(qty,0)))::int,free_amount
            FROM lots LEFT JOIN pending USING(container_type) ORDER BY created_at,id
            """, ("tid", tid), ("mid", mid)))
        await using (var r = await cmd.ExecuteReaderAsync(ct))
            while (await r.ReadAsync(ct)) lots.Add((r.GetGuid(0), r.GetString(1), r.GetDecimal(2), r.GetInt32(3), r.GetDecimal(4)));
        var breakdown = new List<object>();
        var left = value;
        foreach (var lot in lots)
        {
            if (left == 0) break;
            var take = Math.Min(left, lot.Free + lot.Price * lot.Units);
            if (take == 0) continue;
            var units = take > lot.Free ? (int)decimal.Ceiling((take - lot.Free) / lot.Price) : 0;
            await Exec(conn, tx, """
                UPDATE plugin_kunlun_waterstation.deposit_lots SET remaining_qty=remaining_qty-@units,
                  refunded_qty=refunded_qty+@units,free_amount=free_amount+@change WHERE id=@id
                """, ct, ("id", lot.Id), ("units", units), ("change", units * lot.Price - take));
            breakdown.Add(new { lotNo = lot.No, subAmount = take });
            left -= take;
        }
        if (left != 0) throw new BusinessRuleException("押金余额已变化，请重新核对", 409);
        var no = await BusinessNumbers.DepositRefundNo(conn, tx, ct);
        await Exec(conn, tx, """
            INSERT INTO plugin_kunlun_waterstation.deposit_refunds
              (id,tenant_id,refund_no,idempotency_key,member_id,refund_amount,deducted_amount,lot_breakdown,operator_name,pay_method)
            VALUES (@id,@tid,@no,@key,@mid,@paid,@kept,@lots::jsonb,@actor,@pay);
            UPDATE plugin_kunlun_waterstation.members SET deposit_amount=deposit_amount-@value WHERE tenant_id=@tid AND id=@mid
            """, ct, ("id", Guid.NewGuid()), ("tid", tid), ("no", no), ("key", key), ("mid", mid), ("paid", payout),
            ("kept", value - payout), ("lots", ContainerInventory.Json(breakdown)), ("actor", actor), ("pay", (object?)pay ?? DBNull.Value), ("value", value));
        return new(no, payout, breakdown, value, value - payout);
    }
}
