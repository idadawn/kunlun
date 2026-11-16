# 绿麒麟 Android H5 应用

`apps/android-app` 使用 Capacitor 8.6 打包 `apps/mobile-h5`，包名为 `cn.idalee.lvqilin`。H5 的 HTML、JS 和 CSS 随 APK 安装，启动入口为 `/member`，登录页可以切换员工入口 `/staff`。登录表单由本地资源提供，业务数据来自后端。仅使用员工工作台时，可安装 [Android 员工端](../apps/android-staff/README.md)；会员只查本人记录时，可安装 [Android 会员端](../apps/android-member/README.md)。

默认 API 为独立测试环境 `https://kunlun-test.idalee.cn`。不会嵌入账号、密码或令牌；继续复用原 H5 的身份和权限校验、会话存储。当前交付目标是本地调试 APK，不包含商店发布签名。

## 构建

需要 Node.js 22+、pnpm 9、JDK 21、Android SDK Platform 36 和 Build Tools 35.0.0。Gradle Wrapper 固定为 8.14.3，Android Gradle Plugin 为 8.13.0；最低 Android API 为 24，目标 API 为 36。

```sh
pnpm install --frozen-lockfile
pnpm --filter @kunlun/android-app android:build
```

脚本先检查 H5 TypeScript，将静态文件单独构建到 `apps/android-app/www`，同步到 Android assets，再执行 `assembleDebug` 和 `lintDebug`。不会覆盖普通 H5 的 `dist`，也不改变其默认同源 API 行为。macOS 可自动使用 Android Studio 自带 JDK 和 `~/Library/Android/sdk`；其他安装位置请设置 `JAVA_HOME`、`ANDROID_HOME`。

产物：

- `apps/android-app/android/app/build/outputs/apk/debug/app-debug.apk`
- `apps/android-app/android/app/build/reports/lint-results-debug.html`
- `apps/android-app/artifacts/build-info.json`（API 地址、源码基础提交和未提交状态）

需要明确切换后端时设置 `KUNLUN_ANDROID_API_URL`，只接受不带路径、查询、片段及凭据的 HTTPS origin；默认构建连接测试环境。使用 `android:sync` 可只生成资源并同步工程，再用 Android Studio 打开 `apps/android-app/android`。

原生网络使用 [CapacitorHttp](https://capacitorjs.com/docs/apis/http) 的 fetch 支持；应用只申请网络权限，不启用明文 HTTP、不忽略 TLS 错误、不放开任意 WebView 导航。关闭 Capacitor 桥接日志，避免请求参数、凭据进入日志，并关闭系统应用备份。原生返回键和窗口/键盘适配使用 Capacitor 默认实现。

## 安装及基础验收

明确选择一个模拟器序列号，避免操作其他设备：

```sh
adb devices -l
adb -s emulator-5554 install -r apps/android-app/android/app/build/outputs/apk/debug/app-debug.apk
adb -s emulator-5554 shell am start -W -n cn.idalee.lvqilin/.MainActivity
```

基础验收覆盖会员/员工登录入口、必填验证、密码显示切换、键盘返回、无效账号错误提示、前后台恢复和离线后恢复。使用不存在的测试账号可验证真实登录接口的拒绝路径；成功登录及登录后业务需要有效测试账号，不能据此宣称已验收。

证据采集可按 Test Android Apps 工作流执行，点击坐标必须从当步 UI 树中的 `bounds` 计算。截图、日志、性能输出保存在源码之外；测试过程中不要记录有效密码或令牌，不清空已有日志或应用数据。

```sh
adb -s emulator-5554 exec-out screencap -p > screen.png
adb -s emulator-5554 exec-out uiautomator dump /dev/tty > ui.xml
adb -s emulator-5554 shell dumpsys gfxinfo cn.idalee.lvqilin framestats > gfxinfo.txt
adb -s emulator-5554 shell dumpsys meminfo cn.idalee.lvqilin > meminfo.txt
```

`scripts/startup-perfetto.pbtxt` 提供 15 秒启动调度、UI/WebView 与 FrameTimeline 采集配置。使用唯一远端输出路径，先后台启动 Perfetto，再对应用执行一次 `am force-stop` / `am start -W`，等采集退出后拉取该次文件。单独重复进程冷启动获得 `am start -W` 数据，不把原生 Activity 的 `TotalTime` 当成 H5 首屏可交互耗时。

模拟器、debug 构建、JIT 和录制开销会影响绝对性能；帧统计应与 Perfetto 一起解读，单次内存快照不能证明泄漏。
