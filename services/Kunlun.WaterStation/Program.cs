using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using Kunlun.WaterStation.Auth;
using Kunlun.WaterStation.Operations;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.IdentityModel.Tokens;
using Npgsql;

// Automatically load .env.local if present in repo root or parent directories
for (var dir = new DirectoryInfo(Directory.GetCurrentDirectory()); dir is not null; dir = dir.Parent)
{
    var envFile = Path.Combine(dir.FullName, ".env.local");
    if (File.Exists(envFile))
    {
        foreach (var line in File.ReadAllLines(envFile))
        {
            if (string.IsNullOrWhiteSpace(line) || line.StartsWith('#')) continue;
            var idx = line.IndexOf('=');
            if (idx > 0 && string.IsNullOrEmpty(Environment.GetEnvironmentVariable(line[..idx])))
            {
                Environment.SetEnvironmentVariable(line[..idx], line[(idx + 1)..]);
            }
        }
        break;
    }
}

var builder = WebApplication.CreateBuilder(args);

var connStr = builder.Configuration.GetConnectionString("Kunlun")
    ?? Environment.GetEnvironmentVariable("ConnectionStrings__Kunlun")
    ?? throw new InvalidOperationException("Missing ConnectionStrings:Kunlun configuration.");

var dataSource = NpgsqlDataSource.Create(connStr);
builder.Services.AddSingleton(dataSource);
builder.Services.AddSingleton<KunlunAuthRepository>();
builder.Services.AddSingleton<KunlunFinanceRepository>();
builder.Services.AddCors(o => o.AddDefaultPolicy(p => p.AllowAnyOrigin().AllowAnyHeader().AllowAnyMethod()));

var signingKey = Encoding.UTF8.GetBytes(
    builder.Configuration["Kunlun:Jwt:SigningKey"] ?? "kunlun-waterstation-default-dev-signing-key-2026-32bytes!");

builder.Services
    .AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(options =>
    {
        options.MapInboundClaims = false;
        options.TokenValidationParameters = new TokenValidationParameters
        {
            ValidateIssuer = true,
            ValidIssuer = builder.Configuration["Kunlun:Jwt:Issuer"] ?? "kunlun.waterstation",
            ValidateAudience = true,
            ValidAudience = builder.Configuration["Kunlun:Jwt:Audience"] ?? "kunlun.clients",
            ValidateIssuerSigningKey = true,
            IssuerSigningKey = new SymmetricSecurityKey(signingKey),
            ValidateLifetime = true,
            ClockSkew = TimeSpan.FromSeconds(30)
        };
        // Real-time staff status & tokenVersion verification against k3s PostgreSQL
        options.Events = new JwtBearerEvents
        {
            OnTokenValidated = async ctx =>
            {
                var subjectType = ctx.Principal?.FindFirstValue("subject_type");
                var sub = ctx.Principal?.FindFirstValue(JwtRegisteredClaimNames.Sub);
                var verStr = ctx.Principal?.FindFirstValue("token_version");
                if (subjectType == "STAFF" && Guid.TryParse(sub, out var staffId) && int.TryParse(verStr, out var tokenVer))
                {
                    var ds = ctx.HttpContext.RequestServices.GetRequiredService<NpgsqlDataSource>();
                    await using var conn = await ds.OpenConnectionAsync(ctx.HttpContext.RequestAborted);
                    await using var cmd = new NpgsqlCommand(
                        "SELECT status, token_version FROM plugin_kunlun_waterstation.staff WHERE id = @id", conn);
                    cmd.Parameters.AddWithValue("id", staffId);
                    await using var reader = await cmd.ExecuteReaderAsync(ctx.HttpContext.RequestAborted);
                    if (!await reader.ReadAsync() || reader.GetString(0) != "ACTIVE" || reader.GetInt32(1) != tokenVer)
                    {
                        ctx.Fail("员工账号已停用或权限已变更，请重新登录。");
                    }
                }
            }
        };
    });

builder.Services.AddAuthorization();

var app = builder.Build();
app.UseCors();
app.UseAuthentication();
app.UseAuthorization();

// Ensure schema and seed data on startup
using (var scope = app.Services.CreateScope())
{
    var repo = scope.ServiceProvider.GetRequiredService<KunlunAuthRepository>();
    await repo.EnsureSchemaAndSeedAsync();
    var finRepo = scope.ServiceProvider.GetRequiredService<KunlunFinanceRepository>();
    await finRepo.EnsureFinanceSchemaAndSeedAsync();
}

app.MapGet("/healthz", async (NpgsqlDataSource ds) =>
{
    await using var conn = await ds.OpenConnectionAsync();
    await using var cmd = new NpgsqlCommand("SELECT current_database(), current_user", conn);
    await using var r = await cmd.ExecuteReaderAsync();
    await r.ReadAsync();
    return Results.Ok(new
    {
        plugin = "kunlun.waterstation",
        brand = "绿麒麟水站｜小分子团弱碱活性水",
        slogan = "鲜活每一滴，好水到你家",
        database = r.GetString(0),
        dbUser = r.GetString(1),
        status = "healthy"
    });
});

// 1. 管理端 PC / 员工账号密码登录
app.MapPost("/api/auth/staff/login", async (
    StaffLoginRequest req,
    NpgsqlDataSource ds,
    KunlunAuthRepository repo,
    CancellationToken ct) =>
{
    await using var conn = await ds.OpenConnectionAsync(ct);
    await using var cmd = new NpgsqlCommand("""
        SELECT id, staff_no, name, phone, password_hash, role, permissions::text, status, token_version
        FROM plugin_kunlun_waterstation.staff
        WHERE tenant_id = @tid AND (staff_no = @acc OR phone = @acc)
        """, conn);
    cmd.Parameters.AddWithValue("tid", repo.DefaultTenantId);
    cmd.Parameters.AddWithValue("acc", req.Account.Trim());

    await using var reader = await cmd.ExecuteReaderAsync(ct);
    if (!await reader.ReadAsync(ct))
        return Results.Json(new { error = "账号或密码错误" }, statusCode: StatusCodes.Status401Unauthorized);

    var id = reader.GetGuid(0);
    var staffNo = reader.GetString(1);
    var name = reader.GetString(2);
    var phone = reader.GetString(3);
    var pwdHash = reader.GetString(4);
    var role = reader.GetString(5);
    var perms = JsonSerializer.Deserialize<string[]>(reader.GetString(6)) ?? [];
    var status = reader.GetString(7);
    var tokenVer = reader.GetInt32(8);
    await reader.CloseAsync();

    if (!PasswordHasher.Verify(req.Password, pwdHash))
        return Results.Json(new { error = "账号或密码错误" }, statusCode: StatusCodes.Status401Unauthorized);

    if (status != "ACTIVE")
        return Results.Json(new { error = "该员工账号已停用，禁止登录" }, statusCode: StatusCodes.Status403Forbidden);

    var token = repo.IssueJwt("STAFF", id, name, staffNo, phone, role, perms, tokenVer);

    await using var auditCmd = new NpgsqlCommand("""
        INSERT INTO plugin_kunlun_waterstation.auth_audit_logs (tenant_id, actor_type, actor_id, actor_name, action, detail)
        VALUES (@tid, 'STAFF', @id, @name, 'STAFF_LOGIN', @detail)
        """, conn);
    auditCmd.Parameters.AddWithValue("tid", repo.DefaultTenantId);
    auditCmd.Parameters.AddWithValue("id", id);
    auditCmd.Parameters.AddWithValue("name", name);
    auditCmd.Parameters.AddWithValue("detail", $"工号 {staffNo} ({role}) 登录成功");
    await auditCmd.ExecuteNonQueryAsync(ct);

    return Results.Ok(new AuthTokenResponse(token, "STAFF", id, name, staffNo, phone, role, perms, tokenVer));
});

// 2. 微信小程序手机号一键登录（自动识别员工白名单 / 绑定门店老会员 / 自动注册新会员）
app.MapPost("/api/auth/wechat/phone-login", async (
    WeChatPhoneLoginRequest req,
    NpgsqlDataSource ds,
    KunlunAuthRepository repo,
    CancellationToken ct) =>
{
    var phone = req.Phone.Trim();
    if (phone.Length != 11 || !phone.StartsWith('1'))
        return Results.BadRequest(new { error = "请输入有效的 11 位微信授权手机号" });

    await using var conn = await ds.OpenConnectionAsync(ct);

    // 2.1 若手机号命中启用中的员工表，则支持作为员工端小程序身份登录
    await using (var staffCmd = new NpgsqlCommand("""
        SELECT id, staff_no, name, role, permissions::text, status, token_version
        FROM plugin_kunlun_waterstation.staff
        WHERE tenant_id = @tid AND phone = @phone
        """, conn))
    {
        staffCmd.Parameters.AddWithValue("tid", repo.DefaultTenantId);
        staffCmd.Parameters.AddWithValue("phone", phone);
        await using var sr = await staffCmd.ExecuteReaderAsync(ct);
        if (await sr.ReadAsync(ct))
        {
            var sid = sr.GetGuid(0);
            var sno = sr.GetString(1);
            var sname = sr.GetString(2);
            var srole = sr.GetString(3);
            var sperms = JsonSerializer.Deserialize<string[]>(sr.GetString(4)) ?? [];
            var sstatus = sr.GetString(5);
            var sver = sr.GetInt32(6);
            await sr.CloseAsync();

            if (sstatus != "ACTIVE")
                return Results.Json(new { error = "该员工账号已停用" }, statusCode: StatusCodes.Status403Forbidden);

            var stoken = repo.IssueJwt("STAFF", sid, sname, sno, phone, srole, sperms, sver);
            return Results.Ok(new AuthTokenResponse(stoken, "STAFF", sid, sname, sno, phone, srole, sperms, sver));
        }
    }

    // 2.2 匹配门店既有会员档案（解决 PRD 手机号认领与防冒领）
    await using (var memCmd = new NpgsqlCommand("""
        SELECT id, member_no, name, status
        FROM plugin_kunlun_waterstation.members
        WHERE tenant_id = @tid AND phone = @phone
        """, conn))
    {
        memCmd.Parameters.AddWithValue("tid", repo.DefaultTenantId);
        memCmd.Parameters.AddWithValue("phone", phone);
        await using var mr = await memCmd.ExecuteReaderAsync(ct);
        if (await mr.ReadAsync(ct))
        {
            var mid = mr.GetGuid(0);
            var mno = mr.GetString(1);
            var mname = mr.GetString(2);
            var mstatus = mr.GetString(3);
            await mr.CloseAsync();

            if (mstatus != "ACTIVE")
                return Results.Json(new { error = "该会员账号已停用" }, statusCode: StatusCodes.Status403Forbidden);

            if (!string.IsNullOrWhiteSpace(req.WxOpenId))
            {
                await using var bindCmd = new NpgsqlCommand(
                    "UPDATE plugin_kunlun_waterstation.members SET wx_openid = @oid WHERE id = @id", conn);
                bindCmd.Parameters.AddWithValue("oid", req.WxOpenId);
                bindCmd.Parameters.AddWithValue("id", mid);
                await bindCmd.ExecuteNonQueryAsync(ct);
            }

            var mtoken = repo.IssueJwt("MEMBER", mid, mname, mno, phone, "MEMBER", [], 1);
            return Results.Ok(new AuthTokenResponse(mtoken, "MEMBER", mid, mname, mno, phone, "MEMBER", [], 1, IsNewMember: false));
        }
    }

    // 2.3 新手机号自动注册会员
    var newId = Guid.NewGuid();
    var newNo = $"No.{Random.Shared.Next(100000, 999999)}";
    var newName = string.IsNullOrWhiteSpace(req.Name) ? $"微信会员{phone[^4..]}" : req.Name.Trim();

    await using (var insCmd = new NpgsqlCommand("""
        INSERT INTO plugin_kunlun_waterstation.members
            (id, tenant_id, member_no, name, phone, wx_openid, status, source)
        VALUES
            (@id, @tid, @no, @name, @phone, @oid, 'ACTIVE', 'WX_MINIAPP')
        """, conn))
    {
        insCmd.Parameters.AddWithValue("id", newId);
        insCmd.Parameters.AddWithValue("tid", repo.DefaultTenantId);
        insCmd.Parameters.AddWithValue("no", newNo);
        insCmd.Parameters.AddWithValue("name", newName);
        insCmd.Parameters.AddWithValue("phone", phone);
        insCmd.Parameters.AddWithValue("oid", (object?)req.WxOpenId ?? DBNull.Value);
        await insCmd.ExecuteNonQueryAsync(ct);
    }

    var token = repo.IssueJwt("MEMBER", newId, newName, newNo, phone, "MEMBER", [], 1);
    return Results.Ok(new AuthTokenResponse(token, "MEMBER", newId, newName, newNo, phone, "MEMBER", [], 1, IsNewMember: true));
});

// 3. 当前登录身份与权限自检
app.MapGet("/api/auth/me", (ClaimsPrincipal user) =>
{
    var sub = user.FindFirstValue(JwtRegisteredClaimNames.Sub);
    var subjectType = user.FindFirstValue("subject_type");
    var displayName = user.FindFirstValue("display_name");
    var codeOrNo = user.FindFirstValue("code_or_no");
    var phone = user.FindFirstValue("phone");
    var role = user.FindFirstValue("role");
    var perms = user.FindAll("perm").Select(c => c.Value).ToArray();
    return Results.Ok(new { sub, subjectType, displayName, codeOrNo, phone, role, permissions = perms });
}).RequireAuthorization();

// 4. 会员端本人资产查询（强制服务端按当前登录会员过滤，或者员工拥有 member:read 权限）
app.MapGet("/api/members/{memberId:guid}/profile", async (
    Guid memberId,
    ClaimsPrincipal user,
    NpgsqlDataSource ds,
    CancellationToken ct) =>
{
    var subjectType = user.FindFirstValue("subject_type");
    var currentSub = Guid.TryParse(user.FindFirstValue(JwtRegisteredClaimNames.Sub), out var sid) ? sid : Guid.Empty;
    var perms = user.FindAll("perm").Select(c => c.Value).ToHashSet();

    // AC-15: 会员尝试访问他人记录 -> 服务端拒绝
    if (subjectType == "MEMBER" && currentSub != memberId)
    {
        return Results.Json(new { error = "禁止访问其他会员的数据（AC-15 服务端强制隔离）" }, statusCode: StatusCodes.Status403Forbidden);
    }
    if (subjectType == "STAFF" && !perms.Contains(KunlunPermissions.MemberRead))
    {
        return Results.Json(new { error = "当前员工无查询会员权限" }, statusCode: StatusCodes.Status403Forbidden);
    }

    await using var conn = await ds.OpenConnectionAsync(ct);
    await using var cmd = new NpgsqlCommand("""
        SELECT id, member_no, name, phone, default_address,
               bucket_delivery_tickets, bucket_pickup_tickets, bag_pickup_tickets, bag_delivery_tickets,
               deposit_amount, held_buckets, held_bags, status
        FROM plugin_kunlun_waterstation.members
        WHERE id = @id
        """, conn);
    cmd.Parameters.AddWithValue("id", memberId);
    await using var r = await cmd.ExecuteReaderAsync(ct);
    if (!await r.ReadAsync(ct)) return Results.NotFound();

    return Results.Ok(new
    {
        id = r.GetGuid(0),
        memberNo = r.GetString(1),
        name = r.GetString(2),
        phone = r.GetString(3),
        defaultAddress = r.IsDBNull(4) ? "" : r.GetString(4),
        bucketDeliveryTickets = r.GetInt32(5),
        bucketPickupTickets = r.GetInt32(6),
        bagPickupTickets = r.GetInt32(7),
        bagDeliveryTickets = r.GetInt32(8),
        depositAmount = r.GetDecimal(9),
        heldBuckets = r.GetInt32(10),
        heldBags = r.GetInt32(11),
        status = r.GetString(12)
    });
}).RequireAuthorization();

// 5. 站长管理员工启用/停用（停用时 token_version + 1，旧 Token 立即失效；防止停用最后一个管理员）
app.MapPatch("/api/staff/{staffId:guid}/status", async (
    Guid staffId,
    UpdateStaffStatusRequest req,
    ClaimsPrincipal user,
    NpgsqlDataSource ds,
    CancellationToken ct) =>
{
    var perms = user.FindAll("perm").Select(c => c.Value).ToHashSet();
    // AC-16: 无权限员工接口越权拦截
    if (!perms.Contains(KunlunPermissions.StaffManage))
    {
        return Results.Json(new { error = "需要站长管理员权限 (kunlun.waterstation:staff:manage)" }, statusCode: StatusCodes.Status403Forbidden);
    }

    await using var conn = await ds.OpenConnectionAsync(ct);
    if (req.Status == "DISABLED")
    {
        // PRD 12.3: 管理员不得通过操作导致系统失去最后一个可用管理账号
        await using var checkCmd = new NpgsqlCommand("""
            SELECT COUNT(*) FROM plugin_kunlun_waterstation.staff
            WHERE role = 'ADMIN' AND status = 'ACTIVE' AND id <> @id
            """, conn);
        checkCmd.Parameters.AddWithValue("id", staffId);
        var remainingAdmins = Convert.ToInt32(await checkCmd.ExecuteScalarAsync(ct));
        if (remainingAdmins == 0)
        {
            return Results.BadRequest(new { error = "不能停用系统最后一个启用中的管理员账号" });
        }
    }

    await using var updCmd = new NpgsqlCommand("""
        UPDATE plugin_kunlun_waterstation.staff
        SET status = @status, token_version = token_version + 1
        WHERE id = @id
        RETURNING staff_no, status, token_version
        """, conn);
    updCmd.Parameters.AddWithValue("status", req.Status);
    updCmd.Parameters.AddWithValue("id", staffId);
    await using var r = await updCmd.ExecuteReaderAsync(ct);
    if (!await r.ReadAsync(ct)) return Results.NotFound();

    return Results.Ok(new { staffNo = r.GetString(0), status = r.GetString(1), tokenVersion = r.GetInt32(2) });
}).RequireAuthorization();

app.MapFinanceEndpoints();
app.Run();

public partial class Program;
