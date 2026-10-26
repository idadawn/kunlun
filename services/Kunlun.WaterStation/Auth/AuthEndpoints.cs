using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text.Json;
using System.Text.RegularExpressions;
using Npgsql;

namespace Kunlun.WaterStation.Auth;

public sealed record CreateStaffRequest(string Name, string Phone, string Username, string Password, string Role);

public static class AuthEndpoints
{
    private static readonly string DummyHash = PasswordHasher.Hash(Guid.NewGuid().ToString());
    public static bool ValidUsername(string? value) => value is not null && Regex.IsMatch(value.Trim(), @"^[A-Za-z0-9][A-Za-z0-9_.-]{2,31}$");
    private static bool ValidPassword(string? value) => value is { Length: >= 8 and <= 128 };
    private static IResult Unauthorized() => Results.Json(new { error = "用户名或密码错误，或账号已停用" }, statusCode: 401);

    public static void MapAuthEndpoints(this WebApplication app)
    {
        app.MapGet("/api/staff", async (ClaimsPrincipal user, NpgsqlDataSource db, KunlunAuthRepository repo, CancellationToken ct) =>
        {
            if (!user.HasClaim("perm", KunlunPermissions.StaffManage)) return Results.Forbid();
            await using var conn = await db.OpenConnectionAsync(ct);
            await using var cmd = new NpgsqlCommand("SELECT id,staff_no,name,phone,username,role,status FROM plugin_kunlun_waterstation.staff WHERE tenant_id=@tid ORDER BY created_at,id", conn);
            cmd.Parameters.AddWithValue("tid", repo.DefaultTenantId);
            var rows = new List<object>();
            await using var r = await cmd.ExecuteReaderAsync(ct);
            while (await r.ReadAsync(ct)) rows.Add(new { id = r.GetGuid(0), staffNo = r.GetString(1), name = r.GetString(2), phone = r.GetString(3), username = r.GetString(4), role = r.GetString(5), status = r.GetString(6) });
            return Results.Ok(rows);
        }).RequireAuthorization();

        app.MapPost("/api/staff", async (CreateStaffRequest req, ClaimsPrincipal user, NpgsqlDataSource db, KunlunAuthRepository repo, CancellationToken ct) =>
        {
            if (!user.HasClaim("perm", KunlunPermissions.StaffManage)) return Results.Forbid();
            if (string.IsNullOrWhiteSpace(req.Name) || req.Name.Length > 64 || !Regex.IsMatch(req.Phone ?? "", @"^1\d{10}$") || !ValidUsername(req.Username) || !ValidPassword(req.Password) || req.Role is not ("ADMIN" or "CLERK" or "COURIER"))
                return Results.BadRequest(new { error = "请填写有效姓名、手机号、用户名、8–128 位密码和角色" });
            var id = Guid.NewGuid();
            var permissions = req.Role == "ADMIN" ? KunlunPermissions.AdminAll : req.Role == "CLERK" ? KunlunPermissions.ClerkDefault : KunlunPermissions.CourierDefault;
            await using var conn = await db.OpenConnectionAsync(ct);
            await using var cmd = new NpgsqlCommand("INSERT INTO plugin_kunlun_waterstation.staff(id,tenant_id,staff_no,name,phone,username,password_hash,role,permissions) VALUES(@id,@tid,@no,@name,@phone,@username,@hash,@role,@perms::jsonb)", conn);
            cmd.Parameters.AddWithValue("id", id); cmd.Parameters.AddWithValue("tid", repo.DefaultTenantId); cmd.Parameters.AddWithValue("no", "YG" + id.ToString("N")[..12]);
            cmd.Parameters.AddWithValue("name", req.Name.Trim()); cmd.Parameters.AddWithValue("phone", req.Phone!); cmd.Parameters.AddWithValue("username", req.Username.Trim().ToLowerInvariant());
            cmd.Parameters.AddWithValue("hash", PasswordHasher.Hash(req.Password)); cmd.Parameters.AddWithValue("role", req.Role); cmd.Parameters.AddWithValue("perms", JsonSerializer.Serialize(permissions));
            try { await cmd.ExecuteNonQueryAsync(ct); }
            catch (PostgresException e) when (e.SqlState == PostgresErrorCodes.UniqueViolation) { return Results.Conflict(new { error = "用户名或手机号已被使用" }); }
            return Results.Ok(new { id });
        }).RequireAuthorization();

        app.MapPost("/api/auth/staff/login", (StaffLoginRequest req, NpgsqlDataSource db, KunlunAuthRepository repo, CancellationToken ct) =>
            Login(req, "STAFF", db, repo, ct)).RequireRateLimiting("login");
        app.MapPost("/api/auth/member/login", (StaffLoginRequest req, NpgsqlDataSource db, KunlunAuthRepository repo, CancellationToken ct) =>
            Login(req, "MEMBER", db, repo, ct)).RequireRateLimiting("login");

        // No phone-only login route: a supplied phone number is not proof of identity.
        app.MapPut("/api/accounts/{subjectType}/{id:guid}/credentials", async (
            string subjectType, Guid id, AccountCredentialsRequest req, ClaimsPrincipal user,
            NpgsqlDataSource db, KunlunAuthRepository repo, CancellationToken ct) =>
        {
            subjectType = subjectType.ToUpperInvariant();
            if (subjectType is not ("STAFF" or "MEMBER")) return Results.BadRequest(new { error = "账号类型无效" });
            var permission = subjectType == "STAFF" ? KunlunPermissions.StaffManage : KunlunPermissions.MemberWrite;
            if (user.FindFirstValue("subject_type") != "STAFF" || !user.HasClaim("perm", permission)) return Results.Forbid();
            if (!ValidUsername(req.Username) || !ValidPassword(req.Password))
                return Results.BadRequest(new { error = "用户名需为 3–32 位字母、数字、点、横线或下划线；密码需为 8–128 位" });
            var table = subjectType == "STAFF" ? "staff" : "members";
            await using var conn = await db.OpenConnectionAsync(ct);
            await using var cmd = new NpgsqlCommand($"UPDATE plugin_kunlun_waterstation.{table} SET username = @u, password_hash = @hash, token_version = token_version + 1 WHERE id = @id AND tenant_id = @tid", conn);
            cmd.Parameters.AddWithValue("u", req.Username.Trim().ToLowerInvariant());
            cmd.Parameters.AddWithValue("hash", PasswordHasher.Hash(req.Password));
            cmd.Parameters.AddWithValue("id", id);
            cmd.Parameters.AddWithValue("tid", repo.DefaultTenantId);
            try
            {
                if (await cmd.ExecuteNonQueryAsync(ct) == 0) return Results.NotFound();
            }
            catch (PostgresException e) when (e.SqlState == PostgresErrorCodes.UniqueViolation)
            { return Results.Conflict(new { error = "该用户名已被使用" }); }
            return Results.Ok(new { username = req.Username.Trim().ToLowerInvariant() });
        }).RequireAuthorization();

        app.MapPost("/api/auth/logout", async (ClaimsPrincipal user, NpgsqlDataSource db, CancellationToken ct) =>
        {
            var table = user.FindFirstValue("subject_type") == "STAFF" ? "staff" : "members";
            await using var conn = await db.OpenConnectionAsync(ct);
            await using var cmd = new NpgsqlCommand($"UPDATE plugin_kunlun_waterstation.{table} SET token_version = token_version + 1 WHERE id = @id AND tenant_id = @tid", conn);
            cmd.Parameters.AddWithValue("id", Guid.Parse(user.FindFirstValue(JwtRegisteredClaimNames.Sub)!));
            cmd.Parameters.AddWithValue("tid", Guid.Parse(user.FindFirstValue("tenant_id")!));
            await cmd.ExecuteNonQueryAsync(ct);
            return Results.Ok(new { loggedOut = true });
        }).RequireAuthorization();

        app.MapPost("/api/auth/change-password", async (ChangePasswordRequest req, ClaimsPrincipal user, NpgsqlDataSource db, CancellationToken ct) =>
        {
            if (!ValidPassword(req.NewPassword)) return Results.BadRequest(new { error = "新密码需为 8–128 位" });
            var table = user.FindFirstValue("subject_type") == "STAFF" ? "staff" : "members";
            await using var conn = await db.OpenConnectionAsync(ct);
            await using var tx = await conn.BeginTransactionAsync(ct);
            var id = Guid.Parse(user.FindFirstValue(JwtRegisteredClaimNames.Sub)!);
            var tid = Guid.Parse(user.FindFirstValue("tenant_id")!);
            await using var read = new NpgsqlCommand($"SELECT password_hash, token_version FROM plugin_kunlun_waterstation.{table} WHERE id = @id AND tenant_id = @tid FOR UPDATE", conn, tx);
            read.Parameters.AddWithValue("id", id); read.Parameters.AddWithValue("tid", tid);
            await using var r = await read.ExecuteReaderAsync(ct);
            if (!await r.ReadAsync(ct) || !PasswordHasher.Verify(req.CurrentPassword, r.IsDBNull(0) ? null : r.GetString(0))
                || r.GetInt32(1).ToString() != user.FindFirstValue("token_version")) return Unauthorized();
            await r.CloseAsync();
            await using var update = new NpgsqlCommand($"UPDATE plugin_kunlun_waterstation.{table} SET password_hash = @hash, token_version = token_version + 1 WHERE id = @id AND tenant_id = @tid", conn, tx);
            update.Parameters.AddWithValue("hash", PasswordHasher.Hash(req.NewPassword));
            update.Parameters.AddWithValue("id", id); update.Parameters.AddWithValue("tid", tid);
            await update.ExecuteNonQueryAsync(ct);
            await tx.CommitAsync(ct);
            return Results.Ok(new { changed = true });
        }).RequireAuthorization();
    }

    private static async Task<IResult> Login(StaffLoginRequest req, string type, NpgsqlDataSource db, KunlunAuthRepository repo, CancellationToken ct)
    {
        if (!ValidUsername(req.Account) || req.Password is not { Length: > 0 and <= 128 }) return Unauthorized();
        var table = type == "STAFF" ? "staff" : "members";
        var fields = type == "STAFF" ? "staff_no, role, permissions::text" : "member_no, 'MEMBER', '[]'";
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = new NpgsqlCommand($"SELECT id, name, phone, password_hash, status, token_version, {fields} FROM plugin_kunlun_waterstation.{table} WHERE tenant_id = @tid AND lower(username) = @u", conn);
        cmd.Parameters.AddWithValue("tid", repo.DefaultTenantId);
        cmd.Parameters.AddWithValue("u", req.Account.Trim().ToLowerInvariant());
        await using var r = await cmd.ExecuteReaderAsync(ct);
        if (!await r.ReadAsync(ct)) { PasswordHasher.Verify(req.Password, DummyHash); return Unauthorized(); }
        if (!PasswordHasher.Verify(req.Password, r.IsDBNull(3) ? DummyHash : r.GetString(3)) || r.GetString(4) != "ACTIVE") return Unauthorized();
        var id = r.GetGuid(0); var name = r.GetString(1); var phone = r.GetString(2);
        var version = r.GetInt32(5); var code = r.GetString(6); var role = r.GetString(7);
        var permissions = JsonSerializer.Deserialize<string[]>(r.GetString(8)) ?? [];
        if (req.RequireAdmin && role != "ADMIN") return Results.Json(new { error = "管理后台仅限管理员登录" }, statusCode: 403);
        await r.CloseAsync();
        await using var audit = new NpgsqlCommand("INSERT INTO plugin_kunlun_waterstation.auth_audit_logs (tenant_id, actor_type, actor_id, actor_name, action) VALUES (@tid, @type, @id, @name, 'PASSWORD_LOGIN')", conn);
        audit.Parameters.AddWithValue("tid", repo.DefaultTenantId); audit.Parameters.AddWithValue("type", type);
        audit.Parameters.AddWithValue("id", id); audit.Parameters.AddWithValue("name", name);
        await audit.ExecuteNonQueryAsync(ct);
        return Results.Ok(new AuthTokenResponse(repo.IssueJwt(type, id, name, code, phone, role, permissions, version), type, id, name, code, phone, role, permissions, version));
    }
}
