#!/bin/sh
set -eu

version='1.14.6'
host='github.com'
url="https://${host}/SagerNet/sing-box/releases/download/v${version}/sing-box-${version}-linux-amd64.tar.gz"
expected='273e16c1c7881bee94d71e2e38f5bbb5e14971995fd8dd4e145394bf6d23311b'
script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
bin_dir="$script_dir/../bin"
archive="$bin_dir/sing-box-${version}-linux-amd64.tar.gz"

mkdir -p "$bin_dir"
/usr/bin/curl -fL --connect-timeout 20 --max-time 180 -o "$archive.tmp" "$url"
if command -v sha256sum >/dev/null 2>&1; then
  printf '%s  %s\n' "$expected" "$archive.tmp" | sha256sum -c -
else
  printf '%s  %s\n' "$expected" "$archive.tmp" | /usr/bin/shasum -a 256 -c -
fi
mv "$archive.tmp" "$archive"
tar -xzf "$archive" -C "$bin_dir" --strip-components=1 "sing-box-${version}-linux-amd64/sing-box"
chmod +x "$bin_dir/sing-box"
echo "verified $bin_dir/sing-box"
