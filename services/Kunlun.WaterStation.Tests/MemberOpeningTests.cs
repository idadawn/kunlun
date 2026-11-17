using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Kunlun.WaterStation.Auth;
using Kunlun.WaterStation.Operations;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using Xunit;

namespace Kunlun.WaterStation.Tests;

/// <summary>补录会员上系统前的数据：套餐余量、押金和手里的桶袋。数据库由整组测试共用，所以汇总数一律比较前后差值。</summary>
[Collection("KunlunIntegration")]
public sealed class MemberOpeningTests(TestHost host)
{
    private const string Bucket = "BUCKET_18_9L", Bag = "BAG_7_5L";
    private static string Key() => Guid.NewGuid().ToString("N");
    private static async Task<JsonElement> Ok(HttpResponseMessage response)
    {
        var body = await response.Content.ReadAsStringAsync(); Assert.True(response.IsSuccessStatusCode, $"{response.StatusCode}: {body}");
        return JsonSerializer.Deserialize<JsonElement>(body);
    }
    private async Task<HttpClient> Client(string account = "YG0001")
    {
        var c = host.CreateClient(); var s = await Ok(await c.PostAsJsonAsync("/api/auth/staff/login", new StaffLoginRequest(account, TestHost.Password)));
        c.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", s.GetProperty("accessToken").GetString()); return c;
    }
    private static async Task<JsonElement> Member(HttpClient c) =>
        await Ok(await c.PostAsJsonAsync("/api/members", new CreateMemberRequest("老会员", $"137{Random.Shared.Next(10000000, 99999999)}", "老小区 1 栋", null, "2-201")));
    private static Task<HttpResponseMessage> Save(HttpClient c, Guid mid, SaveOpeningRequest req) => c.PostAsJsonAsync($"/api/members/{mid}/opening", req);
    private static SaveOpeningRequest Request(OpeningTicketInput[]? tickets = null, OpeningDepositInput[]? deposits = null, OpeningHoldingInput[]? holdings = null, string? note = null) =>
        new(Key(), tickets, deposits, holdings, note);
    private static async Task<JsonElement> Profile(HttpClient c, Guid mid) => await c.GetFromJsonAsync<JsonElement>($"/api/members/{mid}/profile");
    private static async Task<JsonElement[]> Batches(HttpClient c, Guid mid) => (await c.GetFromJsonAsync<JsonElement>($"/api/members/{mid}/ticket-batches")).EnumerateArray().ToArray();
    private static async Task<JsonElement> Deposit(HttpClient c, Guid mid, string type) =>
        (await c.GetFromJsonAsync<JsonElement>($"/api/members/{mid}/deposit-summary")).EnumerateArray().Single(r => r.GetProperty("containerType").GetString() == type);
    private static async Task<JsonElement> Stock(HttpClient c, string type) =>
        (await c.GetFromJsonAsync<JsonElement>("/api/containers/summary")).EnumerateArray().Single(r => r.GetProperty("containerType").GetString() == type);
    private static async Task<JsonElement> Finance(HttpClient c) => await c.GetFromJsonAsync<JsonElement>("/api/reports/finance-summary");
    private static decimal M(JsonElement x, string field) => x.GetProperty(field).GetDecimal();
    private static int I(JsonElement x, string field) => x.GetProperty(field).GetInt32();
    private static string S(JsonElement x, string field) => x.GetProperty(field).GetString()!;
    private static Guid Id(JsonElement x) => x.GetProperty("id").GetGuid();
    private static async Task<string[]> Permissions(HttpClient c) =>
        (await c.GetFromJsonAsync<JsonElement>("/api/auth/me")).GetProperty("permissions").EnumerateArray().Select(p => p.GetString()!).ToArray();

    [Fact]
    public async Task Admin_Records_Package_Left_Deposit_And_Buckets_Without_Counting_Them_As_Todays_Money()
    {
        using var c = await Client(); var member = await Member(c); var mid = Id(member); var memberNo = S(member, "memberNo");
        var financeBefore = await Finance(c); var stockBefore = await Stock(c, "BUCKET");
        var receipt = await Ok(await Save(c, mid, Request(
            tickets: [new(WaterType: Bucket, FulfillMode: "PICKUP", PlanId: WaterProducts.PlanId("102"), PaidAmount: 499, PackageQty: 95, Remaining: 40),
                      new(WaterType: Bag, FulfillMode: "DELIVERY", Remaining: 10)],
            deposits: [new("BUCKET", 2, 50)],
            holdings: [new("BUCKET", 3)],
            note: "纸质台账第 3 页")));
        var entryNo = S(receipt, "entryNo");
        Assert.StartsWith("QC", entryNo);
        Assert.Equal(4, receipt.GetProperty("items").GetArrayLength());

        var profile = await Profile(c, mid);
        Assert.Equal(40, profile.Tickets(Bucket, "PICKUP"));
        Assert.Equal(10, profile.Tickets(Bag, "DELIVERY"));
        Assert.Equal(100m, M(profile, "depositAmount"));
        Assert.Equal(3, I(profile, "heldBuckets"));

        // The package keeps its original price: refunding what is left pays 499 × 40 ÷ 95.
        var batches = await Batches(c, mid);
        var priced = batches.Single(b => S(b, "waterType") == Bucket);
        Assert.Equal("OPENING", S(priced, "source"));
        Assert.Equal(210.11m, M(priced, "remainingValue"));
        Assert.Equal(210.11m, M(priced, "refundableAmount"));
        Assert.Contains("上系统前", S(priced, "name"));
        Assert.Equal("15L 桶装水", S(priced, "waterLabel"));
        Assert.Equal(entryNo, S(priced.GetProperty("opening"), "entryNo"));
        // Members read this list too: the staff note and who entered it stay on the entry.
        Assert.False(priced.GetProperty("opening").TryGetProperty("note", out _));
        Assert.False(priced.GetProperty("opening").TryGetProperty("operatorName", out _));
        Assert.True(priced.GetProperty("removable").GetBoolean());
        var unknown = batches.Single(b => S(b, "waterType") == Bag);
        Assert.Equal(0m, M(unknown, "remainingValue"));
        Assert.Contains("套餐不清楚", S(unknown, "name"));

        var deposit = await Deposit(c, mid, "BUCKET");
        Assert.Equal(2, I(deposit, "paidQty")); Assert.Equal(100m, M(deposit, "paidAmount")); Assert.Equal(3, I(deposit, "heldQty")); Assert.Equal(0, I(deposit, "refundableQty"));

        // Registered to the member without leaving the store; 客户手里 is at least what members hold.
        var stock = await Stock(c, "BUCKET");
        Assert.Equal(I(stockBefore, "memberHeldQty") + 3, I(stock, "memberHeldQty"));
        Assert.Equal(I(stockBefore, "inStationQty"), I(stock, "inStationQty"));
        Assert.Equal(Math.Max(I(stockBefore, "withCustomersQty"), I(stockBefore, "memberHeldQty") + 3), I(stock, "withCustomersQty"));
        Assert.True(stock.GetProperty("identityValid").GetBoolean());

        var finance = await Finance(c);
        Assert.Equal(M(financeBefore, "rechargeRevenueTotal"), M(finance, "rechargeRevenueTotal"));
        Assert.Equal(M(financeBefore, "depositCollectedTotal"), M(finance, "depositCollectedTotal"));
        Assert.Equal(I(financeBefore, "depositCollectCount"), I(finance, "depositCollectCount"));
        Assert.Equal(M(financeBefore, "depositOpeningTotal") + 100, M(finance, "depositOpeningTotal"));
        Assert.Equal(M(financeBefore, "unrefundedDepositPoolTotal") + 100, M(finance, "unrefundedDepositPoolTotal"));
        Assert.True(finance.GetProperty("reconciledZeroDiff").GetBoolean());
        Assert.Equal(M(financeBefore, "unusedRechargeValue"), M(finance, "unusedRechargeValue"));
        Assert.Equal(M(financeBefore, "rechargeEarnedTotal"), M(finance, "rechargeEarnedTotal"));
        Assert.Equal(M(financeBefore, "openingUnusedValue") + 210.11m, M(finance, "openingUnusedValue"));
        Assert.Equal(I(financeBefore, "openingPaidTicketQty") + 40, I(finance, "openingPaidTicketQty"));
        Assert.Equal(I(financeBefore, "legacyTicketQty") + 10, I(finance, "legacyTicketQty"));
        Assert.Equal(M(financeBefore, "potentialRefundTotal") + 310.11m, M(finance, "potentialRefundTotal"));

        var q = Uri.EscapeDataString(memberNo);
        var deposits = (await c.GetFromJsonAsync<JsonElement>($"/api/ledgers/deposits?q={q}&page=1")).GetProperty("rows").EnumerateArray().ToArray();
        var opening = Assert.Single(deposits);
        Assert.Equal("OPENING", S(opening, "flowType")); Assert.Equal(100m, M(opening, "amount")); Assert.Equal("OPENING", S(opening, "payMethod"));
        Assert.Equal(0, I(await c.GetFromJsonAsync<JsonElement>($"/api/ledgers/deposits?q={q}&flowType=COLLECT&page=1"), "total"));
        Assert.Contains(",OPENING,", await c.GetStringAsync("/api/exports/deposit-ledgers"));
        var flow = Assert.Single((await c.GetFromJsonAsync<JsonElement>($"/api/containers/circulation?q={q}")).GetProperty("rows").EnumerateArray());
        Assert.Equal("OPENING", S(flow, "businessType")); Assert.Equal(3, I(flow, "deltaHeld")); Assert.Equal(3, I(flow, "heldAfter")); Assert.Equal(entryNo, S(flow, "referenceNo"));

        var recorded = await c.GetFromJsonAsync<JsonElement>($"/api/members/{mid}/opening");
        var entry = Assert.Single(recorded.GetProperty("entries").EnumerateArray());
        Assert.Equal(entryNo, S(entry, "entryNo"));
        Assert.Equal("纸质台账第 3 页", S(entry, "note"));
        var lot = Assert.Single(recorded.GetProperty("deposits").EnumerateArray());
        Assert.Equal(2, I(lot, "quantity")); Assert.Equal(50m, M(lot, "unitPrice")); Assert.False(lot.GetProperty("locked").GetBoolean());
    }

    [Fact]
    public async Task Only_The_Permission_Records_And_Retries_Or_Failures_Never_Count_Twice()
    {
        using var c = await Client(); var mid = Id(await Member(c));
        Assert.Contains(KunlunPermissions.MemberOpening, await Permissions(c));
        var req = Request(tickets: [new(WaterType: Bucket, FulfillMode: "PICKUP", Remaining: 5)]);
        using (var clerk = await Client("YG0012"))
        {
            Assert.DoesNotContain(KunlunPermissions.MemberOpening, await Permissions(clerk));
            Assert.Equal(HttpStatusCode.Forbidden, (await Save(clerk, mid, req)).StatusCode);
        }
        var replies = await Task.WhenAll(Enumerable.Range(0, 4).Select(_ => Save(c, mid, req)));
        var numbers = new HashSet<string>(); foreach (var reply in replies) numbers.Add(S(await Ok(reply), "entryNo"));
        Assert.Single(numbers);
        Assert.Equal(5, (await Profile(c, mid)).Tickets(Bucket, "PICKUP"));
        Assert.Equal(HttpStatusCode.Conflict, (await Save(c, mid, req with { Note = "换个备注" })).StatusCode);

        // Nothing differs from what is on record, a package cannot hold less than is left, and a package must match its water.
        Assert.Equal(HttpStatusCode.BadRequest, (await Save(c, mid, Request(holdings: [new("BUCKET", 0)]))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await Save(c, mid, Request(tickets: [new(WaterType: Bucket, FulfillMode: "PICKUP", PaidAmount: 100, PackageQty: 16, Remaining: 17)]))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await Save(c, mid, Request(tickets: [new(WaterType: Bag, FulfillMode: "PICKUP", PlanId: WaterProducts.PlanId("102"), PaidAmount: 499, PackageQty: 95, Remaining: 1)]))).StatusCode);
        // One bad part fails the whole entry.
        Assert.Equal(HttpStatusCode.BadRequest, (await Save(c, mid, Request(tickets: [new(WaterType: Bucket, FulfillMode: "DELIVERY", Remaining: 3)], deposits: [new("BUCKET", 1, 0)]))).StatusCode);
        Assert.Equal(0, (await Profile(c, mid)).Tickets(Bucket, "DELIVERY"));
        Assert.Single((await c.GetFromJsonAsync<JsonElement>($"/api/members/{mid}/opening")).GetProperty("entries").EnumerateArray());
        // Only opening batches can be changed here.
        var plan = Id(await Ok(await c.PostAsJsonAsync("/api/plans", new SaveRechargePlanRequest("补录验收-" + Key(), Bucket, "PICKUP", 100, 16, 0))));
        var recharge = Id(await Ok(await c.PostAsJsonAsync("/api/recharges", new CreateRechargeOrderRequest(mid, plan, "CASH", Key()))));
        Assert.Equal(HttpStatusCode.BadRequest, (await Save(c, mid, Request(tickets: [new(BatchId: recharge, Remaining: 1)]))).StatusCode);
    }

    [Fact]
    public async Task Packages_From_Before_Are_Used_First_And_Refund_At_Their_Original_Price()
    {
        using var c = await Client(); var mid = Id(await Member(c));
        // Recharged in the system first and the older package recorded afterwards: the older one is still used first.
        var plan = Id(await Ok(await c.PostAsJsonAsync("/api/plans", new SaveRechargePlanRequest("先用旧套餐-" + Key(), Bucket, "PICKUP", 100, 16, 0))));
        await Ok(await c.PostAsJsonAsync("/api/recharges", new CreateRechargeOrderRequest(mid, plan, "CASH", Key())));
        await Ok(await Save(c, mid, Request(tickets: [new(WaterType: Bucket, FulfillMode: "PICKUP", PaidAmount: 499, PackageQty: 95, Remaining: 40)])));
        var batches = await Batches(c, mid);
        Assert.Equal("OPENING", S(batches[0], "source"));
        var opening = Id(batches[0]);
        var order = await Ok(await c.PostAsJsonAsync("/api/orders", new CreateWaterOrderRequest(mid, Bucket, "PICKUP", 5, Key())));
        await Ok(await c.PostAsJsonAsync($"/api/orders/{Id(order)}/fulfill", new FulfillWaterOrderRequest(5, 0, 0)));
        batches = await Batches(c, mid);
        Assert.Equal(35, I(batches.Single(b => Id(b) == opening), "remainingBuy"));
        Assert.Equal(16, I(batches.Single(b => S(b, "source") == "PURCHASE"), "remainingBuy"));
        Assert.False(batches.Single(b => Id(b) == opening).GetProperty("removable").GetBoolean());

        var before = await Finance(c);
        var refund = await Ok(await c.PostAsJsonAsync($"/api/ticket-batches/{opening}/refund", new RefundRechargeRequest(Key(), "CASH", "搬家")));
        Assert.Equal(183.84m, M(refund, "refundAmount")); // 499 × 35 ÷ 95
        var after = await Finance(c);
        Assert.Equal(M(before, "rechargeRefundedTotal") + 183.84m, M(after, "rechargeRefundedTotal"));
        Assert.Equal(M(before, "openingRefundedTotal") + 183.84m, M(after, "openingRefundedTotal"));
        Assert.Equal(M(before, "openingUnusedValue") - 183.84m, M(after, "openingUnusedValue"));
        // Paying back a package bought before the system does not change what members used of recharges made in it.
        Assert.Equal(M(before, "rechargeEarnedTotal"), M(after, "rechargeEarnedTotal"));
        var refunds = await c.GetFromJsonAsync<JsonElement>($"/api/ledgers/recharge-refunds?q={S(refund, "refundNo")}&page=1");
        Assert.Contains("上系统前", S(Assert.Single(refunds.GetProperty("rows").EnumerateArray()), "planName"));
        Assert.Equal(HttpStatusCode.Conflict, (await Save(c, mid, Request(tickets: [new(BatchId: opening, Remaining: 10)]))).StatusCode);

        // Without a known package there is no original price to pay back.
        await Ok(await Save(c, mid, Request(tickets: [new(WaterType: Bucket, FulfillMode: "DELIVERY", Remaining: 4)])));
        var unknown = Id((await Batches(c, mid)).Single(b => S(b, "source") == "OPENING" && S(b, "fulfillMode") == "DELIVERY"));
        Assert.Equal(HttpStatusCode.BadRequest, (await c.PostAsJsonAsync($"/api/ticket-batches/{unknown}/refund", new RefundRechargeRequest(Key(), "CASH", "试退"))).StatusCode);
    }

    [Fact]
    public async Task Mistakes_Can_Be_Corrected_Until_Orders_Or_Refunds_Depend_On_Them()
    {
        using var c = await Client(); var mid = Id(await Member(c));
        await Ok(await Save(c, mid, Request(
            tickets: [new(WaterType: Bucket, FulfillMode: "PICKUP", PaidAmount: 100, PackageQty: 16, Remaining: 10), new(WaterType: Bag, FulfillMode: "PICKUP", Remaining: 6)],
            deposits: [new("BUCKET", 2, 50), new("BAG", 1, 5)],
            holdings: [new("BUCKET", 2)])));
        var batches = await Batches(c, mid);
        var bucket = Id(batches.Single(b => S(b, "waterType") == Bucket)); var bag = Id(batches.Single(b => S(b, "waterType") == Bag));

        // The bag balance was a mistake and nothing used it yet; the bucket one is corrected to what is really left.
        var fix = await Ok(await Save(c, mid, Request(tickets: [new(BatchId: bag, Remove: true), new(BatchId: bucket, Remaining: 8)], deposits: [new("BAG", 0)])));
        Assert.Equal(3, fix.GetProperty("items").GetArrayLength());
        var profile = await Profile(c, mid);
        Assert.Equal(8, profile.Tickets(Bucket, "PICKUP")); Assert.Equal(0, profile.Tickets(Bag, "PICKUP")); Assert.Equal(100m, M(profile, "depositAmount"));
        Assert.Single(await Batches(c, mid));
        Assert.Equal(0, I(await Deposit(c, mid, "BAG"), "paidQty"));

        // An open order holds 3: what is left cannot drop below that, and a used batch cannot be removed.
        await Ok(await c.PostAsJsonAsync("/api/orders", new CreateWaterOrderRequest(mid, Bucket, "PICKUP", 3, Key())));
        Assert.Equal(HttpStatusCode.Conflict, (await Save(c, mid, Request(tickets: [new(BatchId: bucket, Remaining: 2)]))).StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, (await Save(c, mid, Request(tickets: [new(BatchId: bucket, Remove: true)]))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await Save(c, mid, Request(tickets: [new(BatchId: bucket, Remaining: 17)]))).StatusCode);
        await Ok(await Save(c, mid, Request(tickets: [new(BatchId: bucket, Remaining: 12)])));
        profile = await Profile(c, mid);
        Assert.Equal(9, profile.Tickets(Bucket, "PICKUP")); Assert.Equal(3, profile.Tickets(Bucket, "PICKUP", reserved: true));

        // The untouched opening deposit can still be changed; holding one fewer leaves the store and 客户手里 as they were.
        var stockBefore = await Stock(c, "BUCKET");
        await Ok(await Save(c, mid, Request(deposits: [new("BUCKET", 3, 40)], holdings: [new("BUCKET", 1)])));
        var deposit = await Deposit(c, mid, "BUCKET");
        Assert.Equal(3, I(deposit, "paidQty")); Assert.Equal(120m, M(deposit, "paidAmount")); Assert.Equal(1, I(deposit, "heldQty"));
        Assert.Equal(2, I(deposit, "refundableQty")); Assert.Equal(80m, M(deposit, "refundableAmount"));
        Assert.Equal(120m, M(await Profile(c, mid), "depositAmount"));
        var stock = await Stock(c, "BUCKET");
        Assert.Equal(I(stockBefore, "memberHeldQty") - 1, I(stock, "memberHeldQty"));
        Assert.Equal(Math.Max(I(stockBefore, "withCustomersQty"), I(stockBefore, "memberHeldQty") - 1), I(stock, "withCustomersQty"));
        Assert.Equal(I(stockBefore, "inStationQty"), I(stock, "inStationQty"));
        Assert.True(stock.GetProperty("identityValid").GetBoolean());

        // Once part of it is refunded at its recorded price it is history: refunds go through 退押金.
        var refund = await Ok(await c.PostAsJsonAsync("/api/deposits/refund", new RefundDepositRequest(mid, "BUCKET", 1, Key(), "CASH")));
        Assert.Equal(40m, M(refund, "refundAmount"));
        Assert.Equal(HttpStatusCode.Conflict, (await Save(c, mid, Request(deposits: [new("BUCKET", 5, 40)]))).StatusCode);
        var recorded = await c.GetFromJsonAsync<JsonElement>($"/api/members/{mid}/opening");
        Assert.True(Assert.Single(recorded.GetProperty("deposits").EnumerateArray()).GetProperty("locked").GetBoolean());
        var entries = recorded.GetProperty("entries").EnumerateArray().ToArray();
        Assert.Equal(4, entries.Length);
        Assert.Equal("ADJUST", S(entries[0].GetProperty("items")[0], "action")); // newest first
    }

    [Fact]
    public async Task Administrators_From_Before_The_Permission_Get_It_On_Start_Without_Signing_In_Again()
    {
        using var c = await Client();
        await using (var conn = host.OpenDatabase())
        await using (var strip = new NpgsqlCommand("UPDATE plugin_kunlun_waterstation.staff SET permissions=permissions - 'kunlun.waterstation:member:opening' WHERE staff_no='YG0001'", conn))
            Assert.Equal(1, await strip.ExecuteNonQueryAsync());
        Assert.DoesNotContain(KunlunPermissions.MemberOpening, await Permissions(c));
        await MemberOpening.EnsureSchema(host.Services.GetRequiredService<NpgsqlDataSource>(), host.Services.GetRequiredService<KunlunAuthRepository>().DefaultTenantId);
        Assert.Contains(KunlunPermissions.MemberOpening, await Permissions(c));
    }
}
