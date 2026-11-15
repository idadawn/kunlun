using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text.Json;
using Npgsql;
using static Kunlun.WaterStation.Auth.KunlunPermissions;

namespace Kunlun.WaterStation.Auth;

public sealed record SaveRoleMobileRequest(string[]? Features);

/// <summary>
/// 员工手机端按角色开通的功能（`packages/shared/src/mobile.ts` 是同一份目录的界面说明）。
/// 店员、送水员的权限码就是已开通功能所需权限的并集：保存时写回该角色全部员工，下一次请求即生效；
/// 管理员在后台始终拥有全部权限，这里只决定手机首页显示哪些功能。
/// </summary>
public static class MobileFeatures
{
    /// <summary>Feature key → permissions it grants, in the order the console lists features.</summary>
    public static readonly (string Key, string[] Permissions)[] Catalog =
    [
        ("order", [MemberRead, OrderCreate, OrderFulfill, DepositCollect]),
        ("orders", [MemberRead, OrderAccept, OrderFulfill, DepositCollect]),
        ("pickup", [PickupVerify, OrderFulfill]),
        ("members", [MemberRead]),
        ("newMember", [MemberRead, MemberWrite]),
        ("recharge", [MemberRead, RechargeCreate]),
        ("depositCollect", [MemberRead, DepositCollect]),
        ("depositRefund", [MemberRead, DepositRefundApply]),
        ("movement", [MemberRead, ContainerRegister]),
        ("inventory", [ContainerInventoryManage]),
        ("overview", [ReportExport]),
    ];

    public static readonly string[] Roles = ["CLERK", "COURIER", "ADMIN"];

    private static readonly Dictionary<string, string[]> ByKey = Catalog.ToDictionary(f => f.Key, f => f.Permissions);

    /// <summary>
    /// Starting features of each role. A clerk's grant exactly the original clerk permissions; a courier's add only
    /// 自提核销 and 登记领还, which couriers could already do through order fulfilment.
    /// </summary>
    public static string[] Defaults(string role) => role switch
    {
        "ADMIN" => ["overview", "order", "orders", "members", "inventory", "recharge", "depositCollect", "depositRefund", "pickup", "movement", "newMember"],
        "CLERK" => ["order", "orders", "members", "recharge", "depositCollect", "depositRefund", "pickup", "movement", "newMember"],
        "COURIER" => ["orders", "members", "pickup", "depositCollect", "movement"],
        _ => []
    };

    /// <summary>What accounts with this role hold: everything for an administrator, else the union of the features' permissions.</summary>
    public static string[] PermissionsFor(string role, IEnumerable<string> features)
    {
        if (role == "ADMIN") return AdminAll;
        var granted = features.SelectMany(f => ByKey.TryGetValue(f, out var p) ? p : []).ToHashSet();
        return AdminAll.Where(granted.Contains).ToArray();
    }

    public static async Task EnsureSchema(NpgsqlDataSource db, Guid tenantId, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var tx = await conn.BeginTransactionAsync(ct);
        await using (var ddl = new NpgsqlCommand("""
            SELECT pg_advisory_xact_lock(hashtextextended('kunlun:role-mobile-configs',0));
            CREATE TABLE IF NOT EXISTS plugin_kunlun_waterstation.role_mobile_configs (
                tenant_id UUID NOT NULL,
                role VARCHAR(24) NOT NULL,
                features JSONB NOT NULL DEFAULT '[]'::jsonb,
                updated_by VARCHAR(64),
                updated_at TIMESTAMPTZ,
                PRIMARY KEY (tenant_id, role)
            );
            """, conn, tx)) await ddl.ExecuteNonQueryAsync(ct);
        foreach (var role in Roles)
        {
            var features = Defaults(role);
            await using var insert = new NpgsqlCommand("""
                INSERT INTO plugin_kunlun_waterstation.role_mobile_configs(tenant_id, role, features)
                VALUES(@tid, @role, @features::jsonb) ON CONFLICT DO NOTHING
                """, conn, tx);
            insert.Parameters.AddWithValue("tid", tenantId);
            insert.Parameters.AddWithValue("role", role);
            insert.Parameters.AddWithValue("features", JsonSerializer.Serialize(features));
            // The first start with this table makes the role's accounts hold exactly what its features grant.
            if (await insert.ExecuteNonQueryAsync(ct) == 1 && role != "ADMIN")
                await ApplyPermissions(conn, tx, tenantId, role, PermissionsFor(role, features), ct);
        }
        await tx.CommitAsync(ct);
    }

    /// <summary>The role's saved features, known keys only; the defaults when nothing is saved.</summary>
    public static async Task<string[]> ForRole(NpgsqlConnection conn, NpgsqlTransaction? tx, Guid tenantId, string role, CancellationToken ct)
    {
        await using var cmd = new NpgsqlCommand("SELECT features::text FROM plugin_kunlun_waterstation.role_mobile_configs WHERE tenant_id=@tid AND role=@role", conn, tx);
        cmd.Parameters.AddWithValue("tid", tenantId);
        cmd.Parameters.AddWithValue("role", role);
        var saved = await cmd.ExecuteScalarAsync(ct) as string;
        var features = saved is null ? Defaults(role) : JsonSerializer.Deserialize<string[]>(saved) ?? [];
        return features.Where(ByKey.ContainsKey).Distinct().ToArray();
    }

    /// <summary>Serialises saving a role's features with creating accounts, so a new account never misses a change.</summary>
    public static async Task LockRoles(NpgsqlConnection conn, NpgsqlTransaction tx, Guid tenantId, CancellationToken ct)
    {
        await using var cmd = new NpgsqlCommand("SELECT pg_advisory_xact_lock(hashtextextended(@key,0))", conn, tx);
        cmd.Parameters.AddWithValue("key", $"{tenantId}:role-mobile-configs");
        await cmd.ExecuteNonQueryAsync(ct);
    }

    private static async Task ApplyPermissions(NpgsqlConnection conn, NpgsqlTransaction tx, Guid tenantId, string role, string[] permissions, CancellationToken ct)
    {
        await using var cmd = new NpgsqlCommand("UPDATE plugin_kunlun_waterstation.staff SET permissions=@perms::jsonb WHERE tenant_id=@tid AND role=@role", conn, tx);
        cmd.Parameters.AddWithValue("perms", JsonSerializer.Serialize(permissions));
        cmd.Parameters.AddWithValue("tid", tenantId);
        cmd.Parameters.AddWithValue("role", role);
        await cmd.ExecuteNonQueryAsync(ct);
    }

    private static async Task<object> Describe(NpgsqlConnection conn, NpgsqlTransaction? tx, Guid tenantId, string role, CancellationToken ct)
    {
        var features = await ForRole(conn, tx, tenantId, role, ct);
        await using var cmd = new NpgsqlCommand("""
            SELECT c.updated_by, c.updated_at,
                   (SELECT count(*) FROM plugin_kunlun_waterstation.staff s WHERE s.tenant_id=@tid AND s.role=@role)
            FROM (SELECT 1) one
            LEFT JOIN plugin_kunlun_waterstation.role_mobile_configs c ON c.tenant_id=@tid AND c.role=@role
            """, conn, tx);
        cmd.Parameters.AddWithValue("tid", tenantId);
        cmd.Parameters.AddWithValue("role", role);
        await using var r = await cmd.ExecuteReaderAsync(ct);
        await r.ReadAsync(ct);
        return new
        {
            role,
            features,
            permissions = PermissionsFor(role, features),
            defaults = Defaults(role),
            staffCount = r.GetInt64(2),
            updatedBy = r.IsDBNull(0) ? null : r.GetString(0),
            updatedAt = r.IsDBNull(1) ? (DateTime?)null : r.GetDateTime(1)
        };
    }

    private static bool CanManage(ClaimsPrincipal user) =>
        user.FindFirstValue("subject_type") == "STAFF" && user.HasClaim("perm", StaffManage);

    public static void MapMobileFeatures(this WebApplication app)
    {
        app.MapGet("/api/mobile/roles", async (ClaimsPrincipal user, NpgsqlDataSource db, KunlunAuthRepository repo, CancellationToken ct) =>
        {
            if (!CanManage(user)) return Results.Json(new { error = "只有管理员能设置手机端功能" }, statusCode: StatusCodes.Status403Forbidden);
            await using var conn = await db.OpenConnectionAsync(ct);
            var roles = new List<object>();
            foreach (var role in Roles) roles.Add(await Describe(conn, null, repo.DefaultTenantId, role, ct));
            return Results.Ok(new { catalog = Catalog.Select(f => new { key = f.Key, permissions = f.Permissions }), roles });
        }).RequireAuthorization();

        app.MapPut("/api/mobile/roles/{role}", async (string role, SaveRoleMobileRequest req, ClaimsPrincipal user, NpgsqlDataSource db, KunlunAuthRepository repo, CancellationToken ct) =>
        {
            if (!CanManage(user)) return Results.Json(new { error = "只有管理员能设置手机端功能" }, statusCode: StatusCodes.Status403Forbidden);
            role = role.ToUpperInvariant();
            if (!Roles.Contains(role)) return Results.BadRequest(new { error = "角色无效" });
            var features = req.Features ?? [];
            if (features.Any(f => !ByKey.ContainsKey(f))) return Results.BadRequest(new { error = "包含不存在的手机端功能" });
            if (features.Distinct().Count() != features.Length) return Results.BadRequest(new { error = "手机端功能不能重复" });

            var tid = repo.DefaultTenantId;
            var actor = user.FindFirstValue("display_name") ?? "管理员";
            await using var conn = await db.OpenConnectionAsync(ct);
            await using var tx = await conn.BeginTransactionAsync(ct);
            await LockRoles(conn, tx, tid, ct);
            await using (var save = new NpgsqlCommand("""
                INSERT INTO plugin_kunlun_waterstation.role_mobile_configs(tenant_id, role, features, updated_by, updated_at)
                VALUES(@tid, @role, @features::jsonb, @actor, now())
                ON CONFLICT (tenant_id, role) DO UPDATE SET features=EXCLUDED.features, updated_by=EXCLUDED.updated_by, updated_at=EXCLUDED.updated_at
                """, conn, tx))
            {
                save.Parameters.AddWithValue("tid", tid);
                save.Parameters.AddWithValue("role", role);
                save.Parameters.AddWithValue("features", JsonSerializer.Serialize(features));
                save.Parameters.AddWithValue("actor", actor);
                await save.ExecuteNonQueryAsync(ct);
            }
            // Clerks and couriers work only on the phone, so what the role can do there is what its accounts may do.
            if (role != "ADMIN") await ApplyPermissions(conn, tx, tid, role, PermissionsFor(role, features), ct);
            await using (var audit = new NpgsqlCommand("""
                INSERT INTO plugin_kunlun_waterstation.auth_audit_logs(tenant_id, actor_type, actor_id, actor_name, action, detail)
                VALUES(@tid, 'STAFF', @id, @actor, 'MOBILE_FEATURES', @detail)
                """, conn, tx))
            {
                audit.Parameters.AddWithValue("tid", tid);
                audit.Parameters.AddWithValue("id", Guid.Parse(user.FindFirstValue(JwtRegisteredClaimNames.Sub)!));
                audit.Parameters.AddWithValue("actor", actor);
                audit.Parameters.AddWithValue("detail", $"{role}: {string.Join(",", features)}");
                await audit.ExecuteNonQueryAsync(ct);
            }
            var result = await Describe(conn, tx, tid, role, ct);
            await tx.CommitAsync(ct);
            return Results.Ok(result);
        }).RequireAuthorization();
    }
}
