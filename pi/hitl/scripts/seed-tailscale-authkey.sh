#!/usr/bin/env bash
# Seed the Tailscale auth key onto a HITL rig and bring it up. Needed after a
# reflash (which wipes /var/lib, including /var/lib/tailscale/authkey). The key
# and deploy SSH key both live gitignored under pi/secrets/.
#
#   pi/hitl/scripts/seed-tailscale-authkey.sh [host]   # default hitl-rig.local
set -euo pipefail

HOST="${1:-hitl-rig.local}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SECRETS="$HERE/../../secrets"
KEY="$SECRETS/tailscale-authkey"
DEPLOY_KEY="$SECRETS/deploy_key"

[ -f "$KEY" ]        || { echo "missing $KEY (mint one and save it here)" >&2; exit 1; }
[ -f "$DEPLOY_KEY" ] || { echo "missing $DEPLOY_KEY (run: bazel run //pi/hitl:hitl.keys -- init)" >&2; exit 1; }

SSH=(ssh -i "$DEPLOY_KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new)

echo "seeding tailscale authkey -> root@$HOST:/var/lib/tailscale/authkey"
"${SSH[@]}" "root@$HOST" 'install -d -m700 /var/lib/tailscale'
scp -i "$DEPLOY_KEY" -o IdentitiesOnly=yes "$KEY" "root@$HOST:/var/lib/tailscale/authkey"
"${SSH[@]}" "root@$HOST" '
  chmod 600 /var/lib/tailscale/authkey
  # Autoconnect if not already logged in; harmless no-op if already up.
  systemctl restart tailscaled-autoconnect.service 2>/dev/null || \
    tailscale up --auth-key "file:/var/lib/tailscale/authkey" --ssh --hostname=hitl-rig
  tailscale status | head -1'
echo "done."
