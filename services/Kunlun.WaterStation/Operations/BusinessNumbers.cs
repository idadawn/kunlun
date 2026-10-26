using Npgsql;
using static Kunlun.WaterStation.Operations.TicketBatches;

namespace Kunlun.WaterStation.Operations;

// Business numbers come from a counter row bumped inside the caller's transaction: concurrent requests queue on the
// row lock, a rolled-back request hands its number back, and numbers already taken (seeded or older random ones) are skipped.
// Deposit, refund and order numbers are unique across tenants, so their counters are global; member numbers are per tenant.
public static class BusinessNumbers
{
    public static async Task EnsureSchema(NpgsqlDataSource db, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var tx = await conn.BeginTransactionAsync(ct);
        await Exec(conn, tx, """
            SELECT pg_advisory_xact_lock(88482026);
            CREATE TABLE IF NOT EXISTS plugin_kunlun_waterstation.business_number_counters (
              scope VARCHAR(64) NOT NULL, period VARCHAR(8) NOT NULL, last_value BIGINT NOT NULL CHECK(last_value > 0),
              PRIMARY KEY(scope, period)
            );
            """, ct);
        await tx.CommitAsync(ct);
    }

    public static Task<string> MemberNo(NpgsqlConnection conn, NpgsqlTransaction tx, Guid tid, CancellationToken ct) =>
        Next(conn, tx, $"member:{tid}", "", n => $"No.{n:D6}",
            "SELECT EXISTS(SELECT 1 FROM plugin_kunlun_waterstation.members WHERE tenant_id=@tid AND member_no=@no)", ct, ("tid", tid));

    public static Task<string> DepositNo(NpgsqlConnection conn, NpgsqlTransaction tx, CancellationToken ct) =>
        Daily(conn, tx, "deposit", (day, n) => $"YJ{day}{n:D4}",
            "SELECT EXISTS(SELECT 1 FROM plugin_kunlun_waterstation.deposit_lots WHERE deposit_no=@no)", ct);

    public static Task<string> DepositRefundNo(NpgsqlConnection conn, NpgsqlTransaction tx, CancellationToken ct) =>
        Daily(conn, tx, "deposit-refund", (day, n) => $"TK{day}{n:D4}",
            "SELECT EXISTS(SELECT 1 FROM plugin_kunlun_waterstation.deposit_refunds WHERE refund_no=@no)", ct);

    public static Task<string> OrderNo(NpgsqlConnection conn, NpgsqlTransaction tx, CancellationToken ct) =>
        Daily(conn, tx, "order", (day, n) => $"ORD-{day}-{n:D6}",
            "SELECT EXISTS(SELECT 1 FROM plugin_kunlun_waterstation.water_orders WHERE order_no=@no)", ct);

    private static Task<string> Daily(NpgsqlConnection conn, NpgsqlTransaction tx, string scope, Func<string, long, string> format, string takenSql, CancellationToken ct)
    {
        var day = DateTime.UtcNow.ToString("yyyyMMdd");
        return Next(conn, tx, scope, day, n => format(day, n), takenSql, ct);
    }

    private static async Task<string> Next(NpgsqlConnection conn, NpgsqlTransaction tx, string scope, string period, Func<long, string> format, string takenSql, CancellationToken ct, params (string, object)[] takenArgs)
    {
        while (true)
        {
            await using var bump = Command(conn, tx, """
                INSERT INTO plugin_kunlun_waterstation.business_number_counters AS c (scope, period, last_value) VALUES (@scope, @period, 1)
                ON CONFLICT (scope, period) DO UPDATE SET last_value = c.last_value + 1
                RETURNING last_value
                """, ("scope", scope), ("period", period));
            var no = format((long)(await bump.ExecuteScalarAsync(ct))!);
            await using var taken = Command(conn, tx, takenSql, [.. takenArgs, ("no", no)]);
            if (!(bool)(await taken.ExecuteScalarAsync(ct))!) return no;
        }
    }
}
