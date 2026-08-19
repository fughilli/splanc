#!/usr/bin/env bash
# Seed the Grafana Cloud credentials onto a HITL rig and (re)start Alloy. Needed
# to wire a rig to Grafana Cloud, and again after a reflash (which wipes
# /var/lib, including /var/lib/hitl/grafana.env). The env file lives gitignored
# under pi/secrets/, alongside the deploy SSH key.
#
#   bazel run //pi/hitl:seed_grafana [-- host]   # default hitl-rig.local
#
# pi/secrets/grafana.env must define the fleet-shared creds (see
# observability/alloy.nix). It is the SAME file for every rig — the per-rig
# `rig` label (HITL_RIG) is injected by the NixOS module from the hostname, so
# it is not part of this file:
#   GRAFANA_CLOUD_PROM_URL=https://prometheus-prod-NN-REGION.grafana.net/api/prom/push
#   GRAFANA_CLOUD_PROM_USER=<numeric metrics instance id>
#   GRAFANA_CLOUD_PROM_KEY=<access-policy token, metrics:write>
set -euo pipefail

HOST="${1:-hitl-rig.local}"
# Under `bazel run`, secrets live in the operator's checkout ($BUILD_WORKSPACE_DIRECTORY);
# run directly and we fall back to the repo root relative to this script.
WS="${BUILD_WORKSPACE_DIRECTORY:-$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)}"
SECRETS="$WS/pi/secrets"
ENV_FILE="$SECRETS/grafana.env"
DEPLOY_KEY="$SECRETS/deploy_key"

[ -f "$ENV_FILE" ]   || { echo "missing $ENV_FILE (create it — see this script's header)" >&2; exit 1; }
[ -f "$DEPLOY_KEY" ] || { echo "missing $DEPLOY_KEY (run: bazel run //pi/hitl:hitl.keys -- init)" >&2; exit 1; }

# Fail loudly if a required key is absent rather than shipping a half-config that
# makes Alloy crash-loop on the rig.
for k in GRAFANA_CLOUD_PROM_URL GRAFANA_CLOUD_PROM_USER GRAFANA_CLOUD_PROM_KEY; do
  grep -q "^${k}=" "$ENV_FILE" || { echo "$ENV_FILE is missing ${k}=" >&2; exit 1; }
done

SSH=(ssh -i "$DEPLOY_KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new)

echo "seeding grafana creds -> root@$HOST:/var/lib/hitl/grafana.env"
"${SSH[@]}" "root@$HOST" 'install -d -m755 /var/lib/hitl'
scp -i "$DEPLOY_KEY" -o IdentitiesOnly=yes "$ENV_FILE" "root@$HOST:/var/lib/hitl/grafana.env"
"${SSH[@]}" "root@$HOST" '
  chmod 600 /var/lib/hitl/grafana.env
  # The unit is gated on this file via ConditionPathExists; restart picks it up
  # now that it exists (start if it was never running).
  systemctl restart hitl-alloy.service 2>/dev/null || systemctl start hitl-alloy.service
  systemctl --no-pager --lines=0 status hitl-alloy.service | head -3'
echo "done."
