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
        // Like URLSession, a request whose task was cancelled while in flight fails.
        try Task.checkCancellation()
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

    @Test func legacyBalanceTakesItsWaterNameFromTheMembersTickets() throws {
        let decoder = JSONDecoder()
        let tickets = try decoder.decode(MemberProfile.self, from: fixture("profile")).tickets
        let batches = try decoder.decode([TicketBatch].self, from: fixture("batches"))
        let purchase = try #require(batches.first { $0.source == "PURCHASE" })
        let legacy = try #require(batches.first { $0.source == "LEGACY" })
        #expect(purchase.waterName(in: tickets) == "桶装水 15L")
        // A legacy balance has no recharge snapshot, so the API sends an empty label.
        #expect(legacy.waterLabel.isEmpty)
        #expect(legacy.waterName(in: tickets) == "袋装水 5L")
        #expect(legacy.waterName(in: []) == "")
    }

    @Test func decodesPackagesBoughtBeforeTheSystem() throws {
        let batches = try JSONDecoder().decode([TicketBatch].self, from: fixture("batches"))
        let priced = try #require(batches.first { $0.id == "opening-1" })
        let unknown = try #require(batches.first { $0.id == "opening-2" })
        #expect(priced.source == "OPENING")
        #expect(priced.opening?.entryNo == "QC-DEMO-001")
        #expect(priced.opening?.paidAmount == 480)
        #expect(priced.opening?.packageQty == 40)
        #expect(priced.opening?.planId == nil)
        // A package recorded as 套餐不清楚 has no price and no package size.
        #expect(unknown.paidAmount == 0)
        #expect(unknown.opening?.paidAmount == 0)
        #expect(unknown.opening?.packageQty == nil)
        // Every other batch sends null.
        #expect(batches.filter { $0.opening != nil }.map(\.id) == ["opening-1", "opening-2"])
    }

    @Test func serversWithoutTheOpeningFieldStillDecode() throws {
        var rows = try #require(JSONSerialization.jsonObject(with: fixture("batches")) as? [[String: Any]])
        for index in rows.indices { rows[index]["opening"] = nil }
        let batches = try JSONDecoder().decode([TicketBatch].self, from: JSONSerialization.data(withJSONObject: rows))
        #expect(batches.count == 4)
        #expect(batches.allSatisfy { $0.opening == nil })
        // Without its entry number an opening package still says it was bought before the system, not a date.
        #expect(batches.first { $0.id == "opening-1" }?.openingNote == "上系统前买的")
        // A snapshot missing fields does not fail the whole list either.
        rows[1]["opening"] = ["entryNo": "QC-DEMO-002"]
        let sparse = try JSONDecoder().decode([TicketBatch].self, from: JSONSerialization.data(withJSONObject: rows))
        #expect(sparse[1].opening?.paidAmount == nil)
        #expect(sparse[1].openingNote == "上系统前买的 · 补录单 QC-DEMO-002")
    }

    @Test func openingPackagesShowWhereTheyCameFromInsteadOfADateOrZeroPrice() throws {
        let batches = try JSONDecoder().decode([TicketBatch].self, from: fixture("batches"))
        let byID = Dictionary(uniqueKeysWithValues: batches.map { ($0.id, $0) })
        let purchase = try #require(byID["batch-1"]), legacy = try #require(byID["legacy-1"])
        let priced = try #require(byID["opening-1"]), unknown = try #require(byID["opening-2"])
        #expect(priced.isOpening && unknown.isOpening)
        #expect(!purchase.isOpening && !legacy.isOpening)
        // An opening batch's createdAt is when the member was set up, so it shows the note and the entry that recorded it.
        #expect(priced.openingNote == "上系统前买的 · 补录单 QC-DEMO-001")
        #expect(unknown.openingNote == "上系统前买的 · 补录单 QC-DEMO-001")
        // Recharges keep their date and legacy balances keep their own note.
        #expect(purchase.openingNote == nil)
        #expect(legacy.openingNote == nil)
        // Only an opening package without its price is 套餐不清楚; a priced one shows what was paid, a legacy balance its 0 as before.
        #expect(unknown.hasUnknownPackage)
        #expect(!priced.hasUnknownPackage)
        #expect(!legacy.hasUnknownPackage)
        #expect(!purchase.hasUnknownPackage)
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

    @Test func pullToRefreshKeepsOrdersOnScreenEvenWhenCancelled() async {
        let server = Server(); let vault = MemoryCredentials()
        let store = MemberStore(environment: .test, credentials: vault, api: server.api)
        await store.restore(); await store.loadOrders()
        #expect(store.orders.value?.count == 3)
        // SwiftUI can cancel a refresh; the rows must stay rather than turn into a spinner nothing restarts.
        let refreshGate = RequestGate()
        await server.gate("/api/orders", refreshGate)
        let refresh = Task { await store.loadOrders() }
        await refreshGate.waitUntilEntered()
        #expect(store.orders.value?.count == 3)
        refresh.cancel()
        await refreshGate.release(); await refresh.value
        #expect(store.orders.value?.count == 3)
        // Another filter is another list, so it shows the spinner until its rows arrive.
        let filterGate = RequestGate()
        await server.gate("/api/orders", filterGate)
        let filtered = Task { await store.loadOrders(status: "PENDING") }
        await filterGate.waitUntilEntered()
        #expect(store.orders.value == nil)
        await filterGate.release(); await filtered.value
        #expect(store.orders.value?.count == 3)
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

    @Test func wrongCurrentPasswordKeepsTheSession() async {
        let server = Server(); let vault = MemoryCredentials()
        let store = MemberStore(environment: .test, credentials: vault, api: server.api)
        await store.restore()
        // The server answers a wrong current password with 401, the same status as an expired login.
        await server.set("/api/auth/change-password", status: 401, data: Data(#"{"error":"用户名或密码错误，或账号已停用"}"#.utf8))
        #expect(!(await store.changePassword(current: "wrong", new: "new-password")))
        #expect(store.identity != nil)
        #expect(vault.saved[.test] == "fixture-token")
        #expect(store.notice == "用户名或密码错误，或账号已停用")
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
