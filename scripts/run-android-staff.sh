#!/usr/bin/env bash
set -euo pipefail
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
sdk_dir="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
if [[ -z "${JAVA_HOME:-}" && -d '/Applications/Android Studio.app/Contents/jbr/Contents/Home' ]]; then
  export JAVA_HOME='/Applications/Android Studio.app/Contents/jbr/Contents/Home'
fi
export ANDROID_HOME="$sdk_dir"
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
./gradlew -I gradle/proxy-from-env.gradle :app:assembleDebug --console=plain
"$adb_bin" -s "$serial" reverse tcp:5188 tcp:5188
"$adb_bin" -s "$serial" install -r app/build/outputs/apk/debug/app-debug.apk
"$adb_bin" -s "$serial" shell am start -n cn.idalee.kunlun.staff.debug/cn.idalee.kunlun.staff.MainActivity
