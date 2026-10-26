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

[Collection("KunlunIntegration")]
public sealed class PostedPriceListTests(TestHost host)
{
    private async Task<HttpClient> Client()
    {
        var c=host.CreateClient();var auth=(await (await c.PostAsJsonAsync("/api/auth/staff/login",new StaffLoginRequest("YG0001",TestHost.Password))).Content.ReadFromJsonAsync<AuthTokenResponse>())!;
        c.DefaultRequestHeaders.Authorization=new AuthenticationHeaderValue("Bearer",auth.AccessToken);return c;
    }
    private static async Task<JsonElement> Ok(HttpResponseMessage r)
    {var body=await r.Content.ReadAsStringAsync();Assert.True(r.IsSuccessStatusCode,$"{r.StatusCode}: {body}");return JsonSerializer.Deserialize<JsonElement>(body);}
    private static async Task<Guid> Member(HttpClient c)=>(await Ok(await c.PostAsJsonAsync("/api/members",new CreateMemberRequest("价目验收",$"130{Random.Shared.Next(10000000,99999999)}","验收地址",null)))).GetProperty("id").GetGuid();

    [Fact]
    public async Task All_Eight_Packages_Match_The_Posted_Price_List()
    {
        using var c=await Client();var plans=await c.GetFromJsonAsync<JsonElement>("/api/plans");
        var expected=new[]{("101","BUCKET_18_9L","PICKUP",100m,16),("102","BUCKET_18_9L","PICKUP",499m,95),("103","BUCKET_18_9L","DELIVERY",100m,13),("104","BUCKET_18_9L","DELIVERY",499m,70),("105","BAG_7_5L","PICKUP",100m,50),("106","BAG_7_5L","PICKUP",499m,300),("107","BAG_7_5L","DELIVERY",100m,40),("108","BAG_7_5L","DELIVERY",499m,220)};
        foreach(var (suffix,type,mode,price,qty) in expected)
        {
            var p=plans.EnumerateArray().Single(p=>p.GetProperty("id").GetGuid()==WaterProducts.PlanId(suffix));
            Assert.Equal(type,p.GetProperty("waterType").GetString());Assert.Equal(mode,p.GetProperty("fulfillMode").GetString());Assert.Equal(price,p.GetProperty("price").GetDecimal());Assert.Equal(qty,p.GetProperty("buyQty").GetInt32());Assert.Equal(0,p.GetProperty("giftQty").GetInt32());
        }
        var products=await c.GetFromJsonAsync<JsonElement>("/api/products");
        var bag=products.EnumerateArray().Single(x=>x.GetProperty("waterType").GetString()=="BAG_7_5L");
        Assert.Equal(5,bag.GetProperty("capacityLiters").GetDecimal());Assert.Equal(5,bag.GetProperty("retailPrice").GetDecimal());Assert.Equal(5,bag.GetProperty("deliveryMinimum").GetInt32());Assert.Equal(0,bag.GetProperty("deliveryFee").GetDecimal());
        var bucket=products.EnumerateArray().Single(x=>x.GetProperty("waterType").GetString()=="BUCKET_18_9L");
        Assert.Equal(15,bucket.GetProperty("capacityLiters").GetDecimal());Assert.Equal(JsonValueKind.Null,bucket.GetProperty("retailPrice").ValueKind);Assert.Equal(1,bucket.GetProperty("deliveryMinimum").GetInt32());
    }

    [Fact]
    public async Task Delivery_Minimum_Is_Enforced_Without_Changing_Pickup()
    {
        using var c=await Client();var m=await Member(c);
        var charge=await Ok(await c.PostAsJsonAsync("/api/recharges",new CreateRechargeOrderRequest(m,WaterProducts.PlanId("107"),"CASH",Guid.NewGuid().ToString())));
        Assert.Equal(40,charge.GetProperty("buyQty").GetInt32());Assert.Equal("5L 袋装水",charge.GetProperty("planSnapshot").GetProperty("waterLabel").GetString());
        var denied=await c.PostAsJsonAsync("/api/orders",new CreateWaterOrderRequest(m,"BAG_7_5L","DELIVERY",4,Guid.NewGuid().ToString()));
        Assert.Equal(HttpStatusCode.BadRequest,denied.StatusCode);
        Assert.Contains("5袋起送",await denied.Content.ReadAsStringAsync());
        var profile=await c.GetFromJsonAsync<JsonElement>($"/api/members/{m}/profile");Assert.Equal(40,profile.GetProperty("bagDeliveryTickets").GetInt32());Assert.Equal(0,profile.GetProperty("reservedBagDeliveryTickets").GetInt32());
        var req=new CreateWaterOrderRequest(m,"BAG_7_5L","DELIVERY",5,Guid.NewGuid().ToString());
        var order=await Ok(await c.PostAsJsonAsync("/api/orders",req));await Ok(await c.PostAsJsonAsync("/api/orders",req));
        await Ok(await c.PostAsJsonAsync($"/api/orders/{order.GetProperty("id")}/cancel",new CancelWaterOrderRequest("验收取消")));
        await Ok(await c.PostAsJsonAsync("/api/recharges",new CreateRechargeOrderRequest(m,WaterProducts.PlanId("105"),"CASH",Guid.NewGuid().ToString())));
        await Ok(await c.PostAsJsonAsync("/api/orders",new CreateWaterOrderRequest(m,"BAG_7_5L","PICKUP",1,Guid.NewGuid().ToString())));
        await Ok(await c.PostAsJsonAsync("/api/recharges",new CreateRechargeOrderRequest(m,WaterProducts.PlanId("103"),"CASH",Guid.NewGuid().ToString())));
        await Ok(await c.PostAsJsonAsync("/api/orders",new CreateWaterOrderRequest(m,"BUCKET_18_9L","DELIVERY",1,Guid.NewGuid().ToString())));
    }

    [Fact]
    public async Task Price_Migration_Preserves_Original_500_Refund_And_Later_Edits()
    {
        using var c=await Client();var m=await Member(c);var id=WaterProducts.PlanId("102");
        var current=new SaveRechargePlanRequest("15L 桶装水 · 自提 499 元 / 95 桶","BUCKET_18_9L","PICKUP",499,95,0);
        try
        {
            await Ok(await c.PutAsJsonAsync($"/api/plans/{id}",current with{Name="旧500档验收",Price=500}));
            var charge=await Ok(await c.PostAsJsonAsync("/api/recharges",new CreateRechargeOrderRequest(m,id,"CASH",Guid.NewGuid().ToString())));
            var db=host.Services.GetRequiredService<NpgsqlDataSource>();var repo=host.Services.GetRequiredService<KunlunFinanceRepository>();
            await using(var conn=await db.OpenConnectionAsync())
                await TicketBatches.Exec(conn,null,"DELETE FROM plugin_kunlun_waterstation.finance_migrations WHERE tenant_id=@tid AND name='posted-price-list-20261026-v1'",default,("tid",repo.TenantId));
            await repo.EnsureFinanceSchemaAndSeedAsync();
            var updated=(await c.GetFromJsonAsync<JsonElement>("/api/plans")).EnumerateArray().Single(x=>x.GetProperty("id").GetGuid()==id);
            Assert.Equal(499,updated.GetProperty("price").GetDecimal());
            var refund=await Ok(await c.PostAsJsonAsync($"/api/ticket-batches/{charge.GetProperty("id")}/refund",new RefundRechargeRequest(Guid.NewGuid().ToString(),"CASH","旧单按原价退")));
            Assert.Equal(500,refund.GetProperty("refundAmount").GetDecimal());
            await Ok(await c.PutAsJsonAsync($"/api/plans/{id}",current with{Price=501}));await repo.EnsureFinanceSchemaAndSeedAsync();
            var retained=(await c.GetFromJsonAsync<JsonElement>("/api/plans")).EnumerateArray().Single(x=>x.GetProperty("id").GetGuid()==id);
            Assert.Equal(501,retained.GetProperty("price").GetDecimal());
        }
        finally {await c.PutAsJsonAsync($"/api/plans/{id}",current);}
    }
}
