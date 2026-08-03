#!/usr/bin/env bash
# 截圖工具：Browser pane 在本環境不合成畫面，用 Chrome headless 取代。
# 用法：tools/shot.sh <url> <out.png> [width] [height]
set -e
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
URL="$1"
OUT="$2"
W="${3:-1440}"
H="${4:-1100}"
PROFILE="$(mktemp -d)"
"$CHROME" \
  --headless=new \
  --disable-gpu \
  --hide-scrollbars \
  --force-prefers-reduced-motion \
  --force-device-scale-factor=1 \
  --user-data-dir="$PROFILE" \
  --window-size="${W},${H}" \
  --virtual-time-budget=6000 \
  --screenshot="$OUT" \
  "$URL" >/dev/null 2>&1 || true
rm -rf "$PROFILE"
ls -la "$OUT"
