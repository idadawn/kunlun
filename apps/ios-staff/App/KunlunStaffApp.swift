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

    var body: some Scene {
        WindowGroup {
            ZStack {
                StaffPalette.background.ignoresSafeArea()
                if let origin {
                    StaffScreen(origin: origin)
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
}

/// The staff pages, with a retry screen when the bundled pages cannot be opened.
struct StaffScreen: View {
    let origin: StaffOrigin
    @State private var failed = false
    @State private var attempt = 0

    var body: some View {
        StaffWebView(origin: origin, attempt: attempt, failed: $failed)
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
