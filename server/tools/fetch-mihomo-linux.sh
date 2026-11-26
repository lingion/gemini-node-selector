#!/bin/sh
set -eu

version='v1.19.34'
url="https://github.com/MetaCubeX/mihomo/releases/download/${version}/mihomo-linux-amd64-v1-${version}.gz"
expected='0c07340a01408d033dda4088ea2a4c1e4d82aeed7b2f84f7c046e93b6ff3290c'
dest="$(CDPATH= cd -- "$(dirname -- "$0")/../bin" && pwd)/mihomo-linux-amd64-v1-v1.19.34.gz"

mkdir -p "$(dirname "$dest")"
/usr/bin/curl -fL --connect-timeout 20 --max-time 180 -o "$dest.tmp" "$url"
if command -v sha256sum >/dev/null 2>&1; then
  printf '%s  %s\n' "$expected" "$dest.tmp" | sha256sum -c -
else
  printf '%s  %s\n' "$expected" "$dest.tmp" | /usr/bin/shasum -a 256 -c -
fi
mv "$dest.tmp" "$dest"
echo "verified $dest"
