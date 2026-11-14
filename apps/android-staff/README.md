# Android 员工端

可安装的 Android 应用，支持 Android 8.0（API 26）以上。员工端 React 页面和样式打包在 APK 中，由内置 WebView 加载；无需 Chrome，也无需启动 Vite。业务数据来自后端，离线时不能办理业务。

## 本地安装到模拟器

先在仓库根目录安装依赖（`pnpm install --frozen-lockfile`），按根 README 启动后端 `127.0.0.1:5188`，并在 Android Studio 启动一个模拟器，再运行：

```sh
pnpm android:staff
```

脚本自动使用 macOS Android Studio 的 JDK 与默认 SDK，其他环境请设置 `JAVA_HOME`、`ANDROID_HOME`。它会构建 APK、设置 adb 端口映射、安装并启动员工端，并读取已有的 `HTTP_PROXY` / `HTTPS_PROXY`（显式 Gradle 代理设置优先）。指定设备可设置 `ANDROID_SERIAL=emulator-5554`。调试版应用 ID 为 `cn.idalee.kunlun.staff.debug`，连接本机后端；只对 `127.0.0.1` 放行 HTTP。

APK：`app/build/outputs/apk/debug/app-debug.apk`。包内没有账号密码，安装后用已有员工账号登录。当前登录凭据仅保存在 WebView 会话中，不另行持久保存密码。

一键脚本默认把 Gradle 缓存放在本项目忽略的 `.gradle-user-home`，避免与其他 Android 工程争用缓存；可通过 `GRADLE_USER_HOME` 覆盖。构建关闭文件系统监视，不启动常驻 Gradle 服务。

## 构建与检查

```sh
cd apps/android-staff
./gradlew :app:assembleDebug :app:testDebugUnitTest :app:lintDebug
./gradlew :app:assembleRelease -PstaffReleaseOrigin=https://kunlun.idalee.cn
```

Gradle 会先检查前端类型，再将当前 `apps/mini-app` 构建到生成的 assets 目录，不改动 H5 的 `dist`。发布版仅允许 HTTPS，默认连接正式服务，可用 `staffReleaseOrigin` 指定其他 HTTPS 域名。发布 APK 尚未配置签名，正式分发前需由发布人员提供签名配置；本地调试包由 Android 调试密钥签名。

容器只允许员工端路由与指定服务器的 API 请求，文件访问、外部内容导航和混合内容均关闭；Android 返回键先返回应用内上一页，根页返回桌面。状态栏、手势区和软键盘通过原生窗口边距处理。
