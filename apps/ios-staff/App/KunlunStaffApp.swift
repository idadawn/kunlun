import SwiftUI
import KunlunStaffCore

enum StaffPalette {
    /// The page background of the staff pages (#f8fafc), also shown around the web view and while it loads.
    static let background = Color(red: 248 / 255, green: 250 / 255, blue: 252 / 255)
    static let green = Color(red: 16 / 255, green: 152 / 255, blue: 128 / 255)
}

@main struct KunlunStaffApp: App {
    /// Release builds use the HTTPS server set at build time (`STAFF_ORIGIN`). Debug builds default to the backend on
    /// this Mac and accept `-StaffOrigin http://127.0.0.1:<port>` as a launch argument.
    private let origin: StaffOrigin? = {
        #if DEBUG
        let debug = true
        #else
        let debug = false
        #endif
        let configured = Bundle.main.object(forInfoDictionaryKey: "KunlunStaffOrigin") as? String ?? ""
        return StaffOrigin.resolve(arguments: ProcessInfo.processInfo.arguments, configured: configured, debug: debug)
    }()
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.openURL) private var openURL
    @State private var reviewing = false

    var body: some Scene {
        WindowGroup {
            ZStack {
                StaffPalette.background.ignoresSafeArea()
                if let origin {
                    StaffScreen(origin: reviewing ? .review : origin, reviewing: reviewing, onAction: onAction)
                        .id(reviewing)
                        .safeAreaInset(edge: .top, spacing: 0) {
                            if reviewing {
                                HStack {
                                    Label("审核演示 · 仅演示数据", systemImage: "testtube.2")
                                    Spacer()
                                    Button("返回正式环境") { reviewing = false }
                                }
                                .font(.footnote)
                                .padding(.horizontal, 12)
                                .padding(.vertical, 8)
                                .background(.thinMaterial)
                            }
                        }
                } else {
                    ContentUnavailableView("服务器地址无效", systemImage: "exclamationmark.triangle",
                                           description: Text("请检查构建设置 STAFF_ORIGIN：只能是 HTTPS 地址。"))
                }
                // Keeps member names and phone numbers out of the app switcher snapshot.
                if scenePhase != .active {
                    StaffPalette.background.ignoresSafeArea()
                    Label("绿麒麟员工端", systemImage: "drop.fill").font(.title2).foregroundStyle(StaffPalette.green)
                }
            }
        }
    }

    private func onAction(_ action: StaffAppAction) {
        switch action {
        case .review:
            reviewing = true
        case .privacy:
            openURL(URL(string: "https://kunlun.idalee.cn/privacy/ios")!)
        case .support:
            openURL(URL(string: "https://kunlun.idalee.cn/support/ios")!)
        }
    }
}

/// The staff pages, with a retry screen when the bundled pages cannot be opened.
struct StaffScreen: View {
    let origin: StaffOrigin
    let reviewing: Bool
    let onAction: (StaffAppAction) -> Void
    @State private var failed = false
    @State private var attempt = 0

    var body: some View {
        StaffWebView(origin: origin, reviewing: reviewing, attempt: attempt, failed: $failed, onAction: onAction)
            // The keyboard covers the page as in Safari: WebKit scrolls the focused field above it and the fixed
            // bottom bars stay behind it. Shrinking the view instead lifts those bars over the field being typed in.
            .ignoresSafeArea(.keyboard)
            .overlay {
                if failed {
                    VStack(spacing: 16) {
                        Text("页面加载失败，请重试").foregroundStyle(.secondary)
                        Button("重新加载") { failed = false; attempt += 1 }
                            .buttonStyle(.borderedProminent).tint(StaffPalette.green)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(StaffPalette.background)
                }
            }
    }
}
