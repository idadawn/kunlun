using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Kunlun.WaterStation.Auth;
using Kunlun.WaterStation.Operations;
using Xunit;

namespace Kunlun.WaterStation.Tests;

[Collection("KunlunIntegration")]
public sealed class OperationalTests(TestHost host)
{
    private async Task<HttpClient> Client()
    {
        var c=host.CreateClient();var login=await c.PostAsJsonAsync("/api/auth/staff/login",new StaffLoginRequest("YG0001",TestHost.Password));
        var auth=(await login.Content.ReadFromJsonAsync<AuthTokenResponse>())!;
        c.DefaultRequestHeaders.Authorization=new AuthenticationHeaderValue("Bearer",auth.AccessToken);return c;
    }
    private static async Task<JsonElement> Ok(HttpResponseMessage r)
    {
        var text=await r.Content.ReadAsStringAsync();Assert.True(r.IsSuccessStatusCode,text);return JsonSerializer.Deserialize<JsonElement>(text);
    }
    private static async Task<Guid> Member(HttpClient c)=> (await Ok(await c.PostAsJsonAsync("/api/members",new CreateMemberRequest("运营验收",$"131{Random.Shared.Next(10000000,99999999)}","测试地址",null, "1-101")))).GetProperty("id").GetGuid();
    [Fact]
    public async Task Overview_Uses_Real_Transactions_And_Seven_Shanghai_Dates()
    {
        using var c=await Client();var before=await c.GetFromJsonAsync<JsonElement>("/api/reports/overview");var m=await Member(c);
        await Ok(await c.PostAsJsonAsync("/api/recharges",new CreateRechargeOrderRequest(m,Guid.Parse("30000000-0000-0000-0000-000000000101"),"CASH",Guid.NewGuid().ToString())));
        var after=await c.GetFromJsonAsync<JsonElement>("/api/reports/overview");
        Assert.Equal(before.GetProperty("memberCount").GetInt64()+1,after.GetProperty("memberCount").GetInt64());
        Assert.Equal(7,after.GetProperty("trend").GetArrayLength());
        Assert.Equal(DateTime.UtcNow.AddHours(8).ToString("yyyy-MM-dd"),after.GetProperty("trend")[6].GetProperty("date").GetString());
        Assert.Equal(before.GetProperty("trend")[6].GetProperty("rechargeAmount").GetDecimal()+100,after.GetProperty("trend")[6].GetProperty("rechargeAmount").GetDecimal());
        using var guest=host.CreateClient();Assert.Equal(HttpStatusCode.Unauthorized,(await guest.GetAsync("/api/reports/overview")).StatusCode);
        var auth=(await (await guest.PostAsJsonAsync("/api/auth/member/login",new StaffLoginRequest("No.008621",TestHost.Password))).Content.ReadFromJsonAsync<AuthTokenResponse>())!;
        guest.DefaultRequestHeaders.Authorization=new AuthenticationHeaderValue("Bearer",auth.AccessToken);
        Assert.Equal(HttpStatusCode.Forbidden,(await guest.GetAsync("/api/reports/overview")).StatusCode);
    }
    [Fact]
    public async Task Container_Movement_Is_Atomic_Recorded_And_Idempotent()
    {
        using var c=await Client();var m=await Member(c);
        var collect=new CollectDepositRequest(m,"BUCKET",2,"CASH",Guid.NewGuid().ToString());
        await Ok(await c.PostAsJsonAsync("/api/deposits/collect",collect));await Ok(await c.PostAsJsonAsync("/api/deposits/collect",collect));
        var before=await c.GetFromJsonAsync<JsonElement>("/api/containers/summary");var bucket=before.EnumerateArray().Single(x=>x.GetProperty("containerType").GetString()=="BUCKET");
        var move=new RegisterContainerMovementRequest(m,"BUCKET",2,0,IdempotencyKey:Guid.NewGuid().ToString());
        var results=await Task.WhenAll(Enumerable.Range(0,3).Select(_=>c.PostAsJsonAsync("/api/containers/movements",move)));
        foreach(var response in results)Assert.Equal(2,(await Ok(response)).GetProperty("currentHeld").GetInt32());
        var moved=(await c.GetFromJsonAsync<JsonElement>("/api/containers/summary")).EnumerateArray().Single(x=>x.GetProperty("containerType").GetString()=="BUCKET");
        Assert.Equal(bucket.GetProperty("inStationQty").GetInt32()-2,moved.GetProperty("inStationQty").GetInt32());Assert.True(moved.GetProperty("identityValid").GetBoolean());
        Assert.Equal(HttpStatusCode.BadRequest,(await c.PostAsJsonAsync("/api/containers/movements",new RegisterContainerMovementRequest(m,"BUCKET",0,3))).StatusCode);
        await Ok(await c.PostAsJsonAsync("/api/containers/movements",new RegisterContainerMovementRequest(m,"BUCKET",0,2,IdempotencyKey:Guid.NewGuid().ToString())));
        var ledger=await c.GetFromJsonAsync<JsonElement>("/api/ledgers/containers");Assert.Equal(2,ledger.EnumerateArray().Count(x=>x.GetProperty("memberName").GetString()=="运营验收"));
        Assert.Equal(HttpStatusCode.OK,(await c.GetAsync("/api/exports/container-ledgers")).StatusCode);
        var refund=new RefundDepositRequest(m,"BUCKET",2,Guid.NewGuid().ToString());
        await Ok(await c.PostAsJsonAsync("/api/deposits/refund",refund));await Ok(await c.PostAsJsonAsync("/api/deposits/refund",refund));
        var profile=await c.GetFromJsonAsync<JsonElement>($"/api/members/{m}/profile");Assert.Equal(0,profile.GetProperty("depositAmount").GetDecimal());Assert.Equal(0,profile.GetProperty("heldBuckets").GetInt32());
    }
}
