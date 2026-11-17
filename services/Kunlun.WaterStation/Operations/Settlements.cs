using System.Security.Claims;
using System.Text.Json;
using Kunlun.WaterStation.Auth;
using Npgsql;
using static Kunlun.WaterStation.Operations.TicketBatches;

namespace Kunlun.WaterStation.Operations;

public sealed record SettlementContainerInput(string ContainerType, int Returned, int Damaged = 0, bool WaiveDamage = false, string Unreturned = "CHARGE");
public sealed record DamageDecision(string Reference, bool Charge);
public sealed record SettlementRequest(string IdempotencyKey, string PayMethod, SettlementContainerInput[]? Containers = null,
    decimal? Amount = null, decimal? ExpectedAmount = null, string? Reason = null, DamageDecision[]? DamageDecisions = null, string? ExpectedRevision = null);
public sealed record SettlementPreviewRequest(SettlementContainerInput[]? Containers = null, decimal? Amount = null, DamageDecision[]? DamageDecisions = null);

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
            ALTER TABLE plugin_kunlun_waterstation.recharge_refunds ADD COLUMN IF NOT EXISTS transferred_amount NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK(transferred_amount>=0);
            ALTER TABLE plugin_kunlun_waterstation.water_orders ADD COLUMN IF NOT EXISTS handover_damage_qty INT,
              ADD COLUMN IF NOT EXISTS damage_compensated BOOLEAN, ADD COLUMN IF NOT EXISTS damage_reason TEXT;
            -- Older handovers recorded paid damage only in the standard handover note.
            UPDATE plugin_kunlun_waterstation.water_orders SET
              handover_damage_qty=substring(override_reason from '(?:^|；)损坏 ([0-9]{1,5}) 个(?:桶|袋)，顾客赔付(?:；|$)')::int,
              damage_compensated=TRUE
            WHERE handover_damage_qty IS NULL AND override_reason ~ '(?:^|；)损坏 [0-9]{1,5} 个(?:桶|袋)，顾客赔付(?:；|$)';
            CREATE TABLE IF NOT EXISTS plugin_kunlun_waterstation.settlement_damage_decisions (
              tenant_id UUID NOT NULL, reference TEXT NOT NULL, settlement_id UUID NOT NULL REFERENCES plugin_kunlun_waterstation.member_settlements(id),
              charge BOOLEAN NOT NULL, amount NUMERIC(10,2) NOT NULL, PRIMARY KEY(tenant_id,reference)
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
        var plan = await Build(conn, null, repo.DefaultTenantId, mid, req.Containers, req.DamageDecisions, ct);
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
        if (req.DamageDecisions is { Length: > 0 } decisions)
            hash = ContainerInventory.Hash(new { hash, decisions = decisions.OrderBy(d => d.Reference, StringComparer.Ordinal) });
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
        var plan = await Build(conn, tx, tid, mid, containers, req.DamageDecisions, ct);
        if (plan.Blockers.Count > 0) throw new BusinessRuleException(plan.Blockers[0], 409);
        if (plan.Damages.Any(d => d.Charge is null)) throw new BusinessRuleException("请逐笔确认历史破损是否收费");
        if (req.ExpectedRevision is not null && req.ExpectedRevision != plan.Revision) throw new BusinessRuleException("会员账目已变化，请重新打开结算核对", 409);
        if (req.ExpectedAmount is { } expected && expected != plan.Computed)
            throw new BusinessRuleException($"账目刚有变化：现在应退 ¥{Money.Text(plan.Computed)}（刚才是 ¥{Money.Text(expected)}），请核对后再确认", 409);
        Distribute(plan, req.Amount ?? plan.Computed);

        var id = Guid.NewGuid();
        var no = await BusinessNumbers.SettlementNo(conn, tx, ct);
        var note = $"退款结算 {no}";
        foreach (var c in plan.Containers) await SettleContainer(conn, tx, tid, mid, id, no, note, c, user, ct);
        var supplement = Math.Max(0, -plan.Amount);
        if (plan.Funding > supplement)
            plan.TransferNo = (await FinanceEndpoints.InsertDepositLot(conn, tx, tid, mid, null, 0, plan.Funding - supplement, "TRANSFER",
                $"settlement:{id:N}:transfer", actor, null, ct, "TRANSFER")).DepositNo;
        if (supplement > 0)
            plan.CollectionNo = (await FinanceEndpoints.InsertDepositLot(conn, tx, tid, mid, null, 0, supplement, req.PayMethod,
                $"settlement:{id:N}:collect", actor, null, ct)).DepositNo;
        if (plan.RefundValue + plan.Charges > 0)
        {
            var refund = await DepositPool.Debit(conn, tx, tid, mid, plan.RefundValue + plan.Charges, plan.RefundAmount, req.PayMethod, $"settlement:{id:N}:debit", actor, ct);
            await RefundRequests.RecordDirect(conn, tx, tid, "DEPOSIT", mid, null, null, null, req.PayMethod, reason, refund.RefundNo, refund.Amount, actor, ct, plan.RefundValue, note);
            plan.RefundNo = refund.RefundNo;
        }
        foreach (var t in plan.Tickets)
        {
            var refund = await MembershipEndpoints.ExecuteRechargeRefund(conn, tx, tid, t.BatchId, req.PayMethod, reason, $"settlement:{id:N}:{t.BatchId:N}", actor, ct, t.Amount, t.Transferred);
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
        foreach (var d in plan.Damages)
            await Exec(conn, tx, """
                INSERT INTO plugin_kunlun_waterstation.settlement_damage_decisions(tenant_id,reference,settlement_id,charge,amount)
                VALUES(@tid,@ref,@id,@charge,@amount)
                """, ct, ("tid", tid), ("ref", d.Reference), ("id", id), ("charge", d.Charge!.Value), ("amount", d.Charge.Value ? d.Value : 0m));
        await tx.CommitAsync(ct);
        return Results.Ok(JsonSerializer.Deserialize<JsonElement>(json));
    }

    private static async Task SettleContainer(NpgsqlConnection conn, NpgsqlTransaction tx, Guid tid, Guid mid, Guid id, string no, string note,
        ContainerLine c, ClaimsPrincipal user, CancellationToken ct)
    {
        if (c.Returned > 0) await TakeBack(conn, tx, tid, mid, c.ContainerType, c.Returned, no, Actor(user), ct);
        async Task Scrap(int quantity, string action, string description, bool charged)
        {
            var key = $"settlement:{id:N}:{c.ContainerType}:{action}";
            var damage = await ContainerCirculation.RecordDamage(conn, tx, tid, mid, c.ContainerType, quantity, description, key, "",
                true, note, user, ct, feePaid: charged);
            // Release any historical reservations. The monetary fee is posted once, from the member-wide pool.
            var scrap = await ContainerCirculation.Scrap(conn, tx, tid, mid, damage.Id, description, true, key + ":scrap", "", user, ct);
            c.ScrapNos.Add(scrap.ScrapNo);
        }
        if (c.Damaged > 0) await Scrap(c.Damaged, "damaged", $"{note}：破损，{(c.WaiveDamage ? "免收" : "计入结算")}", !c.WaiveDamage);
        if (c.Mode == "CHARGE" && c.Unreturned > 0) await Scrap(c.Unreturned, "lost", $"{note}：未归还，计入结算", true);
    }

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

    private sealed record HistoricalDamage(string Reference, string ContainerType, string Name, int Quantity, decimal Value, string Reason, bool? Charge);

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
        public decimal Transferred { get; set; }
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
        public int Returned { get; set; }
        public int Damaged { get; set; }
        public bool WaiveDamage { get; set; }
        public int Unreturned { get; set; }
        public string Mode { get; set; } = "CHARGE";
        public decimal DamageDeducted => WaiveDamage ? 0 : Damaged * UnitDeposit;
        public decimal ChargeDeducted => Mode == "CHARGE" ? Unreturned * UnitDeposit : 0;
        public decimal KeptDeposit => Mode == "KEEP" ? Unreturned * UnitDeposit : 0;
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
        public List<HistoricalDamage> Damages { get; } = [];
        public decimal Deposit { get; set; }
        public decimal Kept => Containers.Sum(c => c.KeptDeposit);
        public decimal Charges => Containers.Sum(c => c.ChargeDeducted + c.DamageDeducted) + Damages.Where(d => d.Charge == true).Sum(d => d.Value);
        public decimal Funding => Math.Max(0, Kept + Charges - Deposit);
        public decimal RefundValue => Math.Max(0, Deposit - Kept - Charges);
        public decimal RefundAmount { get; set; }
        public decimal Computed => Tickets.Sum(t => t.Value) + RefundValue - Funding;
        public decimal Min => -Funding;
        public decimal Max => Computed + Tickets.Sum(t => t.Paid - t.Value);
        public string Revision { get; set; } = "";
        public string? TransferNo { get; set; }
        public string? CollectionNo { get; set; }
        public string? RefundNo { get; set; }
        public decimal Amount { get; set; }
    }

    private sealed record SlipHeader(Guid Id, string No, string PayMethod, string Reason, string OperatorName, DateTimeOffset CreatedAt);

    private static async Task<Plan> Build(NpgsqlConnection conn, NpgsqlTransaction? tx, Guid tid, Guid mid, SettlementContainerInput[]? inputs, DamageDecision[]? decisions, CancellationToken ct)
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
        // Anything still waiting for review changes what the member is owed: a deposit taken but not approved has no lot yet (the
        // slip would charge for it again), a gift would land on refunded tickets, and a refund would pay twice.
        await using (var cmd = Command(conn, tx, "SELECT request_no,kind FROM plugin_kunlun_waterstation.refund_requests WHERE tenant_id=@tid AND member_id=@mid AND status='PENDING' ORDER BY created_at LIMIT 1", ("tid", tid), ("mid", mid)))
        await using (var r = await cmd.ExecuteReaderAsync(ct))
            if (await r.ReadAsync(ct))
            {
                var what = r.GetString(1) switch { "DEPOSIT" => "押金退款申请", "RECHARGE" => "水费退款申请", "COLLECT" => "收的押金", "DAMAGE" => "损坏不赔付", _ => "赠送" };
                plan.Blockers.Add($"有{what} {r.GetString(0)} 在等审核，请先到审核页处理再结算");
            }

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

        var pool = await DepositPool.Read(conn, tx, tid, mid, ct);
        plan.Deposit = pool.Total - pool.Reserved;
        if (pool.Reserved > 0) plan.Notes.Add($"另有待报废押金 ¥{Money.Text(pool.Reserved)}，待报废处理后再结算");
        var choices = inputs ?? [];
        if (choices.Select(c => c.ContainerType).Distinct().Count() != choices.Length) throw new BusinessRuleException("同种桶袋不能重复结算");
        foreach (var product in await WaterProducts.List(conn, tid, ct))
        {
            var held = await ProductContainers.Held(conn, tx, tid, mid, product.ContainerId, ct);
            if (held == 0) continue;
            var input = choices.FirstOrDefault(c => c.ContainerType == product.ContainerId);
            var line = new ContainerLine {
                ContainerType = product.ContainerId, Name = product.Name, Unit = product.Unit, UnitDeposit = product.UnitDeposit, Held = held,
                Returned = input?.Returned ?? 0, Damaged = input?.Damaged ?? 0, WaiveDamage = input?.WaiveDamage ?? false, Mode = input?.Unreturned ?? "KEEP"
            };
            if (line.Returned < 0 || line.Damaged < 0 || (long)line.Returned + line.Damaged > held || line.Mode is not ("KEEP" or "CHARGE"))
                throw new BusinessRuleException($"{product.Name}的归还数量或处理方式无效，请重新核对");
            line.Unreturned = held - line.Returned - line.Damaged;
            plan.Containers.Add(line);
        }
        if (choices.Any(input => plan.Containers.All(c => c.ContainerType != input.ContainerType))) throw new BusinessRuleException("会员持有数量已变化，请重新打开结算", 409);

        await using (var cmd = Command(conn, tx, """
            WITH damaged AS (
              SELECT request_no AS ref,container_type,quantity,concat_ws(' · ',order_no,reason) AS reason FROM plugin_kunlun_waterstation.refund_requests
              WHERE tenant_id=@tid AND member_id=@mid AND kind='DAMAGE' AND status<>'PENDING'
              UNION ALL
              SELECT damage_no,container_type,
                     CASE WHEN fee_paid IS FALSE THEN quantity
                          ELSE (CASE WHEN deposit_waived THEN quantity ELSE uncovered_qty END)
                                - (CASE WHEN uncovered_note LIKE '报废费用给了；%' THEN uncovered_qty ELSE 0 END) END,
                     concat_ws(' · ',reason,NULLIF(uncovered_note,''),scrap_reason) FROM plugin_kunlun_waterstation.container_damages
              WHERE tenant_id=@tid AND member_id=@mid AND (fee_paid IS FALSE OR (fee_paid IS NULL AND status='SCRAPPED' AND (deposit_waived OR uncovered_qty>0)))
                AND idempotency_key NOT LIKE 'settlement:%'
            )
            SELECT d.ref,d.container_type,p.name,d.quantity,d.quantity*c.unit_deposit,d.reason FROM damaged d
            JOIN plugin_kunlun_waterstation.container_configs c ON c.tenant_id=@tid AND c.container_type=d.container_type
            JOIN plugin_kunlun_waterstation.water_products p ON p.tenant_id=@tid AND p.container_id=d.container_type
            WHERE d.quantity>0 AND NOT EXISTS (SELECT 1 FROM plugin_kunlun_waterstation.settlement_damage_decisions s WHERE s.tenant_id=@tid AND s.reference=d.ref)
            ORDER BY d.ref
            """, ("tid", tid), ("mid", mid)))
        await using (var r = await cmd.ExecuteReaderAsync(ct))
            while (await r.ReadAsync(ct))
            {
                var reference = r.GetString(0);
                plan.Damages.Add(new(reference,r.GetString(1),r.GetString(2),r.GetInt32(3),r.GetDecimal(4),r.GetString(5),
                    decisions?.FirstOrDefault(d => d.Reference == reference)?.Charge));
            }
        if (decisions is not null && (decisions.Select(d => d.Reference).Distinct().Count() != decisions.Length ||
                decisions.Any(d => plan.Damages.All(item => item.Reference != d.Reference))))
            throw new BusinessRuleException("历史破损记录已变化，请重新核对", 409);
        if (plan.Tickets.Count == 0 && plan.RefundValue == 0 && plan.Damages.Count == 0 &&
            plan.Funding == 0 && plan.Containers.All(c => c.Damaged + c.Returned == 0 && c.ChargeDeducted == 0))
            plan.Blockers.Add("这位会员没有待结算的变动");
        plan.Revision = ContainerInventory.Hash(new { plan.Deposit, plan.Tickets, plan.Containers, plan.Damages });
        return plan;
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
        plan.RefundAmount = plan.RefundValue;
        var diff = amount - plan.Computed;
        if (diff > 0)
            foreach (var t in plan.Tickets) { var add = Math.Min(diff, t.Paid - t.Value); t.Amount += add; diff -= add; }
        else if (diff < 0)
        {
            foreach (var t in plan.Tickets) { var cut = Math.Min(-diff, t.Amount); t.Amount -= cut; diff += cut; }
            plan.RefundAmount -= Math.Min(-diff, plan.RefundAmount);
        }
        var transfer = plan.Funding + Math.Min(0, amount);
        foreach (var ticket in plan.Tickets)
        {
            ticket.Transferred = Math.Min(ticket.Amount, transfer);
            ticket.Amount -= ticket.Transferred;
            transfer -= ticket.Transferred;
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
            t.BatchId, t.Name, t.WaterType, t.Unit, t.RemainingBuy, t.RemainingGift, value = t.Value, paid = t.Paid, t.Transferred, amount = t.Amount, refundNo = t.RefundNo
        }),
        containers = plan.Containers.Select(c => new
        {
            c.ContainerType, c.Name, c.Unit, c.UnitDeposit, c.Held, c.Returned, c.Damaged, c.WaiveDamage, c.Unreturned, unreturnedMode = c.Mode,
            c.DamageDeducted, c.ChargeDeducted, c.KeptDeposit, c.ScrapNos
        }),
        damages = plan.Damages, revision = plan.Revision,
        pool = new { before = plan.Deposit, kept = plan.Kept, charges = plan.Charges, transfer = plan.Funding + Math.Min(0,plan.Amount),
            supplement = Math.Max(0,-plan.Amount), refund = plan.RefundAmount, plan.TransferNo, plan.CollectionNo, plan.RefundNo },
        notes = plan.Notes
    };
}
