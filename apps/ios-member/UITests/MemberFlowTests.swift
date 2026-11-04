import XCTest

@MainActor final class MemberFlowTests: XCTestCase {
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
}
