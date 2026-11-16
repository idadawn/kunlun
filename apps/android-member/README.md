# Android 会员端

可安装的 Android 会员应用「绿麒麟会员」，支持 Android 8.0（API 26）以上。会员中心 `/member` 的 React 页面和样式打包在 APK 中，由内置 WebView 加载；无需 Chrome，也无需启动 Vite。数据来自后端，会员只读查看本人水票、用水与充值记录、押金和桶袋；下单、充值、交退押金都到店或找送水员办理。

## 本地安装到模拟器

先在仓库根目录安装依赖（`pnpm install --frozen-lockfile`），按根 README 启动后端 `127.0.0.1:5188`，并在 Android Studio 启动一个模拟器，再运行：

```sh
pnpm android:member
```

脚本与员工端相同：自动使用 macOS Android Studio 的 JDK 与默认 SDK（其他环境请设置 `JAVA_HOME`、`ANDROID_HOME`），构建 APK、设置 adb 端口映射、安装并启动会员端，并读取已有的 `HTTP_PROXY` / `HTTPS_PROXY`。指定设备可设置 `ANDROID_SERIAL=emulator-5554`。调试版应用 ID 为 `cn.idalee.kunlun.member.debug`，连接本机后端，只对 `127.0.0.1` 放行 HTTP。后端不在 5188 端口时，把模拟器的 5188 映射到本机端口即可，例如 `adb reverse tcp:5188 tcp:5288`。

APK：`app/build/outputs/apk/debug/app-debug.apk`。包内没有账号密码，安装后用门店设置的会员账号登录（演示数据库里是小写会员编号，如 `no.008621`）。登录状态只保存在 WebView 会话中，App 被关掉或被系统回收后需要重新登录；不保存密码。

一键脚本默认把 Gradle 缓存放在本项目忽略的 `.gradle-user-home`，可通过 `GRADLE_USER_HOME` 覆盖。

## 构建与检查

```sh
cd apps/android-member
./gradlew :app:assembleDebug :app:testDebugUnitTest :app:lintDebug
./gradlew :app:assembleRelease -PmemberReleaseOrigin=https://kunlun.idalee.cn
```

Gradle 会先检查前端类型，再将当前 `apps/mobile-h5` 构建到生成的 assets 目录，不改动 H5 的 `dist`。员工端和会员端打包的是同一份 H5，会员端只放行会员页面。发布版仅允许 HTTPS，默认连接正式服务，可用 `memberReleaseOrigin` 指定其他 HTTPS 域名。发布 APK 尚未配置签名，正式分发前需由发布人员提供签名配置；本地调试包由 Android 调试密钥签名。

## 容器规则

容器代码与 [Android 员工端](../android-staff/README.md) 一致（`MemberUrls` 对应 `StaffUrls`），改动时两边同步；会员页面不显示电话链接，会员端不处理 `tel:`。

- 只打开会员页面（`/member` 及各子页，以及旧链接 `/member/order`、`/member/addresses`）和 `/static/h5/` 下的打包资源，接口只发往配置的服务器 `/api/`；员工页、管理页和其他地址返回 403，跳转被拦下。页面清单由 `scripts/web-routes.test.mjs` 对照 `WEB_ROUTES.member` 检查。
- 文件访问、外部内容导航和混合内容均关闭，不接受第三方 Cookie，关闭系统备份；只有调试版开启 WebView 调试。
- Android 返回键先返回应用内上一页，根页返回桌面。状态栏、手势区和软键盘通过原生窗口边距处理。
- Android 13 起，最近任务里的缩略图不显示会员信息；直接从 App 进入多任务时，系统显示的仍是实时画面。不禁止会员自己截图，方便保存取水码。
- 页面渲染进程被系统回收或崩溃时，App 换一个新的 WebView 而不是退出：崩溃后显示「页面加载失败，请重试」，被回收则直接重新打开。两种情况都需要重新登录。
