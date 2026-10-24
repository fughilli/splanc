#!/usr/bin/env bash
# Build the self-contained Pi 3 benchmark payload (aarch64; the MAX Pi 3 image
# is aarch64 NixOS — //pi/provisioning:ledmapper_pi3, board raspberry-pi-3).
#
#   fx_gpu/pi3bench/build_payload.sh OUT_DIR
#
# Needs: the -c opt fx_gpu tools already built
#   bazel build -c opt //fx_gpu:fxgpu_pack //fx_gpu:fxvm_bench
# plus gcc and nix on an aarch64 host. Produces OUT_DIR/{pi3bench-payload.tar.gz,
# run.sh, rig_run.sh, summarize.py, MANIFEST.txt}.
#
# Bundle layout (relocatable; nothing references /nix/store at run time):
#   lib/                 every .so of the lean-Mesa + libglvnd closure, flattened,
#                        RUNPATHs stripped; plus glibc's ld-linux-aarch64.so.1
#   dri/vc4_dri.so, dri/v3d_dri.so
#   egl_vendor.d/50_mesa.json   (library_path rewritten to a bare soname)
#   bin/gles2bench       (dlopens libEGL/libGLESv2; run via the bundled loader)
#   bin/fxvm_bench       (static)
#   kernels/<effect>/{prog.fxb,uniforms.bin,meta.json,vs.glsl,fs.glsl,<CxP>.fxp}
set -euo pipefail
OUT=${1:?usage: build_payload.sh OUT_DIR}
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(git -C "$HERE" rev-parse --show-toplevel)
PACK=${PACK:-$REPO/bazel-bin/fx_gpu/fxgpu_pack}
VMB=${VMB:-$REPO/bazel-bin/fx_gpu/fxvm_bench}
POINTS=${POINTS:-1x500,1x2048,4x550,4x1024,8x1024,16x1024,20x1024}
FRAMES=${FRAMES:-60}
# GLES2-capable (float-only) study kernels + two VM-only references (hash-heavy).
KERNELS=${KERNELS:-"agent/skill/examples/solid_fill.fx firmware/fx_perf_bench/effects/gradient.fx \
  firmware/fx_perf_bench/effects/sweep.fx agent/skill/examples/imu_tilt.fx \
  firmware/fx_perf_bench/effects/cylinder.fx firmware/fx_perf_bench/effects/plasma.fx \
  firmware/fx_perf_bench/effects/noise.fx firmware/fx_perf_bench/effects/pulses.fx"}
[ "$(uname -m)" = aarch64 ] || { echo "build on aarch64 (the Pi image is aarch64)" >&2; exit 1; }
[ -x "$PACK" ] && [ -x "$VMB" ] || { echo "build //fx_gpu:fxgpu_pack //fx_gpu:fxvm_bench with -c opt first" >&2; exit 1; }

ev() { nix build --impure --no-link --print-out-paths --expr "(import $HERE/mesa-lean.nix).$1"; }
MESA=$(ev "${MESA_ATTR:-mesa}")
GLVND=$(ev glvnd)
PATCHELF=$(ev patchelf)/bin/patchelf
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE"/{bin,lib,dri,egl_vendor.d,kernels} "$OUT"

# Libraries: the runtime closure of mesa + glvnd, flattened.
for p in $(nix-store -qR "$MESA" "$GLVND"); do
  [ -d "$p/lib" ] || continue
  find "$p/lib" -maxdepth 1 -name '*.so*' \( -type f -o -type l \) -print0 |
    while IFS= read -r -d '' f; do
      b=$(basename "$f")
      [ -e "$STAGE/lib/$b" ] || cp -L "$f" "$STAGE/lib/$b" 2>/dev/null || true
    done
done
GLIBC=$(nix-store -qR "$MESA" | grep -E -- '-glibc-[0-9.]+(-[0-9]+)?$' | head -1)
[ -e "$STAGE/lib/ld-linux-aarch64.so.1" ] || cp -L "$GLIBC/lib/ld-linux-aarch64.so.1" "$STAGE/lib/"
# Drop what the GLES2 path never loads (Vulkan, X/GLX vendor libs stay: libEGL_mesa links them).
rm -f "$STAGE"/lib/libvulkan_*.so "$STAGE"/lib/libVkLayer_*.so
for d in ${DRI:-vc4 v3d}; do cp -L "$MESA/lib/dri/${d}_dri.so" "$STAGE/dri/"; done
sed 's#"library_path" *: *"[^"]*"#"library_path" : "libEGL_mesa.so.0"#' \
  "$MESA"/share/glvnd/egl_vendor.d/50_mesa.json >"$STAGE/egl_vendor.d/50_mesa.json"
chmod -R u+w "$STAGE/lib" "$STAGE/dri"
# Strip RUNPATHs so resolution is ONLY via the bundle (--library-path).
for f in "$STAGE"/lib/*.so* "$STAGE"/dri/*.so; do
  case "$(basename "$f")" in ld-linux*) continue ;; esac
  "$PATCHELF" --remove-rpath "$f" 2>/dev/null || true
done

gcc -O2 -Wall -o "$STAGE/bin/gles2bench" "$HERE/gles2bench.c"
cp "$VMB" "$STAGE/bin/fxvm_bench"
chmod u+w "$STAGE/bin/fxvm_bench"
strip "$STAGE/bin/fxvm_bench" "$STAGE/bin/gles2bench"

( cd "$REPO" && "$PACK" --out "$STAGE/kernels" --points "$POINTS" --frames "$FRAMES" $KERNELS )

# Self-check: every bundled library resolves inside the bundle.
missing=0
for f in "$STAGE"/lib/libEGL.so.1 "$STAGE"/lib/libGLESv2.so.2 "$STAGE"/lib/libEGL_mesa.so.0 \
  "$STAGE"/dri/*_dri.so "$STAGE"/bin/gles2bench; do
  if "$STAGE/lib/ld-linux-aarch64.so.1" --library-path "$STAGE/lib" --list "$f" | grep -q 'not found'; then
    echo "UNRESOLVED in $f:" >&2
    "$STAGE/lib/ld-linux-aarch64.so.1" --library-path "$STAGE/lib" --list "$f" | grep 'not found' >&2
    missing=1
  fi
done
[ "$missing" = 0 ] || exit 1

tar czf "$OUT/pi3bench-payload.tar.gz" -C "$STAGE" .
cp "$HERE/run.sh" "$HERE/rig_run.sh" "$HERE/summarize.py" "$OUT/"
{
  echo "built: $(date -u +%FT%TZ) from $(git -C "$REPO" rev-parse --short HEAD)"
  echo "mesa: $MESA"
  echo "glvnd: $GLVND"
  echo "glibc: $GLIBC"
  echo "points: $POINTS frames: $FRAMES"
  for m in "$STAGE"/kernels/*/meta.json; do cat "$m"; done
  du -sh "$STAGE"/* "$OUT/pi3bench-payload.tar.gz"
} >"$OUT/MANIFEST.txt"
cat "$OUT/MANIFEST.txt"
