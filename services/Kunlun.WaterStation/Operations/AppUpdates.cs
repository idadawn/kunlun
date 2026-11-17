using System.Globalization;
using System.Text.Json;
using Microsoft.Extensions.Caching.Memory;

namespace Kunlun.WaterStation.Operations;

/// <summary>
/// Android 员工端、会员端检查更新。两个 App 在蒲公英（pgyer.com）分发；蒲公英的检查更新接口要用账号 API Key，
/// 这个 Key 还能上传、删除应用，不能打进 APK，所以由后端代查：App 带上自己的 versionCode 来问，后端用服务器上的
/// <c>Kunlun:Pgyer:ApiKey</c> 查蒲公英，只回新版本号、更新说明、是否强制更新和蒲公英的安装页地址。
/// 没配 Key、蒲公英出错或回复不完整时一律回「没有更新」，App 照常使用。
/// </summary>
public static class AppUpdates
{
    public const string PgyerClient = "pgyer";

    /// <summary>Each app's App Key on pgyer. They are not secret: checking still needs the account API key.</summary>
    private static readonly Dictionary<string, (string Setting, string AppKey)> Apps = new()
    {
        ["staff"] = ("Kunlun:Pgyer:StaffAppKey", "bb8f9af71652e557498e6caadee6c687"),
        ["member"] = ("Kunlun:Pgyer:MemberAppKey", "f34d2567defffb476f882a429789e14b"),
    };

    // pgyer caps calls per hour; one answer per app and installed version serves every phone for a while.
    private static readonly TimeSpan Keep = TimeSpan.FromMinutes(10), KeepFailure = TimeSpan.FromMinutes(1);
    private const int MaxNotes = 2000;

    public sealed record Update(bool HasUpdate, string? VersionName = null, int? VersionCode = null, string? Notes = null, bool Force = false, string? Url = null);
    private static readonly Update None = new(false);

    public static IServiceCollection AddAppUpdates(this IServiceCollection services)
    {
        services.AddMemoryCache();
        services.AddHttpClient(PgyerClient, (sp, client) =>
        {
            // Kunlun:Pgyer:BaseUrl is for pointing a local run at a stand-in; the default is pgyer's documented API host.
            client.BaseAddress = new Uri(sp.GetRequiredService<IConfiguration>()["Kunlun:Pgyer:BaseUrl"] ?? "https://www.pgyer.com/");
            client.Timeout = TimeSpan.FromSeconds(10);
        });
        return services;
    }

    public static void MapAppUpdates(this WebApplication app) =>
        app.MapGet("/api/app-update/android/{name}", async (string name, int? versionCode, IConfiguration config, IMemoryCache cache,
            IHttpClientFactory http, ILoggerFactory logs, CancellationToken ct) =>
        {
            if (!Apps.TryGetValue(name, out var target)) return Results.NotFound();
            if (versionCode is not > 0) return Results.BadRequest(new { error = "versionCode 必须是正整数" });
            var apiKey = config["Kunlun:Pgyer:ApiKey"]?.Trim();
            if (string.IsNullOrEmpty(apiKey)) return Results.Ok(None);
            var appKey = config[target.Setting] is { Length: > 0 } configured ? configured : target.AppKey;
            var installed = versionCode.Value;
            var update = await cache.GetOrCreateAsync((typeof(AppUpdates), name, installed), async entry =>
            {
                var (result, keep) = await Check(http.CreateClient(PgyerClient), apiKey, appKey, installed, logs.CreateLogger(typeof(AppUpdates)), ct);
                entry.AbsoluteExpirationRelativeToNow = keep;
                return result;
            });
            return Results.Ok(update ?? None);
        }).AllowAnonymous().RequireRateLimiting("app-update");

    /// <summary>Asks pgyer about the newest build for one installed version; a failure is kept only briefly.</summary>
    private static async Task<(Update, TimeSpan)> Check(HttpClient client, string apiKey, string appKey, int installed, ILogger log, CancellationToken ct)
    {
        try
        {
            using var form = new FormUrlEncodedContent(new Dictionary<string, string>
            {
                ["_api_key"] = apiKey,
                ["appKey"] = appKey,
                // pgyer compares this with the build's versionCode (its "Build 版本号").
                ["buildVersion"] = installed.ToString(CultureInfo.InvariantCulture),
            });
            using var response = await client.PostAsync("apiv2/app/check", form, ct);
            if (!response.IsSuccessStatusCode)
            {
                log.LogWarning("Pgyer update check for {AppKey} returned HTTP {Status}", appKey, (int)response.StatusCode);
                return (None, KeepFailure);
            }
            using var json = await JsonDocument.ParseAsync(await response.Content.ReadAsStreamAsync(ct), cancellationToken: ct);
            var root = json.RootElement;
            if (Text(root, "code") != "0" || !root.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Object)
            {
                // Only pgyer's code and message are logged: its data carries a download address that includes the API key.
                log.LogWarning("Pgyer update check for {AppKey} failed: {Code} {Message}", appKey, Text(root, "code"), Text(root, "message"));
                return (None, KeepFailure);
            }
            return (Read(data, installed, appKey, log), Keep);
        }
        catch (Exception e) when (e is HttpRequestException or JsonException || (e is TaskCanceledException && !ct.IsCancellationRequested))
        {
            log.LogWarning("Pgyer update check for {AppKey} failed: {Error}", appKey, $"{e.GetType().Name}: {e.Message}");
            return (None, KeepFailure);
        }
    }

    private static Update Read(JsonElement data, int installed, string appKey, ILogger log)
    {
        // Offer a build only when pgyer calls it new and its versionCode is above the installed one, so the build just
        // installed is never offered again whatever pgyer says.
        if (!Flag(data, "buildHaveNewVersion")
            || !int.TryParse(Text(data, "buildVersionNo"), NumberStyles.None, CultureInfo.InvariantCulture, out var latest) || latest <= installed)
            return None;
        // The app opens pgyer's install page; downloadURL is never passed on, since it carries the API key.
        var url = PageUrl(Text(data, "appURl"), Text(data, "buildShortcutUrl"));
        if (url is null)
        {
            log.LogWarning("Pgyer update check for {AppKey} found build {Build} without a usable install page", appKey, latest);
            return None;
        }
        var notes = Text(data, "buildUpdateDescription")?.Replace("\r\n", "\n").Trim();
        if (notes?.Length > MaxNotes) notes = notes[..MaxNotes];
        var versionName = Text(data, "buildVersion")?.Trim();
        return new Update(true, string.IsNullOrEmpty(versionName) ? null : versionName, latest,
            string.IsNullOrEmpty(notes) ? null : notes, Flag(data, "needForceUpdate"), url);
    }

    /// <summary>
    /// pgyer's install page for the app, over HTTPS on pgyer.com and without a query; otherwise null. pgyer gives both
    /// addresses in full (e.g. <c>https://www.pgyer.com/&lt;page id&gt;</c>, which redirects to the short link).
    /// </summary>
    internal static string? PageUrl(string? appUrl, string? shortcut) => Page(appUrl) ?? Page(shortcut);

    private static string? Page(string? url) =>
        Uri.TryCreate(url, UriKind.Absolute, out var uri) && uri.Scheme == Uri.UriSchemeHttps && uri.IsDefaultPort
        && uri.UserInfo.Length == 0 && (uri.Host is "www.pgyer.com" or "pgyer.com") && uri.AbsolutePath.Length > 1
            ? uri.GetLeftPart(UriPartial.Path)
            : null;

    private static string? Text(JsonElement element, string name) =>
        element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var value)
            ? value.ValueKind switch { JsonValueKind.String => value.GetString(), JsonValueKind.Number => value.GetRawText(), _ => null }
            : null;

    private static bool Flag(JsonElement element, string name) =>
        element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var value)
        && (value.ValueKind == JsonValueKind.True || ((value.ValueKind is JsonValueKind.String or JsonValueKind.Number) && value.ToString() is "true" or "1"));
}
