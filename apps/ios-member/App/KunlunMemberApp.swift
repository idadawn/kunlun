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
    @State private var router = MemberRouter.shared
    @Environment(\.scenePhase) private var scenePhase

    init() {
        let environment = ServiceEnvironment(rawValue: UserDefaults.standard.string(forKey: "service-environment") ?? "") ?? .production
        _store = State(initialValue: MemberStore(environment: environment, credentials: KeychainCredentials()))
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--demo") || ProcessInfo.processInfo.arguments.contains("--demo-login") {
            _store = State(initialValue: DemoSession.makeStore(signedIn: !ProcessInfo.processInfo.arguments.contains("--demo-login")))
            _demo = State(initialValue: true)
        }
        #endif
    }

    var body: some Scene {
        WindowGroup {
            ZStack {
                Group {
                    if store.restoring { ProgressView("正在验证登录…") }
                    else if store.identity != nil { MemberTabs() }
                    else {
                        LoginView(onDemo: {
                            #if DEBUG
                            store = DemoSession.makeStore(); demo = true
                            #endif
                        }, onLive: {
                            UserDefaults.standard.set(ServiceEnvironment.production.rawValue, forKey: "service-environment")
                            store = MemberStore(environment: .production, credentials: KeychainCredentials()); demo = false
                        })
                    }
                }
                .environment(store).environment(router).environment(\.demoMode, demo)
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
extension EnvironmentValues {
    var demoMode: Bool { get { self[DemoModeKey.self] } set { self[DemoModeKey.self] = newValue } }
}

struct MemberTabs: View {
    @Environment(MemberStore.self) private var store
    @Environment(MemberRouter.self) private var router
    @Environment(\.demoMode) private var demo
    var body: some View {
        @Bindable var router = router
        VStack(spacing: 0) {
            if demo { Text("演示数据 · 不连接服务器").font(.caption).frame(maxWidth: .infinity).padding(7).background(.orange.opacity(0.14)) }
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
