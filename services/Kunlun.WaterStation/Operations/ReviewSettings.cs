using System.Security.Claims;
using Kunlun.WaterStation.Auth;
using Npgsql;
using static Kunlun.WaterStation.Operations.TicketBatches;

namespace Kunlun.WaterStation.Operations;

public sealed record SaveReviewSettingsRequest(bool GiftReview, bool RefundReview);

/// <summary>
/// 审核开关，管理员在管理端「审核」页设置：店员充值时手动赠送的水票、店员办理的退押金和退水费，要不要管理员审核。
/// 默认都要审核；关掉后店员当场办完。管理员自己办理时总是直接生效。不管开不开，每笔业务都留有记录。
/// </summary>
public static class ReviewSettings
{
    public sealed record Values(bool GiftReview, bool RefundReview);

    public static async Task EnsureSchema(NpgsqlDataSource db, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var tx = await conn.BeginTransactionAsync(ct);
        await Exec(conn, tx, """
            SELECT pg_advisory_xact_lock(88482026);
            CREATE TABLE IF NOT EXISTS plugin_kunlun_waterstation.review_settings(
              tenant_id UUID PRIMARY KEY,
              gift_review BOOLEAN NOT NULL DEFAULT TRUE,
              refund_review BOOLEAN NOT NULL DEFAULT TRUE,
              updated_by VARCHAR(64) NOT NULL DEFAULT '',
              updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
            );
            """, ct);
        await tx.CommitAsync(ct);
    }

    /// <summary>The switches in force; a station that never saved them reviews both.</summary>
    public static async Task<Values> Read(NpgsqlConnection conn, NpgsqlTransaction? tx, Guid tid, CancellationToken ct)
    {
        await using var cmd = Command(conn, tx, "SELECT gift_review, refund_review FROM plugin_kunlun_waterstation.review_settings WHERE tenant_id=@tid", ("tid", tid));
        await using var r = await cmd.ExecuteReaderAsync(ct);
        return await r.ReadAsync(ct) ? new Values(r.GetBoolean(0), r.GetBoolean(1)) : new Values(true, true);
    }

    public static void MapReviewSettings(this WebApplication app)
    {
        // Every staff dialog reads these to say whether a gift or refund takes effect now or waits for review.
        app.MapGet("/api/settings/review", async (ClaimsPrincipal user, NpgsqlDataSource db, KunlunAuthRepository repo, CancellationToken ct) =>
        {
            if (user.FindFirstValue("subject_type") != "STAFF") return Results.Forbid();
            await using var conn = await db.OpenConnectionAsync(ct);
            return Results.Ok(await Describe(conn, repo.DefaultTenantId, ct));
        }).RequireAuthorization();

        app.MapPut("/api/settings/review", async (SaveReviewSettingsRequest req, ClaimsPrincipal user, NpgsqlDataSource db, KunlunAuthRepository repo, CancellationToken ct) =>
        {
            if (user.FindFirstValue("subject_type") != "STAFF" || !user.HasClaim("perm", KunlunPermissions.StaffManage))
                return Results.Json(new { error = "只有管理员能修改审核设置" }, statusCode: StatusCodes.Status403Forbidden);
            await using var conn = await db.OpenConnectionAsync(ct);
            await Exec(conn, null, """
                INSERT INTO plugin_kunlun_waterstation.review_settings(tenant_id,gift_review,refund_review,updated_by,updated_at)
                VALUES(@tid,@gift,@refund,@actor,now())
                ON CONFLICT (tenant_id) DO UPDATE SET gift_review=@gift,refund_review=@refund,updated_by=@actor,updated_at=now()
                """, ct, ("tid", repo.DefaultTenantId), ("gift", req.GiftReview), ("refund", req.RefundReview), ("actor", user.FindFirstValue("display_name") ?? "管理员"));
            return Results.Ok(await Describe(conn, repo.DefaultTenantId, ct));
        }).RequireAuthorization();
    }

    private static async Task<object> Describe(NpgsqlConnection conn, Guid tid, CancellationToken ct)
    {
        await using var cmd = Command(conn, null, "SELECT gift_review, refund_review, updated_by, updated_at FROM plugin_kunlun_waterstation.review_settings WHERE tenant_id=@tid", ("tid", tid));
        await using var r = await cmd.ExecuteReaderAsync(ct);
        if (!await r.ReadAsync(ct)) return new { giftReview = true, refundReview = true, updatedBy = (string?)null, updatedAt = (DateTime?)null };
        return new { giftReview = r.GetBoolean(0), refundReview = r.GetBoolean(1), updatedBy = (string?)r.GetString(2), updatedAt = (DateTime?)r.GetDateTime(3) };
    }
}
