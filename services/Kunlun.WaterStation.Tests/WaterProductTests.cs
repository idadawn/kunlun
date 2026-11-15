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
    public async Task Added_Water_Has_Its_Own_Tickets_Container_Deposit_And_Inventory()
    {
        using var c = await Staff();
        var name = "18.9L 矿泉水 " + Key()[..6];
        var created = await Ok(await c.PostAsJsonAsync("/api/products", new SaveWaterProduct(name, 18.9m, "大桶", 20m, 2, "BUCKET", 80m)));
        var type = created.GetProperty("waterType").GetString()!;
        var container = created.GetProperty("containerId").GetString()!;
        Assert.NotEqual("BUCKET", container);
        Assert.Equal(80m, created.GetProperty("unitDeposit").GetDecimal());
        await Ok(await c.PostAsJsonAsync("/api/containers/inventory", new InventoryRequest(container, "RECEIVE", "新增水品桶入库", Key(), 5)));
        Assert.Equal("BUCKET", created.GetProperty("containerType").GetString()); Assert.Equal("桶", created.GetProperty("unit").GetString());
        Assert.Contains((await c.GetFromJsonAsync<JsonElement[]>("/api/products"))!, p => p.GetProperty("waterType").GetString() == type);
        Assert.Equal(HttpStatusCode.Conflict, (await c.PostAsJsonAsync("/api/products", new SaveWaterProduct(name, 5, "袋装", null, 1, "BAG", 5m))).StatusCode);
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
        Assert.Equal(HttpStatusCode.BadRequest, (await c.PostAsJsonAsync($"/api/orders/{order.GetProperty("id").GetGuid()}/fulfill", new FulfillWaterOrderRequest(2, 2, 0, order.GetProperty("pickupCode").GetString()))).StatusCode);
        await Ok(await c.PostAsJsonAsync("/api/deposits/collect", new CollectDepositRequest(m, container, 2, "CASH", Key())));
        var done = await Ok(await c.PostAsJsonAsync($"/api/orders/{order.GetProperty("id").GetGuid()}/fulfill", new FulfillWaterOrderRequest(2, 2, 0, order.GetProperty("pickupCode").GetString())));
        Assert.Equal(3, done.GetProperty("availableTicketsAfter").GetInt32()); Assert.Equal(2, done.GetProperty("heldAfter").GetInt32());
        var listed = Assert.Single((await c.GetFromJsonAsync<JsonElement[]>($"/api/members?q={phone}"))!);
        Assert.Equal(3, listed.Tickets(type, "PICKUP")); Assert.Equal(2, listed.GetProperty("heldBuckets").GetInt32());
        Assert.Single((await c.GetFromJsonAsync<JsonElement>($"/api/members?q={phone}&water=BUCKET&page=1")).GetProperty("rows").EnumerateArray());
        Assert.Empty((await c.GetFromJsonAsync<JsonElement>($"/api/members?q={phone}&water=BAG&page=1")).GetProperty("rows").EnumerateArray());
        var placed = (await c.GetFromJsonAsync<JsonElement[]>($"/api/orders?memberId={m}"))!.Single();
        Assert.Equal("BUCKET", placed.GetProperty("productSnapshot").GetProperty("containerType").GetString());
        Assert.Contains($"{name}·自提 3", await c.GetStringAsync("/api/exports/members"));

        // The same physical kind cannot be returned, damaged or refunded against another water's account.
        Assert.Equal(HttpStatusCode.BadRequest, (await c.PostAsJsonAsync("/api/containers/movements", new RegisterContainerMovementRequest(m, "BUCKET", 0, 1, null, Key()))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await c.PostAsJsonAsync("/api/containers/damages", new ReportContainerDamageRequest(m, "BUCKET", 1, "破损", Key()))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await c.PostAsJsonAsync("/api/deposits/refund", new RefundDepositRequest(m, container, 1, Key(), "CASH"))).StatusCode);
        var unchanged = (await c.GetFromJsonAsync<JsonElement[]>($"/api/members/{m}/deposit-summary"))!.Single(x => x.GetProperty("containerType").GetString() == "BUCKET");
        Assert.Equal(0, unchanged.GetProperty("heldQty").GetInt32()); Assert.Equal(2, unchanged.GetProperty("refundableQty").GetInt32());
        await Ok(await c.PutAsJsonAsync($"/api/products/{type}", new SaveWaterProduct(name, 18.9m, "大桶", 20m, 2, "BUCKET", 90m)));
        await Ok(await c.PostAsJsonAsync("/api/containers/movements", new RegisterContainerMovementRequest(m, container, 0, 1, null, Key())));
        var refund = await Ok(await c.PostAsJsonAsync("/api/deposits/refund", new RefundDepositRequest(m, container, 1, Key(), "CASH")));
        Assert.Equal(80m, refund.GetProperty("refundAmount").GetDecimal());
        var damage = await Ok(await c.PostAsJsonAsync("/api/containers/damages", new ReportContainerDamageRequest(m, container, 1, "桶身破损", Key())));
        var scrap = await Ok(await c.PostAsJsonAsync($"/api/containers/damages/{damage.GetProperty("id").GetGuid()}/scrap", new ScrapContainerDamageRequest("确认报废", Key())));
        Assert.Equal(80m, scrap.GetProperty("deductedAmount").GetDecimal());
        var inventory = (await c.GetFromJsonAsync<JsonElement[]>("/api/containers/summary"))!.Single(x => x.GetProperty("containerType").GetString() == container);
        Assert.Equal(4, inventory.GetProperty("totalQty").GetInt32()); Assert.Equal(4, inventory.GetProperty("inStationQty").GetInt32());
        Assert.Equal(0, inventory.GetProperty("memberHeldQty").GetInt32()); Assert.Equal(1, inventory.GetProperty("scrappedQty").GetInt32());
        Assert.Equal(90m, inventory.GetProperty("unitDeposit").GetDecimal());
        Assert.Contains(name, await c.GetStringAsync("/api/exports/deposit-ledgers"));
        Assert.Equal(HttpStatusCode.Conflict, (await c.DeleteAsync($"/api/products/{type}")).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await c.PutAsJsonAsync($"/api/products/{type}", new SaveWaterProduct(name, 10, "大桶", 20m, 2, "BUCKET", 90m))).StatusCode);
        await ProductContainers.EnsureSchema(host.Services.GetRequiredService<NpgsqlDataSource>(), host.Services.GetRequiredService<KunlunAuthRepository>().DefaultTenantId);
        var afterRestart = (await c.GetFromJsonAsync<JsonElement[]>($"/api/members/{m}/deposit-summary"))!.Single(x => x.GetProperty("containerType").GetString() == container);
        Assert.Equal(0, afterRestart.GetProperty("heldQty").GetInt32()); Assert.Equal(0, afterRestart.GetProperty("paidQty").GetInt32());
    }

    [Fact]
    public async Task Same_Kind_Products_Get_Separate_Prices_And_Zero_Stock()
    {
        using var c = await Staff();
        var first = await Ok(await c.PostAsJsonAsync("/api/products", new SaveWaterProduct("新袋装 A " + Key(), 3, "袋", 5, 1, "BAG", 8)));
        var second = await Ok(await c.PostAsJsonAsync("/api/products", new SaveWaterProduct("新袋装 B " + Key(), 6, "袋", 9, 1, "BAG", 12)));
        var a = first.GetProperty("containerId").GetString()!; var b = second.GetProperty("containerId").GetString()!;
        Assert.NotEqual(a, b);
        await Ok(await c.PostAsJsonAsync("/api/containers/inventory", new InventoryRequest(a, "RECEIVE", "入库", Key(), 10)));
        var rows = (await c.GetFromJsonAsync<JsonElement[]>("/api/containers/summary"))!;
        Assert.Equal(10, rows.Single(x => x.GetProperty("containerType").GetString() == a).GetProperty("inStationQty").GetInt32());
        Assert.Equal(0, rows.Single(x => x.GetProperty("containerType").GetString() == b).GetProperty("inStationQty").GetInt32());
        Assert.Equal(12m, rows.Single(x => x.GetProperty("containerType").GetString() == b).GetProperty("unitDeposit").GetDecimal());
        var m = (await Ok(await c.PostAsJsonAsync("/api/members", new CreateMemberRequest("独立容器", $"139{Random.Shared.Next(10000000,99999999)}", null, null)))).GetProperty("id").GetGuid();
        await Ok(await c.PostAsJsonAsync("/api/deposits/collect", new CollectDepositRequest(m, b, 1, "CASH", Key())));
        Assert.Equal(HttpStatusCode.BadRequest, (await c.PostAsJsonAsync("/api/containers/movements", new RegisterContainerMovementRequest(m, b, 1, 0, null, Key()))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await c.PostAsJsonAsync("/api/containers/movements", new RegisterContainerMovementRequest(m, a, 1, 0, null, Key()))).StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, (await c.DeleteAsync($"/api/products/{first.GetProperty("waterType").GetString()}")).StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, (await c.DeleteAsync($"/api/products/{second.GetProperty("waterType").GetString()}")).StatusCode);
    }

    [Fact]
    public async Task Legacy_Stock_Defaults_Do_Not_Seed_New_Container_Accounts()
    {
        using var c = await Staff();
        await using var conn = host.OpenDatabase();
        await using var legacy = new NpgsqlCommand("ALTER TABLE plugin_kunlun_waterstation.container_configs ALTER COLUMN total_qty SET DEFAULT 1000", conn);
        await legacy.ExecuteNonQueryAsync();
        try
        {
            var created = await Ok(await c.PostAsJsonAsync("/api/products", new SaveWaterProduct("旧库新增水品 " + Key(), 8, "桶", null, 1, "BUCKET", 60)));
            var account = created.GetProperty("containerId").GetString();
            var row = (await c.GetFromJsonAsync<JsonElement[]>("/api/containers/summary"))!.Single(x => x.GetProperty("containerType").GetString() == account);
            Assert.Equal(0, row.GetProperty("totalQty").GetInt32());
            Assert.Equal(0, row.GetProperty("inStationQty").GetInt32());
            Assert.True(row.GetProperty("identityValid").GetBoolean());
            await Ok(await c.DeleteAsync($"/api/products/{created.GetProperty("waterType").GetString()}"));
        }
        finally
        {
            await using var restore = new NpgsqlCommand("ALTER TABLE plugin_kunlun_waterstation.container_configs ALTER COLUMN total_qty SET DEFAULT 0", conn);
            await restore.ExecuteNonQueryAsync();
        }
    }

    [Fact]
    public async Task Water_Added_By_Mistake_Can_Be_Deleted_Only_By_Managers()
    {
        using var c = await Staff(); using var clerk = await Staff("YG0012");
        var request = new SaveWaterProduct("误加的水 " + Key()[..6], 7.5m, "袋装", null, 3, "BAG", 10m);
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
