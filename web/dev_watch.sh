#!/usr/bin/env bash
# web/dev_watch.sh — the //web:dev driver. One bazel command for a hermetic,
# live-reloading, TLS dev server:
#
#   bazelisk run //web:dev            # https://localhost:8443, hot reload
#   bazelisk run //web:dev -- --no-tls
#   bazelisk run //web:dev -- --port 9443 --backend-port 9080
#
# Fully hermetic — needs NO host Node/pnpm and no developer pnpm store:
#   * Vite runs via //web:dev_server (js_run_devserver) on Bazel's node
#     toolchain + the Bazel-linked node_modules (jsqr et al. included).
#   * The M2 backend is //pi/server:serve — a rules_python py_binary with a
#     hermetic interpreter — serving the §7 WebSocket, /maps, and the wasm dirs.
#   * ibazel is //third_party/ibazel, a standalone bazel-watcher binary fetched
#     by Bazel (NOT the @bazel/ibazel npm package), so the watch layer is
#     node-free too. It re-runs //web:dev_server on change → Vite re-serves live.
#
# The only host tools this touches are bazelisk (the build tool) and openssl
# (self-signed cert, same as pi/server/server/tls.py and //web:serve).
set -euo pipefail

if [[ -z "${BUILD_WORKSPACE_DIRECTORY:-}" ]]; then
  echo "error: run this via: bazelisk run //web:dev" >&2
  exit 1
fi

# `bazel run` starts us in the runfiles root; pin it before anything else so the
# backend, wasm bundles, and the ibazel binary resolve at stable paths.
RUNFILES="$PWD"
STATE_DIR="$BUILD_WORKSPACE_DIRECTORY/.ledmapper"
IBAZEL="$RUNFILES/third_party/ibazel/ibazel"

PORT=8443
BACKEND_PORT=8080
USE_TLS=1
EXTRA_BACKEND=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --backend-port) BACKEND_PORT="$2"; shift 2 ;;
    --no-tls) USE_TLS=0; PORT=8080; BACKEND_PORT=8081; shift ;;
    --) shift; EXTRA_BACKEND+=("$@"); break ;;
    *) EXTRA_BACKEND+=("$1"); shift ;;
  esac
done

BAZEL_BIN="$(command -v bazelisk || command -v bazel || true)"
if [[ -z "$BAZEL_BIN" ]]; then
  echo "error: neither bazelisk nor bazel found on PATH" >&2
  exit 1
fi

# Self-signed cert shared with //web:serve (same dir + SANs as
# pi/server/server/tls.py) so a browser trust exception covers both paths.
SSL_DIR="$STATE_DIR/ssl"
CERT="$SSL_DIR/cert.pem"
KEY="$SSL_DIR/key.pem"
if [[ "$USE_TLS" == "1" && ( ! -f "$CERT" || ! -f "$KEY" ) ]]; then
  mkdir -p "$SSL_DIR"
  openssl req -x509 -newkey rsa:2048 -keyout "$KEY" -out "$CERT" \
    -days 3650 -nodes -subj "/CN=ledmapper" \
    -addext "subjectAltName=DNS:localhost,DNS:ledmapper.local,IP:127.0.0.1" \
    >/dev/null 2>&1
fi

# M2 backend: http on localhost (Vite terminates TLS and proxies to it). No
# --web-root — Vite serves the app; the backend owns the control plane, maps,
# and the wasm bundle dirs Vite proxies through.
"$RUNFILES/pi/server/serve" \
  --host 127.0.0.1 \
  --port "$BACKEND_PORT" \
  --solver-dir "$RUNFILES/solver/solver_web" \
  --pulse-dir "$RUNFILES/firmware/pulse/pulse_web" \
  --fx-compiler-dir "$RUNFILES/fx_compiler/fx_compiler_web" \
  --fx-vm-dir "$RUNFILES/firmware/fx_vm/fx_vm_web" \
  --session-dir "$STATE_DIR/sessions" \
  --maps-dir "$STATE_DIR/maps" \
  ${EXTRA_BACKEND[@]+"${EXTRA_BACKEND[@]}"} &
BACKEND_PID=$!

cleanup() {
  trap - EXIT INT TERM
  kill "$BACKEND_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# The dev server (Vite) reads these at startup (vite.config.ts).
export LEDMAPPER_BACKEND="http://127.0.0.1:$BACKEND_PORT"
export LEDMAPPER_DEV_PORT="$PORT"
if [[ "$USE_TLS" == "1" ]]; then
  export LEDMAPPER_TLS_CERT="$CERT"
  export LEDMAPPER_TLS_KEY="$KEY"
  echo ">> dev server: https://localhost:$PORT  (M2 backend http://127.0.0.1:$BACKEND_PORT)"
else
  echo ">> dev server: http://localhost:$PORT  (M2 backend http://127.0.0.1:$BACKEND_PORT)"
fi

# ibazel (hermetic binary) watches //web:dev_server's inputs and re-serves on
# change, driving bazelisk under the hood. It must run from the source workspace
# so its file watcher and the nested bazel invocation see the real tree (bazel
# run left us in runfiles); all paths above are absolute, so cd is safe. Not
# `exec` — we keep the trap so the backend is torn down when ibazel exits.
cd "$BUILD_WORKSPACE_DIRECTORY"
"$IBAZEL" -bazel_path="$BAZEL_BIN" run //web:dev_server
