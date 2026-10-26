using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.IdentityModel.Tokens;
using Npgsql;

namespace Kunlun.WaterStation.Auth;

public static class KunlunPermissions
{
    public const string MemberRead = "kunlun.waterstation:member:read";
    public const string MemberWrite = "kunlun.waterstation:member:write";
    public const string RechargeRefund = "kunlun.waterstation:recharge:refund";
    public const string RechargeCreate = "kunlun.waterstation:recharge:create";
    public const string DepositCollect = "kunlun.waterstation:deposit:collect";
    public const string DepositRefundApply = "kunlun.waterstation:deposit:refund_apply";
    public const string DepositRefundApprove = "kunlun.waterstation:deposit:refund_approve";
    public const string OrderCreate = "kunlun.waterstation:order:create";
    public const string OrderAccept = "kunlun.waterstation:order:accept";
    public const string OrderFulfill = "kunlun.waterstation:order:fulfill";
    public const string PickupVerify = "kunlun.waterstation:pickup:verify";
    public const string ContainerRegister = "kunlun.waterstation:container:register";
    public const string PlanManage = "kunlun.waterstation:plan:manage";
    public const string ReportExport = "kunlun.waterstation:report:export";
    public const string StaffManage = "kunlun.waterstation:staff:manage";

    public static readonly string[] AdminAll =
    [
        MemberRead, MemberWrite, RechargeCreate, RechargeRefund, DepositCollect,
        DepositRefundApply, DepositRefundApprove, OrderCreate, OrderAccept,
        OrderFulfill, PickupVerify, ContainerRegister, PlanManage, ReportExport, StaffManage
    ];

    public static readonly string[] ClerkDefault =
    [
        MemberRead, MemberWrite, RechargeCreate, DepositCollect,
        DepositRefundApply, OrderCreate, OrderAccept, OrderFulfill,
        PickupVerify, ContainerRegister
    ];

    public static readonly string[] CourierDefault =
    [
        MemberRead, OrderAccept, OrderFulfill, DepositCollect
    ];
}

public sealed record StaffLoginRequest(string Account, string Password, bool RequireAdmin = false);
public sealed record AccountCredentialsRequest(string Username, string Password);
public sealed record ChangePasswordRequest(string CurrentPassword, string NewPassword);
public sealed record UpdateStaffStatusRequest(string Status);

public sealed record AuthTokenResponse(
    string AccessToken,
    string SubjectType,
    Guid SubjectId,
    string DisplayName,
    string CodeOrNo,
    string Phone,
    string Role,
    string[] Permissions,
    int TokenVersion,
    bool IsNewMember = false);

public static class PasswordHasher
{
    private const int Iterations = 600_000;
    public static string Hash(string password)
    {
        var salt = RandomNumberGenerator.GetBytes(16);
        var hash = Rfc2898DeriveBytes.Pbkdf2(password, salt, Iterations, HashAlgorithmName.SHA256, 32);
        return $"v2.{Convert.ToBase64String(salt)}.{Convert.ToBase64String(hash)}";
    }
    public static bool Verify(string? password, string? stored)
    {
        if (string.IsNullOrEmpty(password) || password.Length > 128 || string.IsNullOrEmpty(stored)) return false;
        try
        {
            var parts = stored.Split('.');
            var modern = parts.Length == 3 && parts[0] == "v2";
            if (!modern && parts.Length != 2) return false;
            var salt = Convert.FromBase64String(parts[modern ? 1 : 0]);
            var expected = Convert.FromBase64String(parts[modern ? 2 : 1]);
            if (salt.Length != 16 || expected.Length != 32) return false;
            var actual = Rfc2898DeriveBytes.Pbkdf2(password, salt, modern ? Iterations : 60_000, HashAlgorithmName.SHA256, 32);
            return CryptographicOperations.FixedTimeEquals(expected, actual);
        }
        catch (FormatException) { return false; }
    }
}

public sealed class KunlunAuthRepository(NpgsqlDataSource dataSource, IConfiguration config)
{
    public Guid DefaultTenantId =>
        Guid.TryParse(config["Kunlun:DefaultTenantId"], out var id)
            ? id
            : Guid.Parse("00000000-0000-0000-0000-000000000001");

    public async Task EnsureSchemaAndSeedAsync(CancellationToken ct = default)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        await using var tx = await conn.BeginTransactionAsync(ct);

        const string ddl = """
            SELECT pg_advisory_xact_lock(88482026);
            CREATE SCHEMA IF NOT EXISTS plugin_kunlun_waterstation;
            SET search_path TO plugin_kunlun_waterstation, public;

            CREATE TABLE IF NOT EXISTS staff (
                id UUID PRIMARY KEY,
                tenant_id UUID NOT NULL,
                staff_no VARCHAR(32) NOT NULL,
                name VARCHAR(64) NOT NULL,
                phone VARCHAR(20) NOT NULL,
                password_hash TEXT NOT NULL,
                role VARCHAR(24) NOT NULL,
                permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
                status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
                token_version INT NOT NULL DEFAULT 1,
                wx_openid VARCHAR(64),
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE (tenant_id, staff_no),
                UNIQUE (tenant_id, phone)
            );

            CREATE TABLE IF NOT EXISTS members (
                id UUID PRIMARY KEY,
                tenant_id UUID NOT NULL,
                member_no VARCHAR(32) NOT NULL,
                name VARCHAR(64) NOT NULL,
                phone VARCHAR(20) NOT NULL,
                wx_openid VARCHAR(64),
                default_address TEXT,
                bucket_delivery_tickets INT NOT NULL DEFAULT 0 CHECK (bucket_delivery_tickets >= 0),
                bucket_pickup_tickets INT NOT NULL DEFAULT 0 CHECK (bucket_pickup_tickets >= 0),
                bag_pickup_tickets INT NOT NULL DEFAULT 0 CHECK (bag_pickup_tickets >= 0),
                bag_delivery_tickets INT NOT NULL DEFAULT 0 CHECK (bag_delivery_tickets >= 0),
                deposit_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00,
                held_buckets INT NOT NULL DEFAULT 0,
                held_bags INT NOT NULL DEFAULT 0,
                status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
                source VARCHAR(24) NOT NULL DEFAULT 'STAFF_CREATED',
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE (tenant_id, member_no),
                UNIQUE (tenant_id, phone)
            );

            ALTER TABLE staff ADD COLUMN IF NOT EXISTS username VARCHAR(32);
            UPDATE staff SET username = lower(staff_no) WHERE username IS NULL;
            CREATE UNIQUE INDEX IF NOT EXISTS staff_username ON staff (tenant_id, lower(username));
            ALTER TABLE members ADD COLUMN IF NOT EXISTS username VARCHAR(32);
            ALTER TABLE members ADD COLUMN IF NOT EXISTS password_hash TEXT;
            ALTER TABLE members ADD COLUMN IF NOT EXISTS token_version INT NOT NULL DEFAULT 1;
            CREATE UNIQUE INDEX IF NOT EXISTS member_username ON members (tenant_id, lower(username));

            CREATE TABLE IF NOT EXISTS auth_audit_logs (
                id BIGSERIAL PRIMARY KEY,
                tenant_id UUID NOT NULL,
                actor_type VARCHAR(16) NOT NULL,
                actor_id UUID NOT NULL,
                actor_name VARCHAR(64) NOT NULL,
                action VARCHAR(48) NOT NULL,
                detail TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
            """;

        await using (var cmd = new NpgsqlCommand(ddl, conn, tx))
        {
            await cmd.ExecuteNonQueryAsync(ct);
        }

        if (!config.GetValue<bool>("Kunlun:SeedDemoData"))
        {
            var username = config["Kunlun:Bootstrap:Username"];
            var password = config["Kunlun:Bootstrap:Password"];
            if (!string.IsNullOrEmpty(username) && !string.IsNullOrEmpty(password))
            {
                if (!AuthEndpoints.ValidUsername(username) || password.Length < 12 || password.Length > 128)
                    throw new InvalidOperationException("Bootstrap requires a valid username and a 12-128 character password.");
                await using var bootstrap = new NpgsqlCommand("""
                    INSERT INTO plugin_kunlun_waterstation.staff
                      (id, tenant_id, staff_no, username, name, phone, password_hash, role, permissions)
                    SELECT @id, @tid, @u, @u, '水站管理员', '', @hash, 'ADMIN', @perms::jsonb
                    WHERE NOT EXISTS (SELECT 1 FROM plugin_kunlun_waterstation.staff WHERE tenant_id = @tid)
                    """, conn, tx);
                bootstrap.Parameters.AddWithValue("id", Guid.NewGuid());
                bootstrap.Parameters.AddWithValue("tid", DefaultTenantId);
                bootstrap.Parameters.AddWithValue("u", username.Trim().ToLowerInvariant());
                bootstrap.Parameters.AddWithValue("hash", PasswordHasher.Hash(password));
                bootstrap.Parameters.AddWithValue("perms", JsonSerializer.Serialize(KunlunPermissions.AdminAll));
                await bootstrap.ExecuteNonQueryAsync(ct);
            }
            await tx.CommitAsync(ct);
            return;
        }

        // Seed 3 default staff (林站长 ADMIN, 小林 CLERK, 王师傅 COURIER)
        var staffSeeds = new[]
        {
            (Id: Guid.Parse("10000000-0000-0000-0000-000000000001"), No: "YG0001", Name: "林站长", Phone: "13800000001", Role: "ADMIN", Perms: KunlunPermissions.AdminAll),
            (Id: Guid.Parse("10000000-0000-0000-0000-000000000012"), No: "YG0012", Name: "林晓峰（小林）", Phone: "13800000012", Role: "CLERK", Perms: KunlunPermissions.ClerkDefault),
            (Id: Guid.Parse("10000000-0000-0000-0000-000000000008"), No: "YG0008", Name: "王建国（王师傅）", Phone: "13800000008", Role: "COURIER", Perms: KunlunPermissions.CourierDefault)
        };

        var defaultPwdHash = PasswordHasher.Hash(config["Kunlun:SeedPassword"] ?? throw new InvalidOperationException("SeedPassword is required for demo data."));
        foreach (var s in staffSeeds)
        {
            const string upsertStaff = """
                INSERT INTO plugin_kunlun_waterstation.staff
                    (id, tenant_id, staff_no, username, name, phone, password_hash, role, permissions, status, token_version)
                VALUES
                    (@id, @tid, @no, lower(@no), @name, @phone, @pwd, @role, @perms::jsonb, 'ACTIVE', 1)
                ON CONFLICT (tenant_id, staff_no) DO NOTHING;
                """;
            await using var cmd = new NpgsqlCommand(upsertStaff, conn, tx);
            cmd.Parameters.AddWithValue("id", s.Id);
            cmd.Parameters.AddWithValue("tid", DefaultTenantId);
            cmd.Parameters.AddWithValue("no", s.No);
            cmd.Parameters.AddWithValue("name", s.Name);
            cmd.Parameters.AddWithValue("phone", s.Phone);
            cmd.Parameters.AddWithValue("pwd", defaultPwdHash);
            cmd.Parameters.AddWithValue("role", s.Role);
            cmd.Parameters.AddWithValue("perms", JsonSerializer.Serialize(s.Perms));
            await cmd.ExecuteNonQueryAsync(ct);
        }

        // Seed 2 existing members (陈静 No.008621, 周明 No.008620)
        var memberSeeds = new[]
        {
            (Id: Guid.Parse("20000000-0000-0000-0000-000000008621"), No: "No.008621", Name: "陈静", Phone: "13800138000", Addr: "幸福里小区 3 栋 2 单元 501 室", BDeliv: 8, BPick: 10, BagPick: 6, Dep: 130.00m, HBucket: 2, HBag: 1),
            (Id: Guid.Parse("20000000-0000-0000-0000-000000008620"), No: "No.008620", Name: "周明", Phone: "13911223344", Addr: "金桂花园 2 栋 101 室", BDeliv: 0, BPick: 0, BagPick: 12, Dep: 30.00m, HBucket: 0, HBag: 1)
        };

        foreach (var m in memberSeeds)
        {
            const string upsertMember = """
                INSERT INTO plugin_kunlun_waterstation.members
                    (id, tenant_id, member_no, name, phone, default_address, bucket_delivery_tickets, bucket_pickup_tickets, bag_pickup_tickets, deposit_amount, held_buckets, held_bags, status, source)
                VALUES
                    (@id, @tid, @no, @name, @phone, @addr, @bd, @bp, @bgp, @dep, @hb, @hbg, 'ACTIVE', 'STAFF_CREATED')
                ON CONFLICT (tenant_id, member_no) DO NOTHING;
                """;
            await using var cmd = new NpgsqlCommand(upsertMember, conn, tx);
            cmd.Parameters.AddWithValue("id", m.Id);
            cmd.Parameters.AddWithValue("tid", DefaultTenantId);
            cmd.Parameters.AddWithValue("no", m.No);
            cmd.Parameters.AddWithValue("name", m.Name);
            cmd.Parameters.AddWithValue("phone", m.Phone);
            cmd.Parameters.AddWithValue("addr", m.Addr);
            cmd.Parameters.AddWithValue("bd", m.BDeliv);
            cmd.Parameters.AddWithValue("bp", m.BPick);
            cmd.Parameters.AddWithValue("bgp", m.BagPick);
            cmd.Parameters.AddWithValue("dep", m.Dep);
            cmd.Parameters.AddWithValue("hb", m.HBucket);
            cmd.Parameters.AddWithValue("hbg", m.HBag);
            await cmd.ExecuteNonQueryAsync(ct);
        }

        await using (var credentials = new NpgsqlCommand("""
            UPDATE plugin_kunlun_waterstation.members SET username = lower(member_no), password_hash = @hash
            WHERE tenant_id = @tid AND username IS NULL
            """, conn, tx))
        {
            credentials.Parameters.AddWithValue("hash", defaultPwdHash);
            credentials.Parameters.AddWithValue("tid", DefaultTenantId);
            await credentials.ExecuteNonQueryAsync(ct);
        }
        await tx.CommitAsync(ct);
    }

    public string IssueJwt(
        string subjectType,
        Guid subjectId,
        string displayName,
        string codeOrNo,
        string phone,
        string role,
        string[] permissions,
        int tokenVersion)
    {
        var key = Encoding.UTF8.GetBytes(
            config["Kunlun:Jwt:SigningKey"] ?? throw new InvalidOperationException("JWT signing key is required."));
        var creds = new SigningCredentials(new SymmetricSecurityKey(key), SecurityAlgorithms.HmacSha256);

        var claims = new List<Claim>
        {
            new(JwtRegisteredClaimNames.Sub, subjectId.ToString()),
            new("subject_type", subjectType),
            new("tenant_id", DefaultTenantId.ToString()),
            new("display_name", displayName),
            new("code_or_no", codeOrNo),
            new("phone", phone),
            new(ClaimTypes.Role, role),
            new("role", role),
            new("token_version", tokenVersion.ToString())
        };
        foreach (var p in permissions)
        {
            claims.Add(new Claim("perm", p));
        }

        var token = new JwtSecurityToken(
            issuer: config["Kunlun:Jwt:Issuer"] ?? "kunlun.waterstation",
            audience: config["Kunlun:Jwt:Audience"] ?? "kunlun.clients",
            claims: claims,
            expires: DateTime.UtcNow.AddHours(12),
            signingCredentials: creds);

        return new JwtSecurityTokenHandler().WriteToken(token);
    }
}
