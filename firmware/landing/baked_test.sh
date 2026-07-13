#!/usr/bin/env bash
# The baked landing page must carry the real app origin, no leftover
# template syntax, and the load-bearing pieces of the R2 flow: the
# same-origin WSS probe and the ?url= bounce. Greps are TOKEN-level (not
# exact expressions) because the page ships minified — the minifier may
# legally rewrite spacing/quoting around them.
set -euo pipefail
page="$1"

grep -q 'https://ledmapper.pages.dev' "$page" || {
  echo "FAIL: app origin not baked in" >&2
  exit 1
}
if grep -qE '%%|\{\{|\{%' "$page"; then
  echo "FAIL: unsubstituted placeholder / template syntax remains" >&2
  exit 1
fi
grep -q 'new WebSocket(' "$page" || {
  echo "FAIL: same-origin WSS probe missing" >&2
  exit 1
}
grep -q 'encodeURIComponent(wsUrl)' "$page" || {
  echo "FAIL: bounce link construction missing" >&2
  exit 1
}
grep -q '/?url=' "$page" || {
  echo "FAIL: bounce query parameter missing" >&2
  exit 1
}
grep -q 'location.replace(' "$page" || {
  echo "FAIL: unconditional redirect (location.replace) missing" >&2
  exit 1
}
# Minification proof: the template's sizeable header comment (and every
# other HTML comment) must not reach the flash image.
if grep -q '<!--' "$page"; then
  echo "FAIL: HTML comment survived minification" >&2
  exit 1
fi
echo "PASS ($(wc -c < "$page") bytes)"
