import AppIntents

struct ViewTicketsIntent: AppIntent {
    static let title: LocalizedStringResource = "查看水票"
    static let description = IntentDescription("打开绿麒麟会员中心，查看自己的剩余水票。未登录时先登录。")
    static let openAppWhenRun = true
    @MainActor func perform() async throws -> some IntentResult {
        MemberRouter.shared.tab = .home
        return .result()
    }
}

struct ViewWaterRecordsIntent: AppIntent {
    static let title: LocalizedStringResource = "查看用水记录"
    static let description = IntentDescription("打开自己的用水记录，了解门店登记的配送和取水情况。")
    static let openAppWhenRun = true
    @MainActor func perform() async throws -> some IntentResult {
        MemberRouter.shared.tab = .records
        return .result()
    }
}

struct MemberShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: ViewTicketsIntent(), phrases: ["用\(.applicationName)查看水票"], shortTitle: "查看水票", systemImageName: "drop.fill")
        AppShortcut(intent: ViewWaterRecordsIntent(), phrases: ["用\(.applicationName)查看用水记录"], shortTitle: "查看用水记录", systemImageName: "list.bullet.rectangle")
    }
}
