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
public sealed class ReportIntegrationTests(WebApplicationFactory<Program> factory)
{
    private readonly HttpClient _client = factory.CreateClient();

    private async Task<string> LoginStaffAsync(string staffNo)
    {
        var resp = await _client.PostAsJsonAsync("/api/auth/staff/login", new StaffLoginRequest(staffNo, "Kunlun@2026"));
        var data = await resp.Content.ReadFromJsonAsync<AuthTokenResponse>();
        return data!.AccessToken;
    }

    [Fact]
    public async Task FinanceSummary_Reconciliation_AC17_And_CsvExports_AC18_Should_Pass()
    {
        var adminToken = await LoginStaffAsync("YG0001");
        _client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", adminToken);

        // 1) 获取操作前的财务汇总基线
        var beforeResp = await _client.GetAsync("/api/reports/finance-summary");
        Assert.Equal(HttpStatusCode.OK, beforeResp.StatusCode);
        var beforeJson = await beforeResp.Content.ReadFromJsonAsync<JsonElement>();
        var rcgBefore = beforeJson.GetProperty("rechargeRevenueTotal").GetDecimal();
        var depColBefore = beforeJson.GetProperty("depositCollectedTotal").GetDecimal();
        var depRefBefore = beforeJson.GetProperty("depositRefundedTotal").GetDecimal();
        var poolBefore = beforeJson.GetProperty("unrefundedDepositPoolTotal").GetDecimal();
        Assert.True(beforeJson.GetProperty("reconciledZeroDiff").GetBoolean());

        // 2) 新建测试会员并执行：充值 ¥200 + 收取 2 桶押金 (¥100) + 退还 1 桶押金 (¥50)
        var uniquePhone = $"133{Random.Shared.Next(10000000, 99999999)}";
        var memResp = await _client.PostAsJsonAsync("/api/members",
            new CreateMemberRequest("姜维", uniquePhone, "绿麒麟大厦 18 楼", "M4报表对账测试"));
        var memberId = (await memResp.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();

        var deliveryPlanId = Guid.Parse("30000000-0000-0000-0000-000000000001");
        await _client.PostAsJsonAsync("/api/recharges",
            new CreateRechargeOrderRequest(memberId, deliveryPlanId, "WECHAT", $"idem-m4-rcg-{Guid.NewGuid()}"));
        await _client.PostAsJsonAsync("/api/deposits/collect",
            new CollectDepositRequest(memberId, "BUCKET", 2, "WECHAT", $"idem-m4-dep-{Guid.NewGuid()}"));
        await _client.PostAsJsonAsync("/api/deposits/refund",
            new RefundDepositRequest(memberId, "BUCKET", 1, $"idem-m4-ref-{Guid.NewGuid()}"));

        // 3) AC-17: 再次获取财务汇总，验证充值收款 (+200)、押金收款 (+100)、押金退款 (+50)、未退押金池 (+50) 严格分离且零误差对齐
        var afterResp = await _client.GetAsync("/api/reports/finance-summary");
        Assert.Equal(HttpStatusCode.OK, afterResp.StatusCode);
        var afterJson = await afterResp.Content.ReadFromJsonAsync<JsonElement>();

        Assert.Equal(rcgBefore + 200.00m, afterJson.GetProperty("rechargeRevenueTotal").GetDecimal());
        Assert.Equal(depColBefore + 100.00m, afterJson.GetProperty("depositCollectedTotal").GetDecimal());
        Assert.Equal(depRefBefore + 50.00m, afterJson.GetProperty("depositRefundedTotal").GetDecimal());
        Assert.Equal(poolBefore + 50.00m, afterJson.GetProperty("unrefundedDepositPoolTotal").GetDecimal());
        Assert.True(afterJson.GetProperty("reconciledZeroDiff").GetBoolean());

        // 4) AC-16 & AC-18: 店员 YG0012 (小林) 无 report.export 权限，尝试导出应返回 403 Forbidden
        var clerkToken = await LoginStaffAsync("YG0012");
        using (var clerkReq = new HttpRequestMessage(HttpMethod.Get, "/api/exports/members"))
        {
            clerkReq.Headers.Authorization = new AuthenticationHeaderValue("Bearer", clerkToken);
            var clerkExportResp = await _client.SendAsync(clerkReq);
            Assert.Equal(HttpStatusCode.Forbidden, clerkExportResp.StatusCode);
        }

        // 5) AC-18: 管理员 YG0001 导出 4 类核心台账 (members / ticket-ledgers / deposit-ledgers / orders)
        foreach (var dataset in new[] { "members", "ticket-ledgers", "deposit-ledgers", "orders" })
        {
            var expResp = await _client.GetAsync($"/api/exports/{dataset}");
            Assert.Equal(HttpStatusCode.OK, expResp.StatusCode);
            Assert.Contains("text/csv", expResp.Content.Headers.ContentType?.ToString() ?? "");
            var csvText = await expResp.Content.ReadAsStringAsync();
            var lines = csvText.Split('\n', StringSplitOptions.RemoveEmptyEntries);
            Assert.True(lines.Length >= 2, $"Dataset {dataset} should contain header and at least 1 data row.");
        }
    }
}
