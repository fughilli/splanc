#!/usr/bin/env bash
# Seed a NETWORK DUT (a device reached over the LAN and provisioned over BLE — e.g.
# the LED Mapper Pi) onto a running HITL rig so it gets its own work queue, WITHOUT
# rebuilding the image. The daemon's --discover monitor ingests
# /var/lib/hitl/network-duts.json within a few seconds — no restart. Re-run after a
# reflash (which wipes /var/lib), same as seed_grafana.
#
#   bazel run //pi/hitl:seed_network_dut -- [host] --name pi-ledmapper-1 \
#       --addr splanc-max-1.local [--ble-mac AA:BB:CC:DD:EE:FF] [--ssh-user root] [--ssh-port 22]
#   bazel run //pi/hitl:seed_network_dut -- [host] --list
#   bazel run //pi/hitl:seed_network_dut -- [host] --remove pi-ledmapper-1
#
# host defaults to hitl-rig.local. The name MUST start with pi-/net- so it can
# never collide with a discovered board (c6-*). --addr is the DUT's LAN management
# address (mDNS host or IP) — prefer its ETHERNET address so provisioning (which
# cycles the DUT's WiFi) can never drop monitoring/journalctl. The DUT is PIN-ONLY:
# only `hitl reserve --device <name>` lands on it, never an unpinned "any DUT" run.
#
# JSON is merged locally (the rig host may lack python3/jq) and shipped atomically.
set -euo pipefail

HOST="hitl-rig.local"
NAME=""; ADDR=""; BLE_MAC=""; SSH_USER="root"; SSH_PORT="22"; ACTION="add"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --name) NAME="$2"; shift 2;;
    --addr) ADDR="$2"; shift 2;;
    --ble-mac) BLE_MAC="$2"; shift 2;;
    --ssh-user) SSH_USER="$2"; shift 2;;
    --ssh-port) SSH_PORT="$2"; shift 2;;
    --list) ACTION="list"; shift;;
    --remove) ACTION="remove"; NAME="$2"; shift 2;;
    -h|--help) sed -n '2,18p' "$0"; exit 0;;
    --*) echo "unknown flag: $1" >&2; exit 2;;
    *) HOST="$1"; shift;;
  esac
done

WS="${BUILD_WORKSPACE_DIRECTORY:-$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)}"
DEPLOY_KEY="$WS/pi/secrets/deploy_key"
[ -f "$DEPLOY_KEY" ] || { echo "missing $DEPLOY_KEY (run: bazel run //pi/hitl:hitl.keys -- init)" >&2; exit 1; }
SSH=(ssh -i "$DEPLOY_KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new)

# Current remote file (or an empty array if it doesn't exist yet).
CURRENT="$("${SSH[@]}" "root@$HOST" 'cat /var/lib/hitl/network-duts.json 2>/dev/null || echo "[]"')"

if [ "$ACTION" = "list" ]; then
  printf '%s\n' "$CURRENT" | python3 -m json.tool
  exit 0
fi

[ -n "$NAME" ] || { echo "--name is required" >&2; exit 2; }
case "$NAME" in pi-*|net-*) ;; *) echo "name must start with pi- or net- (got '$NAME')" >&2; exit 2;; esac
if [ "$ACTION" = "add" ] && [ -z "$ADDR" ]; then
  echo "--addr is required for add" >&2; exit 2
fi

MERGED="$(CURRENT="$CURRENT" NAME="$NAME" ADDR="$ADDR" BLE_MAC="$BLE_MAC" \
          SSH_USER="$SSH_USER" SSH_PORT="$SSH_PORT" ACTION="$ACTION" python3 - <<'PY'
import json, os, sys
try:
    cur = json.loads(os.environ["CURRENT"] or "[]")
except json.JSONDecodeError:
    cur = []
if not isinstance(cur, list):
    cur = []
name = os.environ["NAME"]
cur = [d for d in cur if isinstance(d, dict) and d.get("name") != name]  # replace/remove
if os.environ["ACTION"] == "add":
    env = {
        "HITL_DUT_ADDR": os.environ["ADDR"],
        "HITL_DUT_SSH_USER": os.environ["SSH_USER"],
        "HITL_DUT_SSH_PORT": os.environ["SSH_PORT"],
    }
    if os.environ["BLE_MAC"]:
        env["HITL_DUT_BLE_MAC"] = os.environ["BLE_MAC"]
    cur.append({"name": name, "kind": "network", "devices": [], "env": env})
json.dump(cur, sys.stdout, indent=2)
PY
)"

# Ship atomically: write a temp on the rig, then mv into place so the monitor
# never reads a half-written file.
"${SSH[@]}" "root@$HOST" 'install -d -m755 /var/lib/hitl'
printf '%s\n' "$MERGED" | "${SSH[@]}" "root@$HOST" '
  tmp="$(mktemp /var/lib/hitl/.network-duts.XXXXXX)"
  cat > "$tmp"
  chmod 600 "$tmp"
  mv -f "$tmp" /var/lib/hitl/network-duts.json'

echo "seeded -> root@$HOST:/var/lib/hitl/network-duts.json (daemon ingests within ~3s)"
printf '%s\n' "$MERGED"
