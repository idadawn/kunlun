using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
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
    private void Set(string key, string value)
    {
        previous[key] = Environment.GetEnvironmentVariable(key);
        Environment.SetEnvironmentVariable(key, value);
    }
    protected override void ConfigureWebHost(IWebHostBuilder builder) => builder.UseEnvironment("Testing");
    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        if (!disposing) return;
        using var conn = new NpgsqlConnection(connection); conn.Open();
        using var cmd = new NpgsqlCommand($"DROP DATABASE IF EXISTS {database} WITH (FORCE)", conn); cmd.ExecuteNonQuery();
        foreach (var (key, value) in previous) Environment.SetEnvironmentVariable(key, value);
    }
}
