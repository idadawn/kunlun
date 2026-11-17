using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Kunlun.WaterStation.Auth;
using Kunlun.WaterStation.Operations;
using Npgsql;
using Xunit;

namespace Kunlun.WaterStation.Tests;

/// <summary>
/// 费用支出：买桶袋、配件耗材、维修等花出去的钱一笔一条，作废的不算；进经营汇总和收支统计，可导出。
/// 登记买桶袋时选了哪种桶袋，买的个数同时加到店里，袋桶库存和袋桶台账都记一笔「新购」。
/// 袋桶库存「新购」时填了花费，同时记一笔买桶袋支出，两边互相带单号。
/// </summary>
[Collection("KunlunIntegration")]
public sealed class ExpenseTests(TestHost host)
{
    private static string Key() => Guid.NewGuid().ToString("N");
    private static string Today() => DateTimeOffset.UtcNow.ToOffset(TimeSpan.FromHours(8)).ToString("yyyy-MM-dd");
    private static DateOnly TodayDate() => DateOnly.Parse(Today());

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
    private static async Task<JsonElement> Summary(HttpClient c, string query = "") => await Ok(await c.GetAsync("/api/expenses/summary" + query));
    private static async Task<JsonElement> Rows(HttpClient c, string query) => (await Ok(await c.GetAsync($"/api/expenses?{query}&page=1"))).GetProperty("rows");
    private static async Task<int> InStore(HttpClient c, string type) =>
        (await c.GetFromJsonAsync<JsonElement>("/api/containers/summary")).EnumerateArray().Single(x => x.GetProperty("containerType").GetString() == type).GetProperty("inStationQty").GetInt32();

    [Fact]
    public async Task Expenses_Are_Recorded_Counted_And_Voided_Without_Being_Deleted()
    {
        using var admin = await Login("YG0001");
        var before = await Summary(admin);
        var financeBefore = await Ok(await admin.GetAsync("/api/reports/finance-summary"));
        var marker = "压水器" + Key()[..6];

        var key = Key();
        var request = new CreateExpenseRequest("PARTS", marker, 36.50m, "WECHAT", key, Quantity: 2, Remark: "  坏了一个  ");
        var created = await Ok(await admin.PostAsJsonAsync("/api/expenses", request));
        Assert.StartsWith("ZC", created.GetProperty("expenseNo").GetString());
        Assert.Equal("PARTS", created.GetProperty("category").GetString());
        Assert.Equal(36.50m, created.GetProperty("amount").GetDecimal());
        Assert.Equal(2, created.GetProperty("quantity").GetInt32());
        Assert.Equal(Today(), created.GetProperty("spentOn").GetString());
        Assert.Equal("坏了一个", created.GetProperty("remark").GetString());
        Assert.Equal("ACTIVE", created.GetProperty("status").GetString());
        Assert.Equal("林站长", created.GetProperty("operatorName").GetString());

        // A retry returns the same expense; the key cannot be reused for a different one.
        Assert.Equal(created.GetProperty("id").GetGuid(), (await Ok(await admin.PostAsJsonAsync("/api/expenses", request))).GetProperty("id").GetGuid());
        Assert.Equal(HttpStatusCode.Conflict, (await admin.PostAsJsonAsync("/api/expenses", request with { Amount = 40m })).StatusCode);

        // Bought yesterday, recorded today: the purchase date decides the period it counts in.
        var older = await Ok(await admin.PostAsJsonAsync("/api/expenses", new CreateExpenseRequest("CONTAINER", marker + "空桶", 300m, "CASH", Key(), 10, TodayDate().AddDays(-1))));
        Assert.Equal(TodayDate().AddDays(-1).ToString("yyyy-MM-dd"), older.GetProperty("spentOn").GetString());

        var after = await Summary(admin);
        Assert.Equal(before.GetProperty("expenseTotal").GetDecimal() + 336.50m, after.GetProperty("expenseTotal").GetDecimal());
        Assert.Equal(before.GetProperty("expenseCount").GetInt64() + 2, after.GetProperty("expenseCount").GetInt64());
        Assert.Equal(after.GetProperty("rechargeNet").GetDecimal() - after.GetProperty("expenseTotal").GetDecimal(), after.GetProperty("balance").GetDecimal());
        var parts = after.GetProperty("categories").EnumerateArray().Single(c => c.GetProperty("category").GetString() == "PARTS");
        Assert.True(parts.GetProperty("total").GetDecimal() >= 36.50m);

        var startOfToday = Uri.EscapeDataString(new DateTimeOffset(TodayDate().ToDateTime(TimeOnly.MinValue), TimeSpan.FromHours(8)).ToString("O"));
        var todayOnly = await Rows(admin, $"q={marker}&from={startOfToday}");
        Assert.Equal(marker, Assert.Single(todayOnly.EnumerateArray()).GetProperty("item").GetString());
        Assert.Equal(2, (await Rows(admin, $"q={marker}")).GetArrayLength());
        Assert.Single((await Rows(admin, $"q={marker}&category=CONTAINER")).EnumerateArray());

        var finance = await Ok(await admin.GetAsync("/api/reports/finance-summary"));
        Assert.Equal(financeBefore.GetProperty("expenseTotal").GetDecimal() + 336.50m, finance.GetProperty("expenseTotal").GetDecimal());
        Assert.Equal(finance.GetProperty("rechargeNetReceived").GetDecimal() - finance.GetProperty("expenseTotal").GetDecimal(), finance.GetProperty("rechargeNetAfterExpenses").GetDecimal());

        // Voiding needs a reason, keeps the row and takes it out of every total; voiding again changes nothing.
        var id = older.GetProperty("id").GetGuid();
        Assert.Equal(HttpStatusCode.BadRequest, (await admin.PostAsJsonAsync($"/api/expenses/{id}/void", new VoidExpenseRequest(" "))).StatusCode);
        var voided = await Ok(await admin.PostAsJsonAsync($"/api/expenses/{id}/void", new VoidExpenseRequest("记重了")));
        Assert.Equal("VOIDED", voided.GetProperty("status").GetString());
        Assert.Equal("记重了", voided.GetProperty("voidReason").GetString());
        Assert.Equal("记重了", (await Ok(await admin.PostAsJsonAsync($"/api/expenses/{id}/void", new VoidExpenseRequest("再作废一次")))).GetProperty("voidReason").GetString());
        Assert.Equal(before.GetProperty("expenseTotal").GetDecimal() + 36.50m, (await Summary(admin)).GetProperty("expenseTotal").GetDecimal());
        Assert.Equal(2, (await Rows(admin, $"q={marker}")).GetArrayLength());
        Assert.Single((await Rows(admin, $"q={marker}&status=VOIDED")).EnumerateArray());

        var csv = await admin.GetStringAsync("/api/exports/expenses");
        Assert.Contains($",配件耗材,{marker},2,36.50,WECHAT,坏了一个,", csv);
        Assert.Contains(",已作废,记重了,", csv);
    }

    [Fact]
    public async Task Bad_Expenses_Are_Refused_And_Only_Expense_Or_Report_Holders_See_Them()
    {
        using var admin = await Login("YG0001");
        using var clerk = await Login("YG0012");
        CreateExpenseRequest Valid() => new("OTHER", "电费", 120m, "BANK", Key());
        foreach (var bad in new[]
        {
            Valid() with { Category = "FOOD" }, Valid() with { Item = " " }, Valid() with { Amount = 0m }, Valid() with { Amount = 1.234m },
            Valid() with { PayMethod = "CARD" }, Valid() with { Quantity = 0 }, Valid() with { SpentOn = TodayDate().AddDays(1) },
            // Only 买桶袋 goes into stock, and only into a container a water product has.
            Valid() with { ContainerType = "BAG" }, Valid() with { Category = "CONTAINER", ContainerType = "bag!" }, Valid() with { Category = "CONTAINER", ContainerType = "NOPE" },
        })
            Assert.Equal(HttpStatusCode.BadRequest, (await admin.PostAsJsonAsync("/api/expenses", bad)).StatusCode);
        // A refused purchase records neither money nor stock.
        Assert.Empty((await Rows(admin, "q=电费&category=CONTAINER")).EnumerateArray());

        Assert.Equal(HttpStatusCode.Forbidden, (await clerk.PostAsJsonAsync("/api/expenses", Valid())).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await clerk.GetAsync("/api/expenses?page=1")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await clerk.GetAsync("/api/expenses/summary")).StatusCode);
        var id = (await Ok(await admin.PostAsJsonAsync("/api/expenses", Valid()))).GetProperty("id").GetGuid();
        Assert.Equal(HttpStatusCode.Forbidden, (await clerk.PostAsJsonAsync($"/api/expenses/{id}/void", new VoidExpenseRequest("不该能作废"))).StatusCode);

        var me = await admin.GetFromJsonAsync<JsonElement>("/api/auth/me");
        Assert.Contains(KunlunPermissions.ExpenseManage, me.GetProperty("permissions").EnumerateArray().Select(p => p.GetString()));
    }

    [Fact]
    public async Task A_Purchase_With_A_Cost_Adds_Stock_And_Records_One_Container_Expense()
    {
        using var admin = await Login("YG0001");
        var stock = (await admin.GetFromJsonAsync<JsonElement>("/api/containers/summary")).EnumerateArray().Single(x => x.GetProperty("containerType").GetString() == "BUCKET");
        var before = await Summary(admin);

        var key = Key();
        var request = new InventoryRequest("BUCKET", "RECEIVE", "新买了一批", key, 10, Cost: 280m, PayMethod: "ALIPAY");
        var receipt = await Ok(await admin.PostAsJsonAsync("/api/containers/inventory", request));
        Assert.Equal(stock.GetProperty("inStationQty").GetInt32() + 10, receipt.GetProperty("after").GetProperty("inStationQty").GetInt32());
        var expenseNo = receipt.GetProperty("expense").GetProperty("expenseNo").GetString()!;
        Assert.Equal(280m, receipt.GetProperty("expense").GetProperty("amount").GetDecimal());

        var expense = Assert.Single((await Rows(admin, $"q={expenseNo}")).EnumerateArray());
        Assert.Equal("CONTAINER", expense.GetProperty("category").GetString());
        Assert.Equal("15L 桶装水 · 配套桶", expense.GetProperty("item").GetString());
        Assert.Equal(10, expense.GetProperty("quantity").GetInt32());
        Assert.Equal("ALIPAY", expense.GetProperty("payMethod").GetString());
        Assert.Equal("BUCKET", expense.GetProperty("containerType").GetString());
        Assert.Equal(receipt.GetProperty("operationNo").GetString(), expense.GetProperty("inventoryOperationNo").GetString());

        // A retried 新购 neither adds stock nor money twice, and its receipt still names the expense.
        var replay = await Ok(await admin.PostAsJsonAsync("/api/containers/inventory", request));
        Assert.Equal(receipt.GetProperty("id").GetGuid(), replay.GetProperty("id").GetGuid());
        Assert.Equal(expenseNo, replay.GetProperty("expense").GetProperty("expenseNo").GetString());
        Assert.Equal(before.GetProperty("expenseTotal").GetDecimal() + 280m, (await Summary(admin)).GetProperty("expenseTotal").GetDecimal());

        // Without a cost a 新购 records no money; a cost needs a payment method, and scrapping has no cost.
        var plain = await Ok(await admin.PostAsJsonAsync("/api/containers/inventory", new InventoryRequest("BUCKET", "RECEIVE", "供应商赠送", Key(), 2)));
        Assert.Equal(JsonValueKind.Null, plain.GetProperty("expense").ValueKind);
        Assert.Equal(HttpStatusCode.BadRequest, (await admin.PostAsJsonAsync("/api/containers/inventory", new InventoryRequest("BUCKET", "RECEIVE", "新买", Key(), 1, Cost: 30m))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await admin.PostAsJsonAsync("/api/containers/inventory", new InventoryRequest("BUCKET", "SCRAP", "破了", Key(), 1, Cost: 30m, PayMethod: "CASH"))).StatusCode);
        Assert.Equal(before.GetProperty("expenseTotal").GetDecimal() + 280m, (await Summary(admin)).GetProperty("expenseTotal").GetDecimal());

        var history = await admin.GetFromJsonAsync<JsonElement>("/api/containers/inventory-operations?containerType=BUCKET");
        var listed = history.EnumerateArray().First(h => h.GetProperty("operation").GetProperty("id").GetGuid() == receipt.GetProperty("id").GetGuid());
        Assert.Equal(expenseNo, listed.GetProperty("operation").GetProperty("expense").GetProperty("expenseNo").GetString());
    }

    [Fact]
    public async Task A_Clerk_Who_Manages_Stock_May_Not_Put_A_Cost_On_A_Purchase()
    {
        using var admin = await Login("YG0001");
        var saved = (await Ok(await admin.GetAsync("/api/mobile/roles"))).GetProperty("roles").EnumerateArray()
            .Single(r => r.GetProperty("role").GetString() == "CLERK").GetProperty("features").EnumerateArray().Select(f => f.GetString()!).ToArray();
        try
        {
            await Ok(await admin.PutAsJsonAsync("/api/mobile/roles/CLERK", new SaveRoleMobileRequest([.. saved, "inventory"])));
            using var clerk = await Login("YG0012");
            Assert.Equal(HttpStatusCode.Forbidden, (await clerk.PostAsJsonAsync("/api/containers/inventory", new InventoryRequest("BAG", "RECEIVE", "新买", Key(), 5, Cost: 20m, PayMethod: "CASH"))).StatusCode);
            var received = await Ok(await clerk.PostAsJsonAsync("/api/containers/inventory", new InventoryRequest("BAG", "RECEIVE", "新买", Key(), 5)));
            Assert.Equal(JsonValueKind.Null, received.GetProperty("expense").ValueKind);
        }
        finally
        {
            await Ok(await admin.PutAsJsonAsync("/api/mobile/roles/CLERK", new SaveRoleMobileRequest(saved)));
        }
    }

    [Fact]
    public async Task A_Container_Expense_Puts_Its_Containers_In_The_Store_Once_And_In_The_Ledger()
    {
        using var admin = await Login("YG0001");
        var bags = await InStore(admin, "BAG");
        var buckets = await InStore(admin, "BUCKET");
        var before = await Summary(admin);

        var request = new CreateExpenseRequest("CONTAINER", "5L 袋装水 · 配套水袋", 100m, "WECHAT", Key(), 20, Remark: "批发市场买的", ContainerType: "BAG");
        var expense = await Ok(await admin.PostAsJsonAsync("/api/expenses", request));
        var expenseNo = expense.GetProperty("expenseNo").GetString()!;
        var operationNo = expense.GetProperty("inventoryOperationNo").GetString()!;
        Assert.Equal("BAG", expense.GetProperty("containerType").GetString());
        Assert.StartsWith("CK", operationNo);
        Assert.Equal(bags + 20, await InStore(admin, "BAG"));
        Assert.Equal(before.GetProperty("expenseTotal").GetDecimal() + 100m, (await Summary(admin)).GetProperty("expenseTotal").GetDecimal());

        // 袋桶库存's history has the 新购, carrying the expense; the note is the expense's remark.
        var history = await admin.GetFromJsonAsync<JsonElement>("/api/containers/inventory-operations?containerType=BAG");
        var stocked = history.EnumerateArray().Select(h => h.GetProperty("operation")).Single(o => o.GetProperty("operationNo").GetString() == operationNo);
        Assert.Equal("RECEIVE", stocked.GetProperty("action").GetString());
        Assert.Equal(20, stocked.GetProperty("quantity").GetInt32());
        Assert.Equal(bags + 20, stocked.GetProperty("after").GetProperty("inStationQty").GetInt32());
        Assert.Equal("批发市场买的", stocked.GetProperty("reason").GetString());
        Assert.Equal(expenseNo, stocked.GetProperty("expense").GetProperty("expenseNo").GetString());
        Assert.Equal(100m, stocked.GetProperty("expense").GetProperty("amount").GetDecimal());

        // A retry returns the same expense and stocks nothing more; the key cannot be reused for another container or for money only.
        Assert.Equal(expense.GetProperty("id").GetGuid(), (await Ok(await admin.PostAsJsonAsync("/api/expenses", request))).GetProperty("id").GetGuid());
        Assert.Equal(bags + 20, await InStore(admin, "BAG"));
        Assert.Equal(HttpStatusCode.Conflict, (await admin.PostAsJsonAsync("/api/expenses", request with { ContainerType = "BUCKET" })).StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, (await admin.PostAsJsonAsync("/api/expenses", request with { ContainerType = null })).StatusCode);

        // 袋桶台账 lists it as the store's own 新购, found by the expense number, and exports it.
        var ledger = await admin.GetFromJsonAsync<JsonElement>($"/api/containers/circulation?q={expenseNo}");
        var row = Assert.Single(ledger.GetProperty("rows").EnumerateArray());
        Assert.Equal("RECEIVE", row.GetProperty("businessType").GetString());
        Assert.Equal(operationNo, row.GetProperty("ledgerNo").GetString());
        Assert.Equal(expenseNo, row.GetProperty("referenceNo").GetString());
        Assert.Equal(20, row.GetProperty("receivedQty").GetInt32());
        Assert.Equal("", row.GetProperty("memberName").GetString());
        Assert.Equal(bags, row.GetProperty("storeBefore").GetInt32());
        Assert.Equal(bags + 20, row.GetProperty("storeAfter").GetInt32());
        Assert.Equal(0, (await admin.GetFromJsonAsync<JsonElement>($"/api/containers/circulation?q={expenseNo}&containerType=BUCKET")).GetProperty("total").GetInt32());
        var csv = await admin.GetStringAsync("/api/exports/container-ledgers");
        Assert.Contains("流水号,会员ID,容器类型,领出,归还,持有变化,持有余额,操作人,时间,业务类型,扣押金额,关联单号,原因,报废数量,新购数量", csv);
        Assert.Contains($"{operationNo},,", csv);
        Assert.Contains($",RECEIVE,0.00,{expenseNo},批发市场买的,0,20", csv);

        // A 买桶袋 that names no container records only the money.
        var moneyOnly = await Ok(await admin.PostAsJsonAsync("/api/expenses", new CreateExpenseRequest("CONTAINER", "15L 空桶", 60m, "CASH", Key(), 2)));
        Assert.Equal(JsonValueKind.Null, moneyOnly.GetProperty("containerType").ValueKind);
        Assert.Equal(JsonValueKind.Null, moneyOnly.GetProperty("inventoryOperationNo").ValueKind);
        Assert.Equal(buckets, await InStore(admin, "BUCKET"));

        // Voiding the expense takes the money out of the totals and leaves the bags in the store.
        await Ok(await admin.PostAsJsonAsync($"/api/expenses/{expense.GetProperty("id").GetGuid()}/void", new VoidExpenseRequest("记错了")));
        Assert.Equal(bags + 20, await InStore(admin, "BAG"));
    }

    [Fact]
    public async Task Stocking_A_Container_Expense_Needs_The_Stock_Permission_Too()
    {
        using var admin = await Login("YG0001");
        using var clerk = await Login("YG0012");
        const string grant = "UPDATE plugin_kunlun_waterstation.staff SET permissions=permissions || '[\"kunlun.waterstation:expense:manage\"]'::jsonb WHERE staff_no='YG0012'";
        const string revoke = "UPDATE plugin_kunlun_waterstation.staff SET permissions=permissions - 'kunlun.waterstation:expense:manage' WHERE staff_no='YG0012'";
        await using (var conn = host.OpenDatabase())
        await using (var cmd = new NpgsqlCommand(grant, conn))
            Assert.Equal(1, await cmd.ExecuteNonQueryAsync());
        try
        {
            // Permissions are read on every request: the clerk may now record money, but not put containers in the store.
            var bags = await InStore(admin, "BAG");
            var denied = await clerk.PostAsJsonAsync("/api/expenses", new CreateExpenseRequest("CONTAINER", "5L 水袋", 50m, "CASH", Key(), 10, ContainerType: "BAG"));
            Assert.Equal(HttpStatusCode.Forbidden, denied.StatusCode);
            Assert.Contains("袋桶库存权限", await denied.Content.ReadAsStringAsync());
            var money = await Ok(await clerk.PostAsJsonAsync("/api/expenses", new CreateExpenseRequest("CONTAINER", "5L 水袋", 50m, "CASH", Key(), 10)));
            Assert.Equal(JsonValueKind.Null, money.GetProperty("inventoryOperationNo").ValueKind);
            Assert.Equal(bags, await InStore(admin, "BAG"));
        }
        finally
        {
            await using var conn = host.OpenDatabase();
            await using var cmd = new NpgsqlCommand(revoke, conn);
            await cmd.ExecuteNonQueryAsync();
        }
    }
}
