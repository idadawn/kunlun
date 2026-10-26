using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.RegularExpressions;
using Kunlun.WaterStation.Auth;
using Kunlun.WaterStation.Operations;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using Xunit;

namespace Kunlun.WaterStation.Tests;

[Collection("KunlunIntegration")]
public sealed class BusinessNumberTests(TestHost host)
{
    private const int Burst = 40, MemberCount = 8;
    private static int phoneSeq = Random.Shared.Next(10000000, 89999999);
    private static string Key() => Guid.NewGuid().ToString("N");
    private static string Phone() => $"134{Interlocked.Increment(ref phoneSeq)}";
    private static async Task<JsonElement> Ok(HttpResponseMessage response)
    {
        var body = await response.Content.ReadAsStringAsync(); Assert.True(response.IsSuccessStatusCode, $"{response.StatusCode}: {body}");
        return JsonSerializer.Deserialize<JsonElement>(body);
    }
    private async Task<HttpClient> Staff()
    {
        var c = host.CreateClient(); var s = await Ok(await c.PostAsJsonAsync("/api/auth/staff/login", new StaffLoginRequest("YG0001", TestHost.Password)));
        c.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", s.GetProperty("accessToken").GetString()); return c;
    }
    private static async Task<JsonElement> Member(HttpClient c, string? phone = null) =>
        await Ok(await c.PostAsJsonAsync("/api/members", new CreateMemberRequest("编号验收", phone ?? Phone(), null, null)));
    private static async Task<Guid[]> CreateMembers(HttpClient c)
    {
        var ids = new Guid[MemberCount];
        for (var i = 0; i < MemberCount; i++) ids[i] = (await Member(c)).GetProperty("id").GetGuid();
        return ids;
    }
    private static int Seq(string memberNo) => int.Parse(memberNo["No.".Length..]);
    // Fires every request at once and returns the named number from each response.
    private static async Task<string[]> All(int count, Func<int, Task<HttpResponseMessage>> send, string field) =>
        (await Task.WhenAll(Enumerable.Range(0, count).Select(async i => (await Ok(await send(i))).GetProperty(field).GetString()!))).ToArray();
    // Numbers from one counter form a single gapless run; a burst straddling UTC midnight splits into one run per day.
    private static void AssertGapless(string[] numbers, string pattern)
    {
        Assert.All(numbers, n => Assert.Matches(pattern, n));
        Assert.Equal(numbers.Length, numbers.Distinct().Count());
        foreach (var day in numbers.Select(n => Regex.Match(n, pattern)).GroupBy(m => m.Groups["day"].Value))
        {
            var seqs = day.Select(m => long.Parse(m.Groups["seq"].Value)).ToArray();
            Assert.Equal(seqs.Length - 1, seqs.Max() - seqs.Min());
        }
    }

    [Fact]
    public async Task Concurrent_Member_Creation_Gets_Gapless_Numbers()
    {
        using var c = await Staff();
        var numbers = await All(Burst, _ => c.PostAsJsonAsync("/api/members", new CreateMemberRequest("并发建档", Phone(), null, null)), "memberNo");

        AssertGapless(numbers, @"^No\.(?<seq>\d{6,})$");
    }

    [Fact]
    public async Task Member_Numbers_Return_On_Phone_Conflict_And_Skip_Numbers_Already_Taken()
    {
        using var c = await Staff();
        var first = await Member(c);
        var n = Seq(first.GetProperty("memberNo").GetString()!);

        var clash = await c.PostAsJsonAsync("/api/members", new CreateMemberRequest("重复手机号", first.GetProperty("phone").GetString()!, null, null));
        Assert.Equal(HttpStatusCode.Conflict, clash.StatusCode);
        Assert.Equal($"No.{n + 1:D6}", (await Member(c)).GetProperty("memberNo").GetString());

        // Numbers handed out before the counter existed (random or seeded) are skipped instead of failing the insert.
        var db = host.Services.GetRequiredService<NpgsqlDataSource>();
        var tid = host.Services.GetRequiredService<KunlunAuthRepository>().DefaultTenantId;
        foreach (var legacy in new[] { n + 2, n + 3 })
        {
            await using var cmd = db.CreateCommand("INSERT INTO plugin_kunlun_waterstation.members(id,tenant_id,member_no,name,phone) VALUES(@id,@tid,@no,'旧卡号',@phone)");
            cmd.Parameters.AddWithValue("id", Guid.NewGuid()); cmd.Parameters.AddWithValue("tid", tid);
            cmd.Parameters.AddWithValue("no", $"No.{legacy:D6}"); cmd.Parameters.AddWithValue("phone", Phone());
            await cmd.ExecuteNonQueryAsync();
        }
        Assert.Equal($"No.{n + 4:D6}", (await Member(c)).GetProperty("memberNo").GetString());
    }

    [Fact]
    public async Task Concurrent_Deposits_And_Refunds_Get_Gapless_Numbers_And_Replays_Keep_Theirs()
    {
        using var c = await Staff(); var ids = await CreateMembers(c);

        var deposits = await All(Burst, i => c.PostAsJsonAsync("/api/deposits/collect", new CollectDepositRequest(ids[i % MemberCount], "BUCKET", 1, "CASH", Key())), "depositNo");

        // Replays reuse the first request's number, so the burst plus the replayed request is still one gapless run.
        var depositKey = Key();
        var replays = await All(10, _ => c.PostAsJsonAsync("/api/deposits/collect", new CollectDepositRequest(ids[0], "BUCKET", 1, "CASH", depositKey)), "depositNo");
        Assert.Single(replays.Distinct());
        AssertGapless([.. deposits, replays[0]], @"^YJ(?<day>\d{8})(?<seq>\d{4,})$");

        var refunds = await All(Burst, i => c.PostAsJsonAsync("/api/deposits/refund", new RefundDepositRequest(ids[i % MemberCount], "BUCKET", 1, Key())), "refundNo");

        var refundKey = Key();
        var refundReplays = await All(10, _ => c.PostAsJsonAsync("/api/deposits/refund", new RefundDepositRequest(ids[0], "BUCKET", 1, refundKey)), "refundNo");
        Assert.Single(refundReplays.Distinct());
        AssertGapless([.. refunds, refundReplays[0]], @"^TK(?<day>\d{8})(?<seq>\d{4,})$");
    }

    [Fact]
    public async Task Concurrent_Orders_Get_Gapless_Numbers_And_Replays_Keep_Theirs()
    {
        using var c = await Staff(); var ids = await CreateMembers(c);
        foreach (var id in ids)
            await Ok(await c.PostAsJsonAsync("/api/recharges", new CreateRechargeOrderRequest(id, WaterProducts.PlanId("101"), "CASH", Key())));

        var orders = await All(Burst, i => c.PostAsJsonAsync("/api/orders", new CreateWaterOrderRequest(ids[i % MemberCount], "BUCKET_18_9L", "PICKUP", 1, Key())), "orderNo");

        var key = Key();
        var replays = await All(10, _ => c.PostAsJsonAsync("/api/orders", new CreateWaterOrderRequest(ids[0], "BUCKET_18_9L", "PICKUP", 1, key)), "orderNo");
        Assert.Single(replays.Distinct());
        AssertGapless([.. orders, replays[0]], @"^ORD-(?<day>\d{8})-(?<seq>\d{6,})$");
    }
}
