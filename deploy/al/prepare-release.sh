#!/bin/sh
# Run from the repository root after pnpm build and dotnet publish -o .publish/al/api.
set -eu
release=${1:?Usage: deploy/al/prepare-release.sh OUTPUT_DIRECTORY}
test ! -e "$release" || { echo "Output directory already exists" >&2; exit 1; }
mkdir -p "$release"
cp -R .publish/al/api "$release/api"
cp -R apps/admin-pc/dist "$release/admin-pc"
cp -R apps/mini-app/dist "$release/mini-app"
# Reuse the canonical routing rules; only the container port and API upstream differ.
sed -e 's/listen 80;/listen 8080;/' -e 's|http://127.0.0.1:5188|http://api:8080|g' deploy/nginx.conf > "$release/nginx.conf"
git rev-parse HEAD > "$release/source-revision.txt"
