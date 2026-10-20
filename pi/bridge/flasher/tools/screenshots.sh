#!/usr/bin/env bash
# Screenshot the flasher window in each state (for docs/img/pi-bridge/), using a
# headless Chromium and tools/demo.js in place of the Electron preload + sidecar.
#
#   pi/bridge/flasher/tools/screenshots.sh <out-dir> [chromium-binary]
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="$(mkdir -p "$1" && cd "$1" && pwd)"
chrome="${2:-chromium}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cp -R "$here/../electron/renderer/." "$tmp/"
cp "$here/demo.js" "$tmp/demo.js"
sed -i.bak 's|<script src="countries.js"></script>|<script src="demo.js"></script>\n    <script src="countries.js"></script>|' "$tmp/index.html"
for state in board wifi card write "done" error; do
  "$chrome" --headless=new --no-sandbox --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --window-size=860,720 --virtual-time-budget=4000 --allow-file-access-from-files \
    --screenshot="$out/flasher-$state.png" "file://$tmp/index.html#$state" >/dev/null 2>&1
  echo "$out/flasher-$state.png"
done
