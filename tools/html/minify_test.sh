#!/usr/bin/env bash
# Property checks for html_minify: strictly smaller, comments stripped,
# content/script tokens intact. Byte-exact goldens would pin the minifier
# version (it floats with the nixpkgs snapshot), so properties it is.
set -euo pipefail
src="$1"
min="$2"

src_bytes=$(wc -c < "$src")
min_bytes=$(wc -c < "$min")
if [ "$min_bytes" -ge "$src_bytes" ]; then
  echo "FAIL: not smaller ($min_bytes >= $src_bytes bytes)" >&2
  exit 1
fi

if grep -q '<!--' "$min"; then
  echo "FAIL: HTML comment survived" >&2
  exit 1
fi

for token in 'MARKER_TOKEN' 'https://example.invalid/page?a=b' \
    'value-with-%-and-{{braces}}' 'new WebSocket(' 'GLOBAL_SETTING'; do
  if ! grep -qF "$token" "$min"; then
    echo "FAIL: token lost in minification: $token" >&2
    exit 1
  fi
done

echo "PASS ($src_bytes -> $min_bytes bytes)"
