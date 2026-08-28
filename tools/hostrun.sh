#!/usr/bin/env bash
# hostrun — container side of tools/hostdeploy.py. Submit a build/deploy command
# to the host watcher and stream its output until it finishes; exit with its rc.
#
#   SBC_HOSTNAME_OVERRIDE=hitl-rig-la-1 tools/hostrun.sh \
#       bazel run //pi/hitl:hitl_la.deploy_live -- hitl-rig-2 --keep-builder
#
# SBC_* env vars in this shell are forwarded to the host command. Run it in the
# background (it blocks for the whole deploy) and watch the streamed log.
set -uo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo /workspace)"
BOX="$ROOT/.hostdeploy"
mkdir -p "$BOX"

# Preflight: is the host watcher alive (heartbeat < 8s old)?
alive="$BOX/alive"
now=$(date +%s)
hb=0
[ -f "$alive" ] && hb=$(date -r "$alive" +%s 2>/dev/null || echo 0)
if [ $((now - hb)) -gt 8 ]; then
  echo "hostrun: host watcher not running (start it on the host: python3 tools/hostdeploy.py)" >&2
  exit 3
fi

[ "$#" -gt 0 ] || { echo "usage: hostrun.sh <cmd...>" >&2; exit 2; }

id="$(date +%s)-$$"
log="$BOX/$id.log"
status="$BOX/$id.status"
tailpid=""

# If we're killed/interrupted before the host reports done, tell the watcher to
# abort the (possibly minutes-long) orphaned command — write our id to the cancel
# file. The watcher's supervisor kills that command's whole process group. Without
# this, giving up on this side would leave the host building/deploying blind.
cleanup() {
  [ -n "$tailpid" ] && kill "$tailpid" 2>/dev/null || true
  if [ ! -f "$status" ]; then
    printf '%s' "$id" >"$BOX/cancel" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

# Surface an in-flight command (the watcher runs one at a time; ours queues behind it).
if [ -f "$BOX/running" ]; then
  echo "hostrun: note — host watcher is busy; $(cat "$BOX/running" 2>/dev/null)" >&2
fi

# Build the request JSON (forward SBC_* env + optional HOSTRUN_TIMEOUT), write atomically.
python3 - "$id" "$@" >"$BOX/request.json.tmp" <<'PY'
import json, os, sys
rid, argv = sys.argv[1], sys.argv[2:]
env = {k: v for k, v in os.environ.items() if k.startswith("SBC_")}
req = {"id": rid, "argv": argv, "env": env}
t = os.environ.get("HOSTRUN_TIMEOUT")
if t:
    req["timeout"] = float(t)
print(json.dumps(req))
PY
mv "$BOX/request.json.tmp" "$BOX/request.json"
echo "hostrun: submitted #$id: $*"

# Stream the log until the status file appears.
for _ in $(seq 1 120); do [ -f "$log" ] && break; sleep 0.5; done
tail -n +1 -F "$log" 2>/dev/null &
tailpid=$!
while [ ! -f "$status" ]; do sleep 2; done
sleep 0.5
kill "$tailpid" 2>/dev/null || true
tailpid=""

rc=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("rc",1))' "$status")
reason=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("reason",""))' "$status" 2>/dev/null || true)
echo "hostrun: #$id finished rc=$rc${reason:+ ($reason)}"
exit "$rc"
