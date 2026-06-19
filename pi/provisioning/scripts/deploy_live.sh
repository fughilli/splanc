#!/usr/bin/env bash
# `bazel run //pi/provisioning:deploy_live -- <host-or-ip> [--user root] [extra nix args]`
#
# In-place upgrade of a running LED Mapper Pi:
#   nixos-rebuild switch --flake <flake>#ledmapper --target-host <host> --use-remote-sudo
#
# Authenticates with the deploy PRIVATE key (secrets/deploy_key), whose public
# half was baked into the Pi's authorized_keys at imaging time. No password is
# needed on first boot.
#
# Requires `nix` / `nixos-rebuild` on the deploy host. NOT runnable in the
# authoring environment (no nix). See pi/provisioning/README.md.
set -euo pipefail

HOST=""
USER_NAME="root"
EXTRA_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --user) USER_NAME="$2"; shift 2 ;;
    --) shift ;;
    -*) EXTRA_ARGS+=("$1"); shift ;;
    *) if [[ -z "$HOST" ]]; then HOST="$1"; else EXTRA_ARGS+=("$1"); fi; shift ;;
  esac
done

[[ -n "$HOST" ]] || { echo "usage: deploy_live <host-or-ip> [--user root] [nix args]" >&2; exit 2; }

# Resolve flake dir + secrets, handling `bazel run` runfiles vs source tree.
if [[ -n "${BUILD_WORKSPACE_DIRECTORY:-}" ]]; then
  PROV_DIR="$BUILD_WORKSPACE_DIRECTORY/pi/provisioning"
else
  PROV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi
FLAKE_DIR="$PROV_DIR/nix"
KEYS="$PROV_DIR/scripts/manage_keys.sh"
SECRETS_DIR="${LEDMAPPER_DEPLOY_KEY_DIR:-$PROV_DIR/secrets}"
PRIV="$SECRETS_DIR/deploy_key"

command -v nixos-rebuild >/dev/null 2>&1 || {
  echo "ERROR: 'nixos-rebuild' not found. Run from a host with Nix/NixOS tooling." >&2
  exit 1
}

[[ -f "$PRIV" ]] || {
  echo "ERROR: deploy private key not found at $PRIV." >&2
  echo "Generate it (and re-image the Pi to trust it) with: $KEYS init" >&2
  exit 1
}
chmod 600 "$PRIV" 2>/dev/null || true

# Use the deploy key, don't prompt for unknown hosts on first deploy.
export NIX_SSHOPTS="-i $PRIV -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
TARGET="${USER_NAME}@${HOST}"

# The baked-in deploy pubkey lives outside the flake root (see image_sd.sh /
# ssh-deploy.nix); point eval at it and build --impure so the rebuilt config can
# resolve it, matching what the image was built with.
export LEDMAPPER_DEPLOY_PUBKEY_FILE="$SECRETS_DIR/deploy_key.pub"

echo "==> Deploying $FLAKE_DIR#ledmapper to $TARGET (in-place switch)"
# --use-remote-sudo lets us deploy as a non-root user too; for root it's a no-op.
nixos-rebuild switch \
  --flake "path:${FLAKE_DIR}#ledmapper" \
  --target-host "$TARGET" \
  --use-remote-sudo \
  --impure \
  "${EXTRA_ARGS[@]}"

echo "==> Switch complete on $HOST."
