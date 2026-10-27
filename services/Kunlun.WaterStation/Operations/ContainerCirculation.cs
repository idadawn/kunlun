using System.Security.Claims;
using System.Text.Json;
using Kunlun.WaterStation.Auth;
using Npgsql;
using static Kunlun.WaterStation.Operations.TicketBatches;
using static Kunlun.WaterStation.Operations.ContainerInventory;

namespace Kunlun.WaterStation.Operations;

public sealed record ReportContainerDamageRequest(Guid MemberId, string ContainerType, int Quantity, string Reason, string IdempotencyKey);
// DeductDeposit=false 报废但不扣押金（如自然老化、配送损坏由水站承担）：暂占的押金退回会员可用余额。
public sealed record ScrapContainerDamageRequest(string Reason, string IdempotencyKey, bool DeductDeposit = true);
public sealed record DamageDepositLot(Guid LotId, string LotNo, int Quantity, decimal UnitPrice);

public static class ContainerCirculation
{
    private static bool CanRead(ClaimsPrincipal u) => u.FindFirstValue("subject_type")=="STAFF" && u.HasClaim("perm",KunlunPermissions.MemberRead);
    private static bool CanManage(ClaimsPrincipal u) => CanRead(u) && u.HasClaim("perm",KunlunPermissions.ContainerInventoryManage);
    private static string Actor(ClaimsPrincipal u) => u.FindFirstValue("display_name")??"管理员";
    private static readonly JsonSerializerOptions JsonOptions=new(JsonSerializerDefaults.Web);

    public static async Task EnsureSchema(NpgsqlDataSource db, CancellationToken ct=default)
    {
        await using var conn=await db.OpenConnectionAsync(ct);await using var tx=await conn.BeginTransactionAsync(ct);
        await Exec(conn,tx,"""
            SELECT pg_advisory_xact_lock(88482027);
            ALTER TABLE plugin_kunlun_waterstation.deposit_lots ADD COLUMN IF NOT EXISTS reserved_damage_qty INT NOT NULL DEFAULT 0 CHECK(reserved_damage_qty>=0 AND reserved_damage_qty<=remaining_qty);
            ALTER TABLE plugin_kunlun_waterstation.deposit_lots ADD COLUMN IF NOT EXISTS deducted_qty INT NOT NULL DEFAULT 0 CHECK(deducted_qty>=0);
            ALTER TABLE plugin_kunlun_waterstation.container_ledgers ADD COLUMN IF NOT EXISTS scrapped_qty INT NOT NULL DEFAULT 0 CHECK(scrapped_qty>=0);
            ALTER TABLE plugin_kunlun_waterstation.container_ledgers ADD COLUMN IF NOT EXISTS business_type VARCHAR(24) NOT NULL DEFAULT 'TURNOVER';
            ALTER TABLE plugin_kunlun_waterstation.container_ledgers ADD COLUMN IF NOT EXISTS deposit_deducted_amount NUMERIC(10,2) NOT NULL DEFAULT 0;
            CREATE TABLE IF NOT EXISTS plugin_kunlun_waterstation.container_damages(
              id UUID PRIMARY KEY,tenant_id UUID NOT NULL,damage_no VARCHAR(32) NOT NULL UNIQUE,
              idempotency_key VARCHAR(80) NOT NULL,request_hash VARCHAR(64) NOT NULL,
              member_id UUID NOT NULL REFERENCES plugin_kunlun_waterstation.members(id),container_type VARCHAR(16) NOT NULL CHECK(container_type IN ('BAG','BUCKET')),
              quantity INT NOT NULL CHECK(quantity>0),deposit_amount NUMERIC(10,2) NOT NULL CHECK(deposit_amount>0),
              lot_breakdown JSONB NOT NULL,status VARCHAR(16) NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','SCRAPPED')),
              reason TEXT NOT NULL,operator_name VARCHAR(64) NOT NULL,report_receipt JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
              scrap_no VARCHAR(32),scrap_key VARCHAR(80),scrap_hash VARCHAR(64),scrap_reason TEXT,scrap_operator VARCHAR(64),scrapped_at TIMESTAMPTZ,scrap_receipt JSONB,
              UNIQUE(tenant_id,idempotency_key),UNIQUE(tenant_id,scrap_key)
            );
            CREATE INDEX IF NOT EXISTS container_damages_member ON plugin_kunlun_waterstation.container_damages(tenant_id,member_id,status);
            ALTER TABLE plugin_kunlun_waterstation.container_damages ADD COLUMN IF NOT EXISTS deposit_waived BOOLEAN NOT NULL DEFAULT FALSE;
            """,ct);
        await tx.CommitAsync(ct);
    }

    public static void MapContainerCirculation(this WebApplication app)
    {
        app.MapPost("/api/containers/damages",ReportDamage).RequireAuthorization();
        app.MapPost("/api/containers/damages/{id:guid}/scrap",ScrapDamage).RequireAuthorization();
        app.MapGet("/api/containers/circulation",async(string? q,string? containerType,int? page,ClaimsPrincipal user,NpgsqlDataSource db,KunlunAuthRepository repo,CancellationToken ct)=>
        {
            if(!CanRead(user))return Results.Forbid();
            ValidateFilter(containerType,page);
            var filter="c.tenant_id=@tid AND (@type='' OR c.container_type=@type) AND (@q='' OR m.name ILIKE @search OR m.phone ILIKE @search OR m.member_no ILIKE @search OR c.ledger_no ILIKE @search OR c.order_no ILIKE @search)";
            await using var conn=await db.OpenConnectionAsync(ct);
            var args=FilterArgs(repo.DefaultTenantId,q,containerType,page);
            await using var count=Command(conn,null,$"SELECT count(*) FROM plugin_kunlun_waterstation.container_ledgers c JOIN plugin_kunlun_waterstation.members m ON m.id=c.member_id AND m.tenant_id=c.tenant_id WHERE {filter}",args);
            var total=Convert.ToInt64(await count.ExecuteScalarAsync(ct));
            await using var cmd=Command(conn,null,$"""
                SELECT c.ledger_no,m.name,m.member_no,c.container_type,c.full_out_qty,c.empty_in_qty,c.delta_held,c.held_after,
                c.operator_name,c.created_at,COALESCE(c.order_no,''),c.business_type,c.deposit_deducted_amount,COALESCE(c.remark,''),c.scrapped_qty
                FROM plugin_kunlun_waterstation.container_ledgers c JOIN plugin_kunlun_waterstation.members m ON m.id=c.member_id AND m.tenant_id=c.tenant_id
                WHERE {filter} ORDER BY c.created_at DESC,c.id DESC LIMIT 20 OFFSET @offset
                """,args);
            var rows=new List<object>();await using var r=await cmd.ExecuteReaderAsync(ct);
            while(await r.ReadAsync(ct))rows.Add(new{ledgerNo=r.GetString(0),memberName=r.GetString(1),memberNo=r.GetString(2),containerType=r.GetString(3),fullOutQty=r.GetInt32(4),emptyInQty=r.GetInt32(5),deltaHeld=r.GetInt32(6),heldAfter=r.GetInt32(7),operatorName=r.GetString(8),createdAt=r.GetDateTime(9),referenceNo=r.GetString(10),businessType=r.GetString(11),depositDeductedAmount=r.GetDecimal(12),remark=r.GetString(13),scrappedQty=r.GetInt32(14)});
            return Results.Ok(new{rows,total,page=page??1,pageSize=20});
        }).RequireAuthorization();
        app.MapGet("/api/containers/holdings",async(string? q,int? page,ClaimsPrincipal user,NpgsqlDataSource db,KunlunAuthRepository repo,CancellationToken ct)=>
        {
            if(!CanRead(user))return Results.Forbid();ValidateFilter(null,page);
            await using var conn=await db.OpenConnectionAsync(ct);
            const string from="""
                FROM plugin_kunlun_waterstation.members m
                LEFT JOIN (SELECT member_id,sum(quantity) AS qty,sum(deposit_amount) AS amount FROM plugin_kunlun_waterstation.container_damages
                  WHERE tenant_id=@tid AND status='PENDING' GROUP BY member_id) d ON d.member_id=m.id
                WHERE m.tenant_id=@tid AND (m.held_buckets+m.held_bags>0 OR COALESCE(d.qty,0)>0 OR @q<>'')
                  AND (@q='' OR m.name ILIKE @search OR m.phone ILIKE @search OR m.member_no ILIKE @search)
                """;
            var args=FilterArgs(repo.DefaultTenantId,q,null,page);
            await using var count=Command(conn,null,"SELECT count(*) "+from,args);var total=Convert.ToInt64(await count.ExecuteScalarAsync(ct));
            await using var cmd=Command(conn,null,"SELECT m.id,m.member_no,m.name,m.phone,m.held_bags,m.held_buckets,m.deposit_amount,COALESCE(d.qty,0),COALESCE(d.amount,0) "+from+" ORDER BY m.created_at DESC,m.id LIMIT 20 OFFSET @offset",args);
            var rows=new List<object>();await using var r=await cmd.ExecuteReaderAsync(ct);
            while(await r.ReadAsync(ct))rows.Add(new{id=r.GetGuid(0),memberNo=r.GetString(1),name=r.GetString(2),phone=r.GetString(3),heldBags=r.GetInt32(4),heldBuckets=r.GetInt32(5),depositAmount=r.GetDecimal(6),pendingDamageQty=r.GetInt64(7),pendingDamageAmount=r.GetDecimal(8)});
            return Results.Ok(new{rows,total,page=page??1,pageSize=20});
        }).RequireAuthorization();
        app.MapGet("/api/containers/damages",async(string? q,string? containerType,string? status,int? page,ClaimsPrincipal user,NpgsqlDataSource db,KunlunAuthRepository repo,CancellationToken ct)=>
        {
            if(!CanRead(user))return Results.Forbid();ValidateFilter(containerType,page);
            if(status is not(null or "" or "PENDING" or "SCRAPPED"))throw new BusinessRuleException("破损状态无效");
            await using var conn=await db.OpenConnectionAsync(ct);
            var args=FilterArgs(repo.DefaultTenantId,q,containerType,page).Append(("status",(object)(status??""))).ToArray();
            const string from="""
                FROM plugin_kunlun_waterstation.container_damages d JOIN plugin_kunlun_waterstation.members m ON m.id=d.member_id AND m.tenant_id=d.tenant_id
                WHERE d.tenant_id=@tid AND (@type='' OR d.container_type=@type) AND (@status='' OR d.status=@status)
                  AND (@q='' OR m.name ILIKE @search OR m.phone ILIKE @search OR m.member_no ILIKE @search OR d.damage_no ILIKE @search)
                """;
            await using var count=Command(conn,null,"SELECT count(*) "+from,args);var total=Convert.ToInt64(await count.ExecuteScalarAsync(ct));
            await using var cmd=Command(conn,null,"SELECT d.id,d.damage_no,m.name,m.member_no,d.container_type,d.quantity,d.deposit_amount,d.status,d.reason,d.operator_name,d.created_at,d.lot_breakdown::text,COALESCE(d.scrap_no,''),COALESCE(d.scrap_reason,''),d.deposit_waived "+from+" ORDER BY d.created_at DESC,d.id LIMIT 20 OFFSET @offset",args);
            var rows=new List<object>();await using var r=await cmd.ExecuteReaderAsync(ct);
            while(await r.ReadAsync(ct))rows.Add(new{id=r.GetGuid(0),damageNo=r.GetString(1),memberName=r.GetString(2),memberNo=r.GetString(3),containerType=r.GetString(4),quantity=r.GetInt32(5),depositAmount=r.GetDecimal(6),status=r.GetString(7),reason=r.GetString(8),operatorName=r.GetString(9),createdAt=r.GetDateTime(10),lotBreakdown=JsonSerializer.Deserialize<JsonElement>(r.GetString(11)),scrapNo=r.GetString(12),scrapReason=r.GetString(13),depositWaived=r.GetBoolean(14)});
            return Results.Ok(new{rows,total,page=page??1,pageSize=20});
        }).RequireAuthorization();
    }

    private static void ValidateFilter(string? type,int? page)
    {
        if(type is not(null or "" or "BAG" or "BUCKET") || page is <1 or >1000000)throw new BusinessRuleException("筛选或页码无效");
    }
    private static (string,object)[] FilterArgs(Guid tid,string? q,string? type,int? page)=>[("tid",tid),("q",q?.Trim()??""),("search","%"+(q?.Trim()??"")+"%"),("type",type??""),("offset",((page??1)-1)*20)];

    private static async Task<IResult> ReportDamage(ReportContainerDamageRequest req,ClaimsPrincipal user,NpgsqlDataSource db,KunlunAuthRepository repo,CancellationToken ct)
    {
        if(!CanManage(user))return Results.Forbid();
        if(req.ContainerType is not("BAG" or "BUCKET") || req.Quantity is <=0 or >10000 || string.IsNullOrWhiteSpace(req.Reason) || req.Reason.Length>500)
            throw new BusinessRuleException("请填写会员、容器、有效破损数量和原因");
        var tid=repo.DefaultTenantId;var hash=Hash(req with{Reason=req.Reason.Trim()});
        await using var conn=await db.OpenConnectionAsync(ct);await using var tx=await conn.BeginTransactionAsync(ct);
        await LockRequest(conn,tx,tid,"damage-report",req.IdempotencyKey,ct);
        await using(var replay=Command(conn,tx,"SELECT request_hash,report_receipt::text FROM plugin_kunlun_waterstation.container_damages WHERE tenant_id=@tid AND idempotency_key=@key",("tid",tid),("key",req.IdempotencyKey)))
        await using(var r=await replay.ExecuteReaderAsync(ct))if(await r.ReadAsync(ct))
        {
            if(r.GetString(0)!=hash)throw new BusinessRuleException("请求标识已用于其他破损登记",409);
            return Results.Ok(JsonSerializer.Deserialize<JsonElement>(r.GetString(1)));
        }
        await LockMember(conn,tx,tid,req.MemberId,ct);
        var col=req.ContainerType=="BAG"?"held_bags":"held_buckets";
        await using var member=Command(conn,tx,$"SELECT {col} FROM plugin_kunlun_waterstation.members WHERE tenant_id=@tid AND id=@mid",("tid",tid),("mid",req.MemberId));
        var held=Convert.ToInt32(await member.ExecuteScalarAsync(ct));
        if(req.Quantity>held)throw new BusinessRuleException("破损归还数量超过会员当前持有数量");
        var before=await ReadBalance(conn,tx,tid,req.ContainerType,ct);
        if(before.MemberHeldQty<req.Quantity)throw new BusinessRuleException("会员持有汇总需要核对");
        var lots=new List<DamageDepositLot>();var left=req.Quantity;var covered=0;
        await using(var cmd=Command(conn,tx,"""
            SELECT id,deposit_no,unit_price,remaining_qty-reserved_damage_qty FROM plugin_kunlun_waterstation.deposit_lots
            WHERE tenant_id=@tid AND member_id=@mid AND container_type=@type ORDER BY created_at,id FOR UPDATE
            """,("tid",tid),("mid",req.MemberId),("type",req.ContainerType)))
        await using(var r=await cmd.ExecuteReaderAsync(ct))while(await r.ReadAsync(ct))
        {
            var available=r.GetInt32(3);covered+=available;var take=Math.Min(left,available);
            if(take>0){lots.Add(new(r.GetGuid(0),r.GetString(1),take,r.GetDecimal(2)));left-=take;}
        }
        if(left>0)throw new BusinessRuleException("该会员此类容器的实收押金不足，请先核对或补收押金后登记");
        foreach(var lot in lots)await Exec(conn,tx,"UPDATE plugin_kunlun_waterstation.deposit_lots SET reserved_damage_qty=reserved_damage_qty+@qty WHERE id=@id",ct,("id",lot.LotId),("qty",lot.Quantity));
        var after=before with{MemberHeldQty=before.MemberHeldQty-req.Quantity,DamagedQty=checked(before.DamagedQty+req.Quantity)};
        await SaveBalance(conn,tx,tid,req.ContainerType,after,ct);
        await Exec(conn,tx,$"UPDATE plugin_kunlun_waterstation.members SET {col}={col}-@qty WHERE tenant_id=@tid AND id=@mid",ct,("qty",req.Quantity),("tid",tid),("mid",req.MemberId));
        var id=Guid.NewGuid();var no="PS"+id.ToString("N")[..28];var amount=lots.Sum(l=>l.Quantity*l.UnitPrice);
        var receipt=new{id,damageNo=no,req.MemberId,req.ContainerType,req.Quantity,depositAmount=amount,status="PENDING",lotBreakdown=lots};
        await Exec(conn,tx,"""
            INSERT INTO plugin_kunlun_waterstation.container_damages(id,tenant_id,damage_no,idempotency_key,request_hash,member_id,container_type,quantity,deposit_amount,lot_breakdown,reason,operator_name,report_receipt)
            VALUES(@id,@tid,@no,@key,@hash,@mid,@type,@qty,@amount,@lots::jsonb,@reason,@actor,@receipt::jsonb)
            """,ct,("id",id),("tid",tid),("no",no),("key",req.IdempotencyKey),("hash",hash),("mid",req.MemberId),("type",req.ContainerType),("qty",req.Quantity),("amount",amount),("lots",Json(lots)),("reason",req.Reason.Trim()),("actor",Actor(user)),("receipt",Json(receipt)));
        await Ledger(conn,tx,tid,req.MemberId,req.ContainerType,no,"DAMAGE_RETURN",req.Quantity,0,held-req.Quantity,covered-req.Quantity,0,req.Reason.Trim(),user,ct);
        await tx.CommitAsync(ct);return Results.Ok(receipt);
    }

    private static async Task<IResult> ScrapDamage(Guid id,ScrapContainerDamageRequest req,ClaimsPrincipal user,NpgsqlDataSource db,KunlunAuthRepository repo,CancellationToken ct)
    {
        if(!CanManage(user) || !user.HasClaim("perm",KunlunPermissions.DepositRefundApprove))return Results.Forbid();
        if(string.IsNullOrWhiteSpace(req.Reason) || req.Reason.Length>500)throw new BusinessRuleException("请填写报废原因");
        var tid=repo.DefaultTenantId;var waive=!req.DeductDeposit;
        // Deducting scraps keep the original hash shape so replays of requests sent before the waive option still match.
        var hash=waive?Hash(new{id,reason=req.Reason.Trim(),req.IdempotencyKey,deductDeposit=false}):Hash(new{id,reason=req.Reason.Trim(),req.IdempotencyKey});
        await using var conn=await db.OpenConnectionAsync(ct);await using var tx=await conn.BeginTransactionAsync(ct);
        await LockRequest(conn,tx,tid,"damage-scrap",req.IdempotencyKey,ct);
        await using(var replay=Command(conn,tx,"SELECT scrap_hash,scrap_receipt::text FROM plugin_kunlun_waterstation.container_damages WHERE tenant_id=@tid AND scrap_key=@key",("tid",tid),("key",req.IdempotencyKey)))
        await using(var r=await replay.ExecuteReaderAsync(ct))if(await r.ReadAsync(ct))
        {
            if(r.GetString(0)!=hash)throw new BusinessRuleException("请求标识已用于其他报废",409);
            return Results.Ok(JsonSerializer.Deserialize<JsonElement>(r.GetString(1)));
        }
        // Match all money/fulfillment paths: member -> damage -> container -> deposit lots.
        await using var find=Command(conn,tx,"SELECT member_id FROM plugin_kunlun_waterstation.container_damages WHERE tenant_id=@tid AND id=@id",("tid",tid),("id",id));
        var memberValue=await find.ExecuteScalarAsync(ct);if(memberValue is null)throw new BusinessRuleException("破损记录不存在",404);
        var mid=(Guid)memberValue;await LockMember(conn,tx,tid,mid,ct);
        string type;int qty;decimal amount;List<DamageDepositLot> lots;
        await using(var read=Command(conn,tx,"SELECT container_type,quantity,deposit_amount,lot_breakdown::text,status FROM plugin_kunlun_waterstation.container_damages WHERE tenant_id=@tid AND id=@id FOR UPDATE",("tid",tid),("id",id)))
        await using(var r=await read.ExecuteReaderAsync(ct))
        {
            await r.ReadAsync(ct);if(r.GetString(4)!="PENDING")throw new BusinessRuleException("该记录已报废，请勿重复操作",409);
            type=r.GetString(0);qty=r.GetInt32(1);amount=r.GetDecimal(2);lots=JsonSerializer.Deserialize<List<DamageDepositLot>>(r.GetString(3),JsonOptions)!;
        }
        var before=await ReadBalance(conn,tx,tid,type,ct);
        if(before.DamagedQty<qty)throw new BusinessRuleException("待处理破损库存不足，请核对台账");
        // Waived: only release the reservation, so the deposit stays with the member and becomes refundable or covers new containers.
        var lotUpdate=waive
            ?"UPDATE plugin_kunlun_waterstation.deposit_lots SET reserved_damage_qty=reserved_damage_qty-@qty WHERE id=@id AND tenant_id=@tid AND member_id=@mid AND reserved_damage_qty>=@qty"
            :"UPDATE plugin_kunlun_waterstation.deposit_lots SET reserved_damage_qty=reserved_damage_qty-@qty,remaining_qty=remaining_qty-@qty,deducted_qty=deducted_qty+@qty WHERE id=@id AND tenant_id=@tid AND member_id=@mid AND reserved_damage_qty>=@qty AND remaining_qty>=@qty";
        foreach(var lot in lots)
            if(await Exec(conn,tx,lotUpdate,ct,("id",lot.LotId),("tid",tid),("mid",mid),("qty",lot.Quantity))!=1)throw new BusinessRuleException("原押金批次已变化，请核对后处理",409);
        var deducted=waive?0m:amount;
        if(!waive && await Exec(conn,tx,"UPDATE plugin_kunlun_waterstation.members SET deposit_amount=deposit_amount-@amount WHERE tenant_id=@tid AND id=@mid AND deposit_amount>=@amount",ct,("amount",amount),("tid",tid),("mid",mid))!=1)
            throw new BusinessRuleException("会员押金余额不足，未执行报废扣款",409);
        var after=before with{TotalQty=before.TotalQty-qty,DamagedQty=before.DamagedQty-qty,ScrappedQty=checked(before.ScrappedQty+qty)};
        await SaveBalance(conn,tx,tid,type,after,ct);
        var op=await RecordOperation(conn,tx,tid,"damage:"+id.ToString("N"),hash,type,"SCRAP","DAMAGED",qty,req.Reason.Trim(),mid,user,before,after,ct);
        var no=op.GetProperty("operationNo").GetString()!;
        var col=type=="BAG"?"held_bags":"held_buckets";
        await using var holdings=Command(conn,tx,$"SELECT {col} FROM plugin_kunlun_waterstation.members WHERE tenant_id=@tid AND id=@mid",("tid",tid),("mid",mid));
        var held=Convert.ToInt32(await holdings.ExecuteScalarAsync(ct));
        await using var coverage=Command(conn,tx,"SELECT COALESCE(sum(remaining_qty-reserved_damage_qty),0) FROM plugin_kunlun_waterstation.deposit_lots WHERE tenant_id=@tid AND member_id=@mid AND container_type=@type",("tid",tid),("mid",mid),("type",type));
        var covered=Convert.ToInt32(await coverage.ExecuteScalarAsync(ct));
        await Ledger(conn,tx,tid,mid,type,no,waive?"SCRAP_WAIVED":"SCRAP",0,qty,held,covered,deducted,req.Reason.Trim(),user,ct);
        var receipt=new{id,scrapNo=no,memberId=mid,containerType=type,quantity=qty,deductedAmount=deducted,depositWaived=waive,lotBreakdown=lots,status="SCRAPPED"};
        await Exec(conn,tx,"""
            UPDATE plugin_kunlun_waterstation.container_damages SET status='SCRAPPED',deposit_waived=@waive,scrap_no=@no,scrap_key=@key,scrap_hash=@hash,scrap_reason=@reason,scrap_operator=@actor,scrapped_at=now(),scrap_receipt=@receipt::jsonb
            WHERE tenant_id=@tid AND id=@id
            """,ct,("waive",waive),("no",no),("key",req.IdempotencyKey),("hash",hash),("reason",req.Reason.Trim()),("actor",Actor(user)),("receipt",Json(receipt)),("tid",tid),("id",id));
        await tx.CommitAsync(ct);return Results.Ok(receipt);
    }

    private static Task<int> Ledger(NpgsqlConnection conn,NpgsqlTransaction tx,Guid tid,Guid mid,string type,string reference,string business,int returned,int scrapped,int held,int covered,decimal amount,string reason,ClaimsPrincipal user,CancellationToken ct)=>Exec(conn,tx,"""
        INSERT INTO plugin_kunlun_waterstation.container_ledgers(tenant_id,ledger_no,member_id,container_type,order_no,full_out_qty,empty_in_qty,delta_held,held_after,covered_deposit_qty_after,operator_name,remark,business_type,deposit_deducted_amount,scrapped_qty)
        VALUES(@tid,@no,@mid,@type,@ref,0,@returned,-@returned,@held,@covered,@actor,@reason,@business,@amount,@scrapped)
        """,ct,("tid",tid),("no","CL"+Guid.NewGuid().ToString("N")[..28]),("mid",mid),("type",type),("ref",reference),("returned",returned),("held",held),("covered",covered),("actor",Actor(user)),("reason",reason),("business",business),("amount",amount),("scrapped",scrapped));
}
