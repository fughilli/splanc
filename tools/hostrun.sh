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

# Build the request JSON (forward SBC_* env), write it atomically.
python3 - "$id" "$@" >"$BOX/request.json.tmp" <<'PY'
import json, os, sys
rid, argv = sys.argv[1], sys.argv[2:]
env = {k: v for k, v in os.environ.items() if k.startswith("SBC_")}
print(json.dumps({"id": rid, "argv": argv, "env": env}))
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

rc=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("rc",1))' "$status")
echo "hostrun: #$id finished rc=$rc"
exit "$rc"
