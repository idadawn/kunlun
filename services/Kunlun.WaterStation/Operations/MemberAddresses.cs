using System.Security.Claims;
using System.Text.RegularExpressions;
using Kunlun.WaterStation.Auth;
using Npgsql;
using static Kunlun.WaterStation.Operations.TicketBatches;

namespace Kunlun.WaterStation.Operations;

public sealed record SaveMemberAddressRequest(string ContactName, string ContactPhone, string Location, string DoorNo, bool IsDefault = false);
public sealed record MemberAddress(Guid Id, Guid MemberId, string ContactName, string ContactPhone, string Location, string DoorNo, bool IsDefault, DateTime CreatedAt, DateTime UpdatedAt)
{
    public string FullAddress => Full(Location, DoorNo);
    public static string Full(string location, string doorNo) => string.Join(' ', new[] { location, doorNo }.Where(s => s != ""));
}

/// <summary>
/// 会员收货地址簿：收货地址 + 门牌号 + 联系人 + 手机号，每位会员至多一个默认地址。
/// members.default_address 保留默认地址的展示文本，供会员列表、导出等既有读取方使用。
/// </summary>
public static partial class MemberAddresses
{
    public const int MaxPerMember = 20;
    private const string Columns = "id,member_id,contact_name,contact_phone,location,door_no,is_default,created_at,updated_at";

    [GeneratedRegex(@"^1\d{10}$")]
    private static partial Regex MobilePhone();

    private static bool IsSelf(ClaimsPrincipal user, Guid mid) => user.FindFirstValue("subject_type") == "MEMBER" && user.FindFirstValue("sub") == mid.ToString();
    private static bool IsStaffWith(ClaimsPrincipal user, string permission) => user.FindFirstValue("subject_type") == "STAFF" && user.HasClaim("perm", permission);
    private static bool CanRead(ClaimsPrincipal user, Guid mid) => IsSelf(user, mid) || IsStaffWith(user, KunlunPermissions.MemberRead);
    private static bool CanWrite(ClaimsPrincipal user, Guid mid) => IsSelf(user, mid) || IsStaffWith(user, KunlunPermissions.MemberWrite);

    public static async Task EnsureSchema(NpgsqlDataSource db, Guid tid, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct); await using var tx = await conn.BeginTransactionAsync(ct);
        await Exec(conn, tx, """
            SELECT pg_advisory_xact_lock(88482026);
            CREATE TABLE IF NOT EXISTS plugin_kunlun_waterstation.member_addresses (
              id UUID PRIMARY KEY, tenant_id UUID NOT NULL,
              member_id UUID NOT NULL REFERENCES plugin_kunlun_waterstation.members(id),
              contact_name VARCHAR(64) NOT NULL, contact_phone VARCHAR(20) NOT NULL,
              location TEXT NOT NULL, door_no VARCHAR(64) NOT NULL DEFAULT '',
              is_default BOOLEAN NOT NULL DEFAULT false,
              created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
            );
            CREATE INDEX IF NOT EXISTS member_addresses_member ON plugin_kunlun_waterstation.member_addresses(tenant_id,member_id,updated_at DESC);
            CREATE UNIQUE INDEX IF NOT EXISTS member_addresses_one_default ON plugin_kunlun_waterstation.member_addresses(member_id) WHERE is_default;
            -- Members from before address books keep their single text address as the default entry.
            -- Only members without any address row are touched, so this is safe on every start.
            INSERT INTO plugin_kunlun_waterstation.member_addresses(id,tenant_id,member_id,contact_name,contact_phone,location,door_no,is_default)
            SELECT gen_random_uuid(),m.tenant_id,m.id,m.name,m.phone,btrim(m.default_address),'',true
            FROM plugin_kunlun_waterstation.members m
            WHERE m.tenant_id=@tid AND btrim(COALESCE(m.default_address,''))<>''
              AND NOT EXISTS(SELECT 1 FROM plugin_kunlun_waterstation.member_addresses a WHERE a.member_id=m.id);
            """, ct, ("tid", tid));
        await tx.CommitAsync(ct);
    }

    public static void MapMemberAddresses(this WebApplication app)
    {
        var group = app.MapGroup("/api/members/{mid:guid}/addresses").RequireAuthorization();
        group.MapGet("", async (Guid mid, ClaimsPrincipal user, NpgsqlDataSource db, KunlunAuthRepository repo, CancellationToken ct) =>
        {
            if (!CanRead(user, mid)) return Results.Forbid();
            await using var conn = await db.OpenConnectionAsync(ct);
            return Results.Ok((await List(conn, null, repo.DefaultTenantId, mid, ct)).Select(View));
        });
        group.MapPost("", (Guid mid, SaveMemberAddressRequest req, ClaimsPrincipal user, NpgsqlDataSource db, KunlunAuthRepository repo, CancellationToken ct) =>
            Mutate(mid, user, db, repo, ct, async (conn, tx, tid, existing) =>
            {
                if (existing.Count >= MaxPerMember) throw new BusinessRuleException($"每位会员最多保存 {MaxPerMember} 个收货地址");
                var a = Validate(req);
                var id = Guid.NewGuid();
                var isDefault = req.IsDefault || existing.Count == 0;
                if (isDefault) await ClearDefault(conn, tx, mid, ct);
                await Exec(conn, tx, """
                    INSERT INTO plugin_kunlun_waterstation.member_addresses(id,tenant_id,member_id,contact_name,contact_phone,location,door_no,is_default)
                    VALUES(@id,@tid,@mid,@name,@phone,@location,@door,@default)
                    """, ct, ("id", id), ("tid", tid), ("mid", mid), ("name", a.ContactName), ("phone", a.ContactPhone), ("location", a.Location), ("door", a.DoorNo), ("default", isDefault));
                return id;
            }));
        group.MapPut("/{aid:guid}", (Guid mid, Guid aid, SaveMemberAddressRequest req, ClaimsPrincipal user, NpgsqlDataSource db, KunlunAuthRepository repo, CancellationToken ct) =>
            Mutate(mid, user, db, repo, ct, async (conn, tx, tid, existing) =>
            {
                var current = existing.FirstOrDefault(x => x.Id == aid) ?? throw new BusinessRuleException("收货地址不存在", 404);
                var a = Validate(req);
                // The default can only move to another address; it is never cleared in place.
                if (req.IsDefault && !current.IsDefault) await ClearDefault(conn, tx, mid, ct);
                await Exec(conn, tx, """
                    UPDATE plugin_kunlun_waterstation.member_addresses
                    SET contact_name=@name,contact_phone=@phone,location=@location,door_no=@door,is_default=is_default OR @default,updated_at=now()
                    WHERE id=@id
                    """, ct, ("id", aid), ("name", a.ContactName), ("phone", a.ContactPhone), ("location", a.Location), ("door", a.DoorNo), ("default", req.IsDefault));
                return aid;
            }));
        group.MapPost("/{aid:guid}/default", (Guid mid, Guid aid, ClaimsPrincipal user, NpgsqlDataSource db, KunlunAuthRepository repo, CancellationToken ct) =>
            Mutate(mid, user, db, repo, ct, async (conn, tx, tid, existing) =>
            {
                if (existing.All(x => x.Id != aid)) throw new BusinessRuleException("收货地址不存在", 404);
                await ClearDefault(conn, tx, mid, ct);
                await Exec(conn, tx, "UPDATE plugin_kunlun_waterstation.member_addresses SET is_default=true,updated_at=now() WHERE id=@id", ct, ("id", aid));
                return aid;
            }));
        group.MapDelete("/{aid:guid}", (Guid mid, Guid aid, ClaimsPrincipal user, NpgsqlDataSource db, KunlunAuthRepository repo, CancellationToken ct) =>
            Mutate(mid, user, db, repo, ct, async (conn, tx, tid, existing) =>
            {
                var current = existing.FirstOrDefault(x => x.Id == aid) ?? throw new BusinessRuleException("收货地址不存在", 404);
                await Exec(conn, tx, "DELETE FROM plugin_kunlun_waterstation.member_addresses WHERE id=@id", ct, ("id", aid));
                // Orders keep their own address snapshot; a deleted default hands over to the most recently used address.
                var next = existing.Where(x => x.Id != aid).OrderByDescending(x => x.UpdatedAt).FirstOrDefault();
                if (current.IsDefault && next is not null)
                    await Exec(conn, tx, "UPDATE plugin_kunlun_waterstation.member_addresses SET is_default=true WHERE id=@id", ct, ("id", next.Id));
                return null;
            }));
    }

    /// <summary>Delivery address for a new order: the chosen address of this member, otherwise the default one.</summary>
    public static async Task<MemberAddress?> ForOrder(NpgsqlConnection conn, NpgsqlTransaction tx, Guid tid, Guid mid, Guid? addressId, CancellationToken ct)
    {
        var all = await List(conn, tx, tid, mid, ct);
        if (addressId is null) return all.FirstOrDefault(x => x.IsDefault);
        return all.FirstOrDefault(x => x.Id == addressId) ?? throw new BusinessRuleException("收货地址不存在或不属于该会员");
    }

    /// <summary>Creates the first, default address of a newly registered member.</summary>
    public static async Task AddInitial(NpgsqlConnection conn, NpgsqlTransaction tx, Guid tid, Guid mid, string name, string phone, string location, string? doorNo, CancellationToken ct)
    {
        var a = Validate(new SaveMemberAddressRequest(name, phone, location, doorNo ?? ""));
        await Exec(conn, tx, """
            INSERT INTO plugin_kunlun_waterstation.member_addresses(id,tenant_id,member_id,contact_name,contact_phone,location,door_no,is_default)
            VALUES(@id,@tid,@mid,@name,@phone,@location,@door,true)
            """, ct, ("id", Guid.NewGuid()), ("tid", tid), ("mid", mid), ("name", a.ContactName), ("phone", a.ContactPhone), ("location", a.Location), ("door", a.DoorNo));
        await SyncDefault(conn, tx, tid, mid, ct);
    }

    private static SaveMemberAddressRequest Validate(SaveMemberAddressRequest req)
    {
        var a = new SaveMemberAddressRequest(req.ContactName?.Trim() ?? "", req.ContactPhone?.Trim() ?? "", req.Location?.Trim() ?? "", req.DoorNo?.Trim() ?? "", req.IsDefault);
        if (a.Location.Length is 0 or > 200) throw new BusinessRuleException("请填写不超过 200 字的收货地址");
        if (a.DoorNo.Length is 0 or > 64) throw new BusinessRuleException("请填写不超过 64 字的门牌号");
        if (a.ContactName.Length is 0 or > 32) throw new BusinessRuleException("请填写不超过 32 字的联系人");
        if (!MobilePhone().IsMatch(a.ContactPhone)) throw new BusinessRuleException("请填写 11 位联系手机号");
        return a;
    }

    // Serializes all address changes of one member on the member row, then mirrors the default into members.default_address.
    private static async Task<IResult> Mutate(Guid mid, ClaimsPrincipal user, NpgsqlDataSource db, KunlunAuthRepository repo, CancellationToken ct,
        Func<NpgsqlConnection, NpgsqlTransaction, Guid, List<MemberAddress>, Task<Guid?>> change)
    {
        if (!CanWrite(user, mid)) return Results.Forbid();
        var tid = repo.DefaultTenantId;
        await using var conn = await db.OpenConnectionAsync(ct); await using var tx = await conn.BeginTransactionAsync(ct);
        await using (var member = Command(conn, tx, "SELECT 1 FROM plugin_kunlun_waterstation.members WHERE tenant_id=@tid AND id=@mid FOR UPDATE", ("tid", tid), ("mid", mid)))
            if (await member.ExecuteScalarAsync(ct) is null) return Results.NotFound();
        var id = await change(conn, tx, tid, await List(conn, tx, tid, mid, ct));
        await SyncDefault(conn, tx, tid, mid, ct);
        var saved = id is null ? null : (await List(conn, tx, tid, mid, ct)).Single(x => x.Id == id);
        await tx.CommitAsync(ct);
        return saved is null ? Results.NoContent() : Results.Ok(View(saved));
    }

    private static Task ClearDefault(NpgsqlConnection conn, NpgsqlTransaction tx, Guid mid, CancellationToken ct) =>
        Exec(conn, tx, "UPDATE plugin_kunlun_waterstation.member_addresses SET is_default=false WHERE member_id=@mid AND is_default", ct, ("mid", mid));

    private static Task SyncDefault(NpgsqlConnection conn, NpgsqlTransaction tx, Guid tid, Guid mid, CancellationToken ct) => Exec(conn, tx, """
        UPDATE plugin_kunlun_waterstation.members m
        SET default_address=(SELECT concat_ws(' ',a.location,NULLIF(a.door_no,'')) FROM plugin_kunlun_waterstation.member_addresses a WHERE a.member_id=m.id AND a.is_default)
        WHERE m.tenant_id=@tid AND m.id=@mid
        """, ct, ("tid", tid), ("mid", mid));

    private static async Task<List<MemberAddress>> List(NpgsqlConnection conn, NpgsqlTransaction? tx, Guid tid, Guid mid, CancellationToken ct)
    {
        await using var cmd = Command(conn, tx, $"SELECT {Columns} FROM plugin_kunlun_waterstation.member_addresses WHERE tenant_id=@tid AND member_id=@mid ORDER BY is_default DESC,updated_at DESC,id", ("tid", tid), ("mid", mid));
        var rows = new List<MemberAddress>();
        await using var r = await cmd.ExecuteReaderAsync(ct);
        while (await r.ReadAsync(ct))
            rows.Add(new(r.GetGuid(0), r.GetGuid(1), r.GetString(2), r.GetString(3), r.GetString(4), r.GetString(5), r.GetBoolean(6), r.GetDateTime(7), r.GetDateTime(8)));
        return rows;
    }

    private static object View(MemberAddress a) => new
    {
        id = a.Id, memberId = a.MemberId, contactName = a.ContactName, contactPhone = a.ContactPhone,
        location = a.Location, doorNo = a.DoorNo, fullAddress = a.FullAddress, isDefault = a.IsDefault, createdAt = a.CreatedAt, updatedAt = a.UpdatedAt
    };
}
