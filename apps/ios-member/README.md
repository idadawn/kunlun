# 绿麒麟会员 · iOS

SwiftUI 原生会员客户端，最低 iOS 17，支持 iPhone / iPad。使用 Xcode 16 或更新版本打开 `KunlunMember.xcodeproj`，选择 `KunlunMember` scheme 和 iPhone 模拟器运行；模拟器无需开发者签名。没有第三方 Swift 依赖，`KunlunCore` 是同目录的本地 Swift Package。

## 已实现

- 用户名密码登录，启动时通过 `/api/auth/me` 验证身份，只接受会员账号。
- 我的水票：每种水品、自提 / 配送分别展示可用票与已预留票。
- 用水记录：状态筛选、每页 20 条、加载更多、订单快照和取水码。
- 充值记录：剩余购票 / 赠票、预留、待审核赠票、退款与历史余额标记。
- 押金与袋桶：原收款金额、持有数量、可退金额、待退款与待报废状态。
- 收货地址只读、修改密码、退出登录。
- App Intents / App Shortcuts：“查看水票”和“查看用水记录”。两者在前台打开 App，未登录时保留目标并先显示登录页，不在系统卡片上暴露余额和个人资料。
- 深链接 `kunlun-member://tickets`、`kunlun-member://records` 使用同一导航状态和登录门禁。

与当前后端规则一致，会员不自助下单、充值、付款、退款或修改地址；相关业务由门店办理。没有改动后端权限。

## 服务与登录

默认连接 `https://kunlun.idalee.cn`，登录页右上角可选择独立测试环境 `https://kunlun-test.idalee.cn`。会员用户名和密码由门店设置，没有内置真实账号。接口与 `packages/shared/src/types.ts`、`api.ts` 对齐，会员 ID 取自服务端认证身份。

令牌按环境保存在设备钥匙串（`WhenUnlockedThisDeviceOnly`），密码不保存，`UserDefaults` 仅记录环境选择。网络使用 HTTPS、临时 URLSession、禁用缓存与 Cookie，不跟随重定向。401 清理会话和所有已加载会员数据；退出和修改密码调用真实后端失效接口。离线退出须由用户选择“仅清除本机登录”，不宣称已撤销服务端会话。App 后台快照遮盖会员信息。

## 演示与验证

Debug 登录页提供“体验演示”，或使用启动参数 `--demo`。演示数据是 `Tests/Fixtures` 中的虚构资料，不连接服务器、不写钥匙串，所有业务页持续显示“演示数据”。Release 不包含演示入口或演示传输实现。

```sh
swift test --package-path apps/ios-member
xcodebuild -project apps/ios-member/KunlunMember.xcodeproj \
  -scheme KunlunMember -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -parallel-testing-enabled NO CODE_SIGNING_ALLOWED=NO test
```

将模拟器名称替换为本机已安装的 iPhone。CI 自动选择可用设备。Swift Testing 覆盖接口契约、会员身份限制、分页、错误语义、会话撤销、临时网络故障、退出后迟到响应隔离；XCUITest 验证只读会员流程和 App Intent 的 `perform()` 到导航的交接。`--intent-records` 仅 Debug 可用，测试实际调用 Intent 的 `perform()`，不代表已通过 Siri 语音识别验收。

本次模拟器验收使用演示传输。真实会员凭据下的全链路联调、真机签名、Siri 语音调用和 TestFlight / App Store 发布需要后续验收；没有创建会员或更改生产数据。

## 维护入口

- `Core/`：接口 DTO、网络客户端、会话与加载状态；可在 macOS 上运行单元测试。
- `App/`：SwiftUI 页面、钥匙串、快捷指令、演示适配器和隐私声明。
- `UITests/`：原生模拟器 UI 流程。
- Xcode 使用同步文件夹，向 `App/` 或 `UITests/` 添加文件会自动纳入 target。
- 发布前设置 Signing Team、确认 Bundle ID 和 App Store Connect 隐私信息；当前未配置发布证书。

实现参考：[Apple Observation](https://developer.apple.com/documentation/SwiftUI/Managing-model-data-in-your-app)、[App Intents](https://developer.apple.com/documentation/appintents/creating-your-first-app-intent)、[UserDefaults 所需理由](https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacyaccessedapitypes/nsprivacyaccessedapitype)。
