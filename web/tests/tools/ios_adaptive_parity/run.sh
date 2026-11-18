#!/usr/bin/env bash
# Numerical parity of the iOS adaptive diffuse detector (AdaptiveDiffuse.swift)
# with the TS reference (web/src/cv/diffuseDetect.ts) on the regression frames
# (web/tests/testdata/diffuse_rope). macOS + Xcode command-line tools + node.
# Float32 summation order differs (running sums vs the reference's), so a
# handful of pixels sitting exactly on the threshold may flip; the bar is
# <= 0.5% of kept pixels and <= 1 LSB on pixels both keep.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
WEB="$(cd "$HERE/../../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
"$WEB/node_modules/.bin/tsc" "$WEB/src/cv/diffuseDetect.ts" --outDir "$TMP/js" --module commonjs --target es2022 --skipLibCheck --rootDir "$WEB/src" >/dev/null
echo '{"type":"commonjs"}' > "$TMP/js/package.json"
node "$HERE/gen.cjs" "$TMP/js" "$WEB/tests/testdata/diffuse_rope" "$TMP/frames"
xcrun swiftc -O -o "$TMP/parity" "$WEB/native-plugins/camera-bridge/ios/Sources/CameraBridge/AdaptiveDiffuse.swift" "$HERE/main.swift"
"$TMP/parity" "$TMP/frames"
python3 "$HERE/compare.py" "$TMP/frames"
