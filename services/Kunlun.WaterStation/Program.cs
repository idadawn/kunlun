using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using Kunlun.WaterStation.Auth;
using Kunlun.WaterStation.Operations;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.IdentityModel.Tokens;
using Npgsql;

// Database and secrets must be supplied explicitly; never load a nearby .env.local.
var builder = WebApplication.CreateBuilder(args);

var connStr = builder.Configuration.GetConnectionString("Kunlun")
    ?? Environment.GetEnvironmentVariable("ConnectionStrings__Kunlun")
    ?? throw new InvalidOperationException("Missing ConnectionStrings:Kunlun configuration.");

var dataSource = NpgsqlDataSource.Create(connStr);
builder.Services.AddSingleton(dataSource);
builder.Services.AddSingleton<KunlunAuthRepository>();
builder.Services.AddSingleton<KunlunFinanceRepository>();
builder.Services.AddSingleton<KunlunOrderRepository>();
builder.Services.AddCors(o => o.AddDefaultPolicy(p => p.AllowAnyOrigin().AllowAnyHeader().AllowAnyMethod()));

var signingKey = Encoding.UTF8.GetBytes(
    builder.Configuration["Kunlun:Jwt:SigningKey"] ?? throw new InvalidOperationException("JWT signing key is required."));

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
                var tenant = ctx.Principal?.FindFirstValue("tenant_id");
                if (subjectType is not ("STAFF" or "MEMBER") || !Guid.TryParse(sub, out var id)
                    || !Guid.TryParse(tenant, out var tenantId) || !int.TryParse(verStr, out var version))
                { ctx.Fail("登录凭证无效"); return; }
                var table = subjectType == "STAFF" ? "staff" : "members";
                var ds = ctx.HttpContext.RequestServices.GetRequiredService<NpgsqlDataSource>();
                await using var conn = await ds.OpenConnectionAsync(ctx.HttpContext.RequestAborted);
                await using var cmd = new NpgsqlCommand($"SELECT status, token_version FROM plugin_kunlun_waterstation.{table} WHERE id = @id AND tenant_id = @tid", conn);
                cmd.Parameters.AddWithValue("id", id);
                cmd.Parameters.AddWithValue("tid", tenantId);
                await using var reader = await cmd.ExecuteReaderAsync(ctx.HttpContext.RequestAborted);
                if (!await reader.ReadAsync(ctx.HttpContext.RequestAborted) || reader.GetString(0) != "ACTIVE" || reader.GetInt32(1) != version)
                    ctx.Fail("登录已失效，请重新登录");
            }
        };
    });

if (signingKey.Length < 32) throw new InvalidOperationException("JWT signing key must contain at least 32 bytes.");
builder.Services.AddAuthorization();
builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode = 429;
    options.AddPolicy("login", context => System.Threading.RateLimiting.RateLimitPartition.GetFixedWindowLimiter(
        context.Connection.RemoteIpAddress?.ToString() ?? "unknown",
        _ => new System.Threading.RateLimiting.FixedWindowRateLimiterOptions
        { PermitLimit = builder.Environment.IsEnvironment("Testing") ? 10000 : 15, Window = TimeSpan.FromMinutes(1), QueueLimit = 0 }));
});

var app = builder.Build();
app.Use(async (context, next) =>
{
    try { await next(); }
    catch (BusinessRuleException ex) when (!context.Response.HasStarted)
    {
        context.Response.StatusCode = ex.Status;
        await context.Response.WriteAsJsonAsync(new { error = ex.Message });
    }
});
app.UseCors();
app.UseRateLimiter();
app.UseAuthentication();
app.UseAuthorization();

// Ensure schema and seed data on startup
using (var scope = app.Services.CreateScope())
{
    var repo = scope.ServiceProvider.GetRequiredService<KunlunAuthRepository>();
    await repo.EnsureSchemaAndSeedAsync();
    var finRepo = scope.ServiceProvider.GetRequiredService<KunlunFinanceRepository>();
    await finRepo.EnsureFinanceSchemaAndSeedAsync();
    var ordRepo = scope.ServiceProvider.GetRequiredService<KunlunOrderRepository>();
    await ordRepo.EnsureOrderSchemaAsync();
    await TicketBatches.EnsureSchema(scope.ServiceProvider.GetRequiredService<NpgsqlDataSource>(), repo.DefaultTenantId);
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

app.MapAuthEndpoints();

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
    return Results.Ok(new { sub, subjectId = sub, subjectType, displayName, codeOrNo, phone, role, permissions = perms });
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
               deposit_amount, held_buckets, held_bags, status,
               reserved_bucket_delivery_tickets, reserved_bucket_pickup_tickets,
               reserved_bag_pickup_tickets, reserved_bag_delivery_tickets
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
        status = r.GetString(12),
        reservedBucketDeliveryTickets = r.GetInt32(13),
        reservedBucketPickupTickets = r.GetInt32(14),
        reservedBagPickupTickets = r.GetInt32(15),
        reservedBagDeliveryTickets = r.GetInt32(16)
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

    if (req.Status is not ("ACTIVE" or "DISABLED")) return Results.BadRequest(new { error = "员工状态无效" });
    var tid = Guid.Parse(user.FindFirstValue("tenant_id")!);
    await using var conn = await ds.OpenConnectionAsync(ct);
    await using var tx = await conn.BeginTransactionAsync(ct);
    await TicketBatches.Exec(conn, tx, "SELECT pg_advisory_xact_lock(hashtextextended(@key,0))", ct, ("key", $"{tid}:staff-status"));
    await using var target = TicketBatches.Command(conn, tx, "SELECT role FROM plugin_kunlun_waterstation.staff WHERE tenant_id=@tid AND id=@id FOR UPDATE", ("tid", tid), ("id", staffId));
    var role = await target.ExecuteScalarAsync(ct);
    if (role is null) return Results.NotFound();
    if (req.Status == "DISABLED" && (string)role == "ADMIN")
    {
        await using var count = TicketBatches.Command(conn, tx, "SELECT count(*) FROM plugin_kunlun_waterstation.staff WHERE tenant_id=@tid AND role='ADMIN' AND status='ACTIVE' AND id<>@id", ("tid", tid), ("id", staffId));
        if (Convert.ToInt64(await count.ExecuteScalarAsync(ct)) == 0) return Results.BadRequest(new { error = "不能停用最后一个管理员" });
    }
    await TicketBatches.Exec(conn, tx, "UPDATE plugin_kunlun_waterstation.staff SET status=@status,token_version=token_version+1 WHERE tenant_id=@tid AND id=@id", ct, ("status", req.Status), ("tid", tid), ("id", staffId));
    await tx.CommitAsync(ct);
    return Results.Ok(new { id = staffId, status = req.Status });
}).RequireAuthorization();

app.MapFinanceEndpoints();
app.MapMembershipEndpoints();
app.MapOrderEndpoints();
app.MapReportEndpoints();
app.MapOverviewEndpoints();
app.Run();

public partial class Program;
