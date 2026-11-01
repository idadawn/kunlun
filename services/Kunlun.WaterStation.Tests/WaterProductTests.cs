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

[Collection("KunlunIntegration")]
public sealed class WaterProductTests(TestHost host)
{
    private static string Key() => Guid.NewGuid().ToString("N");
    private static async Task<JsonElement> Ok(HttpResponseMessage response)
    {
        var body = await response.Content.ReadAsStringAsync(); Assert.True(response.IsSuccessStatusCode, $"{response.StatusCode}: {body}");
        return JsonSerializer.Deserialize<JsonElement>(body);
    }
    private async Task<HttpClient> Staff(string account = "YG0001")
    {
        var c = host.CreateClient(); var s = await Ok(await c.PostAsJsonAsync("/api/auth/staff/login", new StaffLoginRequest(account, TestHost.Password)));
        c.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", s.GetProperty("accessToken").GetString()); return c;
    }

    [Fact]
    public async Task Added_Water_Has_Its_Own_Tickets_And_Uses_The_Bucket_Deposit()
    {
        using var c = await Staff();
        var name = "18.9L 矿泉水 " + Key()[..6];
        var created = await Ok(await c.PostAsJsonAsync("/api/products", new SaveWaterProduct(name, 18.9m, "大桶", 20m, 2, "BUCKET")));
        var type = created.GetProperty("waterType").GetString()!;
        Assert.Equal("BUCKET", created.GetProperty("containerType").GetString()); Assert.Equal("桶", created.GetProperty("unit").GetString());
        Assert.Contains((await c.GetFromJsonAsync<JsonElement[]>("/api/products"))!, p => p.GetProperty("waterType").GetString() == type);
        Assert.Equal(HttpStatusCode.Conflict, (await c.PostAsJsonAsync("/api/products", new SaveWaterProduct(name, 5, "袋装", null, 1, "BAG"))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await c.PostAsJsonAsync("/api/products", new SaveWaterProduct("未选容器 " + Key()[..6], 5, "袋装", null, 1))).StatusCode);

        var plan = (await Ok(await c.PostAsJsonAsync("/api/plans", new SaveRechargePlanRequest("矿泉水自提 " + Key(), type, "PICKUP", 100, 5, 0)))).GetProperty("id").GetGuid();
        Assert.Equal(HttpStatusCode.BadRequest, (await c.PostAsJsonAsync("/api/plans", new SaveRechargePlanRequest("不存在的水 " + Key(), "NO_SUCH_WATER", "PICKUP", 100, 5, 0))).StatusCode);
        var phone = $"137{Random.Shared.Next(10000000, 99999999)}";
        var m = (await Ok(await c.PostAsJsonAsync("/api/members", new CreateMemberRequest("新水品会员", phone, null, null)))).GetProperty("id").GetGuid();
        var charge = await Ok(await c.PostAsJsonAsync("/api/recharges", new CreateRechargeOrderRequest(m, plan, "CASH", Key())));
        Assert.Equal(name, charge.GetProperty("planSnapshot").GetProperty("waterLabel").GetString());
        var profile = await c.GetFromJsonAsync<JsonElement>($"/api/members/{m}/profile");
        Assert.Equal(5, profile.Tickets(type, "PICKUP")); Assert.Equal(0, profile.Tickets("BUCKET_18_9L", "PICKUP"));
        var ticket = Assert.Single(profile.GetProperty("tickets").EnumerateArray());
        Assert.Equal(name, ticket.GetProperty("name").GetString()); Assert.Equal("桶", ticket.GetProperty("unit").GetString());

        // Tickets of one water never pay for another, even in the same kind of bucket.
        Assert.Equal(HttpStatusCode.BadRequest, (await c.PostAsJsonAsync("/api/orders", new CreateWaterOrderRequest(m, "BUCKET_18_9L", "PICKUP", 1, Key()))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await c.PostAsJsonAsync("/api/orders", new CreateWaterOrderRequest(m, type, "DELIVERY", 2, Key()))).StatusCode);
        await Ok(await c.PostAsJsonAsync("/api/deposits/collect", new CollectDepositRequest(m, "BUCKET", 2, "CASH", Key())));
        var order = await Ok(await c.PostAsJsonAsync("/api/orders", new CreateWaterOrderRequest(m, type, "PICKUP", 2, Key())));
        var done = await Ok(await c.PostAsJsonAsync($"/api/orders/{order.GetProperty("id").GetGuid()}/fulfill", new FulfillWaterOrderRequest(2, 2, 0, order.GetProperty("pickupCode").GetString())));
        Assert.Equal(3, done.GetProperty("availableTicketsAfter").GetInt32()); Assert.Equal(2, done.GetProperty("heldAfter").GetInt32());
        var listed = Assert.Single((await c.GetFromJsonAsync<JsonElement[]>($"/api/members?q={phone}"))!);
        Assert.Equal(3, listed.Tickets(type, "PICKUP")); Assert.Equal(2, listed.GetProperty("heldBuckets").GetInt32());
        Assert.Single((await c.GetFromJsonAsync<JsonElement>($"/api/members?q={phone}&water=BUCKET&page=1")).GetProperty("rows").EnumerateArray());
        Assert.Empty((await c.GetFromJsonAsync<JsonElement>($"/api/members?q={phone}&water=BAG&page=1")).GetProperty("rows").EnumerateArray());
        var placed = (await c.GetFromJsonAsync<JsonElement[]>($"/api/orders?memberId={m}"))!.Single();
        Assert.Equal("BUCKET", placed.GetProperty("productSnapshot").GetProperty("containerType").GetString());
        Assert.Contains($"{name}·自提 3", await c.GetStringAsync("/api/exports/members"));

        Assert.Equal(HttpStatusCode.Conflict, (await c.DeleteAsync($"/api/products/{type}")).StatusCode);
    }

    [Fact]
    public async Task Water_Added_By_Mistake_Can_Be_Deleted_Only_By_Managers()
    {
        using var c = await Staff(); using var clerk = await Staff("YG0012");
        var request = new SaveWaterProduct("误加的水 " + Key()[..6], 7.5m, "袋装", null, 3, "BAG");
        Assert.Equal(HttpStatusCode.Forbidden, (await clerk.PostAsJsonAsync("/api/products", request)).StatusCode);
        var type = (await Ok(await c.PostAsJsonAsync("/api/products", request))).GetProperty("waterType").GetString()!;
        // The container is chosen once: an edit keeps it.
        var edited = await Ok(await c.PutAsJsonAsync($"/api/products/{type}", request with { Name = request.Name + " 改", ContainerType = "BUCKET" }));
        Assert.Equal("BAG", edited.GetProperty("containerType").GetString()); Assert.Equal("袋", edited.GetProperty("unit").GetString());
        Assert.Equal(HttpStatusCode.Forbidden, (await clerk.DeleteAsync($"/api/products/{type}")).StatusCode);
        await Ok(await c.DeleteAsync($"/api/products/{type}"));
        Assert.DoesNotContain((await c.GetFromJsonAsync<JsonElement[]>("/api/products"))!, p => p.GetProperty("waterType").GetString() == type);
        Assert.Equal(HttpStatusCode.NotFound, (await c.DeleteAsync($"/api/products/{type}")).StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, (await c.DeleteAsync("/api/products/BUCKET_18_9L")).StatusCode);
    }

    [Fact]
    public async Task Original_Balances_Moved_To_Per_Water_Tickets_And_Stay_Moved_On_Restart()
    {
        using var c = await Staff();
        // The demo members started with balances in the retired member columns.
        var chen = await c.GetFromJsonAsync<JsonElement>("/api/members/20000000-0000-0000-0000-000000008621/profile");
        Assert.Equal(8, chen.Tickets("BUCKET_18_9L", "DELIVERY")); Assert.Equal(10, chen.Tickets("BUCKET_18_9L", "PICKUP")); Assert.Equal(6, chen.Tickets("BAG_7_5L", "PICKUP"));
        Assert.Equal(12, (await c.GetFromJsonAsync<JsonElement>("/api/members/20000000-0000-0000-0000-000000008620/profile")).Tickets("BAG_7_5L", "PICKUP"));

        // A second start must neither bring the old columns back nor fail on the demo seed.
        var repo = host.Services.GetRequiredService<KunlunAuthRepository>();
        await repo.EnsureSchemaAndSeedAsync();
        await host.Services.GetRequiredService<KunlunOrderRepository>().EnsureOrderSchemaAsync();
        await TicketBatches.EnsureSchema(host.Services.GetRequiredService<NpgsqlDataSource>(), repo.DefaultTenantId);
        await using var conn = host.OpenDatabase();
        await using var columns = new NpgsqlCommand("SELECT count(*) FROM information_schema.columns WHERE table_schema='plugin_kunlun_waterstation' AND table_name='members' AND column_name LIKE '%\\_tickets'", conn);
        Assert.Equal(0L, (long)(await columns.ExecuteScalarAsync())!);
        Assert.Equal(10, (await c.GetFromJsonAsync<JsonElement>("/api/members/20000000-0000-0000-0000-000000008621/profile")).Tickets("BUCKET_18_9L", "PICKUP"));
    }
}
