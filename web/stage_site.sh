#!/usr/bin/env bash
# Materialize the complete static site tree into a directory, for the GitHub
# Pages CI to publish (the master-merge main site and per-PR staging previews).
# The layout is defined once in stage_site.lib.sh — the same tree Cloudflare
# publishes — so every origin serves a byte-identical bundle.
#
# Usage:
#   bazel run //web:stage_site -- <output-dir>
# <output-dir> is created/overwritten. A relative path is resolved against the
# workspace root (BUILD_WORKSPACE_DIRECTORY); pass an absolute path in CI.
set -euo pipefail

if [[ -z "${BUILD_WORKSPACE_DIRECTORY:-}" ]]; then
  echo "error: run this via: bazel run //web:stage_site -- <output-dir>" >&2
  exit 1
fi

OUT="${1:?usage: bazel run //web:stage_site -- <output-dir>}"
# Resolve a relative output dir against the workspace root, not the runfiles cwd.
if [[ "$OUT" != /* ]]; then
  OUT="$BUILD_WORKSPACE_DIRECTORY/$OUT"
fi

# shellcheck source=web/stage_site.lib.sh
source web/stage_site.lib.sh

stage_site "$OUT"

echo "staged $(find "$OUT" -type f | wc -l) files into $OUT:"
(cd "$OUT" && find . -type f | sort | sed 's/^/  /')
