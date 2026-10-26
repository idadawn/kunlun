using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using Kunlun.WaterStation.Auth;
using Microsoft.AspNetCore.Mvc.Testing;
using Xunit;

namespace Kunlun.WaterStation.Tests;

[CollectionDefinition("KunlunIntegration")]
public sealed class KunlunIntegrationCollection : ICollectionFixture<TestHost>;

[Collection("KunlunIntegration")]
public sealed class AuthIntegrationTests(TestHost factory)
{
    private readonly HttpClient _client = factory.CreateClient();

    [Fact]
    public async Task Staff_Password_Login_And_Me_Should_Succeed()
    {
        var resp = await _client.PostAsJsonAsync("/api/auth/staff/login", new StaffLoginRequest("YG0001", TestHost.Password));
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);

        var tokenData = await resp.Content.ReadFromJsonAsync<AuthTokenResponse>();
        Assert.NotNull(tokenData);
        Assert.Equal("STAFF", tokenData.SubjectType);
        Assert.Equal("ADMIN", tokenData.Role);
        Assert.Contains(KunlunPermissions.StaffManage, tokenData.Permissions);

        using var req = new HttpRequestMessage(HttpMethod.Get, "/api/auth/me");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", tokenData.AccessToken);
        var meResp = await _client.SendAsync(req);
        Assert.Equal(HttpStatusCode.OK, meResp.StatusCode);
    }

    [Fact]
    public async Task Member_Password_Login_Should_Authenticate_Existing_Member_And_Enforce_AC15_Isolation()
    {
        // 陈静 13800138000 门店已建档 No.008621
        var resp = await _client.PostAsJsonAsync("/api/auth/member/login",
            new StaffLoginRequest("No.008621", TestHost.Password));
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);

        var chen = await resp.Content.ReadFromJsonAsync<AuthTokenResponse>();
        Assert.NotNull(chen);
        Assert.Equal("MEMBER", chen.SubjectType);
        Assert.Equal("No.008621", chen.CodeOrNo);
        Assert.False(chen.IsNewMember);

        // 1) 陈静查本人档案 -> 200 OK
        using var selfReq = new HttpRequestMessage(HttpMethod.Get, $"/api/members/{chen.SubjectId}/profile");
        selfReq.Headers.Authorization = new AuthenticationHeaderValue("Bearer", chen.AccessToken);
        var selfResp = await _client.SendAsync(selfReq);
        Assert.Equal(HttpStatusCode.OK, selfResp.StatusCode);

        // 2) AC-15: 陈静尝试访问周明 (20000000-0000-0000-0000-000000008620) 的档案 -> 403 Forbidden
        var zhouId = Guid.Parse("20000000-0000-0000-0000-000000008620");
        using var otherReq = new HttpRequestMessage(HttpMethod.Get, $"/api/members/{zhouId}/profile");
        otherReq.Headers.Authorization = new AuthenticationHeaderValue("Bearer", chen.AccessToken);
        var otherResp = await _client.SendAsync(otherReq);
        Assert.Equal(HttpStatusCode.Forbidden, otherResp.StatusCode);
    }

    [Fact]
    public async Task Courier_Without_StaffManage_Should_Be_Blocked_AC16_And_Disabled_Staff_Token_Revoked()
    {
        // 送水员王师傅 (13800000008) 微信手机号一键登录
        var courierResp = await _client.PostAsJsonAsync("/api/auth/staff/login",
            new StaffLoginRequest("YG0008", TestHost.Password));
        var courier = await courierResp.Content.ReadFromJsonAsync<AuthTokenResponse>();
        Assert.NotNull(courier);
        Assert.Equal("COURIER", courier.Role);

        // AC-16: 送水员尝试调用员工状态管理接口 -> 403 Forbidden
        using var forbiddenReq = new HttpRequestMessage(HttpMethod.Patch, $"/api/staff/{courier.SubjectId}/status")
        {
            Content = JsonContent.Create(new UpdateStaffStatusRequest("ACTIVE"))
        };
        forbiddenReq.Headers.Authorization = new AuthenticationHeaderValue("Bearer", courier.AccessToken);
        var forbiddenResp = await _client.SendAsync(forbiddenReq);
        Assert.Equal(HttpStatusCode.Forbidden, forbiddenResp.StatusCode);

        // 站长登录并停用王师傅账号 -> 王师傅原有 Token 立即失效 (401)
        var adminResp = await _client.PostAsJsonAsync("/api/auth/staff/login", new StaffLoginRequest("YG0001", TestHost.Password));
        var admin = await adminResp.Content.ReadFromJsonAsync<AuthTokenResponse>();
        Assert.NotNull(admin);

        try
        {
            using var disableReq = new HttpRequestMessage(HttpMethod.Patch, $"/api/staff/{courier.SubjectId}/status")
            {
                Content = JsonContent.Create(new UpdateStaffStatusRequest("DISABLED"))
            };
            disableReq.Headers.Authorization = new AuthenticationHeaderValue("Bearer", admin.AccessToken);
            var disableResp = await _client.SendAsync(disableReq);
            Assert.Equal(HttpStatusCode.OK, disableResp.StatusCode);

            // 王师傅原 Token 再次请求 /api/auth/me -> 立即 401
            using var revokedCheck = new HttpRequestMessage(HttpMethod.Get, "/api/auth/me");
            revokedCheck.Headers.Authorization = new AuthenticationHeaderValue("Bearer", courier.AccessToken);
            var revokedResp = await _client.SendAsync(revokedCheck);
            Assert.Equal(HttpStatusCode.Unauthorized, revokedResp.StatusCode);
        }
        finally
        {
            // 恢复王师傅为 ACTIVE，保持演示库状态干净
            using var restoreReq = new HttpRequestMessage(HttpMethod.Patch, $"/api/staff/{courier.SubjectId}/status")
            {
                Content = JsonContent.Create(new UpdateStaffStatusRequest("ACTIVE"))
            };
            restoreReq.Headers.Authorization = new AuthenticationHeaderValue("Bearer", admin.AccessToken);
            await _client.SendAsync(restoreReq);
        }
    }
}
