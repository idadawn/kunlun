#!/usr/bin/env bash
set -euo pipefail
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
sdk_dir="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
if [[ -z "${JAVA_HOME:-}" && -d '/Applications/Android Studio.app/Contents/jbr/Contents/Home' ]]; then
  export JAVA_HOME='/Applications/Android Studio.app/Contents/jbr/Contents/Home'
fi
export ANDROID_HOME="$sdk_dir"
# Keep this app's cache independent from other Android builds on the workstation.
export GRADLE_USER_HOME="${GRADLE_USER_HOME:-$repo_dir/apps/android-staff/.gradle-user-home}"
# The wrapper downloads before Gradle init scripts run, so supply proxy settings to its JVM too.
proxy_jvm_options="$(node -e '
  for (const scheme of ["http", "https"]) {
    const value = process.env[scheme.toUpperCase() + "_PROXY"];
    if (!value) continue;
    const proxy = new URL(value);
    if (!["http:", "https:"].includes(proxy.protocol)) continue;
    process.stdout.write(`-D${scheme}.proxyHost=${proxy.hostname} -D${scheme}.proxyPort=${proxy.port || (proxy.protocol === "https:" ? 443 : 80)} `);
  }
')"
export JAVA_OPTS="$proxy_jvm_options ${JAVA_OPTS:-}"
adb_bin="$sdk_dir/platform-tools/adb"
if [[ ! -x "$adb_bin" ]]; then
  echo '找不到 adb，请设置 ANDROID_HOME。' >&2
  exit 1
fi
serial="${ANDROID_SERIAL:-$("$adb_bin" devices | awk '$1 ~ /^emulator-/ && $2 == "device" {print $1; exit}')}"
if [[ -z "$serial" ]]; then
  echo '请先启动 Android 模拟器；连接真机时请设置 ANDROID_SERIAL。' >&2
  exit 1
fi
cd "$repo_dir/apps/android-staff"
./gradlew --no-daemon --no-watch-fs -I gradle/proxy-from-env.gradle :app:assembleDebug --console=plain
"$adb_bin" -s "$serial" reverse tcp:5188 tcp:5188
"$adb_bin" -s "$serial" install -r app/build/outputs/apk/debug/app-debug.apk
"$adb_bin" -s "$serial" shell am start -n cn.idalee.kunlun.staff.debug/cn.idalee.kunlun.staff.MainActivity
