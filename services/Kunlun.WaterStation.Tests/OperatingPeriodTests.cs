using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Kunlun.WaterStation.Auth;
using Kunlun.WaterStation.Operations;
using Xunit;

namespace Kunlun.WaterStation.Tests;

[Collection("KunlunIntegration")]
public sealed class OperatingPeriodTests(TestHost host)
{
    [Theory]
    [InlineData("today", "2024-01-01", "2024-01-01", "hour")]
    [InlineData("week", "2024-01-01", "2024-01-01", "day")]
    [InlineData("last-week", "2023-12-25", "2023-12-31", "day")]
    [InlineData("month", "2024-01-01", "2024-01-01", "day")]
    [InlineData("last-month", "2023-12-01", "2023-12-31", "day")]
    [InlineData("year", "2024-01-01", "2024-01-01", "month")]
    [InlineData("last-year", "2023-01-01", "2023-12-31", "month")]
    public void Presets_at_Shanghai_midnight(string period, string start, string end, string grain)
    {
        var window = OperatingPeriodReport.Resolve(period, DateTimeOffset.Parse("2023-12-31T16:00:00Z"));
        Assert.Equal(new OperatingPeriodReport.Window(DateOnly.Parse(start), DateOnly.Parse(end), grain), window);
    }

    [Fact]
    public void Last_month_includes_leap_day()
    {
        var window = OperatingPeriodReport.Resolve("last-month", DateTimeOffset.Parse("2024-03-10T14:00:00Z"));
        Assert.Equal(new DateOnly(2024, 2, 29), window.End);
    }

    [Fact]
    public async Task Period_uses_receipts_purchase_dates_and_actual_fulfilment()
    {
        using var c = host.CreateClient();
        const string url = "/api/reports/operating-period?period=";
        Assert.Equal(HttpStatusCode.Unauthorized, (await c.GetAsync(url + "today")).StatusCode);
        async Task Login(string account)
        {
            var login = await c.PostAsJsonAsync("/api/auth/staff/login", new StaffLoginRequest(account, TestHost.Password));
            var session = await login.Content.ReadFromJsonAsync<AuthTokenResponse>();
            c.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", session!.AccessToken);
        }
        await Login("YG0012");
        Assert.Equal(HttpStatusCode.Forbidden, (await c.GetAsync(url + "today")).StatusCode);
        await Login("YG0001");
        Assert.Equal(HttpStatusCode.BadRequest, (await c.GetAsync(url + "unknown")).StatusCode);

        async Task<JsonElement> Report(string period) => await c.GetFromJsonAsync<JsonElement>(url + period);
        static decimal Cash(JsonElement r, string field) => r.GetProperty("cash").GetProperty(field).GetDecimal();
        static decimal Sum(JsonElement r, string field) => r.GetProperty("activity").GetProperty("trend").EnumerateArray().Sum(p => p.GetProperty(field).GetDecimal());
        static decimal Redeemed(JsonElement r) => r.GetProperty("activity").GetProperty("redeemedValue").GetDecimal();
        static string Key() => Guid.NewGuid().ToString("N");
        async Task<JsonElement> Post(string path, object body)
        {
            var r = await c.PostAsJsonAsync(path, body);
            r.EnsureSuccessStatusCode();
            return await r.Content.ReadFromJsonAsync<JsonElement>();
        }

        var before = await Report("today");
        var previous = await Report("last-week");
        var member = await Post("/api/members", new CreateMemberRequest("经营统计", $"133{Random.Shared.Next(10000000, 99999999)}", "测试地址", null, "101"));
        var id = member.GetProperty("id").GetGuid();
        var plan = Guid.Parse("30000000-0000-0000-0000-000000000103");
        var purchase = await Post("/api/recharges", new CreateRechargeOrderRequest(id, plan, "CASH", Key()));
        await Post("/api/deposits/collect", new CollectDepositRequest(id, "BUCKET", 1, "CASH", Key()));
        var order = await Post("/api/orders", new CreateWaterOrderRequest(id, "BUCKET_18_9L", "DELIVERY", 2, Key()));
        await Post($"/api/orders/{order.GetProperty("id").GetGuid()}/fulfill", new FulfillWaterOrderRequest(1, 1, 0, DiffReason: "实送一桶"));
        // Entered today, but spent on the last Sunday.
        await Post("/api/expenses", new CreateExpenseRequest("PARTS", "配件", 19.75m, "CASH", Key(), SpentOn: previous.GetProperty("end").Deserialize<DateOnly>()));

        var today = await Report("today");
        Assert.Equal(Cash(before, "rechargeRevenue") + 100m, Cash(today, "rechargeRevenue"));
        Assert.Equal(Cash(before, "balance") + 100m, Cash(today, "balance"));
        Assert.Equal(Cash(today, "rechargeRevenue"), Sum(today, "receipts"));
        Assert.Equal(Sum(before, "deliveries") + 1, Sum(today, "deliveries"));
        Assert.Equal(Sum(before, "buckets") + 1, Sum(today, "buckets"));
        Assert.Equal(Sum(before, "newMembers") + 1, Sum(today, "newMembers"));
        var fixedQty = purchase.GetProperty("buyQty").GetInt32();
        Assert.Equal(Redeemed(before) + decimal.Round(100m / fixedQty, 2, MidpointRounding.AwayFromZero), Redeemed(today));

        var lastWeek = await Report("last-week");
        Assert.Equal(Cash(previous, "balance") - 19.75m, Cash(lastWeek, "balance"));
        Assert.Equal(Sum(previous, "buckets"), Sum(lastWeek, "buckets"));
        Assert.Equal(7, lastWeek.GetProperty("activity").GetProperty("trend").GetArrayLength());
        var lastYear = await Report("last-year");
        Assert.Equal(12, lastYear.GetProperty("activity").GetProperty("trend").GetArrayLength());
    }
}
