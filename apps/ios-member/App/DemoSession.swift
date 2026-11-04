#if DEBUG
import Foundation
import KunlunCore

@MainActor enum DemoSession {
    static func makeStore(signedIn: Bool = true) -> MemberStore {
        let api = MemberAPI(baseURL: ServiceEnvironment.test.baseURL) { request in
            let path = request.url!.path
            let file: String
            if path == "/api/auth/me" || path == "/api/auth/member/login" { file = "identity" }
            else if path.hasSuffix("/profile") { file = "profile" }
            else if path.hasSuffix("/deposit-summary") { file = "deposits" }
            else if path.hasSuffix("/ticket-batches") { file = "batches" }
            else if path.hasSuffix("/addresses") { file = "addresses" }
            else if path == "/api/orders" { file = "orders" }
            else if path == "/api/auth/logout" || path == "/api/auth/change-password" {
                return (Data("{}".utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
            } else { throw APIError(status: 404, message: "演示中没有此操作") }
            guard let url = Bundle.main.url(forResource: file, withExtension: "json", subdirectory: "Fixtures") else { throw APIError(status: 500, message: "演示资料缺失") }
            var data = try Data(contentsOf: url)
            if file == "orders", let status = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "status" })?.value {
                var page = try JSONSerialization.jsonObject(with: data) as! [String: Any]
                let rows = (page["rows"] as! [[String: Any]]).filter { $0["status"] as? String == status }
                page["rows"] = rows; page["total"] = rows.count
                data = try JSONSerialization.data(withJSONObject: page)
            }
            return (data, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        }
        return MemberStore(environment: .test, credentials: DemoCredentials(signedIn: signedIn), api: api)
    }
}

@MainActor private final class DemoCredentials: CredentialStore {
    private var token: String? = "demo-only-not-a-real-token"
    init(signedIn: Bool) { if !signedIn { token = nil } }
    func read(for environment: ServiceEnvironment) throws -> String? { token }
    func save(_ token: String?, for environment: ServiceEnvironment) throws { self.token = token }
}
#endif
