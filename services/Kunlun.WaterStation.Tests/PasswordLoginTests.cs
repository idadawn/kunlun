using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Kunlun.WaterStation.Auth;
using Xunit;

namespace Kunlun.WaterStation.Tests;

[Collection("KunlunIntegration")]
public sealed class PasswordLoginTests(TestHost host)
{
    [Fact]
    public async Task Incorrect_Empty_Password_And_Phone_Bypass_Are_Rejected()
    {
        using var client = host.CreateClient();
        foreach (var input in new[] { new StaffLoginRequest("YG0001", "wrong"), new StaffLoginRequest("", ""), new StaffLoginRequest(null!, null!) })
            Assert.Equal(HttpStatusCode.Unauthorized, (await client.PostAsJsonAsync("/api/auth/staff/login", input)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.PostAsJsonAsync("/api/auth/wechat/phone-login", new { phone = "13800138000" })).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.PostAsJsonAsync("/api/auth/staff/login", new StaffLoginRequest("YG0012", TestHost.Password, true))).StatusCode);
    }

    [Fact]
    public async Task Account_Provisioning_ChangePassword_Logout_And_DataIsolation()
    {
        using var admin = host.CreateClient();
        var login = await admin.PostAsJsonAsync("/api/auth/staff/login", new StaffLoginRequest("YG0001", TestHost.Password));
        var session = (await login.Content.ReadFromJsonAsync<AuthTokenResponse>())!;
        admin.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", session.AccessToken);
        var member = await admin.PostAsJsonAsync("/api/members", new { name = "登录验收", phone = $"135{Random.Shared.Next(10000000, 99999999)}" });
        var id = (await member.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        var username = "member_" + Guid.NewGuid().ToString("N")[..12];
        var password = Guid.NewGuid().ToString("N");
        Assert.Equal(HttpStatusCode.OK, (await admin.PutAsJsonAsync($"/api/accounts/MEMBER/{id}/credentials", new AccountCredentialsRequest(username, password))).StatusCode);
        using var client = host.CreateClient();
        var response = await client.PostAsJsonAsync("/api/auth/member/login", new StaffLoginRequest(username.ToUpperInvariant(), password));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var auth = (await response.Content.ReadFromJsonAsync<AuthTokenResponse>())!;
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", auth.AccessToken);
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync($"/api/members/{id}/profile")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync("/api/ledgers/recharges")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync("/api/members/20000000-0000-0000-0000-000000008621/profile")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.PutAsJsonAsync($"/api/accounts/MEMBER/{id}/credentials", new AccountCredentialsRequest(username, password))).StatusCode);
        var newPassword = Guid.NewGuid().ToString("N");
        Assert.Equal(HttpStatusCode.OK, (await client.PostAsJsonAsync("/api/auth/change-password", new ChangePasswordRequest(password, newPassword))).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/api/auth/me")).StatusCode);
        client.DefaultRequestHeaders.Authorization = null;
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.PostAsJsonAsync("/api/auth/member/login", new StaffLoginRequest(username, password))).StatusCode);
        auth = (await (await client.PostAsJsonAsync("/api/auth/member/login", new StaffLoginRequest(username, newPassword))).Content.ReadFromJsonAsync<AuthTokenResponse>())!;
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", auth.AccessToken);
        Assert.Equal(HttpStatusCode.OK, (await client.PostAsJsonAsync("/api/auth/logout", new { })).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/api/auth/me")).StatusCode);
    }
    [Fact]
    public async Task Admin_Can_Create_Staff_But_Clerk_Cannot_And_Last_Admin_Is_Protected()
    {
        using var client = host.CreateClient();
        var auth = (await (await client.PostAsJsonAsync("/api/auth/staff/login", new StaffLoginRequest("YG0001", TestHost.Password))).Content.ReadFromJsonAsync<AuthTokenResponse>())!;
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", auth.AccessToken);
        var username = "staff_" + Guid.NewGuid().ToString("N")[..12]; var password = Guid.NewGuid().ToString("N");
        var request = new CreateStaffRequest("测试员工", $"132{Random.Shared.Next(10000000, 99999999)}", username, password, "CLERK");
        Assert.Equal(HttpStatusCode.OK, (await client.PostAsJsonAsync("/api/staff", request)).StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, (await client.PostAsJsonAsync("/api/staff", request)).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.PatchAsJsonAsync($"/api/staff/{auth.SubjectId}/status", new UpdateStaffStatusRequest("DISABLED"))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.PatchAsJsonAsync($"/api/staff/{auth.SubjectId}/status", new UpdateStaffStatusRequest("invalid"))).StatusCode);
        var clerk = (await (await client.PostAsJsonAsync("/api/auth/staff/login", new StaffLoginRequest(username, password))).Content.ReadFromJsonAsync<AuthTokenResponse>())!;
        Assert.Equal("CLERK", clerk.Role);
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", clerk.AccessToken);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.PostAsJsonAsync("/api/staff", request)).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync("/api/staff")).StatusCode);
    }

}
