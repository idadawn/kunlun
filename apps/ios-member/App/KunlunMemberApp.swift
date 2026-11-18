import SwiftUI
import KunlunCore

enum MemberTab: Hashable { case home, records, assets, account }

@MainActor @Observable final class MemberRouter {
    static let shared = MemberRouter()
    var tab: MemberTab = .home
    func open(_ url: URL) {
        guard url.scheme == "kunlun-member" else { return }
        switch url.host { case "tickets": tab = .home; case "records": tab = .records; default: break }
    }
}

@main struct KunlunMemberApp: App {
    @State private var store: MemberStore
    @State private var demo = false
    @State private var localOrigin: (url: URL, label: String)?
    @State private var router = MemberRouter.shared
    @Environment(\.scenePhase) private var scenePhase

    init() {
        let environment = ServiceEnvironment(rawValue: UserDefaults.standard.string(forKey: "service-environment") ?? "") ?? .production
        _store = State(initialValue: MemberStore(environment: environment, credentials: KeychainCredentials()))
        #if DEBUG
        if let local = Self.localOrigin(in: ProcessInfo.processInfo.arguments) {
            _store = State(initialValue: Self.localStore(local.url))
            _localOrigin = State(initialValue: local)
        }
        if ProcessInfo.processInfo.arguments.contains("--demo") || ProcessInfo.processInfo.arguments.contains("--demo-login") {
            _store = State(initialValue: DemoSession.makeStore(signedIn: !ProcessInfo.processInfo.arguments.contains("--demo-login")))
            _demo = State(initialValue: true)
        }
        if ProcessInfo.processInfo.arguments.contains("--ui-keychain") {
            let credentials = KeychainCredentials(service: "cn.idalee.kunlun.member.ui-tests")
            if ProcessInfo.processInfo.arguments.contains("--reset-test-keychain") { try? credentials.save(nil, for: .test) }
            _store = State(initialValue: DemoSession.makeStore(signedIn: false, credentials: credentials))
            _demo = State(initialValue: true)
        }
        #endif
    }

    #if DEBUG
    /// `-MemberOrigin http://127.0.0.1:5188` points a Debug build at a backend on this Mac. Only loopback hosts are accepted.
    static func localOrigin(in arguments: [String]) -> (url: URL, label: String)? {
        guard let index = arguments.firstIndex(of: "-MemberOrigin"), arguments.indices.contains(index + 1),
              let parts = URLComponents(string: arguments[index + 1]),
              let scheme = parts.scheme?.lowercased(), ["http", "https"].contains(scheme),
              let host = parts.host?.lowercased(), ["127.0.0.1", "localhost"].contains(host),
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/", let url = parts.url else { return nil }
        return (url, parts.port.map { "\(host):\($0)" } ?? host)
    }

    /// Its own keychain entry, so a local login never replaces a saved production or test login.
    static func localStore(_ url: URL) -> MemberStore {
        MemberStore(environment: .test, credentials: KeychainCredentials(service: "cn.idalee.kunlun.member.local"), api: MemberAPI(baseURL: url))
    }
    #endif

    var body: some Scene {
        WindowGroup {
            ZStack {
                Group {
                    if store.restoring { ProgressView("正在验证登录…") }
                    else if store.identity?.mustChangePassword == true { PasswordView(requiredChange: true) }
                    else if store.identity != nil { MemberTabs() }
                    else {
                        LoginView(onDemo: {
                            #if DEBUG
                            store = DemoSession.makeStore(); demo = true
                            #endif
                        }, onLive: {
                            demo = false
                            #if DEBUG
                            // Leaving the demo returns to the backend this build was launched against, never to production.
                            if let localOrigin { store = Self.localStore(localOrigin.url); return }
                            #endif
                            UserDefaults.standard.set(ServiceEnvironment.production.rawValue, forKey: "service-environment")
                            store = MemberStore(environment: .production, credentials: KeychainCredentials())
                        })
                    }
                }
                .environment(store).environment(router).environment(\.demoMode, demo).environment(\.localOrigin, localOrigin?.label)
                .tint(Brand.green)
                if scenePhase != .active {
                    Brand.background.ignoresSafeArea()
                    Label("绿麒麟会员", systemImage: "drop.fill").font(.title2).foregroundStyle(Brand.green)
                }
            }
            .task(id: ObjectIdentifier(store)) {
                await store.restore()
                #if DEBUG
                if ProcessInfo.processInfo.arguments.contains("--intent-records") { _ = try? await ViewWaterRecordsIntent().perform() }
                #endif
            }
            .onOpenURL { router.open($0) }
        }
    }
}

private struct DemoModeKey: EnvironmentKey { static let defaultValue = false }
private struct LocalOriginKey: EnvironmentKey { static let defaultValue: String? = nil }
extension EnvironmentValues {
    var demoMode: Bool { get { self[DemoModeKey.self] } set { self[DemoModeKey.self] = newValue } }
    /// The backend a Debug build was pointed at with `-MemberOrigin`, such as "127.0.0.1:5188"; otherwise nil.
    var localOrigin: String? { get { self[LocalOriginKey.self] } set { self[LocalOriginKey.self] = newValue } }
}

struct MemberTabs: View {
    @Environment(MemberStore.self) private var store
    @Environment(MemberRouter.self) private var router
    @Environment(\.demoMode) private var demo
    @Environment(\.localOrigin) private var localOrigin
    var body: some View {
        @Bindable var router = router
        VStack(spacing: 0) {
            if demo { Text("演示数据 · 不连接服务器").font(.caption).frame(maxWidth: .infinity).padding(7).background(.orange.opacity(0.14)) }
            else if let localOrigin { Text("本机后端 · \(localOrigin)").font(.caption).frame(maxWidth: .infinity).padding(7).background(.orange.opacity(0.14)) }
            else if store.environment == .test { Text("测试环境").font(.caption).frame(maxWidth: .infinity).padding(7).background(.orange.opacity(0.14)) }
            TabView(selection: $router.tab) {
            NavigationStack { HomeView() }.tabItem { Label("我的水票", systemImage: "drop.fill") }.tag(MemberTab.home)
            NavigationStack { RecordsView() }.tabItem { Label("记录", systemImage: "list.bullet.rectangle") }.tag(MemberTab.records)
            NavigationStack { AssetsView() }.tabItem { Label("押金与桶", systemImage: "shippingbox") }.tag(MemberTab.assets)
            NavigationStack { AccountView() }.tabItem { Label("我的", systemImage: "person.crop.circle") }.tag(MemberTab.account)
            }
        }
    }
}
