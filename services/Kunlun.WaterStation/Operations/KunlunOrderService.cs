using Npgsql;
using Kunlun.WaterStation.Auth;

namespace Kunlun.WaterStation.Operations;

public sealed record CreateWaterOrderRequest(
    Guid MemberId,
    string WaterType,      // BUCKET_18_9L | BAG_7_5L
    string FulfillMode,    // DELIVERY | PICKUP
    int OrderQty,
    string IdempotencyKey,
    Guid? AddressId = null,        // delivery address from the member address book; default address when omitted
    string? AppointmentSlot = null,
    string? Remark = null);

public sealed record CancelWaterOrderRequest(
    string CancelReason);

public sealed record FulfillWaterOrderRequest(
    int ActualQty,
    int FullOutN,
    int EmptyInM,
    string? PickupCode = null,
    string? DiffReason = null,
    bool ForceCreditOverride = false,
    string? OverrideReason = null);

public sealed record VerifyPickupCodeRequest(
    string PickupCode,
    int ActualQty,
    int FullOutN,
    int EmptyInM,
    string? DiffReason = null);

public sealed class KunlunOrderRepository(NpgsqlDataSource dataSource, KunlunAuthRepository authRepo)
{
    public Guid TenantId => authRepo.DefaultTenantId;

    public async Task EnsureOrderSchemaAsync(CancellationToken ct = default)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        await using var tx = await conn.BeginTransactionAsync(ct);

        const string ddl = """
            SELECT pg_advisory_xact_lock(88482026);
            SET search_path TO plugin_kunlun_waterstation, public;

            ALTER TABLE members ADD COLUMN IF NOT EXISTS reserved_bucket_delivery_tickets INT NOT NULL DEFAULT 0 CHECK (reserved_bucket_delivery_tickets >= 0);
            ALTER TABLE members ADD COLUMN IF NOT EXISTS reserved_bucket_pickup_tickets INT NOT NULL DEFAULT 0 CHECK (reserved_bucket_pickup_tickets >= 0);
            ALTER TABLE members ADD COLUMN IF NOT EXISTS reserved_bag_pickup_tickets INT NOT NULL DEFAULT 0 CHECK (reserved_bag_pickup_tickets >= 0);
            ALTER TABLE members ADD COLUMN IF NOT EXISTS reserved_bag_delivery_tickets INT NOT NULL DEFAULT 0 CHECK (reserved_bag_delivery_tickets >= 0);

            CREATE TABLE IF NOT EXISTS water_orders (
                id UUID PRIMARY KEY,
                tenant_id UUID NOT NULL,
                order_no VARCHAR(32) NOT NULL UNIQUE,
                idempotency_key VARCHAR(80) NOT NULL,
                member_id UUID NOT NULL REFERENCES members(id),
                water_type VARCHAR(24) NOT NULL,
                fulfill_mode VARCHAR(16) NOT NULL,
                order_qty INT NOT NULL CHECK (order_qty > 0),
                reserved_qty INT NOT NULL CHECK (reserved_qty >= 0),
                actual_qty INT,
                full_out_qty INT,
                empty_in_qty INT,
                pickup_code VARCHAR(8),
                address_snapshot JSONB NOT NULL,
                appointment_slot VARCHAR(64),
                status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
                diff_reason TEXT,
                cancel_reason TEXT,
                override_reason TEXT,
                created_by_type VARCHAR(16) NOT NULL,
                created_by_name VARCHAR(64) NOT NULL,
                fulfilled_by_name VARCHAR(64),
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                completed_at TIMESTAMPTZ,
                cancelled_at TIMESTAMPTZ,
                UNIQUE (tenant_id, idempotency_key)
            );

            ALTER TABLE water_orders ADD COLUMN IF NOT EXISTS product_snapshot JSONB;
            ALTER TABLE water_orders ADD COLUMN IF NOT EXISTS remark VARCHAR(200);

            CREATE TABLE IF NOT EXISTS container_ledgers (
                id BIGSERIAL PRIMARY KEY,
                tenant_id UUID NOT NULL,
                ledger_no VARCHAR(32) NOT NULL,
                member_id UUID NOT NULL REFERENCES members(id),
                container_type VARCHAR(16) NOT NULL,
                order_no VARCHAR(32),
                full_out_qty INT NOT NULL,
                empty_in_qty INT NOT NULL,
                delta_held INT NOT NULL,
                held_after INT NOT NULL CHECK (held_after >= 0),
                covered_deposit_qty_after INT NOT NULL,
                operator_name VARCHAR(64) NOT NULL,
                remark TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
            """;

        await using (var cmd = new NpgsqlCommand(ddl, conn, tx))
        {
            await cmd.ExecuteNonQueryAsync(ct);
        }

        await tx.CommitAsync(ct);
    }

    public static (string AvailableCol, string ReservedCol, string ContainerType) ResolveTicketColumns(string waterType, string fulfillMode) =>
        (waterType, fulfillMode) switch
        {
            ("BUCKET_18_9L", "DELIVERY") => ("bucket_delivery_tickets", "reserved_bucket_delivery_tickets", "BUCKET"),
            ("BUCKET_18_9L", "PICKUP")   => ("bucket_pickup_tickets",   "reserved_bucket_pickup_tickets",   "BUCKET"),
            ("BAG_7_5L",     "PICKUP")   => ("bag_pickup_tickets",      "reserved_bag_pickup_tickets",      "BAG"),
            ("BAG_7_5L",     "DELIVERY") => ("bag_delivery_tickets",    "reserved_bag_delivery_tickets",    "BAG"),
            _ => throw new ArgumentException($"Unsupported waterType/fulfillMode combination: {waterType}/{fulfillMode}")
        };
}
