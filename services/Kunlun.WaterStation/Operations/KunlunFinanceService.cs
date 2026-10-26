using System.Text.Json;
using Kunlun.WaterStation.Auth;
using Npgsql;

namespace Kunlun.WaterStation.Operations;

public sealed record CreateMemberRequest(string Name, string Phone, string? DefaultAddress, string? Remark);
public sealed record SaveRechargePlanRequest(
    string Name,
    string WaterType,     // BUCKET_18_9L | BAG_7_5L
    string FulfillMode,   // DELIVERY | PICKUP
    decimal Price,
    int BuyQty,
    int GiftQty,
    string Status = "ACTIVE");

public sealed record CreateRechargeOrderRequest(
    Guid MemberId,
    Guid PlanId,
    string PayMethod,
    string IdempotencyKey,
    string? Remark = null);

public sealed record CollectDepositRequest(
    Guid MemberId,
    string ContainerType, // BUCKET | BAG
    int Quantity,
    string PayMethod,
    string IdempotencyKey);

public sealed record RefundDepositRequest(
    Guid MemberId,
    string ContainerType, // BUCKET | BAG
    int Quantity,
    string IdempotencyKey);

public sealed record RegisterContainerMovementRequest(
    Guid MemberId,
    string ContainerType, // BUCKET | BAG
    int FullOutN,
    int EmptyInM,
    string? OrderNo = null);

public sealed class KunlunFinanceRepository(NpgsqlDataSource dataSource, KunlunAuthRepository authRepo)
{
    public Guid TenantId => authRepo.DefaultTenantId;

    public async Task EnsureFinanceSchemaAndSeedAsync(CancellationToken ct = default)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        await using var tx = await conn.BeginTransactionAsync(ct);

        const string ddl = """
            SELECT pg_advisory_xact_lock(88482026);
            SET search_path TO plugin_kunlun_waterstation, public;

            CREATE TABLE IF NOT EXISTS recharge_plans (
                id UUID PRIMARY KEY,
                tenant_id UUID NOT NULL,
                name VARCHAR(80) NOT NULL,
                water_type VARCHAR(24) NOT NULL,
                fulfill_mode VARCHAR(16) NOT NULL,
                price NUMERIC(10,2) NOT NULL CHECK (price > 0),
                buy_qty INT NOT NULL CHECK (buy_qty > 0),
                gift_qty INT NOT NULL DEFAULT 0 CHECK (gift_qty >= 0),
                status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE (tenant_id, name)
            );

            CREATE TABLE IF NOT EXISTS recharge_orders (
                id UUID PRIMARY KEY,
                tenant_id UUID NOT NULL,
                recharge_no VARCHAR(32) NOT NULL UNIQUE,
                idempotency_key VARCHAR(80) NOT NULL,
                member_id UUID NOT NULL REFERENCES members(id),
                plan_id UUID NOT NULL REFERENCES recharge_plans(id),
                plan_snapshot JSONB NOT NULL,
                paid_amount NUMERIC(10,2) NOT NULL CHECK (paid_amount > 0),
                buy_qty INT NOT NULL,
                gift_qty INT NOT NULL,
                total_tickets INT NOT NULL,
                pay_method VARCHAR(24) NOT NULL,
                operator_id UUID NOT NULL,
                operator_name VARCHAR(64) NOT NULL,
                remark TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE (tenant_id, idempotency_key)
            );

            CREATE TABLE IF NOT EXISTS ticket_ledgers (
                id BIGSERIAL PRIMARY KEY,
                tenant_id UUID NOT NULL,
                ledger_no VARCHAR(32) NOT NULL,
                member_id UUID NOT NULL REFERENCES members(id),
                water_type VARCHAR(24) NOT NULL,
                fulfill_mode VARCHAR(16) NOT NULL,
                change_type VARCHAR(24) NOT NULL, -- RECHARGE_BUY | RECHARGE_GIFT | ORDER_RESERVE | ORDER_RELEASE | ORDER_CONSUME
                delta_qty INT NOT NULL,
                balance_after INT NOT NULL CHECK (balance_after >= 0),
                ref_no VARCHAR(32) NOT NULL,
                operator_name VARCHAR(64) NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS container_configs (
                tenant_id UUID NOT NULL,
                container_type VARCHAR(16) NOT NULL, -- BUCKET | BAG
                unit_deposit NUMERIC(10,2) NOT NULL CHECK (unit_deposit > 0),
                total_qty INT NOT NULL DEFAULT 1200,
                in_station_qty INT NOT NULL DEFAULT 86,
                in_transit_qty INT NOT NULL DEFAULT 18,
                member_held_qty INT NOT NULL DEFAULT 986,
                inspecting_qty INT NOT NULL DEFAULT 108,
                abnormal_qty INT NOT NULL DEFAULT 2,
                warn_threshold INT NOT NULL DEFAULT 100,
                PRIMARY KEY (tenant_id, container_type),
                CHECK (total_qty = in_station_qty + in_transit_qty + member_held_qty + inspecting_qty + abnormal_qty)
            );

            CREATE TABLE IF NOT EXISTS deposit_lots (
                id UUID PRIMARY KEY,
                tenant_id UUID NOT NULL,
                deposit_no VARCHAR(32) NOT NULL UNIQUE,
                idempotency_key VARCHAR(80) NOT NULL,
                member_id UUID NOT NULL REFERENCES members(id),
                container_type VARCHAR(16) NOT NULL, -- BUCKET | BAG
                unit_price NUMERIC(10,2) NOT NULL CHECK (unit_price > 0),
                paid_qty INT NOT NULL CHECK (paid_qty > 0),
                refunded_qty INT NOT NULL DEFAULT 0 CHECK (refunded_qty >= 0),
                remaining_qty INT NOT NULL CHECK (remaining_qty >= 0 AND remaining_qty <= paid_qty),
                total_amount NUMERIC(10,2) NOT NULL,
                pay_method VARCHAR(24) NOT NULL,
                operator_name VARCHAR(64) NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE (tenant_id, idempotency_key)
            );

            CREATE TABLE IF NOT EXISTS deposit_refunds (
                id UUID PRIMARY KEY,
                tenant_id UUID NOT NULL,
                refund_no VARCHAR(32) NOT NULL UNIQUE,
                idempotency_key VARCHAR(80) NOT NULL,
                member_id UUID NOT NULL REFERENCES members(id),
                container_type VARCHAR(16) NOT NULL,
                refund_qty INT NOT NULL CHECK (refund_qty > 0),
                refund_amount NUMERIC(10,2) NOT NULL CHECK (refund_amount > 0),
                lot_breakdown JSONB NOT NULL,
                operator_name VARCHAR(64) NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE (tenant_id, idempotency_key)
            );
            """;

        await using (var cmd = new NpgsqlCommand(ddl, conn, tx))
        {
            await cmd.ExecuteNonQueryAsync(ct);
        }

        // Seed 3 default recharge plans (AC-02: 同价不同领取方式享不同赠送)
        var plans = new[]
        {
            (Id: Guid.Parse("30000000-0000-0000-0000-000000000001"), Name: "小分子团弱碱活性水 · 配送畅享包", Water: "BUCKET_18_9L", Mode: "DELIVERY", Price: 200.00m, Buy: 10, Gift: 2),
            (Id: Guid.Parse("30000000-0000-0000-0000-000000000002"), Name: "小分子团弱碱活性水 · 自提实惠包", Water: "BUCKET_18_9L", Mode: "PICKUP", Price: 200.00m, Buy: 12, Gift: 2),
            (Id: Guid.Parse("30000000-0000-0000-0000-000000000003"), Name: "小分子团弱碱活性水 · 袋装家庭包", Water: "BAG_7_5L", Mode: "PICKUP", Price: 100.00m, Buy: 10, Gift: 1)
        };
        foreach (var p in plans)
        {
            await using var cmd = new NpgsqlCommand("""
                INSERT INTO plugin_kunlun_waterstation.recharge_plans
                    (id, tenant_id, name, water_type, fulfill_mode, price, buy_qty, gift_qty, status)
                VALUES (@id, @tid, @name, @water, @mode, @price, @buy, @gift, 'ACTIVE')
                ON CONFLICT (tenant_id, name) DO NOTHING
                """, conn, tx);
            cmd.Parameters.AddWithValue("id", p.Id);
            cmd.Parameters.AddWithValue("tid", TenantId);
            cmd.Parameters.AddWithValue("name", p.Name);
            cmd.Parameters.AddWithValue("water", p.Water);
            cmd.Parameters.AddWithValue("mode", p.Mode);
            cmd.Parameters.AddWithValue("price", p.Price);
            cmd.Parameters.AddWithValue("buy", p.Buy);
            cmd.Parameters.AddWithValue("gift", p.Gift);
            await cmd.ExecuteNonQueryAsync(ct);
        }

        // Seed container configs (18.9L 周转桶 ¥50/个, 7.5L 袋装容器 ¥30/个)
        await using (var cfgCmd = new NpgsqlCommand("""
            INSERT INTO plugin_kunlun_waterstation.container_configs
                (tenant_id, container_type, unit_deposit, total_qty, in_station_qty, in_transit_qty, member_held_qty, inspecting_qty, abnormal_qty, warn_threshold)
            VALUES
                (@tid, 'BUCKET', 50.00, 200, 88, 0, 2, 108, 2, 100),
                (@tid, 'BAG', 30.00, 200, 164, 0, 2, 34, 0, 80)
            ON CONFLICT (tenant_id, container_type) DO NOTHING
            """, conn, tx))
        {
            cfgCmd.Parameters.AddWithValue("tid", TenantId);
            await cfgCmd.ExecuteNonQueryAsync(ct);
        }

        // Seed initial deposit lots for 陈静 (2 桶 @ ¥50 + 1 袋 @ ¥30) & 周明 (1 袋 @ ¥30)
        var chenId = Guid.Parse("20000000-0000-0000-0000-000000008621");
        var zhouId = Guid.Parse("20000000-0000-0000-0000-000000008620");
        await using (var lotCmd = new NpgsqlCommand("""
            INSERT INTO plugin_kunlun_waterstation.deposit_lots
                (id, tenant_id, deposit_no, idempotency_key, member_id, container_type, unit_price, paid_qty, refunded_qty, remaining_qty, total_amount, pay_method, operator_name)
            VALUES
                ('40000000-0000-0000-0000-000000000001', @tid, 'YJ202609120001', 'seed-chen-bucket', @mid,  'BUCKET', 50.00, 2, 0, 2, 100.00, 'CASH',   '林站长'),
                ('40000000-0000-0000-0000-000000000002', @tid, 'YJ202609120002', 'seed-chen-bag',    @mid,  'BAG',    30.00, 1, 0, 1,  30.00, 'CASH',   '林站长'),
                ('40000000-0000-0000-0000-000000000003', @tid, 'YJ202609150001', 'seed-zhou-bag',    @zmid, 'BAG',    30.00, 1, 0, 1,  30.00, 'WECHAT', '林站长')
            ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
            """, conn, tx))
        {
            lotCmd.Parameters.AddWithValue("tid", TenantId);
            lotCmd.Parameters.AddWithValue("mid", chenId);
            lotCmd.Parameters.AddWithValue("zmid", zhouId);
            await lotCmd.ExecuteNonQueryAsync(ct);
        }

        await tx.CommitAsync(ct);
    }

    public static string GetTicketColumn(string waterType, string fulfillMode) =>
        (waterType, fulfillMode) switch
        {
            ("BUCKET_18_9L", "DELIVERY") => "bucket_delivery_tickets",
            ("BUCKET_18_9L", "PICKUP") => "bucket_pickup_tickets",
            ("BAG_7_5L", "PICKUP") => "bag_pickup_tickets",
            ("BAG_7_5L", "DELIVERY") => "bag_delivery_tickets",
            _ => throw new ArgumentException($"Unsupported ticket category: {waterType} + {fulfillMode}")
        };
}
