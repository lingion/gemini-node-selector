#!/bin/bash
# Antigravity Transparent Proxy Launcher
# Injects proxy environment variables into both Antigravity Electron and Go language_server

PROXY_HOST="${1:-127.0.0.1}"
PROXY_PORT="${2:-7890}"
PROXY_URL="http://${PROXY_HOST}:${PROXY_PORT}"
SOCKS_URL="socks5://${PROXY_HOST}:${PROXY_PORT}"

echo "Starting Google Antigravity with proxy ${PROXY_URL}..."

export HTTP_PROXY="${PROXY_URL}"
export HTTPS_PROXY="${PROXY_URL}"
export http_proxy="${PROXY_URL}"
export https_proxy="${PROXY_URL}"
export ALL_PROXY="${SOCKS_URL}"
export all_proxy="${SOCKS_URL}"
export NO_PROXY="localhost,127.0.0.1,local.home"
export no_proxy="localhost,127.0.0.1,local.home"

# Locate Antigravity on macOS
if [ -d "/Applications/Antigravity.app" ]; then
    open -a "/Applications/Antigravity.app" \
        --env "HTTP_PROXY=${PROXY_URL}" \
        --env "HTTPS_PROXY=${PROXY_URL}" \
        --env "http_proxy=${PROXY_URL}" \
        --env "https_proxy=${PROXY_URL}" \
        --env "ALL_PROXY=${SOCKS_URL}" \
        --env "all_proxy=${SOCKS_URL}" \
        --args "--proxy-server=${PROXY_URL}"
elif which agy >/dev/null 2>&1; then
    agy "$@"
else
    echo "Antigravity.app not found in /Applications. Environment variables exported for current shell."
fi
