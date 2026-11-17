using System.Net;
using System.Text;
using System.Text.Json;
using Kunlun.WaterStation.Operations;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace Kunlun.WaterStation.Tests;

/// <summary>
/// Android 员工端、会员端检查更新：后端拿服务器上的蒲公英 API Key 代查，App 只拿到版本号、更新说明和安装页地址，
/// Key 和蒲公英带 Key 的下载地址都不交给 App。不用登录。
/// </summary>
[Collection("KunlunIntegration")]
public sealed class AppUpdateTests(TestHost host)
{
    private const string ApiKey = "pgyer-test-api-key";
    private const string StaffAppKey = "bb8f9af71652e557498e6caadee6c687", MemberAppKey = "f34d2567defffb476f882a429789e14b";

    /// <summary>Stands in for pgyer: answers each check with <see cref="Reply"/> and keeps what it was sent.</summary>
    private sealed class FakePgyer : HttpMessageHandler
    {
        public readonly List<(Uri Uri, Dictionary<string, string> Form)> Checks = [];
        public Func<HttpResponseMessage> Reply = () => throw new InvalidOperationException("No reply set");
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            var form = (await request.Content!.ReadAsStringAsync(ct)).Split('&').Select(p => p.Split('='))
                .ToDictionary(p => WebUtility.UrlDecode(p[0]), p => WebUtility.UrlDecode(p[1]));
            Checks.Add((request.RequestUri!, form));
            return Reply();
        }
    }

    private static HttpResponseMessage Json(object body) =>
        new(HttpStatusCode.OK) { Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json") };

    /// <summary>pgyer's answer when build 2 (1.1.0) is the newest, shaped like its documented app/check reply.</summary>
    private static Dictionary<string, object?> Build2() => new()
    {
        ["buildBuildVersion"] = 3,
        ["forceUpdateVersion"] = "",
        ["forceUpdateVersionNo"] = "",
        ["needForceUpdate"] = false,
        ["downloadURL"] = $"https://www.pgyer.com/app/installUpdate/abc123?_api_key={ApiKey}",
        ["buildHaveNewVersion"] = true,
        ["buildVersionNo"] = "2",
        ["buildVersion"] = "1.1.0",
        ["buildShortcutUrl"] = "Lvq1",
        ["buildUpdateDescription"] = "新增自动更新\r\n修正若干问题",
        ["appURl"] = "https://www.pgyer.com/Lvq1",
    };

    private static Func<HttpResponseMessage> Answer(Dictionary<string, object?> data) => () => Json(new { code = 0, message = "", data });

    private WebApplicationFactory<Program> WithPgyer(FakePgyer pgyer) => host.WithWebHostBuilder(b =>
    {
        b.ConfigureAppConfiguration((_, c) => c.AddInMemoryCollection(new Dictionary<string, string?> { ["Kunlun:Pgyer:ApiKey"] = ApiKey }));
        b.ConfigureTestServices(s => s.AddHttpClient(AppUpdates.PgyerClient).ConfigurePrimaryHttpMessageHandler(() => pgyer));
    });

    private static async Task<(HttpStatusCode Status, string Body)> Get(HttpClient client, string path)
    {
        using var response = await client.GetAsync(path);
        return (response.StatusCode, await response.Content.ReadAsStringAsync());
    }

    private static async Task<JsonElement> Check(HttpClient client, string app, int versionCode)
    {
        var (status, body) = await Get(client, $"/api/app-update/android/{app}?versionCode={versionCode}");
        Assert.True(status == HttpStatusCode.OK, $"{status}: {body}");
        Assert.DoesNotContain(ApiKey, body);
        Assert.DoesNotContain("installUpdate", body);
        return JsonSerializer.Deserialize<JsonElement>(body);
    }

    [Fact]
    public async Task Without_A_Pgyer_Key_On_The_Server_Phones_Hear_There_Is_No_Update()
    {
        using var phone = host.CreateClient();
        Assert.False((await Check(phone, "staff", 1)).GetProperty("hasUpdate").GetBoolean());
        Assert.False((await Check(phone, "member", 1)).GetProperty("hasUpdate").GetBoolean());

        Assert.Equal(HttpStatusCode.NotFound, (await Get(phone, "/api/app-update/android/admin?versionCode=1")).Status);
        foreach (var bad in new[] { "", "?versionCode=0", "?versionCode=-1", "?versionCode=abc" })
            Assert.Equal(HttpStatusCode.BadRequest, (await Get(phone, "/api/app-update/android/staff" + bad)).Status);
    }

    [Fact]
    public async Task A_Newer_Build_On_Pgyer_Is_Offered_With_Its_Install_Page_And_Notes()
    {
        var pgyer = new FakePgyer { Reply = Answer(Build2()) };
        using var server = WithPgyer(pgyer);
        using var phone = server.CreateClient();

        var update = await Check(phone, "staff", 1);
        Assert.True(update.GetProperty("hasUpdate").GetBoolean());
        Assert.Equal("1.1.0", update.GetProperty("versionName").GetString());
        Assert.Equal(2, update.GetProperty("versionCode").GetInt32());
        Assert.Equal("新增自动更新\n修正若干问题", update.GetProperty("notes").GetString());
        Assert.False(update.GetProperty("force").GetBoolean());
        Assert.Equal("https://www.pgyer.com/Lvq1", update.GetProperty("url").GetString());
        var (uri, form) = Assert.Single(pgyer.Checks);
        Assert.Equal("https://www.pgyer.com/apiv2/app/check", uri.ToString());
        Assert.Equal(new Dictionary<string, string> { ["_api_key"] = ApiKey, ["appKey"] = StaffAppKey, ["buildVersion"] = "1" }, form);

        // The answer is kept for a while: phones on the same version do not each send pgyer a request.
        Assert.True((await Check(phone, "staff", 1)).GetProperty("hasUpdate").GetBoolean());
        Assert.Single(pgyer.Checks);
        Assert.True((await Check(phone, "member", 1)).GetProperty("hasUpdate").GetBoolean());
        Assert.Equal(MemberAppKey, pgyer.Checks[^1].Form["appKey"]);

        // The installed build is never offered again, even when pgyer still calls it new.
        Assert.False((await Check(phone, "staff", 2)).GetProperty("hasUpdate").GetBoolean());
        Assert.False((await Check(phone, "staff", 5)).GetProperty("hasUpdate").GetBoolean());
        // A build pgyer does not call new is not offered either.
        var notNew = Build2(); notNew["buildHaveNewVersion"] = false; notNew["buildVersionNo"] = "9";
        pgyer.Reply = Answer(notNew);
        Assert.False((await Check(phone, "member", 2)).GetProperty("hasUpdate").GetBoolean());

        // A forced update; an install page on another host falls back to the short link; empty notes and version name are left out.
        var forced = Build2();
        forced["needForceUpdate"] = true; forced["appURl"] = "https://pgyer.example.com/Lvq1"; forced["buildVersionNo"] = 7;
        forced["buildUpdateDescription"] = " "; forced["buildVersion"] = "";
        pgyer.Reply = Answer(forced);
        var force = await Check(phone, "staff", 3);
        Assert.True(force.GetProperty("force").GetBoolean());
        Assert.Equal(7, force.GetProperty("versionCode").GetInt32());
        Assert.Equal("https://www.pgyer.com/Lvq1", force.GetProperty("url").GetString());
        Assert.Equal(JsonValueKind.Null, force.GetProperty("notes").ValueKind);
        Assert.Equal(JsonValueKind.Null, force.GetProperty("versionName").ValueKind);

        // Without a pgyer page to open there is nothing to offer: only HTTPS pages on pgyer.com, and never with a query.
        foreach (var (appUrl, shortcut, versionCode) in new (string?, string?, int)[]
        {
            (null, null, 4), ("http://www.pgyer.com/Lvq1", null, 5), ("https://www.pgyer.com@evil.example/Lvq1", "../x", 6),
        })
        {
            var noPage = Build2(); noPage["buildVersionNo"] = "9"; noPage["appURl"] = appUrl; noPage["buildShortcutUrl"] = shortcut;
            pgyer.Reply = Answer(noPage);
            Assert.False((await Check(phone, "member", versionCode)).GetProperty("hasUpdate").GetBoolean());
        }
        var withQuery = Build2(); withQuery["buildVersionNo"] = "9"; withQuery["appURl"] = "https://www.pgyer.com/Lvq1?_api_key=leak";
        pgyer.Reply = Answer(withQuery);
        Assert.Equal("https://www.pgyer.com/Lvq1", (await Check(phone, "member", 8)).GetProperty("url").GetString());
    }

    [Fact]
    public async Task When_Pgyer_Fails_Phones_Hear_There_Is_No_Update()
    {
        var pgyer = new FakePgyer();
        using var server = WithPgyer(pgyer);
        using var phone = server.CreateClient();
        var failures = new Func<HttpResponseMessage>[]
        {
            () => Json(new { code = 1098, message = "超过调用次数限制" }),
            () => new HttpResponseMessage(HttpStatusCode.BadGateway),
            () => new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("<html>", Encoding.UTF8, "text/html") },
            () => throw new HttpRequestException("connection refused"),
            () => Json(new { code = 0, message = "", data = "unexpected" }),
        };
        for (var i = 0; i < failures.Length; i++)
        {
            pgyer.Reply = failures[i];
            Assert.False((await Check(phone, "staff", i + 1)).GetProperty("hasUpdate").GetBoolean());
        }
        Assert.Equal(failures.Length, pgyer.Checks.Count);
    }
}
