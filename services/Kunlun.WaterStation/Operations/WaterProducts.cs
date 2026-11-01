using System.Security.Claims;
using Npgsql;
using static Kunlun.WaterStation.Operations.TicketBatches;

namespace Kunlun.WaterStation.Operations;

/// <summary>A water the station sells. Its tickets are its own; ContainerType says which reusable container (and deposit) it goes out in.</summary>
public sealed record WaterProduct(string WaterType, string Name, decimal CapacityLiters, string Packaging, decimal? RetailPrice, int DeliveryMinimum, decimal DeliveryFee, string ContainerType)
{
    /// <summary>Counted the way it is carried: buckets per bucket, bags per bag.</summary>
    public string Unit => ContainerType == "BAG" ? "袋" : "桶";
}
/// <summary>ContainerType is chosen when a product is created and fixed afterwards; updates ignore it.</summary>
public sealed record SaveWaterProduct(string Name, decimal CapacityLiters, string Packaging, decimal? RetailPrice, int DeliveryMinimum, string? ContainerType = null);

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
    private const string Columns = "water_type,name,capacity_liters,packaging,retail_price,delivery_minimum,delivery_fee,container_type";

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
            INSERT INTO plugin_kunlun_waterstation.water_products
              (tenant_id,water_type,name,capacity_liters,packaging,retail_price,delivery_minimum,delivery_fee,container_type)
            VALUES (@tid,'BUCKET_18_9L','15L 桶装水',15,'桶装',NULL,1,0,'BUCKET'),
                   (@tid,'BAG_7_5L','5L 袋装水',5,'食品级铝箔袋（10斤装）',5,5,0,'BAG')
            ON CONFLICT DO NOTHING;
            -- Products from before container types existed: the bag water always went out in reusable bags.
            UPDATE plugin_kunlun_waterstation.water_products SET container_type='BAG' WHERE tenant_id=@tid AND water_type='BAG_7_5L' AND container_type<>'BAG';
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
        new(r.GetString(0), r.GetString(1), r.GetDecimal(2), r.GetString(3), r.IsDBNull(4) ? null : r.GetDecimal(4), r.GetInt32(5), r.GetDecimal(6), r.GetString(7));

    public static async Task<WaterProduct> Read(NpgsqlConnection conn, NpgsqlTransaction? tx, Guid tid, string type, CancellationToken ct)
    {
        await using var cmd = Command(conn, tx, $"SELECT {Columns} FROM plugin_kunlun_waterstation.water_products WHERE tenant_id=@tid AND water_type=@type", ("tid", tid), ("type", type ?? ""));
        await using var r = await cmd.ExecuteReaderAsync(ct);
        if (!await r.ReadAsync(ct)) throw new BusinessRuleException("水品不存在，请先在「水品与押金标准」里添加");
        return Map(r);
    }

    private static async Task<List<WaterProduct>> List(NpgsqlConnection conn, Guid tid, CancellationToken ct)
    {
        await using var cmd = Command(conn, null, $"SELECT {Columns} FROM plugin_kunlun_waterstation.water_products WHERE tenant_id=@tid ORDER BY created_at,water_type", ("tid", tid));
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
            || req.DeliveryMinimum < 1 || req.DeliveryMinimum > 10000
            || (req.RetailPrice.HasValue && (req.RetailPrice.Value <= 0 || req.RetailPrice.Value > 99999999 || decimal.Round(req.RetailPrice.Value, 2) != req.RetailPrice.Value)))
            throw new BusinessRuleException("水品名称、规格、包装、零售价或起送数量无效");
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
            var type = "W" + Guid.NewGuid().ToString("N")[..10].ToUpperInvariant();
            await using (var cmd = Command(conn, tx, """
                INSERT INTO plugin_kunlun_waterstation.water_products(tenant_id,water_type,name,capacity_liters,packaging,retail_price,delivery_minimum,delivery_fee,container_type)
                VALUES(@tid,@type,@name,@capacity,@packaging,@retail,@minimum,0,@container)
                """, ("tid", tid), ("type", type), ("name", name), ("capacity", req.CapacityLiters), ("packaging", req.Packaging.Trim()), ("minimum", req.DeliveryMinimum), ("container", req.ContainerType)))
            {
                cmd.Parameters.Add(new NpgsqlParameter("retail", NpgsqlTypes.NpgsqlDbType.Numeric) { Value = (object?)req.RetailPrice ?? DBNull.Value });
                await cmd.ExecuteNonQueryAsync(ct);
            }
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
            await using (var cmd = Command(conn, tx, "UPDATE plugin_kunlun_waterstation.water_products SET name=@name,capacity_liters=@capacity,packaging=@packaging,retail_price=@retail,delivery_minimum=@minimum WHERE tenant_id=@tid AND water_type=@type", ("tid", tid), ("type", type), ("name", name), ("capacity", req.CapacityLiters), ("packaging", req.Packaging.Trim()), ("minimum", req.DeliveryMinimum)))
            {
                cmd.Parameters.Add(new NpgsqlParameter("retail", NpgsqlTypes.NpgsqlDbType.Numeric) { Value = (object?)req.RetailPrice ?? DBNull.Value });
                if (await cmd.ExecuteNonQueryAsync(ct) == 0) return Results.NotFound();
            }
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
            await using (var used = Command(conn, tx, """
                SELECT EXISTS(SELECT 1 FROM plugin_kunlun_waterstation.recharge_plans WHERE tenant_id=@tid AND water_type=@type)
                    OR EXISTS(SELECT 1 FROM plugin_kunlun_waterstation.ticket_batches WHERE tenant_id=@tid AND water_type=@type)
                    OR EXISTS(SELECT 1 FROM plugin_kunlun_waterstation.water_orders WHERE tenant_id=@tid AND water_type=@type)
                """, ("tid", tid), ("type", type)))
                if ((bool)(await used.ExecuteScalarAsync(ct))!) throw new BusinessRuleException("这个水品已有充值套餐、水票或水单，不能删除", 409);
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
