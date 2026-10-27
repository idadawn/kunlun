using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Kunlun.WaterStation.Auth;
using Kunlun.WaterStation.Operations;
using Xunit;

namespace Kunlun.WaterStation.Tests;

/// <summary>所有退款先登记申请，管理员审核通过才退；驳回不动账。报废可选择不扣押金。</summary>
[Collection("KunlunIntegration")]
public sealed class RefundReviewTests(TestHost host)
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
        var m = await Ok(await c.PostAsJsonAsync("/api/members", new CreateMemberRequest("退款审核验收", $"137{Random.Shared.Next(10000000, 99999999)}", "审核小区", null, "2-202")));
        return (m.GetProperty("id").GetGuid(), m.GetProperty("memberNo").GetString()!);
    }
    private static async Task<JsonElement> Bucket(HttpClient c, Guid mid) =>
        (await c.GetFromJsonAsync<JsonElement>($"/api/members/{mid}/deposit-summary")).EnumerateArray().Single(x => x.GetProperty("containerType").GetString() == "BUCKET");
    private static async Task<decimal> DepositBalance(HttpClient c, Guid mid) =>
        (await c.GetFromJsonAsync<JsonElement>($"/api/members/{mid}/profile")).GetProperty("depositAmount").GetDecimal();
    private static Task<HttpResponseMessage> ApplyDeposit(HttpClient c, Guid mid, int qty, string pay = "WECHAT") =>
        c.PostAsJsonAsync("/api/refund-requests", new ApplyRefundRequest("DEPOSIT", mid, "BUCKET", qty, null, pay, "不再订水", Key()));
    private static async Task<JsonElement> Requests(HttpClient c, string query) =>
        await c.GetFromJsonAsync<JsonElement>($"/api/refund-requests?{query}&page=1");

    [Fact]
    public async Task Clerk_Deposit_Refund_Waits_For_Admin_Approval()
    {
        using var admin = await Login("YG0001");
        using var clerk = await Login("YG0012");
        var (mid, memberNo) = await Member(admin);
        await Ok(await admin.PostAsJsonAsync("/api/deposits/collect", new CollectDepositRequest(mid, "BUCKET", 3, "CASH", Key())));

        // 店员不能直接退押金，只能提交申请；提交后不动押金
        Assert.Equal(HttpStatusCode.Forbidden, (await clerk.PostAsJsonAsync("/api/deposits/refund", new RefundDepositRequest(mid, "BUCKET", 1, Key(), "CASH"))).StatusCode);
        var request = await Ok(await ApplyDeposit(clerk, mid, 2));
        Assert.Equal("PENDING", request.GetProperty("status").GetString());
        Assert.Equal(100m, request.GetProperty("estimatedAmount").GetDecimal());
        Assert.Equal(150m, await DepositBalance(admin, mid));
        Assert.Equal(2, (await Bucket(admin, mid)).GetProperty("pendingRefundQty").GetInt32());

        // 待审核数量计入上限：3 个已交、2 个在审，再申请 2 个被拒绝
        Assert.Equal(HttpStatusCode.BadRequest, (await ApplyDeposit(clerk, mid, 2)).StatusCode);

        var id = request.GetProperty("id").GetGuid();
        Assert.Equal(HttpStatusCode.Forbidden, (await clerk.PostAsJsonAsync($"/api/refund-requests/{id}/approve", new ApproveRefundRequest(null, null))).StatusCode);
        var pending = await Requests(admin, $"status=PENDING&q={memberNo}");
        Assert.Equal(1, pending.GetProperty("total").GetInt64());

        var approved = await Ok(await admin.PostAsJsonAsync($"/api/refund-requests/{id}/approve", new ApproveRefundRequest("CASH", "核对无误")));
        Assert.Equal(100m, approved.GetProperty("refundAmount").GetDecimal());
        Assert.Equal(50m, await DepositBalance(admin, mid));
        Assert.Equal(0, (await Bucket(admin, mid)).GetProperty("pendingRefundQty").GetInt32());
        var replay = await Ok(await admin.PostAsJsonAsync($"/api/refund-requests/{id}/approve", new ApproveRefundRequest(null, null)));
        Assert.True(replay.GetProperty("idempotentReplay").GetBoolean());
        Assert.Equal(HttpStatusCode.Conflict, (await admin.PostAsJsonAsync($"/api/refund-requests/{id}/reject", new RejectRefundRequest("晚了"))).StatusCode);

        // 退款按审核时选的方式入账，并带出审核记录
        var row = Assert.Single((await Requests(admin, $"status=APPROVED&q={memberNo}")).GetProperty("rows").EnumerateArray());
        Assert.Equal(approved.GetProperty("refundNo").GetString(), row.GetProperty("refundNo").GetString());
        Assert.Equal(("CASH", "林站长", "核对无误"), (row.GetProperty("payMethod").GetString(), row.GetProperty("reviewerName").GetString(), row.GetProperty("reviewNote").GetString()));
        var flow = Assert.Single((await admin.GetFromJsonAsync<JsonElement>($"/api/ledgers/deposits?q={memberNo}&flowType=REFUND&page=1")).GetProperty("rows").EnumerateArray());
        Assert.Equal("CASH", flow.GetProperty("payMethod").GetString());
    }

    [Fact]
    public async Task Rejected_Recharge_Refund_Leaves_Tickets_And_A_New_Request_Can_Be_Approved()
    {
        using var admin = await Login("YG0001");
        using var clerk = await Login("YG0012");
        var (mid, memberNo) = await Member(admin);
        var batch = (await Ok(await admin.PostAsJsonAsync("/api/recharges", new CreateRechargeOrderRequest(mid, BucketPickupPlan, "CASH", Key())))).GetProperty("id").GetGuid();
        var apply = () => clerk.PostAsJsonAsync("/api/refund-requests", new ApplyRefundRequest("RECHARGE", mid, null, null, batch, "WECHAT", "搬家", Key()));

        var first = await Ok(await apply());
        Assert.Equal(HttpStatusCode.Conflict, (await apply()).StatusCode);
        var listed = (await admin.GetFromJsonAsync<JsonElement>($"/api/members/{mid}/ticket-batches")).EnumerateArray().Single(b => b.GetProperty("id").GetGuid() == batch);
        Assert.Equal(first.GetProperty("requestNo").GetString(), listed.GetProperty("pendingRequestNo").GetString());

        var firstId = first.GetProperty("id").GetGuid();
        Assert.Equal(HttpStatusCode.BadRequest, (await admin.PostAsJsonAsync($"/api/refund-requests/{firstId}/reject", new RejectRefundRequest(" "))).StatusCode);
        await Ok(await admin.PostAsJsonAsync($"/api/refund-requests/{firstId}/reject", new RejectRefundRequest("仍在使用中，暂不退")));
        Assert.Equal(HttpStatusCode.Conflict, (await admin.PostAsJsonAsync($"/api/refund-requests/{firstId}/approve", new ApproveRefundRequest(null, null))).StatusCode);
        var profile = await admin.GetFromJsonAsync<JsonElement>($"/api/members/{mid}/profile");
        Assert.True(profile.GetProperty("bucketPickupTickets").GetInt32() > 0);
        Assert.Equal(0, (await admin.GetFromJsonAsync<JsonElement>($"/api/ledgers/recharge-refunds?q={memberNo}&page=1")).GetProperty("total").GetInt64());

        var second = await Ok(await apply());
        var approved = await Ok(await admin.PostAsJsonAsync($"/api/refund-requests/{second.GetProperty("id").GetGuid()}/approve", new ApproveRefundRequest(null, null)));
        Assert.Equal(second.GetProperty("estimatedAmount").GetDecimal(), approved.GetProperty("refundAmount").GetDecimal());
        var refund = Assert.Single((await admin.GetFromJsonAsync<JsonElement>($"/api/ledgers/recharge-refunds?q={memberNo}&page=1")).GetProperty("rows").EnumerateArray());
        Assert.Equal("WECHAT", refund.GetProperty("payMethod").GetString());
        Assert.Equal(0, (await admin.GetFromJsonAsync<JsonElement>($"/api/members/{mid}/profile")).GetProperty("bucketPickupTickets").GetInt32());
    }

    [Fact]
    public async Task Admin_Direct_Refund_Is_Recorded_As_Approved_Request()
    {
        using var admin = await Login("YG0001");
        var (mid, memberNo) = await Member(admin);
        await Ok(await admin.PostAsJsonAsync("/api/deposits/collect", new CollectDepositRequest(mid, "BUCKET", 1, "CASH", Key())));
        var refund = await Ok(await admin.PostAsJsonAsync("/api/deposits/refund", new RefundDepositRequest(mid, "BUCKET", 1, Key(), "BANK")));
        var row = Assert.Single((await Requests(admin, $"q={memberNo}")).GetProperty("rows").EnumerateArray());
        Assert.Equal(("APPROVED", refund.GetProperty("refundNo").GetString()), (row.GetProperty("status").GetString(), row.GetProperty("refundNo").GetString()));
    }

    [Fact]
    public async Task Waived_Scrap_Keeps_Deposit_With_Member_And_Out_Of_Deductions()
    {
        using var admin = await Login("YG0001");
        var (mid, memberNo) = await Member(admin);
        await Ok(await admin.PostAsJsonAsync("/api/deposits/collect", new CollectDepositRequest(mid, "BUCKET", 2, "CASH", Key())));
        await Ok(await admin.PostAsJsonAsync("/api/containers/movements", new RegisterContainerMovementRequest(mid, "BUCKET", 2, 0, IdempotencyKey: Key())));
        var damage = await Ok(await admin.PostAsJsonAsync("/api/containers/damages", new ReportContainerDamageRequest(mid, "BUCKET", 1, "自然老化", Key())));
        var deductedBefore = (await admin.GetFromJsonAsync<JsonElement>("/api/reports/finance-summary")).GetProperty("depositDeductedTotal").GetDecimal();

        var key = Key();
        var scrap = await Ok(await admin.PostAsJsonAsync($"/api/containers/damages/{damage.GetProperty("id")}/scrap", new ScrapContainerDamageRequest("自然老化，水站承担", key, DeductDeposit: false)));
        Assert.Equal(0m, scrap.GetProperty("deductedAmount").GetDecimal());
        Assert.True(scrap.GetProperty("depositWaived").GetBoolean());
        // A replay with the other choice is a different request.
        Assert.Equal(HttpStatusCode.Conflict, (await admin.PostAsJsonAsync($"/api/containers/damages/{damage.GetProperty("id")}/scrap", new ScrapContainerDamageRequest("自然老化，水站承担", key))).StatusCode);

        // 押金仍归会员：余额不变，释放的 1 个可退
        Assert.Equal(100m, await DepositBalance(admin, mid));
        var bucket = await Bucket(admin, mid);
        Assert.Equal((0, 1), (bucket.GetProperty("pendingDamageQty").GetInt32(), bucket.GetProperty("refundableQty").GetInt32()));
        var finance = await admin.GetFromJsonAsync<JsonElement>("/api/reports/finance-summary");
        Assert.Equal(deductedBefore, finance.GetProperty("depositDeductedTotal").GetDecimal());
        Assert.True(finance.GetProperty("reconciledZeroDiff").GetBoolean());
        Assert.Equal(0, (await admin.GetFromJsonAsync<JsonElement>($"/api/ledgers/deposits?q={memberNo}&flowType=DEDUCT&page=1")).GetProperty("total").GetInt64());
        var row = (await admin.GetFromJsonAsync<JsonElement>($"/api/containers/damages?q={memberNo}&status=SCRAPPED")).GetProperty("rows").EnumerateArray().Single();
        Assert.True(row.GetProperty("depositWaived").GetBoolean());
        var circulation = await admin.GetFromJsonAsync<JsonElement>($"/api/containers/circulation?q={memberNo}");
        Assert.Contains(circulation.GetProperty("rows").EnumerateArray(), r => r.GetProperty("businessType").GetString() == "SCRAP_WAIVED" && r.GetProperty("depositDeductedAmount").GetDecimal() == 0);
    }
}
