import Foundation

public struct APIError: Error, LocalizedError, Sendable {
    public let status: Int
    public let message: String
    public var errorDescription: String? { message }
    public init(status: Int, message: String) { self.status = status; self.message = message }
}

public typealias HTTPTransport = @Sendable (URLRequest) async throws -> (Data, HTTPURLResponse)

/// Never forward membership credentials through a server redirect, or cache personal responses.
private final class NoRedirect: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

public struct MemberAPI: Sendable {
    public let baseURL: URL
    private let transport: HTTPTransport

    public init(baseURL: URL, transport: HTTPTransport? = nil) {
        self.baseURL = baseURL
        if let transport { self.transport = transport } else {
            let config = URLSessionConfiguration.ephemeral
            config.urlCache = nil
            config.httpCookieStorage = nil
            config.timeoutIntervalForRequest = 20
            let session = URLSession(configuration: config, delegate: NoRedirect(), delegateQueue: nil)
            self.transport = { request in
                let (data, response) = try await session.data(for: request)
                guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
                return (data, http)
            }
        }
    }

    private func send(_ path: String, token: String? = nil, body: [String: String]? = nil,
                      method: String = "GET", query: [URLQueryItem] = []) async throws -> Data {
        var components = URLComponents(url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { components.queryItems = query }
        var request = URLRequest(url: components.url!, cachePolicy: .reloadIgnoringLocalCacheData)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body {
            request.httpBody = try JSONEncoder().encode(body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await transport(request)
        guard (200..<300).contains(response.statusCode) else {
            struct Failure: Decodable { let message: String?; let error: String? }
            let failure = try? JSONDecoder().decode(Failure.self, from: data)
            let fallback = response.statusCode == 401 ? "登录已失效，请重新登录" : "暂时无法完成请求（\(response.statusCode)）"
            throw APIError(status: response.statusCode, message: failure?.message ?? failure?.error ?? fallback)
        }
        return data
    }

    private func get<T: Decodable>(_ type: T.Type, _ path: String, token: String, query: [URLQueryItem] = []) async throws -> T {
        try JSONDecoder().decode(type, from: await send(path, token: token, query: query))
    }
    public func login(account: String, password: String) async throws -> LoginResponse {
        let data = try await send("api/auth/member/login", body: ["account": account.trimmingCharacters(in: .whitespacesAndNewlines), "password": password], method: "POST")
        let session = try JSONDecoder().decode(LoginResponse.self, from: data)
        guard session.identity.isMember, !session.accessToken.isEmpty else { throw APIError(status: 403, message: "请使用会员账号登录") }
        return session
    }
    public func me(token: String) async throws -> MemberIdentity { try await get(MemberIdentity.self, "api/auth/me", token: token) }
    public func profile(id: String, token: String) async throws -> MemberProfile { try await get(MemberProfile.self, "api/members/\(id)/profile", token: token) }
    public func orders(id: String, token: String, page: Int, status: String = "") async throws -> Page<WaterOrder> {
        var query = [URLQueryItem(name: "memberId", value: id), URLQueryItem(name: "page", value: String(page)), URLQueryItem(name: "pageSize", value: "20")]
        if !status.isEmpty { query.append(URLQueryItem(name: "status", value: status)) }
        return try await get(Page<WaterOrder>.self, "api/orders", token: token, query: query)
    }
    public func batches(id: String, token: String) async throws -> [TicketBatch] { try await get([TicketBatch].self, "api/members/\(id)/ticket-batches", token: token) }
    public func deposits(id: String, token: String) async throws -> [DepositSummary] { try await get([DepositSummary].self, "api/members/\(id)/deposit-summary", token: token) }
    public func addresses(id: String, token: String) async throws -> [MemberAddress] { try await get([MemberAddress].self, "api/members/\(id)/addresses", token: token) }
    public func logout(token: String) async throws { _ = try await send("api/auth/logout", token: token, method: "POST") }
    public func changePassword(token: String, current: String, new: String) async throws {
        _ = try await send("api/auth/change-password", token: token, body: ["currentPassword": current, "newPassword": new], method: "POST")
    }
}
