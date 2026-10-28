using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Kunlun.WaterStation.Auth;
using Kunlun.WaterStation.Operations;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Npgsql;
using Xunit;

namespace Kunlun.WaterStation.Tests;

[Collection("KunlunIntegration")]
public sealed class MiniPaymentTests(TestHost factory)
{
    private sealed class EnvironmentStub(string name) : IHostEnvironment
    {
        public string EnvironmentName { get; set; } = name;
        public string ApplicationName { get; set; } = "Tests";
        public string ContentRootPath { get; set; } = "/";
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }

    [Theory]
    [InlineData("Production", "kunlun_test")]
    [InlineData("Development", "kunlun")]
    [InlineData("Testing", "kunlun")]
    public void Mock_Cannot_Start_On_Production_Or_Business_Database(string env, string database)
    {
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["Kunlun:MiniPayments:Mode"] = "Mock" }).Build();
        Assert.Throws<InvalidOperationException>(() => MiniPayments.IsEnabled(config, new EnvironmentStub(env), $"Host=localhost;Database={database}"));
    }

    [Fact]
    public void Payment_Is_Disabled_By_Default_And_Unsupported_Real_Mode_Fails_Closed()
    {
        Assert.False(MiniPayments.IsEnabled(new ConfigurationBuilder().Build(), new EnvironmentStub("Production"), "Host=localhost;Database=kunlun"));
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["Kunlun:MiniPayments:Mode"] = "Wechat" }).Build();
        Assert.Throws<InvalidOperationException>(() => MiniPayments.IsEnabled(config, new EnvironmentStub("Testing"), "Host=localhost;Database=kunlun_test"));
    }

    private static async Task Login(HttpClient client, string type, string name, string password)
    {
        var response = await client.PostAsJsonAsync($"/api/auth/{type}/login", new { account = name, password });
        response.EnsureSuccessStatusCode();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("accessToken").GetString());
    }

    private static async Task<Guid> NewMember(HttpClient admin, HttpClient member)
    {
        var account = "mp" + Guid.NewGuid().ToString("N")[..16];
        var created = await admin.PostAsJsonAsync("/api/members", new { name = "小程序测试会员", phone = "131" + Random.Shared.Next(10000000, 99999999) });
        created.EnsureSuccessStatusCode();
        var mid = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        (await admin.PutAsJsonAsync($"/api/accounts/MEMBER/{mid}/credentials", new { username = account, password = TestHost.Password })).EnsureSuccessStatusCode();
        await Login(member, "member", account, TestHost.Password); return mid;
    }

    [Fact]
    public async Task Payment_Snapshot_Idempotency_Isolation_And_Atomic_Credit()
    {
        using var app = factory.WithWebHostBuilder(builder => builder.ConfigureAppConfiguration((_, cfg) => cfg.AddInMemoryCollection(new Dictionary<string, string?> { ["Kunlun:MiniPayments:Mode"] = "Mock" })));
        using var admin = app.CreateClient(); using var member = app.CreateClient(); using var other = app.CreateClient();
        await Login(admin, "staff", "YG0001", TestHost.Password);
        var mid = await NewMember(admin, member); await NewMember(admin, other);
        var planResponse = await admin.PostAsJsonAsync("/api/plans", new { name = "MP快照" + Guid.NewGuid().ToString("N"), waterType = "BUCKET_18_9L", fulfillMode = "DELIVERY", price = 100m, buyQty = 13, giftQty = 0, status = "ACTIVE" });
        planResponse.EnsureSuccessStatusCode();
        var planId = (await planResponse.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        var key = Guid.NewGuid().ToString("N");
        // Client-supplied amount and member identity must never affect a payment.
        var created = await member.PostAsJsonAsync("/api/mini-payments", new { planId, idempotencyKey = key, amountFen = 1, memberId = Guid.NewGuid() });
        created.EnsureSuccessStatusCode();
        var payment = (await created.Content.ReadFromJsonAsync<MiniPaymentView>())!;
        Assert.Equal(10000, payment.AmountFen); Assert.Equal(mid, payment.MemberId); Assert.Equal("NOTPAY", payment.Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await admin.PostAsJsonAsync("/api/mini-payments", new { planId, idempotencyKey = key })).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await other.GetAsync($"/api/mini-payments/{payment.Id}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await other.PostAsJsonAsync($"/api/mini-payments/{payment.Id}/simulate", new { outcome = "SUCCESS" })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await member.PostAsJsonAsync($"/api/mini-payments/{payment.Id}/simulate", new { outcome = "arbitrary" })).StatusCode);
        var retry = await member.PostAsJsonAsync("/api/mini-payments", new { planId, idempotencyKey = key });
        Assert.Equal(payment.Id, (await retry.Content.ReadFromJsonAsync<MiniPaymentView>())!.Id);
        Assert.Equal(HttpStatusCode.Conflict, (await member.PostAsJsonAsync("/api/mini-payments", new { planId = Guid.NewGuid(), idempotencyKey = key })).StatusCode);
        foreach (var outcome in new[] { "CANCEL", "FAIL" })
            (await member.PostAsJsonAsync($"/api/mini-payments/{payment.Id}/simulate", new { outcome })).EnsureSuccessStatusCode();
        var profile = await member.GetFromJsonAsync<JsonElement>($"/api/members/{mid}/profile");
        Assert.Equal(0, profile.GetProperty("bucketDeliveryTickets").GetInt32());
        // A pending purchase retains the price and quantity agreed at creation.
        (await admin.PutAsJsonAsync($"/api/plans/{planId}", new { name = "MP变价" + key, waterType = "BUCKET_18_9L", fulfillMode = "DELIVERY", price = 150m, buyQty = 19, giftQty = 0, status = "ACTIVE" })).EnsureSuccessStatusCode();
        var settlements = await Task.WhenAll(Enumerable.Range(0, 5).Select(_ => member.PostAsJsonAsync($"/api/mini-payments/{payment.Id}/simulate", new { outcome = "SUCCESS" })));
        foreach (var response in settlements) { response.EnsureSuccessStatusCode(); Assert.Equal("SUCCESS", (await response.Content.ReadFromJsonAsync<MiniPaymentView>())!.Status); }
        profile = await member.GetFromJsonAsync<JsonElement>($"/api/members/{mid}/profile");
        Assert.Equal(13, profile.GetProperty("bucketDeliveryTickets").GetInt32());
        var late = await member.PostAsJsonAsync($"/api/mini-payments/{payment.Id}/simulate", new { outcome = "CANCEL" });
        Assert.Equal("SUCCESS", (await late.Content.ReadFromJsonAsync<MiniPaymentView>())!.Status);
        await using var conn = await app.Services.GetRequiredService<NpgsqlDataSource>().OpenConnectionAsync();
        await using var cmd = new NpgsqlCommand("SELECT (SELECT count(*) FROM plugin_kunlun_waterstation.recharge_orders WHERE id=@id),(SELECT count(*) FROM plugin_kunlun_waterstation.ticket_batches WHERE recharge_id=@id),(SELECT count(*) FROM plugin_kunlun_waterstation.ticket_ledgers WHERE member_id=@mid AND change_type='RECHARGE_BUY')", conn);
        cmd.Parameters.AddWithValue("id", payment.Id); cmd.Parameters.AddWithValue("mid", mid);
        await using var reader = await cmd.ExecuteReaderAsync(); await reader.ReadAsync();
        Assert.Equal(1, reader.GetInt64(0)); Assert.Equal(1, reader.GetInt64(1)); Assert.Equal(1, reader.GetInt64(2));
        using var disabled = factory.CreateClient(); await Login(disabled, "staff", "YG0001", TestHost.Password);
        Assert.Equal(HttpStatusCode.ServiceUnavailable, (await disabled.GetAsync("/api/mini-payments")).StatusCode);
    }
}
