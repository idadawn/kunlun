using System.Text.Json;
using Kunlun.WaterStation.Auth;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Npgsql;

namespace Kunlun.WaterStation.Tests;

public sealed class TestHost : WebApplicationFactory<Program>
{
    public static readonly string Password = Guid.NewGuid().ToString("N");
    private readonly string connection;
    private readonly string database = "kunlun_test_" + Guid.NewGuid().ToString("N");
    private readonly Dictionary<string, string?> previous = new();
    public TestHost()
    {
        connection = Environment.GetEnvironmentVariable("KUNLUN_TEST_DATABASE_URL")
            ?? throw new InvalidOperationException("Set KUNLUN_TEST_DATABASE_URL to an isolated test database. Tests never use .env.local.");
        var cs = new NpgsqlConnectionStringBuilder(connection);
        if (cs.Database is null || !cs.Database.Contains("test", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Test database name must contain 'test'.");
        using var conn = new NpgsqlConnection(connection); conn.Open();
        using var cmd = new NpgsqlCommand($"CREATE DATABASE {database}", conn); cmd.ExecuteNonQuery();
        cs.Database = database;
        Set("ConnectionStrings__Kunlun", cs.ConnectionString);
        Set("Kunlun__Jwt__SigningKey", Guid.NewGuid().ToString("N") + Guid.NewGuid().ToString("N"));
        Set("Kunlun__SeedDemoData", "true"); Set("Kunlun__SeedPassword", Password);
    }
    /// <summary>This run's own database, for seeding history the API no longer creates (e.g. gift tickets from retired coupons).</summary>
    public NpgsqlConnection OpenDatabase()
    {
        var conn = new NpgsqlConnection(new NpgsqlConnectionStringBuilder(connection) { Database = database }.ConnectionString);
        conn.Open();
        return conn;
    }
    private void Set(string key, string value)
    {
        previous[key] = Environment.GetEnvironmentVariable(key);
        Environment.SetEnvironmentVariable(key, value);
    }
    protected override void ConfigureWebHost(IWebHostBuilder builder) => builder.UseEnvironment("Testing");
    /// <summary>
    /// Most tests take deposits and register damage expecting them settled at once, as before those reviews existed, so this
    /// run starts with both switches off; the tests about these reviews switch them on and back off themselves.
    /// </summary>
    protected override IHost CreateHost(IHostBuilder builder)
    {
        var host = base.CreateHost(builder);
        using var conn = OpenDatabase();
        using var cmd = new NpgsqlCommand("""
            INSERT INTO plugin_kunlun_waterstation.review_settings(tenant_id, deposit_review, damage_review) VALUES(@tid, FALSE, FALSE)
            ON CONFLICT (tenant_id) DO UPDATE SET deposit_review = FALSE, damage_review = FALSE
            """, conn);
        cmd.Parameters.AddWithValue("tid", host.Services.GetRequiredService<KunlunAuthRepository>().DefaultTenantId);
        cmd.ExecuteNonQuery();
        return host;
    }
    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        if (!disposing) return;
        using var conn = new NpgsqlConnection(connection); conn.Open();
        using var cmd = new NpgsqlCommand($"DROP DATABASE IF EXISTS {database} WITH (FORCE)", conn); cmd.ExecuteNonQuery();
        foreach (var (key, value) in previous) Environment.SetEnvironmentVariable(key, value);
    }
}

public static class ProfileTickets
{
    /// <summary>A member's available (or reserved) tickets of one water product and mode, from a profile or member row; none means zero.</summary>
    public static int Tickets(this JsonElement member, string water, string mode, bool reserved = false) =>
        member.GetProperty("tickets").EnumerateArray()
            .Where(t => t.GetProperty("waterType").GetString() == water && t.GetProperty("fulfillMode").GetString() == mode)
            .Select(t => t.GetProperty(reserved ? "reserved" : "available").GetInt32()).SingleOrDefault();
}
