#!/usr/bin/env bash
# Publish the static web artifacts to Cloudflare Pages (:deploy_cloudflare).
#
# The ESP32 player does not serve the webapp (the Pi does) — it points the
# phone at an EXTERNALLY HOSTED copy (docs/esp32-led-mapping-plan.md, target
# architecture). This publishes that copy: the vite bundle (capture app +
# wall page) plus the wasm solver at /solver/, matching the paths the Pi
# server serves so the same app works from either origin. Against a hosted
# copy the phone selects its player with ?url=wss://<player-host>/ws
# (defaultWsUrl targets the serving origin, which on Pages is not a player).
#
# `bazel run` starts us in the runfiles main-workspace directory, so the data
# deps are at stable relative paths (web/dist, solver/solver_web).
#
# Usage:
#   bazelisk run //web:deploy_cloudflare                # deploy
#   bazelisk run //web:deploy_cloudflare -- --dry-run   # stage + print only
#
# Auth (deploys only): CLOUDFLARE_API_TOKEN (Pages:Edit) and
# CLOUDFLARE_ACCOUNT_ID in the environment. First deploy of a new project:
#   pnpm dlx wrangler@4 pages project create "$LEDMAPPER_CF_PROJECT" \
#       --production-branch main
#
# Config: LEDMAPPER_CF_PROJECT (default "ledmapper"),
# LEDMAPPER_CF_BRANCH (default "main" = the production deployment).
set -euo pipefail

if [[ -z "${BUILD_WORKSPACE_DIRECTORY:-}" ]]; then
  echo "error: run this via: bazelisk run //web:deploy_cloudflare" >&2
  exit 1
fi

PROJECT="${LEDMAPPER_CF_PROJECT:-ledmapper}"
BRANCH="${LEDMAPPER_CF_BRANCH:-main}"
DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
  shift
fi

# Stage the site exactly as the Pi serves it: bundle at /, solver at /solver,
# effects Sim at /pulse, effects compiler at /fx-compiler, preview VM at /fx-vm.
STAGE="$(mktemp -d)"
trap 'chmod -R u+w "$STAGE" 2>/dev/null; rm -rf "$STAGE"' EXIT
cp -RL web/dist/. "$STAGE"/
mkdir -p "$STAGE/solver"
cp -RL solver/solver_web/. "$STAGE/solver/"
mkdir -p "$STAGE/pulse"
cp -RL firmware/pulse/pulse_web/. "$STAGE/pulse/"
mkdir -p "$STAGE/fx-compiler"
cp -RL fx_compiler/fx_compiler_web/. "$STAGE/fx-compiler/"
mkdir -p "$STAGE/fx-vm"
cp -RL firmware/fx_vm/fx_vm_web/. "$STAGE/fx-vm/"
# Bazel outputs arrive read-only; the staging copy is ours.
chmod -R u+w "$STAGE"
# Dev-only artifacts that have no business on a CDN.
find "$STAGE" \( -name '*.d.ts' -o -name '.empty' \) -delete

echo "staged $(find "$STAGE" -type f | wc -l) files:"
(cd "$STAGE" && find . -type f | sort | sed 's/^/  /')

# wrangler pinned to the 4.x line; dlx keeps the deploy toolchain out of the
# repo's dependency graph (it needs network + credentials anyway).
CMD=(pnpm dlx wrangler@4 pages deploy "$STAGE"
  --project-name "$PROJECT"
  --branch "$BRANCH"
  --commit-dirty=true)

if [[ "$DRY_RUN" == "1" ]]; then
  echo "dry run — would execute:"
  echo "  ${CMD[*]}"
  exit 0
fi

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo "error: CLOUDFLARE_API_TOKEN is not set (needs a Pages:Edit token;" >&2
  echo "CLOUDFLARE_ACCOUNT_ID too unless the token maps to one account)." >&2
  exit 1
fi

exec "${CMD[@]}"
