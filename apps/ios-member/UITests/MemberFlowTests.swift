import XCTest

@MainActor final class MemberFlowTests: XCTestCase {
    func testRealKeychainPersistsAndDeletesSession() {
        let app = XCUIApplication()
        let arguments = ["--ui-keychain", "-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN"]
        app.launchArguments = arguments + ["--reset-test-keychain"]
        app.launch()
        let account = app.textFields["login.account"]
        XCTAssertTrue(account.waitForExistence(timeout: 15))
        account.tap(); account.typeText("demo.member")
        let password = app.secureTextFields["login.password"]
        password.tap(); password.typeText("demo-only")
        app.buttons["login.submit"].tap()
        XCTAssertTrue(app.staticTexts["你好，林先生"].waitForExistence(timeout: 10))
        app.terminate()
        app.launchArguments = arguments
        app.launch()
        XCTAssertTrue(app.staticTexts["你好，林先生"].waitForExistence(timeout: 10))
        app.tabBars.buttons["我的"].tap()
        app.buttons["account.logout"].tap()
        app.buttons["退出登录"].firstMatch.tap()
        XCTAssertTrue(account.waitForExistence(timeout: 5))
        app.terminate(); app.launch()
        XCTAssertTrue(account.waitForExistence(timeout: 10))
    }

    func testLoginGatesIntentDestination() {
        let app = XCUIApplication()
        app.launchArguments = ["--demo-login", "--intent-records", "-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN"]
        app.launch()
        let account = app.textFields["login.account"]
        XCTAssertTrue(account.waitForExistence(timeout: 15))
        XCTAssertFalse(app.staticTexts["SD-DEMO-001"].exists)
        XCTAssertFalse(app.buttons["login.submit"].isEnabled)
        account.tap(); account.typeText("demo.member")
        let password = app.secureTextFields["login.password"]
        password.tap(); password.typeText("demo-only")
        app.buttons["login.submit"].tap()
        XCTAssertTrue(app.staticTexts["SD-DEMO-001"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.tabBars.buttons["记录"].isSelected)
    }

    func testMemberReadOnlyJourney() {
        let app = XCUIApplication()
        app.launchArguments = ["--demo", "-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN"]
        app.launch()
        XCTAssertTrue(app.staticTexts["你好，林先生"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["演示数据 · 不连接服务器"].exists)
        XCTAssertFalse(app.buttons["提交订单"].exists)
        app.tabBars.buttons["记录"].tap()
        XCTAssertTrue(app.staticTexts["SD-DEMO-001"].waitForExistence(timeout: 5))
        app.buttons["充值记录"].tap()
        XCTAssertTrue(app.staticTexts["赠票 3 份待审核"].waitForExistence(timeout: 5))
        // Packages bought before the system say so instead of the member's 2026-09-15 join date; the unknown one shows no ¥0.00.
        XCTAssertTrue(scrollTo(app.staticTexts["当时实付"], in: app))
        XCTAssertTrue(scrollTo(app.staticTexts["套餐不清楚"], in: app))
        XCTAssertTrue(app.staticTexts["可以照常用水，不能按原价退，详情请向门店核对"].exists)
        XCTAssertGreaterThan(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "上系统前买的 · 补录单")).count, 0)
        XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "2026年9月")).count, 0)
        // A legacy balance names its water from the member's tickets and hides its placeholder 2000-01-01 date.
        XCTAssertTrue(scrollTo(app.staticTexts["袋装水 5L · 到店取水"], in: app))
        XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "2000年")).count, 0)
        app.tabBars.buttons["押金与桶"].tap()
        XCTAssertTrue(app.staticTexts["我的押金余额"].waitForExistence(timeout: 5))
        app.tabBars.buttons["我的"].tap()
        app.buttons["收货地址"].tap()
        XCTAssertTrue(app.staticTexts["清泉花园 2 栋 301"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["新增地址"].exists)
    }

    func testAppIntentHandoffAndLogout() {
        let app = XCUIApplication()
        app.launchArguments = ["--demo", "--intent-records", "-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN"]
        app.launch()
        XCTAssertTrue(app.staticTexts["SD-DEMO-001"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.tabBars.buttons["记录"].isSelected)
        app.tabBars.buttons["我的"].tap()
        app.buttons["account.logout"].tap()
        app.buttons["退出登录"].firstMatch.tap()
        XCTAssertTrue(app.textFields["login.account"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["林先生"].exists)
    }

    /// The recharge list is lazy, so a card further down exists only once it has been scrolled to.
    private func scrollTo(_ element: XCUIElement, in app: XCUIApplication) -> Bool {
        var swipes = 0
        while !element.exists && swipes < 6 { app.swipeUp(); swipes += 1 }
        return element.waitForExistence(timeout: 5)
    }
}
