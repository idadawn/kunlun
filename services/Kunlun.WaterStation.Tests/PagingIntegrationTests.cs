using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Kunlun.WaterStation.Auth;
using Kunlun.WaterStation.Operations;
using Xunit;

namespace Kunlun.WaterStation.Tests;

[Collection("KunlunIntegration")]
public sealed class PagingIntegrationTests(TestHost factory)
{
    private readonly HttpClient _client = factory.CreateClient();
    // 每个用例的数据带唯一标记，按标记过滤即可与其他用例写入的数据隔离。
    private readonly string _tag = Guid.NewGuid().ToString("N")[..8];
    private static readonly Guid BucketPickupPlan = WaterProducts.PlanId("101");
    private static readonly Guid BucketDeliveryPlan = WaterProducts.PlanId("103");

    private async Task LoginAdminAsync()
    {
        var resp = await _client.PostAsJsonAsync("/api/auth/staff/login", new StaffLoginRequest("YG0001", TestHost.Password));
        var token = (await resp.Content.ReadFromJsonAsync<AuthTokenResponse>())!.AccessToken;
        _client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
    }

    private async Task<(Guid Id, string MemberNo)> CreateMemberAsync(string name)
    {
        var resp = await _client.PostAsJsonAsync("/api/members",
            new CreateMemberRequest(name, $"139{Random.Shared.Next(10000000, 99999999)}", "绿麒麟分页测试小区", null, "1 栋"));
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var json = await resp.Content.ReadFromJsonAsync<JsonElement>();
        return (json.GetProperty("id").GetGuid(), json.GetProperty("memberNo").GetString()!);
    }

    private async Task<JsonElement> GetAsync(string url)
    {
        var resp = await _client.GetAsync(url);
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        return await resp.Content.ReadFromJsonAsync<JsonElement>();
    }

    private static List<string> Items(JsonElement page, string key) =>
        page.GetProperty("rows").EnumerateArray().Select(x => x.GetProperty(key).ToString()).ToList();

    private static async Task Ok(Task<HttpResponseMessage> request) => Assert.Equal(HttpStatusCode.OK, (await request).StatusCode);

    private static string Q(DateTimeOffset time) => Uri.EscapeDataString(time.ToString("O"));

    [Fact]
    public async Task Members_PageWithTotal_FilterServerSide_And_KeepLegacyArray()
    {
        await LoginAdminAsync();
        var created = new List<Guid>();
        for (var i = 0; i < 5; i++) created.Add((await CreateMemberAsync($"分页{_tag}{i}")).Id);
        await Ok(_client.PostAsJsonAsync("/api/recharges", new CreateRechargeOrderRequest(created[0], BucketDeliveryPlan, "CASH", $"page-rcg-{Guid.NewGuid()}")));

        // 每页 2 条：3 页互不重叠，合起来正好是全部 5 位，最新建档的在前
        var seen = new List<string>();
        for (var page = 1; page <= 3; page++)
        {
            var json = await GetAsync($"/api/members?q={_tag}&page={page}&pageSize=2");
            Assert.Equal(5, json.GetProperty("total").GetInt64());
            Assert.Equal(page, json.GetProperty("page").GetInt32());
            Assert.Equal(2, json.GetProperty("pageSize").GetInt32());
            Assert.Equal(page < 3 ? 2 : 1, json.GetProperty("rows").GetArrayLength());
            seen.AddRange(Items(json, "id"));
        }
        Assert.Equal(created.AsEnumerable().Reverse().Select(id => id.ToString()), seen);

        // 越界页为空但仍返回总数；page / pageSize 越界时被收敛到 1..100
        var beyond = await GetAsync($"/api/members?q={_tag}&page=9&pageSize=2");
        Assert.Equal(0, beyond.GetProperty("rows").GetArrayLength());
        Assert.Equal(5, beyond.GetProperty("total").GetInt64());
        var clamped = await GetAsync($"/api/members?q={_tag}&page=0&pageSize=1000");
        Assert.Equal(1, clamped.GetProperty("page").GetInt32());
        Assert.Equal(Paging.MaxPageSize, clamped.GetProperty("pageSize").GetInt32());

        // 不传分页参数时仍返回旧的数组格式
        var legacy = await GetAsync($"/api/members?q={_tag}");
        Assert.Equal(JsonValueKind.Array, legacy.ValueKind);
        Assert.Equal(5, legacy.GetArrayLength());

        // 状态与持有水票类型在服务端筛选
        Assert.Equal(5, (await GetAsync($"/api/members?q={_tag}&status=ACTIVE&pageSize=10")).GetProperty("total").GetInt64());
        Assert.Equal(0, (await GetAsync($"/api/members?q={_tag}&status=DISABLED&pageSize=10")).GetProperty("total").GetInt64());
        var bucket = await GetAsync($"/api/members?q={_tag}&water=BUCKET&pageSize=10");
        Assert.Equal(new[] { created[0].ToString() }, Items(bucket, "id"));
        Assert.Equal(0, (await GetAsync($"/api/members?q={_tag}&water=BAG&pageSize=10")).GetProperty("total").GetInt64());

        // 搜索词里的 % 和 _ 按字面匹配，不再匹配全部会员
        Assert.Equal(0, (await GetAsync("/api/members?q=%25&pageSize=10")).GetProperty("total").GetInt64());
        Assert.Equal(0, (await GetAsync("/api/members?q=_&pageSize=10")).GetProperty("total").GetInt64());
    }

    [Fact]
    public async Task Orders_PageWithTotal_And_FilterByTextStatusModeAndDate()
    {
        await LoginAdminAsync();
        var (memberId, _) = await CreateMemberAsync($"水单{_tag}");
        await Ok(_client.PostAsJsonAsync("/api/recharges", new CreateRechargeOrderRequest(memberId, BucketDeliveryPlan, "CASH", $"page-rcg-{Guid.NewGuid()}")));
        await Ok(_client.PostAsJsonAsync("/api/recharges", new CreateRechargeOrderRequest(memberId, BucketPickupPlan, "CASH", $"page-rcg-{Guid.NewGuid()}")));

        var orderNos = new List<string>();
        Guid firstOrderId = default;
        foreach (var mode in new[] { "DELIVERY", "DELIVERY", "DELIVERY", "PICKUP", "PICKUP" })
        {
            var resp = await _client.PostAsJsonAsync("/api/orders", new CreateWaterOrderRequest(memberId, "BUCKET_18_9L", mode, 1, $"page-ord-{Guid.NewGuid()}"));
            Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
            var json = await resp.Content.ReadFromJsonAsync<JsonElement>();
            if (firstOrderId == default) firstOrderId = json.GetProperty("id").GetGuid();
            orderNos.Add(json.GetProperty("orderNo").GetString()!);
        }
        await Ok(_client.PostAsJsonAsync($"/api/orders/{firstOrderId}/cancel", new CancelWaterOrderRequest("分页测试取消")));

        var first = await GetAsync($"/api/orders?memberId={memberId}&pageSize=2");
        var last = await GetAsync($"/api/orders?memberId={memberId}&pageSize=2&page=3");
        Assert.Equal(5, first.GetProperty("total").GetInt64());
        Assert.Equal(orderNos.TakeLast(2).Reverse(), Items(first, "orderNo"));
        Assert.Equal(new[] { orderNos[0] }, Items(last, "orderNo"));

        var legacy = await GetAsync($"/api/orders?memberId={memberId}");
        Assert.Equal(JsonValueKind.Array, legacy.ValueKind);
        Assert.Equal(5, legacy.GetArrayLength());

        long Total(JsonElement json) => json.GetProperty("total").GetInt64();
        Assert.Equal(1, Total(await GetAsync($"/api/orders?memberId={memberId}&status=CANCELLED&pageSize=10")));
        Assert.Equal(2, Total(await GetAsync($"/api/orders?memberId={memberId}&status=PENDING&mode=DELIVERY&pageSize=10")));
        Assert.Equal(2, Total(await GetAsync($"/api/orders?memberId={memberId}&mode=PICKUP&pageSize=10")));
        // 文本搜索覆盖水单号、联系人快照与会员姓名
        Assert.Equal(new[] { orderNos[2] }, Items(await GetAsync($"/api/orders?q={orderNos[2]}&pageSize=10"), "orderNo"));
        Assert.Equal(5, Total(await GetAsync($"/api/orders?q=水单{_tag}&pageSize=10")));
        // 下单时间区间：from 含、to 不含
        var now = DateTimeOffset.UtcNow;
        Assert.Equal(5, Total(await GetAsync($"/api/orders?memberId={memberId}&from={Q(now.AddHours(-1))}&pageSize=10")));
        Assert.Equal(0, Total(await GetAsync($"/api/orders?memberId={memberId}&from={Q(now.AddHours(1))}&pageSize=10")));
        Assert.Equal(0, Total(await GetAsync($"/api/orders?memberId={memberId}&to={Q(now.AddHours(-1))}&pageSize=10")));
        Assert.Equal(5, Total(await GetAsync($"/api/orders?memberId={memberId}&from={Q(now.AddHours(-1).ToOffset(TimeSpan.FromHours(8)))}&pageSize=10")));
    }

    [Fact]
    public async Task Ledgers_PageWithTotal_And_FilterServerSide()
    {
        await LoginAdminAsync();
        var name = $"台账{_tag}";
        var (memberId, memberNo) = await CreateMemberAsync(name);
        for (var i = 0; i < 3; i++)
            await Ok(_client.PostAsJsonAsync("/api/recharges", new CreateRechargeOrderRequest(memberId, BucketDeliveryPlan, "CASH", $"page-rcg-{Guid.NewGuid()}")));
        await Ok(_client.PostAsJsonAsync("/api/deposits/collect", new CollectDepositRequest(memberId, "BUCKET", 2, "CASH", $"page-dep-{Guid.NewGuid()}")));
        await Ok(_client.PostAsJsonAsync("/api/deposits/collect", new CollectDepositRequest(memberId, "BAG", 1, "CASH", $"page-dep-{Guid.NewGuid()}")));
        await Ok(_client.PostAsJsonAsync("/api/deposits/refund", new RefundDepositRequest(memberId, "BUCKET", 1, $"page-ref-{Guid.NewGuid()}")));
        await Ok(_client.PostAsJsonAsync("/api/containers/movements", new RegisterContainerMovementRequest(memberId, "BUCKET", 1, 0, null, $"page-mv-{Guid.NewGuid()}")));
        await Ok(_client.PostAsJsonAsync("/api/containers/movements", new RegisterContainerMovementRequest(memberId, "BAG", 1, 0, null, $"page-mv-{Guid.NewGuid()}")));

        var recharges = await GetAsync($"/api/ledgers/recharges?q={memberNo}&pageSize=2");
        Assert.Equal(3, recharges.GetProperty("total").GetInt64());
        Assert.Equal(2, recharges.GetProperty("rows").GetArrayLength());
        var page2 = Items(await GetAsync($"/api/ledgers/recharges?q={memberNo}&pageSize=2&page=2"), "rechargeNo");
        Assert.Single(page2);
        Assert.DoesNotContain(page2[0], Items(recharges, "rechargeNo"));
        var future = Q(DateTimeOffset.UtcNow.AddHours(1));
        Assert.Equal(0, (await GetAsync($"/api/ledgers/recharges?q={memberNo}&from={future}&page=1")).GetProperty("total").GetInt64());
        var legacyRecharges = await GetAsync("/api/ledgers/recharges");
        Assert.Equal(JsonValueKind.Array, legacyRecharges.ValueKind);
        Assert.InRange(legacyRecharges.GetArrayLength(), 3, 30);

        var deposits = await GetAsync($"/api/ledgers/deposits?q={name}&pageSize=2");
        Assert.Equal(3, deposits.GetProperty("total").GetInt64());
        var flows = (await GetAsync($"/api/ledgers/deposits?q={name}&pageSize=10")).GetProperty("rows").EnumerateArray()
            .Select(d => d.GetProperty("flowType").GetString()).Order().ToList();
        Assert.Equal(new[] { "COLLECT", "COLLECT", "REFUND" }, flows);
        Assert.Equal(0, (await GetAsync($"/api/ledgers/deposits?q={name}&to={Q(DateTimeOffset.UtcNow.AddHours(-1))}&page=1")).GetProperty("total").GetInt64());
        Assert.Equal(JsonValueKind.Array, (await GetAsync("/api/ledgers/deposits")).ValueKind);

        // 容器流水按类型筛选：分类型总数之和等于全部，且每页只含该类型
        var all = (await GetAsync("/api/ledgers/containers?pageSize=1")).GetProperty("total").GetInt64();
        var bags = await GetAsync("/api/ledgers/containers?containerType=BAG&pageSize=100");
        var buckets = await GetAsync("/api/ledgers/containers?containerType=BUCKET&pageSize=1");
        Assert.True(bags.GetProperty("total").GetInt64() >= 1);
        Assert.Equal(all, bags.GetProperty("total").GetInt64() + buckets.GetProperty("total").GetInt64());
        Assert.All(bags.GetProperty("rows").EnumerateArray(), c => Assert.Equal("BAG", c.GetProperty("containerType").GetString()));
        Assert.Contains(bags.GetProperty("rows").EnumerateArray(), c => c.GetProperty("memberName").GetString() == name);
        Assert.Equal(JsonValueKind.Array, (await GetAsync("/api/ledgers/containers")).ValueKind);
    }

    [Fact]
    public async Task RechargeAndDepositLedgers_AreKeptApart_WithOwnFilters()
    {
        await LoginAdminAsync();
        var (memberId, memberNo) = await CreateMemberAsync($"分账{_tag}");
        await Ok(_client.PostAsJsonAsync("/api/recharges", new CreateRechargeOrderRequest(memberId, BucketDeliveryPlan, "CASH", $"split-rcg-{Guid.NewGuid()}")));
        await Ok(_client.PostAsJsonAsync("/api/recharges", new CreateRechargeOrderRequest(memberId, BucketPickupPlan, "WECHAT", $"split-rcg-{Guid.NewGuid()}")));
        await Ok(_client.PostAsJsonAsync("/api/deposits/collect", new CollectDepositRequest(memberId, "BUCKET", 2, "CASH", $"split-dep-{Guid.NewGuid()}")));
        await Ok(_client.PostAsJsonAsync("/api/deposits/collect", new CollectDepositRequest(memberId, "BAG", 1, "WECHAT", $"split-dep-{Guid.NewGuid()}")));
        await Ok(_client.PostAsJsonAsync("/api/deposits/refund", new RefundDepositRequest(memberId, "BUCKET", 1, $"split-ref-{Guid.NewGuid()}", "ALIPAY")));
        Assert.Equal(HttpStatusCode.BadRequest, (await _client.PostAsJsonAsync("/api/deposits/refund", new RefundDepositRequest(memberId, "BUCKET", 1, $"split-ref-{Guid.NewGuid()}", "COUPON"))).StatusCode);
        var pickup = (await GetAsync($"/api/members/{memberId}/ticket-batches")).EnumerateArray().Single(b => b.GetProperty("fulfillMode").GetString() == "PICKUP");
        await Ok(_client.PostAsJsonAsync($"/api/ticket-batches/{pickup.GetProperty("id")}/refund", new RefundRechargeRequest($"split-rr-{Guid.NewGuid()}", "BANK", "搬家退清")));

        // 充值流水按收款方式筛选；退清的那笔带出退款单号，未退的为空
        var wechat = Assert.Single((await GetAsync($"/api/ledgers/recharges?q={memberNo}&payMethod=WECHAT&page=1")).GetProperty("rows").EnumerateArray());
        Assert.Equal(JsonValueKind.String, wechat.GetProperty("refundNo").ValueKind);
        var cash = Assert.Single((await GetAsync($"/api/ledgers/recharges?q={memberNo}&payMethod=CASH&page=1")).GetProperty("rows").EnumerateArray());
        Assert.Equal(JsonValueKind.Null, cash.GetProperty("refundNo").ValueKind);

        // 水费退款单独成表，不混入押金流水
        var refund = Assert.Single((await GetAsync($"/api/ledgers/recharge-refunds?q={memberNo}&page=1")).GetProperty("rows").EnumerateArray());
        Assert.Equal(wechat.GetProperty("rechargeNo").GetString(), refund.GetProperty("rechargeNo").GetString());
        Assert.Equal(wechat.GetProperty("refundNo").GetString(), refund.GetProperty("refundNo").GetString());
        Assert.Equal("BANK", refund.GetProperty("payMethod").GetString());
        Assert.Equal(0, (await GetAsync($"/api/ledgers/recharge-refunds?q={memberNo}&payMethod=CASH&page=1")).GetProperty("total").GetInt64());

        // 押金流水只含收退押，可按业务类型和容器筛选，退押保留实际退款方式
        Assert.Equal(3, (await GetAsync($"/api/ledgers/deposits?q={memberNo}&page=1")).GetProperty("total").GetInt64());
        var depositRefund = Assert.Single((await GetAsync($"/api/ledgers/deposits?q={memberNo}&flowType=REFUND&page=1")).GetProperty("rows").EnumerateArray());
        Assert.Equal("ALIPAY", depositRefund.GetProperty("payMethod").GetString());
        Assert.Equal(memberNo, depositRefund.GetProperty("memberNo").GetString());
        var bag = Assert.Single((await GetAsync($"/api/ledgers/deposits?q={memberNo}&containerType=BAG&page=1")).GetProperty("rows").EnumerateArray());
        Assert.Equal(("COLLECT", "WECHAT"), (bag.GetProperty("flowType").GetString(), bag.GetProperty("payMethod").GetString()));
        Assert.Equal(2, (await GetAsync($"/api/ledgers/deposits?q={memberNo}&containerType=BUCKET&page=1")).GetProperty("total").GetInt64());

        Assert.True((await GetAsync("/api/reports/finance-summary")).GetProperty("rechargeRefundCount").GetInt64() >= 1);
        Assert.Contains(refund.GetProperty("refundNo").GetString()!, await _client.GetStringAsync("/api/exports/recharge-refunds"));
        Assert.Contains(",ALIPAY", await _client.GetStringAsync("/api/exports/deposit-ledgers"));
    }
}
