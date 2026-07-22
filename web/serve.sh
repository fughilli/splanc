#!/usr/bin/env bash
# Serve the built web app through the M2 server (see BUILD.bazel :serve).
#
# `bazel run` starts us in the runfiles main-workspace directory, so the data
# deps are at stable relative paths: the M2 launcher at pi/server/serve and
# the vite bundle at web/dist. Mutable state lives under the SOURCE workspace
# (.ledmapper/, gitignored) so the self-signed cert — and therefore the
# browser's one-tap trust exception — survives rebuilds and restarts.
set -euo pipefail

if [[ -z "${BUILD_WORKSPACE_DIRECTORY:-}" ]]; then
  echo "error: run this via: bazelisk run //web:serve" >&2
  exit 1
fi

STATE_DIR="$BUILD_WORKSPACE_DIRECTORY/.ledmapper"
mkdir -p "$STATE_DIR"

TLS_ARGS=(--ssl-dir "$STATE_DIR/ssl")
PORT=8443
if [[ "${1:-}" == "--no-tls" ]]; then
  shift
  TLS_ARGS=()
  PORT=8080
fi

# Later duplicate flags win in argparse, so "$@" can override any default.
exec pi/server/serve \
  --host 0.0.0.0 \
  --port "$PORT" \
  --web-root web/dist \
  --solver-dir solver/solver_web \
  --pulse-dir firmware/pulse/pulse_web \
  --session-dir "$STATE_DIR/sessions" \
  --maps-dir "$STATE_DIR/maps" \
  "${TLS_ARGS[@]}" \
  "$@"
