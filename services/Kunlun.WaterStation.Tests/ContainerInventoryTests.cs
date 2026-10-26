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
    private static void Balanced(JsonElement s)=>Assert.Equal(Qty(s,"totalQty"),Qty(s,"inStationQty")+Qty(s,"inTransitQty")+Qty(s,"memberHeldQty")+Qty(s,"inspectingQty")+Qty(s,"abnormalQty")+Qty(s,"damagedQty"));

    [Fact]
    public async Task Receive_Damage_Repair_Scrap_And_Count_Preserve_The_Inventory_Equation()
    {
        using var c=await Client();var before=await Summary(c,"BAG");
        var received=await Apply(c,new("BAG","RECEIVE","购入新袋",Key(),6));Balanced(received.GetProperty("after"));
        var damaged=await Apply(c,new("BAG","DAMAGE","发现破损",Key(),3));Assert.Equal(Qty(before,"totalQty")+6,Qty(damaged.GetProperty("after"),"totalQty"));
        await Apply(c,new("BAG","REPAIR","修复检验合格",Key(),1));
        var scrap=await Apply(c,new("BAG","SCRAP","不可修复报废",Key(),2));var after=scrap.GetProperty("after");
        Assert.Equal(Qty(before,"damagedQty"),Qty(after,"damagedQty"));Assert.Equal(Qty(before,"totalQty")+4,Qty(after,"totalQty"));Assert.Equal(Qty(before,"scrappedQty")+2,Qty(after,"scrappedQty"));Balanced(after);
        var count=await Apply(c,new("BAG","COUNT","盘盈核实",Key(),SourceState:"AVAILABLE",CountedQuantity:Qty(after,"inStationQty")+2,ExpectedQuantity:Qty(after,"inStationQty")));
        Assert.Equal(2,Qty(count,"quantity"));Assert.Equal(Qty(before,"totalQty")+6,Qty(count.GetProperty("after"),"totalQty"));Balanced(count.GetProperty("after"));
        Assert.True((await Summary(c,"BAG")).GetProperty("identityValid").GetBoolean());
        Assert.Equal(HttpStatusCode.OK,(await c.GetAsync("/api/exports/inventory-operations")).StatusCode);
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
        foreach(var req in new[]{new InventoryRequest("BAG","RECEIVE","负数",Key(),-1),new InventoryRequest("BAG","DAMAGE","超额报损",Key(),Qty(before,"inStationQty")+1),new InventoryRequest("BAG","SCRAP","超额报废",Key(),Qty(before,"damagedQty")+1),new InventoryRequest("BAG","COUNT","不能绕过会员流水",Key(),SourceState:"MEMBER",CountedQuantity:0,ExpectedQuantity:Qty(before,"memberHeldQty"))})
            Assert.Equal(HttpStatusCode.BadRequest,(await c.PostAsJsonAsync("/api/containers/inventory",req)).StatusCode);
        Assert.Equal(before.ToString(),(await Summary(c,"BAG")).ToString());
    }

    [Fact]
    public async Task Count_Detects_Stale_Stock_And_Can_Reconcile_Inspection_Stock()
    {
        using var c=await Client();var before=await Summary(c,"BUCKET");
        await Apply(c,new("BUCKET","RECEIVE","盘点期间新增入库",Key(),1));
        Assert.Equal(HttpStatusCode.Conflict,(await c.PostAsJsonAsync("/api/containers/inventory",new InventoryRequest("BUCKET","COUNT","旧账面不能覆盖新库存",Key(),CountedQuantity:Qty(before,"inStationQty"),ExpectedQuantity:Qty(before,"inStationQty")))).StatusCode);
        var current=await Summary(c,"BUCKET");
        var receipt=await Apply(c,new("BUCKET","COUNT","待检盘点",Key(),SourceState:"INSPECTING",CountedQuantity:Qty(current,"inspectingQty"),ExpectedQuantity:Qty(current,"inspectingQty")));
        Assert.Equal(0,Qty(receipt,"quantity"));Balanced(receipt.GetProperty("after"));
    }

    [Fact]
    public async Task Competing_Scrap_Requests_Cannot_Scrap_The_Same_Container_Twice()
    {
        using var c=await Client();await Apply(c,new("BAG","DAMAGE","报废竞争测试",Key(),1));var before=await Summary(c,"BAG");var damaged=Qty(before,"damagedQty");
        var responses=await Task.WhenAll(Enumerable.Range(0,2).Select(_=>c.PostAsJsonAsync("/api/containers/inventory",new InventoryRequest("BAG","SCRAP","确认报废",Key(),damaged))));
        Assert.Single(responses,r=>r.StatusCode==HttpStatusCode.OK);Assert.Single(responses,r=>r.StatusCode==HttpStatusCode.BadRequest);
        var after=await Summary(c,"BAG");Assert.Equal(0,Qty(after,"damagedQty"));Assert.Equal(Qty(before,"scrappedQty")+damaged,Qty(after,"scrappedQty"));Balanced(after);
    }

    [Fact]
    public async Task Member_Damaged_Return_Changes_Holdings_But_Not_Deposits_Or_Tickets()
    {
        using var c=await Client();var m=await Member(c);
        await Ok(await c.PostAsJsonAsync("/api/deposits/collect",new CollectDepositRequest(m,"BAG",1,"CASH",Key())));
        await Ok(await c.PostAsJsonAsync("/api/containers/movements",new RegisterContainerMovementRequest(m,"BAG",1,0,IdempotencyKey:Key())));
        var before=await Summary(c,"BAG");var req=new InventoryRequest("BAG","DAMAGE","会员已交回破损袋",Key(),1,"MEMBER",m);
        var first=await Apply(c,req);var replay=await Apply(c,req);Assert.Equal(first.GetProperty("id").GetGuid(),replay.GetProperty("id").GetGuid());
        var p=await c.GetFromJsonAsync<JsonElement>($"/api/members/{m}/profile");Assert.Equal(0,Qty(p,"heldBags"));Assert.Equal(5m,p.GetProperty("depositAmount").GetDecimal());Assert.Equal(0,Qty(p,"bagPickupTickets"));
        var after=await Summary(c,"BAG");Assert.Equal(Qty(before,"totalQty"),Qty(after,"totalQty"));Assert.Equal(Qty(before,"memberHeldQty")-1,Qty(after,"memberHeldQty"));Assert.Equal(Qty(before,"damagedQty")+1,Qty(after,"damagedQty"));Balanced(after);
        var history=await c.GetFromJsonAsync<JsonElement>("/api/containers/inventory-operations?containerType=BAG");Assert.Contains(history.EnumerateArray(),x=>x.GetProperty("operation").GetProperty("id").GetGuid()==first.GetProperty("id").GetGuid());
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
            await Apply(c,new("BUCKET","COUNT","可用库存为零验收",Key(),CountedQuantity:0,ExpectedQuantity:Qty(before,"inStationQty")));
            Assert.Equal(HttpStatusCode.BadRequest,(await c.PostAsJsonAsync($"/api/orders/{orderId}/fulfill",new FulfillWaterOrderRequest(1,1,0,order.GetProperty("pickupCode").GetString()))).StatusCode);
            var p=await c.GetFromJsonAsync<JsonElement>($"/api/members/{m}/profile");Assert.Equal(0,Qty(p,"heldBuckets"));Assert.Equal(15,Qty(p,"bucketPickupTickets"));Assert.Equal(1,Qty(p,"reservedBucketPickupTickets"));
        }
        finally
        {
            var current=await Summary(c,"BUCKET");await Apply(c,new("BUCKET","COUNT","恢复验收前库存",Key(),CountedQuantity:Qty(before,"inStationQty"),ExpectedQuantity:Qty(current,"inStationQty")));
            if(orderId.HasValue)await c.PostAsJsonAsync($"/api/orders/{orderId}/cancel",new CancelWaterOrderRequest("验收结束"));
        }
    }
}
