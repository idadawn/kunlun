#!/usr/bin/env bash
# Archive the iOS member or staff app and send it to App Store Connect (TestFlight / App Store), or only export the .ipa.
#   KUNLUN_IOS_TEAM=<Team ID> scripts/ios-release.sh member|staff [upload|export]
# The archive is built unsigned; the export signs it with the team's Apple Distribution certificate and an App Store
# profile, which Xcode creates through the developer account signed in to Xcode, so the team needs no registered devices.
# Every upload needs a build number (CURRENT_PROJECT_VERSION) that App Store Connect has not seen.
set -euo pipefail

usage='Usage: KUNLUN_IOS_TEAM=<Team ID> scripts/ios-release.sh member|staff [upload|export]'
app=${1:-}
mode=${2:-upload}
team=${KUNLUN_IOS_TEAM:-}
case "$app" in
  member) project=apps/ios-member/KunlunMember.xcodeproj; scheme=KunlunMember ;;
  staff) project=apps/ios-staff/KunlunStaff.xcodeproj; scheme=KunlunStaff ;;
  *) echo "$usage" >&2; exit 2 ;;
esac
case "$mode" in upload|export) ;; *) echo "$usage" >&2; exit 2 ;; esac
if [[ ! $team =~ ^[A-Z0-9]{10}$ ]]; then
  echo 'Set KUNLUN_IOS_TEAM to the 10-character Team ID shown under Membership details on developer.apple.com.' >&2
  exit 2
fi

cd "$(dirname "$0")/.."
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

xcodebuild -quiet -project "$project" -scheme "$scheme" -configuration Release -destination 'generic/platform=iOS' \
  -archivePath "$work/$scheme.xcarchive" CODE_SIGNING_ALLOWED=NO archive
property() { /usr/libexec/PlistBuddy -c "Print :ApplicationProperties:$1" "$work/$scheme.xcarchive/Info.plist"; }
version=$(property CFBundleShortVersionString)
build=$(property CFBundleVersion)
out=${KUNLUN_IOS_OUT:-$HOME/kunlun-release/ios}/$version-$build
# The archive holds the dSYMs for reading crash reports, so an earlier one with the same version and build is kept.
if [ -e "$out/$scheme.xcarchive" ]; then
  echo "$out/$scheme.xcarchive already exists; raise CURRENT_PROJECT_VERSION for a new build." >&2
  exit 1
fi
mkdir -p "$out"
mv "$work/$scheme.xcarchive" "$out/"

cat > "$work/export.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>$mode</string>
  <key>signingStyle</key><string>automatic</string>
  <key>teamID</key><string>$team</string>
  <key>uploadSymbols</key><true/>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict>
</plist>
PLIST
xcodebuild -exportArchive -archivePath "$out/$scheme.xcarchive" -exportOptionsPlist "$work/export.plist" \
  -exportPath "$out/$scheme-$mode" -allowProvisioningUpdates
echo "$scheme $version ($build): $mode finished; files are in $out"
