using System.Security.Claims;
using Npgsql;
using static Kunlun.WaterStation.Operations.TicketBatches;

namespace Kunlun.WaterStation.Operations;

/// <summary>A water product with a dedicated container account. ContainerType is the physical kind; ContainerId identifies its deposit and inventory.</summary>
public sealed record WaterProduct(string WaterType, string Name, decimal CapacityLiters, string Packaging, decimal? RetailPrice, int DeliveryMinimum, decimal DeliveryFee, string ContainerType, string ContainerId, decimal UnitDeposit)
{
    /// <summary>Counted the way it is carried: buckets per bucket, bags per bag.</summary>
    public string Unit => ContainerType == "BAG" ? "袋" : "桶";
}
/// <summary>ContainerType is chosen when a product is created and fixed afterwards; updates ignore it.</summary>
public sealed record SaveWaterProduct(string Name, decimal CapacityLiters, string Packaging, decimal? RetailPrice, int DeliveryMinimum, string? ContainerType = null, decimal? UnitDeposit = null);

public static class WaterProducts
{
    // Legacy API keys remain stable; physical capacity is product metadata, not the key's suffix.
    public static readonly (string Id, string Name, string Water, string Mode, decimal Price, int Qty)[] PostedPlans =
    [
        ("101", "15L 桶装水 · 自提 100 元 / 16 桶", "BUCKET_18_9L", "PICKUP", 100m, 16),
        ("102", "15L 桶装水 · 自提 499 元 / 95 桶", "BUCKET_18_9L", "PICKUP", 499m, 95),
        ("103", "15L 桶装水 · 配送 100 元 / 13 桶", "BUCKET_18_9L", "DELIVERY", 100m, 13),
        ("104", "15L 桶装水 · 配送 499 元 / 70 桶", "BUCKET_18_9L", "DELIVERY", 499m, 70),
        ("105", "5L 袋装水 · 自提 100 元 / 50 袋", "BAG_7_5L", "PICKUP", 100m, 50),
        ("106", "5L 袋装水 · 自提 499 元 / 300 袋", "BAG_7_5L", "PICKUP", 499m, 300),
        ("107", "5L 袋装水 · 配送 100 元 / 40 袋", "BAG_7_5L", "DELIVERY", 100m, 40),
        ("108", "5L 袋装水 · 配送 499 元 / 220 袋", "BAG_7_5L", "DELIVERY", 499m, 220)
    ];
    public static Guid PlanId(string suffix) => Guid.Parse("30000000-0000-0000-0000-000000000" + suffix);
    private const string Columns = "p.water_type,p.name,p.capacity_liters,p.packaging,p.retail_price,p.delivery_minimum,p.delivery_fee,p.container_type,p.container_id,(SELECT c.unit_deposit FROM plugin_kunlun_waterstation.container_configs c WHERE c.tenant_id=p.tenant_id AND c.container_type=p.container_id)";

    public static async Task ApplyPostedPrices(NpgsqlConnection conn, NpgsqlTransaction tx, Guid tid, CancellationToken ct)
    {
        await Exec(conn, tx, """
            CREATE TABLE IF NOT EXISTS plugin_kunlun_waterstation.water_products (
              tenant_id UUID NOT NULL, water_type VARCHAR(24) NOT NULL, name VARCHAR(80) NOT NULL,
              capacity_liters NUMERIC(6,2) NOT NULL CHECK(capacity_liters>0), packaging VARCHAR(80) NOT NULL,
              retail_price NUMERIC(10,2) CHECK(retail_price>0), delivery_minimum INT NOT NULL CHECK(delivery_minimum>0),
              delivery_fee NUMERIC(10,2) NOT NULL CHECK(delivery_fee>=0), PRIMARY KEY(tenant_id,water_type)
            );
            ALTER TABLE plugin_kunlun_waterstation.water_products
              ADD COLUMN IF NOT EXISTS container_type VARCHAR(16) NOT NULL DEFAULT 'BUCKET' CHECK(container_type IN ('BUCKET','BAG')),
              ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
            ALTER TABLE plugin_kunlun_waterstation.water_products ADD COLUMN IF NOT EXISTS container_id VARCHAR(16);
            INSERT INTO plugin_kunlun_waterstation.water_products
              (tenant_id,water_type,name,capacity_liters,packaging,retail_price,delivery_minimum,delivery_fee,container_type,container_id)
            VALUES (@tid,'BUCKET_18_9L','15L 桶装水',15,'桶装',NULL,1,0,'BUCKET','BUCKET'),
                   (@tid,'BAG_7_5L','5L 袋装水',5,'食品级铝箔袋（10斤装）',5,5,0,'BAG','BAG')
            ON CONFLICT DO NOTHING;
            -- Products from before container types existed: the bag water always went out in reusable bags.
            UPDATE plugin_kunlun_waterstation.water_products SET container_type='BAG' WHERE tenant_id=@tid AND water_type='BAG_7_5L' AND container_type<>'BAG';
            UPDATE plugin_kunlun_waterstation.water_products SET container_id=CASE water_type
              WHEN 'BUCKET_18_9L' THEN 'BUCKET' WHEN 'BAG_7_5L' THEN 'BAG' ELSE 'C'||upper(left(md5(water_type),15)) END
              WHERE container_id IS NULL;
            ALTER TABLE plugin_kunlun_waterstation.water_products ALTER COLUMN container_id SET NOT NULL;
            CREATE UNIQUE INDEX IF NOT EXISTS water_product_container ON plugin_kunlun_waterstation.water_products(tenant_id,container_id);
            """, ct, ("tid", tid));
        var first = await Exec(conn, tx, "INSERT INTO plugin_kunlun_waterstation.finance_migrations VALUES(@tid,'posted-price-list-20261026-v1') ON CONFLICT DO NOTHING", ct, ("tid", tid));
        if (first == 0) return;
        foreach (var p in PostedPlans)
            await Exec(conn, tx, """
                UPDATE plugin_kunlun_waterstation.recharge_plans
                SET name=@name,water_type=@water,fulfill_mode=@mode,price=@price,buy_qty=@qty,gift_qty=0,updated_at=now()
                WHERE tenant_id=@tid AND id=@id
                """, ct, ("id", PlanId(p.Id)), ("tid", tid), ("name", p.Name), ("water", p.Water), ("mode", p.Mode), ("price", p.Price), ("qty", p.Qty));
    }

    private static WaterProduct Map(NpgsqlDataReader r) =>
        new(r.GetString(0), r.GetString(1), r.GetDecimal(2), r.GetString(3), r.IsDBNull(4) ? null : r.GetDecimal(4), r.GetInt32(5), r.GetDecimal(6), r.GetString(7), r.GetString(8), r.GetDecimal(9));

    public static async Task<WaterProduct> Read(NpgsqlConnection conn, NpgsqlTransaction? tx, Guid tid, string type, CancellationToken ct)
    {
        await using var cmd = Command(conn, tx, $"SELECT {Columns} FROM plugin_kunlun_waterstation.water_products p WHERE p.tenant_id=@tid AND p.water_type=@type", ("tid", tid), ("type", type ?? ""));
        await using var r = await cmd.ExecuteReaderAsync(ct);
        if (!await r.ReadAsync(ct)) throw new BusinessRuleException("水品不存在，请先在「水品与押金标准」里添加");
        return Map(r);
    }

    public static async Task<List<WaterProduct>> List(NpgsqlConnection conn, Guid tid, CancellationToken ct)
    {
        await using var cmd = Command(conn, null, $"SELECT {Columns} FROM plugin_kunlun_waterstation.water_products p WHERE p.tenant_id=@tid ORDER BY p.created_at,p.water_type", ("tid", tid));
        var products = new List<WaterProduct>();
        await using var r = await cmd.ExecuteReaderAsync(ct);
        while (await r.ReadAsync(ct)) products.Add(Map(r));
        return products;
    }

    private static bool CanManage(ClaimsPrincipal user) => user.FindFirstValue("subject_type") == "STAFF" && user.HasClaim("perm", Auth.KunlunPermissions.PlanManage);

    private static void Validate(SaveWaterProduct req)
    {
        if (string.IsNullOrWhiteSpace(req.Name) || req.Name.Trim().Length > 80 || string.IsNullOrWhiteSpace(req.Packaging) || req.Packaging.Trim().Length > 80
            || req.CapacityLiters <= 0 || req.CapacityLiters > 1000 || decimal.Round(req.CapacityLiters, 2) != req.CapacityLiters
            || (req.UnitDeposit.HasValue && (req.UnitDeposit <= 0 || req.UnitDeposit > 99999999 || decimal.Round(req.UnitDeposit.Value, 2) != req.UnitDeposit))
            || req.DeliveryMinimum < 1 || req.DeliveryMinimum > 10000
            || (req.RetailPrice.HasValue && (req.RetailPrice.Value <= 0 || req.RetailPrice.Value > 99999999 || decimal.Round(req.RetailPrice.Value, 2) != req.RetailPrice.Value)))
            throw new BusinessRuleException("水品名称、规格、包装、押金、零售价或起送数量无效");
    }

    private static async Task EnsureUniqueName(NpgsqlConnection conn, NpgsqlTransaction tx, Guid tid, string name, string? except, CancellationToken ct)
    {
        await using var cmd = Command(conn, tx, "SELECT 1 FROM plugin_kunlun_waterstation.water_products WHERE tenant_id=@tid AND lower(name)=lower(@name) AND water_type<>@except", ("tid", tid), ("name", name), ("except", except ?? ""));
        if (await cmd.ExecuteScalarAsync(ct) is not null) throw new BusinessRuleException("已有同名水品，请换个名字", 409);
    }

    public static void MapWaterProducts(this WebApplication app)
    {
        app.MapPost("/api/products", async (SaveWaterProduct req, ClaimsPrincipal user, NpgsqlDataSource db, Auth.KunlunAuthRepository repo, CancellationToken ct) =>
        {
            if (!CanManage(user)) return Results.Forbid();
            Validate(req);
            if (req.ContainerType is not ("BUCKET" or "BAG")) throw new BusinessRuleException("请选择这种水用周转桶还是周转水袋装");
            var tid = repo.DefaultTenantId; var name = req.Name.Trim();
            await using var conn = await db.OpenConnectionAsync(ct); await using var tx = await conn.BeginTransactionAsync(ct);
            await Exec(conn, tx, "SELECT pg_advisory_xact_lock(hashtextextended(@key,0))", ct, ("key", $"{tid}:water-products"));
            await EnsureUniqueName(conn, tx, tid, name, null, ct);
            if (!req.UnitDeposit.HasValue) throw new BusinessRuleException("请填写这款水配套桶袋的押金单价");
            var type = "W" + Guid.NewGuid().ToString("N")[..10].ToUpperInvariant();
            await using (var cmd = Command(conn, tx, """
                INSERT INTO plugin_kunlun_waterstation.water_products(tenant_id,water_type,name,capacity_liters,packaging,retail_price,delivery_minimum,delivery_fee,container_type,container_id)
                VALUES(@tid,@type,@name,@capacity,@packaging,@retail,@minimum,0,@container,@type)
                """, ("tid", tid), ("type", type), ("name", name), ("capacity", req.CapacityLiters), ("packaging", req.Packaging.Trim()), ("minimum", req.DeliveryMinimum), ("container", req.ContainerType)))
            {
                cmd.Parameters.Add(new NpgsqlParameter("retail", NpgsqlTypes.NpgsqlDbType.Numeric) { Value = (object?)req.RetailPrice ?? DBNull.Value });
                await cmd.ExecuteNonQueryAsync(ct);
            }
            await Exec(conn, tx, "INSERT INTO plugin_kunlun_waterstation.container_configs(tenant_id,container_type,unit_deposit,total_qty,in_station_qty,member_held_qty,damaged_qty,scrapped_qty,unregistered_out_qty) VALUES(@tid,@type,@deposit,0,0,0,0,0,0)", ct, ("tid", tid), ("type", type), ("deposit", req.UnitDeposit.Value));
            var created = await Read(conn, tx, tid, type, ct);
            await tx.CommitAsync(ct);
            return Results.Ok(created);
        }).RequireAuthorization();
        app.MapPut("/api/products/{type}", async (string type, SaveWaterProduct req, ClaimsPrincipal user, NpgsqlDataSource db, Auth.KunlunAuthRepository repo, CancellationToken ct) =>
        {
            if (!CanManage(user)) return Results.Forbid();
            Validate(req);
            var tid = repo.DefaultTenantId; var name = req.Name.Trim();
            await using var conn = await db.OpenConnectionAsync(ct); await using var tx = await conn.BeginTransactionAsync(ct);
            await Exec(conn, tx, "SELECT pg_advisory_xact_lock(hashtextextended(@key,0))", ct, ("key", $"{tid}:water-products"));
            await EnsureUniqueName(conn, tx, tid, name, type, ct);
            var current = await Read(conn, tx, tid, type, ct);
            if (current.CapacityLiters != req.CapacityLiters)
                throw new BusinessRuleException("配套桶袋的容量与水品固定匹配，变更规格请新增水品");
            await using (var cmd = Command(conn, tx, "UPDATE plugin_kunlun_waterstation.water_products SET name=@name,capacity_liters=@capacity,packaging=@packaging,retail_price=@retail,delivery_minimum=@minimum WHERE tenant_id=@tid AND water_type=@type", ("tid", tid), ("type", type), ("name", name), ("capacity", req.CapacityLiters), ("packaging", req.Packaging.Trim()), ("minimum", req.DeliveryMinimum)))
            {
                cmd.Parameters.Add(new NpgsqlParameter("retail", NpgsqlTypes.NpgsqlDbType.Numeric) { Value = (object?)req.RetailPrice ?? DBNull.Value });
                if (await cmd.ExecuteNonQueryAsync(ct) == 0) return Results.NotFound();
            }
            if (req.UnitDeposit.HasValue)
                await Exec(conn, tx, "UPDATE plugin_kunlun_waterstation.container_configs SET unit_deposit=@deposit WHERE tenant_id=@tid AND container_type=@id", ct, ("deposit", req.UnitDeposit.Value), ("tid", tid), ("id", current.ContainerId));
            var saved = await Read(conn, tx, tid, type, ct);
            await tx.CommitAsync(ct);
            return Results.Ok(saved);
        }).RequireAuthorization();
        // Only a product nothing refers to yet can go: one added by mistake. Anything with plans, tickets or orders stays for the books.
        app.MapDelete("/api/products/{type}", async (string type, ClaimsPrincipal user, NpgsqlDataSource db, Auth.KunlunAuthRepository repo, CancellationToken ct) =>
        {
            if (!CanManage(user)) return Results.Forbid();
            var tid = repo.DefaultTenantId;
            await using var conn = await db.OpenConnectionAsync(ct); await using var tx = await conn.BeginTransactionAsync(ct);
            await Exec(conn, tx, "SELECT pg_advisory_xact_lock(hashtextextended(@key,0))", ct, ("key", $"{tid}:water-products"));
            await using (var locked = Command(conn, tx, "SELECT 1 FROM plugin_kunlun_waterstation.water_products WHERE tenant_id=@tid AND water_type=@type FOR UPDATE", ("tid", tid), ("type", type)))
                if (await locked.ExecuteScalarAsync(ct) is null) return Results.NotFound();
            await using (var used = Command(conn, tx, """
                SELECT EXISTS(SELECT 1 FROM plugin_kunlun_waterstation.recharge_plans WHERE tenant_id=@tid AND water_type=@type)
                    OR EXISTS(SELECT 1 FROM plugin_kunlun_waterstation.ticket_batches WHERE tenant_id=@tid AND water_type=@type)
                    OR EXISTS(SELECT 1 FROM plugin_kunlun_waterstation.water_orders WHERE tenant_id=@tid AND water_type=@type)
                """, ("tid", tid), ("type", type)))
                if ((bool)(await used.ExecuteScalarAsync(ct))!) throw new BusinessRuleException("这个水品已有充值套餐、水票或水单，不能删除", 409);
            await using (var stock = Command(conn, tx, """
                SELECT 1 FROM plugin_kunlun_waterstation.container_configs c
                JOIN plugin_kunlun_waterstation.water_products p ON p.tenant_id=c.tenant_id AND p.container_id=c.container_type
                WHERE p.tenant_id=@tid AND p.water_type=@type AND (c.total_qty>0 OR c.scrapped_qty>0
                  OR EXISTS(SELECT 1 FROM plugin_kunlun_waterstation.deposit_lots l WHERE l.tenant_id=c.tenant_id AND l.container_type=c.container_type)
                  OR EXISTS(SELECT 1 FROM plugin_kunlun_waterstation.container_ledgers l WHERE l.tenant_id=c.tenant_id AND l.container_type=c.container_type)
                  OR EXISTS(SELECT 1 FROM plugin_kunlun_waterstation.container_inventory_operations o WHERE o.tenant_id=c.tenant_id AND o.container_type=c.container_type))
                """, ("tid", tid), ("type", type)))
                if (await stock.ExecuteScalarAsync(ct) is not null) throw new BusinessRuleException("配套桶袋已有库存、押金或周转记录，不能删除水品", 409);
            await Exec(conn, tx, "DELETE FROM plugin_kunlun_waterstation.member_container_holdings h USING plugin_kunlun_waterstation.water_products p WHERE h.tenant_id=p.tenant_id AND h.container_type=p.container_id AND p.tenant_id=@tid AND p.water_type=@type AND h.quantity=0", ct, ("tid", tid), ("type", type));
            await Exec(conn, tx, "DELETE FROM plugin_kunlun_waterstation.container_configs c USING plugin_kunlun_waterstation.water_products p WHERE c.tenant_id=p.tenant_id AND c.container_type=p.container_id AND p.tenant_id=@tid AND p.water_type=@type", ct, ("tid", tid), ("type", type));
            if (await Exec(conn, tx, "DELETE FROM plugin_kunlun_waterstation.water_products WHERE tenant_id=@tid AND water_type=@type", ct, ("tid", tid), ("type", type)) == 0) return Results.NotFound();
            await tx.CommitAsync(ct);
            return Results.Ok(new { waterType = type, deleted = true });
        }).RequireAuthorization();
        app.MapGet("/api/products", async (NpgsqlDataSource db, Auth.KunlunAuthRepository repo, CancellationToken ct) =>
        {
            await using var conn = await db.OpenConnectionAsync(ct);
            return Results.Ok(await List(conn, repo.DefaultTenantId, ct));
        }).RequireAuthorization();
    }
}
