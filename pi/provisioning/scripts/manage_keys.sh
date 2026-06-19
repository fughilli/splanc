#!/usr/bin/env bash
# LED Mapper — deploy SSH key management.
#
# The deploy flow owns one ed25519 key pair:
#   * PUBLIC half  -> pi/provisioning/secrets/deploy_key.pub
#                     baked into the image's root authorized_keys at build time
#                     (see nix/modules/ssh-deploy.nix).
#   * PRIVATE half -> pi/provisioning/secrets/deploy_key
#                     used by `deploy_live` for nixos-rebuild --target-host.
#
# secrets/ is GITIGNORED. The private key is NEVER committed. You may instead
# point at a key outside the repo via LEDMAPPER_DEPLOY_KEY_DIR.
#
# Usage:
#   manage_keys.sh init      # generate the pair if absent (idempotent)
#   manage_keys.sh path      # print the private/public key paths
#   manage_keys.sh pub       # print the public key (for sanity-checking)
#   manage_keys.sh rotate    # back up old pair, generate a new one
#   manage_keys.sh ensure    # init only if missing; used by the bazel targets
set -euo pipefail

# Resolve secrets dir: env override, else <provisioning>/secrets.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROV_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SECRETS_DIR="${LEDMAPPER_DEPLOY_KEY_DIR:-$PROV_DIR/secrets}"
PRIV="$SECRETS_DIR/deploy_key"
PUB="$SECRETS_DIR/deploy_key.pub"
COMMENT="ledmapper-deploy"

init() {
  mkdir -p "$SECRETS_DIR"
  chmod 700 "$SECRETS_DIR"
  if [[ -f "$PRIV" ]]; then
    echo "Deploy key already exists at $PRIV (use 'rotate' to replace)." >&2
    return 0
  fi
  ssh-keygen -t ed25519 -N "" -C "$COMMENT" -f "$PRIV"
  chmod 600 "$PRIV"
  chmod 644 "$PUB"
  echo "Generated deploy key:"
  echo "  private: $PRIV"
  echo "  public : $PUB"
}

ensure() {
  if [[ ! -f "$PUB" ]]; then
    init
  fi
}

rotate() {
  if [[ -f "$PRIV" ]]; then
    ts="$(date +%Y%m%d%H%M%S)"
    mv "$PRIV" "$PRIV.bak.$ts"
    [[ -f "$PUB" ]] && mv "$PUB" "$PUB.bak.$ts"
    echo "Backed up old key with suffix .bak.$ts" >&2
  fi
  init
  cat <<EOF >&2

Rotation complete. To finish rotating a FIELDED Pi:
  1. Re-image it (bazel run //pi/provisioning:image_sd), OR
  2. While you still have access with the OLD key, deploy the new
     authorized_keys: bazel run //pi/provisioning:deploy_live -- <host>
     (the new pubkey is baked into the rebuilt config) then remove the old
     key from the Pi's root authorized_keys.
EOF
}

case "${1:-}" in
  init)   init ;;
  ensure) ensure ;;
  rotate) rotate ;;
  path)   echo "private: $PRIV"; echo "public : $PUB" ;;
  pub)    cat "$PUB" ;;
  *)
    echo "usage: $0 {init|ensure|rotate|path|pub}" >&2
    exit 2
    ;;
esac
