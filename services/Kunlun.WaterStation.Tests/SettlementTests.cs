using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Kunlun.WaterStation.Auth;
using Kunlun.WaterStation.Operations;
using Xunit;

namespace Kunlun.WaterStation.Tests;

/// <summary>
/// 退款金额可以改（水费、押金都以办理的人填的为准），收押金、补录押金按金额；退款结算一张单子结清水票、押金和桶袋。
/// 数据库由整组测试共用，汇总数一律比较前后差值，并检查押金账始终对得上（reconciledZeroDiff）。
/// </summary>
[Collection("KunlunIntegration")]
public sealed class SettlementTests(TestHost host)
{
    private const string Bucket = "BUCKET_18_9L", Bag = "BAG_7_5L";
    private static readonly Guid BucketPickup100 = WaterProducts.PlanId("101");
    private static string Key() => Guid.NewGuid().ToString("N");

    private async Task<HttpClient> Login(string account = "YG0001")
    {
        var c = host.CreateClient();
        var s = await Ok(await c.PostAsJsonAsync("/api/auth/staff/login", new StaffLoginRequest(account, TestHost.Password)));
        c.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", s.GetProperty("accessToken").GetString());
        return c;
    }
    private static async Task<JsonElement> Ok(HttpResponseMessage response)
    {
        var body = await response.Content.ReadAsStringAsync();
        Assert.True(response.IsSuccessStatusCode, $"{response.StatusCode}: {body}");
        return JsonSerializer.Deserialize<JsonElement>(body);
    }
    private static async Task<string> Fails(HttpResponseMessage response, HttpStatusCode status)
    {
        var body = await response.Content.ReadAsStringAsync();
        Assert.True(response.StatusCode == status, $"expected {status}, got {response.StatusCode}: {body}");
        return body;
    }
    private static async Task<(Guid Id, string No)> Member(HttpClient c)
    {
        var m = await Ok(await c.PostAsJsonAsync("/api/members", new CreateMemberRequest("结算验收", $"136{Random.Shared.Next(10000000, 99999999)}", "结算小区", null, "3-303")));
        return (m.GetProperty("id").GetGuid(), m.GetProperty("memberNo").GetString()!);
    }
    private static async Task<Guid> Recharge(HttpClient c, Guid mid) =>
        (await Ok(await c.PostAsJsonAsync("/api/recharges", new CreateRechargeOrderRequest(mid, BucketPickup100, "CASH", Key())))).GetProperty("id").GetGuid();
    private static Task<JsonElement> Opening(HttpClient c, Guid mid, OpeningTicketInput[]? tickets = null, OpeningDepositInput[]? deposits = null, OpeningHoldingInput[]? holdings = null) =>
        c.PostAsJsonAsync($"/api/members/{mid}/opening", new SaveOpeningRequest(Key(), tickets, deposits, holdings)).ContinueWith(t => Ok(t.Result)).Unwrap();
    private static async Task<JsonElement> Deposit(HttpClient c, Guid mid, string type) =>
        (await c.GetFromJsonAsync<JsonElement>($"/api/members/{mid}/deposit-summary")).EnumerateArray().Single(r => r.GetProperty("containerType").GetString() == type);
    private static async Task<JsonElement> Batch(HttpClient c, Guid mid, Guid id) =>
        (await c.GetFromJsonAsync<JsonElement>($"/api/members/{mid}/ticket-batches")).EnumerateArray().Single(b => b.GetProperty("id").GetGuid() == id);
    private static async Task<JsonElement> Finance(HttpClient c) => await c.GetFromJsonAsync<JsonElement>("/api/reports/finance-summary");
    private static async Task<JsonElement[]> Requests(HttpClient c, string query) =>
        (await c.GetFromJsonAsync<JsonElement>($"/api/refund-requests?{query}&page=1")).GetProperty("rows").EnumerateArray().ToArray();
    private static Task<HttpResponseMessage> Preview(HttpClient c, Guid mid, params SettlementContainerInput[] containers) =>
        c.PostAsJsonAsync($"/api/members/{mid}/settlement/preview", new SettlementPreviewRequest(containers));
    private static decimal M(JsonElement x, string field) => x.GetProperty(field).GetDecimal();
    private static int I(JsonElement x, string field) => x.GetProperty(field).GetInt32();
    private static JsonElement Line(JsonElement slip, string type) =>
        slip.GetProperty("containers").EnumerateArray().Single(c => c.GetProperty("containerType").GetString() == type);
    private static async Task Reconciled(HttpClient c) => Assert.True((await Finance(c)).GetProperty("reconciledZeroDiff").GetBoolean(), "deposit pool and flows must agree");
    private static async Task ReviewSwitches(HttpClient admin, bool refund) =>
        await Ok(await admin.PutAsJsonAsync("/api/settings/review", new SaveReviewSettingsRequest(true, refund)));

    [Fact]
    public async Task Water_Refund_Pays_The_Amount_Typed_In_And_Keeps_What_The_Books_Said()
    {
        using var admin = await Login();
        var (mid, memberNo) = await Member(admin);
        var batch = await Recharge(admin, mid);
        ApplyRefundRequest Refund(decimal? amount, string? key = null) => new("RECHARGE", mid, null, null, batch, "WECHAT", "搬家", key ?? Key(), amount);

        await Fails(await admin.PostAsJsonAsync("/api/refund-requests", Refund(100.01m)), HttpStatusCode.BadRequest);
        await Fails(await admin.PostAsJsonAsync("/api/refund-requests", Refund(-1m)), HttpStatusCode.BadRequest);
        await Fails(await admin.PostAsJsonAsync("/api/refund-requests", Refund(1.005m)), HttpStatusCode.BadRequest);

        var key = Key();
        var refund = await Ok(await admin.PostAsJsonAsync("/api/refund-requests", Refund(88.5m, key)));
        Assert.Equal(("APPROVED", 88.5m, 100m), (refund.GetProperty("status").GetString(), M(refund, "refundAmount"), M(refund, "estimatedAmount")));
        // The same request key cannot come back with another amount; the same amount replays.
        await Fails(await admin.PostAsJsonAsync("/api/refund-requests", Refund(80m, key)), HttpStatusCode.Conflict);
        Assert.True((await Ok(await admin.PostAsJsonAsync("/api/refund-requests", Refund(88.5m, key)))).GetProperty("idempotentReplay").GetBoolean());

        Assert.Equal(88.5m, M(await Batch(admin, mid, batch), "refundedAmount"));
        var ledger = Assert.Single((await admin.GetFromJsonAsync<JsonElement>($"/api/ledgers/recharge-refunds?q={memberNo}&page=1")).GetProperty("rows").EnumerateArray());
        Assert.Equal(88.5m, M(ledger, "amount"));
        var row = Assert.Single(await Requests(admin, $"kind=RECHARGE&q={memberNo}"));
        Assert.Equal((100m, 88.5m, 88.5m), (M(row, "estimatedAmount"), M(row, "requestedAmount"), M(row, "refundAmount")));
        // A refunded row shows the tickets it refunded, not the batch's remaining ones, which are none by then.
        Assert.Equal((await Batch(admin, mid, batch)).GetProperty("fixedQty").GetInt32(), row.GetProperty("remainingBuy").GetInt32());
    }

    [Fact]
    public async Task Clerk_Typed_Amounts_Wait_And_The_Reviewer_Confirms_The_Final_One()
    {
        using var admin = await Login();
        using var clerk = await Login("YG0012");
        await ReviewSwitches(admin, refund: true);
        var (mid, memberNo) = await Member(admin);
        var batch = await Recharge(admin, mid);

        var water = await Ok(await clerk.PostAsJsonAsync("/api/refund-requests", new ApplyRefundRequest("RECHARGE", mid, null, null, batch, "CASH", "搬家", Key(), 60m)));
        Assert.Equal("PENDING", water.GetProperty("status").GetString());
        var pending = Assert.Single(await Requests(admin, $"kind=RECHARGE&status=PENDING&q={memberNo}"));
        Assert.Equal((60m, 100m, 100m), (M(pending, "requestedAmount"), M(pending, "estimatedAmount"), M(pending, "currentAmount")));
        var waterId = water.GetProperty("id").GetGuid();
        // A reviewer must confirm the figure: an approval that never saw the applicant's amount is refused.
        await Fails(await admin.PostAsJsonAsync($"/api/refund-requests/{waterId}/approve", new ApproveRefundRequest(null, null)), HttpStatusCode.Conflict);
        await Fails(await admin.PostAsJsonAsync($"/api/refund-requests/{waterId}/approve", new ApproveRefundRequest(null, null, 100.01m)), HttpStatusCode.BadRequest);
        var approved = await Ok(await admin.PostAsJsonAsync($"/api/refund-requests/{waterId}/approve", new ApproveRefundRequest(null, "按 65 退", 65m)));
        Assert.Equal(65m, M(approved, "refundAmount"));
        Assert.Equal(65m, M(await Batch(admin, mid, batch), "refundedAmount"));

        // A deposit refund paid back short keeps the rest as a deduction, and the deposit books still agree.
        var unit = M(await Deposit(admin, mid, "BUCKET"), "unitDeposit");
        await Ok(await admin.PostAsJsonAsync("/api/deposits/collect", new CollectDepositRequest(mid, "BUCKET", 1, "CASH", Key())));
        var deductedBefore = M(await Finance(admin), "depositDeductedTotal");
        var deposit = await Ok(await clerk.PostAsJsonAsync("/api/refund-requests", new ApplyRefundRequest("DEPOSIT", mid, "BUCKET", 1, null, "CASH", "不再订水", Key(), unit - 2)));
        Assert.Equal(unit - 2, M(Assert.Single(await Requests(admin, $"kind=DEPOSIT&status=PENDING&q={memberNo}")), "requestedAmount"));
        var depositApproved = await Ok(await admin.PostAsJsonAsync($"/api/refund-requests/{deposit.GetProperty("id").GetGuid()}/approve", new ApproveRefundRequest("CASH", null, unit - 1)));
        Assert.Equal(unit - 1, M(depositApproved, "refundAmount"));
        Assert.Equal(deductedBefore + 1, M(await Finance(admin), "depositDeductedTotal"));
        Assert.Equal(0, I(await Deposit(admin, mid, "BUCKET"), "paidQty"));
        var flows = (await admin.GetFromJsonAsync<JsonElement>($"/api/ledgers/deposits?q={memberNo}&page=1")).GetProperty("rows").EnumerateArray().ToArray();
        Assert.Contains(flows, f => f.GetProperty("flowType").GetString() == "DEDUCT" && M(f, "amount") == 1m);
        await Reconciled(admin);
    }

    [Fact]
    public async Task Deposits_Are_Collected_Refunded_And_Recorded_By_The_Amount_Typed_In()
    {
        using var admin = await Login();
        var (mid, _) = await Member(admin);
        var collected = await Ok(await admin.PostAsJsonAsync("/api/deposits/collect", new CollectDepositRequest(mid, "BUCKET", 2, "CASH", Key(), 50m)));
        Assert.Equal((25m, 50m), (M(collected, "unitPrice"), M(collected, "totalAmount")));
        await Fails(await admin.PostAsJsonAsync("/api/deposits/collect", new CollectDepositRequest(mid, "BUCKET", 3, "CASH", Key(), 10m)), HttpStatusCode.BadRequest);
        var row = await Deposit(admin, mid, "BUCKET");
        Assert.Equal((2, 50m), (I(row, "paidQty"), M(row, "paidAmount")));
        var lot = Assert.Single(row.GetProperty("lots").EnumerateArray());
        Assert.Equal((25m, 2), (M(lot, "unitPrice"), I(lot, "quantity")));

        await Fails(await admin.PostAsJsonAsync("/api/deposits/refund", new RefundDepositRequest(mid, "BUCKET", 1, Key(), "CASH", 30m)), HttpStatusCode.BadRequest);
        var deductedBefore = M(await Finance(admin), "depositDeductedTotal");
        var refund = await Ok(await admin.PostAsJsonAsync("/api/deposits/refund", new RefundDepositRequest(mid, "BUCKET", 1, Key(), "CASH", 20m)));
        Assert.Equal((20m, 5m), (M(refund, "refundAmount"), M(refund, "deductedAmount")));
        Assert.Equal(deductedBefore + 5, M(await Finance(admin), "depositDeductedTotal"));
        Assert.Equal(25m, M(await Deposit(admin, mid, "BUCKET"), "paidAmount"));
        await Reconciled(admin);

        // Before-the-system deposits: a count and a total that splits evenly.
        var (other, _) = await Member(admin);
        await Fails(await admin.PostAsJsonAsync($"/api/members/{other}/opening", new SaveOpeningRequest(Key(), Deposits: [new("BAG", 3, Amount: 10m)])), HttpStatusCode.BadRequest);
        await Opening(admin, other, deposits: [new("BAG", 2, Amount: 9m)]);
        var opening = await admin.GetFromJsonAsync<JsonElement>($"/api/members/{other}/opening");
        var entered = Assert.Single(opening.GetProperty("deposits").EnumerateArray());
        Assert.Equal((2, 4.5m, 9m), (I(entered, "quantity"), M(entered, "unitPrice"), M(entered, "amount")));
        await Reconciled(admin);
    }

    [Fact]
    public async Task Typed_Deposits_Waiting_For_Review_Keep_Their_Price_And_Hold_Up_A_Settlement()
    {
        using var admin = await Login();
        var (mid, memberNo) = await Member(admin);
        await Recharge(admin, mid);
        await Ok(await admin.PutAsJsonAsync("/api/settings/review", new SaveReviewSettingsRequest(true, true, true, false)));
        try
        {
            var collect = new CollectDepositRequest(mid, "BUCKET", 2, "WECHAT", Key(), 90m);
            var pending = await Ok(await admin.PostAsJsonAsync("/api/deposits/collect", collect));
            Assert.Equal(("PENDING", 45m, 90m), (pending.GetProperty("status").GetString(), M(pending, "unitPrice"), M(pending, "totalAmount")));
            // The same key with another amount is another collect; the same amount replays.
            await Fails(await admin.PostAsJsonAsync("/api/deposits/collect", collect with { Amount = 80m }), HttpStatusCode.Conflict);
            Assert.True((await Ok(await admin.PostAsJsonAsync("/api/deposits/collect", collect))).GetProperty("idempotentReplay").GetBoolean());

            // The deposit is paid but has no lot yet, so a slip would charge for it again: settling waits for the review.
            var blocked = await Ok(await Preview(admin, mid));
            Assert.Contains("收的押金", Assert.Single(blocked.GetProperty("blockers").EnumerateArray()).GetString());

            var request = Assert.Single(await Requests(admin, $"kind=COLLECT&status=PENDING&q={memberNo}"));
            await Ok(await admin.PostAsJsonAsync($"/api/refund-requests/{request.GetProperty("id").GetGuid()}/approve", new ApproveRefundRequest(null, null)));
            var lot = Assert.Single((await Deposit(admin, mid, "BUCKET")).GetProperty("lots").EnumerateArray());
            Assert.Equal((45m, 2), (M(lot, "unitPrice"), I(lot, "quantity")));
            Assert.Empty((await Ok(await Preview(admin, mid))).GetProperty("blockers").EnumerateArray());
            await Reconciled(admin);
        }
        finally
        {
            await Ok(await admin.PutAsJsonAsync("/api/settings/review", new SaveReviewSettingsRequest(true, true, false, false)));
        }
    }

    [Fact]
    public async Task Settlement_Refunds_Tickets_And_Deposit_And_Charges_For_Containers_Not_Returned()
    {
        using var admin = await Login();
        var (mid, memberNo) = await Member(admin);
        // The screenshot: a package from before the system (100 yuan / 40 bags, 30 left), one bag's deposit, two bags at home.
        await Opening(admin, mid,
            tickets: [new(WaterType: Bag, FulfillMode: "DELIVERY", PlanId: WaterProducts.PlanId("107"), PaidAmount: 100, PackageQty: 40, Remaining: 30)],
            deposits: [new("BAG", 1, Amount: 5m)], holdings: [new("BAG", 2)]);
        var bagDeposit = M(await Deposit(admin, mid, "BAG"), "unitDeposit");

        var all = await Ok(await Preview(admin, mid, new SettlementContainerInput("BAG", 2)));
        Assert.Empty(all.GetProperty("blockers").EnumerateArray());
        Assert.Equal(80m, M(all.GetProperty("slip"), "computedAmount"));
        Assert.Equal(5m, M(all.GetProperty("slip").GetProperty("pool"), "refund"));

        var one = (await Ok(await Preview(admin, mid, new SettlementContainerInput("BAG", 1)))).GetProperty("slip");
        Assert.Equal(75m, M(one, "computedAmount"));
        Assert.Equal((5m, 1), (M(Line(one, "BAG"), "chargeDeducted"), I(Line(one, "BAG"), "unreturned")));

        // Keeping both: the bag without a deposit is charged at the standard deposit.
        var none = (await Ok(await Preview(admin, mid, new SettlementContainerInput("BAG", 0)))).GetProperty("slip");
        Assert.Equal(75m - bagDeposit, M(none, "computedAmount"));
        Assert.Equal(bagDeposit, M(none.GetProperty("pool"), "transfer"));

        var tooMuch = await Ok(await admin.PostAsJsonAsync($"/api/members/{mid}/settlement/preview", new SettlementPreviewRequest([new("BAG", 1)], 1000m)));
        Assert.Equal(JsonValueKind.String, tooMuch.GetProperty("amountError").ValueKind);
        Assert.Equal((0m, 100m), (M(tooMuch.GetProperty("range"), "min"), M(tooMuch.GetProperty("range"), "max")));

        var stockBefore = (await admin.GetFromJsonAsync<JsonElement>("/api/containers/summary")).EnumerateArray().Single(r => r.GetProperty("containerType").GetString() == "BAG");
        var key = Key();
        var request = new SettlementRequest(key, "CASH", [new("BAG", 1)], Amount: 70m, ExpectedAmount: 75m, Reason: "搬家");
        var slip = await Ok(await admin.PostAsJsonAsync($"/api/members/{mid}/settlement", request));
        var no = slip.GetProperty("settlementNo").GetString()!;
        Assert.StartsWith("JS", no);
        Assert.Equal((75m, 70m), (M(slip, "computedAmount"), M(slip, "amount")));
        var ticket = Assert.Single(slip.GetProperty("tickets").EnumerateArray());
        Assert.Equal((75m, 70m), (M(ticket, "value"), M(ticket, "amount")));
        Assert.False(string.IsNullOrEmpty(ticket.GetProperty("refundNo").GetString()));
        Assert.Single(Line(slip, "BAG").GetProperty("scrapNos").EnumerateArray());
        Assert.Equal(no, (await Ok(await admin.PostAsJsonAsync($"/api/members/{mid}/settlement", request))).GetProperty("settlementNo").GetString());

        var profile = await admin.GetFromJsonAsync<JsonElement>($"/api/members/{mid}/profile");
        Assert.Equal(0, profile.Tickets(Bag, "DELIVERY"));
        var bags = await Deposit(admin, mid, "BAG");
        Assert.Equal((0, 0), (I(bags, "heldQty"), I(bags, "paidQty")));
        var stockAfter = (await admin.GetFromJsonAsync<JsonElement>("/api/containers/summary")).EnumerateArray().Single(r => r.GetProperty("containerType").GetString() == "BAG");
        Assert.Equal(I(stockBefore, "scrappedQty") + 1, I(stockAfter, "scrappedQty"));
        var listed = Assert.Single((await admin.GetFromJsonAsync<JsonElement>($"/api/members/{mid}/settlements")).EnumerateArray());
        Assert.Equal(no, listed.GetProperty("settlementNo").GetString());
        var water = Assert.Single(await Requests(admin, $"kind=RECHARGE&q={memberNo}"));
        Assert.Equal(($"退款结算 {no}", 75m, 70m), (water.GetProperty("reviewNote").GetString(), M(water, "estimatedAmount"), M(water, "refundAmount")));
        await Reconciled(admin);
        // Nothing is left to settle.
        Assert.NotEmpty((await Ok(await Preview(admin, mid))).GetProperty("blockers").EnumerateArray());
    }

    [Fact]
    public async Task Settlement_Takes_Damage_Waives_It_On_Request_And_Leaves_Kept_Containers_Covered()
    {
        using var admin = await Login();
        var (mid, _) = await Member(admin);
        await Recharge(admin, mid);
        await Ok(await admin.PostAsJsonAsync("/api/deposits/collect", new CollectDepositRequest(mid, "BUCKET", 2, "CASH", Key(), 60m)));
        await Opening(admin, mid, holdings: [new("BUCKET", 3)]);

        // One back good, one broken (deposit kept), one staying out on the other deposit: nothing to refund on the deposit.
        var deduct = (await Ok(await Preview(admin, mid, new SettlementContainerInput("BUCKET", 1, 1, false, "KEEP")))).GetProperty("slip");
        var bucket = Line(deduct, "BUCKET");
        var standard = M(bucket, "unitDeposit");
        Assert.Equal((standard, standard), (M(bucket, "damageDeducted"), M(bucket, "keptDeposit")));
        Assert.Equal(160m - 2 * standard, M(deduct, "computedAmount"));

        var waived = (await Ok(await Preview(admin, mid, new SettlementContainerInput("BUCKET", 1, 1, true, "KEEP")))).GetProperty("slip");
        Assert.Equal(160m - standard, M(waived, "computedAmount"));
        await Ok(await admin.PostAsJsonAsync($"/api/members/{mid}/settlement",
            new SettlementRequest(Key(), "WECHAT", [new("BUCKET", 1, 1, true, "KEEP")], ExpectedAmount: 160m - standard)));
        var after = await Deposit(admin, mid, "BUCKET");
        Assert.Equal((1, standard), (I(after, "heldQty"), M(after.GetProperty("pool"), "total")));
        await Reconciled(admin);

        // Owed deposit for containers kept out is taken from the refund and becomes deposit, refundable once they come back.
        var (owing, _) = await Member(admin);
        await Recharge(admin, owing);
        await Opening(admin, owing, holdings: [new("BUCKET", 2)]);
        var unit = M(await Deposit(admin, owing, "BUCKET"), "unitDeposit");
        var keep = (await Ok(await Preview(admin, owing, new SettlementContainerInput("BUCKET", 0, 0, false, "KEEP")))).GetProperty("slip");
        Assert.Equal(100m - 2 * unit, M(keep, "computedAmount"));
        await Ok(await admin.PostAsJsonAsync($"/api/members/{owing}/settlement",
            new SettlementRequest(Key(), "CASH", [new("BUCKET", 0, 0, false, "KEEP")], ExpectedAmount: 100m - 2 * unit)));
        var covered = await Deposit(admin, owing, "BUCKET");
        Assert.Equal((2, 2 * unit), (I(covered, "heldQty"), M(covered.GetProperty("pool"), "total")));
        await Reconciled(admin);
    }

    [Fact]
    public async Task Seventy_Yuan_Leaves_Ten_In_The_Pool_Until_The_Two_Bags_Come_Back()
    {
        using var admin = await Login();
        var (mid, memberNo) = await Member(admin);
        await Opening(admin, mid,
            tickets: [new(WaterType: Bag, FulfillMode: "DELIVERY", PlanId: WaterProducts.PlanId("107"), PaidAmount: 100, PackageQty: 40, Remaining: 28)],
            holdings: [new("BAG", 2)]);
        var slip = (await Ok(await Preview(admin, mid))).GetProperty("slip");
        Assert.Equal((60m, 10m), (M(slip, "computedAmount"), M(slip.GetProperty("pool"), "transfer")));
        var request = new SettlementRequest(Key(), "WECHAT", ExpectedAmount: 60, ExpectedRevision: slip.GetProperty("revision").GetString());
        var booked = await Ok(await admin.PostAsJsonAsync($"/api/members/{mid}/settlement", request));
        Assert.False(string.IsNullOrEmpty(booked.GetProperty("pool").GetProperty("transferNo").GetString()));
        var water = Assert.Single((await admin.GetFromJsonAsync<JsonElement>($"/api/ledgers/recharge-refunds?q={memberNo}&page=1")).GetProperty("rows").EnumerateArray());
        Assert.Equal((60m, 10m), (M(water,"amount"), M(water,"transferredAmount")));
        var flows = await admin.GetFromJsonAsync<JsonElement>($"/api/ledgers/deposits?q={memberNo}&page=1");
        Assert.Contains(flows.GetProperty("rows").EnumerateArray(), r => r.GetProperty("flowType").GetString() == "TRANSFER" && M(r,"amount") == 10);
        Assert.Equal((2, 10m), (I(await Deposit(admin, mid, "BAG"), "heldQty"), M((await Deposit(admin, mid, "BAG")).GetProperty("pool"), "total")));
        await Ok(await admin.PostAsJsonAsync("/api/containers/movements", new RegisterContainerMovementRequest(mid, "BAG", 0, 2, IdempotencyKey: Key())));
        await Ok(await admin.PostAsJsonAsync("/api/refund-requests", new { kind="DEPOSIT", memberId=mid, amount=6.37m, payMethod="WECHAT", idempotencyKey=Key() }));
        Assert.Equal(3.63m, M((await Deposit(admin, mid, "BAG")).GetProperty("pool"), "total"));
        await Reconciled(admin);
    }

    [Fact]
    public async Task Pool_Refund_Reserves_Money_And_Preserves_The_Change_From_An_Old_Lot()
    {
        using var admin = await Login();
        using var clerk = await Login("YG0012");
        await ReviewSwitches(admin, true);
        var (mid, _) = await Member(admin);
        await Opening(admin, mid, deposits:[new("BUCKET", 1, Amount:30)], holdings:[new("BAG", 7)]);
        var collection = new { memberId=mid, amount=2.37m, payMethod="CASH", idempotencyKey=Key() };
        await Ok(await admin.PostAsJsonAsync("/api/deposits/collect", collection));
        await Ok(await admin.PostAsJsonAsync("/api/deposits/collect", collection));
        Assert.Equal(2.63m, M((await Deposit(admin, mid, "BAG")).GetProperty("pool"), "shortfall"));
        var refund = new ApplyRefundRequest("DEPOSIT",mid,null,null,null,"CASH","",Key(),10.17m);
        var pending = await Ok(await clerk.PostAsJsonAsync("/api/refund-requests",refund));
        Assert.Equal(22.20m, M((await Deposit(admin, mid, "BAG")).GetProperty("pool"), "available"));
        await Fails(await admin.PostAsJsonAsync("/api/refund-requests",refund with { IdempotencyKey=Key(), Amount=22.21m }), HttpStatusCode.BadRequest);
        var approval = await Ok(await admin.PostAsJsonAsync($"/api/refund-requests/{pending.GetProperty("id")}/approve", new ApproveRefundRequest(null,null,10.17m)));
        Assert.Equal(10.17m, M(approval,"refundAmount"));
        Assert.Equal(22.20m, M((await Deposit(admin, mid, "BAG")).GetProperty("pool"), "total"));
        await Reconciled(admin);
    }

    [Fact]
    public async Task Amount_Only_Collect_Is_Approved_Once_And_Concurrent_Refunds_Cannot_Overdraw()
    {
        using var admin = await Login();
        var (mid, _) = await Member(admin);
        await Ok(await admin.PutAsJsonAsync("/api/settings/review", new SaveReviewSettingsRequest(true,true,true,false)));
        try
        {
            var req = new { memberId=mid, amount=23.41m, payMethod="CASH", idempotencyKey=Key() };
            var pending = await Ok(await admin.PostAsJsonAsync("/api/deposits/collect",req));
            var pendingPool = (await Deposit(admin,mid,"BAG")).GetProperty("pool");
            Assert.Equal((0m,23.41m), (M(pendingPool,"total"),M(pendingPool,"pendingCollect")));
            await Ok(await admin.PostAsJsonAsync($"/api/refund-requests/{pending.GetProperty("requestId")}/approve", new ApproveRefundRequest(null,null)));
            await Ok(await admin.PostAsJsonAsync("/api/deposits/collect",req));
            var refunds = await Task.WhenAll(Enumerable.Range(0,2).Select(_ =>
                admin.PostAsJsonAsync("/api/deposits/refund",new {memberId=mid, amount=15.07m, payMethod="CASH", idempotencyKey=Key()})));
            Assert.Single(refunds, r => r.IsSuccessStatusCode);
            Assert.Single(refunds, r => r.StatusCode == HttpStatusCode.BadRequest);
            Assert.Equal(8.34m, M((await Deposit(admin,mid,"BUCKET")).GetProperty("pool"),"total"));
            await Reconciled(admin);
        }
        finally { await Ok(await admin.PutAsJsonAsync("/api/settings/review",new SaveReviewSettingsRequest(true,true,false,false))); }
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task Each_Unpaid_Scrap_Is_Decided_Once_And_Paid_Damage_Is_Excluded(bool charge)
    {
        using var admin = await Login();
        var (mid, _) = await Member(admin);
        await Recharge(admin, mid);
        await Opening(admin, mid, holdings:[new("BAG",2)]);
        foreach (var paid in new[] {true,false})
        {
            var damage = await Ok(await admin.PostAsJsonAsync("/api/containers/damages", new ReportContainerDamageRequest(mid,"BAG",1,"袋破了",Key(), FeePaid:paid)));
            await Ok(await admin.PostAsJsonAsync($"/api/containers/damages/{damage.GetProperty("id")}/scrap", new ScrapContainerDamageRequest("报废",Key(),false)));
        }
        var slip = (await Ok(await Preview(admin,mid))).GetProperty("slip");
        var damageLine = Assert.Single(slip.GetProperty("damages").EnumerateArray());
        var request = new SettlementRequest(Key(),"CASH");
        await Fails(await admin.PostAsJsonAsync($"/api/members/{mid}/settlement",request), HttpStatusCode.BadRequest);
        request = request with { DamageDecisions=[new(damageLine.GetProperty("reference").GetString()!,charge)] };
        var receipt = await Ok(await admin.PostAsJsonAsync($"/api/members/{mid}/settlement",request));
        Assert.Equal(charge ? 95m : 100m, M(receipt,"amount"));
        Assert.Equal(receipt.GetProperty("id").GetGuid(), (await Ok(await admin.PostAsJsonAsync($"/api/members/{mid}/settlement",request))).GetProperty("id").GetGuid());
        var after = (await Ok(await Preview(admin,mid))).GetProperty("slip");
        Assert.Empty(after.GetProperty("damages").EnumerateArray());
        var counts = (await Deposit(admin, mid, "BAG")).GetProperty("damageBreakdown");
        Assert.Equal((2,charge ? 0 : 1,charge ? 2 : 1,0), (I(counts,"total"), I(counts,"waived"), I(counts,"paid"), I(counts,"pending")));
        Assert.Equal(0, I((await Deposit(admin, mid, "BUCKET")).GetProperty("damageBreakdown"), "total"));
        var history = after.GetProperty("damageHistory").EnumerateArray().ToArray();
        Assert.Equal(2, history.Sum(d => I(d,"quantity")));
        Assert.Contains(history, d => d.GetProperty("status").GetString()=="PAID");
        Assert.Contains(history, d => d.GetProperty("status").GetString()==(charge ? "SETTLED_CHARGED" : "SETTLED_WAIVED"));
        await Reconciled(admin);
    }

    [Fact]
    public async Task Settlement_Is_Refused_With_Open_Orders_Stale_Totals_Or_Without_Review_Rights()
    {
        using var admin = await Login();
        using var clerk = await Login("YG0012");
        var (mid, _) = await Member(admin);
        await Recharge(admin, mid);
        await Fails(await Preview(clerk, mid), HttpStatusCode.Forbidden);
        await Fails(await admin.PostAsJsonAsync($"/api/members/{mid}/settlement", new SettlementRequest(Key(), "CASH", ExpectedAmount: 99m)), HttpStatusCode.Conflict);

        await Ok(await admin.PostAsJsonAsync("/api/orders", new CreateWaterOrderRequest(mid, Bucket, "PICKUP", 1, Key())));
        var blocked = await Ok(await Preview(admin, mid));
        Assert.Contains("没完成的水单", Assert.Single(blocked.GetProperty("blockers").EnumerateArray()).GetString());
        await Fails(await admin.PostAsJsonAsync($"/api/members/{mid}/settlement", new SettlementRequest(Key(), "CASH")), HttpStatusCode.Conflict);
    }
}
