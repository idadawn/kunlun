# iOS 员工端

原生 iOS 应用，支持 iOS 17 以上的 iPhone / iPad。与 [Android 员工端](../android-staff/README.md) 相同，员工端 React 页面和样式在构建时打包进 App，由 WKWebView 加载；接口请求由原生代码转发到后端，离线时不能办理业务。没有第三方 Swift 依赖，`KunlunStaffCore` 是同目录的本地 Swift Package。

## 在模拟器运行

1. 在仓库根目录安装依赖：`pnpm install --frozen-lockfile`。构建阶段会调用 pnpm 打包 `apps/mobile-h5`；从 Xcode 构建时会在 `/opt/homebrew/bin`、`/usr/local/bin` 中查找 pnpm。
2. 按根 README 启动后端 `127.0.0.1:5188`。
3. 用 Xcode 16 或更新版本打开 `KunlunStaff.xcodeproj`，选择 `KunlunStaff` scheme 和 iPhone 模拟器运行。模拟器直接访问本机的 `127.0.0.1`，不需要端口映射。

命令行等价操作：

```sh
xcodebuild -project apps/ios-staff/KunlunStaff.xcodeproj -scheme KunlunStaff \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -derivedDataPath apps/ios-staff/DerivedData build
xcrun simctl install booted apps/ios-staff/DerivedData/Build/Products/Debug-iphonesimulator/KunlunStaff.app
xcrun simctl launch booted cn.idalee.kunlun.staff.debug
```

连接其他端口的本机后端（仅 Debug）：`xcrun simctl launch booted cn.idalee.kunlun.staff.debug -StaffOrigin http://127.0.0.1:5288`。Debug 只对 `127.0.0.1` / `localhost` 放行 HTTP。

调试版 Bundle ID 为 `cn.idalee.kunlun.staff.debug`，显示名「绿麒麟员工端」。包内没有账号密码，安装后用已有员工账号登录；登录凭据只保存在 WebView 会话中，App 被系统结束后需要重新登录，与 Android 员工端一致。

## 发布版

Release 连接构建设置 `STAFF_ORIGIN` 指定的服务器，默认 `https://kunlun.idalee.cn`。只接受 HTTPS 根地址，不能带路径、查询参数或账号；启动参数无效，Info.plist 也不含本地网络例外。Release 构建会先检查前端类型，相当于 Android 的 `checkStaffWeb`。

```sh
xcodebuild -project apps/ios-staff/KunlunStaff.xcodeproj -scheme KunlunStaff -configuration Release \
  -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO build
# 连接其他 HTTPS 服务：追加 STAFF_ORIGIN=https://kunlun-test.idalee.cn
```

正式 Bundle ID 为 `cn.idalee.kunlun.staff`。上传 TestFlight 用 `KUNLUN_IOS_TEAM=<团队 ID> scripts/ios-release.sh staff`，签名方式、构建号和注意事项见 [iOS 会员端 · 上传 TestFlight / App Store](../ios-member/README.md#上传-testflight--app-store)。员工端只给店里员工用，建议走 TestFlight 内部测试：测试员要先加进 App Store Connect 团队，最多 100 人；测试版 90 天后过期，要定期上传新构建。

## 工作方式

- 页面在 `kunlun-staff://localhost` 下由 `WKURLSchemeHandler` 提供：员工页面路由返回打包的 `www/index.html`，`/static/h5/` 返回打包资源，`/api/` 转发到服务器，其他地址一律返回 403。WebView 只能打开员工页面；`tel:` 链接交给系统电话（Android 员工端打开拨号盘，同样由员工自己拨出）。
- 主机名必须保持 `localhost`。WebKit 只把这个主机名下的自定义协议页面当作安全上下文，页面生成幂等键用的 `crypto.randomUUID()` 依赖它。
- 接口转发使用临时 URLSession，不用 Cookie 和缓存，也不跟随重定向。转发时保留页面的 `Authorization`、`Content-Type`、`Idempotency-Key` 等请求头，去掉 `Origin`、`Referer`、`Cookie`。服务器不可达时页面收到网络错误，照常提示「网络连接失败」。
- 视口固定为 1 倍，小字号输入框聚焦时不放大。键盘与 Safari 一样覆盖在页面上，不会把底部导航顶到输入框上方。
- 支持从左缘右滑返回上一页。页面进程被系统回收后自动重新加载。切到后台时，快照会遮住会员姓名和电话。
- Debug 版开启 `isInspectable`，可以用 Mac Safari 的「开发」菜单调试页面。页面错误、警告，以及每个接口调用的方法、路径和结果，会写入系统日志（subsystem `cn.idalee.kunlun.staff`）；不记录查询参数、请求头和正文。

```sh
xcrun simctl spawn booted log stream --level info --predicate 'subsystem == "cn.idalee.kunlun.staff"'
```

## 测试

```sh
swift test --package-path apps/ios-staff   # 地址规则、服务器地址校验、请求转发与响应头
pnpm test:web                              # 员工页面清单与路由表、Android 员工端一致
```

CI 的 iOS 任务会运行上述单元测试，并构建模拟器 Debug 版和真机 Release 版。

## 维护入口

- `Core/`：`StaffRoutes` 决定能打开什么，`StaffOrigin` 校验服务器地址，`StaffProxy` 组装转发请求。这些代码可在 macOS 上测试。
- `App/`：SwiftUI 入口、WKWebView、协议处理器、图标和隐私声明。Xcode 使用同步文件夹，向 `App/` 添加的文件会自动加入 target。
- 新增员工页面时要同步 `StaffRoutes.pages`，`pnpm test:web` 会检查两者一致。
- 构建阶段「Bundle staff pages」每次构建都运行 `vite build`，产物输出到 App 包内的 `www/`，不改动 `apps/mobile-h5/dist`。
