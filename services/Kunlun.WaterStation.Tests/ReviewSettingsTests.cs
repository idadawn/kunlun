using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Kunlun.WaterStation.Auth;
using Kunlun.WaterStation.Operations;
using Xunit;

namespace Kunlun.WaterStation.Tests;

/// <summary>充值时可手动赠送；后台两个审核开关决定店员的赠送和退款要不要等管理员，管理员自己办理总是直接生效。</summary>
[Collection("KunlunIntegration")]
public sealed class ReviewSettingsTests(TestHost host)
{
    private static string Key() => Guid.NewGuid().ToString("N");
    private static readonly Guid BucketPickupPlan = WaterProducts.PlanId("101");

    private async Task<HttpClient> Login(string account)
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
    private static async Task<(Guid Id, string No)> Member(HttpClient c)
    {
        var m = await Ok(await c.PostAsJsonAsync("/api/members", new CreateMemberRequest("审核开关验收", $"135{Random.Shared.Next(10000000, 99999999)}", "开关小区", null, "1-101")));
        return (m.GetProperty("id").GetGuid(), m.GetProperty("memberNo").GetString()!);
    }
    private static async Task<int> Tickets(HttpClient c, Guid mid) =>
        (await c.GetFromJsonAsync<JsonElement>($"/api/members/{mid}/profile")).Tickets("BUCKET_18_9L", "PICKUP");
    private static async Task<decimal> DepositBalance(HttpClient c, Guid mid) =>
        (await c.GetFromJsonAsync<JsonElement>($"/api/members/{mid}/profile")).GetProperty("depositAmount").GetDecimal();
    private static Task<HttpResponseMessage> Recharge(HttpClient c, Guid mid, int gift) =>
        c.PostAsJsonAsync("/api/recharges", new CreateRechargeOrderRequest(mid, BucketPickupPlan, "CASH", Key(), GiftQty: gift));
    private static async Task<JsonElement> RechargeRow(HttpClient c, string memberNo, int index = 0) =>
        (await c.GetFromJsonAsync<JsonElement>($"/api/ledgers/recharges?q={memberNo}&page=1")).GetProperty("rows")[index];
    private static async Task<JsonElement> Requests(HttpClient c, string query) =>
        (await c.GetFromJsonAsync<JsonElement>($"/api/refund-requests?{query}&page=1")).GetProperty("rows");
    private static async Task Switches(HttpClient admin, bool gift, bool refund) =>
        await Ok(await admin.PutAsJsonAsync("/api/settings/review", new SaveReviewSettingsRequest(gift, refund)));

    [Fact]
    public async Task Clerk_Gift_Waits_For_Approval_While_The_Paid_Tickets_Arrive_At_Once()
    {
        using var admin = await Login("YG0001");
        using var clerk = await Login("YG0012");
        await Switches(admin, gift: true, refund: true);
        var (mid, memberNo) = await Member(admin);

        var recharge = await Ok(await Recharge(clerk, mid, gift: 2));
        var paid = recharge.GetProperty("buyQty").GetInt32();
        Assert.Equal(0, recharge.GetProperty("giftQty").GetInt32());
        Assert.Equal(2, recharge.GetProperty("pendingGiftQty").GetInt32());
        Assert.Equal(paid, await Tickets(admin, mid));
        Assert.Equal("PENDING", (await RechargeRow(admin, memberNo)).GetProperty("giftReview").GetProperty("status").GetString());
        var batch = (await admin.GetFromJsonAsync<JsonElement>($"/api/members/{mid}/ticket-batches")).EnumerateArray().Single();
        Assert.Equal(2, batch.GetProperty("pendingGiftQty").GetInt32());
        Assert.Equal(JsonValueKind.Null, batch.GetProperty("pendingRequestNo").ValueKind);

        var gift = Assert.Single((await Requests(admin, $"kind=GIFT&status=PENDING&q={memberNo}")).EnumerateArray());
        Assert.Equal(2, gift.GetProperty("quantity").GetInt32());
        Assert.Equal("林晓峰（小林）", gift.GetProperty("applicantName").GetString());
        var giftId = gift.GetProperty("id").GetGuid();
        Assert.Equal(HttpStatusCode.Forbidden, (await clerk.PostAsJsonAsync($"/api/refund-requests/{giftId}/approve", new ApproveRefundRequest(null, null))).StatusCode);
        await Ok(await admin.PostAsJsonAsync($"/api/refund-requests/{giftId}/approve", new ApproveRefundRequest(null, "老客户")));
        Assert.Equal(paid + 2, await Tickets(admin, mid));
        var row = await RechargeRow(admin, memberNo);
        Assert.Equal(2, row.GetProperty("giftQty").GetInt32());
        Assert.Equal("APPROVED", row.GetProperty("giftReview").GetProperty("status").GetString());
        Assert.Equal("林站长", row.GetProperty("giftReview").GetProperty("reviewerName").GetString());
        Assert.Equal(HttpStatusCode.Conflict, (await admin.PostAsJsonAsync($"/api/refund-requests/{giftId}/reject", new RejectRefundRequest("晚了"))).StatusCode);

        // Refunding the recharge takes the approved gift back with the paid tickets.
        var refund = await Ok(await admin.PostAsJsonAsync("/api/refund-requests", new ApplyRefundRequest("RECHARGE", mid, null, null, batch.GetProperty("id").GetGuid(), "CASH", null, Key())));
        Assert.Equal("APPROVED", refund.GetProperty("status").GetString());
        Assert.Equal(0, await Tickets(admin, mid));
        var refunded = Assert.Single((await admin.GetFromJsonAsync<JsonElement>($"/api/ledgers/recharge-refunds?q={memberNo}&page=1")).GetProperty("rows").EnumerateArray());
        Assert.Equal(2, refunded.GetProperty("revokedGiftQty").GetInt32());
    }

    [Fact]
    public async Task Rejected_Gift_Never_Arrives_And_A_Refund_Voids_A_Waiting_Gift()
    {
        using var admin = await Login("YG0001");
        using var clerk = await Login("YG0012");
        await Switches(admin, gift: true, refund: true);
        var (mid, memberNo) = await Member(admin);

        var first = await Ok(await Recharge(clerk, mid, gift: 3));
        var paid = first.GetProperty("buyQty").GetInt32();
        var firstGift = (await Requests(admin, $"kind=GIFT&q={first.GetProperty("rechargeNo").GetString()}"))[0].GetProperty("id").GetGuid();
        await Ok(await admin.PostAsJsonAsync($"/api/refund-requests/{firstGift}/reject", new RejectRefundRequest("赠送数量不对")));
        Assert.Equal(paid, await Tickets(admin, mid));
        var rejected = (await RechargeRow(admin, memberNo)).GetProperty("giftReview");
        Assert.Equal("REJECTED", rejected.GetProperty("status").GetString());
        Assert.Equal("赠送数量不对", rejected.GetProperty("reviewNote").GetString());

        // A recharge refunded while its gift waits takes the gift down with it.
        var second = await Ok(await Recharge(clerk, mid, gift: 1));
        var secondGift = (await Requests(admin, $"kind=GIFT&status=PENDING&q={memberNo}"))[0].GetProperty("id").GetGuid();
        await Ok(await admin.PostAsJsonAsync($"/api/ticket-batches/{second.GetProperty("id").GetGuid()}/refund", new RefundRechargeRequest(Key(), "CASH", "办错了")));
        var voided = Assert.Single((await Requests(admin, $"kind=GIFT&status=REJECTED&q={second.GetProperty("rechargeNo").GetString()}")).EnumerateArray());
        Assert.Equal("充值已退款，赠送作废", voided.GetProperty("reviewNote").GetString());
        Assert.Equal(HttpStatusCode.Conflict, (await admin.PostAsJsonAsync($"/api/refund-requests/{secondGift}/approve", new ApproveRefundRequest(null, null))).StatusCode);
        Assert.Equal(paid, await Tickets(admin, mid));
    }

    [Fact]
    public async Task With_Review_Off_Clerk_Gifts_And_Refunds_Take_Effect_At_Once()
    {
        using var admin = await Login("YG0001");
        using var clerk = await Login("YG0012");
        var (mid, memberNo) = await Member(admin);
        try
        {
            await Switches(admin, gift: false, refund: false);
            var recharge = await Ok(await Recharge(clerk, mid, gift: 3));
            var paid = recharge.GetProperty("buyQty").GetInt32();
            Assert.Equal(3, recharge.GetProperty("giftQty").GetInt32());
            Assert.Equal(0, recharge.GetProperty("pendingGiftQty").GetInt32());
            Assert.Equal(paid + 3, await Tickets(admin, mid));
            Assert.Equal(JsonValueKind.Null, (await RechargeRow(admin, memberNo)).GetProperty("giftReview").ValueKind);

            var unit = (await Ok(await admin.PostAsJsonAsync("/api/deposits/collect", new CollectDepositRequest(mid, "BUCKET", 2, "CASH", Key())))).GetProperty("unitPrice").GetDecimal();
            var deposit = await Ok(await clerk.PostAsJsonAsync("/api/refund-requests", new ApplyRefundRequest("DEPOSIT", mid, "BUCKET", 1, null, "WECHAT", null, Key())));
            Assert.Equal("APPROVED", deposit.GetProperty("status").GetString());
            Assert.Equal(unit, deposit.GetProperty("refundAmount").GetDecimal());
            Assert.Equal(unit, await DepositBalance(admin, mid));
            var flow = Assert.Single((await admin.GetFromJsonAsync<JsonElement>($"/api/ledgers/deposits?q={memberNo}&flowType=REFUND&page=1")).GetProperty("rows").EnumerateArray());
            Assert.Equal("林晓峰（小林）", flow.GetProperty("applicantName").GetString());
            var request = Assert.Single((await Requests(admin, $"kind=DEPOSIT&q={memberNo}")).EnumerateArray());
            Assert.Equal("无需审核，直接退款", request.GetProperty("reviewNote").GetString());

            var batch = recharge.GetProperty("id").GetGuid();
            var water = await Ok(await clerk.PostAsJsonAsync("/api/refund-requests", new ApplyRefundRequest("RECHARGE", mid, null, null, batch, "CASH", "", Key())));
            Assert.Equal("APPROVED", water.GetProperty("status").GetString());
            Assert.Equal(0, await Tickets(admin, mid));
        }
        finally
        {
            await Switches(admin, gift: true, refund: true);
        }
    }

    [Fact]
    public async Task Admins_Own_Gifts_And_Refunds_Never_Wait()
    {
        using var admin = await Login("YG0001");
        await Switches(admin, gift: true, refund: true);
        var (mid, memberNo) = await Member(admin);
        var recharge = await Ok(await Recharge(admin, mid, gift: 1));
        Assert.Equal(1, recharge.GetProperty("giftQty").GetInt32());
        Assert.Equal(0, recharge.GetProperty("pendingGiftQty").GetInt32());

        await Ok(await admin.PostAsJsonAsync("/api/deposits/collect", new CollectDepositRequest(mid, "BUCKET", 1, "CASH", Key())));
        var refund = await Ok(await admin.PostAsJsonAsync("/api/refund-requests", new ApplyRefundRequest("DEPOSIT", mid, "BUCKET", 1, null, "CASH", "搬家", Key())));
        Assert.Equal("APPROVED", refund.GetProperty("status").GetString());
        Assert.Equal(0m, await DepositBalance(admin, mid));
        var request = Assert.Single((await Requests(admin, $"kind=DEPOSIT&q={memberNo}")).EnumerateArray());
        Assert.Equal("管理员直接办理", request.GetProperty("reviewNote").GetString());
    }

    [Fact]
    public async Task Only_Admins_Change_The_Switches_And_Gifts_Stay_In_Range()
    {
        using var admin = await Login("YG0001");
        using var clerk = await Login("YG0012");
        var saved = await Ok(await admin.PutAsJsonAsync("/api/settings/review", new SaveReviewSettingsRequest(true, true)));
        Assert.Equal("林站长", saved.GetProperty("updatedBy").GetString());
        var read = await clerk.GetFromJsonAsync<JsonElement>("/api/settings/review");
        Assert.True(read.GetProperty("giftReview").GetBoolean() && read.GetProperty("refundReview").GetBoolean());
        Assert.Equal(HttpStatusCode.Forbidden, (await clerk.PutAsJsonAsync("/api/settings/review", new SaveReviewSettingsRequest(false, false))).StatusCode);

        var (mid, _) = await Member(admin);
        Assert.Equal(HttpStatusCode.BadRequest, (await Recharge(admin, mid, gift: -1)).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await Recharge(admin, mid, gift: 1001)).StatusCode);
        // The same request key cannot come back with a different gift.
        var key = Key();
        await Ok(await admin.PostAsJsonAsync("/api/recharges", new CreateRechargeOrderRequest(mid, BucketPickupPlan, "CASH", key, GiftQty: 1)));
        Assert.Equal(HttpStatusCode.Conflict, (await admin.PostAsJsonAsync("/api/recharges", new CreateRechargeOrderRequest(mid, BucketPickupPlan, "CASH", key, GiftQty: 2))).StatusCode);
    }
}
