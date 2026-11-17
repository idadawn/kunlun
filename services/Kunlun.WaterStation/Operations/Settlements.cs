using System.Security.Claims;
using System.Text.Json;
using Kunlun.WaterStation.Auth;
using Npgsql;
using static Kunlun.WaterStation.Operations.TicketBatches;

namespace Kunlun.WaterStation.Operations;

/// <summary>
/// One container of a settlement. Of what the member holds, Returned came back good and Damaged came back broken; the rest stays
/// out. WaiveDamage: the station bears the broken ones, so their deposit is not kept. Unreturned decides the rest: CHARGE writes them
/// off and keeps their deposit, charging the standard deposit for any without one; KEEP leaves them with the member to bring back
/// later, turning any deposit they owe into deposit paid from the refund.
/// </summary>
public sealed record SettlementContainerInput(string ContainerType, int Returned, int Damaged = 0, bool WaiveDamage = false, string Unreturned = "CHARGE");

/// <summary>
/// Containers left out count as all returned good. Amount: what is actually paid back (negative: what the member pays), the computed
/// total when left out. ExpectedAmount: the computed total the counter was shown; if the books moved since, the settlement is refused
/// rather than paying a different sum.
/// </summary>
public sealed record SettlementRequest(string IdempotencyKey, string PayMethod, SettlementContainerInput[]? Containers = null,
    decimal? Amount = null, decimal? ExpectedAmount = null, string? Reason = null);

public sealed record SettlementPreviewRequest(SettlementContainerInput[]? Containers = null, decimal? Amount = null);

/// <summary>
/// 退款结算：会员不再订水或搬走时，一张退款单结清剩余水票、押金和手里的桶袋。
/// <list type="bullet">
/// <item>水票：每个有原价的在用批次按原实付单价退剩余付费票，赠票收回；没有原价的不动。</item>
/// <item>桶袋：还回好的退押金；坏的默认扣押金（可选水站承担）；没还的选「不还了」就扣下押金，没交押金的按现行押金标准从退款里扣，
/// 选「以后还」就留在会员手里，欠的押金从退款里转成押金，以后还回再退。</item>
/// <item>实退金额默认等于应退合计，可以改：差额先记在水费退款上（每笔不超过原实付），少退的再从退押金里扣（记为扣押金）。</item>
/// </list>
/// 结算在一个事务里完成，每笔水费、押金退款照常入账并在「审核」里留一条已通过的记录；没交押金要扣的，先按标准记一笔收押金
/// （收付方式同结算），再报废扣下，所以押金账和现金都对得上。只有能审核水费和押金退款的人可以办理。
/// </summary>
public static class Settlements
{
    private const int ReasonMaxLength = 200;
    private static bool Has(ClaimsPrincipal u, string perm) =>
        u.FindFirstValue("subject_type") == "STAFF" && (u.HasClaim("perm", perm) || u.HasClaim("perm", "kunlun.waterstation:*"));
    public static bool CanSettle(ClaimsPrincipal u) => Has(u, KunlunPermissions.RechargeRefund) && Has(u, KunlunPermissions.DepositRefundApprove);
    private static string Actor(ClaimsPrincipal u) => u.FindFirstValue("display_name") ?? "管理员";
    private static bool Payment(string? value) => value is "CASH" or "WECHAT" or "ALIPAY" or "BANK";
    private static IResult Denied() => Results.Json(new { error = "退款结算要由能审核水费和押金退款的管理员办理" }, statusCode: StatusCodes.Status403Forbidden);

    public static async Task EnsureSchema(NpgsqlDataSource db, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var tx = await conn.BeginTransactionAsync(ct);
        await Exec(conn, tx, """
            SELECT pg_advisory_xact_lock(88482026);
            CREATE TABLE IF NOT EXISTS plugin_kunlun_waterstation.member_settlements (
              id UUID PRIMARY KEY, tenant_id UUID NOT NULL, settlement_no VARCHAR(32) NOT NULL UNIQUE,
              idempotency_key VARCHAR(80) NOT NULL, request_hash VARCHAR(64) NOT NULL,
              member_id UUID NOT NULL REFERENCES plugin_kunlun_waterstation.members(id),
              computed_amount NUMERIC(10,2) NOT NULL, amount NUMERIC(10,2) NOT NULL, pay_method VARCHAR(24) NOT NULL,
              reason VARCHAR(200) NOT NULL DEFAULT '', operator_id UUID NOT NULL, operator_name VARCHAR(64) NOT NULL,
              receipt JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
              UNIQUE(tenant_id, idempotency_key)
            );
            CREATE INDEX IF NOT EXISTS member_settlements_member ON plugin_kunlun_waterstation.member_settlements(tenant_id, member_id, created_at DESC);
            """, ct);
        await tx.CommitAsync(ct);
    }

    public static void MapSettlements(this WebApplication app)
    {
        app.MapGet("/api/members/{mid:guid}/settlements", List).RequireAuthorization();
        app.MapPost("/api/members/{mid:guid}/settlement/preview", Preview).RequireAuthorization();
        app.MapPost("/api/members/{mid:guid}/settlement", Settle).RequireAuthorization();
    }

    /// <summary>The member's settlement slips, newest first.</summary>
    private static async Task<IResult> List(Guid mid, ClaimsPrincipal user, NpgsqlDataSource db, KunlunAuthRepository repo, CancellationToken ct)
    {
        if (!Has(user, KunlunPermissions.MemberRead)) return Results.Forbid();
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = Command(conn, null, "SELECT receipt::text FROM plugin_kunlun_waterstation.member_settlements WHERE tenant_id=@tid AND member_id=@mid ORDER BY created_at DESC,id DESC LIMIT 50",
            ("tid", repo.DefaultTenantId), ("mid", mid));
        var rows = new List<JsonElement>();
        await using var r = await cmd.ExecuteReaderAsync(ct);
        while (await r.ReadAsync(ct)) rows.Add(JsonSerializer.Deserialize<JsonElement>(r.GetString(0)));
        return Results.Ok(rows);
    }

    /// <summary>What settling with these choices would pay, line by line, without changing anything; problems come back as blockers.</summary>
    private static async Task<IResult> Preview(Guid mid, SettlementPreviewRequest req, ClaimsPrincipal user, NpgsqlDataSource db, KunlunAuthRepository repo, CancellationToken ct)
    {
        if (!CanSettle(user)) return Denied();
        await using var conn = await db.OpenConnectionAsync(ct);
        var plan = await Build(conn, null, repo.DefaultTenantId, mid, req.Containers, ct);
        string? amountError = null;
        try { Distribute(plan, req.Amount ?? plan.Computed); }
        catch (BusinessRuleException e) { amountError = e.Message; Distribute(plan, plan.Computed); }
        return Results.Ok(new { slip = Slip(plan, null), range = new { min = plan.Min, max = plan.Max }, amountError, blockers = plan.Blockers });
    }

    private static async Task<IResult> Settle(Guid mid, SettlementRequest req, ClaimsPrincipal user, NpgsqlDataSource db, KunlunAuthRepository repo, CancellationToken ct)
    {
        if (!CanSettle(user)) return Denied();
        if (!Payment(req.PayMethod)) throw new BusinessRuleException("请选择退款方式");
        var reason = Remarks.Normalize(req.Reason, ReasonMaxLength) ?? "";
        var containers = req.Containers ?? [];
        var hash = ContainerInventory.Hash(new
        {
            mid, req.PayMethod, reason, amount = req.Amount is { } a ? Money.Text(a) : null,
            containers = containers.OrderBy(c => c.ContainerType, StringComparer.Ordinal).Select(c => new { c.ContainerType, c.Returned, c.Damaged, c.WaiveDamage, c.Unreturned })
        });
        var tid = repo.DefaultTenantId; var actor = Actor(user);

        await using var conn = await db.OpenConnectionAsync(ct);
        await using var tx = await conn.BeginTransactionAsync(ct);
        await LockRequest(conn, tx, tid, "settlement", req.IdempotencyKey, ct);
        await using (var replay = Command(conn, tx, "SELECT request_hash,receipt::text FROM plugin_kunlun_waterstation.member_settlements WHERE tenant_id=@tid AND idempotency_key=@key", ("tid", tid), ("key", req.IdempotencyKey)))
        await using (var r = await replay.ExecuteReaderAsync(ct))
            if (await r.ReadAsync(ct))
            {
                if (r.GetString(0) != hash) throw new BusinessRuleException("请求标识已用于其他退款结算", 409);
                return Results.Ok(JsonSerializer.Deserialize<JsonElement>(r.GetString(1)));
            }
        // Same lock order as every money path: the request, then the member, then the batches, lots and stock it touches.
        await LockMember(conn, tx, tid, mid, ct);
        var plan = await Build(conn, tx, tid, mid, containers, ct);
        if (plan.Blockers.Count > 0) throw new BusinessRuleException(plan.Blockers[0], 409);
        if (req.ExpectedAmount is { } expected && expected != plan.Computed)
            throw new BusinessRuleException($"账目刚有变化：现在应退 ¥{Money.Text(plan.Computed)}（刚才是 ¥{Money.Text(expected)}），请核对后再确认", 409);
        Distribute(plan, req.Amount ?? plan.Computed);

        var id = Guid.NewGuid();
        var no = await BusinessNumbers.SettlementNo(conn, tx, ct);
        var note = $"退款结算 {no}";
        foreach (var c in plan.Containers) await SettleContainer(conn, tx, tid, mid, id, no, note, req.PayMethod, reason, c, user, ct);
        foreach (var t in plan.Tickets)
        {
            var refund = await MembershipEndpoints.ExecuteRechargeRefund(conn, tx, tid, t.BatchId, req.PayMethod, reason, $"settlement:{id:N}:{t.BatchId:N}", actor, ct, t.Amount);
            await RefundRequests.RecordDirect(conn, tx, tid, "RECHARGE", mid, null, null, t.BatchId, req.PayMethod, reason, refund.RefundNo, refund.Amount, actor, ct, t.Value, note);
            t.RefundNo = refund.RefundNo;
        }

        var receipt = Slip(plan, new SlipHeader(id, no, req.PayMethod, reason, actor, DateTimeOffset.UtcNow));
        var json = ContainerInventory.Json(receipt);
        await Exec(conn, tx, """
            INSERT INTO plugin_kunlun_waterstation.member_settlements
              (id,tenant_id,settlement_no,idempotency_key,request_hash,member_id,computed_amount,amount,pay_method,reason,operator_id,operator_name,receipt)
            VALUES(@id,@tid,@no,@key,@hash,@mid,@computed,@amount,@pay,@reason,@operator,@actor,@receipt::jsonb)
            """, ct, ("id", id), ("tid", tid), ("no", no), ("key", req.IdempotencyKey), ("hash", hash), ("mid", mid), ("computed", plan.Computed),
            ("amount", plan.Amount), ("pay", req.PayMethod), ("reason", reason), ("operator", Guid.Parse(user.FindFirstValue("sub")!)), ("actor", actor), ("receipt", json));
        await tx.CommitAsync(ct);
        return Results.Ok(JsonSerializer.Deserialize<JsonElement>(json));
    }

    /// <summary>
    /// Carries out one container's part in the order the plan assumed: deposit for containers without one, the good ones back, the broken
    /// ones scrapped, the ones not coming back written off, then the rest of the deposit refunded, each from the oldest lots first.
    /// </summary>
    private static async Task SettleContainer(NpgsqlConnection conn, NpgsqlTransaction tx, Guid tid, Guid mid, Guid id, string no, string note,
        string pay, string reason, ContainerLine c, ClaimsPrincipal user, CancellationToken ct)
    {
        var actor = Actor(user);
        var key = $"settlement:{id:N}:{c.ContainerType}";
        if (c.OffsetQty > 0)
        {
            c.OffsetNo = await BusinessNumbers.DepositNo(conn, tx, ct);
            await Exec(conn, tx, """
                INSERT INTO plugin_kunlun_waterstation.deposit_lots
                  (id,tenant_id,deposit_no,idempotency_key,member_id,container_type,unit_price,paid_qty,refunded_qty,remaining_qty,total_amount,pay_method,operator_name,source)
                VALUES(@id,@tid,@no,@key,@mid,@type,@price,@qty,0,@qty,@total,@pay,@actor,'SETTLEMENT')
                """, ct, ("id", Guid.NewGuid()), ("tid", tid), ("no", c.OffsetNo), ("key", key + ":deposit"), ("mid", mid), ("type", c.ContainerType),
                ("price", c.UnitDeposit), ("qty", c.OffsetQty), ("total", c.OffsetAmount), ("pay", pay), ("actor", actor));
            await Exec(conn, tx, "UPDATE plugin_kunlun_waterstation.members SET deposit_amount=deposit_amount+@amount WHERE tenant_id=@tid AND id=@mid", ct,
                ("amount", c.OffsetAmount), ("tid", tid), ("mid", mid));
        }
        if (c.Returned > 0) await TakeBack(conn, tx, tid, mid, c.ContainerType, c.Returned, no, actor, ct);
        if (c.Damaged > 0)
        {
            var damage = await ContainerCirculation.RecordDamage(conn, tx, tid, mid, c.ContainerType, c.Damaged, $"{note}：还回时坏了",
                key + ":damage", "", acceptUncovered: c.WaiveDamage, c.WaiveDamage ? "结算时坏的不扣押金，水站承担" : "", user, ct);
            var scrap = await ContainerCirculation.Scrap(conn, tx, tid, mid, damage.Id, c.WaiveDamage ? $"{note}：坏的不扣押金，水站承担" : $"{note}：坏的扣押金",
                c.WaiveDamage, key + ":damage-scrap", "", user, ct);
            if (scrap.DeductedAmount != c.DamageDeducted) throw Moved();
            c.ScrapNos.Add(scrap.ScrapNo);
        }
        if (c.Unreturned > 0 && c.Mode == "CHARGE")
        {
            var lost = await ContainerCirculation.RecordDamage(conn, tx, tid, mid, c.ContainerType, c.Unreturned, $"{note}：没还回，押金不退",
                key + ":kept", "", acceptUncovered: false, "", user, ct);
            var scrap = await ContainerCirculation.Scrap(conn, tx, tid, mid, lost.Id, $"{note}：没还回，押金不退", false, key + ":kept-scrap", "", user, ct);
            if (scrap.DeductedAmount != c.ChargeDeducted) throw Moved();
            c.ScrapNos.Add(scrap.ScrapNo);
        }
        if (c.RefundQty > 0)
        {
            var refund = await FinanceEndpoints.ExecuteDepositRefund(conn, tx, tid, mid, c.ContainerType, c.RefundQty, pay, key, actor, ct, c.RefundAmount);
            if (refund.Value != c.RefundValue) throw Moved();
            await RefundRequests.RecordDirect(conn, tx, tid, "DEPOSIT", mid, c.ContainerType, c.RefundQty, null, pay, reason, refund.RefundNo, refund.Amount, actor, ct, refund.Value, note);
            c.RefundNo = refund.RefundNo;
        }
    }

    private static BusinessRuleException Moved() => new("押金账刚有变化，请关掉重新打开结算", 409);

    /// <summary>Good containers handed back: they leave the member and return to the store. The caller holds the member lock.</summary>
    private static async Task TakeBack(NpgsqlConnection conn, NpgsqlTransaction tx, Guid tid, Guid mid, string type, int qty, string no, string actor, CancellationToken ct)
    {
        var held = await ProductContainers.Held(conn, tx, tid, mid, type, ct);
        if (qty > held) throw new BusinessRuleException("还回的比会员手里的多，请核对数量");
        if (!await ContainerInventory.MoveToMembers(conn, tx, tid, type, -qty, ct)) throw new BusinessRuleException("会员持有桶袋的汇总需要核对，请联系管理员");
        await ProductContainers.SetHeld(conn, tx, tid, mid, type, held - qty, ct);
        await using var cover = Command(conn, tx, "SELECT COALESCE(sum(remaining_qty-reserved_damage_qty),0) FROM plugin_kunlun_waterstation.deposit_lots WHERE tenant_id=@tid AND member_id=@mid AND container_type=@type",
            ("tid", tid), ("mid", mid), ("type", type));
        var covered = Convert.ToInt32(await cover.ExecuteScalarAsync(ct));
        await Exec(conn, tx, """
            INSERT INTO plugin_kunlun_waterstation.container_ledgers(tenant_id,ledger_no,member_id,container_type,order_no,full_out_qty,empty_in_qty,delta_held,held_after,covered_deposit_qty_after,operator_name,remark)
            VALUES(@tid,@ledger,@mid,@type,@no,0,@qty,@delta,@held,@covered,@actor,'退款结算还回')
            """, ct, ("tid", tid), ("ledger", "CL" + Guid.NewGuid().ToString("N")[..28]), ("mid", mid), ("type", type), ("no", no), ("qty", qty),
            ("delta", -qty), ("held", held - qty), ("covered", covered), ("actor", actor));
    }

    // ---- The plan: what each ticket batch and container works out to, shared by the preview and the settlement itself. ----

    private sealed record LotRow(decimal Price, int Available);

    private sealed class TicketLine
    {
        public Guid BatchId { get; init; }
        public string Name { get; init; } = "";
        public string WaterType { get; init; } = "";
        public string Unit { get; init; } = "";
        public int RemainingBuy { get; init; }
        public int RemainingGift { get; init; }
        /// <summary>The remaining paid tickets at the original price.</summary>
        public decimal Value { get; init; }
        /// <summary>What the recharge took in: the most it may pay back.</summary>
        public decimal Paid { get; init; }
        public decimal Amount { get; set; }
        public string? RefundNo { get; set; }
    }

    private sealed class ContainerLine
    {
        public string ContainerType { get; init; } = "";
        public string Name { get; init; } = "";
        public string Unit { get; init; } = "";
        public decimal UnitDeposit { get; init; }
        public int Held { get; init; }
        public List<LotRow> Lots { get; init; } = [];
        public int Covered => Lots.Sum(l => l.Available);
        public int PendingDamageQty { get; init; }
        public decimal PendingDamageAmount { get; init; }
        public int Returned { get; set; }
        public int Damaged { get; set; }
        public bool WaiveDamage { get; set; }
        public int Unreturned { get; set; }
        public string Mode { get; set; } = "CHARGE";
        /// <summary>Containers without a deposit that must have one (to deduct, or to stay out): added at the standard price from the refund.</summary>
        public int OffsetQty { get; set; }
        public decimal OffsetAmount { get; set; }
        public decimal DamageDeducted { get; set; }
        /// <summary>Broken ones the station bears that never had a deposit.</summary>
        public int DamageUncovered { get; set; }
        public decimal ChargeDeducted { get; set; }
        public int KeptQty { get; set; }
        public decimal KeptDeposit { get; set; }
        public int RefundQty { get; set; }
        public decimal RefundValue { get; set; }
        public decimal RefundAmount { get; set; }
        public string? RefundNo { get; set; }
        public string? OffsetNo { get; set; }
        public List<string> ScrapNos { get; } = [];
    }

    private sealed class Plan
    {
        public Guid MemberId { get; init; }
        public string MemberName { get; init; } = "";
        public string MemberNo { get; init; } = "";
        public List<TicketLine> Tickets { get; } = [];
        public List<ContainerLine> Containers { get; } = [];
        public List<string> Blockers { get; } = [];
        public List<string> Notes { get; } = [];
        public decimal Computed => Tickets.Sum(t => t.Value) + Containers.Sum(c => c.RefundValue - c.OffsetAmount);
        /// <summary>Every refund down to nothing; the deposit owed is still taken.</summary>
        public decimal Min => -Containers.Sum(c => c.OffsetAmount);
        /// <summary>Every water refund up to what its recharge took in.</summary>
        public decimal Max => Computed + Tickets.Sum(t => t.Paid - t.Value);
        public decimal Amount { get; set; }
    }

    private sealed record SlipHeader(Guid Id, string No, string PayMethod, string Reason, string OperatorName, DateTimeOffset CreatedAt);

    private static async Task<Plan> Build(NpgsqlConnection conn, NpgsqlTransaction? tx, Guid tid, Guid mid, SettlementContainerInput[]? inputs, CancellationToken ct)
    {
        Plan plan;
        await using (var cmd = Command(conn, tx, "SELECT name,member_no,status FROM plugin_kunlun_waterstation.members WHERE tenant_id=@tid AND id=@mid", ("tid", tid), ("mid", mid)))
        await using (var r = await cmd.ExecuteReaderAsync(ct))
        {
            if (!await r.ReadAsync(ct)) throw new BusinessRuleException("会员不存在", 404);
            plan = new Plan { MemberId = mid, MemberName = r.GetString(0), MemberNo = r.GetString(1) };
            if (r.GetString(2) != "ACTIVE") plan.Blockers.Add("会员已停用，请先重新启用再结算");
        }
        await using (var cmd = Command(conn, tx, "SELECT order_no FROM plugin_kunlun_waterstation.water_orders WHERE tenant_id=@tid AND member_id=@mid AND status NOT IN ('COMPLETED','CANCELLED') ORDER BY created_at LIMIT 1", ("tid", tid), ("mid", mid)))
            if (await cmd.ExecuteScalarAsync(ct) is string order) plan.Blockers.Add($"有没完成的水单 {order}，请先完成或取消再结算");
        await using (var cmd = Command(conn, tx, "SELECT request_no FROM plugin_kunlun_waterstation.refund_requests WHERE tenant_id=@tid AND member_id=@mid AND kind IN ('DEPOSIT','RECHARGE') AND status='PENDING' ORDER BY created_at LIMIT 1", ("tid", tid), ("mid", mid)))
            if (await cmd.ExecuteScalarAsync(ct) is string request) plan.Blockers.Add($"有退款申请 {request} 在审核，处理完再结算");

        var units = (await WaterProducts.List(conn, tid, ct)).ToDictionary(p => p.WaterType, p => p.Unit);
        var unpriced = 0;
        await using (var cmd = Command(conn, tx, """
            SELECT b.id,b.source,b.water_type,b.paid_amount,b.fixed_qty,b.remaining_buy,b.remaining_gift,
                   COALESCE(r.plan_snapshot->>'name',b.opening_snapshot->>'name','历史余额')
            FROM plugin_kunlun_waterstation.ticket_batches b LEFT JOIN plugin_kunlun_waterstation.recharge_orders r ON r.id=b.recharge_id
            WHERE b.tenant_id=@tid AND b.member_id=@mid AND b.status='ACTIVE' AND b.remaining_buy+b.remaining_gift>0
            ORDER BY b.created_at,b.id
            """, ("tid", tid), ("mid", mid)))
        await using (var r = await cmd.ExecuteReaderAsync(ct))
            while (await r.ReadAsync(ct))
            {
                string source = r.GetString(1); decimal paid = r.GetDecimal(3); int buy = r.GetInt32(5), gift = r.GetInt32(6);
                if (!MembershipEndpoints.Priced(source, paid)) { unpriced += buy + gift; continue; }
                var value = MembershipEndpoints.RemainingValue(source, "ACTIVE", paid, buy, r.GetInt32(4));
                plan.Tickets.Add(new TicketLine
                {
                    BatchId = r.GetGuid(0), Name = r.GetString(7), WaterType = r.GetString(2), Unit = units.GetValueOrDefault(r.GetString(2), "桶"),
                    RemainingBuy = buy, RemainingGift = gift, Value = value, Paid = paid, Amount = value
                });
            }
        if (unpriced > 0) plan.Notes.Add($"另有 {unpriced} 张水票没有原价（历史余额或套餐不清楚），这次不退也不动");

        foreach (var product in await WaterProducts.List(conn, tid, ct))
        {
            var type = product.ContainerId;
            var held = await ProductContainers.Held(conn, tx, tid, mid, type, ct);
            var lots = new List<LotRow>();
            await using (var cmd = Command(conn, tx, """
                SELECT unit_price,remaining_qty-reserved_damage_qty FROM plugin_kunlun_waterstation.deposit_lots
                WHERE tenant_id=@tid AND member_id=@mid AND container_type=@type AND remaining_qty>reserved_damage_qty ORDER BY created_at,id
                """, ("tid", tid), ("mid", mid), ("type", type)))
            await using (var r = await cmd.ExecuteReaderAsync(ct))
                while (await r.ReadAsync(ct)) lots.Add(new LotRow(r.GetDecimal(0), r.GetInt32(1)));
            int pendingQty; decimal pendingAmount;
            await using (var cmd = Command(conn, tx, "SELECT COALESCE(sum(quantity),0),COALESCE(sum(deposit_amount),0) FROM plugin_kunlun_waterstation.container_damages WHERE tenant_id=@tid AND member_id=@mid AND container_type=@type AND status='PENDING'",
                ("tid", tid), ("mid", mid), ("type", type)))
            await using (var r = await cmd.ExecuteReaderAsync(ct)) { await r.ReadAsync(ct); pendingQty = Convert.ToInt32(r.GetValue(0)); pendingAmount = r.GetDecimal(1); }
            if (pendingQty > 0) plan.Notes.Add($"{product.Name}另有 {pendingQty} 个坏{product.Unit}等报废，押金 ¥{Money.Text(pendingAmount)} 先不退，到桶袋台账报废时再定");
            if (held == 0 && lots.Count == 0) continue;
            plan.Containers.Add(new ContainerLine
            {
                ContainerType = type, Name = product.Name, Unit = product.Unit, UnitDeposit = product.UnitDeposit, Held = held, Lots = lots,
                PendingDamageQty = pendingQty, PendingDamageAmount = pendingAmount
            });
        }

        foreach (var input in inputs ?? [])
            if (plan.Containers.All(c => c.ContainerType != input.ContainerType)) throw new BusinessRuleException("这位会员没有这种桶袋可结算，请刷新后再试");
        foreach (var c in plan.Containers) PlanContainer(c, inputs?.FirstOrDefault(i => i.ContainerType == c.ContainerType));
        if (plan.Tickets.Count == 0 && plan.Containers.Count == 0) plan.Blockers.Add("这位会员没有要退的水票、押金或桶袋");
        return plan;
    }

    /// <summary>
    /// Works out one container from the lots oldest first, in the order the settlement runs: broken ones kept, written-off ones
    /// kept, the rest refunded, and the newest left for the ones staying out.
    /// </summary>
    private static void PlanContainer(ContainerLine c, SettlementContainerInput? input)
    {
        c.Returned = input?.Returned ?? c.Held;
        c.Damaged = input?.Damaged ?? 0;
        c.WaiveDamage = input?.WaiveDamage ?? false;
        c.Mode = input?.Unreturned ?? "CHARGE";
        if (c.Returned < 0 || c.Damaged < 0 || c.Returned + c.Damaged > c.Held)
            throw new BusinessRuleException($"{c.Name}：还回的好的和坏的加起来不能比手里的 {c.Held} 个多");
        if (c.Mode is not ("CHARGE" or "KEEP")) throw new BusinessRuleException("没还的桶袋请选「不还了」或「以后还」");
        c.Unreturned = c.Held - c.Returned - c.Damaged;
        var deduct = c.Damaged > 0 && !c.WaiveDamage;
        var need = (deduct ? c.Damaged : 0) + c.Unreturned;
        c.OffsetQty = Math.Max(0, need - c.Covered);
        c.OffsetAmount = c.OffsetQty * c.UnitDeposit;
        var queue = c.Lots.Select(l => (l.Price, l.Available)).ToList();
        if (c.OffsetQty > 0) queue.Add((c.UnitDeposit, c.OffsetQty));
        var total = queue.Sum(q => q.Available);
        var used = 0;
        decimal Take(int n) { var value = FinanceEndpoints.FifoValue(queue, n, used); used += n; return value; }
        c.DamageUncovered = c.WaiveDamage ? Math.Max(0, c.Damaged - total) : 0;
        c.DamageDeducted = deduct ? Take(c.Damaged) : 0;
        c.ChargeDeducted = c.Mode == "CHARGE" ? Take(c.Unreturned) : 0;
        c.KeptQty = c.Mode == "KEEP" ? c.Unreturned : 0;
        c.RefundQty = total - used - c.KeptQty;
        c.RefundValue = Take(c.RefundQty);
        c.KeptDeposit = Take(c.KeptQty);
        c.RefundAmount = c.RefundValue;
    }

    /// <summary>
    /// Sets the amount actually paid back. More than the books goes onto the water refunds, each up to what its recharge took in;
    /// less comes off the water refunds first, then off the deposit refunds, where it is kept as a deduction.
    /// </summary>
    private static void Distribute(Plan plan, decimal amount)
    {
        if (decimal.Round(amount, 2) != amount || Math.Abs(amount) > Money.Max) throw new BusinessRuleException("实退金额要精确到分");
        if (amount < plan.Min || amount > plan.Max)
            throw new BusinessRuleException(plan.Min == plan.Max
                ? $"这次只能退 ¥{Money.Text(plan.Max)}：没有水费退款可以承担差额"
                : $"实退金额只能在 ¥{Money.Text(plan.Min)} 到 ¥{Money.Text(plan.Max)} 之间：多退记在水费退款上（每笔不超过原实付），少退先少退水费、再扣押金");
        foreach (var t in plan.Tickets) t.Amount = t.Value;
        foreach (var c in plan.Containers) c.RefundAmount = c.RefundValue;
        var diff = amount - plan.Computed;
        if (diff > 0)
            foreach (var t in plan.Tickets) { var add = Math.Min(diff, t.Paid - t.Value); t.Amount += add; diff -= add; }
        else if (diff < 0)
        {
            foreach (var t in plan.Tickets) { var cut = Math.Min(-diff, t.Amount); t.Amount -= cut; diff += cut; }
            foreach (var c in plan.Containers) { var cut = Math.Min(-diff, c.RefundAmount); c.RefundAmount -= cut; diff += cut; }
        }
        plan.Amount = amount;
    }

    /// <summary>The slip: every line of the settlement with what the books say and what was paid; numbers once it is done.</summary>
    private static object Slip(Plan plan, SlipHeader? header) => new
    {
        id = header?.Id, settlementNo = header?.No, memberId = plan.MemberId, memberName = plan.MemberName, memberNo = plan.MemberNo,
        payMethod = header?.PayMethod, reason = header?.Reason, operatorName = header?.OperatorName, createdAt = header?.CreatedAt,
        computedAmount = plan.Computed, amount = plan.Amount,
        tickets = plan.Tickets.Select(t => new
        {
            t.BatchId, t.Name, t.WaterType, t.Unit, t.RemainingBuy, t.RemainingGift, value = t.Value, paid = t.Paid, amount = t.Amount, refundNo = t.RefundNo
        }),
        containers = plan.Containers.Select(c => new
        {
            c.ContainerType, c.Name, c.Unit, c.UnitDeposit, c.Held, c.Covered, c.Returned, c.Damaged, c.WaiveDamage, c.Unreturned, unreturnedMode = c.Mode,
            c.OffsetQty, c.OffsetAmount, c.DamageDeducted, c.DamageUncovered, c.ChargeDeducted, c.KeptQty, c.KeptDeposit,
            c.RefundQty, c.RefundValue, c.RefundAmount, c.RefundNo, c.OffsetNo, c.ScrapNos, c.PendingDamageQty, c.PendingDamageAmount
        }),
        notes = plan.Notes
    };
}
