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

/// <summary>停用、重新启用和删除会员：停用的会员登录不了、办不了业务，余额原样留着；只有没有任何记录的会员能删。</summary>
[Collection("KunlunIntegration")]
public sealed class MemberStatusTests(TestHost host)
{
    private const string Bucket = "BUCKET_18_9L";
    private static string Key() => Guid.NewGuid().ToString("N");
    private static string Phone() => $"136{Random.Shared.Next(10000000, 99999999)}";
    private static async Task<JsonElement> Ok(HttpResponseMessage response)
    {
        var body = await response.Content.ReadAsStringAsync(); Assert.True(response.IsSuccessStatusCode, $"{response.StatusCode}: {body}");
        return JsonSerializer.Deserialize<JsonElement>(body);
    }
    /// <summary>The refusal's message, after checking its status.</summary>
    private static async Task<string> Refused(HttpResponseMessage response, HttpStatusCode status)
    {
        var body = await response.Content.ReadAsStringAsync(); Assert.True(response.StatusCode == status, $"{response.StatusCode}: {body}");
        var json = JsonSerializer.Deserialize<JsonElement>(body);
        return json.TryGetProperty("message", out var message) && message.ValueKind == JsonValueKind.String ? message.GetString()! : json.GetProperty("error").GetString()!;
    }
    private async Task<HttpClient> Staff(string account = "YG0001")
    {
        var c = host.CreateClient(); var s = await Ok(await c.PostAsJsonAsync("/api/auth/staff/login", new StaffLoginRequest(account, TestHost.Password)));
        c.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", s.GetProperty("accessToken").GetString()); return c;
    }
    private static async Task<Guid> Member(HttpClient admin, string? phone = null) =>
        (await Ok(await admin.PostAsJsonAsync("/api/members", new CreateMemberRequest("停用测试", phone ?? Phone(), "新村 5 栋", null, "1-101")))).GetProperty("id").GetGuid();
    private static Task<HttpResponseMessage> SetStatus(HttpClient c, Guid mid, string status, string? reason = null) =>
        c.PatchAsJsonAsync($"/api/members/{mid}/status", new UpdateMemberStatusRequest(status, reason));
    private static Task<HttpResponseMessage> Recharge(HttpClient c, Guid mid) =>
        c.PostAsJsonAsync("/api/recharges", new CreateRechargeOrderRequest(mid, WaterProducts.PlanId("101"), "CASH", Key()));
    private static Task<HttpResponseMessage> Order(HttpClient c, Guid mid) =>
        c.PostAsJsonAsync("/api/orders", new CreateWaterOrderRequest(mid, Bucket, "PICKUP", 1, Key()));
    private Task<HttpResponseMessage> MemberSignIn(string account) =>
        host.CreateClient().PostAsJsonAsync("/api/auth/member/login", new { account, password = TestHost.Password });
    private static async Task<JsonElement> Profile(HttpClient c, Guid mid) => await c.GetFromJsonAsync<JsonElement>($"/api/members/{mid}/profile");

    [Fact]
    public async Task A_Disabled_Member_Cannot_Sign_In_Or_Be_Served_Until_Enabled_Again()
    {
        using var admin = await Staff();
        var mid = await Member(admin);
        await Ok(await Recharge(admin, mid));
        var account = "ty" + Key()[..10];
        var temporary = Key();
        await Ok(await admin.PutAsJsonAsync($"/api/accounts/MEMBER/{mid}/credentials", new AccountCredentialsRequest(account, temporary)));
        using var member = host.CreateClient();
        await TestHost.CompleteFirstLogin(member, account, temporary, TestHost.Password);
        await Ok(await member.GetAsync($"/api/members/{mid}/profile"));

        var disabled = await Ok(await SetStatus(admin, mid, "DISABLED", "  搬走了  "));
        Assert.Equal("DISABLED", disabled.GetProperty("status").GetString());
        Assert.Equal("搬走了", disabled.GetProperty("disableReason").GetString());
        Assert.Equal("林站长", disabled.GetProperty("disabledBy").GetString());
        Assert.Equal(JsonValueKind.String, disabled.GetProperty("disabledAt").ValueKind);

        // The member app's session ends at once, and signing in again is refused.
        Assert.Equal(HttpStatusCode.Unauthorized, (await member.GetAsync($"/api/members/{mid}/profile")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await MemberSignIn(account)).StatusCode);

        // Staff can start nothing for the member, whose balance stays as it was; the reason shows on the profile and the list finds them.
        Assert.Equal("会员已停用", await Refused(await Recharge(admin, mid), HttpStatusCode.BadRequest));
        Assert.Equal("会员已停用", await Refused(await Order(admin, mid), HttpStatusCode.BadRequest));
        Assert.Equal("会员已停用", await Refused(await admin.PostAsJsonAsync("/api/deposits/collect", new CollectDepositRequest(mid, "BUCKET", 1, "CASH", Key())), HttpStatusCode.BadRequest));
        var profile = await Profile(admin, mid);
        Assert.Equal("DISABLED", profile.GetProperty("status").GetString());
        Assert.Equal("搬走了", profile.GetProperty("disableReason").GetString());
        Assert.Equal(16, profile.Tickets(Bucket, "PICKUP"));
        var listed = await admin.GetFromJsonAsync<JsonElement>($"/api/members?q={profile.GetProperty("memberNo").GetString()}&status=DISABLED&pageSize=5");
        Assert.Equal(1, listed.GetProperty("total").GetInt32());
        Assert.Equal("搬走了", listed.GetProperty("rows")[0].GetProperty("disableReason").GetString());

        // Disabling again changes nothing; enabling clears the reason, and the member signs in and orders again.
        await Ok(await SetStatus(admin, mid, "DISABLED", "再停一次"));
        Assert.Equal("搬走了", (await Profile(admin, mid)).GetProperty("disableReason").GetString());
        var enabled = await Ok(await SetStatus(admin, mid, "ACTIVE"));
        Assert.Equal("ACTIVE", enabled.GetProperty("status").GetString());
        Assert.Equal(JsonValueKind.Null, enabled.GetProperty("disableReason").ValueKind);
        await Ok(await MemberSignIn(account));
        await Ok(await Order(admin, mid));
    }

    [Fact]
    public async Task Disabling_Needs_The_Permission_A_Reason_And_Nothing_Left_Unfinished()
    {
        using var admin = await Staff();
        using var clerk = await Staff("YG0012");
        var phone = Phone();
        var mid = await Member(admin, phone);
        Assert.Equal(HttpStatusCode.Forbidden, (await SetStatus(clerk, mid, "DISABLED", "搬走了")).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await SetStatus(admin, mid, "DISABLED", "   ")).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await SetStatus(admin, mid, "DISABLED", new string('长', MemberStatus.ReasonMaxLength + 1))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await SetStatus(admin, mid, "GONE", "搬走了")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await SetStatus(admin, Guid.NewGuid(), "DISABLED", "搬走了")).StatusCode);

        // An open order would be stuck once the member is disabled, so it has to be finished or cancelled first.
        await Ok(await Recharge(admin, mid));
        var order = await Ok(await Order(admin, mid));
        Assert.Contains("1 张水单没完成", await Refused(await SetStatus(admin, mid, "DISABLED", "搬走了"), HttpStatusCode.Conflict));
        Assert.Equal("ACTIVE", (await Profile(admin, mid)).GetProperty("status").GetString());
        await Ok(await admin.PostAsJsonAsync($"/api/orders/{order.GetProperty("id").GetGuid()}/cancel", new CancelWaterOrderRequest("会员不要了")));
        await Ok(await SetStatus(admin, mid, "DISABLED", "搬走了"));

        // The phone still belongs to the disabled member: staff are sent to enable them rather than create a second one.
        var taken = await Refused(await admin.PostAsJsonAsync("/api/members", new CreateMemberRequest("重名", phone, null, null, null)), HttpStatusCode.Conflict);
        Assert.Contains("已停用的会员", taken);
        Assert.Contains("重新启用", taken);
    }

    [Fact]
    public async Task Only_A_Member_Without_Records_Can_Be_Deleted()
    {
        using var admin = await Staff();
        using var clerk = await Staff("YG0012");
        var phone = Phone();
        var mistake = await Member(admin, phone);
        Assert.Equal(HttpStatusCode.Forbidden, (await clerk.DeleteAsync($"/api/members/{mistake}")).StatusCode);
        Assert.True((await Ok(await admin.DeleteAsync($"/api/members/{mistake}"))).GetProperty("deleted").GetBoolean());
        Assert.Equal(HttpStatusCode.NotFound, (await admin.GetAsync($"/api/members/{mistake}/profile")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await admin.DeleteAsync($"/api/members/{mistake}")).StatusCode);
        // Its address went with it and the phone is free again.
        await Member(admin, phone);

        var served = await Member(admin);
        await Ok(await Recharge(admin, served));
        Assert.Contains("1 笔充值", await Refused(await admin.DeleteAsync($"/api/members/{served}"), HttpStatusCode.Conflict));
        await Ok(await admin.GetAsync($"/api/members/{served}/profile"));
        // A member with records can only be disabled, and stays undeletable when disabled.
        await Ok(await SetStatus(admin, served, "DISABLED", "不再来了"));
        Assert.Equal(HttpStatusCode.Conflict, (await admin.DeleteAsync($"/api/members/{served}")).StatusCode);

        // Each change is logged with who made it and which member it was.
        await using var conn = host.OpenDatabase();
        await using var audit = new NpgsqlCommand("""
            SELECT action, actor_name, detail FROM plugin_kunlun_waterstation.auth_audit_logs
            WHERE action IN ('MEMBER_DELETE','MEMBER_DISABLE') AND (detail LIKE @deleted OR detail LIKE @disabled) ORDER BY id
            """, conn);
        audit.Parameters.AddWithValue("deleted", $"%{mistake}%");
        audit.Parameters.AddWithValue("disabled", $"%{served}%");
        var rows = new List<(string Action, string Actor, JsonElement Detail)>();
        await using (var r = await audit.ExecuteReaderAsync())
            while (await r.ReadAsync()) rows.Add((r.GetString(0), r.GetString(1), JsonSerializer.Deserialize<JsonElement>(r.GetString(2))));
        Assert.Equal(new[] { "MEMBER_DELETE", "MEMBER_DISABLE" }, rows.Select(x => x.Action).ToArray());
        Assert.All(rows, x => Assert.Equal("林站长", x.Actor));
        Assert.Equal(phone, rows[0].Detail.GetProperty("phone").GetString());
        Assert.Equal("不再来了", rows[1].Detail.GetProperty("reason").GetString());
    }

    [Fact]
    public async Task Administrators_From_Before_The_Permission_Get_It_On_Start_Without_Signing_In_Again()
    {
        using var c = await Staff();
        async Task<string[]> Permissions() =>
            (await c.GetFromJsonAsync<JsonElement>("/api/auth/me")).GetProperty("permissions").EnumerateArray().Select(p => p.GetString()!).ToArray();
        await using (var conn = host.OpenDatabase())
        await using (var strip = new NpgsqlCommand("UPDATE plugin_kunlun_waterstation.staff SET permissions=permissions - 'kunlun.waterstation:member:manage' WHERE staff_no='YG0001'", conn))
            Assert.Equal(1, await strip.ExecuteNonQueryAsync());
        Assert.DoesNotContain(KunlunPermissions.MemberManage, await Permissions());
        await MemberStatus.EnsureSchema(host.Services.GetRequiredService<NpgsqlDataSource>(), host.Services.GetRequiredService<KunlunAuthRepository>().DefaultTenantId);
        Assert.Contains(KunlunPermissions.MemberManage, await Permissions());
    }
}
