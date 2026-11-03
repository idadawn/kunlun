using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Kunlun.WaterStation.Auth;
using Kunlun.WaterStation.Operations;
using Xunit;

namespace Kunlun.WaterStation.Tests;

[Collection("KunlunIntegration")]
public sealed class ContainerInventoryTests(TestHost host)
{
    private static string Key()=>Guid.NewGuid().ToString();
    private async Task<HttpClient> Client(string username="YG0001")
    {
        var c=host.CreateClient();var a=(await (await c.PostAsJsonAsync("/api/auth/staff/login",new StaffLoginRequest(username,TestHost.Password))).Content.ReadFromJsonAsync<AuthTokenResponse>())!;
        c.DefaultRequestHeaders.Authorization=new AuthenticationHeaderValue("Bearer",a.AccessToken);return c;
    }
    private static async Task<JsonElement> Ok(HttpResponseMessage r){var body=await r.Content.ReadAsStringAsync();Assert.True(r.IsSuccessStatusCode,$"{r.StatusCode}: {body}");return JsonSerializer.Deserialize<JsonElement>(body);}
    private static async Task<JsonElement> Summary(HttpClient c,string type)=>(await c.GetFromJsonAsync<JsonElement>("/api/containers/summary")).EnumerateArray().Single(x=>x.GetProperty("containerType").GetString()==type);
    private static int Qty(JsonElement s,string field)=>s.GetProperty(field).GetInt32();
    private static async Task<JsonElement> Apply(HttpClient c,InventoryRequest req)=>await Ok(await c.PostAsJsonAsync("/api/containers/inventory",req));
    private static async Task<Guid> Member(HttpClient c)=>(await Ok(await c.PostAsJsonAsync("/api/members",new CreateMemberRequest("库存验收",$"129{Random.Shared.Next(10000000,99999999)}","库存测试地址",null, "1-101")))).GetProperty("id").GetGuid();
    private static void Balanced(JsonElement s)=>Assert.Equal(Qty(s,"totalQty"),Qty(s,"inStationQty")+Qty(s,"memberHeldQty")+Qty(s,"damagedQty")+(s.TryGetProperty("unregisteredOutQty",out var u)?u.GetInt32():0));
    private static async Task<JsonElement> Count(HttpClient c,StocktakeRequest req)=>await Ok(await c.PostAsJsonAsync("/api/containers/stocktake",req));

    [Fact]
    public async Task Stock_Only_Receives_And_Scraps_And_Preserves_The_Equation()
    {
        using var c=await Client();var before=await Summary(c,"BAG");
        var received=await Apply(c,new("BAG","RECEIVE","购入新袋",Key(),6));Balanced(received.GetProperty("after"));
        var scrap=await Apply(c,new("BAG","SCRAP","门店报废",Key(),2));var after=scrap.GetProperty("after");
        Assert.Equal(Qty(before,"totalQty")+4,Qty(after,"totalQty"));Assert.Equal(Qty(before,"inStationQty")+4,Qty(after,"inStationQty"));
        Assert.Equal(Qty(before,"scrappedQty")+2,Qty(after,"scrappedQty"));Balanced(after);Balanced(await Summary(c,"BAG"));
        Assert.Equal(["containerType","unitDeposit","totalQty","inStationQty","memberHeldQty","damagedQty","scrappedQty","warnThreshold","unregisteredOutQty","inStationUnknown","outUnknown","countedAt","identityValid","lowStockWarning"],before.EnumerateObject().Select(p=>p.Name));
        foreach(var action in new[]{"DAMAGE","REPAIR","COUNT"})
            Assert.Equal(HttpStatusCode.BadRequest,(await c.PostAsJsonAsync("/api/containers/inventory",new InventoryRequest("BAG",action,"旧库存维护不可再提交",Key(),1))).StatusCode);
        Assert.Equal(HttpStatusCode.OK,(await c.GetAsync("/api/exports/inventory-operations")).StatusCode);
    }

    [Fact]
    public async Task Stocktake_Resets_Counts_Keeps_Unknowns_Unblocking_And_Records_Unregistered()
    {
        using var c=await Client();var m=await Member(c);
        await Ok(await c.PostAsJsonAsync("/api/deposits/collect",new CollectDepositRequest(m,"BUCKET",3,"CASH",Key())));
        await Ok(await c.PostAsJsonAsync("/api/containers/movements",new RegisterContainerMovementRequest(m,"BUCKET",2,0,IdempotencyKey:Key())));
        var registered=Qty(await Summary(c,"BUCKET"),"memberHeldQty");var scrappedBefore=Qty(await Summary(c,"BUCKET"),"scrappedQty");
        try
        {
            // 店里能用 50、客户手里比会员名下多 30 个、店里坏了 3 个报废。
            var req=new StocktakeRequest("BUCKET",50,registered+30,3,Key(),"  月底盘点  ");
            var counted=await Count(c,req);var after=counted.GetProperty("after");
            Assert.Equal("COUNT",counted.GetProperty("action").GetString());Assert.Equal("月底盘点",counted.GetProperty("reason").GetString());
            Assert.Equal(registered,counted.GetProperty("counted").GetProperty("registeredHeldQty").GetInt32());
            var s=await Summary(c,"BUCKET");
            Assert.Equal(50,Qty(s,"inStationQty"));Assert.Equal(30,Qty(s,"unregisteredOutQty"));Assert.Equal(scrappedBefore+3,Qty(s,"scrappedQty"));
            Assert.Equal(50+registered+Qty(s,"damagedQty")+30,Qty(s,"totalQty"));Assert.True(s.GetProperty("identityValid").GetBoolean());
            Assert.False(s.GetProperty("inStationUnknown").GetBoolean());Assert.False(s.GetProperty("outUnknown").GetBoolean());
            Assert.Equal(JsonValueKind.String,s.GetProperty("countedAt").ValueKind);Balanced(after);
            Assert.Equal(counted.GetProperty("id").GetGuid(),(await Count(c,req with{Note="月底盘点"})).GetProperty("id").GetGuid());
            Assert.Equal(HttpStatusCode.Conflict,(await c.PostAsJsonAsync("/api/containers/stocktake",req with{ScrapQty=4})).StatusCode);

            // 店里一个不剩时交不出桶；店里说不清（待核实）时不拦截，店里的数停在 0。
            await Count(c,new("BUCKET",0,registered+30,0,Key()));
            Assert.Equal(HttpStatusCode.BadRequest,(await c.PostAsJsonAsync("/api/containers/movements",new RegisterContainerMovementRequest(m,"BUCKET",1,0,IdempotencyKey:Key()))).StatusCode);
            await Count(c,new("BUCKET",null,null,0,Key()));
            s=await Summary(c,"BUCKET");
            Assert.True(s.GetProperty("inStationUnknown").GetBoolean());Assert.True(s.GetProperty("outUnknown").GetBoolean());
            Assert.Equal(0,Qty(s,"unregisteredOutQty"));Assert.False(s.GetProperty("lowStockWarning").GetBoolean());
            await Ok(await c.PostAsJsonAsync("/api/containers/movements",new RegisterContainerMovementRequest(m,"BUCKET",1,0,IdempotencyKey:Key())));
            s=await Summary(c,"BUCKET");Assert.Equal(0,Qty(s,"inStationQty"));Assert.Equal(registered+1,Qty(s,"memberHeldQty"));Balanced(s);

            // 客户手里比会员名下登记的还少时照样记下，未登记为 0。
            await Count(c,new("BUCKET",20,registered-1,0,Key()));
            s=await Summary(c,"BUCKET");Assert.Equal(0,Qty(s,"unregisteredOutQty"));Assert.False(s.GetProperty("outUnknown").GetBoolean());Balanced(s);

            var history=await c.GetFromJsonAsync<JsonElement>("/api/containers/inventory-operations?containerType=BUCKET");
            Assert.Contains(history.EnumerateArray(),x=>x.GetProperty("operation").GetProperty("action").GetString()=="COUNT");
            Assert.Contains(",COUNT,",await c.GetStringAsync("/api/exports/inventory-operations"));
            foreach(var bad in new[]{new StocktakeRequest("BUCKET",-1,null,0,Key()),new StocktakeRequest("BUCKET",null,null,-2,Key()),new StocktakeRequest("CUP",1,1,0,Key())})
                Assert.Equal(HttpStatusCode.BadRequest,(await c.PostAsJsonAsync("/api/containers/stocktake",bad)).StatusCode);
            using var clerk=await Client("YG0012");
            Assert.Equal(HttpStatusCode.Forbidden,(await clerk.PostAsJsonAsync("/api/containers/stocktake",new StocktakeRequest("BUCKET",1,null,0,Key()))).StatusCode);
        }
        finally
        {
            // Later tests hand out buckets from a known, well-stocked store.
            await Count(c,new("BUCKET",500,null,0,Key()));await Count(c,new("BUCKET",500,Qty(await Summary(c,"BUCKET"),"memberHeldQty"),0,Key()));
        }
    }

    [Fact]
    public async Task Concurrent_Retries_Apply_Once_And_Changed_Payload_Is_Rejected()
    {
        using var c=await Client();var before=await Summary(c,"BUCKET");var req=new InventoryRequest("BUCKET","RECEIVE","同一入库重试",Key(),2);
        var responses=await Task.WhenAll(Enumerable.Range(0,6).Select(_=>c.PostAsJsonAsync("/api/containers/inventory",req)));
        var ids=new HashSet<Guid>();foreach(var response in responses)ids.Add((await Ok(response)).GetProperty("id").GetGuid());Assert.Single(ids);
        Assert.Equal(Qty(before,"totalQty")+2,Qty(await Summary(c,"BUCKET"),"totalQty"));
        Assert.Equal(HttpStatusCode.Conflict,(await c.PostAsJsonAsync("/api/containers/inventory",req with{Quantity=3})).StatusCode);
    }

    [Fact]
    public async Task Permissions_Negative_Amounts_And_Overdraw_Are_Rejected()
    {
        using var c=await Client();using var clerk=await Client("YG0012");var before=await Summary(c,"BAG");
        Assert.Equal(HttpStatusCode.Forbidden,(await clerk.PostAsJsonAsync("/api/containers/inventory",new InventoryRequest("BAG","RECEIVE","越权",Key(),1))).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden,(await clerk.GetAsync("/api/containers/inventory-operations")).StatusCode);
        foreach(var req in new[]{new InventoryRequest("BAG","RECEIVE","负数",Key(),-1),new InventoryRequest("BAG","DAMAGE","超额报损",Key(),Qty(before,"inStationQty")+1),new InventoryRequest("BAG","SCRAP","超额报废",Key(),Qty(before,"inStationQty")+1)})
            Assert.Equal(HttpStatusCode.BadRequest,(await c.PostAsJsonAsync("/api/containers/inventory",req)).StatusCode);
        Assert.Equal(before.ToString(),(await Summary(c,"BAG")).ToString());
    }

    [Fact]
    public async Task New_Bag_Deposit_Is_Five_And_Old_Receipts_Refund_At_Original_Price()
    {
        using var c=await Client();var m=await Member(c);Assert.Equal(5m,(await Summary(c,"BAG")).GetProperty("unitDeposit").GetDecimal());
        try
        {
            (await c.PutAsync("/api/containers/BAG/unit-deposit?newUnitDeposit=30",null)).EnsureSuccessStatusCode();
            await Ok(await c.PostAsJsonAsync("/api/deposits/collect",new CollectDepositRequest(m,"BAG",1,"CASH",Key())));
            (await c.PutAsync("/api/containers/BAG/unit-deposit?newUnitDeposit=5",null)).EnsureSuccessStatusCode();
            var newReceipt=await Ok(await c.PostAsJsonAsync("/api/deposits/collect",new CollectDepositRequest(m,"BAG",2,"CASH",Key())));Assert.Equal(10m,newReceipt.GetProperty("totalAmount").GetDecimal());
            var oldRefund=await Ok(await c.PostAsJsonAsync("/api/deposits/refund",new RefundDepositRequest(m,"BAG",1,Key())));Assert.Equal(30m,oldRefund.GetProperty("refundAmount").GetDecimal());
            var newRefund=await Ok(await c.PostAsJsonAsync("/api/deposits/refund",new RefundDepositRequest(m,"BAG",2,Key())));Assert.Equal(10m,newRefund.GetProperty("refundAmount").GetDecimal());
        }
        finally {await c.PutAsync("/api/containers/BAG/unit-deposit?newUnitDeposit=5",null);}
    }

    [Fact]
    public async Task Fulfillment_With_No_Containers_Rolls_Back_Tickets_And_Holdings()
    {
        using var c=await Client();var m=await Member(c);var before=await Summary(c,"BUCKET");Guid? orderId=null;
        try
        {
            await Ok(await c.PostAsJsonAsync("/api/recharges",new CreateRechargeOrderRequest(m,WaterProducts.PlanId("101"),"CASH",Key())));
            await Ok(await c.PostAsJsonAsync("/api/deposits/collect",new CollectDepositRequest(m,"BUCKET",1,"CASH",Key())));
            var order=await Ok(await c.PostAsJsonAsync("/api/orders",new CreateWaterOrderRequest(m,"BUCKET_18_9L","PICKUP",1,Key())));orderId=order.GetProperty("id").GetGuid();
            await Apply(c,new("BUCKET","SCRAP","可用库存为零验收",Key(),Qty(before,"inStationQty")));
            Assert.Equal(HttpStatusCode.BadRequest,(await c.PostAsJsonAsync($"/api/orders/{orderId}/fulfill",new FulfillWaterOrderRequest(1,1,0,order.GetProperty("pickupCode").GetString()))).StatusCode);
            var p=await c.GetFromJsonAsync<JsonElement>($"/api/members/{m}/profile");Assert.Equal(0,Qty(p,"heldBuckets"));Assert.Equal(15,p.Tickets("BUCKET_18_9L", "PICKUP"));Assert.Equal(1,p.Tickets("BUCKET_18_9L", "PICKUP", reserved: true));
        }
        finally
        {
            await Apply(c,new("BUCKET","RECEIVE","补充验收库存",Key(),Qty(before,"inStationQty")));
            if(orderId.HasValue)await c.PostAsJsonAsync($"/api/orders/{orderId}/cancel",new CancelWaterOrderRequest("验收结束"));
        }
    }
}
