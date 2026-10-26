using Npgsql;

namespace Kunlun.WaterStation.Operations;

public sealed class BusinessRuleException(string message, int status = 400) : Exception(message)
{
    public int Status { get; } = status;
}

public static class TicketBatches
{
    public static NpgsqlCommand Command(NpgsqlConnection conn, NpgsqlTransaction? tx, string sql, params (string, object)[] args)
    {
        var cmd = new NpgsqlCommand(sql, conn, tx);
        foreach (var (key, value) in args) cmd.Parameters.AddWithValue(key, value);
        return cmd;
    }
    public static async Task<int> Exec(NpgsqlConnection conn, NpgsqlTransaction? tx, string sql, CancellationToken ct, params (string, object)[] args)
    {
        await using var cmd = Command(conn, tx, sql, args);
        return await cmd.ExecuteNonQueryAsync(ct);
    }
    public static async Task LockMember(NpgsqlConnection conn, NpgsqlTransaction tx, Guid tid, Guid mid, CancellationToken ct)
    {
        await using var cmd = Command(conn, tx, "SELECT status FROM plugin_kunlun_waterstation.members WHERE tenant_id=@tid AND id=@mid FOR UPDATE", ("tid", tid), ("mid", mid));
        var status = await cmd.ExecuteScalarAsync(ct);
        if (status is null) throw new BusinessRuleException("会员不存在", 404);
        if ((string)status != "ACTIVE") throw new BusinessRuleException("会员已停用");
    }
    public static async Task LockRequest(NpgsqlConnection conn, NpgsqlTransaction tx, Guid tid, string kind, string key, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(key) || key.Length > 80) throw new BusinessRuleException("请求唯一标识无效");
        await Exec(conn, tx, "SELECT pg_advisory_xact_lock(hashtextextended(@key, 0))", ct, ("key", $"{tid}:{kind}:{key}"));
    }

    public static async Task EnsureSchema(NpgsqlDataSource db, Guid tid, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var tx = await conn.BeginTransactionAsync(ct);
        await Exec(conn, tx, """
            SELECT pg_advisory_xact_lock(88482026);
            SET search_path TO plugin_kunlun_waterstation, public;
            CREATE TABLE IF NOT EXISTS ticket_batches (
              id UUID PRIMARY KEY, tenant_id UUID NOT NULL, member_id UUID NOT NULL REFERENCES members(id),
              recharge_id UUID UNIQUE REFERENCES recharge_orders(id), source VARCHAR(16) NOT NULL,
              water_type VARCHAR(24) NOT NULL, fulfill_mode VARCHAR(16) NOT NULL,
              paid_amount NUMERIC(10,2) NOT NULL, fixed_qty INT NOT NULL CHECK(fixed_qty > 0),
              gift_qty INT NOT NULL CHECK(gift_qty >= 0), remaining_buy INT NOT NULL, remaining_gift INT NOT NULL,
              reserved_buy INT NOT NULL DEFAULT 0, reserved_gift INT NOT NULL DEFAULT 0,
              status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE', created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
              CHECK(remaining_buy BETWEEN 0 AND fixed_qty), CHECK(remaining_gift BETWEEN 0 AND gift_qty),
              CHECK(reserved_buy BETWEEN 0 AND remaining_buy), CHECK(reserved_gift BETWEEN 0 AND remaining_gift)
            );
            CREATE INDEX IF NOT EXISTS batch_member ON ticket_batches(tenant_id,member_id,water_type,fulfill_mode,created_at,id);
            CREATE TABLE IF NOT EXISTS order_ticket_allocations (
              order_id UUID NOT NULL REFERENCES water_orders(id), batch_id UUID NOT NULL REFERENCES ticket_batches(id),
              buy_qty INT NOT NULL CHECK(buy_qty>=0), gift_qty INT NOT NULL CHECK(gift_qty>=0),
              consumed_buy INT NOT NULL DEFAULT 0, consumed_gift INT NOT NULL DEFAULT 0,
              status VARCHAR(16) NOT NULL DEFAULT 'RESERVED', PRIMARY KEY(order_id,batch_id)
            );
            CREATE TABLE IF NOT EXISTS coupon_templates (
              id UUID PRIMARY KEY, tenant_id UUID NOT NULL, name VARCHAR(80) NOT NULL,
              plan_id UUID NOT NULL REFERENCES recharge_plans(id), gift_qty INT NOT NULL CHECK(gift_qty>0),
              starts_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
              per_member_limit INT NOT NULL CHECK(per_member_limit>0), status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
              CHECK(expires_at>starts_at)
            );
            CREATE TABLE IF NOT EXISTS member_coupons (
              id UUID PRIMARY KEY, tenant_id UUID NOT NULL, member_id UUID NOT NULL REFERENCES members(id),
              template_id UUID NOT NULL REFERENCES coupon_templates(id), snapshot JSONB NOT NULL,
              idempotency_key VARCHAR(80) NOT NULL, status VARCHAR(16) NOT NULL DEFAULT 'AVAILABLE',
              recharge_id UUID UNIQUE REFERENCES recharge_orders(id), issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
              UNIQUE(tenant_id,idempotency_key)
            );
            ALTER TABLE recharge_orders ADD COLUMN IF NOT EXISTS coupon_snapshot JSONB;
            CREATE TABLE IF NOT EXISTS recharge_refunds (
              id UUID PRIMARY KEY, tenant_id UUID NOT NULL, refund_no VARCHAR(32) NOT NULL UNIQUE,
              member_id UUID NOT NULL REFERENCES members(id), batch_id UUID NOT NULL UNIQUE REFERENCES ticket_batches(id),
              idempotency_key VARCHAR(80) NOT NULL, refund_buy_qty INT NOT NULL CHECK(refund_buy_qty>=0),
              revoked_gift_qty INT NOT NULL CHECK(revoked_gift_qty>=0), amount NUMERIC(10,2) NOT NULL CHECK(amount>=0),
              pay_method VARCHAR(24) NOT NULL, reason TEXT NOT NULL, operator_name VARCHAR(64) NOT NULL,
              created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(tenant_id,idempotency_key)
            );
            CREATE TABLE IF NOT EXISTS membership_migrations (tenant_id UUID NOT NULL, name TEXT NOT NULL, PRIMARY KEY(tenant_id,name));
            """, ct);
        var first = await Exec(conn, tx, "INSERT INTO plugin_kunlun_waterstation.membership_migrations VALUES (@tid,'opening-balances-v1') ON CONFLICT DO NOTHING", ct, ("tid", tid));
        if (first == 1)
        {
            foreach (var (water, mode) in new[] { ("BUCKET_18_9L", "PICKUP"), ("BUCKET_18_9L", "DELIVERY"), ("BAG_7_5L", "PICKUP"), ("BAG_7_5L", "DELIVERY") })
            {
                var (available, reserved, _) = KunlunOrderRepository.ResolveTicketColumns(water, mode);
                await Exec(conn, tx, $"""
                    INSERT INTO plugin_kunlun_waterstation.ticket_batches
                      (id,tenant_id,member_id,source,water_type,fulfill_mode,paid_amount,fixed_qty,gift_qty,remaining_buy,remaining_gift,created_at)
                    SELECT gen_random_uuid(),tenant_id,id,'LEGACY',@water,@mode,0,{available}+{reserved},0,{available}+{reserved},0,'2000-01-01'::timestamptz
                    FROM plugin_kunlun_waterstation.members WHERE tenant_id=@tid AND {available}+{reserved}>0
                    """, ct, ("tid", tid), ("water", water), ("mode", mode));
            }
            var pending = new List<(Guid Id, Guid Member, string Water, string Mode, int Qty)>();
            await using (var cmd = Command(conn, tx, "SELECT id,member_id,water_type,fulfill_mode,reserved_qty FROM plugin_kunlun_waterstation.water_orders WHERE tenant_id=@tid AND status IN ('PENDING','DISPATCHED') ORDER BY created_at,id", ("tid", tid)))
            await using (var r = await cmd.ExecuteReaderAsync(ct))
                while (await r.ReadAsync(ct)) pending.Add((r.GetGuid(0), r.GetGuid(1), r.GetString(2), r.GetString(3), r.GetInt32(4)));
            foreach (var o in pending) await Reserve(conn, tx, tid, o.Member, o.Water, o.Mode, o.Id, o.Qty, ct);
        }
        await tx.CommitAsync(ct);
    }

    // Caller always holds the member row lock. This serializes orders, recharges and refunds.
    public static async Task Reserve(NpgsqlConnection conn, NpgsqlTransaction tx, Guid tid, Guid mid, string water, string mode, Guid orderId, int qty, CancellationToken ct)
    {
        var rows = new List<(Guid Id, int Buy, int Gift)>();
        await using (var cmd = Command(conn, tx, """
            SELECT id, remaining_buy-reserved_buy, remaining_gift-reserved_gift
            FROM plugin_kunlun_waterstation.ticket_batches
            WHERE tenant_id=@tid AND member_id=@mid AND water_type=@water AND fulfill_mode=@mode AND status='ACTIVE'
              AND remaining_buy+remaining_gift>reserved_buy+reserved_gift
            ORDER BY created_at,id FOR UPDATE
            """, ("tid", tid), ("mid", mid), ("water", water), ("mode", mode)))
        await using (var r = await cmd.ExecuteReaderAsync(ct))
            while (await r.ReadAsync(ct)) rows.Add((r.GetGuid(0), r.GetInt32(1), r.GetInt32(2)));
        foreach (var row in rows)
        {
            if (qty == 0) break;
            var buy = Math.Min(qty, row.Buy); qty -= buy;
            var gift = Math.Min(qty, row.Gift); qty -= gift;
            await Exec(conn, tx, "UPDATE plugin_kunlun_waterstation.ticket_batches SET reserved_buy=reserved_buy+@buy,reserved_gift=reserved_gift+@gift WHERE id=@id", ct, ("id", row.Id), ("buy", buy), ("gift", gift));
            await Exec(conn, tx, """
                INSERT INTO plugin_kunlun_waterstation.order_ticket_allocations(order_id,batch_id,buy_qty,gift_qty)
                VALUES(@oid,@bid,@buy,@gift) ON CONFLICT(order_id,batch_id) DO UPDATE
                SET buy_qty=order_ticket_allocations.buy_qty+EXCLUDED.buy_qty,gift_qty=order_ticket_allocations.gift_qty+EXCLUDED.gift_qty
                """, ct, ("oid", orderId), ("bid", row.Id), ("buy", buy), ("gift", gift));
        }
        if (qty != 0) throw new BusinessRuleException("批次水票不足，请先核对历史余额", 409);
    }

    public static async Task Settle(NpgsqlConnection conn, NpgsqlTransaction tx, Guid orderId, int consumed, CancellationToken ct)
    {
        var rows = new List<(Guid Id, int Buy, int Gift, int RemainingBuy)>();
        await using (var cmd = Command(conn, tx, """
            SELECT a.batch_id,a.buy_qty,a.gift_qty,b.remaining_buy
            FROM plugin_kunlun_waterstation.order_ticket_allocations a JOIN plugin_kunlun_waterstation.ticket_batches b ON b.id=a.batch_id
            WHERE a.order_id=@oid AND a.status='RESERVED' ORDER BY b.created_at,b.id FOR UPDATE OF a,b
            """, ("oid", orderId)))
        await using (var r = await cmd.ExecuteReaderAsync(ct))
            while (await r.ReadAsync(ct)) rows.Add((r.GetGuid(0), r.GetInt32(1), r.GetInt32(2), r.GetInt32(3)));
        var actual = consumed;
        foreach (var row in rows)
        {
            var buy = Math.Min(consumed, row.Buy); consumed -= buy;
            var gift = Math.Min(consumed, row.Gift); consumed -= gift;
            if (gift > 0 && row.RemainingBuy > buy)
                throw new BusinessRuleException("该批次仍有付费水票待使用，请先完成或取消占用付费票的订单", 409);
            await Exec(conn, tx, """
                UPDATE plugin_kunlun_waterstation.ticket_batches
                SET remaining_buy=remaining_buy-@buy,remaining_gift=remaining_gift-@gift,
                    reserved_buy=reserved_buy-@rb,reserved_gift=reserved_gift-@rg WHERE id=@bid
                """, ct, ("bid", row.Id), ("buy", buy), ("gift", gift), ("rb", row.Buy), ("rg", row.Gift));
            await Exec(conn, tx, """
                UPDATE plugin_kunlun_waterstation.order_ticket_allocations
                SET consumed_buy=@buy,consumed_gift=@gift,status=@status WHERE order_id=@oid AND batch_id=@bid
                """, ct, ("oid", orderId), ("bid", row.Id), ("buy", buy), ("gift", gift), ("status", actual == 0 ? "RELEASED" : "CONSUMED"));
        }
        if (consumed != 0) throw new BusinessRuleException("水单扣票来源不完整，请核对批次", 409);
    }
}
