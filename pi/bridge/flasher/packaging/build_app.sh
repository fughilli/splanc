#!/usr/bin/env bash
# Build the Splanc Bridge Flasher end to end on macOS (.dmg) or Linux (.AppImage).
# Windows: build_app.ps1. CI: .github/workflows/pi-bridge-image.yml (flasher job).
#
#   FLASHER_VERSION=1.2.3 pi/bridge/flasher/packaging/build_app.sh
#
# Steps: unit tests -> freeze the sidecar (PyInstaller) -> electron-builder.
# Output: pi/bridge/flasher/electron/dist/Splanc-Bridge-Flasher-<ver>-<os>-<arch>.<ext>
#
# macOS signing: when CSC_LINK (base64 Developer ID Application .p12) and
# CSC_KEY_PASSWORD are set, electron-builder signs with them, and notarizes when
# APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID are set too. Without
# them the app is ad-hoc signed: it runs, but Gatekeeper asks the user to allow it
# once (System Settings > Privacy & Security > Open Anyway; docs/pi-bridge.md).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
flasher="$(cd "$here/.." && pwd)"
ver="${FLASHER_VERSION:-0.0.0-dev}"
py="${PYTHON:-python3}"

echo "==> version $ver"
printf '{"version": "%s"}\n' "$ver" >"$flasher/version.json"

echo "==> python deps + unit tests"
"$py" -m pip install --disable-pip-version-check -q -r "$here/requirements.txt"
(cd "$flasher" && "$py" -m pytest -q -p no:cacheprovider tests)

echo "==> freeze the sidecar"
"$py" -m PyInstaller --noconfirm --distpath "$flasher/dist" --workpath "$flasher/.pyibuild" \
  "$here/sidecar.spec"
# The frozen sidecar must start and speak the protocol.
"$py" "$here/smoke_sidecar.py" "$flasher/dist/splanc-flasher-sidecar/splanc-flasher-sidecar"

echo "==> electron-builder"
cd "$flasher/electron"
npm ci --no-audit --no-fund
npm version "$ver" --no-git-tag-version --allow-same-version >/dev/null
# CI passes the signing variables even when the secrets don't exist; an EMPTY
# CSC_LINK makes electron-builder try to read the project dir as a certificate.
for v in CSC_LINK CSC_KEY_PASSWORD APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID; do
  if [ -z "${!v:-}" ]; then unset "$v"; fi
done
args=(--publish never)
if [ "$(uname -s)" = Darwin ]; then
  if [ -n "${CSC_LINK:-}" ]; then
    echo "    signing with the Developer ID certificate"
    if [ -n "${APPLE_ID:-}" ]; then args+=(-c.mac.notarize=true); else args+=(-c.mac.notarize=false); fi
  else
    echo "    no signing certificate: ad-hoc signed (users allow it once in Privacy & Security)"
    export CSC_IDENTITY_AUTO_DISCOVERY=false
    args+=(-c.mac.identity=- -c.mac.hardenedRuntime=false -c.mac.notarize=false)
  fi
  args+=(--mac)
else
  args+=(--linux)
fi
npx --no-install electron-builder "${args[@]}"

echo "==> artifacts"
ls -l "$flasher"/electron/dist/*.dmg "$flasher"/electron/dist/*.AppImage 2>/dev/null || true
