using System.Security.Claims;
using Npgsql;
using static Kunlun.WaterStation.Operations.TicketBatches;

namespace Kunlun.WaterStation.Operations;

public sealed record WaterProduct(string WaterType, string Name, decimal CapacityLiters, string Packaging, decimal? RetailPrice, int DeliveryMinimum, decimal DeliveryFee);
public sealed record SaveWaterProduct(string Name, decimal CapacityLiters, string Packaging, decimal? RetailPrice, int DeliveryMinimum);

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

    public static async Task ApplyPostedPrices(NpgsqlConnection conn, NpgsqlTransaction tx, Guid tid, CancellationToken ct)
    {
        await Exec(conn, tx, """
            CREATE TABLE IF NOT EXISTS plugin_kunlun_waterstation.water_products (
              tenant_id UUID NOT NULL, water_type VARCHAR(24) NOT NULL, name VARCHAR(80) NOT NULL,
              capacity_liters NUMERIC(6,2) NOT NULL CHECK(capacity_liters>0), packaging VARCHAR(80) NOT NULL,
              retail_price NUMERIC(10,2) CHECK(retail_price>0), delivery_minimum INT NOT NULL CHECK(delivery_minimum>0),
              delivery_fee NUMERIC(10,2) NOT NULL CHECK(delivery_fee>=0), PRIMARY KEY(tenant_id,water_type)
            );
            INSERT INTO plugin_kunlun_waterstation.water_products
              (tenant_id,water_type,name,capacity_liters,packaging,retail_price,delivery_minimum,delivery_fee)
            VALUES (@tid,'BUCKET_18_9L','15L 桶装水',15,'桶装',NULL,1,0),
                   (@tid,'BAG_7_5L','5L 袋装水',5,'食品级铝箔袋（10斤装）',5,5,0)
            ON CONFLICT DO NOTHING;
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

    public static async Task<WaterProduct> Read(NpgsqlConnection conn, NpgsqlTransaction? tx, Guid tid, string type, CancellationToken ct)
    {
        await using var cmd = Command(conn, tx, "SELECT water_type,name,capacity_liters,packaging,retail_price,delivery_minimum,delivery_fee FROM plugin_kunlun_waterstation.water_products WHERE tenant_id=@tid AND water_type=@type", ("tid", tid), ("type", type));
        await using var r = await cmd.ExecuteReaderAsync(ct);
        if (!await r.ReadAsync(ct)) throw new BusinessRuleException("水品配置不存在");
        return new WaterProduct(r.GetString(0), r.GetString(1), r.GetDecimal(2), r.GetString(3), r.IsDBNull(4) ? null : r.GetDecimal(4), r.GetInt32(5), r.GetDecimal(6));
    }
    public static void MapWaterProducts(this WebApplication app)
    {
        app.MapPut("/api/products/{type}", async (string type, SaveWaterProduct req, ClaimsPrincipal user, NpgsqlDataSource db, Auth.KunlunAuthRepository repo, CancellationToken ct) =>
        {
            if (user.FindFirstValue("subject_type") != "STAFF" || !user.HasClaim("perm", Auth.KunlunPermissions.PlanManage)) return Results.Forbid();
            if (type is not ("BUCKET_18_9L" or "BAG_7_5L") || string.IsNullOrWhiteSpace(req.Name) || req.Name.Length > 80 || string.IsNullOrWhiteSpace(req.Packaging) || req.Packaging.Length > 80
                || req.CapacityLiters <= 0 || req.CapacityLiters > 1000 || decimal.Round(req.CapacityLiters, 2) != req.CapacityLiters
                || req.DeliveryMinimum < 1 || req.DeliveryMinimum > 10000
                || (req.RetailPrice.HasValue && (req.RetailPrice.Value <= 0 || req.RetailPrice.Value > 99999999 || decimal.Round(req.RetailPrice.Value, 2) != req.RetailPrice.Value)))
                throw new BusinessRuleException("水品名称、规格、包装、零售价或起送数量无效");
            await using var conn = await db.OpenConnectionAsync(ct);
            await using var cmd = Command(conn, null, "UPDATE plugin_kunlun_waterstation.water_products SET name=@name,capacity_liters=@capacity,packaging=@packaging,retail_price=@retail,delivery_minimum=@minimum WHERE tenant_id=@tid AND water_type=@type", ("tid", repo.DefaultTenantId), ("type", type), ("name", req.Name.Trim()), ("capacity", req.CapacityLiters), ("packaging", req.Packaging.Trim()), ("minimum", req.DeliveryMinimum));
            cmd.Parameters.Add(new NpgsqlParameter("retail", NpgsqlTypes.NpgsqlDbType.Numeric) { Value = (object?)req.RetailPrice ?? DBNull.Value });
            if (await cmd.ExecuteNonQueryAsync(ct) == 0) return Results.NotFound();
            return Results.Ok(await Read(conn, null, repo.DefaultTenantId, type, ct));
        }).RequireAuthorization();
        app.MapGet("/api/products", async (NpgsqlDataSource db, Auth.KunlunAuthRepository repo, CancellationToken ct) =>
        {
            await using var conn = await db.OpenConnectionAsync(ct);
            var products = new List<WaterProduct>();
            foreach (var type in new[] { "BAG_7_5L", "BUCKET_18_9L" }) products.Add(await Read(conn, null, repo.DefaultTenantId, type, ct));
            return Results.Ok(products);
        }).RequireAuthorization();
    }
}
