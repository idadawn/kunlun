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

Gradle 会先检查前端类型，再将当前 `apps/mobile-h5` 构建到生成的 assets 目录，不改动 H5 的 `dist`。发布版仅允许 HTTPS，默认连接正式服务，可用 `staffReleaseOrigin` 指定其他 HTTPS 域名。不提供签名配置时，发布包不签名（`app-release-unsigned.apk`，CI 即如此）；本地调试包由 Android 调试密钥签名。

## 正式签名与打包

员工端和会员端用同一把签名密钥。密钥和密码只放在发布人员的电脑和备份里，不进仓库。

1. **生成密钥**（只做一次）。命令会提示输入密码和名称；macOS 上若找不到 `keytool`，用 Android Studio 自带的 `"/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/keytool"`。

   ```sh
   mkdir -p ~/kunlun-release && chmod 700 ~/kunlun-release
   keytool -genkeypair -v -keystore ~/kunlun-release/kunlun-release.jks -storetype PKCS12 \
     -alias kunlun -keyalg RSA -keysize 4096 -validity 10000
   ```

2. **写签名配置**：在同一目录建 `signing.properties`，执行 `chmod 600`。PKCS12 密钥库的两个密码相同；`storeFile` 写相对路径时，从这个文件所在目录找。

   ```properties
   storeFile=kunlun-release.jks
   storePassword=生成密钥时设的密码
   keyAlias=kunlun
   keyPassword=同上
   ```

3. **打包**：`-PkunlunSigning` 也可以换成环境变量 `KUNLUN_ANDROID_SIGNING`。文件不存在或缺项时构建直接失败，不会悄悄打出未签名的包。

   ```sh
   cd apps/android-staff
   ./gradlew :app:assembleRelease -PkunlunSigning=$HOME/kunlun-release/signing.properties
   ```

   输出 `app/build/outputs/apk/release/app-release.apk`，同时带 v1、v2 签名。可以用 SDK 的 `build-tools/<版本>/apksigner verify --min-sdk-version 23 --print-certs <apk>` 核对。

4. **保管**：密钥或密码丢了，就不能再发布能覆盖安装的更新，用户只能卸载重装。请把 `kunlun-release.jks` 和密码另外备份，比如放进密码管理器。

版本号在 `app/build.gradle` 的 `versionCode` 和 `versionName`，首个正式版是 1 / 1.0.0；以后每次发布，`versionCode` 至少加 1。正式版连接 `https://kunlun.idalee.cn`，所以线上服务要先更新到与 App 同一版本再发布。

## 容器规则

容器代码与 [Android 会员端](../android-member/README.md) 一致（`StaffUrls` 对应 `MemberUrls`），改动时两边同步；电话链接只有员工端处理。

- 只允许员工端路由与指定服务器的 API 请求，文件访问、外部内容导航和混合内容均关闭。
- 点水单上的收货人电话会打开系统拨号盘并填好号码，由员工自己拨出，不需要电话权限。只认手指点击、格式正常的 `tel:` 号码，脚本跳转和 `*21#` 这类代码会被拦下。
- Android 返回键先返回应用内上一页，根页返回桌面。状态栏、手势区和软键盘通过原生窗口边距处理。
- Android 13 起，最近任务里的缩略图不显示业务内容；直接从 App 进入多任务时，系统显示的仍是实时画面。不禁止截图。
- 页面渲染进程被系统回收或崩溃时，App 换一个新的 WebView 而不是退出：崩溃后显示「页面加载失败，请重试」，被回收则直接重新打开。两种情况都需要重新登录。
