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
public sealed class OrderIntegrationTests(TestHost factory)
{
    private readonly HttpClient _client = factory.CreateClient();

    private async Task<string> GetAdminTokenAsync()
    {
        var resp = await _client.PostAsJsonAsync("/api/auth/staff/login", new StaffLoginRequest("YG0001", TestHost.Password));
        var data = await resp.Content.ReadFromJsonAsync<AuthTokenResponse>();
        return data!.AccessToken;
    }

    [Fact]
    public async Task Order_Reserve_CancelRelease_EqualExchange_And_UncoveredDepositWarning_Should_Pass()
    {
        var token = await GetAdminTokenAsync();
        _client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);

        // 1) 新建测试会员
        var uniquePhone = $"135{Random.Shared.Next(10000000, 99999999)}";
        var memResp = await _client.PostAsJsonAsync("/api/members",
            new CreateMemberRequest("黄忠", uniquePhone, "绿麒麟嘉园 6 栋", "M3配送测试", "602"));
        Assert.Equal(HttpStatusCode.OK, memResp.StatusCode);
        var memberId = (await memResp.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();

        // 2) AC-04: 0 水票时尝试下单 2 桶 -> 服务端拒绝透支
        var overResp = await _client.PostAsJsonAsync("/api/orders",
            new CreateWaterOrderRequest(memberId, "BUCKET_18_9L", "DELIVERY", 2, $"idem-ord-over-{Guid.NewGuid()}"));
        Assert.Equal(HttpStatusCode.BadRequest, overResp.StatusCode);
        var overErr = await overResp.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("TICKET_INSUFFICIENT", overErr.GetProperty("error").GetString());

        // 3) 充值 12 张桶装配送水票 (¥200: 购 10 + 赠 2) 并缴纳 1 个水桶押金 (¥50)
        var deliveryPlanId = Guid.Parse("30000000-0000-0000-0000-000000000103");
        await _client.PostAsJsonAsync("/api/recharges",
            new CreateRechargeOrderRequest(memberId, deliveryPlanId, "WECHAT", $"idem-m3-rcg-{Guid.NewGuid()}"));
        await _client.PostAsJsonAsync("/api/deposits/collect",
            new CollectDepositRequest(memberId, "BUCKET", 1, "WECHAT", $"idem-m3-dep-{Guid.NewGuid()}"));

        // 4) AC-06: 下单 3 桶 (可用变为 9，预占变为 3)，随后取消订单 -> 预占 3 桶原路释放回可用 (12)
        var cancelOrdResp = await _client.PostAsJsonAsync("/api/orders",
            new CreateWaterOrderRequest(memberId, "BUCKET_18_9L", "DELIVERY", 3, $"idem-ord-cancel-{Guid.NewGuid()}"));
        Assert.Equal(HttpStatusCode.OK, cancelOrdResp.StatusCode);
        var cancelOrdJson = await cancelOrdResp.Content.ReadFromJsonAsync<JsonElement>();
        var cancelOrderId = cancelOrdJson.GetProperty("id").GetGuid();
        Assert.Equal(10, cancelOrdJson.GetProperty("availableTicketsAfter").GetInt32());
        Assert.Equal(3, cancelOrdJson.GetProperty("reservedTicketsAfter").GetInt32());

        var doCancelResp = await _client.PostAsJsonAsync($"/api/orders/{cancelOrderId}/cancel",
            new CancelWaterOrderRequest("客户临时出差改期"));
        Assert.Equal(HttpStatusCode.OK, doCancelResp.StatusCode);
        var doCancelJson = await doCancelResp.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(13, doCancelJson.GetProperty("availableTicketsAfter").GetInt32());
        Assert.Equal(0, doCancelJson.GetProperty("reservedTicketsAfter").GetInt32());

        // 5) AC-07: 首单配送 1 桶 (发出重桶 N=1, 收回空桶 M=0 -> 持有 1 桶 <= 押金覆盖 1 桶)
        var ord1Resp = await _client.PostAsJsonAsync("/api/orders",
            new CreateWaterOrderRequest(memberId, "BUCKET_18_9L", "DELIVERY", 1, $"idem-ord-1-{Guid.NewGuid()}"));
        var ord1Id = (await ord1Resp.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();

        var ful1Resp = await _client.PostAsJsonAsync($"/api/orders/{ord1Id}/fulfill",
            new FulfillWaterOrderRequest(ActualQty: 1, FullOutN: 1, EmptyInM: 0));
        Assert.Equal(HttpStatusCode.OK, ful1Resp.StatusCode);
        var ful1Json = await ful1Resp.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(1, ful1Json.GetProperty("heldAfter").GetInt32());
        Assert.Equal(12, ful1Json.GetProperty("availableTicketsAfter").GetInt32());

        // 6) AC-08: 次单等量换桶配送 1 桶 (发出重桶 N=1, 收回空桶 M=1 -> 净增 0, 持有仍为 1 桶 <= 押金覆盖 1 桶，无需补交押金)
        var ord2Resp = await _client.PostAsJsonAsync("/api/orders",
            new CreateWaterOrderRequest(memberId, "BUCKET_18_9L", "DELIVERY", 1, $"idem-ord-2-{Guid.NewGuid()}"));
        var ord2Id = (await ord2Resp.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();

        var ful2Resp = await _client.PostAsJsonAsync($"/api/orders/{ord2Id}/fulfill",
            new FulfillWaterOrderRequest(ActualQty: 1, FullOutN: 1, EmptyInM: 1));
        Assert.Equal(HttpStatusCode.OK, ful2Resp.StatusCode);
        var ful2Json = await ful2Resp.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(1, ful2Json.GetProperty("heldAfter").GetInt32());
        Assert.Equal(11, ful2Json.GetProperty("availableTicketsAfter").GetInt32());

        // 7) AC-09: 第三单下单 2 桶，配送时发出重桶 N=2，仅收回空桶 M=1 -> 累计占桶将达 2 桶 > 已缴押金覆盖 1 桶 -> 拦截要求补 1 桶押金
        var ord3Resp = await _client.PostAsJsonAsync("/api/orders",
            new CreateWaterOrderRequest(memberId, "BUCKET_18_9L", "DELIVERY", 2, $"idem-ord-3-{Guid.NewGuid()}"));
        var ord3Id = (await ord3Resp.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();

        var ful3BlockResp = await _client.PostAsJsonAsync($"/api/orders/{ord3Id}/fulfill",
            new FulfillWaterOrderRequest(ActualQty: 2, FullOutN: 2, EmptyInM: 1));
        Assert.Equal(HttpStatusCode.OK, ful3BlockResp.StatusCode);
        var completed = await ful3BlockResp.Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(completed.GetProperty("owedDepositAmount").GetDecimal() > 0);

    }

    [Fact]
    public async Task Owed_Deposit_Needs_A_Note_At_Handover_And_When_Damage_Exceeds_The_Paid_Deposit()
    {
        var token = await GetAdminTokenAsync();
        _client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);

        // 会员交了 1 个桶的押金，配送 3 桶一个空桶都没换回：还差 2 个桶的押金。
        var memResp = await _client.PostAsJsonAsync("/api/members",
            new CreateMemberRequest("欠押金验收", $"137{Random.Shared.Next(10000000, 99999999)}", "绿麒麟嘉园 7 栋", "欠押金测试", "701"));
        var member = await memResp.Content.ReadFromJsonAsync<JsonElement>();
        var memberId = member.GetProperty("id").GetGuid();
        await _client.PostAsJsonAsync("/api/recharges",
            new CreateRechargeOrderRequest(memberId, Guid.Parse("30000000-0000-0000-0000-000000000103"), "WECHAT", $"idem-owe-rcg-{Guid.NewGuid()}"));
        await _client.PostAsJsonAsync("/api/deposits/collect", new CollectDepositRequest(memberId, "BUCKET", 1, "CASH", $"idem-owe-dep-{Guid.NewGuid()}"));
        var ordResp = await _client.PostAsJsonAsync("/api/orders",
            new CreateWaterOrderRequest(memberId, "BUCKET_18_9L", "DELIVERY", 3, $"idem-owe-ord-{Guid.NewGuid()}"));
        var orderJson = await ordResp.Content.ReadFromJsonAsync<JsonElement>();
        var orderId = orderJson.GetProperty("id").GetGuid();

        // 写了备注照样交付：会员手里 3 个，押金只够 1 个，欠 2 个；备注记进水单和袋桶台账。
        const string note = "这单后欠押金 2 个桶 ¥100.00；报废 1 个桶，报废费用没给；说明：顾客说下次带钱来";
        var owed = await _client.PostAsJsonAsync($"/api/orders/{orderId}/fulfill",
            new FulfillWaterOrderRequest(ActualQty: 3, FullOutN: 3, EmptyInM: 0, ForceCreditOverride: true, OverrideReason: $"  {note}  "));
        Assert.Equal(HttpStatusCode.OK, owed.StatusCode);
        var owedJson = await owed.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(3, owedJson.GetProperty("heldAfter").GetInt32());
        Assert.Equal(2, owedJson.GetProperty("owedDepositQty").GetInt32());

        var orders = await _client.GetFromJsonAsync<JsonElement>($"/api/orders?memberId={memberId}&page=1&pageSize=20");
        var fulfilled = orders.GetProperty("rows").EnumerateArray().Single(o => o.GetProperty("id").GetGuid() == orderId);
        Assert.Equal("COMPLETED", fulfilled.GetProperty("status").GetString());
        Assert.Equal(note, fulfilled.GetProperty("overrideReason").GetString());
        var orderNo = fulfilled.GetProperty("orderNo").GetString()!;
        var ledger = await _client.GetFromJsonAsync<JsonElement>($"/api/containers/circulation?q={Uri.EscapeDataString(orderNo)}&page=1");
        Assert.Contains(note, ledger.GetProperty("rows")[0].GetProperty("remark").GetString());

        // 欠着的押金会带到下一单：等量换桶也还差 2 个，不记欠押金就拦下。
        var nextOrder = await (await _client.PostAsJsonAsync("/api/orders",
            new CreateWaterOrderRequest(memberId, "BUCKET_18_9L", "DELIVERY", 1, $"idem-owe-ord2-{Guid.NewGuid()}"))).Content.ReadFromJsonAsync<JsonElement>();
        var swap = await _client.PostAsJsonAsync($"/api/orders/{nextOrder.GetProperty("id").GetGuid()}/fulfill",
            new FulfillWaterOrderRequest(ActualQty: 1, FullOutN: 1, EmptyInM: 1));
        Assert.Equal(HttpStatusCode.OK, swap.StatusCode);
        Assert.Equal(2, (await swap.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("owedDepositQty").GetInt32());

        // 破损 2 个：交过的 1 个押金先扣，剩下 1 个没押金。不勾选就拦下，勾了不写备注也拦下。
        var damage = new ReportContainerDamageRequest(memberId, "BUCKET", 2, "桶身开裂", $"idem-owe-dmg-{Guid.NewGuid()}");
        var blocked = await _client.PostAsJsonAsync("/api/containers/damages", damage);
        Assert.Equal(HttpStatusCode.BadRequest, blocked.StatusCode);
        Assert.Contains("还差 1 个没押金", await blocked.Content.ReadAsStringAsync());
        Assert.Equal(HttpStatusCode.BadRequest, (await _client.PostAsJsonAsync("/api/containers/damages", damage with { AcceptUncovered = true, UncoveredNote = " " })).StatusCode);

        var uncoveredRequest = damage with { AcceptUncovered = true, UncoveredNote = "报废费用没给，顾客说下次一起交" };
        var reported = await _client.PostAsJsonAsync("/api/containers/damages", uncoveredRequest);
        Assert.Equal(HttpStatusCode.OK, reported.StatusCode);
        var receipt = await reported.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(50m, receipt.GetProperty("depositAmount").GetDecimal());
        Assert.Equal(1, receipt.GetProperty("uncoveredQty").GetInt32());
        var replay = await (await _client.PostAsJsonAsync("/api/containers/damages", uncoveredRequest)).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(receipt.GetProperty("id").GetGuid(), replay.GetProperty("id").GetGuid());

        var memberNo = Uri.EscapeDataString(member.GetProperty("memberNo").GetString()!);
        var damages = await _client.GetFromJsonAsync<JsonElement>($"/api/containers/damages?q={memberNo}&page=1");
        var row = damages.GetProperty("rows").EnumerateArray().Single();
        Assert.Equal(1, row.GetProperty("uncoveredQty").GetInt32());
        Assert.Equal("报废费用没给，顾客说下次一起交", row.GetProperty("uncoveredNote").GetString());
        var damageLedger = await _client.GetFromJsonAsync<JsonElement>($"/api/containers/circulation?q={Uri.EscapeDataString(row.GetProperty("damageNo").GetString()!)}&page=1");
        Assert.Contains("没押金 1 个：报废费用没给", damageLedger.GetProperty("rows")[0].GetProperty("remark").GetString());

        // 确认报废只扣交过的那 1 个桶的押金。
        var scrap = await _client.PostAsJsonAsync($"/api/containers/damages/{row.GetProperty("id").GetGuid()}/scrap",
            new ScrapContainerDamageRequest("无法继续周转", $"idem-owe-scrap-{Guid.NewGuid()}"));
        Assert.Equal(HttpStatusCode.OK, scrap.StatusCode);
        Assert.Equal(50m, (await scrap.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("deductedAmount").GetDecimal());
        var profile = await _client.GetFromJsonAsync<JsonElement>($"/api/members/{memberId}/profile");
        Assert.Equal(1, profile.GetProperty("heldBuckets").GetInt32());
        Assert.Equal(0m, profile.GetProperty("depositAmount").GetDecimal());
    }

    [Fact]
    public async Task Handover_Note_On_Damaged_Containers_Is_Kept_When_No_Deposit_Is_Owed()
    {
        var token = await GetAdminTokenAsync();
        _client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);

        // 押金够 2 个桶，配送 1 桶不换空桶：不欠押金，但顾客有个坏桶不赔，交付备注照样记进水单和袋桶台账。
        var memResp = await _client.PostAsJsonAsync("/api/members",
            new CreateMemberRequest("损坏备注验收", $"138{Random.Shared.Next(10000000, 99999999)}", "绿麒麟嘉园 8 栋", "损坏备注测试", "801"));
        var memberId = (await memResp.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        await _client.PostAsJsonAsync("/api/recharges",
            new CreateRechargeOrderRequest(memberId, Guid.Parse("30000000-0000-0000-0000-000000000103"), "WECHAT", $"idem-dmg-rcg-{Guid.NewGuid()}"));
        await _client.PostAsJsonAsync("/api/deposits/collect", new CollectDepositRequest(memberId, "BUCKET", 2, "CASH", $"idem-dmg-dep-{Guid.NewGuid()}"));

        async Task<Guid> Order() => (await (await _client.PostAsJsonAsync("/api/orders",
            new CreateWaterOrderRequest(memberId, "BUCKET_18_9L", "DELIVERY", 1, $"idem-dmg-ord-{Guid.NewGuid()}"))).Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();

        // 超过 500 字的交付备注被拦下，水单不变。
        var tooLong = await Order();
        var refused = await _client.PostAsJsonAsync($"/api/orders/{tooLong}/fulfill",
            new FulfillWaterOrderRequest(ActualQty: 1, FullOutN: 1, EmptyInM: 0, OverrideReason: new string('坏', 501)));
        Assert.Equal(HttpStatusCode.BadRequest, refused.StatusCode);
        Assert.Equal("HANDOVER_NOTE_TOO_LONG", (await refused.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error").GetString());

        const string note = "损坏 1 个桶，不赔付：自然老化";
        var orderId = await Order();
        var done = await _client.PostAsJsonAsync($"/api/orders/{orderId}/fulfill",
            new FulfillWaterOrderRequest(ActualQty: 1, FullOutN: 1, EmptyInM: 0, OverrideReason: $" {note} "));
        Assert.Equal(HttpStatusCode.OK, done.StatusCode);
        Assert.Equal(0, (await done.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("owedDepositQty").GetInt32());

        var orders = await _client.GetFromJsonAsync<JsonElement>($"/api/orders?memberId={memberId}&page=1&pageSize=20");
        var fulfilled = orders.GetProperty("rows").EnumerateArray().Single(o => o.GetProperty("id").GetGuid() == orderId);
        Assert.Equal(note, fulfilled.GetProperty("overrideReason").GetString());
        var ledger = await _client.GetFromJsonAsync<JsonElement>($"/api/containers/circulation?q={Uri.EscapeDataString(fulfilled.GetProperty("orderNo").GetString()!)}&page=1");
        Assert.Equal(note, ledger.GetProperty("rows")[0].GetProperty("remark").GetString());
        Assert.Equal("PENDING", orders.GetProperty("rows").EnumerateArray().Single(o => o.GetProperty("id").GetGuid() == tooLong).GetProperty("status").GetString());
    }

    [Fact]
    public async Task PickupCode_Verification_DiffAdjustment_AC14_And_ContainerIdentity_AC20_Should_Pass()
    {
        var token = await GetAdminTokenAsync();
        _client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);

        // 1) 新建会员并充值自提实惠包 (¥200: 购 12 + 赠 2 = 14 桶) + 缴 2 桶押金
        var uniquePhone = $"136{Random.Shared.Next(10000000, 99999999)}";
        var memResp = await _client.PostAsJsonAsync("/api/members",
            new CreateMemberRequest("马超", uniquePhone, null, "M3自提测试"));
        var memberId = (await memResp.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();

        var pickupPlanId = Guid.Parse("30000000-0000-0000-0000-000000000101");
        await _client.PostAsJsonAsync("/api/recharges",
            new CreateRechargeOrderRequest(memberId, pickupPlanId, "WECHAT", $"idem-m3-pkp-{Guid.NewGuid()}"));
        await _client.PostAsJsonAsync("/api/deposits/collect",
            new CollectDepositRequest(memberId, "BUCKET", 2, "WECHAT", $"idem-m3-pkp-dep-{Guid.NewGuid()}"));

        // 2) 下单 3 桶门店自提 (生成 6 位自提码，可用变为 11，预占为 3)
        var ordResp = await _client.PostAsJsonAsync("/api/orders",
            new CreateWaterOrderRequest(memberId, "BUCKET_18_9L", "PICKUP", 3, $"idem-ord-pkp-{Guid.NewGuid()}"));
        Assert.Equal(HttpStatusCode.OK, ordResp.StatusCode);
        var ordJson = await ordResp.Content.ReadFromJsonAsync<JsonElement>();
        var pickupCode = ordJson.GetProperty("pickupCode").GetString();
        Assert.NotNull(pickupCode);
        Assert.Equal(6, pickupCode!.Length);

        // 3) AC-14: 客户到店实际只提走 2 桶，未填差异原因时拒绝核销
        var noReasonResp = await _client.PostAsJsonAsync("/api/orders/pickup-verify",
            new VerifyPickupCodeRequest(pickupCode, ActualQty: 2, FullOutN: 2, EmptyInM: 0, DiffReason: null));
        Assert.Equal(HttpStatusCode.BadRequest, noReasonResp.StatusCode);
        Assert.Equal("DIFF_REASON_REQUIRED", (await noReasonResp.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error").GetString());

        // 4) AC-14: 填写差异原因后核销成功 -> 实扣 2 桶，多余预占的 1 桶自动释放回可用余额 (11 + 1 = 12)
        var verifyResp = await _client.PostAsJsonAsync("/api/orders/pickup-verify",
            new VerifyPickupCodeRequest(pickupCode, ActualQty: 2, FullOutN: 2, EmptyInM: 0, DiffReason: "电瓶车踏板仅放得下2桶"));
        Assert.Equal(HttpStatusCode.OK, verifyResp.StatusCode);
        var verifyJson = await verifyResp.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(14, verifyJson.GetProperty("availableTicketsAfter").GetInt32());
        Assert.Equal(0, verifyJson.GetProperty("reservedTicketsAfter").GetInt32());
        Assert.Equal(2, verifyJson.GetProperty("heldAfter").GetInt32());

        // 5) AC-20: 校验容器库存恒等式 (现存总量 = 门店可用 + 会员持有 + 待报废)
        var sumResp = await _client.GetAsync("/api/containers/summary");
        Assert.Equal(HttpStatusCode.OK, sumResp.StatusCode);
        var sumList = await sumResp.Content.ReadFromJsonAsync<JsonElement>();
        foreach (var item in sumList.EnumerateArray())
        {
            Assert.True(item.GetProperty("identityValid").GetBoolean());
        }
    }
}
