using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Kunlun.WaterStation.Auth;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Xunit;

namespace Kunlun.WaterStation.Tests;

[Collection("KunlunIntegration")]
public sealed class MiniClientTests(TestHost host)
{
    [Fact]
    public async Task Handshake_Reports_Only_Safe_Server_Capabilities()
    {
        using var client = host.CreateClient();
        var config = await client.GetFromJsonAsync<JsonElement>("/api/mini-config");
        Assert.Equal("kunlun.waterstation", config.GetProperty("service").GetString());
        Assert.Equal(1, config.GetProperty("apiVersion").GetInt32());
        Assert.Equal("test", config.GetProperty("environment").GetString());
        Assert.Equal("DISABLED", config.GetProperty("paymentProvider").GetString());
        Assert.False(config.GetProperty("retailPaymentsEnabled").GetBoolean());
        Assert.False(config.TryGetProperty("database", out _)); Assert.False(config.TryGetProperty("dbUser", out _));
        using var enabled = host.WithWebHostBuilder(b => b.ConfigureAppConfiguration((_, c) => c.AddInMemoryCollection(new Dictionary<string, string?> { ["Kunlun:MiniPayments:Mode"] = "Mock" })));
        using var mockClient = enabled.CreateClient();
        var mock = await mockClient.GetFromJsonAsync<JsonElement>("/api/mini-config");
        Assert.Equal("MOCK", mock.GetProperty("paymentProvider").GetString());
        Assert.True(mock.GetProperty("retailPaymentsEnabled").GetBoolean());
    }

    [Fact]
    public async Task Member_Deposit_Summary_Includes_Current_Standards_Without_Station_Inventory()
    {
        using var admin = host.CreateClient();
        var loggedIn = await admin.PostAsJsonAsync("/api/auth/staff/login", new StaffLoginRequest("YG0001", TestHost.Password));
        loggedIn.EnsureSuccessStatusCode();
        admin.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", (await loggedIn.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("accessToken").GetString());
        var suffix = Guid.NewGuid().ToString("N");
        var memberResponse = await admin.PostAsJsonAsync("/api/members", new { name = "真实接口会员", phone = "136" + Random.Shared.Next(10000000, 99999999) });
        memberResponse.EnsureSuccessStatusCode();
        var id = (await memberResponse.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        var account = "real" + suffix[..12];
        (await admin.PutAsJsonAsync($"/api/accounts/MEMBER/{id}/credentials", new { username = account, password = TestHost.Password })).EnsureSuccessStatusCode();
        using var member = host.CreateClient();
        var response = await member.PostAsJsonAsync("/api/auth/member/login", new { account, password = TestHost.Password }); response.EnsureSuccessStatusCode();
        member.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("accessToken").GetString());
        var rows = (await member.GetFromJsonAsync<JsonElement[]>($"/api/members/{id}/deposit-summary"))!;
        Assert.Equal(2, rows.Length);
        foreach (var row in rows)
        {
            Assert.True(row.GetProperty("unitDeposit").GetDecimal() > 0);
            Assert.Equal(0, row.GetProperty("heldQty").GetInt32());
            Assert.False(row.TryGetProperty("totalQty", out _)); Assert.False(row.TryGetProperty("inStationQty", out _));
        }
        Assert.Equal(HttpStatusCode.Forbidden, (await member.GetAsync($"/api/members/{Guid.NewGuid()}/deposit-summary")).StatusCode);
        using var anonymous = host.CreateClient();
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.GetAsync($"/api/members/{id}/deposit-summary")).StatusCode);
    }
}
