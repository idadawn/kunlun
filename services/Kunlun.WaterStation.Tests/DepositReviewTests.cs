using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Kunlun.WaterStation.Auth;
using Kunlun.WaterStation.Operations;
using Xunit;

namespace Kunlun.WaterStation.Tests;

/// <summary>
/// 员工收的押金和交付时登记的损坏不赔付，按审核页的两个开关等管理员批准：收的押金待审核时照样算进押金覆盖（交付不受影响），
/// 批准才记成押金批次、驳回就作废（会员变成欠押金）；损坏不赔付批准、驳回都不动账。不分谁办的都要审核。
/// </summary>
[Collection("KunlunIntegration")]
public sealed class DepositReviewTests(TestHost host)
{
    private static string Key() => Guid.NewGuid().ToString("N");
    private static readonly Guid BucketDeliveryPlan = Guid.Parse("30000000-0000-0000-0000-000000000103");

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
    private static async Task<JsonElement> Error(HttpResponseMessage response, HttpStatusCode status)
    {
        var body = await response.Content.ReadAsStringAsync();
        Assert.True(response.StatusCode == status, $"{response.StatusCode}: {body}");
        return JsonSerializer.Deserialize<JsonElement>(body);
    }
    private static async Task<(Guid Id, string No)> Member(HttpClient c, string name)
    {
        var m = await Ok(await c.PostAsJsonAsync("/api/members", new CreateMemberRequest(name, $"139{Random.Shared.Next(10000000, 99999999)}", "审核小区 9 栋", null, "901")));
        var id = m.GetProperty("id").GetGuid();
        await Ok(await c.PostAsJsonAsync("/api/recharges", new CreateRechargeOrderRequest(id, BucketDeliveryPlan, "WECHAT", Key())));
        return (id, m.GetProperty("memberNo").GetString()!);
    }
    private static async Task<JsonElement> Buckets(HttpClient c, Guid mid) =>
        (await c.GetFromJsonAsync<JsonElement>($"/api/members/{mid}/deposit-summary"))!.EnumerateArray().Single(r => r.GetProperty("containerType").GetString() == "BUCKET");
    private static async Task<decimal> DepositBalance(HttpClient c, Guid mid) =>
        (await c.GetFromJsonAsync<JsonElement>($"/api/members/{mid}/profile")).GetProperty("depositAmount").GetDecimal();
    private static async Task<Guid> Order(HttpClient c, Guid mid, int qty) =>
        (await Ok(await c.PostAsJsonAsync("/api/orders", new CreateWaterOrderRequest(mid, "BUCKET_18_9L", "DELIVERY", qty, Key())))).GetProperty("id").GetGuid();
    private static async Task<JsonElement> Requests(HttpClient c, string kind, string memberNo) =>
        (await c.GetFromJsonAsync<JsonElement>($"/api/refund-requests?kind={kind}&q={memberNo}&page=1")).GetProperty("rows");
    private static Task<HttpResponseMessage> Switches(HttpClient admin, bool deposit, bool damage) =>
        admin.PutAsJsonAsync("/api/settings/review", new SaveReviewSettingsRequest(true, true, deposit, damage));

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task Standalone_Return_Splits_Damaged_Stock_And_Tracks_One_Waiver(bool approve)
    {
        using var admin = await Login("YG0001");
        await Ok(await Switches(admin, deposit: false, damage: true));
        try
        {
            var (mid, _) = await Member(admin, "独立归还验收");
            const string path = "/api/containers/movements";
            async Task<JsonElement> Stock() => (await admin.GetFromJsonAsync<JsonElement>("/api/containers/summary"))
                .EnumerateArray().Single(r => r.GetProperty("containerType").GetString() == "BAG");
            async Task<JsonElement> Bags() => (await admin.GetFromJsonAsync<JsonElement>($"/api/members/{mid}/deposit-summary"))
                .EnumerateArray().Single(r => r.GetProperty("containerType").GetString() == "BAG");
            static int Qty(JsonElement row, string key) => row.GetProperty(key).GetInt32();

            var issue = new RegisterContainerMovementRequest(mid, "BAG", 5, 0, IdempotencyKey: Key());
            await Error(await admin.PostAsJsonAsync(path, issue with { DamagedQty = 1, DamageCompensated = true }), HttpStatusCode.BadRequest);
            await Ok(await admin.PostAsJsonAsync(path, issue));
            var before = await Stock();
            var request = new RegisterContainerMovementRequest(mid, "BAG", 0, 3, IdempotencyKey: Key(), DamagedQty: 1,
                DamageCompensated: false, DamageReason: "自然老化");
            await Error(await admin.PostAsJsonAsync(path, request with { DamagedQty = 4 }), HttpStatusCode.BadRequest);
            await Error(await admin.PostAsJsonAsync(path, request with { DamageReason = " " }), HttpStatusCode.BadRequest);
            var results = await Task.WhenAll(Enumerable.Range(0, 2).Select(_ => admin.PostAsJsonAsync(path, request)));
            var first = await Ok(results[0]);
            Assert.Equal(first.GetProperty("ledgerNo").GetString(), (await Ok(results[1])).GetProperty("ledgerNo").GetString());
            Assert.Equal(2, Qty(first, "currentHeld"));
            await Error(await admin.PostAsJsonAsync(path, request with { DamageCompensated = true }), HttpStatusCode.Conflict);
            var after = await Stock();
            Assert.Equal(Qty(before, "inStationQty") + 2, Qty(after, "inStationQty"));
            Assert.Equal(Qty(before, "damagedQty") + 1, Qty(after, "damagedQty"));
            Assert.Equal(Qty(before, "memberHeldQty") - 3, Qty(after, "memberHeldQty"));
            Assert.Equal(Qty(before, "totalQty"), Qty(after, "totalQty"));
            var no = first.GetProperty("ledgerNo").GetString();
            var ledger = Assert.Single((await admin.GetFromJsonAsync<JsonElement>($"/api/containers/circulation?q={no}&page=1")).GetProperty("rows").EnumerateArray());
            Assert.Equal((3, 1, -3), (Qty(ledger, "emptyInQty"), Qty(ledger, "damagedReturnQty"), Qty(ledger, "deltaHeld")));
            var slip = Assert.Single((await admin.GetFromJsonAsync<JsonElement>($"/api/containers/damages?q={no}&status=PENDING&page=1")).GetProperty("rows").EnumerateArray());
            Assert.Equal(no, slip.GetProperty("movementNo").GetString());
            var review = Assert.Single((await admin.GetFromJsonAsync<JsonElement>($"/api/refund-requests?q={no}&kind=DAMAGE&page=1")).GetProperty("rows").EnumerateArray());
            Assert.Equal(no, review.GetProperty("movementNo").GetString());
            Assert.Equal("PENDING", review.GetProperty("status").GetString());
            Assert.Equal(1, Qty((await Bags()).GetProperty("damageBreakdown"), "awaitingReview"));
            var decision = approve ? "approve" : "reject";
            await Ok(await admin.PostAsJsonAsync($"/api/refund-requests/{review.GetProperty("id")}/{decision}", new { note = "核对完毕" }));
            await Ok(await admin.PostAsJsonAsync(path, request with { IdempotencyKey = Key(), EmptyInM = 1, DamageCompensated = true, DamageReason = null }));
            var bag = await Bags();
            var counts = bag.GetProperty("damageBreakdown");
            Assert.Equal((1,2,1), (Qty(bag,"heldQty"), Qty(bag,"damageQty"), Qty(counts,"paid")));
            Assert.Equal(1, Qty(counts,approve ? "waived" : "pending"));
            var preview = await Ok(await admin.PostAsJsonAsync($"/api/members/{mid}/settlement/preview", new SettlementPreviewRequest()));
            Assert.Equal(approve ? 0 : 1, preview.GetProperty("slip").GetProperty("damages").GetArrayLength());
            Assert.Equal(0m, await DepositBalance(admin,mid));
        }
        finally { await Ok(await Switches(admin, deposit: false, damage: false)); }
    }

    [Fact]
    public async Task Deposits_Staff_Take_Wait_For_Approval_And_Cover_The_Handover_Meanwhile()
    {
        using var admin = await Login("YG0001");
        using var clerk = await Login("YG0012");
        await Ok(await Switches(admin, deposit: true, damage: false));
        try
        {
            // Saving only the two older switches (an admin page from before) leaves the deposit switch as it is.
            await Ok(await admin.PutAsJsonAsync("/api/settings/review", new SaveReviewSettingsRequest(true, true)));
            Assert.True((await clerk.GetFromJsonAsync<JsonElement>("/api/settings/review")).GetProperty("depositReview").GetBoolean());

            var (mid, memberNo) = await Member(admin, "收押金审核验收");
            var key = Key();
            var collect = new CollectDepositRequest(mid, "BUCKET", 2, "WECHAT", key);
            var pending = await Ok(await clerk.PostAsJsonAsync("/api/deposits/collect", collect));
            Assert.Equal("PENDING", pending.GetProperty("status").GetString());
            Assert.Equal(100m, pending.GetProperty("totalAmount").GetDecimal());
            var requestNo = pending.GetProperty("requestNo").GetString();
            var replay = await Ok(await clerk.PostAsJsonAsync("/api/deposits/collect", collect));
            Assert.Equal(requestNo, replay.GetProperty("requestNo").GetString());
            Assert.True(replay.GetProperty("idempotentReplay").GetBoolean());
            Assert.Equal(HttpStatusCode.Conflict, (await clerk.PostAsJsonAsync("/api/deposits/collect", collect with { Quantity = 3 })).StatusCode);

            // Not booked yet: no lot, no balance, nothing refundable, but it covers the two buckets this delivery leaves.
            var summary = await Buckets(admin, mid);
            Assert.Equal(0, summary.GetProperty("paidQty").GetInt32());
            Assert.Equal(2, summary.GetProperty("pendingCollectQty").GetInt32());
            Assert.Equal(100m, summary.GetProperty("pendingCollectAmount").GetDecimal());
            Assert.Equal(0m, await DepositBalance(admin, mid));
            var delivered = await Ok(await clerk.PostAsJsonAsync($"/api/orders/{await Order(admin, mid, 2)}/fulfill", new FulfillWaterOrderRequest(2, 2, 0)));
            Assert.Equal(0, delivered.GetProperty("owedDepositQty").GetInt32());

            var request = Assert.Single((await Requests(admin, "COLLECT", memberNo)).EnumerateArray());
            Assert.Equal("PENDING", request.GetProperty("status").GetString());
            Assert.Equal(50m, request.GetProperty("unitPrice").GetDecimal());
            Assert.Equal("林晓峰（小林）", request.GetProperty("applicantName").GetString());
            var requestId = request.GetProperty("id").GetGuid();
            Assert.Equal(HttpStatusCode.Forbidden, (await clerk.PostAsJsonAsync($"/api/refund-requests/{requestId}/approve", new ApproveRefundRequest(null, null))).StatusCode);

            // Approving books the lot at the price it was taken for; the collect replayed afterwards finds that lot.
            var approved = await Ok(await admin.PostAsJsonAsync($"/api/refund-requests/{requestId}/approve", new ApproveRefundRequest(null, "微信到账")));
            Assert.Equal(100m, approved.GetProperty("refundAmount").GetDecimal());
            var depositNo = approved.GetProperty("refundNo").GetString();
            summary = await Buckets(admin, mid);
            Assert.Equal(2, summary.GetProperty("paidQty").GetInt32());
            Assert.Equal(0, summary.GetProperty("pendingCollectQty").GetInt32());
            Assert.Equal(100m, await DepositBalance(admin, mid));
            var booked = await Ok(await clerk.PostAsJsonAsync("/api/deposits/collect", collect));
            Assert.Equal("APPROVED", booked.GetProperty("status").GetString());
            Assert.Equal(depositNo, booked.GetProperty("depositNo").GetString());
            await Error(await admin.PostAsJsonAsync($"/api/refund-requests/{requestId}/reject", new RejectRefundRequest("钱没到账")), HttpStatusCode.Conflict);

            // The admin login at the counter waits too. Rejected, the deposit is void and the member owes it again.
            var counter = await Ok(await admin.PostAsJsonAsync("/api/deposits/collect", new CollectDepositRequest(mid, "BUCKET", 1, "CASH", Key())));
            Assert.Equal("PENDING", counter.GetProperty("status").GetString());
            var counterId = counter.GetProperty("requestId").GetGuid();
            var nextOrder = await Order(admin, mid, 1);
            await Ok(await admin.PostAsJsonAsync($"/api/refund-requests/{counterId}/reject", new RejectRefundRequest("钱没到账")));
            await Error(await admin.PostAsJsonAsync($"/api/refund-requests/{counterId}/approve", new ApproveRefundRequest(null, null)), HttpStatusCode.Conflict);
            Assert.Equal(0, (await Buckets(admin, mid)).GetProperty("pendingCollectQty").GetInt32());
            var completed = await Ok(await clerk.PostAsJsonAsync($"/api/orders/{nextOrder}/fulfill", new FulfillWaterOrderRequest(1, 1, 0)));
            Assert.Equal(50m, completed.GetProperty("owedDepositAmount").GetDecimal());
            Assert.Equal(100m, await DepositBalance(admin, mid));
        }
        finally
        {
            await Ok(await Switches(admin, deposit: false, damage: false));
        }
    }

    [Fact]
    public async Task Unpaid_Damage_At_Handover_Waits_For_Approval_And_Moves_No_Money()
    {
        using var admin = await Login("YG0001");
        using var courier = await Login("YG0008");
        await Ok(await Switches(admin, deposit: false, damage: true));
        try
        {
            var (mid, memberNo) = await Member(admin, "损坏审核验收");
            await Ok(await admin.PostAsJsonAsync("/api/deposits/collect", new CollectDepositRequest(mid, "BUCKET", 3, "CASH", Key())));

            await Ok(await admin.PostAsJsonAsync($"/api/members/{mid}/opening", new SaveOpeningRequest(Key(), Holdings:[new("BUCKET", 7)])));
            async Task<JsonElement> Stock() => (await admin.GetFromJsonAsync<JsonElement>("/api/containers/summary"))
                .EnumerateArray().Single(r => r.GetProperty("containerType").GetString() == "BUCKET");
            var stockBefore = await Stock();
            var orderId = await Order(admin, mid, 5);
            var endpoint = $"/api/orders/{orderId}/fulfill";
            var invalid = new FulfillWaterOrderRequest(5,5,5, DamagedQty:6, DamageCompensated:true);
            Assert.Equal("INVALID_DAMAGE_QTY", (await Error(await courier.PostAsJsonAsync(endpoint,invalid), HttpStatusCode.BadRequest)).GetProperty("error").GetString());
            Assert.Equal("DAMAGE_COMPENSATION_REQUIRED", (await Error(await courier.PostAsJsonAsync($"/api/orders/{orderId}/fulfill",
                new FulfillWaterOrderRequest(5, 5, 5, DamagedQty: 1)), HttpStatusCode.BadRequest)).GetProperty("error").GetString());
            Assert.Equal("DAMAGE_REASON_REQUIRED", (await Error(await courier.PostAsJsonAsync($"/api/orders/{orderId}/fulfill",
                new FulfillWaterOrderRequest(5, 5, 5, DamagedQty: 1, DamageCompensated: false, DamageReason: "  ")), HttpStatusCode.BadRequest)).GetProperty("error").GetString());

            var returns = new FulfillWaterOrderRequest(5, 5, 5, DamagedQty: 1, DamageCompensated: false, DamageReason: "自然老化");
            var done = await Ok(await courier.PostAsJsonAsync(endpoint,returns));
            Assert.True((await Ok(await courier.PostAsJsonAsync(endpoint,returns))).GetProperty("idempotentReplay").GetBoolean());
            var stockAfter = await Stock();
            int Qty(JsonElement item, string key) => item.GetProperty(key).GetInt32();
            Assert.Equal(Qty(stockBefore,"inStationQty") - 1, Qty(stockAfter,"inStationQty"));
            Assert.Equal(Qty(stockBefore,"damagedQty") + 1, Qty(stockAfter,"damagedQty"));
            Assert.Equal(Qty(stockBefore,"totalQty"), Qty(stockAfter,"totalQty"));
            Assert.Equal(7, Qty(await Buckets(admin,mid),"heldQty"));
            var orderNo = done.GetProperty("orderNo").GetString();
            var movement = Assert.Single((await admin.GetFromJsonAsync<JsonElement>($"/api/containers/circulation?q={orderNo}&page=1")).GetProperty("rows").EnumerateArray());
            Assert.Equal((5,5,1,0), (Qty(movement,"fullOutQty"),Qty(movement,"emptyInQty"),Qty(movement,"damagedReturnQty"),Qty(movement,"deltaHeld")));
            var damage = Assert.Single((await admin.GetFromJsonAsync<JsonElement>($"/api/containers/damages?q={orderNo}&status=PENDING&page=1")).GetProperty("rows").EnumerateArray());
            Assert.Equal(orderNo, damage.GetProperty("handoverOrderNo").GetString());
            Assert.Equal(1, Qty(damage,"quantity"));
            Assert.Equal("PENDING", done.GetProperty("damageReviewStatus").GetString());
            var row = Assert.Single((await Requests(admin, "DAMAGE", memberNo)).EnumerateArray());
            Assert.Equal(done.GetProperty("damageRequestNo").GetString(), row.GetProperty("requestNo").GetString());
            Assert.Equal(done.GetProperty("orderNo").GetString(), row.GetProperty("orderNo").GetString());
            Assert.Equal(1, row.GetProperty("quantity").GetInt32());
            Assert.Equal("自然老化", row.GetProperty("reason").GetString());
            Assert.Equal("王建国（王师傅）", row.GetProperty("applicantName").GetString());
            Assert.Equal(HttpStatusCode.Forbidden, (await courier.PostAsJsonAsync($"/api/refund-requests/{row.GetProperty("id").GetGuid()}/reject", new RejectRefundRequest("要顾客赔"))).StatusCode);
            await Ok(await admin.PostAsJsonAsync($"/api/refund-requests/{row.GetProperty("id").GetGuid()}/reject", new RejectRefundRequest("要顾客赔")));
            Assert.Equal(150m, await DepositBalance(admin, mid));

            await Ok(await admin.PostAsJsonAsync($"/api/containers/damages/{damage.GetProperty("id")}/scrap",
                new ScrapContainerDamageRequest("无法修复",Key(),false)));
            var afterScrap = await Stock();
            Assert.Equal(Qty(stockBefore,"damagedQty"), Qty(afterScrap,"damagedQty"));
            Assert.Equal(Qty(stockBefore,"scrappedQty") + 1, Qty(afterScrap,"scrappedQty"));
            Assert.Equal(150m, await DepositBalance(admin,mid));

            await Ok(await courier.PostAsJsonAsync($"/api/orders/{await Order(admin, mid, 1)}/fulfill",
                new FulfillWaterOrderRequest(1,1,1,DamagedQty:1,DamageCompensated:false,DamageReason:"袋桶老化")));
            var awaiting = (await Buckets(admin, mid)).GetProperty("damageBreakdown");
            Assert.Equal((1, 1), (Qty(awaiting,"awaitingReview"), Qty(awaiting,"pending")));
            var pendingWaiver = (await Requests(admin,"DAMAGE",memberNo)).EnumerateArray().Single(r => r.GetProperty("status").GetString()=="PENDING");
            await Ok(await admin.PostAsJsonAsync($"/api/refund-requests/{pendingWaiver.GetProperty("id")}/approve", new ApproveRefundRequest(null,"同意免赔")));
            // Damage the customer pays for asks nothing; with the switch off an unpaid one is recorded as approved.
            var paidFor = await Ok(await courier.PostAsJsonAsync($"/api/orders/{await Order(admin, mid, 1)}/fulfill",
                new FulfillWaterOrderRequest(1, 1, 1, DamagedQty: 1, DamageCompensated: true)));
            Assert.Equal(JsonValueKind.Null, paidFor.GetProperty("damageRequestNo").ValueKind);
            await Ok(await Switches(admin, deposit: false, damage: false));
            var waived = await Ok(await courier.PostAsJsonAsync($"/api/orders/{await Order(admin, mid, 1)}/fulfill",
                new FulfillWaterOrderRequest(1, 1, 2, DamagedQty: 2, DamageCompensated: false, DamageReason: "送水时碰坏的")));
            Assert.Equal("APPROVED", waived.GetProperty("damageReviewStatus").GetString());
            var preview = await Ok(await admin.PostAsJsonAsync($"/api/members/{mid}/settlement/preview", new SettlementPreviewRequest()));
            var historical = preview.GetProperty("slip").GetProperty("damages").EnumerateArray().ToArray();
            var rejectedRef = row.GetProperty("requestNo").GetString()!;
            Assert.Equal(rejectedRef, Assert.Single(historical).GetProperty("reference").GetString());
            var breakdown = preview.GetProperty("slip").GetProperty("damageHistory").EnumerateArray().ToArray();
            var quantities = breakdown.GroupBy(d => d.GetProperty("status").GetString()!)
                .ToDictionary(g => g.Key, g => g.Sum(d => d.GetProperty("quantity").GetInt32()));
            Assert.Equal((3,1,1), (quantities["WAIVED"], quantities["REJECTED"], quantities["PAID"]));
            Assert.Equal(paidFor.GetProperty("orderNo").GetString(), Assert.Single(breakdown, d => d.GetProperty("status").GetString()=="PAID").GetProperty("reference").GetString());
            Assert.Equal(5, quantities.Values.Sum());
            var profile = await Buckets(admin, mid);
            var counts = profile.GetProperty("damageBreakdown");
            Assert.Equal(5, Qty(profile,"damageQty"));
            Assert.Equal((5,3,1,1), (Qty(counts,"total"), Qty(counts,"waived"), Qty(counts,"paid"), Qty(counts,"pending")));
            var settled = await Ok(await admin.PostAsJsonAsync($"/api/members/{mid}/settlement",
                new SettlementRequest(Key(),"CASH", DamageDecisions:[new(rejectedRef,true)])));
            var rows = (await admin.GetFromJsonAsync<JsonElement>($"/api/refund-requests?memberId={mid}&kind=DAMAGE&page=1")).GetProperty("rows").EnumerateArray().ToArray();
            Assert.Equal(3,rows.Length);
            Assert.All(rows,r => Assert.Equal(mid,r.GetProperty("memberId").GetGuid()));
            var resolved = rows.Single(r => r.GetProperty("status").GetString()=="REJECTED");
            Assert.Equal(settled.GetProperty("settlementNo").GetString(),resolved.GetProperty("settlementNo").GetString());
            Assert.True(resolved.GetProperty("settlementCharged").GetBoolean());
            Assert.All(rows.Where(r => r.GetProperty("status").GetString()=="APPROVED"),r => Assert.Equal(JsonValueKind.Null,r.GetProperty("settlementNo").ValueKind));

        }
        finally
        {
            await Ok(await Switches(admin, deposit: false, damage: false));
        }
    }
}
