# 绿麒麟会员 · iOS

SwiftUI 原生会员客户端，最低 iOS 17，支持 iPhone / iPad。使用 Xcode 16 或更新版本打开 `KunlunMember.xcodeproj`，选择 `KunlunMember` scheme 和 iPhone 模拟器运行；模拟器使用 Xcode 自动生成的本地签名，无需开发者账号。不要禁用模拟器签名，否则钥匙串缺少必要的应用标识权限。没有第三方 Swift 依赖，`KunlunCore` 是同目录的本地 Swift Package。

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

连本机后端联调（仅 Debug）：`xcrun simctl launch booted cn.idalee.kunlun.member -MemberOrigin http://127.0.0.1:5188`。只接受本机回环地址（`127.0.0.1` 或 `localhost`）；登录页右上角、业务页顶部和「我的」页的当前服务都标出本机后端地址，不能切换环境，从「体验演示」返回也回到这个地址；令牌存在单独的钥匙串项 `cn.idalee.kunlun.member.local`，不影响正式和测试环境已保存的登录。演示数据库里的会员用户名是小写会员编号（如 `no.008621`），密码为后端的 `Kunlun__SeedPassword`。

令牌按环境保存在设备钥匙串（`WhenUnlockedThisDeviceOnly`），密码不保存，`UserDefaults` 仅记录环境选择。网络使用 HTTPS、临时 URLSession、禁用缓存与 Cookie，不跟随重定向。401 清理会话和所有已加载会员数据；退出和修改密码调用真实后端失效接口。离线退出须由用户选择“仅清除本机登录”，不宣称已撤销服务端会话。App 后台快照遮盖会员信息。

## 演示与验证

Debug 登录页提供“体验演示”，或使用启动参数 `--demo`。演示数据是 `Tests/Fixtures` 中的虚构资料，不连接服务器、不写钥匙串，所有业务页持续显示“演示数据”。Release 不包含演示入口或演示传输实现。

```sh
swift test --package-path apps/ios-member
xcodebuild -project apps/ios-member/KunlunMember.xcodeproj \
  -scheme KunlunMember -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -parallel-testing-enabled NO test
```

将模拟器名称替换为本机已安装的 iPhone。CI 自动选择可用设备。Swift Testing 覆盖接口契约、会员身份限制、分页、错误语义、会话撤销、临时网络故障、退出后迟到响应隔离；XCUITest 验证登录门禁、只读会员流程和 App Intent 的 `perform()` 到导航的交接。`--intent-records` 仅 Debug 可用，测试实际调用 Intent 的 `perform()`，不代表已通过 Siri 语音识别验收。另有 `--ui-keychain` 测试模式，使用演示网络和独立的 `cn.idalee.kunlun.member.ui-tests` 钥匙串服务，验证真实钥匙串写入、跨进程恢复与退出删除；只写入虚构测试令牌，不触碰正式登录项。

2026-11-17 用 `-MemberOrigin` 在模拟器上连本机临时后端（演示数据）走通了会员全链路：登录、水票、记录、押金、地址、退出、改密码和离线提示，结果见架构说明第 14 节。真机签名、Siri 语音调用和 TestFlight / App Store 发布仍需后续验收；没有创建会员或更改生产数据。

## 上传 TestFlight / App Store

会员端和员工端用同一个脚本上传，签名用开发者团队的发布证书：

```sh
KUNLUN_IOS_TEAM=<团队 ID> scripts/ios-release.sh member          # 归档并上传会员端
KUNLUN_IOS_TEAM=<团队 ID> scripts/ios-release.sh staff export    # 只导出员工端 .ipa，不上传
```

- 团队 ID 是 developer.apple.com「会员资格详细信息」里的 10 位字母数字。Xcode 设置 → Accounts 里要登录这个团队的账号；账号持有人或管理员才能让 Xcode 自动生成发布证书。
- 脚本先不签名归档，导出时再用 Apple Distribution 证书和 App Store 描述文件签名。证书和描述文件都由 Xcode 通过登录的账号自动创建，团队里不需要登记设备。
- 每次上传都要用 App Store Connect 没用过的构建号：在 Xcode 工程里把 `CURRENT_PROJECT_VERSION` 加 1，改版本时再改 `MARKETING_VERSION`。
- 归档和安装包放在 `~/kunlun-release/ios/<版本>-<构建号>/`（可用 `KUNLUN_IOS_OUT` 指定目录）。归档里有符号文件，看崩溃报告要用，请保留。
- App Store Connect 里要先建好对应的 App（套装 ID `cn.idalee.kunlun.member`、`cn.idalee.kunlun.staff`）。上传后苹果处理 5–30 分钟，之后出现在 TestFlight。Info.plist 已声明不使用受管制加密，上传时不用回答出口合规问题。
- 上架 App Store 还需要隐私政策网址、「App 隐私」问卷、iPhone 和 iPad 截图，以及给审核员的会员账号（会员端必须登录才能用）。
- 首个版本：会员端、员工端都是 1.0.0（构建号 1），2026-11-17 上传。

## 维护入口

- `Core/`：接口 DTO、网络客户端、会话与加载状态；可在 macOS 上运行单元测试。
- `App/`：SwiftUI 页面、钥匙串、快捷指令、演示适配器和隐私声明。
- `UITests/`：原生模拟器 UI 流程。
- Xcode 使用同步文件夹，向 `App/` 或 `UITests/` 添加文件会自动纳入 target。

实现参考：[Apple Observation](https://developer.apple.com/documentation/SwiftUI/Managing-model-data-in-your-app)、[App Intents](https://developer.apple.com/documentation/appintents/creating-your-first-app-intent)、[UserDefaults 所需理由](https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacyaccessedapitypes/nsprivacyaccessedapitype)。
