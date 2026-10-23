#!/usr/bin/env bash
# Build the Splanc MAX OTA gate's test images (docs/design/max-ota.md "HITL").
#
#   pi/hitl/max_ota_images.sh OUT_DIR [APP]        (APP: ledmapper_pi3, the default)
#
# Three systems from THIS tree, all trusting the checked-in TEST key
# (--//firmware/ota:trust=test) and signed with it (firmware/ota/keys/test_max.key):
#   A  9.1.0             the setup image (deployed over SSH by the gate)
#   B  9.2.0             a good update
#   U  9.3.0 unhealthy   a player that runs but never reports healthy
# packed as deltas (only what the device lacks) with tools/max_ota_release.py:
#   b_from_a  u_from_b  a_from_b  (.nixclosure + .manifest), plus toplevels.txt.
# Then: bazel run //pi/hitl/harness:max_ota_gate -- --images OUT_DIR ...
# Needs Nix (an aarch64-linux builder, as for any ledmapper image). Never ship these.
set -euo pipefail
out="$(realpath -m "${1:?usage: max_ota_images.sh OUT_DIR [APP]}")"
app="${2:-ledmapper_pi3}"
board="${MAX_BOARD:-pi3}"
root="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
cd "$root"
mkdir -p "$out"
read -r -a bazel_flags <<<"${MAX_OTA_BAZEL_FLAGS:-}"

build() { # name version variant
  local log="$out/build-$1.log"
  echo "==> building $1 ($2${3:+, $3})" >&2
  SPLANC_MAX_VERSION="$2" SPLANC_MAX_VARIANT="$3" bazel "${bazel_flags[@]}" run \
    --//firmware/ota:trust=test "//pi/provisioning:${app}.image_sd" -- \
    --no-write --attr images.maxOtaSystem >"$log" 2>&1 || { tail -30 "$log" >&2; exit 1; }
  local f
  f="$(sed -n 's/^==> Built image: //p' "$log" | tail -n1)"
  [[ -f "$f" ]] || { echo "no system for $1 (see $log)" >&2; exit 1; }
  # Root it outside the launcher's per-attr link, which the next build replaces.
  nix-store --add-root "$out/$1.system" --indirect --realise "$(cat "$f")" >/dev/null
  cat "$f"
}

if [[ -s "$out/toplevels.txt" && -z "${MAX_OTA_REBUILD:-}" ]]; then
  # shellcheck disable=SC1090
  . <(sed 's/^/top_/' "$out/toplevels.txt") # a=… b=… u=… -> top_a=…
else
  top_a="$(build a 9.1.0 "")"
  top_b="$(build b 9.2.0 "")"
  top_u="$(build u 9.3.0 unhealthy)"
  printf 'a=%s\nb=%s\nu=%s\n' "$top_a" "$top_b" "$top_u" >"$out/toplevels.txt"
fi

# zstd for the packer (from the same nixpkgs as the image, if it isn't installed).
if ! command -v zstd >/dev/null; then
  zbin="$(nix build --no-link --print-out-paths --impure \
    "path:$root/pi/provisioning/nix#nixosConfigurations.ledmapper.pkgs.buildPackages.zstd.bin")"
  PATH="$zbin/bin:$PATH"
fi

bazel "${bazel_flags[@]}" build //firmware/ota:ota_sign >/dev/null 2>&1
signer="$(bazel "${bazel_flags[@]}" cquery --output=files //firmware/ota:ota_sign 2>/dev/null | head -n1)"
pack() { # name toplevel version base
  python3 tools/max_ota_release.py --toplevel "$2" --board "$board" --version "$3" \
    --base-toplevel "$4" --name "$1" --signer "$signer" \
    --pubkey firmware/ota/keys/test_max.pub --key-file firmware/ota/keys/test_max.key \
    --zstd-level "${MAX_ZSTD_LEVEL:-9}" --out-dir "$out"
}
pack b_from_a "$top_b" 9.2.0 "$top_a"
pack u_from_b "$top_u" 9.3.0 "$top_b"
pack a_from_b "$top_a" 9.1.0 "$top_b"
ls -l "$out"
