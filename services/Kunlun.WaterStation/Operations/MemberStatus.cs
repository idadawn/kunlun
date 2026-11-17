using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text.Encodings.Web;
using System.Text.Json;
using Kunlun.WaterStation.Auth;
using Npgsql;
using static Kunlun.WaterStation.Operations.TicketBatches;

namespace Kunlun.WaterStation.Operations;

/// <summary>停用要写原因；重新启用的原因可以不填。</summary>
public sealed record UpdateMemberStatusRequest(string Status, string? Reason = null);

/// <summary>
/// 停用、重新启用和删除会员（「停用和删除会员」权限，默认只给管理员，不随手机端功能开通）。
/// <para>停用：会员端登录和手里的登录凭证马上失效（登录和每次请求本来就只认 ACTIVE）；员工也办不了他的充值、点单、收退押金、退款、
/// 登记领还和补录（都要先锁会员，不是 ACTIVE 一律拒绝）。所以停用前要把没办完的事办完：未完成的水单、待审核的赠送、收押金、
/// 退款和损坏不赔付、待确认的报废。水票、押金和桶袋原样留着、照样算在账上，重新启用后照常用、照常退。</para>
/// <para>删除：只给一条业务记录都没有的会员（建错、重复的档案），连同地址一起删；有记录的只能停用，账上的会员不能凭空消失。</para>
/// 每次停用、启用、删除都写一条 auth_audit_logs，记下是谁、对哪位会员、为什么。
/// </summary>
public static class MemberStatus
{
    public const int ReasonMaxLength = 100;
    // Readable in the database: names and reasons are stored as written, not as \u escapes.
    private static readonly JsonSerializerOptions AuditJson = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    public static async Task EnsureSchema(NpgsqlDataSource db, Guid tid, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var tx = await conn.BeginTransactionAsync(ct);
        await Exec(conn, tx, """
            SELECT pg_advisory_xact_lock(88482026);
            ALTER TABLE plugin_kunlun_waterstation.members ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ;
            ALTER TABLE plugin_kunlun_waterstation.members ADD COLUMN IF NOT EXISTS disabled_by VARCHAR(64);
            ALTER TABLE plugin_kunlun_waterstation.members ADD COLUMN IF NOT EXISTS disable_reason VARCHAR(100);
            -- Administrators hold every permission; the ones from before this permission existed get it here. Permissions are
            -- re-read on every request, so no one has to sign in again.
            UPDATE plugin_kunlun_waterstation.staff SET permissions=permissions || '["kunlun.waterstation:member:manage"]'::jsonb
            WHERE tenant_id=@tid AND role='ADMIN' AND NOT (permissions ? 'kunlun.waterstation:member:manage');
            """, ct, ("tid", tid));
        await tx.CommitAsync(ct);
    }

    public static void MapMemberStatus(this WebApplication app)
    {
        app.MapPatch("/api/members/{mid:guid}/status", SetStatus).RequireAuthorization();
        app.MapDelete("/api/members/{mid:guid}", Delete).RequireAuthorization();
    }

    private static async Task<IResult> SetStatus(Guid mid, UpdateMemberStatusRequest req, ClaimsPrincipal user, NpgsqlDataSource db, KunlunAuthRepository repo, CancellationToken ct)
    {
        if (!user.HasClaim("perm", KunlunPermissions.MemberManage)) return Denied();
        if (req.Status is not ("ACTIVE" or "DISABLED")) return Results.BadRequest(new { error = "会员状态只能是正常或已停用" });
        var disable = req.Status == "DISABLED";
        var reason = req.Reason?.Trim() ?? "";
        if (reason.Length > ReasonMaxLength || disable && reason.Length == 0)
            return Results.BadRequest(new { error = $"请写明停用原因，{ReasonMaxLength} 字以内" });
        var tid = repo.DefaultTenantId;
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var tx = await conn.BeginTransactionAsync(ct);
        // Every business with a member locks this row first, so nothing new can start between the check below and the change.
        var member = await Lock(conn, tx, tid, mid, ct);
        if (member is null) return Results.NotFound(new { error = "会员不存在" });
        if (member.Status != req.Status)
        {
            if (disable)
            {
                var open = await Unfinished(conn, tx, tid, mid, ct);
                if (open.Count > 0)
                    return Results.Conflict(new { error = $"{member.Name}还有 {string.Join("、", open)}，请先办完再停用：停用后这些都办不了" });
                // The token version moves too, so a member app that is open drops its session on the next request.
                await Exec(conn, tx, """
                    UPDATE plugin_kunlun_waterstation.members
                    SET status='DISABLED', disabled_at=now(), disabled_by=@by, disable_reason=@reason, token_version=token_version+1
                    WHERE tenant_id=@tid AND id=@mid
                    """, ct, ("by", Operator(user)), ("reason", reason), ("tid", tid), ("mid", mid));
            }
            else
            {
                await Exec(conn, tx, """
                    UPDATE plugin_kunlun_waterstation.members SET status='ACTIVE', disabled_at=NULL, disabled_by=NULL, disable_reason=NULL
                    WHERE tenant_id=@tid AND id=@mid
                    """, ct, ("tid", tid), ("mid", mid));
            }
            await Audit(conn, tx, tid, user, disable ? "MEMBER_DISABLE" : "MEMBER_ENABLE",
                new { memberId = mid, memberNo = member.MemberNo, name = member.Name, reason = reason.Length > 0 ? reason : null }, ct);
        }
        var result = await Read(conn, tx, tid, mid, ct);
        await tx.CommitAsync(ct);
        return Results.Ok(result);
    }

    private static async Task<IResult> Delete(Guid mid, ClaimsPrincipal user, NpgsqlDataSource db, KunlunAuthRepository repo, CancellationToken ct)
    {
        if (!user.HasClaim("perm", KunlunPermissions.MemberManage)) return Denied();
        var tid = repo.DefaultTenantId;
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var tx = await conn.BeginTransactionAsync(ct);
        var member = await Lock(conn, tx, tid, mid, ct);
        if (member is null) return Results.NotFound(new { error = "会员不存在" });
        var records = await Records(conn, tx, tid, mid, ct);
        if (records.Count > 0)
            return Results.Conflict(new { error = $"{member.Name}已经有 {string.Join("、", records)}，不能删除；不再来了请停用" });
        try
        {
            // Addresses and the empty balance rows go with the member; nothing else refers to a member without records.
            await Exec(conn, tx, """
                DELETE FROM plugin_kunlun_waterstation.member_addresses WHERE tenant_id=@tid AND member_id=@mid;
                DELETE FROM plugin_kunlun_waterstation.member_tickets WHERE tenant_id=@tid AND member_id=@mid;
                DELETE FROM plugin_kunlun_waterstation.member_container_holdings WHERE tenant_id=@tid AND member_id=@mid;
                DELETE FROM plugin_kunlun_waterstation.members WHERE tenant_id=@tid AND id=@mid;
                """, ct, ("tid", tid), ("mid", mid));
        }
        catch (PostgresException e) when (e.SqlState == PostgresErrorCodes.ForeignKeyViolation)
        {
            // A kind of record the check above does not count still refers to the member: refuse the same way.
            return Results.Conflict(new { error = $"{member.Name}已经有业务记录，不能删除；不再来了请停用" });
        }
        await Audit(conn, tx, tid, user, "MEMBER_DELETE", new { memberId = mid, memberNo = member.MemberNo, name = member.Name, phone = member.Phone }, ct);
        await tx.CommitAsync(ct);
        return Results.Ok(new { id = mid, memberNo = member.MemberNo, deleted = true });
    }

    private sealed record Locked(string MemberNo, string Name, string Phone, string Status);

    private static async Task<Locked?> Lock(NpgsqlConnection conn, NpgsqlTransaction tx, Guid tid, Guid mid, CancellationToken ct)
    {
        await using var cmd = Command(conn, tx, "SELECT member_no,name,phone,status FROM plugin_kunlun_waterstation.members WHERE tenant_id=@tid AND id=@mid FOR UPDATE",
            ("tid", tid), ("mid", mid));
        await using var r = await cmd.ExecuteReaderAsync(ct);
        return await r.ReadAsync(ct) ? new Locked(r.GetString(0), r.GetString(1), r.GetString(2), r.GetString(3)) : null;
    }

    /// <summary>What would get stuck once the member is disabled: finishing each of these needs the member active.</summary>
    private static async Task<List<string>> Unfinished(NpgsqlConnection conn, NpgsqlTransaction tx, Guid tid, Guid mid, CancellationToken ct)
    {
        await using var cmd = Command(conn, tx, """
            SELECT (SELECT count(*) FROM plugin_kunlun_waterstation.water_orders WHERE tenant_id=@tid AND member_id=@mid AND status IN ('PENDING','DISPATCHED')),
                   (SELECT count(*) FROM plugin_kunlun_waterstation.refund_requests WHERE tenant_id=@tid AND member_id=@mid AND status='PENDING'),
                   (SELECT count(*) FROM plugin_kunlun_waterstation.container_damages WHERE tenant_id=@tid AND member_id=@mid AND status='PENDING')
            """, ("tid", tid), ("mid", mid));
        await using var r = await cmd.ExecuteReaderAsync(ct);
        await r.ReadAsync(ct);
        var open = new List<string>();
        if (r.GetInt64(0) > 0) open.Add($"{r.GetInt64(0)} 张水单没完成");
        if (r.GetInt64(1) > 0) open.Add($"{r.GetInt64(1)} 笔赠送、收押金、退款或损坏不赔付在等审核");
        if (r.GetInt64(2) > 0) open.Add($"{r.GetInt64(2)} 笔报损待确认报废");
        return open;
    }

    /// <summary>What the member already has on the books; any of it means the member can only be disabled.</summary>
    private static async Task<List<string>> Records(NpgsqlConnection conn, NpgsqlTransaction tx, Guid tid, Guid mid, CancellationToken ct)
    {
        await using var cmd = Command(conn, tx, """
            SELECT (SELECT count(*) FROM plugin_kunlun_waterstation.recharge_orders WHERE tenant_id=@tid AND member_id=@mid),
                   (SELECT count(*) FROM plugin_kunlun_waterstation.water_orders WHERE tenant_id=@tid AND member_id=@mid),
                   (SELECT count(*) FROM plugin_kunlun_waterstation.deposit_lots WHERE tenant_id=@tid AND member_id=@mid),
                   (SELECT count(*) FROM plugin_kunlun_waterstation.container_ledgers WHERE tenant_id=@tid AND member_id=@mid),
                   (SELECT count(*) FROM plugin_kunlun_waterstation.member_opening_entries WHERE tenant_id=@tid AND member_id=@mid),
                   (SELECT count(*) FROM plugin_kunlun_waterstation.refund_requests WHERE tenant_id=@tid AND member_id=@mid)
                     + (SELECT count(*) FROM plugin_kunlun_waterstation.container_damages WHERE tenant_id=@tid AND member_id=@mid),
                   (SELECT count(*) FROM plugin_kunlun_waterstation.ticket_batches WHERE tenant_id=@tid AND member_id=@mid),
                   EXISTS(SELECT 1 FROM plugin_kunlun_waterstation.member_tickets WHERE tenant_id=@tid AND member_id=@mid AND available+reserved>0)
                     OR EXISTS(SELECT 1 FROM plugin_kunlun_waterstation.member_container_holdings WHERE tenant_id=@tid AND member_id=@mid AND quantity>0)
                     OR EXISTS(SELECT 1 FROM plugin_kunlun_waterstation.members WHERE tenant_id=@tid AND id=@mid AND (deposit_amount>0 OR held_buckets+held_bags>0))
            """, ("tid", tid), ("mid", mid));
        await using var r = await cmd.ExecuteReaderAsync(ct);
        await r.ReadAsync(ct);
        var list = new List<string>();
        void Add(int column, string unit) { if (r.GetInt64(column) > 0) list.Add($"{r.GetInt64(column)} {unit}"); }
        Add(0, "笔充值");
        Add(1, "张水单");
        Add(2, "笔押金");
        Add(3, "条桶袋领还记录");
        Add(4, "次补录");
        Add(5, "笔退款或报损");
        // Recharges carry their own ticket batches; batches without one are history balances or packages from before the system.
        if (list.Count == 0) Add(6, "个水票批次");
        if (list.Count == 0 && r.GetBoolean(7)) list.Add("水票、押金或桶袋余额");
        return list;
    }

    private static async Task<object> Read(NpgsqlConnection conn, NpgsqlTransaction tx, Guid tid, Guid mid, CancellationToken ct)
    {
        await using var cmd = Command(conn, tx, "SELECT status,disabled_at,disabled_by,disable_reason FROM plugin_kunlun_waterstation.members WHERE tenant_id=@tid AND id=@mid",
            ("tid", tid), ("mid", mid));
        await using var r = await cmd.ExecuteReaderAsync(ct);
        await r.ReadAsync(ct);
        return new
        {
            id = mid,
            status = r.GetString(0),
            disabledAt = r.IsDBNull(1) ? (DateTime?)null : r.GetDateTime(1),
            disabledBy = r.IsDBNull(2) ? null : r.GetString(2),
            disableReason = r.IsDBNull(3) ? null : r.GetString(3),
        };
    }

    private static string Operator(ClaimsPrincipal user) => user.FindFirstValue("display_name") ?? "员工";

    private static Task<int> Audit(NpgsqlConnection conn, NpgsqlTransaction tx, Guid tid, ClaimsPrincipal user, string action, object detail, CancellationToken ct) =>
        Exec(conn, tx, """
            INSERT INTO plugin_kunlun_waterstation.auth_audit_logs(tenant_id, actor_type, actor_id, actor_name, action, detail)
            VALUES(@tid, 'STAFF', @id, @actor, @action, @detail)
            """, ct, ("tid", tid), ("id", Guid.Parse(user.FindFirstValue(JwtRegisteredClaimNames.Sub)!)), ("actor", Operator(user)),
            ("action", action), ("detail", JsonSerializer.Serialize(detail, AuditJson)));

    private static IResult Denied() =>
        Results.Json(new { error = "需要「停用和删除会员」权限 (kunlun.waterstation:member:manage)" }, statusCode: StatusCodes.Status403Forbidden);
}
