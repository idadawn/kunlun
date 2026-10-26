using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Kunlun.WaterStation.Auth;
using Kunlun.WaterStation.Operations;
using Xunit;

namespace Kunlun.WaterStation.Tests;

[Collection("KunlunIntegration")]
public sealed class ContainerCirculationTests(TestHost host)
{
    private static string Key()=>Guid.NewGuid().ToString();
    private async Task<HttpClient> Client(string user="YG0001")
    {
        var c=host.CreateClient();var auth=await Ok(await c.PostAsJsonAsync("/api/auth/staff/login",new StaffLoginRequest(user,TestHost.Password)));
        c.DefaultRequestHeaders.Authorization=new AuthenticationHeaderValue("Bearer",auth.GetProperty("accessToken").GetString());return c;
    }
    private static async Task<JsonElement> Ok(HttpResponseMessage response)
    {
        var text=await response.Content.ReadAsStringAsync();Assert.True(response.IsSuccessStatusCode,$"{response.StatusCode}: {text}");return JsonSerializer.Deserialize<JsonElement>(text);
    }
    private static int Q(JsonElement x,string field)=>x.GetProperty(field).GetInt32();
    private static decimal Money(JsonElement x,string field)=>x.GetProperty(field).GetDecimal();
    private static async Task<JsonElement> Member(HttpClient c)=>await Ok(await c.PostAsJsonAsync("/api/members",new CreateMemberRequest("周转验收",$"129{Random.Shared.Next(10000000,99999999)}","验收地址",null,"1-101")));
    private static async Task<JsonElement> Stock(HttpClient c,string type)=>(await c.GetFromJsonAsync<JsonElement>("/api/containers/summary")).EnumerateArray().Single(x=>x.GetProperty("containerType").GetString()==type);
    private static async Task<JsonElement> Profile(HttpClient c,Guid mid)=>await c.GetFromJsonAsync<JsonElement>($"/api/members/{mid}/profile");
    private static async Task<JsonElement> Deposit(HttpClient c,Guid mid)=>(await c.GetFromJsonAsync<JsonElement>($"/api/members/{mid}/deposit-summary")).EnumerateArray().Single(x=>x.GetProperty("containerType").GetString()=="BAG");
    private static async Task Prepare(HttpClient c,Guid mid,int qty=1)
    {
        await Ok(await c.PostAsJsonAsync("/api/deposits/collect",new CollectDepositRequest(mid,"BAG",qty,"CASH",Key())));
        await Ok(await c.PostAsJsonAsync("/api/containers/movements",new RegisterContainerMovementRequest(mid,"BAG",qty,0,IdempotencyKey:Key())));
    }
    private static async Task<JsonElement> Report(HttpClient c,Guid mid,int qty=1)=>await Ok(await c.PostAsJsonAsync("/api/containers/damages",new ReportContainerDamageRequest(mid,"BAG",qty,"归还破损水袋",Key())));
    private static async Task<JsonElement> Scrap(HttpClient c,Guid id,string? key=null)=>await Ok(await c.PostAsJsonAsync($"/api/containers/damages/{id}/scrap",new ScrapContainerDamageRequest("无法继续周转",key??Key())));

    [Fact]
    public async Task Damage_Reserves_Original_Lots_And_Scrap_Deducts_Once_With_Reconciled_Reports()
    {
        using var c=await Client();var member=await Member(c);var mid=member.GetProperty("id").GetGuid();
        try
        {
            (await c.PutAsync("/api/containers/BAG/unit-deposit?newUnitDeposit=30",null)).EnsureSuccessStatusCode();
            await Ok(await c.PostAsJsonAsync("/api/deposits/collect",new CollectDepositRequest(mid,"BAG",1,"CASH",Key())));
        }
        finally{(await c.PutAsync("/api/containers/BAG/unit-deposit?newUnitDeposit=5",null)).EnsureSuccessStatusCode();}
        await Ok(await c.PostAsJsonAsync("/api/deposits/collect",new CollectDepositRequest(mid,"BAG",2,"CASH",Key())));
        await Ok(await c.PostAsJsonAsync("/api/containers/movements",new RegisterContainerMovementRequest(mid,"BAG",2,0,IdempotencyKey:Key())));
        var before=await Stock(c,"BAG");var financeBefore=await c.GetFromJsonAsync<JsonElement>("/api/reports/finance-summary");
        var report=await Report(c,mid,2);var id=report.GetProperty("id").GetGuid();Assert.Equal(35m,Money(report,"depositAmount"));
        var profile=await Profile(c,mid);Assert.Equal(0,Q(profile,"heldBags"));Assert.Equal(40m,Money(profile,"depositAmount"));Assert.Equal(0,Q(profile,"bagPickupTickets"));
        var reserved=await Deposit(c,mid);Assert.Equal(2,Q(reserved,"pendingDamageQty"));Assert.Equal(1,Q(reserved,"refundableQty"));Assert.Equal(5m,Money(reserved,"refundableAmount"));
        var now=await Stock(c,"BAG");Assert.Equal(Q(before,"totalQty"),Q(now,"totalQty"));Assert.Equal(Q(before,"damagedQty")+2,Q(now,"damagedQty"));
        await Ok(await c.PostAsJsonAsync("/api/deposits/refund",new RefundDepositRequest(mid,"BAG",1,Key())));
        var key=Key();var receipt=await Scrap(c,id,key);Assert.Equal(35m,Money(receipt,"deductedAmount"));
        Assert.True(JsonElement.DeepEquals(receipt,await Scrap(c,id,key)));
        Assert.Equal(HttpStatusCode.Conflict,(await c.PostAsJsonAsync($"/api/containers/damages/{id}/scrap",new ScrapContainerDamageRequest("换原因",key))).StatusCode);
        Assert.Equal(HttpStatusCode.Conflict,(await c.PostAsJsonAsync($"/api/containers/damages/{id}/scrap",new ScrapContainerDamageRequest("重复报废",Key()))).StatusCode);
        profile=await Profile(c,mid);Assert.Equal(0m,Money(profile,"depositAmount"));Assert.Equal(0,Q(profile,"heldBags"));
        now=await Stock(c,"BAG");Assert.Equal(Q(before,"totalQty")-2,Q(now,"totalQty"));Assert.Equal(Q(before,"damagedQty"),Q(now,"damagedQty"));Assert.Equal(Q(before,"scrappedQty")+2,Q(now,"scrappedQty"));Assert.True(now.GetProperty("identityValid").GetBoolean());
        var finance=await c.GetFromJsonAsync<JsonElement>("/api/reports/finance-summary");Assert.True(finance.GetProperty("reconciledZeroDiff").GetBoolean());Assert.Equal(Money(financeBefore,"depositDeductedTotal")+35,Money(finance,"depositDeductedTotal"));
        var q=Uri.EscapeDataString(member.GetProperty("memberNo").GetString()!);
        var circulation=await c.GetFromJsonAsync<JsonElement>("/api/containers/circulation?q="+q);Assert.Equal(3,Q(circulation,"total"));
        Assert.Contains(circulation.GetProperty("rows").EnumerateArray(),r=>r.GetProperty("businessType").GetString()=="SCRAP"&&Money(r,"depositDeductedAmount")==35&&Q(r,"scrappedQty")==2);
        Assert.Contains("DEDUCT",await c.GetStringAsync("/api/exports/deposit-ledgers"));Assert.Contains("SCRAP",await c.GetStringAsync("/api/exports/container-ledgers"));
        var ledger=await c.GetFromJsonAsync<JsonElement>("/api/ledgers/deposits");Assert.Contains(ledger.EnumerateArray(),r=>r.GetProperty("docNo").GetString()==receipt.GetProperty("scrapNo").GetString()&&r.GetProperty("flowType").GetString()=="DEDUCT");
    }

    [Fact]
    public async Task Pending_Damage_Cannot_Be_Refunded_Reused_Or_Scrapped_From_Stock()
    {
        using var c=await Client();var mid=(await Member(c)).GetProperty("id").GetGuid();await Prepare(c,mid);var damage=await Report(c,mid);
        Assert.Equal(HttpStatusCode.BadRequest,(await c.PostAsJsonAsync("/api/deposits/refund",new RefundDepositRequest(mid,"BAG",1,Key()))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest,(await c.PostAsJsonAsync("/api/containers/movements",new RegisterContainerMovementRequest(mid,"BAG",1,0,IdempotencyKey:Key()))).StatusCode);
        var stock=await Stock(c,"BAG");Assert.Equal(HttpStatusCode.BadRequest,(await c.PostAsJsonAsync("/api/containers/inventory",new InventoryRequest("BAG","SCRAP","不能绕过扣押",Key(),Q(stock,"damagedQty"),"DAMAGED"))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest,(await c.PostAsJsonAsync("/api/containers/inventory",new InventoryRequest("BAG","SCRAP","不能直接扣会员库存",Key(),1,"MEMBER",mid))).StatusCode);
        Assert.Equal(5m,Money(await Profile(c,mid),"depositAmount"));await Scrap(c,damage.GetProperty("id").GetGuid());
    }

    [Fact]
    public async Task Concurrent_Report_And_Scrap_Retries_Do_Not_Double_Charge()
    {
        using var c=await Client();var mid=(await Member(c)).GetProperty("id").GetGuid();await Prepare(c,mid);
        var request=new ReportContainerDamageRequest(mid,"BAG",1,"破损归还",Key());
        var reports=await Task.WhenAll(Enumerable.Range(0,4).Select(_=>c.PostAsJsonAsync("/api/containers/damages",request)));
        var ids=new HashSet<Guid>();foreach(var r in reports)ids.Add((await Ok(r)).GetProperty("id").GetGuid());var id=Assert.Single(ids);
        var key=Key();var results=await Task.WhenAll(Enumerable.Range(0,4).Select(_=>Scrap(c,id,key)));Assert.Single(results.Select(r=>r.GetProperty("scrapNo").GetString()).Distinct());
        Assert.Equal(0m,Money(await Profile(c,mid),"depositAmount"));
        Assert.Equal(HttpStatusCode.Conflict,(await c.PostAsJsonAsync("/api/containers/damages",request with{Quantity=2})).StatusCode);
    }

    [Fact]
    public async Task Competing_Scraps_And_Refund_Are_Serialized()
    {
        using var c=await Client();var mid=(await Member(c)).GetProperty("id").GetGuid();await Prepare(c,mid);var id=(await Report(c,mid)).GetProperty("id").GetGuid();
        var responses=await Task.WhenAll(c.PostAsJsonAsync($"/api/containers/damages/{id}/scrap",new ScrapContainerDamageRequest("报废",Key())),c.PostAsJsonAsync($"/api/containers/damages/{id}/scrap",new ScrapContainerDamageRequest("报废",Key())),c.PostAsJsonAsync("/api/deposits/refund",new RefundDepositRequest(mid,"BAG",1,Key())));
        Assert.Single(responses,r=>r.StatusCode==HttpStatusCode.OK);Assert.Single(responses,r=>r.StatusCode==HttpStatusCode.Conflict);Assert.Single(responses,r=>r.StatusCode==HttpStatusCode.BadRequest);
        Assert.Equal(0m,Money(await Profile(c,mid),"depositAmount"));
    }

    [Fact]
    public async Task Permissions_OverReturn_And_Wrong_Container_Are_Rejected()
    {
        using var c=await Client();using var clerk=await Client("YG0012");var mid=(await Member(c)).GetProperty("id").GetGuid();await Prepare(c,mid);
        var req=new ReportContainerDamageRequest(mid,"BAG",1,"归还",Key());
        Assert.Equal(HttpStatusCode.Forbidden,(await clerk.PostAsJsonAsync("/api/containers/damages",req)).StatusCode);
        foreach(var invalid in new[]{req with{Quantity=2},req with{Quantity=-1},req with{ContainerType="BUCKET"},req with{Reason=" "}})
            Assert.Equal(HttpStatusCode.BadRequest,(await c.PostAsJsonAsync("/api/containers/damages",invalid)).StatusCode);
        var report=await Ok(await c.PostAsJsonAsync("/api/containers/damages",req));
        Assert.Equal(HttpStatusCode.Forbidden,(await clerk.PostAsJsonAsync($"/api/containers/damages/{report.GetProperty("id").GetGuid()}/scrap",new ScrapContainerDamageRequest("报废",Key()))).StatusCode);
        Assert.Equal(5m,Money(await Profile(c,mid),"depositAmount"));await Scrap(c,report.GetProperty("id").GetGuid());
    }

    [Fact]
    public async Task Circulation_Is_Searchable_And_Paged_Without_Losing_Older_Records()
    {
        using var c=await Client();var m=await Member(c);var mid=m.GetProperty("id").GetGuid();
        await Ok(await c.PostAsJsonAsync("/api/deposits/collect",new CollectDepositRequest(mid,"BAG",1,"CASH",Key())));
        for(var i=0;i<22;i++)await Ok(await c.PostAsJsonAsync("/api/containers/movements",new RegisterContainerMovementRequest(mid,"BAG",i%2==0?1:0,i%2==1?1:0,IdempotencyKey:Key())));
        var query=Uri.EscapeDataString(m.GetProperty("memberNo").GetString()!);
        var a=await c.GetFromJsonAsync<JsonElement>("/api/containers/circulation?q="+query+"&page=1");var b=await c.GetFromJsonAsync<JsonElement>("/api/containers/circulation?q="+query+"&page=2");
        Assert.Equal(22,Q(a,"total"));Assert.Equal(20,a.GetProperty("rows").GetArrayLength());Assert.Equal(2,b.GetProperty("rows").GetArrayLength());
        Assert.Equal(22,a.GetProperty("rows").EnumerateArray().Concat(b.GetProperty("rows").EnumerateArray()).Select(r=>r.GetProperty("ledgerNo").GetString()).Distinct().Count());
        Assert.Equal(HttpStatusCode.BadRequest,(await c.GetAsync("/api/containers/circulation?page=0")).StatusCode);
    }
}
