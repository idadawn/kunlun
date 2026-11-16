import Foundation
import Testing
@testable import KunlunStaffCore

private func url(_ text: String) -> URL { URL(string: text)! }

@Suite struct StaffRoutesTests {
    @Test func staffPagesAndHashedAssetsComeFromTheBundle() {
        #expect(StaffRoutes.resource(for: url("kunlun-staff://localhost/staff/orders?q=1")) == .page)
        #expect(StaffRoutes.resource(for: url("kunlun-staff://localhost/staff/inventory")) == .page)
        #expect(StaffRoutes.resource(for: url("kunlun-staff://localhost/static/h5/index-Ab12.js")) == .asset("www/static/h5/index-Ab12.js"))
        #expect(StaffRoutes.allowsNavigation(to: StaffRoutes.start))
        for other in ["kunlun-staff://localhost/member", "kunlun-staff://localhost/admin", "kunlun-staff://localhost/favicon.ico", "kunlun-staff://localhost/staff/"] {
            #expect(StaffRoutes.resource(for: url(other)) == nil, "\(other)")
        }
    }

    @Test func apiCallsKeepTheirPathAndQuery() {
        let call = url("kunlun-staff://localhost/api/members?q=%E5%91%A8&page=1")
        #expect(StaffRoutes.resource(for: call) == .api(path: "/api/members", query: "q=%E5%91%A8&page=1"))
        #expect(!StaffRoutes.allowsNavigation(to: call))
        let origin = StaffOrigin("http://127.0.0.1:5188", allowLoopbackHTTP: true)!
        #expect(StaffRoutes.upstream(path: "/api/members", query: "q=%E5%91%A8&page=1", origin: origin)?.absoluteString
                == "http://127.0.0.1:5188/api/members?q=%E5%91%A8&page=1")
    }

    @Test func refusesOtherSchemesHostsCredentialsAndTraversal() {
        for text in ["https://kunlun.idalee.cn/staff", "kunlun-staff://evil/staff", "kunlun-staff://user@localhost/staff",
                     "kunlun-staff://localhost:8080/staff", "file:///staff", "javascript:alert(1)",
                     "kunlun-staff://localhost/static/h5/%2e%2e/index.html", "kunlun-staff://localhost/static/h5/../index.html",
                     "kunlun-staff://localhost/api/%2e%2e/admin", "kunlun-staff://localhost/api//members", "kunlun-staff://localhost/api/a%2F%2Fb"] {
            #expect(StaffRoutes.resource(for: url(text)) == nil, "\(text)")
        }
    }
}

@Suite struct StaffOriginTests {
    @Test func releaseAcceptsHttpsOriginsOnly() {
        #expect(StaffOrigin("https://kunlun.idalee.cn", allowLoopbackHTTP: false)?.url.absoluteString == "https://kunlun.idalee.cn")
        #expect(StaffOrigin("https://kunlun.idalee.cn:443/", allowLoopbackHTTP: false)?.url.absoluteString == "https://kunlun.idalee.cn")
        for text in ["http://kunlun.idalee.cn", "http://127.0.0.1:5188", "https://kunlun.idalee.cn/api", "https://user@kunlun.idalee.cn",
                     "https://kunlun.idalee.cn?x=1", "ftp://kunlun.idalee.cn", "", "$(STAFF_ORIGIN)"] {
            #expect(StaffOrigin(text, allowLoopbackHTTP: false) == nil, "\(text)")
        }
    }

    @Test func debugAllowsPlainHttpOnThisMacOnly() {
        #expect(StaffOrigin("http://127.0.0.1:5188", allowLoopbackHTTP: true)?.url.absoluteString == "http://127.0.0.1:5188")
        #expect(StaffOrigin("http://localhost:5288", allowLoopbackHTTP: true) != nil)
        #expect(StaffOrigin("http://192.168.1.10:5188", allowLoopbackHTTP: true) == nil)
    }

    @Test func debugLaunchArgumentOverridesTheBuiltInOrigin() {
        let arguments = ["KunlunStaff", "-StaffOrigin", "http://127.0.0.1:5288"]
        #expect(StaffOrigin.resolve(arguments: arguments, configured: "http://127.0.0.1:5188", debug: true)?.port == 5288)
        #expect(StaffOrigin.resolve(arguments: ["KunlunStaff"], configured: "http://127.0.0.1:5188", debug: true)?.port == 5188)
        // Release ignores the argument and never accepts plain HTTP.
        #expect(StaffOrigin.resolve(arguments: arguments, configured: "https://kunlun.idalee.cn", debug: false)?.host == "kunlun.idalee.cn")
        #expect(StaffOrigin.resolve(arguments: [], configured: "http://127.0.0.1:5188", debug: false) == nil)
    }
}

@Suite struct StaffProxyTests {
    @Test func forwardsTheBearerTokenButNotCookiesOriginOrEncoding() {
        let origin = StaffOrigin("http://127.0.0.1:5188", allowLoopbackHTTP: true)!
        let headers = ["Authorization": "Bearer t", "Content-Type": "application/json", "Idempotency-Key": "k", "Cookie": "a=b",
                       "Origin": "kunlun-staff://localhost", "Referer": "kunlun-staff://localhost/staff/order", "Accept-Encoding": "br"]
        let request = StaffProxy.request(method: "POST", path: "/api/orders", query: nil, headers: headers, body: Data("{}".utf8), origin: origin)!
        #expect(request.url?.absoluteString == "http://127.0.0.1:5188/api/orders")
        #expect(request.httpMethod == "POST")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer t")
        #expect(request.value(forHTTPHeaderField: "Idempotency-Key") == "k")
        for dropped in ["Cookie", "Origin", "Referer", "Accept-Encoding"] { #expect(request.value(forHTTPHeaderField: dropped) == nil, "\(dropped)") }
        #expect(request.httpBody == Data("{}".utf8))
        #expect(!request.httpShouldHandleCookies)
    }

    @Test func readsRequestBodiesGivenAsDataOrStream() {
        var request = URLRequest(url: url("kunlun-staff://localhost/api/orders"))
        #expect(StaffProxy.body(of: request) == nil)
        request.httpBodyStream = InputStream(data: Data(repeating: 7, count: 40_000))
        #expect(StaffProxy.body(of: request) == Data(repeating: 7, count: 40_000))
        request.httpBody = Data("{}".utf8)
        #expect(StaffProxy.body(of: request) == Data("{}".utf8))
    }

    @Test func dropsCookiesAndEncodingFromReplies() {
        let headers = StaffProxy.responseHeaders(["Content-Type": "application/json", "Set-Cookie": "a=b", "Content-Encoding": "gzip", "Content-Length": "10"])
        #expect(headers == ["Content-Type": "application/json"])
    }

    @Test func servesBuildFilesWithTheirTypes() {
        #expect(StaffProxy.mimeType(forAsset: "www/static/h5/index-Ab12.js") == "text/javascript; charset=utf-8")
        #expect(StaffProxy.mimeType(forAsset: "www/static/h5/index-Ab12.css") == "text/css; charset=utf-8")
        #expect(StaffProxy.mimeType(forAsset: "www/static/h5/favicon-x.svg") == "image/svg+xml")
        #expect(StaffProxy.mimeType(forAsset: "www/index.html") == "text/html; charset=utf-8")
    }
}
