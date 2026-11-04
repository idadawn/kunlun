import Foundation
import Observation

@MainActor public protocol CredentialStore {
    func read(for environment: ServiceEnvironment) throws -> String?
    func save(_ token: String?, for environment: ServiceEnvironment) throws
}

@MainActor @Observable public final class MemberStore {
    public private(set) var identity: MemberIdentity?
    public private(set) var environment: ServiceEnvironment
    public private(set) var restoring = true
    public private(set) var busy = false
    public private(set) var restoreError: String?
    public var notice: String?
    public private(set) var profile: LoadState<MemberProfile> = .idle
    public private(set) var orders: LoadState<[WaterOrder]> = .idle
    public private(set) var batches: LoadState<[TicketBatch]> = .idle
    public private(set) var deposits: LoadState<[DepositSummary]> = .idle
    public private(set) var addresses: LoadState<[MemberAddress]> = .idle
    public private(set) var hasMoreOrders = false
    public private(set) var loadingMore = false
    public private(set) var moreError: String?
    public private(set) var orderStatus = ""
    private var orderPage = 0
    private var orderRequest = UUID()
    private var epoch = UUID()
    private var loadRequests: [AnyKeyPath: UUID] = [:]
    private var token: String?
    private var api: MemberAPI
    private let credentials: any CredentialStore

    public init(environment: ServiceEnvironment, credentials: any CredentialStore, api: MemberAPI? = nil) {
        self.environment = environment
        self.credentials = credentials
        self.api = api ?? MemberAPI(baseURL: environment.baseURL)
    }

    public func restore() async {
        guard !busy else { return }
        busy = true; restoring = true; restoreError = nil
        defer { busy = false; restoring = false }
        do {
            guard let saved = try credentials.read(for: environment) else { return }
            token = saved
            let user = try await api.me(token: saved)
            guard user.isMember else { throw APIError(status: 401, message: "请使用会员账号登录") }
            identity = user
        } catch {
            if (error as? APIError)?.status == 401 { clearSession(message: "登录已失效，请重新登录") }
            else { restoreError = "暂时无法验证登录状态，请重试。\(error.localizedDescription)" }
        }
    }

    public func login(account: String, password: String) async {
        guard !busy else { return }
        busy = true; notice = nil
        defer { busy = false }
        do {
            let result = try await api.login(account: account, password: password)
            try credentials.save(result.accessToken, for: environment)
            epoch = UUID(); token = result.accessToken; identity = result.identity; restoreError = nil
        } catch { notice = error.localizedDescription }
    }

    public func switchEnvironment(_ target: ServiceEnvironment) {
        guard !busy, identity == nil else { return }
        clearSession()
        environment = target
        api = MemberAPI(baseURL: target.baseURL)
        restoring = true
    }

    /// Offline removal is explicit. The UI explains that server revocation could not be confirmed.
    public func forgetLocalSession() { clearSession() }

    public func logout() async -> Bool {
        guard let token, !busy else { return false }
        busy = true
        defer { busy = false }
        do {
            try await api.logout(token: token)
            clearSession()
            return true
        } catch {
            if (error as? APIError)?.status == 401 { clearSession(); return true }
            notice = "服务器退出未完成：\(error.localizedDescription)"
            return false
        }
    }

    public func changePassword(current: String, new: String) async -> Bool {
        guard let token, !busy else { return false }
        busy = true; notice = nil
        defer { busy = false }
        do {
            try await api.changePassword(token: token, current: current, new: new)
            clearSession(message: "密码已修改，请重新登录")
            return true
        } catch { handle(error); notice = error.localizedDescription; return false }
    }

    private func clearSession(message: String? = nil) {
        notice = message
        do { try credentials.save(nil, for: environment) } catch { notice = "无法清除钥匙串中的登录状态：\(error.localizedDescription)" }
        epoch = UUID(); orderRequest = UUID(); loadRequests = [:]; token = nil; identity = nil; restoreError = nil
        profile = .idle; orders = .idle; batches = .idle; deposits = .idle; addresses = .idle
        orderPage = 0; hasMoreOrders = false; loadingMore = false; moreError = nil; orderStatus = ""
    }
    private func handle(_ error: any Error) {
        if (error as? APIError)?.status == 401 { clearSession(message: "登录已失效，请重新登录") }
    }
    private func load<T>(_ key: ReferenceWritableKeyPath<MemberStore, LoadState<T>>,
                         operation: (MemberAPI, String, String) async throws -> T) async {
        guard let identity, let token else { return }
        let current = epoch
        let request = UUID()
        loadRequests[key] = request
        self[keyPath: key] = .loading
        do {
            let value = try await operation(api, identity.subjectId, token)
            guard epoch == current, loadRequests[key] == request else { return }
            self[keyPath: key] = .loaded(value)
        } catch {
            guard epoch == current, loadRequests[key] == request else { return }
            if error is CancellationError || (error as? URLError)?.code == .cancelled { self[keyPath: key] = .idle; return }
            self[keyPath: key] = .failed(error.localizedDescription)
            handle(error)
        }
    }
    public func loadProfile() async { await load(\.profile) { try await $0.profile(id: $1, token: $2) } }
    public func loadBatches() async { await load(\.batches) { try await $0.batches(id: $1, token: $2).sorted { $0.createdAt > $1.createdAt } } }
    public func loadDeposits() async { await load(\.deposits) { try await $0.deposits(id: $1, token: $2) } }
    public func loadAddresses() async { await load(\.addresses) { try await $0.addresses(id: $1, token: $2) } }

    public func loadOrders(status: String? = nil, more: Bool = false) async {
        guard let identity, let token else { return }
        if more && (loadingMore || !hasMoreOrders) { return }
        let current = epoch
        if !more {
            orderRequest = UUID(); orderStatus = status ?? orderStatus
            orders = .loading; orderPage = 0; hasMoreOrders = false
        }
        let request = orderRequest
        loadingMore = more; moreError = nil
        let page = more ? orderPage + 1 : 1
        do {
            let response = try await api.orders(id: identity.subjectId, token: token, page: page, status: orderStatus)
            guard epoch == current, request == orderRequest else { return }
            var rows = more ? orders.value ?? [] : []
            let existing = Set(rows.map(\.id))
            rows += response.rows.filter { !existing.contains($0.id) }
            orders = .loaded(rows); orderPage = response.page; hasMoreOrders = response.hasMore; loadingMore = false
        } catch {
            guard epoch == current, request == orderRequest else { return }
            loadingMore = false
            if error is CancellationError || (error as? URLError)?.code == .cancelled {
                if !more { orders = .idle }; return
            }
            if more { moreError = error.localizedDescription } else { orders = .failed(error.localizedDescription) }
            handle(error)
        }
    }
}
