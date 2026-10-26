using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Kunlun.WaterStation.Auth;
using Kunlun.WaterStation.Operations;
using Microsoft.AspNetCore.Mvc.Testing;
using Xunit;

namespace Kunlun.WaterStation.Tests;

[Collection("KunlunIntegration")]
public sealed class FinanceIntegrationTests(TestHost factory)
{
    private readonly HttpClient _client = factory.CreateClient();

    private async Task<string> GetAdminTokenAsync()
    {
        var resp = await _client.PostAsJsonAsync("/api/auth/staff/login", new StaffLoginRequest("YG0001", TestHost.Password));
        var data = await resp.Content.ReadFromJsonAsync<AuthTokenResponse>();
        return data!.AccessToken;
    }

    [Fact]
    public async Task CreateMember_Recharge_Idempotency_And_Snapshot_Immutability_Should_Pass()
    {
        var token = await GetAdminTokenAsync();
        _client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);

        // 1) AC-01: 新建会员
        var uniquePhone = $"137{Random.Shared.Next(10000000, 99999999)}";
        var memResp = await _client.PostAsJsonAsync("/api/members",
            new CreateMemberRequest("赵子龙", uniquePhone, "昆仑花园 1 栋 101", "M2测试会员"));
        Assert.Equal(HttpStatusCode.OK, memResp.StatusCode);
        var memJson = await memResp.Content.ReadFromJsonAsync<JsonElement>();
        var memberId = memJson.GetProperty("id").GetGuid();

        // 2) AC-02 & AC-05: 办理配送畅享包 (¥200: 购 10 + 赠 2 = 12 桶)，连续重复提交同一幂等键只入账一次
        var deliveryPlanId = Guid.Parse("30000000-0000-0000-0000-000000000103");
        var idemKey = $"idem-recharge-{Guid.NewGuid()}";

        var r1 = await _client.PostAsJsonAsync("/api/recharges",
            new CreateRechargeOrderRequest(memberId, deliveryPlanId, "CASH", idemKey));
        var r2 = await _client.PostAsJsonAsync("/api/recharges",
            new CreateRechargeOrderRequest(memberId, deliveryPlanId, "CASH", idemKey));

        Assert.Equal(HttpStatusCode.OK, r1.StatusCode);
        Assert.Equal(HttpStatusCode.OK, r2.StatusCode);

        var j1 = await r1.Content.ReadFromJsonAsync<JsonElement>();
        var j2 = await r2.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(j1.GetProperty("rechargeNo").GetString(), j2.GetProperty("rechargeNo").GetString());
        Assert.True(j2.GetProperty("idempotentReplay").GetBoolean());

        // 核对会员配送桶票只增加了 12 桶（未翻倍成 24 桶）
        var profResp = await _client.GetFromJsonAsync<JsonElement>($"/api/members/{memberId}/profile");
        Assert.Equal(13, profResp.GetProperty("bucketDeliveryTickets").GetInt32());

        // 3) AC-13: 修改优惠方案赠送数量后，已发生充值单中的 planSnapshot 保持原值不变
        Assert.Equal(0, j1.GetProperty("planSnapshot").GetProperty("giftQty").GetInt32());
    }

    [Fact]
    public async Task Deposit_Collect_ContainerReturn_And_OriginalUnitPrice_Refund_Should_Pass()
    {
        var token = await GetAdminTokenAsync();
        _client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);

        // 新建测试会员
        var uniquePhone = $"136{Random.Shared.Next(10000000, 99999999)}";
        var memResp = await _client.PostAsJsonAsync("/api/members",
            new CreateMemberRequest("孙尚香", uniquePhone, "翠竹苑 8 栋 202", null));
        var memberId = (await memResp.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();

        try
        {
            // 1) 确保周转桶押金单价为 ¥50，会员交 2 个桶押金（共 ¥100）
            await _client.PutAsync("/api/containers/BUCKET/unit-deposit?newUnitDeposit=50", null);
            var depResp = await _client.PostAsJsonAsync("/api/deposits/collect",
                new CollectDepositRequest(memberId, "BUCKET", 2, "WX_OFFLINE", $"dep-{Guid.NewGuid()}"));
            Assert.Equal(HttpStatusCode.OK, depResp.StatusCode);

            // 2) 领出 2 个满桶（持有 = 2）
            await _client.PostAsJsonAsync("/api/containers/movements",
                new RegisterContainerMovementRequest(memberId, "BUCKET", FullOutN: 2, EmptyInM: 0));

            // 3) AC-11: 押金被实际持有容器占用（已交 2，持有 2，可退 0）时尝试退押金 -> 被 400 拦截
            var blockedRefund = await _client.PostAsJsonAsync("/api/deposits/refund",
                new RefundDepositRequest(memberId, "BUCKET", 1, $"ref-block-{Guid.NewGuid()}"));
            Assert.Equal(HttpStatusCode.BadRequest, blockedRefund.StatusCode);

            // 4) AC-10: 归还 1 个空桶（持有变为 1，但押金仍保留 ¥100）
            var movResp = await _client.PostAsJsonAsync("/api/containers/movements",
                new RegisterContainerMovementRequest(memberId, "BUCKET", FullOutN: 0, EmptyInM: 1));
            var movJson = await movResp.Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal(1, movJson.GetProperty("currentHeld").GetInt32());
            Assert.Equal(100.00m, movJson.GetProperty("depositAmountUnchanged").GetDecimal());

            // 5) AC-12: 管理员把周转桶押金单价从 ¥50 修改为 ¥80，随后退还刚才释放出的 1 个历史押金 -> 必须按原收取单价 ¥50 退还！
            await _client.PutAsync("/api/containers/BUCKET/unit-deposit?newUnitDeposit=80", null);

            var okRefund = await _client.PostAsJsonAsync("/api/deposits/refund",
                new RefundDepositRequest(memberId, "BUCKET", 1, $"ref-ok-{Guid.NewGuid()}"));
            Assert.Equal(HttpStatusCode.OK, okRefund.StatusCode);

            var refJson = await okRefund.Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal(50.00m, refJson.GetProperty("refundAmount").GetDecimal());
        }
        finally
        {
            // 恢复标准单价 ¥50
            await _client.PutAsync("/api/containers/BUCKET/unit-deposit?newUnitDeposit=50", null);
        }
    }
}
