using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Kunlun.WaterStation.Auth;
using Kunlun.WaterStation.Operations;
using Xunit;

namespace Kunlun.WaterStation.Tests;

[Collection("KunlunIntegration")]
public sealed class RemarkTests(TestHost host)
{
    private static readonly Guid DeliveryPlan = Guid.Parse("30000000-0000-0000-0000-000000000103");
    private static string Key() => Guid.NewGuid().ToString("N");
    private static string Phone() => $"139{Random.Shared.Next(10000000, 99999999)}";
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
    private static async Task<Guid> DeliveryMember(HttpClient admin, string? remark = null)
    {
        var id = (await Ok(await admin.PostAsJsonAsync("/api/members", new CreateMemberRequest("备注验收", Phone(), "幸福里小区 3 栋", remark, "2 单元 501 室")))).GetProperty("id").GetGuid();
        await Ok(await admin.PostAsJsonAsync("/api/recharges", new CreateRechargeOrderRequest(id, DeliveryPlan, "CASH", Key())));
        return id;
    }
    private static CreateWaterOrderRequest Delivery(Guid member, string? remark, string? key = null) =>
        new(member, "BUCKET_18_9L", "DELIVERY", 1, key ?? Key(), Remark: remark);
    private static async Task<JsonElement> Listed(HttpClient c, Guid member, string orderNo) =>
        (await c.GetFromJsonAsync<JsonElement[]>($"/api/orders?memberId={member}"))!.Single(o => o.GetProperty("orderNo").GetString() == orderNo);

    [Fact]
    public async Task Member_Order_Remark_Reaches_Courier_And_Order_Export()
    {
        using var admin = await Staff(); var id = await DeliveryMember(admin);
        var username = "member_" + Key()[..12]; var password = Key();
        await Ok(await admin.PutAsJsonAsync($"/api/accounts/MEMBER/{id}/credentials", new AccountCredentialsRequest(username, password)));
        using var member = host.CreateClient();
        var auth = await Ok(await member.PostAsJsonAsync("/api/auth/member/login", new StaffLoginRequest(username, password)));
        member.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", auth.GetProperty("accessToken").GetString());

        var key = Key();
        var created = await Ok(await member.PostAsJsonAsync("/api/orders", Delivery(id, "  空桶放门口  ", key)));
        var orderNo = created.GetProperty("orderNo").GetString()!;
        Assert.Equal("空桶放门口", created.GetProperty("remark").GetString());
        var replay = await Ok(await member.PostAsJsonAsync("/api/orders", Delivery(id, "  空桶放门口  ", key)));
        Assert.True(replay.GetProperty("idempotentReplay").GetBoolean());
        Assert.Equal("空桶放门口", replay.GetProperty("remark").GetString());

        using var courier = await Staff("YG0008");
        Assert.Equal("空桶放门口", (await Listed(courier, id, orderNo)).GetProperty("remark").GetString());
        Assert.Equal("空桶放门口", (await Listed(member, id, orderNo)).GetProperty("remark").GetString());

        // Free text with separators stays in one quoted CSV cell, placed before the creation time.
        var multiline = (await Ok(await admin.PostAsJsonAsync("/api/orders", Delivery(id, "放门口,别敲门\n谢谢")))).GetProperty("orderNo").GetString();
        var csv = await admin.GetStringAsync("/api/exports/orders");
        Assert.Contains("差异原因,备注,创建时间", csv);
        var row = csv.Split('\n').Single(l => l.StartsWith(orderNo + ","));
        Assert.Matches(@",空桶放门口,\d{4}-\d{2}-\d{2}T", row);
        Assert.Contains($"{multiline},", csv);
        Assert.Contains(",\"放门口,别敲门\n谢谢\",", csv);
    }

    [Fact]
    public async Task Blank_Order_Remarks_Are_Null_And_Overlong_Ones_Reserve_Nothing()
    {
        using var admin = await Staff(); var id = await DeliveryMember(admin);
        var blank = (await Ok(await admin.PostAsJsonAsync("/api/orders", Delivery(id, "   ")))).GetProperty("orderNo").GetString()!;
        Assert.Equal(JsonValueKind.Null, (await Listed(admin, id, blank)).GetProperty("remark").ValueKind);
        var none = (await Ok(await admin.PostAsJsonAsync("/api/orders", Delivery(id, null)))).GetProperty("orderNo").GetString()!;
        Assert.Equal(JsonValueKind.Null, (await Listed(admin, id, none)).GetProperty("remark").ValueKind);

        var before = (await admin.GetFromJsonAsync<JsonElement>($"/api/members/{id}/profile")).GetProperty("bucketDeliveryTickets").GetInt32();
        var tooLong = await admin.PostAsJsonAsync("/api/orders", Delivery(id, new string('长', Remarks.OrderMaxLength + 1)));
        Assert.Equal(HttpStatusCode.BadRequest, tooLong.StatusCode);
        Assert.Contains("备注", await tooLong.Content.ReadAsStringAsync());
        Assert.Equal(before, (await admin.GetFromJsonAsync<JsonElement>($"/api/members/{id}/profile")).GetProperty("bucketDeliveryTickets").GetInt32());
        await Ok(await admin.PostAsJsonAsync("/api/orders", Delivery(id, new string('长', Remarks.OrderMaxLength))));
    }

    [Fact]
    public async Task Member_Remark_Is_Returned_By_Member_List_And_Profile()
    {
        using var admin = await Staff();
        var phone = Phone();
        var created = await Ok(await admin.PostAsJsonAsync("/api/members", new CreateMemberRequest("备注会员", phone, null, " 老客户，周末上午送 ")));
        var id = created.GetProperty("id").GetGuid();
        Assert.Equal("老客户，周末上午送", created.GetProperty("remark").GetString());
        var listed = Assert.Single((await admin.GetFromJsonAsync<JsonElement[]>($"/api/members?q={phone}"))!);
        Assert.Equal("老客户，周末上午送", listed.GetProperty("remark").GetString());
        Assert.Equal("老客户，周末上午送", (await admin.GetFromJsonAsync<JsonElement>($"/api/members/{id}/profile")).GetProperty("remark").GetString());

        var plain = (await Ok(await admin.PostAsJsonAsync("/api/members", new CreateMemberRequest("无备注会员", Phone(), null, "")))).GetProperty("id").GetGuid();
        Assert.Equal(JsonValueKind.Null, (await admin.GetFromJsonAsync<JsonElement>($"/api/members/{plain}/profile")).GetProperty("remark").ValueKind);

        var refusedPhone = Phone();
        Assert.Equal(HttpStatusCode.BadRequest, (await admin.PostAsJsonAsync("/api/members", new CreateMemberRequest("超长备注", refusedPhone, null, new string('长', Remarks.MemberMaxLength + 1)))).StatusCode);
        Assert.Empty((await admin.GetFromJsonAsync<JsonElement[]>($"/api/members?q={refusedPhone}"))!);
    }
}
