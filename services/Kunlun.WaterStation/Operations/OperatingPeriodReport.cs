using System.Data;
using System.Security.Claims;
using Kunlun.WaterStation.Auth;
using Npgsql;
using static Kunlun.WaterStation.Operations.TicketBatches;

namespace Kunlun.WaterStation.Operations;

internal static class OperatingPeriodReport
{
    private static readonly TimeSpan StationOffset = TimeSpan.FromHours(8);

    internal sealed record Window(DateOnly Start, DateOnly End, string Grain);

    internal static Window Resolve(string period, DateTimeOffset now)
    {
        var today = DateOnly.FromDateTime(now.ToOffset(StationOffset).DateTime);
        var monday = today.AddDays(-(((int)today.DayOfWeek + 6) % 7));
        var month = new DateOnly(today.Year, today.Month, 1);
        var year = new DateOnly(today.Year, 1, 1);
        return period switch
        {
            "today" => new(today, today, "hour"),
            "week" => new(monday, today, "day"),
            "last-week" => new(monday.AddDays(-7), monday.AddDays(-1), "day"),
            "month" => new(month, today, "day"),
            "last-month" => new(month.AddMonths(-1), month.AddDays(-1), "day"),
            "year" => new(year, today, "month"),
            "last-year" => new(year.AddYears(-1), year.AddDays(-1), "month"),
            _ => throw new BusinessRuleException("请选择有效的经营统计周期")
        };
    }

    public static async Task<IResult> Get(string period, ClaimsPrincipal user, NpgsqlDataSource db, KunlunAuthRepository repo, CancellationToken ct)
    {
        if (!Expenses.CanRead(user)) return Results.Forbid();
        var now = DateTimeOffset.UtcNow;
        var window = Resolve(period, now);
        var from = new DateTimeOffset(window.Start.ToDateTime(TimeOnly.MinValue), StationOffset).ToUniversalTime();
        var until = new DateTimeOffset(window.End.AddDays(1).ToDateTime(TimeOnly.MinValue), StationOffset).ToUniversalTime();

        await using var conn = await db.OpenConnectionAsync(ct);
        await using var tx = await conn.BeginTransactionAsync(IsolationLevel.RepeatableRead, ct);
        var cash = await Expenses.ReadSummary(conn, tx, repo.DefaultTenantId, from, until, ct);
        // Expense-only staff can read the same cash figures as the expense ledger.
        var activity = user.HasClaim("perm", KunlunPermissions.ReportExport)
            ? await ReadActivity(conn, tx, repo.DefaultTenantId, from, until, now, window.Grain, ct) : null;
        await tx.CommitAsync(ct);
        return Results.Ok(new { window.Start, window.End, window.Grain, cash, activity });
    }

    private sealed record Point(string Label, decimal Receipts, long Buckets, long Bags, long Deliveries, long Pickups, long NewMembers);

    private sealed record Activity(List<Point> Trend, decimal RedeemedValue);

    private static async Task<Activity> ReadActivity(NpgsqlConnection conn, NpgsqlTransaction tx, Guid tid,
        DateTimeOffset from, DateTimeOffset until, DateTimeOffset now, string grain, CancellationToken ct)
    {
        // Group at the station before joining the streams. Empty hours, days and months still have a point.
        await using var cmd = Command(conn, tx, """
            WITH slots AS (
              SELECT generate_series(@from AT TIME ZONE 'Asia/Shanghai',
                date_trunc(@grain, LEAST(@now, @until - interval '1 microsecond') AT TIME ZONE 'Asia/Shanghai'),
                ('1 ' || @grain)::interval) AS slot
            ), charges AS (
              SELECT date_trunc(@grain, created_at AT TIME ZONE 'Asia/Shanghai') AS slot, sum(paid_amount) AS receipts
              FROM plugin_kunlun_waterstation.recharge_orders
              WHERE tenant_id=@tid AND created_at >= @from AND created_at < @until GROUP BY 1
            ), orders AS (
              SELECT date_trunc(@grain, o.completed_at AT TIME ZONE 'Asia/Shanghai') AS slot, o.id, o.actual_qty, o.fulfill_mode,
                     COALESCE(o.product_snapshot->>'containerType', p.container_type) AS kind
              FROM plugin_kunlun_waterstation.water_orders o
              LEFT JOIN plugin_kunlun_waterstation.water_products p ON p.tenant_id=o.tenant_id AND p.water_type=o.water_type
              WHERE o.tenant_id=@tid AND o.status='COMPLETED' AND o.completed_at >= @from AND o.completed_at < @until
            ), fulfilled AS (
              SELECT slot, sum(actual_qty) FILTER (WHERE kind='BUCKET') AS buckets, sum(actual_qty) FILTER (WHERE kind='BAG') AS bags,
                     count(*) FILTER (WHERE fulfill_mode='DELIVERY') AS deliveries, count(*) FILTER (WHERE fulfill_mode='PICKUP') AS pickups
              FROM orders GROUP BY slot
            ), redemptions AS (
              SELECT o.slot, sum(a.consumed_buy * b.paid_amount / b.fixed_qty) AS redemption_value
              FROM orders o JOIN plugin_kunlun_waterstation.order_ticket_allocations a ON a.order_id=o.id
              JOIN plugin_kunlun_waterstation.ticket_batches b ON b.id=a.batch_id AND b.tenant_id=@tid
              WHERE a.status='CONSUMED' AND a.consumed_buy > 0 AND b.paid_amount > 0 GROUP BY o.slot
            ), members AS (
              SELECT date_trunc(@grain, created_at AT TIME ZONE 'Asia/Shanghai') AS slot, count(*) AS joined
              FROM plugin_kunlun_waterstation.members
              WHERE tenant_id=@tid AND created_at >= @from AND created_at < @until GROUP BY 1
            )
            SELECT to_char(slot, CASE @grain WHEN 'hour' THEN 'HH24:00' WHEN 'month' THEN 'FMMM"月"' ELSE 'MM/DD' END),
                   COALESCE(receipts,0), COALESCE(buckets,0), COALESCE(bags,0), COALESCE(deliveries,0), COALESCE(pickups,0), COALESCE(joined,0), COALESCE(redemption_value,0)
            FROM slots LEFT JOIN charges USING(slot) LEFT JOIN fulfilled USING(slot) LEFT JOIN members USING(slot)
            LEFT JOIN redemptions USING(slot) ORDER BY slot
            """, ("tid", tid), ("from", from), ("until", until), ("now", now), ("grain", grain));
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        var points = new List<Point>();
        decimal redeemedValue = 0;
        while (await reader.ReadAsync(ct))
        {
            redeemedValue += reader.GetDecimal(7);
            points.Add(new(reader.GetString(0), reader.GetDecimal(1), reader.GetInt64(2), reader.GetInt64(3),
                reader.GetInt64(4), reader.GetInt64(5), reader.GetInt64(6)));
        }
        return new(points, decimal.Round(redeemedValue, 2, MidpointRounding.AwayFromZero));
    }
}
