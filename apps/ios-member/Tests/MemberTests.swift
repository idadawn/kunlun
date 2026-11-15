import Foundation
import Testing
@testable import KunlunCore

private func fixture(_ name: String) throws -> Data {
    try Data(contentsOf: #require(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures")))
}

private actor RequestGate {
    var entered = false
    var startWaiters: [CheckedContinuation<Void, Never>] = []
    var continuation: CheckedContinuation<Void, Never>?
    func enter() async {
        entered = true
        for waiter in startWaiters { waiter.resume() }
        startWaiters = []
        await withCheckedContinuation { continuation = $0 }
    }
    func waitUntilEntered() async {
        if entered { return }
        await withCheckedContinuation { startWaiters.append($0) }
    }
    func release() { continuation?.resume(); continuation = nil }
}

private actor Server {
    var requests: [URLRequest] = []
    var overrides: [String: (Int, Data)] = [:]
    var gates: [String: RequestGate] = [:]
    func set(_ path: String, status: Int = 200, data: Data) { overrides[path] = (status, data) }
    func gate(_ path: String, _ gate: RequestGate) { gates[path] = gate }
    func request(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        requests.append(request)
        let url = request.url!
        let path = url.path
        let response: (Int, Data)
        if let value = overrides[path] { response = value }
        else {
            let name: String?
            if path == "/api/auth/me" || path == "/api/auth/member/login" { name = "identity" }
            else if path.hasSuffix("/profile") { name = "profile" }
            else if path.hasSuffix("/ticket-batches") { name = "batches" }
            else if path.hasSuffix("/deposit-summary") { name = "deposits" }
            else if path.hasSuffix("/addresses") { name = "addresses" }
            else if path == "/api/orders" { name = "orders" }
            else { name = nil }
            response = (200, try name.map(fixture) ?? Data("{}".utf8))
        }
        if let gate = gates[path] { await gate.enter() }
        return (response.1, HTTPURLResponse(url: url, statusCode: response.0, httpVersion: nil, headerFields: nil)!)
    }
    nonisolated var api: MemberAPI { MemberAPI(baseURL: ServiceEnvironment.test.baseURL) { try await self.request($0) } }
}

@MainActor private final class MemoryCredentials: CredentialStore {
    var saved: [ServiceEnvironment: String]
    init(token: String? = "fixture-token") { saved = token.map { [.test: $0] } ?? [:] }
    func read(for environment: ServiceEnvironment) throws -> String? { saved[environment] }
    func save(_ token: String?, for environment: ServiceEnvironment) throws { saved[environment] = token }
}

@MainActor struct MemberTests {
    let memberID = "11111111-1111-4111-8111-111111111111"

    @Test func decodesCurrentMemberContractIncludingNullableHistory() throws {
        let decoder = JSONDecoder()
        let profile = try decoder.decode(MemberProfile.self, from: fixture("profile"))
        #expect(profile.depositAmount == 65)
        #expect(profile.tickets.map(\.id).count == 2)
        let page = try decoder.decode(Page<WaterOrder>.self, from: fixture("orders"))
        #expect(page.rows.first?.actualQty == nil)
        #expect(page.rows.first?.pickupCode == nil)
        #expect(!page.hasMore)
        #expect(try decoder.decode([TicketBatch].self, from: fixture("batches")).first?.pendingGiftQty == 3)
        #expect(try decoder.decode([DepositSummary].self, from: fixture("deposits")).first?.refundableAmount == 20)
        #expect(try decoder.decode([MemberAddress].self, from: fixture("addresses")).first?.isDefault == true)
    }

    @Test func loginUsesMemberEndpointAndNeverSendsPriorBearer() async throws {
        let server = Server()
        let result = try await server.api.login(account: "  member.demo  ", password: "not-a-real-password")
        #expect(result.identity.isMember)
        let request = try #require(await server.requests.first)
        #expect(request.url?.path == "/api/auth/member/login")
        #expect(request.httpMethod == "POST")
        #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
        let body = try JSONDecoder().decode([String: String].self, from: #require(request.httpBody))
        #expect(body["account"] == "member.demo")
    }

    @Test func errorsPreserveStatusAndServerMessage() async throws {
        let server = Server()
        await server.set("/api/auth/member/login", status: 403, data: Data(#"{"message":"会员已停用","error":"FORBIDDEN"}"#.utf8))
        do { _ = try await server.api.login(account: "abc", password: "invalid"); Issue.record("Expected failure") }
        catch let error as APIError { #expect(error.status == 403); #expect(error.message == "会员已停用") }
    }

    @Test func staffCannotEnterMemberApp() async throws {
        let server = Server()
        let data = String(data: try fixture("identity"), encoding: .utf8)!.replacingOccurrences(of: "MEMBER", with: "STAFF")
        await server.set("/api/auth/member/login", data: Data(data.utf8))
        let vault = MemoryCredentials(token: nil)
        let store = MemberStore(environment: .test, credentials: vault, api: server.api)
        await store.login(account: "staff", password: "invalid")
        #expect(store.identity == nil)
        #expect(vault.saved.isEmpty)
    }

    @Test func sessionRestoreValidatesMemberAnd401ClearsAllData() async throws {
        let server = Server(); let vault = MemoryCredentials()
        let store = MemberStore(environment: .test, credentials: vault, api: server.api)
        await store.restore(); await store.loadProfile(); await store.loadOrders()
        #expect(store.profile.value?.name == "林先生")
        await server.set("/api/members/\(memberID)/deposit-summary", status: 401, data: Data())
        await store.loadDeposits()
        #expect(store.identity == nil)
        #expect(store.profile.value == nil)
        #expect(store.orders.value == nil)
        #expect(vault.saved.isEmpty)
    }

    @Test func temporaryRestoreFailureKeepsCredentialForRetry() async {
        let server = Server(); let vault = MemoryCredentials()
        await server.set("/api/auth/me", status: 503, data: Data())
        let store = MemberStore(environment: .test, credentials: vault, api: server.api)
        await store.restore()
        #expect(store.identity == nil)
        #expect(store.restoreError != nil)
        #expect(vault.saved[.test] == "fixture-token")
        #expect(!store.restoring)
    }

    @Test func lateResponseCannotRestoreDataAfterLogout() async {
        let server = Server(); let vault = MemoryCredentials()
        let store = MemberStore(environment: .test, credentials: vault, api: server.api)
        await store.restore()
        let gate = RequestGate()
        await server.gate("/api/members/\(memberID)/profile", gate)
        let loading = Task { await store.loadProfile() }
        await gate.waitUntilEntered()
        store.forgetLocalSession()
        await gate.release(); await loading.value
        #expect(store.identity == nil)
        #expect(store.profile.value == nil)
    }

    @Test func orderPaginationUsesSelfFilterAndDeduplicatesRows() async throws {
        let server = Server(); let vault = MemoryCredentials()
        let store = MemberStore(environment: .test, credentials: vault, api: server.api)
        await store.restore()
        var page = try #require(JSONSerialization.jsonObject(with: fixture("orders")) as? [String: Any])
        page["total"] = 23
        await server.set("/api/orders", data: try JSONSerialization.data(withJSONObject: page))
        await store.loadOrders(status: "PENDING")
        #expect(store.hasMoreOrders)
        page["page"] = 2
        await server.set("/api/orders", data: try JSONSerialization.data(withJSONObject: page))
        await store.loadOrders(more: true)
        #expect(store.orders.value?.count == 3)
        #expect(!store.hasMoreOrders)
        let request = try #require(await server.requests.last)
        let requestURL = try #require(request.url)
        let query = try #require(URLComponents(url: requestURL, resolvingAgainstBaseURL: false)?.queryItems)
        #expect(query.contains(URLQueryItem(name: "memberId", value: memberID)))
        #expect(query.contains(URLQueryItem(name: "page", value: "2")))
        #expect(query.contains(URLQueryItem(name: "status", value: "PENDING")))
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer fixture-token")
    }

    @Test func passwordChangeInvalidatesSavedSession() async {
        let server = Server(); let vault = MemoryCredentials()
        let store = MemberStore(environment: .test, credentials: vault, api: server.api)
        await store.restore()
        #expect(await store.changePassword(current: "old", new: "new-password"))
        #expect(store.identity == nil)
        #expect(vault.saved.isEmpty)
        #expect(store.notice == "密码已修改，请重新登录")
    }

    @Test func logoutFailureRequiresExplicitLocalRemoval() async {
        let server = Server(); let vault = MemoryCredentials()
        let store = MemberStore(environment: .test, credentials: vault, api: server.api)
        await store.restore()
        await server.set("/api/auth/logout", status: 503, data: Data())
        #expect(!(await store.logout()))
        #expect(store.identity != nil)
        #expect(vault.saved[.test] != nil)
        store.forgetLocalSession()
        #expect(store.identity == nil)
        #expect(vault.saved.isEmpty)
    }
}
