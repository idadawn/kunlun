using System.Globalization;
using System.Security.Claims;
using System.Text.Json;
using Kunlun.WaterStation.Auth;
using Npgsql;
using static Kunlun.WaterStation.Operations.TicketBatches;

namespace Kunlun.WaterStation.Operations;

/// <summary>
/// 上系统前买的一个套餐：哪种水、自提还是配送、当时实付多少钱买了多少桶、现在还剩多少。PaidAmount 为 0 表示套餐不清楚：
/// 照常能用，但没有原价，不能按原价退。带 BatchId 时改的是一笔已补录的余额：Remaining 改成现在实际还剩的数，
/// Remove 删掉一笔还没用过、也没办过退款的（录错了）。
/// </summary>
public sealed record OpeningTicketInput(Guid? BatchId = null, string? WaterType = null, string? FulfillMode = null, Guid? PlanId = null,
    decimal PaidAmount = 0, int PackageQty = 0, int Remaining = 0, bool Remove = false);
/// <summary>
/// 上系统前交的某种桶袋的押金：几个、一共多少钱（Amount，按个数平分成每个的押金，要能分到整分）；旧客户端传每个多少钱（UnitPrice）。
/// 每位会员每种桶袋只有一笔，Quantity 为 0 删掉还没退过、没扣过的那笔。
/// </summary>
public sealed record OpeningDepositInput(string ContainerType, int Quantity, decimal UnitPrice = 0, decimal? Amount = null);
/// <summary>会员现在手里某种桶袋的个数。</summary>
public sealed record OpeningHoldingInput(string ContainerType, int Quantity);
public sealed record SaveOpeningRequest(string IdempotencyKey, OpeningTicketInput[]? Tickets = null, OpeningDepositInput[]? Deposits = null,
    OpeningHoldingInput[]? Holdings = null, string? Note = null);

/// <summary>
/// 补录会员上系统前的数据（期初）：买过什么套餐、现在还剩多少，交了多少押金，手里有几个桶袋。
/// <list type="bullet">
/// <item>水票记为 source=OPENING 的批次：知道套餐时带原实付和套餐桶数，退清时与系统里的充值一样按原价折算；不知道时不计价、不能按原价退。</item>
/// <item>押金记为 source=OPENING 的押金批次（收款方式 OPENING），退押、报废扣押照常按它的单价先进先出。</item>
/// <item>手里的桶袋直接改成现在的数，只登记到会员名下，店里不动；库存的「客户手里」少于会员名下时补到一样多。</item>
/// </list>
/// 补录的批次按会员建档时间入账，所以排在这位会员系统里的充值和押金之前，先用先退。它们不是当天收的钱：
/// 不进水费实收、累计收押和经营走势，财务汇总另列「上系统前」的数。每次补录一个单号，前后变化都记在 member_opening_entries。
/// </summary>
public static class MemberOpening
{
    public const string Source = "OPENING";
    private const int MaxQty = 100_000;
    private const int MaxContainers = 10_000;
    private const int MaxItems = 50;
    private const int NoteMaxLength = 200;

    private static bool CanSave(ClaimsPrincipal user) => user.FindFirstValue("subject_type") == "STAFF" && user.HasClaim("perm", KunlunPermissions.MemberOpening);
    private static bool CanRead(ClaimsPrincipal user) => user.FindFirstValue("subject_type") == "STAFF" && user.HasClaim("perm", KunlunPermissions.MemberRead);
    private static string Actor(ClaimsPrincipal user) => user.FindFirstValue("display_name") ?? "管理员";
    private static string Yuan(decimal amount) => (amount % 1 == 0 ? amount.ToString("0", CultureInfo.InvariantCulture) : amount.ToString("0.00", CultureInfo.InvariantCulture));
    private static string ModeLabel(string mode) => mode == "PICKUP" ? "自提" : "配送";

    public static async Task EnsureSchema(NpgsqlDataSource db, Guid tid, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var tx = await conn.BeginTransactionAsync(ct);
        await Exec(conn, tx, """
            SELECT pg_advisory_xact_lock(88482026);
            ALTER TABLE plugin_kunlun_waterstation.ticket_batches ADD COLUMN IF NOT EXISTS opening_snapshot JSONB;
            ALTER TABLE plugin_kunlun_waterstation.deposit_lots ADD COLUMN IF NOT EXISTS source VARCHAR(16) NOT NULL DEFAULT 'COLLECT';
            CREATE UNIQUE INDEX IF NOT EXISTS deposit_lots_one_opening ON plugin_kunlun_waterstation.deposit_lots(tenant_id,member_id,container_type) WHERE source='OPENING';
            CREATE TABLE IF NOT EXISTS plugin_kunlun_waterstation.member_opening_entries (
              id UUID PRIMARY KEY, tenant_id UUID NOT NULL, entry_no VARCHAR(32) NOT NULL UNIQUE,
              idempotency_key VARCHAR(80) NOT NULL, request_hash VARCHAR(64) NOT NULL,
              member_id UUID NOT NULL REFERENCES plugin_kunlun_waterstation.members(id),
              note VARCHAR(200), operator_id UUID NOT NULL, operator_name VARCHAR(64) NOT NULL,
              receipt JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
              UNIQUE(tenant_id,idempotency_key)
            );
            CREATE INDEX IF NOT EXISTS member_opening_entries_member ON plugin_kunlun_waterstation.member_opening_entries(tenant_id,member_id,created_at DESC);
            -- Administrators hold every permission; the ones from before this permission existed get it here. Permissions are
            -- re-read on every request, so no one has to sign in again.
            UPDATE plugin_kunlun_waterstation.staff SET permissions=permissions || '["kunlun.waterstation:member:opening"]'::jsonb
            WHERE tenant_id=@tid AND role='ADMIN' AND NOT (permissions ? 'kunlun.waterstation:member:opening');
            """, ct, ("tid", tid));
        await tx.CommitAsync(ct);
    }

    public static void MapMemberOpening(this WebApplication app)
    {
        app.MapGet("/api/members/{mid:guid}/opening", Read).RequireAuthorization();
        app.MapPost("/api/members/{mid:guid}/opening", Save).RequireAuthorization();
    }

    /// <summary>这位会员补录过的押金（每种桶袋一笔，退过或扣过的不能再改）和历次补录记录，新的在前。</summary>
    private static async Task<IResult> Read(Guid mid, ClaimsPrincipal user, NpgsqlDataSource db, KunlunAuthRepository repo, CancellationToken ct)
    {
        if (!CanRead(user)) return Results.Forbid();
        var tid = repo.DefaultTenantId;
        await using var conn = await db.OpenConnectionAsync(ct);
        var deposits = new List<object>();
        await using (var cmd = Command(conn, null, """
            SELECT container_type,paid_qty,unit_price,total_amount,deposit_no,remaining_qty,refunded_qty+deducted_qty+reserved_damage_qty>0
            FROM plugin_kunlun_waterstation.deposit_lots WHERE tenant_id=@tid AND member_id=@mid AND source='OPENING' ORDER BY created_at,id
            """, ("tid", tid), ("mid", mid)))
        await using (var r = await cmd.ExecuteReaderAsync(ct))
            while (await r.ReadAsync(ct))
                deposits.Add(new { containerType = r.GetString(0), quantity = r.GetInt32(1), unitPrice = r.GetDecimal(2), amount = r.GetDecimal(3), depositNo = r.GetString(4), remainingQty = r.GetInt32(5), locked = r.GetBoolean(6) });
        var entries = new List<JsonElement>();
        await using (var cmd = Command(conn, null, "SELECT receipt::text FROM plugin_kunlun_waterstation.member_opening_entries WHERE tenant_id=@tid AND member_id=@mid ORDER BY created_at DESC,id DESC LIMIT 50", ("tid", tid), ("mid", mid)))
        await using (var r = await cmd.ExecuteReaderAsync(ct))
            while (await r.ReadAsync(ct)) entries.Add(JsonSerializer.Deserialize<JsonElement>(r.GetString(0)));
        return Results.Ok(new { deposits, entries });
    }

    private static async Task<IResult> Save(Guid mid, SaveOpeningRequest req, ClaimsPrincipal user, NpgsqlDataSource db, KunlunAuthRepository repo, CancellationToken ct)
    {
        if (!CanSave(user)) return Results.Json(new { error = "需要「补录会员上系统前的数据」权限" }, statusCode: StatusCodes.Status403Forbidden);
        OpeningTicketInput[] tickets = req.Tickets ?? []; OpeningDepositInput[] deposits = req.Deposits ?? []; OpeningHoldingInput[] holdings = req.Holdings ?? [];
        if (tickets.Length + deposits.Length + holdings.Length == 0) throw new BusinessRuleException("请填写要补录的套餐余量、押金或手里的桶袋");
        if (tickets.Length > MaxItems || deposits.Length > MaxItems || holdings.Length > MaxItems) throw new BusinessRuleException("一次补录的条目太多，请分几次录入");
        if (tickets.Where(t => t.BatchId is not null).GroupBy(t => t.BatchId).Any(g => g.Count() > 1)) throw new BusinessRuleException("同一笔余额一次只能改一处");
        if (deposits.GroupBy(d => d.ContainerType).Any(g => g.Count() > 1)) throw new BusinessRuleException("同一种桶袋的押金只能填一次");
        if (holdings.GroupBy(h => h.ContainerType).Any(g => g.Count() > 1)) throw new BusinessRuleException("同一种桶袋手里的个数只能填一次");
        var note = Remarks.Normalize(req.Note, NoteMaxLength);
        // Deposits given as a price each keep the original hash shape, so replays sent before totals existed still match.
        var hash = deposits.Any(d => d.Amount is not null)
            ? ContainerInventory.Hash(new { mid, tickets, deposits, holdings, note })
            : ContainerInventory.Hash(new { mid, tickets, deposits = deposits.Select(d => new { d.ContainerType, d.Quantity, d.UnitPrice }), holdings, note });
        var tid = repo.DefaultTenantId; var actor = Actor(user);

        await using var conn = await db.OpenConnectionAsync(ct);
        await using var tx = await conn.BeginTransactionAsync(ct);
        await LockRequest(conn, tx, tid, "member-opening", req.IdempotencyKey, ct);
        await using (var replay = Command(conn, tx, "SELECT request_hash,receipt::text FROM plugin_kunlun_waterstation.member_opening_entries WHERE tenant_id=@tid AND idempotency_key=@key", ("tid", tid), ("key", req.IdempotencyKey)))
        await using (var r = await replay.ExecuteReaderAsync(ct))
            if (await r.ReadAsync(ct))
            {
                if (r.GetString(0) != hash) throw new BusinessRuleException("请求标识已用于其他补录", 409);
                return Results.Ok(JsonSerializer.Deserialize<JsonElement>(r.GetString(1)));
            }
        // Same lock order as every money path: the request, then the member, then the batches and lots it touches.
        await LockMember(conn, tx, tid, mid, ct);
        DateTime since;
        await using (var joined = Command(conn, tx, "SELECT created_at FROM plugin_kunlun_waterstation.members WHERE tenant_id=@tid AND id=@mid", ("tid", tid), ("mid", mid)))
            since = (DateTime)(await joined.ExecuteScalarAsync(ct))!;

        var id = Guid.NewGuid();
        var no = await BusinessNumbers.OpeningNo(conn, tx, ct);
        var entry = new Entry(conn, tx, tid, mid, since, id, no, actor, note);
        var items = new List<object>();
        foreach (var t in tickets) if (await (t.BatchId is { } batch ? entry.ChangeTickets(batch, t, ct) : entry.AddTickets(t, ct)) is { } item) items.Add(item);
        foreach (var d in deposits) if (await entry.SetDeposit(d, ct) is { } item) items.Add(item);
        foreach (var h in holdings) if (await entry.SetHolding(h, ct) is { } item) items.Add(item);
        if (items.Count == 0) throw new BusinessRuleException("填的和现在记的一样，没有需要修改的");

        var receipt = new { id, entryNo = no, memberId = mid, note, operatorName = actor, createdAt = DateTimeOffset.UtcNow, items };
        var json = ContainerInventory.Json(receipt);
        await Exec(conn, tx, """
            INSERT INTO plugin_kunlun_waterstation.member_opening_entries(id,tenant_id,entry_no,idempotency_key,request_hash,member_id,note,operator_id,operator_name,receipt)
            VALUES(@id,@tid,@no,@key,@hash,@mid,@note,@operator,@actor,@receipt::jsonb)
            """, ct, ("id", id), ("tid", tid), ("no", no), ("key", req.IdempotencyKey), ("hash", hash), ("mid", mid), ("note", (object?)note ?? DBNull.Value),
            ("operator", Guid.Parse(user.FindFirstValue("sub")!)), ("actor", actor), ("receipt", json));
        await tx.CommitAsync(ct);
        return Results.Ok(JsonSerializer.Deserialize<JsonElement>(json));
    }

    /// <summary>One opening entry being written inside its transaction; the member row is locked.</summary>
    private sealed class Entry(NpgsqlConnection conn, NpgsqlTransaction tx, Guid tid, Guid mid, DateTime since, Guid id, string no, string actor, string? note)
    {
        /// <summary>A package bought before the system becomes an OPENING batch dated when the member joined, so it is used first.</summary>
        public async Task<object?> AddTickets(OpeningTicketInput t, CancellationToken ct)
        {
            if (t.Remove) throw new BusinessRuleException("要删除的余额须指明是哪一笔");
            if (t.FulfillMode is not ("PICKUP" or "DELIVERY")) throw new BusinessRuleException("请选择是自提票还是配送票");
            var product = await WaterProducts.Read(conn, tx, tid, t.WaterType ?? "", ct);
            var unit = product.Unit;
            if (t.Remaining is < 1 or > MaxQty) throw new BusinessRuleException($"现在还剩几{unit}要在 1 到 {MaxQty} 之间");
            var priced = t.PaidAmount != 0;
            if (priced && (t.PaidAmount < 0 || t.PaidAmount > 99999999 || decimal.Round(t.PaidAmount, 2) != t.PaidAmount))
                throw new BusinessRuleException("当时实付的金额要大于 0、精确到分；不清楚就选「套餐不清楚」");
            if (priced && t.PackageQty is < 1 or > MaxQty) throw new BusinessRuleException($"请填写这个套餐一共多少{unit}");
            if (priced && t.Remaining > t.PackageQty) throw new BusinessRuleException($"还剩的不能比套餐的 {t.PackageQty} {unit}多");
            string? planName = null;
            if (t.PlanId is { } planId)
            {
                await using var cmd = Command(conn, tx, "SELECT name,water_type,fulfill_mode FROM plugin_kunlun_waterstation.recharge_plans WHERE tenant_id=@tid AND id=@id", ("tid", tid), ("id", planId));
                await using var r = await cmd.ExecuteReaderAsync(ct);
                if (!await r.ReadAsync(ct)) throw new BusinessRuleException("选的套餐不存在", 404);
                if (r.GetString(1) != product.WaterType || r.GetString(2) != t.FulfillMode) throw new BusinessRuleException("选的套餐和水品、领取方式对不上");
                planName = r.GetString(0);
            }
            var name = priced
                ? $"上系统前 · {product.Name} · {ModeLabel(t.FulfillMode)} {Yuan(t.PaidAmount)} 元 / {t.PackageQty} {unit}"
                : $"上系统前 · {product.Name} · {ModeLabel(t.FulfillMode)}（套餐不清楚）";
            var batchId = Guid.NewGuid();
            var snapshot = new
            {
                entryNo = no, planId = t.PlanId, planName, name, waterLabel = product.Name, fulfillMode = t.FulfillMode,
                paidAmount = priced ? t.PaidAmount : 0, packageQty = priced ? t.PackageQty : (int?)null, note, operatorName = actor, enteredAt = DateTimeOffset.UtcNow
            };
            await Exec(conn, tx, """
                INSERT INTO plugin_kunlun_waterstation.ticket_batches
                  (id,tenant_id,member_id,source,water_type,fulfill_mode,paid_amount,fixed_qty,gift_qty,remaining_buy,remaining_gift,opening_snapshot,created_at)
                VALUES(@id,@tid,@mid,'OPENING',@water,@mode,@paid,@fixed,0,@remaining,0,@snapshot::jsonb,@since)
                """, ct, ("id", batchId), ("tid", tid), ("mid", mid), ("water", product.WaterType), ("mode", t.FulfillMode), ("paid", priced ? t.PaidAmount : 0m),
                ("fixed", priced ? t.PackageQty : t.Remaining), ("remaining", t.Remaining), ("snapshot", ContainerInventory.Json(snapshot)), ("since", since));
            var (balance, _) = await MemberTickets.Add(conn, tx, tid, mid, product.WaterType, t.FulfillMode, t.Remaining, 0, ct);
            await TicketLedger(product.WaterType, t.FulfillMode, "OPENING", t.Remaining, balance, ct);
            return new { kind = "TICKETS", action = "CREATE", batchId, waterType = product.WaterType, name, fulfillMode = t.FulfillMode, unit,
                paidAmount = priced ? t.PaidAmount : 0, packageQty = priced ? t.PackageQty : (int?)null, before = 0, after = t.Remaining };
        }

        /// <summary>Corrects what is left of an opening batch, or drops one nothing has touched yet.</summary>
        public async Task<object?> ChangeTickets(Guid batchId, OpeningTicketInput t, CancellationToken ct)
        {
            string source, water, mode, status, name; decimal paid; int fixedQty, remaining, reserved;
            await using (var cmd = Command(conn, tx, """
                SELECT source,water_type,fulfill_mode,paid_amount,fixed_qty,remaining_buy,reserved_buy,status,COALESCE(opening_snapshot->>'name','')
                FROM plugin_kunlun_waterstation.ticket_batches WHERE tenant_id=@tid AND id=@id AND member_id=@mid FOR UPDATE
                """, ("tid", tid), ("id", batchId), ("mid", mid)))
            await using (var r = await cmd.ExecuteReaderAsync(ct))
            {
                if (!await r.ReadAsync(ct)) throw new BusinessRuleException("要修改的余额不存在", 404);
                source = r.GetString(0); water = r.GetString(1); mode = r.GetString(2); paid = r.GetDecimal(3); fixedQty = r.GetInt32(4);
                remaining = r.GetInt32(5); reserved = r.GetInt32(6); status = r.GetString(7); name = r.GetString(8);
            }
            if (source != Source) throw new BusinessRuleException("这里只能改补录的上系统前余额；系统里充值的水票请走退款");
            if (status != "ACTIVE") throw new BusinessRuleException("这笔余额已经退款，不能再改", 409);
            await using (var pending = Command(conn, tx, "SELECT request_no FROM plugin_kunlun_waterstation.refund_requests WHERE tenant_id=@tid AND batch_id=@id AND status='PENDING'", ("tid", tid), ("id", batchId)))
                if (await pending.ExecuteScalarAsync(ct) is string request) throw new BusinessRuleException($"这笔余额有退款申请 {request} 在审核，处理完再改", 409);
            var unit = (await WaterProducts.Read(conn, tx, tid, water, ct)).Unit;
            if (t.Remove)
            {
                await using (var used = Command(conn, tx, """
                    SELECT EXISTS(SELECT 1 FROM plugin_kunlun_waterstation.order_ticket_allocations WHERE batch_id=@id)
                        OR EXISTS(SELECT 1 FROM plugin_kunlun_waterstation.refund_requests WHERE tenant_id=@tid AND batch_id=@id)
                    """, ("tid", tid), ("id", batchId)))
                    if ((bool)(await used.ExecuteScalarAsync(ct))!)
                        throw new BusinessRuleException("这笔余额已经用来下过单或办过退款，不能删除；可以把还剩的改成实际的数", 409);
                await Exec(conn, tx, "DELETE FROM plugin_kunlun_waterstation.ticket_batches WHERE tenant_id=@tid AND id=@id", ct, ("tid", tid), ("id", batchId));
                var (left, _) = await MemberTickets.Add(conn, tx, tid, mid, water, mode, -remaining, 0, ct);
                await TicketLedger(water, mode, "OPENING_REMOVE", -remaining, left, ct);
                return new { kind = "TICKETS", action = "REMOVE", batchId, waterType = water, name, fulfillMode = mode, unit, before = remaining, after = 0 };
            }
            if (t.Remaining is < 0 or > MaxQty) throw new BusinessRuleException($"还剩几{unit}要在 0 到 {MaxQty} 之间");
            if (t.Remaining < reserved) throw new BusinessRuleException($"有 {reserved} {unit}被未完成的水单占着，还剩的不能少于 {reserved} {unit}", 409);
            // A priced batch keeps its package: refunds pay paid × remaining ÷ package, so more cannot be left than it held.
            if (paid > 0 && t.Remaining > fixedQty) throw new BusinessRuleException($"还剩的不能比套餐的 {fixedQty} {unit}多");
            var delta = t.Remaining - remaining;
            if (delta == 0) return null;
            await Exec(conn, tx, "UPDATE plugin_kunlun_waterstation.ticket_batches SET remaining_buy=@remaining,fixed_qty=GREATEST(fixed_qty,@remaining) WHERE tenant_id=@tid AND id=@id",
                ct, ("remaining", t.Remaining), ("tid", tid), ("id", batchId));
            var (balance, _) = await MemberTickets.Add(conn, tx, tid, mid, water, mode, delta, 0, ct);
            await TicketLedger(water, mode, "OPENING_ADJUST", delta, balance, ct);
            return new { kind = "TICKETS", action = "ADJUST", batchId, waterType = water, name, fulfillMode = mode, unit, before = remaining, after = t.Remaining };
        }

        /// <summary>The member's one opening deposit lot of a container: created, changed or dropped while nothing has refunded, deducted or reserved it.</summary>
        public async Task<object?> SetDeposit(OpeningDepositInput d, CancellationToken ct)
        {
            if (!ProductContainers.ValidId(d.ContainerType) || d.Quantity is < 0 or > MaxContainers) throw new BusinessRuleException("请填写有效的桶袋和押金个数");
            // A total typed in splits evenly over the containers; older clients send the price each.
            var price = d.Quantity == 0 ? 0m
                : d.Amount is { } typed ? Money.UnitPrice(typed, d.Quantity, "")
                : Money.Valid(d.UnitPrice, allowZero: false) ? d.UnitPrice
                : throw new BusinessRuleException("押金金额要大于 0、精确到分");
            await ProductContainers.Require(conn, tx, tid, d.ContainerType, ct);
            (Guid Id, string No, int Qty, decimal Price, decimal Total, bool Touched)? lot = null;
            await using (var cmd = Command(conn, tx, """
                SELECT id,deposit_no,paid_qty,unit_price,total_amount,refunded_qty+deducted_qty+reserved_damage_qty>0
                FROM plugin_kunlun_waterstation.deposit_lots WHERE tenant_id=@tid AND member_id=@mid AND container_type=@type AND source='OPENING' FOR UPDATE
                """, ("tid", tid), ("mid", mid), ("type", d.ContainerType)))
            await using (var r = await cmd.ExecuteReaderAsync(ct))
                if (await r.ReadAsync(ct)) lot = (r.GetGuid(0), r.GetString(1), r.GetInt32(2), r.GetDecimal(3), r.GetDecimal(4), r.GetBoolean(5));
            var total = d.Quantity * price;
            if (lot is null)
            {
                if (d.Quantity == 0) return null;
                var depositNo = await BusinessNumbers.DepositNo(conn, tx, ct);
                await Exec(conn, tx, """
                    INSERT INTO plugin_kunlun_waterstation.deposit_lots
                      (id,tenant_id,deposit_no,idempotency_key,member_id,container_type,unit_price,paid_qty,refunded_qty,remaining_qty,total_amount,pay_method,operator_name,source,created_at)
                    VALUES(@id,@tid,@no,@key,@mid,@type,@price,@qty,0,@qty,@total,'OPENING',@actor,'OPENING',@since)
                    """, ct, ("id", Guid.NewGuid()), ("tid", tid), ("no", depositNo), ("key", $"opening:{id:N}:{d.ContainerType}"), ("mid", mid), ("type", d.ContainerType),
                    ("price", price), ("qty", d.Quantity), ("total", total), ("actor", actor), ("since", since));
                await AddDeposit(total, ct);
                return new { kind = "DEPOSIT", action = "CREATE", containerType = d.ContainerType, depositNo, before = (object?)null, after = new { quantity = d.Quantity, unitPrice = price, amount = total } };
            }
            var (lotId, no2, qty, oldPrice, oldTotal, touched) = lot.Value;
            if (d.Quantity == qty && price == oldPrice) return null;
            if (touched) throw new BusinessRuleException("上系统前的这笔押金已经退过或报废扣过，不能再改；要退押金请走「退押金」", 409);
            await using (var pending = Command(conn, tx, "SELECT request_no FROM plugin_kunlun_waterstation.refund_requests WHERE tenant_id=@tid AND member_id=@mid AND kind='DEPOSIT' AND container_type=@type AND status='PENDING'", ("tid", tid), ("mid", mid), ("type", d.ContainerType)))
                if (await pending.ExecuteScalarAsync(ct) is string request) throw new BusinessRuleException($"这种桶袋有退押金申请 {request} 在审核，处理完再改", 409);
            var before = new { quantity = qty, unitPrice = oldPrice, amount = oldTotal };
            if (d.Quantity == 0)
            {
                await Exec(conn, tx, "DELETE FROM plugin_kunlun_waterstation.deposit_lots WHERE tenant_id=@tid AND id=@id", ct, ("tid", tid), ("id", lotId));
                await AddDeposit(-oldTotal, ct);
                return new { kind = "DEPOSIT", action = "REMOVE", containerType = d.ContainerType, depositNo = no2, before, after = (object?)null };
            }
            await Exec(conn, tx, "UPDATE plugin_kunlun_waterstation.deposit_lots SET unit_price=@price,paid_qty=@qty,remaining_qty=@qty,total_amount=@total WHERE tenant_id=@tid AND id=@id",
                ct, ("price", price), ("qty", d.Quantity), ("total", total), ("tid", tid), ("id", lotId));
            await AddDeposit(total - oldTotal, ct);
            return new { kind = "DEPOSIT", action = "ADJUST", containerType = d.ContainerType, depositNo = no2, before, after = new { quantity = d.Quantity, unitPrice = price, amount = total } };
        }

        /// <summary>
        /// Writes down how many of a container the member holds now. Nothing moves between the store and customers, so 店里 stays;
        /// what is registered to members is at customers, so 客户手里 is raised to it when it was counted lower.
        /// </summary>
        public async Task<object?> SetHolding(OpeningHoldingInput h, CancellationToken ct)
        {
            if (!ProductContainers.ValidId(h.ContainerType) || h.Quantity is < 0 or > MaxContainers) throw new BusinessRuleException("请填写有效的桶袋和手里的个数");
            var held = await ProductContainers.Held(conn, tx, tid, mid, h.ContainerType, ct);
            var delta = h.Quantity - held;
            if (delta == 0) return null;
            if (await Exec(conn, tx, """
                UPDATE plugin_kunlun_waterstation.container_configs
                SET member_held_qty=member_held_qty+@delta,
                    with_customers_qty=GREATEST(with_customers_qty,member_held_qty+@delta),
                    total_qty=in_station_qty+GREATEST(with_customers_qty,member_held_qty+@delta)+damaged_qty
                WHERE tenant_id=@tid AND container_type=@type AND member_held_qty+@delta>=0
                """, ct, ("delta", delta), ("tid", tid), ("type", h.ContainerType)) != 1)
                throw new BusinessRuleException("会员持有桶袋的汇总需要核对，请联系管理员");
            await ProductContainers.SetHeld(conn, tx, tid, mid, h.ContainerType, h.Quantity, ct);
            await using var coverage = Command(conn, tx, "SELECT COALESCE(sum(remaining_qty-reserved_damage_qty),0) FROM plugin_kunlun_waterstation.deposit_lots WHERE tenant_id=@tid AND member_id=@mid AND container_type=@type", ("tid", tid), ("mid", mid), ("type", h.ContainerType));
            var covered = Convert.ToInt32(await coverage.ExecuteScalarAsync(ct));
            await Exec(conn, tx, """
                INSERT INTO plugin_kunlun_waterstation.container_ledgers
                  (tenant_id,ledger_no,member_id,container_type,order_no,full_out_qty,empty_in_qty,delta_held,held_after,covered_deposit_qty_after,operator_name,remark,business_type)
                VALUES(@tid,@ledger,@mid,@type,@no,0,0,@delta,@held,@covered,@actor,@remark,'OPENING')
                """, ct, ("tid", tid), ("ledger", "CL" + Guid.NewGuid().ToString("N")[..28]), ("mid", mid), ("type", h.ContainerType), ("no", no),
                ("delta", delta), ("held", h.Quantity), ("covered", covered), ("actor", actor), ("remark", note ?? "补录上系统前手里的桶袋"));
            return new { kind = "HOLDING", action = "SET", containerType = h.ContainerType, before = held, after = h.Quantity, coveredQty = covered };
        }

        // members.deposit_amount is the summary older read-only clients show; lots stay the source of truth.
        private Task<int> AddDeposit(decimal amount, CancellationToken ct) =>
            Exec(conn, tx, "UPDATE plugin_kunlun_waterstation.members SET deposit_amount=GREATEST(0,deposit_amount+@amount) WHERE tenant_id=@tid AND id=@mid", ct, ("amount", amount), ("tid", tid), ("mid", mid));

        private Task<int> TicketLedger(string water, string mode, string kind, int delta, int balance, CancellationToken ct) => Exec(conn, tx, """
            INSERT INTO plugin_kunlun_waterstation.ticket_ledgers(tenant_id,ledger_no,member_id,water_type,fulfill_mode,change_type,delta_qty,balance_after,ref_no,operator_name)
            VALUES(@tid,@ledger,@mid,@water,@mode,@kind,@delta,@balance,@no,@actor)
            """, ct, ("tid", tid), ("ledger", "TL" + Guid.NewGuid().ToString("N")[..28]), ("mid", mid), ("water", water), ("mode", mode), ("kind", kind),
            ("delta", delta), ("balance", balance), ("no", no), ("actor", actor));
    }
}
