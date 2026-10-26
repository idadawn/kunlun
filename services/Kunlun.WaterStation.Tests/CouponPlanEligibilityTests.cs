using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Kunlun.WaterStation.Auth;
using Kunlun.WaterStation.Operations;
using Xunit;
namespace Kunlun.WaterStation.Tests;
[Collection("KunlunIntegration")]
public sealed class CouponPlanEligibilityTests(TestHost host)
{
    [Fact]
    public async Task Coupon_Cannot_Use_Disabled_Plan_But_Historical_Coupon_Can_Be_Disabled()
    {
        using var c=host.CreateClient();
        var auth=(await (await c.PostAsJsonAsync("/api/auth/staff/login",new StaffLoginRequest("YG0001",TestHost.Password))).Content.ReadFromJsonAsync<AuthTokenResponse>())!;
        c.DefaultRequestHeaders.Authorization=new AuthenticationHeaderValue("Bearer",auth.AccessToken);
        var plan=new SaveRechargePlanRequest("券套餐校验-"+Guid.NewGuid(),"BUCKET_18_9L","PICKUP",100,16,0,"DISABLED");
        var p=await c.PostAsJsonAsync("/api/plans",plan);p.EnsureSuccessStatusCode();var id=(await p.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        var coupon=new SaveCouponRequest("套餐状态验收",id,1,DateTimeOffset.UtcNow.AddMinutes(-1),DateTimeOffset.UtcNow.AddDays(7),1);
        Assert.Equal(HttpStatusCode.BadRequest,(await c.PostAsJsonAsync("/api/coupon-templates",coupon)).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest,(await c.PostAsJsonAsync("/api/coupon-templates",coupon with{Status="DISABLED"})).StatusCode);
        (await c.PutAsJsonAsync($"/api/plans/{id}",plan with{Status="ACTIVE"})).EnsureSuccessStatusCode();
        var created=await c.PostAsJsonAsync("/api/coupon-templates",coupon);created.EnsureSuccessStatusCode();var cid=(await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        (await c.PutAsJsonAsync($"/api/plans/{id}",plan)).EnsureSuccessStatusCode();
        Assert.Equal(HttpStatusCode.BadRequest,(await c.PutAsJsonAsync($"/api/coupon-templates/{cid}",coupon)).StatusCode);
        Assert.Equal(HttpStatusCode.OK,(await c.PutAsJsonAsync($"/api/coupon-templates/{cid}",coupon with{Status="DISABLED"})).StatusCode);
        var other=await c.PostAsJsonAsync("/api/plans",plan with{Name="另一个停用套餐-"+Guid.NewGuid()});other.EnsureSuccessStatusCode();var oid=(await other.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        Assert.Equal(HttpStatusCode.BadRequest,(await c.PutAsJsonAsync($"/api/coupon-templates/{cid}",coupon with{PlanId=oid,Status="DISABLED"})).StatusCode);
    }
}
