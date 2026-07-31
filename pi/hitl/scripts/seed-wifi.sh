#!/usr/bin/env bash
# Seed persistent (runtime) WiFi networks onto the HITL rig, composed on top of
# the baked-in BigVibes/FugLink without a rebuild. Thin wrapper over the
# sbc-deploy seeder with this rig's defaults (host + deploy key).
#
#   seed-wifi.sh                       # seed everything in pi/secrets/wifi-seed.yaml
#   seed-wifi.sh --ssid X --psk Y [--priority N]
#   seed-wifi.sh --list
#   seed-wifi.sh --remove SSID
#
# See pi/secrets/README.md for the wifi-seed.yaml schema. Baked vs seeded layers
# are documented in sbc-deploy nix/modules/wifi.nix.
set -euo pipefail

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
SECRETS="$ROOT/pi/secrets"
ARGS=(--host hitl-rig.local --ssh-key "$SECRETS/deploy_key")

# No args → seed the whole gitignored seed file (absolute path: bazel run's cwd
# differs from here).
if [ $# -eq 0 ]; then
  [ -f "$SECRETS/wifi-seed.yaml" ] || {
    echo "no $SECRETS/wifi-seed.yaml — create it (see pi/secrets/README.md) or pass --ssid/--psk" >&2
    exit 1
  }
  ARGS+=(--file "$SECRETS/wifi-seed.yaml")
fi

exec bazel run @sbc_deploy//deploy:seed_wifi -- "${ARGS[@]}" "$@"
