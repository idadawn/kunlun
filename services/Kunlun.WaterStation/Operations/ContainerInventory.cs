using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Kunlun.WaterStation.Auth;
using Npgsql;
using static Kunlun.WaterStation.Operations.TicketBatches;

namespace Kunlun.WaterStation.Operations;

/// <summary>Stock changes are only RECEIVE (into store-available) and SCRAP (out of store-available).</summary>
public sealed record InventoryRequest(string ContainerType, string Action, string Reason, string IdempotencyKey, int Quantity = 0);
/// <summary>
/// 盘点：店里能用的、客户手里的数量都可以答"说不清"（null），记为待核实；ScrapQty 是店里坏了要报废的，不算在店里能用的里面。
/// </summary>
public sealed record StocktakeRequest(string ContainerType, int? InStationQty, int? WithCustomersQty, int ScrapQty, string IdempotencyKey, string? Note = null);
/// <summary>
/// 现存总量 = 门店可用 + 会员持有 + 待报废（会员破损归还、尚未扣押金）+ 客户手里未登记到会员名下的；累计报废另计。
/// 门店可用或客户手里待核实时，对应数字只是上次记下的参考，总量也就说不准。
/// </summary>
public sealed record InventoryBalance(int TotalQty, int InStationQty, int MemberHeldQty, int DamagedQty, int ScrappedQty,
    int UnregisteredOutQty = 0, bool InStationUnknown = false, bool OutUnknown = false);

public static class ContainerInventory
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private static bool Authorized(ClaimsPrincipal user) => user.FindFirstValue("subject_type") == "STAFF" && user.HasClaim("perm", KunlunPermissions.ContainerInventoryManage);

    public static async Task EnsureSchema(NpgsqlDataSource db, Guid tid, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct); await using var tx = await conn.BeginTransactionAsync(ct);
        await Exec(conn, tx, """
            SELECT pg_advisory_xact_lock(88482026);
            ALTER TABLE plugin_kunlun_waterstation.container_configs ADD COLUMN IF NOT EXISTS damaged_qty INT NOT NULL DEFAULT 0;
            ALTER TABLE plugin_kunlun_waterstation.container_configs ADD COLUMN IF NOT EXISTS scrapped_qty INT NOT NULL DEFAULT 0;
            ALTER TABLE plugin_kunlun_waterstation.container_configs ADD COLUMN IF NOT EXISTS unregistered_out_qty INT NOT NULL DEFAULT 0;
            ALTER TABLE plugin_kunlun_waterstation.container_configs ADD COLUMN IF NOT EXISTS in_station_unknown BOOLEAN NOT NULL DEFAULT false;
            ALTER TABLE plugin_kunlun_waterstation.container_configs ADD COLUMN IF NOT EXISTS out_unknown BOOLEAN NOT NULL DEFAULT false;
            ALTER TABLE plugin_kunlun_waterstation.container_configs ADD COLUMN IF NOT EXISTS counted_at TIMESTAMPTZ;
            DO $$ BEGIN
              -- Transit, inspecting, abnormal and store-damaged stock no longer exist: fold them into store-available
              -- (total unchanged) so damaged_qty only holds member returns awaiting scrap.
              IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='plugin_kunlun_waterstation' AND table_name='container_configs' AND column_name='inspecting_qty') THEN
                ALTER TABLE plugin_kunlun_waterstation.container_configs DROP CONSTRAINT IF EXISTS container_configs_check,
                  DROP CONSTRAINT IF EXISTS container_assets_balance, DROP CONSTRAINT IF EXISTS container_quantities_nonnegative;
                UPDATE plugin_kunlun_waterstation.container_configs
                SET in_station_qty=in_station_qty+in_transit_qty+inspecting_qty+abnormal_qty+damaged_qty,damaged_qty=0;
                IF to_regclass('plugin_kunlun_waterstation.container_damages') IS NOT NULL THEN
                  UPDATE plugin_kunlun_waterstation.container_configs c SET in_station_qty=c.in_station_qty-d.qty,damaged_qty=d.qty
                  FROM (SELECT tenant_id,container_type,sum(quantity)::int AS qty FROM plugin_kunlun_waterstation.container_damages WHERE status='PENDING' GROUP BY 1,2) d
                  WHERE c.tenant_id=d.tenant_id AND c.container_type=d.container_type;
                END IF;
                ALTER TABLE plugin_kunlun_waterstation.container_configs DROP COLUMN in_transit_qty,DROP COLUMN inspecting_qty,DROP COLUMN abnormal_qty;
              END IF;
              IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='plugin_kunlun_waterstation.container_configs'::regclass AND conname IN ('container_stock_balance','container_stock_balance_v2')) THEN
                ALTER TABLE plugin_kunlun_waterstation.container_configs DROP CONSTRAINT IF EXISTS container_configs_check,
                  ADD CONSTRAINT container_stock_balance CHECK(total_qty=in_station_qty+member_held_qty+damaged_qty),
                  ADD CONSTRAINT container_stock_nonnegative CHECK(total_qty>=0 AND in_station_qty>=0 AND member_held_qty>=0 AND damaged_qty>=0 AND scrapped_qty>=0);
              END IF;
              -- Stock-takes add buckets that customers hold without being registered to a member.
              IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='plugin_kunlun_waterstation.container_configs'::regclass AND conname='container_stock_balance_v2') THEN
                ALTER TABLE plugin_kunlun_waterstation.container_configs DROP CONSTRAINT IF EXISTS container_stock_balance,
                  DROP CONSTRAINT IF EXISTS container_stock_nonnegative,
                  ADD CONSTRAINT container_stock_balance_v2 CHECK(total_qty=in_station_qty+member_held_qty+damaged_qty+unregistered_out_qty),
                  ADD CONSTRAINT container_stock_nonnegative_v2 CHECK(total_qty>=0 AND in_station_qty>=0 AND member_held_qty>=0 AND damaged_qty>=0 AND scrapped_qty>=0 AND unregistered_out_qty>=0);
              END IF;
            END $$;
            CREATE TABLE IF NOT EXISTS plugin_kunlun_waterstation.container_inventory_operations (
              id UUID PRIMARY KEY, tenant_id UUID NOT NULL, operation_no VARCHAR(32) NOT NULL UNIQUE,
              idempotency_key VARCHAR(80) NOT NULL, request_hash VARCHAR(64) NOT NULL,
              container_type VARCHAR(16) NOT NULL, action VARCHAR(16) NOT NULL, source_state VARCHAR(16) NOT NULL,
              quantity INT NOT NULL, delta_total INT NOT NULL, member_id UUID,
              reason TEXT NOT NULL, operator_id UUID NOT NULL, operator_name VARCHAR(64) NOT NULL,
              before_state JSONB NOT NULL, after_state JSONB NOT NULL, receipt JSONB NOT NULL,
              created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(tenant_id,idempotency_key)
            );
            CREATE INDEX IF NOT EXISTS inventory_operations_recent ON plugin_kunlun_waterstation.container_inventory_operations(tenant_id,created_at DESC);
            WITH first_run AS (
              INSERT INTO plugin_kunlun_waterstation.finance_migrations VALUES(@tid,'reusable-bag-deposit-five-v1') ON CONFLICT DO NOTHING RETURNING 1
            )
            UPDATE plugin_kunlun_waterstation.container_configs SET unit_deposit=5
            WHERE tenant_id=@tid AND container_type='BAG' AND EXISTS(SELECT 1 FROM first_run);
            UPDATE plugin_kunlun_waterstation.staff
            SET permissions=permissions || '["kunlun.waterstation:container:inventory_manage"]'::jsonb,token_version=token_version+1
            WHERE tenant_id=@tid AND role='ADMIN' AND NOT(permissions ? 'kunlun.waterstation:container:inventory_manage');
            """, ct, ("tid", tid));
        await tx.CommitAsync(ct);
    }

    public static void MapContainerInventory(this WebApplication app)
    {
        app.MapPost("/api/containers/inventory", Execute).RequireAuthorization();
        app.MapPost("/api/containers/stocktake", Stocktake).RequireAuthorization();
        app.MapGet("/api/containers/inventory-operations", async (string? containerType, ClaimsPrincipal user, NpgsqlDataSource db, KunlunAuthRepository repo, CancellationToken ct) =>
        {
            if (!Authorized(user)) return Results.Forbid();
            if (containerType is not (null or "BUCKET" or "BAG")) throw new BusinessRuleException("容器类型无效");
            await using var conn = await db.OpenConnectionAsync(ct);
            await using var cmd = Command(conn, null, """
                SELECT o.receipt::text,COALESCE(m.name,'')
                FROM plugin_kunlun_waterstation.container_inventory_operations o
                LEFT JOIN plugin_kunlun_waterstation.members m ON m.id=o.member_id AND m.tenant_id=o.tenant_id
                WHERE o.tenant_id=@tid AND o.action IN ('RECEIVE','SCRAP','COUNT') AND (@type='' OR o.container_type=@type)
                ORDER BY o.created_at DESC,o.id DESC LIMIT 100
                """, ("tid", repo.DefaultTenantId), ("type", containerType ?? ""));
            var rows = new List<object>(); await using var r = await cmd.ExecuteReaderAsync(ct);
            while (await r.ReadAsync(ct)) rows.Add(new { operation = JsonSerializer.Deserialize<JsonElement>(r.GetString(0)), memberName = r.GetString(1) });
            return Results.Ok(rows);
        }).RequireAuthorization();
    }

    internal static async Task<InventoryBalance> ReadBalance(NpgsqlConnection conn, NpgsqlTransaction tx, Guid tid, string type, CancellationToken ct)
    {
        await using var cmd = Command(conn, tx, """
            SELECT total_qty,in_station_qty,member_held_qty,damaged_qty,scrapped_qty,unregistered_out_qty,in_station_unknown,out_unknown
            FROM plugin_kunlun_waterstation.container_configs WHERE tenant_id=@tid AND container_type=@type FOR UPDATE
            """, ("tid", tid), ("type", type));
        await using var r = await cmd.ExecuteReaderAsync(ct);
        if (!await r.ReadAsync(ct)) throw new BusinessRuleException("容器配置不存在", 404);
        return new(r.GetInt32(0),r.GetInt32(1),r.GetInt32(2),r.GetInt32(3),r.GetInt32(4),r.GetInt32(5),r.GetBoolean(6),r.GetBoolean(7));
    }

    internal static Task<int> SaveBalance(NpgsqlConnection conn, NpgsqlTransaction tx, Guid tid, string type, InventoryBalance b, CancellationToken ct) => Exec(conn, tx, """
        UPDATE plugin_kunlun_waterstation.container_configs SET total_qty=@total,in_station_qty=@available,
        member_held_qty=@held,damaged_qty=@damaged,scrapped_qty=@scrapped,unregistered_out_qty=@unregistered,
        in_station_unknown=@inUnknown,out_unknown=@outUnknown
        WHERE tenant_id=@tid AND container_type=@type
        """, ct, ("tid",tid),("type",type),("total",b.TotalQty),("available",b.InStationQty),
        ("held",b.MemberHeldQty),("damaged",b.DamagedQty),("scrapped",b.ScrappedQty),("unregistered",b.UnregisteredOutQty),
        ("inUnknown",b.InStationUnknown),("outUnknown",b.OutUnknown));

    /// <summary>
    /// Hands containers from the store to a member (delta &gt; 0) or takes empties back (delta &lt; 0). While the store
    /// count is 待核实 it cannot block a hand-over: the store figure stops at zero and the total follows the components.
    /// </summary>
    internal static async Task<bool> MoveToMembers(NpgsqlConnection conn, NpgsqlTransaction tx, Guid tid, string type, int delta, CancellationToken ct) =>
        await Exec(conn, tx, """
            UPDATE plugin_kunlun_waterstation.container_configs
            SET in_station_qty=CASE WHEN in_station_unknown THEN GREATEST(in_station_qty-@delta,0) ELSE in_station_qty-@delta END,
                member_held_qty=member_held_qty+@delta,
                total_qty=CASE WHEN in_station_unknown THEN GREATEST(in_station_qty-@delta,0) ELSE in_station_qty-@delta END
                  +member_held_qty+@delta+damaged_qty+unregistered_out_qty
            WHERE tenant_id=@tid AND container_type=@type AND (in_station_unknown OR in_station_qty-@delta>=0) AND member_held_qty+@delta>=0
            """, ct, ("tid", tid), ("type", type), ("delta", delta)) == 1;

    internal static string Hash(object value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(value, JsonOptions))));
    internal static string Json(object value) => JsonSerializer.Serialize(value, JsonOptions);

    internal static async Task<JsonElement> RecordOperation(NpgsqlConnection conn, NpgsqlTransaction tx, Guid tid, string key, string hash,
        string type, string action, string source, int qty, string reason, Guid? memberId, ClaimsPrincipal user,
        InventoryBalance before, InventoryBalance after, CancellationToken ct, object? counted = null)
    {
        var id=Guid.NewGuid(); var no="CK"+id.ToString("N")[..28];
        var actor=user.FindFirstValue("display_name")??"管理员";
        var receipt=new {id,operationNo=no,containerType=type,action,sourceState=source,quantity=qty,deltaTotal=after.TotalQty-before.TotalQty,
            memberId,reason,operatorName=actor,before,after,counted,createdAt=DateTimeOffset.UtcNow};
        var json=Json(receipt);
        await Exec(conn,tx,"""
            INSERT INTO plugin_kunlun_waterstation.container_inventory_operations
            (id,tenant_id,operation_no,idempotency_key,request_hash,container_type,action,source_state,quantity,delta_total,member_id,reason,operator_id,operator_name,before_state,after_state,receipt)
            VALUES(@id,@tid,@no,@key,@hash,@type,@action,@source,@qty,@delta,NULLIF(@member,'')::uuid,@reason,@operator,@actor,@before::jsonb,@after::jsonb,@receipt::jsonb)
            """,ct,("id",id),("tid",tid),("no",no),("key",key),("hash",hash),("type",type),("action",action),("source",source),
            ("qty",qty),("delta",after.TotalQty-before.TotalQty),("member",memberId?.ToString()??""),("reason",reason),
            ("operator",Guid.Parse(user.FindFirstValue("sub")!)),("actor",actor),("before",Json(before)),("after",Json(after)),("receipt",json));
        return JsonSerializer.Deserialize<JsonElement>(json);
    }

    private static async Task<IResult> Execute(InventoryRequest req, ClaimsPrincipal user, NpgsqlDataSource db, KunlunAuthRepository repo, CancellationToken ct)
    {
        if (!Authorized(user)) return Results.Forbid();
        if (req.ContainerType is not ("BUCKET" or "BAG") || req.Action is not ("RECEIVE" or "SCRAP"))
            throw new BusinessRuleException("库存只办理入库和报废；会员破损请到袋桶台账登记");
        if (string.IsNullOrWhiteSpace(req.Reason) || req.Reason.Length>500 || req.Quantity is <=0 or >1000000)
            throw new BusinessRuleException("请填写有效数量和不超过 500 字的原因");
        var hash=Hash(req with{Reason=req.Reason.Trim()}); var tid=repo.DefaultTenantId;
        await using var conn=await db.OpenConnectionAsync(ct); await using var tx=await conn.BeginTransactionAsync(ct);
        if(await Replay(conn,tx,tid,req.IdempotencyKey,hash,ct) is JsonElement replay)return Results.Ok(replay);
        var before=await ReadBalance(conn,tx,tid,req.ContainerType,ct); InventoryBalance after;
        try
        {
            if(req.Action=="RECEIVE")after=before with{TotalQty=checked(before.TotalQty+req.Quantity),InStationQty=checked(before.InStationQty+req.Quantity)};
            else
            {
                if(before.InStationQty<req.Quantity)throw new BusinessRuleException($"门店可用仅 {before.InStationQty} 个，报废数量不能超过；会员归还的破损请在袋桶台账办理");
                after=before with{TotalQty=before.TotalQty-req.Quantity,InStationQty=before.InStationQty-req.Quantity,ScrappedQty=checked(before.ScrappedQty+req.Quantity)};
            }
        }
        catch(OverflowException){throw new BusinessRuleException("库存数量超出允许范围");}
        await SaveBalance(conn,tx,tid,req.ContainerType,after,ct);
        var receipt=await RecordOperation(conn,tx,tid,req.IdempotencyKey,hash,req.ContainerType,req.Action,req.Action=="RECEIVE"?"EXTERNAL":"AVAILABLE",req.Quantity,req.Reason.Trim(),null,user,before,after,ct);
        await tx.CommitAsync(ct);return Results.Ok(receipt);
    }

    // Locks the request key; a retry with the same payload gets the first receipt back.
    private static async Task<JsonElement?> Replay(NpgsqlConnection conn, NpgsqlTransaction tx, Guid tid, string key, string hash, CancellationToken ct)
    {
        await LockRequest(conn,tx,tid,"inventory",key,ct);
        await using var cmd=Command(conn,tx,"SELECT request_hash,receipt::text FROM plugin_kunlun_waterstation.container_inventory_operations WHERE tenant_id=@tid AND idempotency_key=@key",("tid",tid),("key",key));
        await using var r=await cmd.ExecuteReaderAsync(ct);
        if(!await r.ReadAsync(ct))return null;
        if(r.GetString(0)!=hash)throw new BusinessRuleException("该请求标识已用于其他库存操作",409);
        return JsonSerializer.Deserialize<JsonElement>(r.GetString(1));
    }

    /// <summary>
    /// 盘点：按店员答的"店里能用的、客户手里的、要报废的"重设库存。客户手里超出会员名下登记的部分记为未登记；
    /// 答"说不清"的项目标为待核实，日常收发桶不再因它被拦下，下次盘点填上数字即恢复。
    /// </summary>
    private static async Task<IResult> Stocktake(StocktakeRequest req, ClaimsPrincipal user, NpgsqlDataSource db, KunlunAuthRepository repo, CancellationToken ct)
    {
        if(!Authorized(user))return Results.Forbid();
        if(req.ContainerType is not ("BUCKET" or "BAG"))throw new BusinessRuleException("容器类型无效");
        if(req.InStationQty is <0 or >1000000 || req.WithCustomersQty is <0 or >1000000 || req.ScrapQty is <0 or >1000000 || req.Note?.Length>500)
            throw new BusinessRuleException("请填写有效的盘点数量，备注不超过 500 字");
        var note=string.IsNullOrWhiteSpace(req.Note)?null:req.Note.Trim();
        var hash=Hash(req with{Note=note}); var tid=repo.DefaultTenantId;
        await using var conn=await db.OpenConnectionAsync(ct); await using var tx=await conn.BeginTransactionAsync(ct);
        if(await Replay(conn,tx,tid,req.IdempotencyKey,hash,ct) is JsonElement replay)return Results.Ok(replay);
        var before=await ReadBalance(conn,tx,tid,req.ContainerType,ct);
        // An unknown store count still drops the scrapped ones from the last figure, which they were part of.
        var inStation=req.InStationQty??Math.Max(before.InStationQty-req.ScrapQty,0);
        var unregistered=req.WithCustomersQty is int customers?Math.Max(customers-before.MemberHeldQty,0):0;
        InventoryBalance after;
        try
        {
            after=before with{InStationQty=inStation,UnregisteredOutQty=unregistered,InStationUnknown=req.InStationQty is null,OutUnknown=req.WithCustomersQty is null,
                ScrappedQty=checked(before.ScrappedQty+req.ScrapQty),TotalQty=checked(inStation+before.MemberHeldQty+before.DamagedQty+unregistered)};
        }
        catch(OverflowException){throw new BusinessRuleException("库存数量超出允许范围");}
        await SaveBalance(conn,tx,tid,req.ContainerType,after,ct);
        await Exec(conn,tx,"UPDATE plugin_kunlun_waterstation.container_configs SET counted_at=now() WHERE tenant_id=@tid AND container_type=@type",ct,("tid",tid),("type",req.ContainerType));
        var counted=new{inStationQty=req.InStationQty,withCustomersQty=req.WithCustomersQty,registeredHeldQty=before.MemberHeldQty,scrapQty=req.ScrapQty};
        var receipt=await RecordOperation(conn,tx,tid,req.IdempotencyKey,hash,req.ContainerType,"COUNT","COUNT",req.ScrapQty,note??"盘点",null,user,before,after,ct,counted);
        await tx.CommitAsync(ct);return Results.Ok(receipt);
    }
}
