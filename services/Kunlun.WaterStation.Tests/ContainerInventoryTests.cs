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
    private static void Balanced(JsonElement s)=>Assert.Equal(Qty(s,"totalQty"),Qty(s,"inStationQty")+Qty(s,"withCustomersQty")+Qty(s,"damagedQty"));
    private static async Task<JsonElement> Update(HttpClient c,UpdateStockRequest req)=>await Ok(await c.PostAsJsonAsync("/api/containers/stock",req));
    private static Task<JsonElement> Move(HttpClient c,Guid m,int take,int back)=>c.PostAsJsonAsync("/api/containers/movements",new RegisterContainerMovementRequest(m,"BUCKET",take,back,IdempotencyKey:Key())).ContinueWith(t=>Ok(t.Result)).Unwrap();

    [Fact]
    public async Task Stock_Only_Receives_And_Scraps_And_Preserves_The_Equation()
    {
        using var c=await Client();var before=await Summary(c,"BAG");
        var received=await Apply(c,new("BAG","RECEIVE","购入新袋",Key(),6));Balanced(received.GetProperty("after"));
        var scrap=await Apply(c,new("BAG","SCRAP","门店报废",Key(),2));var after=scrap.GetProperty("after");
        Assert.Equal(Qty(before,"totalQty")+4,Qty(after,"totalQty"));Assert.Equal(Qty(before,"inStationQty")+4,Qty(after,"inStationQty"));
        Assert.Equal(Qty(before,"scrappedQty")+2,Qty(after,"scrappedQty"));Balanced(after);Balanced(await Summary(c,"BAG"));
        Assert.Equal(["containerType","unitDeposit","totalQty","inStationQty","withCustomersQty","memberHeldQty","damagedQty","scrappedQty","warnThreshold","countedAt","identityValid","lowStockWarning"],before.EnumerateObject().Select(p=>p.Name));
        foreach(var action in new[]{"DAMAGE","REPAIR","COUNT","ADJUST"})
            Assert.Equal(HttpStatusCode.BadRequest,(await c.PostAsJsonAsync("/api/containers/inventory",new InventoryRequest("BAG",action,"旧库存维护不可再提交",Key(),1))).StatusCode);
        var csv=await c.GetStringAsync("/api/exports/inventory-operations");Assert.Contains(",新购,",csv);Assert.Contains(",报废,",csv);
    }

    [Fact]
    public async Task Any_Count_Can_Be_Set_At_Any_Time_And_Daily_Moves_Never_Block()
    {
        using var c=await Client();var m=await Member(c);
        await Ok(await c.PostAsJsonAsync("/api/deposits/collect",new CollectDepositRequest(m,"BUCKET",3,"CASH",Key())));
        var start=await Summary(c,"BUCKET");await Move(c,m,2,0);
        var s=await Summary(c,"BUCKET");
        Assert.Equal(Qty(start,"inStationQty")-2,Qty(s,"inStationQty"));Assert.Equal(Qty(start,"withCustomersQty")+2,Qty(s,"withCustomersQty"));
        Assert.Equal(Qty(start,"memberHeldQty")+2,Qty(s,"memberHeldQty"));Balanced(s);
        var registered=Qty(s,"memberHeldQty");var scrapped=Qty(s,"scrappedQty");
        try
        {
            // 店里 50、客户手里比会员名下多 30 个、报废多记 3 个，同时把提醒线改成 20。
            var req=new UpdateStockRequest("BUCKET",Key(),50,registered+30,scrapped+3,20,"  月底核对  ");
            var saved=await Update(c,req);
            Assert.Equal("ADJUST",saved.GetProperty("action").GetString());Assert.Equal("月底核对",saved.GetProperty("reason").GetString());
            Assert.Equal(20,saved.GetProperty("warnThreshold").GetProperty("after").GetInt32());Balanced(saved.GetProperty("after"));
            s=await Summary(c,"BUCKET");
            Assert.Equal(50,Qty(s,"inStationQty"));Assert.Equal(registered+30,Qty(s,"withCustomersQty"));Assert.Equal(registered,Qty(s,"memberHeldQty"));
            Assert.Equal(scrapped+3,Qty(s,"scrappedQty"));Assert.Equal(50+registered+30+Qty(s,"damagedQty"),Qty(s,"totalQty"));
            Assert.Equal(20,Qty(s,"warnThreshold"));Assert.False(s.GetProperty("lowStockWarning").GetBoolean());
            Assert.Equal(JsonValueKind.String,s.GetProperty("countedAt").ValueKind);Balanced(s);
            Assert.Equal(saved.GetProperty("id").GetGuid(),(await Update(c,req with{Note="月底核对"})).GetProperty("id").GetGuid());
            Assert.Equal(HttpStatusCode.Conflict,(await c.PostAsJsonAsync("/api/containers/stock",req with{ScrappedQty=scrapped+4})).StatusCode);

            // 只填一个数时其他的不动；客户手里可以比会员名下少。
            var only=await Update(c,new("BUCKET",Key(),ScrappedQty:scrapped+5));
            Assert.Equal(JsonValueKind.Null,only.GetProperty("warnThreshold").ValueKind);Assert.Equal("修改数量",only.GetProperty("reason").GetString());
            await Update(c,new("BUCKET",Key(),WithCustomersQty:registered-1));
            s=await Summary(c,"BUCKET");
            Assert.Equal(50,Qty(s,"inStationQty"));Assert.Equal(registered-1,Qty(s,"withCustomersQty"));Assert.Equal(scrapped+5,Qty(s,"scrappedQty"));Balanced(s);

            // 店里记成 0 也照样交得出桶：店里停在 0，客户手里和会员名下照加，提醒店里偏少。
            await Update(c,new("BUCKET",Key(),InStationQty:0));
            await Move(c,m,1,0);
            s=await Summary(c,"BUCKET");
            Assert.Equal(0,Qty(s,"inStationQty"));Assert.Equal(registered,Qty(s,"withCustomersQty"));Assert.Equal(registered+1,Qty(s,"memberHeldQty"));
            Assert.True(s.GetProperty("lowStockWarning").GetBoolean());Balanced(s);
            // 客户手里记成 0 时还桶：店里加回来，客户手里停在 0。
            await Update(c,new("BUCKET",Key(),WithCustomersQty:0));
            await Move(c,m,0,1);
            s=await Summary(c,"BUCKET");
            Assert.Equal(1,Qty(s,"inStationQty"));Assert.Equal(0,Qty(s,"withCustomersQty"));Assert.Equal(registered,Qty(s,"memberHeldQty"));Balanced(s);
            // 提醒线 0 表示不提醒。
            await Update(c,new("BUCKET",Key(),WarnThreshold:0));Assert.False((await Summary(c,"BUCKET")).GetProperty("lowStockWarning").GetBoolean());

            var history=await c.GetFromJsonAsync<JsonElement>("/api/containers/inventory-operations?containerType=BUCKET");
            Assert.Contains(history.EnumerateArray(),x=>x.GetProperty("operation").GetProperty("action").GetString()=="ADJUST");
            Assert.Contains(",修改数量,",await c.GetStringAsync("/api/exports/inventory-operations"));
            foreach(var bad in new[]{new UpdateStockRequest("BUCKET",Key(),-1),new UpdateStockRequest("BUCKET",Key(),ScrappedQty:-2),new UpdateStockRequest("BUCKET",Key(),WarnThreshold:1000001),
                new UpdateStockRequest("BUCKET",Key()),new UpdateStockRequest("BUCKET",Key(),1,Note:new string('备',501)),new UpdateStockRequest("CUP",Key(),1)})
                Assert.Equal(HttpStatusCode.BadRequest,(await c.PostAsJsonAsync("/api/containers/stock",bad)).StatusCode);
            using var clerk=await Client("YG0012");
            Assert.Equal(HttpStatusCode.Forbidden,(await clerk.PostAsJsonAsync("/api/containers/stock",new UpdateStockRequest("BUCKET",Key(),1))).StatusCode);
        }
        finally
        {
            // Later tests hand out buckets from a known, well-stocked store.
            await Update(c,new("BUCKET",Key(),500,Qty(await Summary(c,"BUCKET"),"memberHeldQty"),WarnThreshold:100));
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
    public async Task Fulfillment_From_An_Empty_Store_Still_Hands_Over()
    {
        using var c=await Client();var m=await Member(c);var before=await Summary(c,"BUCKET");
        try
        {
            await Ok(await c.PostAsJsonAsync("/api/recharges",new CreateRechargeOrderRequest(m,WaterProducts.PlanId("101"),"CASH",Key())));
            await Ok(await c.PostAsJsonAsync("/api/deposits/collect",new CollectDepositRequest(m,"BUCKET",1,"CASH",Key())));
            var order=await Ok(await c.PostAsJsonAsync("/api/orders",new CreateWaterOrderRequest(m,"BUCKET_18_9L","PICKUP",1,Key())));
            await Apply(c,new("BUCKET","SCRAP","店里记成零验收",Key(),Qty(before,"inStationQty")));
            var done=await Ok(await c.PostAsJsonAsync($"/api/orders/{order.GetProperty("id").GetGuid()}/fulfill",new FulfillWaterOrderRequest(1,1,0,order.GetProperty("pickupCode").GetString())));
            Assert.Equal(1,done.GetProperty("heldAfter").GetInt32());
            var s=await Summary(c,"BUCKET");
            Assert.Equal(0,Qty(s,"inStationQty"));Assert.Equal(Qty(before,"withCustomersQty")+1,Qty(s,"withCustomersQty"));Assert.Equal(Qty(before,"memberHeldQty")+1,Qty(s,"memberHeldQty"));
            Assert.True(s.GetProperty("lowStockWarning").GetBoolean());Balanced(s);
            var p=await c.GetFromJsonAsync<JsonElement>($"/api/members/{m}/profile");Assert.Equal(1,Qty(p,"heldBuckets"));Assert.Equal(15,p.Tickets("BUCKET_18_9L", "PICKUP"));Assert.Equal(0,p.Tickets("BUCKET_18_9L", "PICKUP", reserved: true));
        }
        finally
        {
            await Apply(c,new("BUCKET","RECEIVE","补充验收库存",Key(),Qty(before,"inStationQty")));
        }
    }
}
