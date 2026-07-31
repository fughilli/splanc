#!/usr/bin/env bash
# Launcher for `bazel run //pi/hitl:seed_wifi`. Runs the sbc-deploy WiFi seeder
# (from runfiles) against the HITL rig with this rig's defaults filled in.
#
#   bazel run //pi/hitl:seed_wifi                         # seed pi/secrets/wifi-seed.yaml
#   bazel run //pi/hitl:seed_wifi -- --ssid X --psk Y     # one-off
#   bazel run //pi/hitl:seed_wifi -- --list
#   bazel run //pi/hitl:seed_wifi -- --remove SSID
#
# Baked vs seeded layers: sbc-deploy nix/modules/wifi.nix. Schema for
# wifi-seed.yaml: pi/secrets/README.md.
set -euo pipefail
# --- begin runfiles.bash initialization v3 ---
set +e
f=bazel_tools/tools/bash/runfiles/runfiles.bash
# shellcheck disable=SC1090
source "${RUNFILES_DIR:-/dev/null}/$f" 2>/dev/null ||
  source "$(grep -sm1 "^$f " "${RUNFILES_MANIFEST_FILE:-/dev/null}" | cut -f2- -d' ')" 2>/dev/null ||
  source "$0.runfiles/$f" 2>/dev/null ||
  { echo >&2 "ERROR: cannot find runfiles.bash"; exit 1; }
set -e
# --- end runfiles.bash initialization v3 ---

SEEDER="$(rlocation sbc_deploy/deploy/scripts/seed_wifi.sh)"
[ -n "${SEEDER:-}" ] && [ -f "$SEEDER" ] || { echo >&2 "cannot locate seed_wifi.sh in runfiles"; exit 1; }

# `bazel run` starts us in the runfiles tree; the deploy key + seed file live in
# the operator's checkout, exposed as $BUILD_WORKSPACE_DIRECTORY.
WS="${BUILD_WORKSPACE_DIRECTORY:-$PWD}"
SECRETS="$WS/pi/secrets"
ARGS=(--host hitl-rig.local --ssh-key "$SECRETS/deploy_key")

if [ "$#" -eq 0 ]; then
  [ -f "$SECRETS/wifi-seed.yaml" ] || {
    echo >&2 "no $SECRETS/wifi-seed.yaml — create it (see pi/secrets/README.md) or pass --ssid/--psk/--list/--remove"
    exit 1
  }
  ARGS+=(--file "$SECRETS/wifi-seed.yaml")
fi

exec bash "$SEEDER" "${ARGS[@]}" "$@"
