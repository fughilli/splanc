#!/bin/sh
# Pi 3 (VideoCore IV / vc4) GLES2 + VM benchmark — runs ON the Pi.
# docs/design/fx-gpu-lowering.md "Pi 3 measurement".
#
#   sh run.sh PAYLOAD.tar.gz [--points 1x500,4x550,...] [--kernels a,b]
#             [--frames 60] [--vm-budget-ms 1500] [--vm-threads 1,4] [--no-gpu] [--no-vm]
#
# Unpacks the payload into a fresh temp dir (removed on exit, even on failure),
# reports the environment (vc4 driver present? render node? image Mesa?), runs
# the GLES2 offscreen render + readback bench through the BUNDLED lean Mesa
# (nothing from the image, nothing installed), then the fx_vm baseline on the
# same kernels and layouts. Output: JSON objects, one per line, on stdout.
# Read-only on the system: no spidev, no player interaction, no writes outside
# the temp dir.
set -u
PAYLOAD=${1:?usage: run.sh PAYLOAD.tar.gz [opts]}
shift
POINTS=1x500,1x2048,4x550,4x1024,8x1024,16x1024,20x1024
KERNELS=""
FRAMES=60
VM_BUDGET=1500
VM_THREADS=1
DO_GPU=1
DO_VM=1
while [ $# -gt 0 ]; do
  case "$1" in
    --points) POINTS=$2; shift ;;
    --kernels) KERNELS=$2; shift ;;
    --frames) FRAMES=$2; shift ;;
    --vm-budget-ms) VM_BUDGET=$2; shift ;;
    --vm-threads) VM_THREADS=$2; shift ;;
    --no-gpu) DO_GPU=0 ;;
    --no-vm) DO_VM=0 ;;
  esac
  shift
done

BASE=/var/tmp
[ -d "$BASE" ] && [ -w "$BASE" ] || BASE=/tmp
T=$(mktemp -d "$BASE/fxgpu-pi3bench.XXXXXX") || { echo '{"bench":"env","ok":false,"error":"mktemp failed"}'; exit 1; }
cleanup() { rm -rf "$T"; }
trap cleanup EXIT
trap 'cleanup; exit 130' INT TERM HUP

jstr() { printf '%s' "$1" | tr -d '\000-\037' | sed 's/\\/\\\\/g; s/"/\\"/g'; }

if ! tar xzf "$PAYLOAD" -C "$T" 2>"$T/untar.err"; then
  printf '{"bench":"env","ok":false,"error":"untar failed: %s"}\n' "$(jstr "$(tail -c 300 "$T/untar.err")")"
  exit 1
fi

# ---- environment / vc4 check ------------------------------------------------
model=$( (tr -d '\000' </proc/device-tree/model) 2>/dev/null)
kern=$(uname -r)
render=no; [ -e /dev/dri/renderD128 ] && render=yes
card=no; [ -e /dev/dri/card0 ] && card=yes
vc4mod=no; grep -q '^vc4 ' /proc/modules 2>/dev/null && vc4mod=yes
v3dmod=no; grep -q '^v3d ' /proc/modules 2>/dev/null && v3dmod=yes
overlay=""
for f in /boot/firmware/config.txt /boot/config.txt; do
  [ -f "$f" ] && overlay="$overlay$(grep -E '^[[:space:]]*(dtoverlay|gpu_mem|max_framebuffers)' "$f" | tr '\n' ';')"
done
img_mesa=no
[ -e /run/opengl-driver/lib/dri ] && img_mesa=yes
ls /run/current-system/sw/lib/libEGL* >/dev/null 2>&1 && img_mesa=yes
cma=$(grep -E '^CmaTotal' /proc/meminfo | tr -s ' ' | cut -d' ' -f2)
memavail=$(grep -E '^MemAvailable' /proc/meminfo | tr -s ' ' | cut -d' ' -f2)
load=$(cut -d' ' -f1-3 /proc/loadavg)
gov=$(cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor 2>/dev/null)
freq=$(cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq 2>/dev/null)
throttled=$( (vcgencmd get_throttled 2>/dev/null || true) | tr -d '\n')
player=$( (ps -eo comm,pcpu,rss 2>/dev/null || true) | grep -iE 'player|ledmapper' | head -3 | tr -s ' ' | tr '\n' ';')
tmpfree=$(df -k "$BASE" 2>/dev/null | tail -1 | tr -s ' ' | cut -d' ' -f4)
# SPI side (read-only): spidev's per-transfer limit caps one STREAM frame at
# bufsiz bytes (default 4096 -> ~1364 LEDs); which SPI devices exist.
bufsiz=$(cat /sys/module/spidev/parameters/bufsiz 2>/dev/null)
spidevs=$(ls /dev/spidev* 2>/dev/null | tr '\n' ' ')
cmdline_spi=$(tr ' ' '\n' </proc/cmdline 2>/dev/null | grep -i spi | tr '\n' ' ')
printf '{"bench":"env","ok":true,"model":"%s","kernel":"%s","render_node":"%s","card0":"%s","vc4_module":"%s","v3d_module":"%s","config_txt":"%s","image_has_mesa":"%s","cma_kb":"%s","mem_avail_kb":"%s","loadavg":"%s","governor":"%s","cpu_khz":"%s","throttled":"%s","player":"%s","tmp_free_kb":"%s","tmpdir":"%s","spidev_bufsiz":"%s","spidevs":"%s","cmdline_spi":"%s"}\n' \
  "$(jstr "$model")" "$(jstr "$kern")" "$render" "$card" "$vc4mod" "$v3dmod" "$(jstr "$overlay")" \
  "$img_mesa" "$cma" "$memavail" "$(jstr "$load")" "$(jstr "$gov")" "$(jstr "$freq")" \
  "$(jstr "$throttled")" "$(jstr "$player")" "$tmpfree" "$T" "$(jstr "$bufsiz")" "$(jstr "$spidevs")" "$(jstr "$cmdline_spi")"

want() { # kernel name filter
  [ -z "$KERNELS" ] && return 0
  case ",$KERNELS," in *",$1,"*) return 0 ;; esac
  return 1
}

# ---- GLES2 (bundled lean Mesa, vc4) ---------------------------------------------
if [ "$DO_GPU" = 1 ]; then
  if [ "$render" != yes ]; then
    printf '{"bench":"gles2","ok":false,"error":"no /dev/dri/renderD128: vc4 KMS driver not active in this image (needs dtoverlay=vc4-kms-v3d); GPU bench skipped"}\n'
  else
    for kd in "$T"/kernels/*/; do
      k=$(basename "$kd")
      want "$k" || continue
      grep -q '"gpu":true' "$kd/meta.json" || continue
      for p in $(echo "$POINTS" | tr ',' ' '); do
        [ -f "$kd/$p.fxp" ] || continue
        if ! __EGL_VENDOR_LIBRARY_DIRS="$T/egl_vendor.d" LIBGL_DRIVERS_PATH="$T/dri" \
          EGL_PLATFORM=surfaceless MESA_SHADER_CACHE_DISABLE=true \
          "$T/lib/ld-linux-aarch64.so.1" --library-path "$T/lib" "$T/bin/gles2bench" \
          "$kd/vs.glsl" "$kd/fs.glsl" "$kd/$p.fxp" --frames "$FRAMES" --name "$k" --layout "$p" \
          2>"$T/gl.err"; then
          printf '{"bench":"gles2","ok":false,"kernel":"%s","layout":"%s","error":"%s"}\n' \
            "$k" "$p" "$(jstr "$(tail -c 600 "$T/gl.err")")"
        fi
      done
    done
  fi
fi

# ---- fx_vm baseline (static binary, same kernels + layouts) -----------------------
if [ "$DO_VM" = 1 ]; then
  for th in $(echo "$VM_THREADS" | tr ',' ' '); do
    if [ -n "$KERNELS" ]; then
      "$T/bin/fxvm_bench" --dir "$T/kernels" --points "$POINTS" --budget-ms "$VM_BUDGET" --threads "$th" --kernels "$KERNELS"
    else
      "$T/bin/fxvm_bench" --dir "$T/kernels" --points "$POINTS" --budget-ms "$VM_BUDGET" --threads "$th"
    fi
  done
fi
printf '{"bench":"done","ok":true}\n'
