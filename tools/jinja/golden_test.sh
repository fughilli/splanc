#!/usr/bin/env bash
# Byte-exact golden for the jinja_template rule (conditionals, loops,
# whitespace control all pinned — a Jinja2 behavior change shows up here).
set -euo pipefail
diff -u "$2" "$1"
echo "PASS"
