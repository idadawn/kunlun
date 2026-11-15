using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Kunlun.WaterStation.Auth;
using Kunlun.WaterStation.Operations;
using Xunit;
using static Kunlun.WaterStation.Auth.KunlunPermissions;

namespace Kunlun.WaterStation.Tests;

/// <summary>
/// 管理员按角色开通员工手机端功能：店员、送水员的权限跟着开通的功能走，已登录的员工下一次请求就生效；
/// 管理员的配置只改手机首页，后台权限不变。
/// </summary>
[Collection("KunlunIntegration")]
public sealed class MobileFeaturesTests(TestHost host)
{
    private async Task<HttpClient> Login(string account, string? password = null)
    {
        var c = host.CreateClient();
        var s = await Ok(await c.PostAsJsonAsync("/api/auth/staff/login", new StaffLoginRequest(account, password ?? TestHost.Password)));
        c.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", s.GetProperty("accessToken").GetString());
        return c;
    }
    private static async Task<JsonElement> Ok(HttpResponseMessage response)
    {
        var body = await response.Content.ReadAsStringAsync();
        Assert.True(response.IsSuccessStatusCode, $"{response.StatusCode}: {body}");
        return JsonSerializer.Deserialize<JsonElement>(body);
    }
    private static string[] Strings(JsonElement array) => array.EnumerateArray().Select(x => x.GetString()!).ToArray();
    private static async Task<JsonElement> Role(HttpClient admin, string role) =>
        (await Ok(await admin.GetAsync("/api/mobile/roles"))).GetProperty("roles").EnumerateArray().Single(r => r.GetProperty("role").GetString() == role);
    private static Task<HttpResponseMessage> Save(HttpClient admin, string role, params string[] features) =>
        admin.PutAsJsonAsync($"/api/mobile/roles/{role}", new SaveRoleMobileRequest(features));

    [Fact]
    public async Task Default_Features_Keep_The_Original_Clerk_Permissions_And_Reach_The_Phone()
    {
        using var admin = await Login("YG0001");
        var overview = await Ok(await admin.GetAsync("/api/mobile/roles"));
        Assert.Equal(MobileFeatures.Catalog.Select(f => f.Key), overview.GetProperty("catalog").EnumerateArray().Select(f => f.GetProperty("key").GetString()));
        var roles = overview.GetProperty("roles").EnumerateArray().ToDictionary(r => r.GetProperty("role").GetString()!);
        Assert.Equal(["CLERK", "COURIER", "ADMIN"], roles.Keys);
        Assert.Equal(ClerkDefault.Order(), Strings(roles["CLERK"].GetProperty("permissions")).Order());
        Assert.Equal(AdminAll, Strings(roles["ADMIN"].GetProperty("permissions")));
        // Couriers keep what they could do before: order fulfilment already let them verify pickups and register containers.
        Assert.Equal(CourierDefault.Append(PickupVerify).Append(ContainerRegister).Order(), Strings(roles["COURIER"].GetProperty("permissions")).Order());
        Assert.True(roles["CLERK"].GetProperty("staffCount").GetInt64() >= 1);

        using var clerk = await Login("YG0012");
        var me = await clerk.GetFromJsonAsync<JsonElement>("/api/auth/me");
        Assert.Equal(Strings(roles["CLERK"].GetProperty("features")), Strings(me.GetProperty("mobileFeatures")));
        Assert.Equal(HttpStatusCode.Forbidden, (await clerk.GetAsync("/api/mobile/roles")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await Save(clerk, "CLERK", "inventory")).StatusCode);
    }

    [Fact]
    public async Task Courier_Features_Decide_What_A_Signed_In_Courier_May_Do_On_The_Next_Request()
    {
        using var admin = await Login("YG0001");
        using var courier = await Login("YG0008");
        var original = Strings((await Role(admin, "COURIER")).GetProperty("features"));
        try
        {
            Assert.Equal(HttpStatusCode.OK, (await courier.GetAsync("/api/members?page=1")).StatusCode);

            var saved = await Ok(await Save(admin, "courier", "pickup"));
            Assert.Equal(["pickup"], Strings(saved.GetProperty("features")));
            Assert.Equal([OrderFulfill, PickupVerify], Strings(saved.GetProperty("permissions")));
            Assert.Equal("林站长", saved.GetProperty("updatedBy").GetString());

            // The token issued before the change now carries only what the role holds.
            Assert.Equal(HttpStatusCode.Forbidden, (await courier.GetAsync("/api/members?page=1")).StatusCode);
            var me = await courier.GetFromJsonAsync<JsonElement>("/api/auth/me");
            Assert.Equal(["pickup"], Strings(me.GetProperty("mobileFeatures")));
            Assert.Equal([OrderFulfill, PickupVerify], Strings(me.GetProperty("permissions")));

            await Ok(await Save(admin, "COURIER", "members", "newMember"));
            Assert.Equal(HttpStatusCode.OK, (await courier.GetAsync("/api/members?page=1")).StatusCode);
            await Ok(await courier.PostAsJsonAsync("/api/members", new CreateMemberRequest("手机端开通验收", $"136{Random.Shared.Next(10000000, 99999999)}", "开通小区", null, "2-202")));

            // A courier account added now holds what the role's features grant.
            var username = "courier" + Guid.NewGuid().ToString("N")[..8];
            var password = Guid.NewGuid().ToString("N");
            await Ok(await admin.PostAsJsonAsync("/api/staff", new CreateStaffRequest("新送水员", $"137{Random.Shared.Next(10000000, 99999999)}", username, password, "COURIER")));
            using var fresh = await Login(username, password);
            var freshMe = await fresh.GetFromJsonAsync<JsonElement>("/api/auth/me");
            Assert.Equal([MemberRead, MemberWrite], Strings(freshMe.GetProperty("permissions")));
            Assert.Equal(["members", "newMember"], Strings(freshMe.GetProperty("mobileFeatures")));
        }
        finally
        {
            await Ok(await Save(admin, "COURIER", original));
        }
        Assert.Equal(HttpStatusCode.OK, (await courier.GetAsync("/api/members?page=1")).StatusCode);
    }

    [Fact]
    public async Task Admin_Layout_Never_Changes_Admin_Permissions_And_Invalid_Features_Are_Refused()
    {
        using var admin = await Login("YG0001");
        var original = Strings((await Role(admin, "ADMIN")).GetProperty("features"));
        try
        {
            var saved = await Ok(await Save(admin, "ADMIN"));
            Assert.Empty(Strings(saved.GetProperty("features")));
            Assert.Equal(AdminAll, Strings(saved.GetProperty("permissions")));
            var me = await admin.GetFromJsonAsync<JsonElement>("/api/auth/me");
            Assert.Empty(Strings(me.GetProperty("mobileFeatures")));
            Assert.Contains(StaffManage, Strings(me.GetProperty("permissions")));
        }
        finally
        {
            await Ok(await Save(admin, "ADMIN", original));
        }
        Assert.Equal(HttpStatusCode.BadRequest, (await Save(admin, "CLERK", "teleport")).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await Save(admin, "CLERK", "members", "members")).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await Save(admin, "MEMBER", "members")).StatusCode);
        Assert.Equal(ClerkDefault.Order(), Strings((await Role(admin, "CLERK")).GetProperty("permissions")).Order());
    }
}
