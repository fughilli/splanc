#!/usr/bin/env bash
# `bazel run //pi/provisioning:image_sd [-- --device /dev/sdX] [--no-write]`
#
# Builds the LED Mapper NixOS SD-card image (Raspberry Pi, via the
# nvmd/nixos-raspberrypi flake) and optionally writes it to a chosen device.
#
# Steps:
#   1. Ensure the deploy SSH key pair exists (public half is baked into the
#      image's authorized_keys — see nix/modules/ssh-deploy.nix).
#   2. `nix build` the SD image from nix/flake.nix.
#   3. dd / write the resulting image to --device (with confirmation), unless
#      --no-write is given (then just print the image path).
#
# Requires `nix` (with flakes) on the build host. NOT runnable in the authoring
# environment (no nix). See pi/provisioning/README.md.
set -euo pipefail

DEVICE=""
WRITE=1
EXTRA_NIX_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --device) DEVICE="$2"; shift 2 ;;
    --no-write) WRITE=0; shift ;;
    --) shift ;;
    *) EXTRA_NIX_ARGS+=("$1"); shift ;;
  esac
done

# Locate the flake. Under `bazel run`, runfiles put the flake next to us; fall
# back to the source tree path for direct invocation.
find_flake_dir() {
  if [[ -n "${BUILD_WORKSPACE_DIRECTORY:-}" ]]; then
    echo "$BUILD_WORKSPACE_DIRECTORY/pi/provisioning/nix"
    return
  fi
  local here; here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  echo "$here/../nix"
}
FLAKE_DIR="$(find_flake_dir)"

# Find manage_keys.sh similarly.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KEYS="${SCRIPT_DIR}/manage_keys.sh"
[[ -x "$KEYS" ]] || KEYS="${BUILD_WORKSPACE_DIRECTORY:-.}/pi/provisioning/scripts/manage_keys.sh"

command -v nix >/dev/null 2>&1 || {
  echo "ERROR: 'nix' not found. The SD image must be built on a host with Nix (flakes enabled)." >&2
  exit 1
}

echo "==> Ensuring deploy SSH key exists (public half is baked into the image)"
bash "$KEYS" ensure

# The deploy pubkey lives at <provisioning>/secrets/, which is OUTSIDE the flake
# root (nix/). A flake's store copy only contains the flake dir, so a relative
# path from the module can't reach it. ssh-deploy.nix resolves the key from
# $LEDMAPPER_DEPLOY_PUBKEY_FILE (absolute) first; export it and build --impure so
# eval can read the operator-local key. (No secret is committed; only the public
# half is read, and it is baked into the image's authorized_keys.)
SECRETS_DIR="${LEDMAPPER_DEPLOY_KEY_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)/secrets}"
export LEDMAPPER_DEPLOY_PUBKEY_FILE="$SECRETS_DIR/deploy_key.pub"

echo "==> Building SD image from $FLAKE_DIR"
# Build the sdImage attribute. nixos-raspberrypi places it under
# nixosConfigurations.<host>.config.system.build.sdImage; flake.nix re-exports
# it as .#images.sdImage.
nix build "${EXTRA_NIX_ARGS[@]}" \
  --impure \
  --print-out-paths \
  "path:${FLAKE_DIR}#images.sdImage" \
  --out-link /tmp/ledmapper-sdimage
OUT="$(readlink -f /tmp/ledmapper-sdimage)"

# The sdImage derivation output contains a compressed .img (usually .img.zst).
IMG="$(find "$OUT" -maxdepth 2 \( -name '*.img' -o -name '*.img.zst' \) | head -n1)"
echo "==> Built image: $IMG"

if [[ $WRITE -eq 0 || -z "$DEVICE" ]]; then
  echo "Not writing to a device (no --device or --no-write set)."
  echo "To flash manually:"
  echo "  zstdcat '$IMG' | sudo dd of=/dev/sdX bs=4M status=progress conv=fsync"
  exit 0
fi

echo "!!  About to OVERWRITE $DEVICE with the LED Mapper image."
lsblk "$DEVICE" || true
read -r -p "Type the device path again to confirm ($DEVICE): " confirm
[[ "$confirm" == "$DEVICE" ]] || { echo "Mismatch; aborting." >&2; exit 1; }

if [[ "$IMG" == *.zst ]]; then
  zstdcat "$IMG" | sudo dd of="$DEVICE" bs=4M status=progress conv=fsync
else
  sudo dd if="$IMG" of="$DEVICE" bs=4M status=progress conv=fsync
fi
sync
echo "==> Done. Insert the card into the Pi and boot. It will come up as 'ledmapper.local'."
