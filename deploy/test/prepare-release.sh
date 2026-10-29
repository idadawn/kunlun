#!/bin/sh
# Run after pnpm build and dotnet publish -o .publish/test/api.
set -eu
release=${1:?Usage: deploy/test/prepare-release.sh OUTPUT_DIRECTORY}
test ! -e "$release" || { echo "Output directory already exists" >&2; exit 1; }
mkdir -p "$release"
cp -R .publish/test/api "$release/api"
cp -R apps/admin-pc/dist "$release/admin-pc"
cp -R apps/mini-app/dist "$release/mini-app"
sed -e 's/listen 80;/listen 8080;/' -e 's|http://127.0.0.1:5188|http://api:8080|g' deploy/nginx.conf > "$release/nginx.conf"
git rev-parse HEAD > "$release/source-revision.txt"
