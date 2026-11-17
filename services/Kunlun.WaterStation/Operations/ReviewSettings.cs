using System.Security.Claims;
using Kunlun.WaterStation.Auth;
using Npgsql;
using static Kunlun.WaterStation.Operations.TicketBatches;

namespace Kunlun.WaterStation.Operations;

// DepositReview / DamageReview left out (older admin pages) keep their current values.
public sealed record SaveReviewSettingsRequest(bool GiftReview, bool RefundReview, bool? DepositReview = null, bool? DamageReview = null);

/// <summary>
/// 审核开关，管理员在管理端「审核」页设置：充值时手动赠送的水票、店员办理的退押金和退水费、员工收的押金、交付时登记的损坏不赔付，
/// 要不要管理员审核。默认都要审核；关掉后当场办完。赠送、收押金和损坏不赔付不分谁办的都要批准（门店共用一个管理员账号），
/// 管理员自己办理的退款直接生效。不管开不开，每笔业务都留有记录。
/// </summary>
public static class ReviewSettings
{
    public sealed record Values(bool GiftReview, bool RefundReview, bool DepositReview, bool DamageReview);

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
            ALTER TABLE plugin_kunlun_waterstation.review_settings ADD COLUMN IF NOT EXISTS deposit_review BOOLEAN NOT NULL DEFAULT TRUE;
            ALTER TABLE plugin_kunlun_waterstation.review_settings ADD COLUMN IF NOT EXISTS damage_review BOOLEAN NOT NULL DEFAULT TRUE;
            """, ct);
        await tx.CommitAsync(ct);
    }

    /// <summary>The switches in force; a station that never saved them reviews everything.</summary>
    public static async Task<Values> Read(NpgsqlConnection conn, NpgsqlTransaction? tx, Guid tid, CancellationToken ct)
    {
        await using var cmd = Command(conn, tx, "SELECT gift_review, refund_review, deposit_review, damage_review FROM plugin_kunlun_waterstation.review_settings WHERE tenant_id=@tid", ("tid", tid));
        await using var r = await cmd.ExecuteReaderAsync(ct);
        return await r.ReadAsync(ct) ? new Values(r.GetBoolean(0), r.GetBoolean(1), r.GetBoolean(2), r.GetBoolean(3)) : new Values(true, true, true, true);
    }

    public static void MapReviewSettings(this WebApplication app)
    {
        // Every staff dialog reads these to say whether a gift, refund, deposit or damage waiver takes effect now or waits for review.
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
                INSERT INTO plugin_kunlun_waterstation.review_settings(tenant_id,gift_review,refund_review,deposit_review,damage_review,updated_by,updated_at)
                VALUES(@tid,@gift,@refund,COALESCE(@deposit::boolean,TRUE),COALESCE(@damage::boolean,TRUE),@actor,now())
                ON CONFLICT (tenant_id) DO UPDATE SET gift_review=@gift,refund_review=@refund,
                  deposit_review=COALESCE(@deposit::boolean,review_settings.deposit_review),damage_review=COALESCE(@damage::boolean,review_settings.damage_review),
                  updated_by=@actor,updated_at=now()
                """, ct, ("tid", repo.DefaultTenantId), ("gift", req.GiftReview), ("refund", req.RefundReview),
                ("deposit", (object?)req.DepositReview ?? DBNull.Value), ("damage", (object?)req.DamageReview ?? DBNull.Value),
                ("actor", user.FindFirstValue("display_name") ?? "管理员"));
            return Results.Ok(await Describe(conn, repo.DefaultTenantId, ct));
        }).RequireAuthorization();
    }

    private static async Task<object> Describe(NpgsqlConnection conn, Guid tid, CancellationToken ct)
    {
        await using var cmd = Command(conn, null, "SELECT gift_review, refund_review, deposit_review, damage_review, updated_by, updated_at FROM plugin_kunlun_waterstation.review_settings WHERE tenant_id=@tid", ("tid", tid));
        await using var r = await cmd.ExecuteReaderAsync(ct);
        if (!await r.ReadAsync(ct)) return new { giftReview = true, refundReview = true, depositReview = true, damageReview = true, updatedBy = (string?)null, updatedAt = (DateTime?)null };
        return new
        {
            giftReview = r.GetBoolean(0), refundReview = r.GetBoolean(1), depositReview = r.GetBoolean(2), damageReview = r.GetBoolean(3),
            updatedBy = (string?)r.GetString(4), updatedAt = (DateTime?)r.GetDateTime(5)
        };
    }
}
