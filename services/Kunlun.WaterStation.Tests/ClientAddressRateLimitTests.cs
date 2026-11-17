using System.Net;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Xunit;

namespace Kunlun.WaterStation.Tests;

[Collection("KunlunIntegration")]
public sealed class ClientAddressRateLimitTests(TestHost host)
{
    // Kestrel listens on [::] in the container, so nginx on the internal compose network shows up IPv4-mapped.
    private static readonly IPAddress Nginx = IPAddress.Parse("::ffff:172.21.0.4");
    private static readonly IPAddress PublicPeer = IPAddress.Parse("198.51.100.9");

    [Fact]
    public async Task Login_Limit_Counts_Each_Client_Behind_Nginx_And_Ignores_Untrusted_Forwarding()
    {
        // Production keeps the real limit: 15 login attempts per client per minute.
        using var api = host.WithWebHostBuilder(b => b.UseEnvironment("Production"));
        async Task<int> Login(IPAddress peer, string forwardedFor)
        {
            // TestServer has no socket, so the peer address is set by hand; without one the middleware would trust any header.
            var context = await api.Server.SendAsync(c =>
            {
                c.Connection.RemoteIpAddress = peer;
                c.Request.Method = HttpMethods.Post;
                c.Request.Path = "/api/auth/member/login";
                c.Request.Headers["X-Forwarded-For"] = forwardedFor;
                c.Request.ContentType = "application/json";
                c.Request.Body = new MemoryStream("""{"account":"nobody","password":"wrong-password"}"""u8.ToArray());
                c.Features.Set<IHttpRequestBodyDetectionFeature>(new HasBody());
            });
            return context.Response.StatusCode;
        }

        for (var i = 0; i < 15; i++) Assert.Equal(401, await Login(Nginx, "203.0.113.10"));
        Assert.Equal(429, await Login(Nginx, "203.0.113.10"));
        // Another member behind the same nginx is not held up by the first one.
        Assert.Equal(401, await Login(Nginx, "203.0.113.11"));
        // Only the entry Caddy wrote counts; addresses a client puts in front of it do not buy a new allowance.
        Assert.Equal(429, await Login(Nginx, "192.0.2.1, 203.0.113.10"));

        // A peer outside the internal networks cannot choose its address: it is counted as itself whatever it forwards.
        for (var i = 0; i < 15; i++) Assert.Equal(401, await Login(PublicPeer, $"203.0.113.{100 + i}"));
        Assert.Equal(429, await Login(PublicPeer, "203.0.113.200"));
    }

    /// <summary>A hand-built TestServer request otherwise says it has no body, and minimal APIs would not read the JSON.</summary>
    private sealed class HasBody : IHttpRequestBodyDetectionFeature { public bool CanHaveBody => true; }
}
