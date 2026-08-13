#!/usr/bin/env bash
#
# Stage the runtime WASM bundles into web/dist for the iOS (Capacitor) build.
#
# The PWA loads four WASM bundles from backend-served paths (/solver, /pulse,
# /fx-compiler, /fx-vm — see web/stage_site.lib.sh, which stages them next to the
# app for the Cloudflare/Pages deploys). The Capacitor wrapper ships only
# web/dist and has NO backend, so those paths 404 and the effects compiler/preview
# and the solver fail ("Importing a module script failed"). This copies the same
# bundles INTO web/dist so they're packaged in the app and load from
# capacitor://localhost/<path>/ locally.
#
# Runs after `vite build` (which populates web/dist) and before `cap sync`. WASM
# is platform-neutral, so it builds identically on the host or in the container.
set -euo pipefail

ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$ROOT"

echo "[stage-wasm] building WASM bundles…"
bazelisk build \
  //solver:solver_web \
  //firmware/pulse:pulse_web \
  //fx_compiler:fx_compiler_web \
  //firmware/fx_vm:fx_vm_web

dist="web/dist"
[ -f "$dist/index.html" ] || {
  echo "[stage-wasm] $dist/index.html missing — run the web build first" >&2
  exit 1
}

# stage <bazel-bin-subdir> <dist-subdir>: copy a bundle in, mirroring the paths
# web/stage_site.lib.sh publishes (so the same app code resolves them).
stage() {
  local src="bazel-bin/$1" dst="$dist/$2"
  [ -d "$src" ] || { echo "[stage-wasm] missing build output: $src" >&2; exit 1; }
  chmod -R u+w "$dst" 2>/dev/null || true   # make a prior read-only staging removable
  rm -rf "$dst"
  mkdir -p "$dst"
  # bazel outputs are read-only; cp copies the files fine but may fail to REPLICATE
  # that read-only mode on some filesystems — harmless, we make it writable next —
  # so don't let a mode-set error abort the copy.
  cp -RL "$src"/. "$dst"/ 2>/dev/null || true
  chmod -R u+w "$dst" 2>/dev/null || true
  find "$dst" -name '*.d.ts' -delete 2>/dev/null || true
  # Verify the bundle actually landed (the wasm glue JS the app imports).
  if ! ls "$dst"/*_wasm_pkg.js >/dev/null 2>&1 && ! ls "$dst"/*.js >/dev/null 2>&1; then
    echo "[stage-wasm] ERROR: nothing copied into $dst" >&2
    exit 1
  fi
  echo "[stage-wasm]   $2/  <- $1"
}

stage "solver/solver_web" "solver"
stage "firmware/pulse/pulse_web" "pulse"
stage "fx_compiler/fx_compiler_web" "fx-compiler"
stage "firmware/fx_vm/fx_vm_web" "fx-vm"

echo "[stage-wasm] done."
