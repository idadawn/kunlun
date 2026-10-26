using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Kunlun.WaterStation.Auth;
using Kunlun.WaterStation.Operations;
using Xunit;

namespace Kunlun.WaterStation.Tests;

[Collection("KunlunIntegration")]
public sealed class MembershipTests(TestHost host)
{
    private static string Key() => Guid.NewGuid().ToString("N");
    private static async Task<JsonElement> Ok(HttpResponseMessage response)
    {
        var body = await response.Content.ReadAsStringAsync(); Assert.True(response.IsSuccessStatusCode, $"{response.StatusCode}: {body}");
        return JsonSerializer.Deserialize<JsonElement>(body);
    }
    private async Task<HttpClient> Admin(string account = "YG0001")
    {
        var c = host.CreateClient(); var s = await Ok(await c.PostAsJsonAsync("/api/auth/staff/login", new StaffLoginRequest(account, TestHost.Password)));
        c.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", s.GetProperty("accessToken").GetString()); return c;
    }
    private static async Task<Guid> Member(HttpClient c) => (await Ok(await c.PostAsJsonAsync("/api/members", new CreateMemberRequest("批次验收", $"139{Random.Shared.Next(10000000, 99999999)}", "测试地址", null)))).GetProperty("id").GetGuid();
    private static async Task<Guid> Plan(HttpClient c, int qty = 16, decimal price = 100, string mode = "PICKUP") => (await Ok(await c.PostAsJsonAsync("/api/plans", new SaveRechargePlanRequest("验收套餐-" + Key(), "BUCKET_18_9L", mode, price, qty, 0)))).GetProperty("id").GetGuid();
    private static async Task<Guid> Coupon(HttpClient c, Guid member, Guid plan, int gift = 1, int limit = 1)
    {
        var template = await Ok(await c.PostAsJsonAsync("/api/coupon-templates", new SaveCouponRequest("赠水券", plan, gift, DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddDays(1), limit)));
        return (await Ok(await c.PostAsJsonAsync($"/api/coupon-templates/{template.GetProperty("id").GetGuid()}/issue", new IssueCouponRequest(member, Key())))).GetProperty("id").GetGuid();
    }
    private static async Task<JsonElement> Recharge(HttpClient c, Guid member, Guid plan, Guid? coupon = null) => await Ok(await c.PostAsJsonAsync("/api/recharges", new CreateRechargeOrderRequest(member, plan, "CASH", Key(), CouponId: coupon)));
    private static async Task<JsonElement> Order(HttpClient c, Guid member, int qty, string mode = "PICKUP") => await Ok(await c.PostAsJsonAsync("/api/orders", new CreateWaterOrderRequest(member, "BUCKET_18_9L", mode, qty, Key())));
    private static async Task Consume(HttpClient c, Guid member, int qty, string mode = "PICKUP")
    {
        var order = await Order(c, member, qty, mode);
        if (mode == "DELIVERY") await Ok(await c.PostAsync($"/api/orders/{order.GetProperty("id")}/accept", null));
        await Ok(await c.PostAsJsonAsync($"/api/orders/{order.GetProperty("id").GetGuid()}/fulfill", new FulfillWaterOrderRequest(qty, 0, 0)));
    }
    private static async Task<JsonElement> Refund(HttpClient c, Guid batch) => await Ok(await c.PostAsJsonAsync($"/api/ticket-batches/{batch}/refund", new RefundRechargeRequest(Key(), "CASH", "中途退清剩余权益")));

    [Fact]
    public async Task Fixed16_PlusGift1_Consume6_Refund62_50_And_RevokeGift()
    {
        using var c = await Admin(); var m = await Member(c); var p = await Plan(c); var coupon = await Coupon(c, m, p);
        var charge = await Recharge(c, m, p, coupon); var batch = charge.GetProperty("id").GetGuid();
        Assert.Equal(17, charge.GetProperty("totalTickets").GetInt32());
        await Consume(c, m, 6);
        // Edit current package; original transaction still determines refund.
        await Ok(await c.PutAsJsonAsync($"/api/plans/{p}", new SaveRechargePlanRequest("改价-" + Key(), "BUCKET_18_9L", "PICKUP", 200, 20, 0, "DISABLED")));
        var before = await c.GetFromJsonAsync<JsonElement>("/api/reports/finance-summary");
        var request = new RefundRechargeRequest(Key(), "CASH", "中途退款");
        var results = await Task.WhenAll(Enumerable.Range(0, 5).Select(_ => c.PostAsJsonAsync($"/api/ticket-batches/{batch}/refund", request)));
        var ids = new HashSet<string>(); foreach (var response in results) { var json = await Ok(response); ids.Add(json.GetProperty("refundNo").GetString()!); Assert.Equal(62.50m, json.GetProperty("refundAmount").GetDecimal()); Assert.Equal(1, json.GetProperty("revokedGiftQty").GetInt32()); }
        Assert.Single(ids);
        var after = await c.GetFromJsonAsync<JsonElement>("/api/reports/finance-summary");
        Assert.Equal(before.GetProperty("rechargeRefundedTotal").GetDecimal() + 62.50m, after.GetProperty("rechargeRefundedTotal").GetDecimal());
        Assert.Equal(before.GetProperty("depositCollectedTotal").GetDecimal(), after.GetProperty("depositCollectedTotal").GetDecimal());
        var profile = await c.GetFromJsonAsync<JsonElement>($"/api/members/{m}/profile"); Assert.Equal(0, profile.GetProperty("bucketPickupTickets").GetInt32());
        var coupons = await c.GetFromJsonAsync<JsonElement>($"/api/members/{m}/coupons"); Assert.Equal("USED", coupons[0].GetProperty("status").GetString());
        Assert.Equal(HttpStatusCode.Conflict, (await c.PostAsJsonAsync($"/api/ticket-batches/{batch}/refund", request with { IdempotencyKey = Key() })).StatusCode);
    }

    [Theory]
    [InlineData(16, 100, 6, "PICKUP", 62.50)]
    [InlineData(95, 500, 6, "PICKUP", 468.42)]
    [InlineData(13, 100, 6, "DELIVERY", 53.85)]
    [InlineData(70, 500, 6, "DELIVERY", 457.14)]
    public async Task Refund_Uses_Original_Ratio_And_Rounds_Only_Final_Amount(int qty, decimal price, int used, string mode, decimal expected)
    {
        using var c = await Admin(); var m = await Member(c); var p = await Plan(c, qty, price, mode);
        var charge = await Recharge(c, m, p); await Consume(c, m, used, mode);
        Assert.Equal(expected, (await Refund(c, charge.GetProperty("id").GetGuid())).GetProperty("refundAmount").GetDecimal());
    }

    [Fact]
    public async Task FIFO_Reservations_Cancel_Differences_And_PaidBeforeGift()
    {
        using var c = await Admin(); var m = await Member(c); var p = await Plan(c, 2); var coupon = await Coupon(c, m, p);
        var first = await Recharge(c, m, p, coupon); await Recharge(c, m, p);
        var pending = await Order(c, m, 2);
        var giftOrder = await Order(c, m, 1);
        // Gift cannot be consumed while paid tickets are merely reserved by another order.
        Assert.Equal(HttpStatusCode.Conflict, (await c.PostAsJsonAsync($"/api/orders/{giftOrder.GetProperty("id")}/fulfill", new FulfillWaterOrderRequest(1, 0, 0))).StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, (await c.PostAsJsonAsync($"/api/ticket-batches/{first.GetProperty("id")}/refund", new RefundRechargeRequest(Key(), "CASH", "有预占"))).StatusCode);
        await Ok(await c.PostAsJsonAsync($"/api/orders/{giftOrder.GetProperty("id")}/cancel", new CancelWaterOrderRequest("取消赠票订单")));
        await Ok(await c.PostAsJsonAsync($"/api/orders/{pending.GetProperty("id")}/fulfill", new FulfillWaterOrderRequest(3, 0, 0, DiffReason: "增加一桶")));
        var batches = await c.GetFromJsonAsync<JsonElement>($"/api/members/{m}/ticket-batches");
        Assert.Equal(0, batches[0].GetProperty("remainingBuy").GetInt32()); Assert.Equal(0, batches[0].GetProperty("remainingGift").GetInt32());
        Assert.Equal(2, batches[1].GetProperty("remainingBuy").GetInt32());
        // Partial fulfillment releases unused reservations back to the same batch.
        var last = await Order(c, m, 2);
        await Ok(await c.PostAsJsonAsync($"/api/orders/{last.GetProperty("id")}/fulfill", new FulfillWaterOrderRequest(1, 0, 0, DiffReason: "少提一桶")));
        var updated = await c.GetFromJsonAsync<JsonElement>($"/api/members/{m}/ticket-batches"); Assert.Equal(1, updated[1].GetProperty("remainingBuy").GetInt32()); Assert.Equal(0, updated[1].GetProperty("reservedBuy").GetInt32());
    }

    [Fact]
    public async Task Coupon_Ownership_Matching_Expiry_Quota_And_Concurrent_Redemption()
    {
        using var c = await Admin(); var m = await Member(c); var other = await Member(c); var p = await Plan(c); var wrong = await Plan(c);
        var template = await Ok(await c.PostAsJsonAsync("/api/coupon-templates", new SaveCouponRequest("限一次", p, 1, DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddDays(1), 1)));
        var templateId = template.GetProperty("id").GetGuid(); var issue = new IssueCouponRequest(m, Key());
        var issues = await Task.WhenAll(Enumerable.Range(0, 3).Select(_ => c.PostAsJsonAsync($"/api/coupon-templates/{templateId}/issue", issue)));
        var issued = new HashSet<Guid>(); foreach (var r in issues) issued.Add((await Ok(r)).GetProperty("id").GetGuid()); var coupon = Assert.Single(issued);
        Assert.Equal(HttpStatusCode.BadRequest, (await c.PostAsJsonAsync($"/api/coupon-templates/{templateId}/issue", issue with { IdempotencyKey = Key() })).StatusCode);
        foreach (var (member, plan) in new[] { (other, p), (m, wrong) }) Assert.Equal(HttpStatusCode.BadRequest, (await c.PostAsJsonAsync("/api/recharges", new CreateRechargeOrderRequest(member, plan, "CASH", Key(), CouponId: coupon))).StatusCode);
        // Editing template cannot change an already-issued coupon's promised gift.
        await Ok(await c.PutAsJsonAsync($"/api/coupon-templates/{templateId}", new SaveCouponRequest("改为五桶", p, 5, DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddDays(2), 1)));
        var requests = await Task.WhenAll(Enumerable.Range(0, 3).Select(_ => c.PostAsJsonAsync("/api/recharges", new CreateRechargeOrderRequest(m, p, "CASH", Key(), CouponId: coupon))));
        Assert.Single(requests, x => x.IsSuccessStatusCode); Assert.Equal(2, requests.Count(x => x.StatusCode == HttpStatusCode.BadRequest));
        Assert.Equal(1, (await Ok(requests.Single(x => x.IsSuccessStatusCode))).GetProperty("giftQty").GetInt32());
        var expired = await Ok(await c.PostAsJsonAsync("/api/coupon-templates", new SaveCouponRequest("过期券", p, 1, DateTimeOffset.UtcNow.AddDays(-2), DateTimeOffset.UtcNow.AddDays(-1), 1)));
        Assert.Equal(HttpStatusCode.BadRequest, (await c.PostAsJsonAsync($"/api/coupon-templates/{expired.GetProperty("id")}/issue", new IssueCouponRequest(m, Key()))).StatusCode);
    }

    [Fact]
    public async Task Recharge_Concurrent_Replay_Is_Atomic_And_Cannot_Cross_Members()
    {
        using var c = await Admin(); var m = await Member(c); var other = await Member(c); var p = await Plan(c);
        var req = new CreateRechargeOrderRequest(m, p, "CASH", Key());
        var responses = await Task.WhenAll(Enumerable.Range(0, 6).Select(_ => c.PostAsJsonAsync("/api/recharges", req)));
        var ids = new HashSet<Guid>(); foreach (var r in responses) ids.Add((await Ok(r)).GetProperty("id").GetGuid()); Assert.Single(ids);
        Assert.Equal(HttpStatusCode.Conflict, (await c.PostAsJsonAsync("/api/recharges", req with { MemberId = other })).StatusCode);
        Assert.Equal(16, (await c.GetFromJsonAsync<JsonElement>($"/api/members/{m}/profile")).GetProperty("bucketPickupTickets").GetInt32());
        using var clerk = await Admin("YG0012"); Assert.Equal(HttpStatusCode.Forbidden, (await clerk.PostAsJsonAsync($"/api/ticket-batches/{ids.Single()}/refund", new RefundRechargeRequest(Key(), "CASH", "越权"))).StatusCode);
        var legacy = await c.GetFromJsonAsync<JsonElement>("/api/members/20000000-0000-0000-0000-000000008621/ticket-batches");
        Assert.Equal(HttpStatusCode.BadRequest, (await c.PostAsJsonAsync($"/api/ticket-batches/{legacy[0].GetProperty("id")}/refund", new RefundRechargeRequest(Key(), "CASH", "历史余额"))).StatusCode);
    }
    [Fact]
    public async Task Concurrent_Order_And_Refund_Cannot_Spend_The_Same_Tickets()
    {
        using var c = await Admin(); var m = await Member(c); var p = await Plan(c);
        var charge = await Recharge(c, m, p); var id = charge.GetProperty("id").GetGuid();
        var order = c.PostAsJsonAsync("/api/orders", new CreateWaterOrderRequest(m, "BUCKET_18_9L", "PICKUP", 16, Key()));
        var refund = c.PostAsJsonAsync($"/api/ticket-batches/{id}/refund", new RefundRechargeRequest(Key(), "CASH", "并发退款"));
        var responses = await Task.WhenAll(order, refund);
        Assert.True(responses[0].IsSuccessStatusCode ^ responses[1].IsSuccessStatusCode);
        Assert.Contains(responses[0].StatusCode, new[] { HttpStatusCode.OK, HttpStatusCode.BadRequest });
        Assert.Contains(responses[1].StatusCode, new[] { HttpStatusCode.OK, HttpStatusCode.Conflict });
        var profile = await c.GetFromJsonAsync<JsonElement>($"/api/members/{m}/profile");
        Assert.Equal(0, profile.GetProperty("bucketPickupTickets").GetInt32());
        Assert.Equal(responses[0].IsSuccessStatusCode ? 16 : 0, profile.GetProperty("reservedBucketPickupTickets").GetInt32());
    }

    [Fact]
    public async Task Member_Cannot_Read_Or_Mutate_Other_Members_Batches_Coupons_Or_Address()
    {
        using var admin = await Admin(); var other = await Member(admin); using var c = host.CreateClient();
        var login = await Ok(await c.PostAsJsonAsync("/api/auth/member/login", new StaffLoginRequest("No.008621", TestHost.Password)));
        c.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", login.GetProperty("accessToken").GetString());
        foreach (var suffix in new[] { "ticket-batches", "coupons", "deposit-summary" }) Assert.Equal(HttpStatusCode.Forbidden, (await c.GetAsync($"/api/members/{other}/{suffix}")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await c.PutAsJsonAsync($"/api/members/{other}/address", new SaveAddressRequest("越权地址"))).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await c.PostAsJsonAsync("/api/recharges", new CreateRechargeOrderRequest(other, Guid.NewGuid(), "CASH", Key()))).StatusCode);
        var self = login.GetProperty("subjectId").GetGuid();
        await Ok(await c.PutAsJsonAsync($"/api/members/{self}/address", new SaveAddressRequest("会员自助修改地址")));
        Assert.Equal("会员自助修改地址", (await c.GetFromJsonAsync<JsonElement>($"/api/members/{self}/profile")).GetProperty("defaultAddress").GetString());
    }

}
