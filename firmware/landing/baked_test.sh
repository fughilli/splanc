#!/usr/bin/env bash
# The baked landing page must carry the real app origin and no leftover
# placeholders, and keep the two load-bearing pieces of the R2 flow: the
# same-origin WSS probe and the ?url= bounce.
set -euo pipefail
page="$1"

grep -q 'https://ledmapper.pages.dev' "$page" || {
  echo "FAIL: app origin not baked in" >&2
  exit 1
}
if grep -q '%%' "$page"; then
  echo "FAIL: unsubstituted placeholder remains" >&2
  exit 1
fi
grep -q 'new WebSocket(wsUrl)' "$page" || {
  echo "FAIL: same-origin WSS probe missing" >&2
  exit 1
}
grep -q '"/?url=" + encodeURIComponent(wsUrl)' "$page" || {
  echo "FAIL: bounce link construction missing" >&2
  exit 1
}
grep -q 'location.replace(target)' "$page" || {
  echo "FAIL: unconditional redirect (location.replace) missing" >&2
  exit 1
}
echo "PASS"
