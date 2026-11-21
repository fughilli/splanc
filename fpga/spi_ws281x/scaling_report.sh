#!/usr/bin/env bash
# Place-and-route scaling report for the spi_ws281x core on the Tang Nano 9K
# (GW1NR-9C): utilisation (LUT/FF/BSRAM/IO) and nextpnr fmax for a set of
# port counts / FIFO depths / core clocks, via the pinned 20-port top
# (tangnano9k_20p_top + tangnano9k_20p.cst). For NUM_WS < 20 the cst lines of
# the unused ports are dropped, so ports 0..NUM_WS-1 keep their real pins.
#
#   YOSYS=... NEXTPNR=... fpga/spi_ws281x/scaling_report.sh [OUT_DIR] [CONFIG...]
#
# CONFIG = NUM_WS:MAX_LEDS:FIFO_DEPTH:CLK_MHZ (FIFO_DEPTH 0 = full frame). With no
# configs it runs the sweep in the design doc. YOSYS/NEXTPNR default to the
# rules_fpga nix toolchain binaries on PATH. Prints one JSON object per config.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=${1:-/tmp/spi_ws281x_scaling}
shift || true
YOSYS=${YOSYS:-yosys}
NEXTPNR=${NEXTPNR:-nextpnr-himbaechel}
CONFIGS=("$@")
if [ ${#CONFIGS[@]} -eq 0 ]; then
  CONFIGS=(8:1024:2048:54 16:1024:2048:54 20:1024:2048:54 20:1024:2048:81
    20:553:0:54 20:1024:0:54)
fi
mkdir -p "$OUT"
SRCS=("$HERE"/csr.v "$HERE"/spi_ctrl.v "$HERE"/spi_slave.v "$HERE"/spi_ws281x.v
  "$HERE"/ws281x_stream.v "$HERE"/tangnano9k_20p_top.v)

for c in "${CONFIGS[@]}"; do
  IFS=: read -r np leds depth mhz <<<"$c"
  tag="p${np}_l${leds}_d${depth}_${mhz}mhz"
  defs="-DTN9K_NUM_WS=$np -DTN9K_MAX_LEDS=$leds -DTN9K_FIFO_DEPTH=$depth -DTN9K_CLK_MHZ=$mhz"
  if ! "$YOSYS" -q -l "$OUT/$tag.yosys.log" -p "read_verilog -sv $defs ${SRCS[*]}; synth_gowin -top tangnano9k_20p_top -json $OUT/$tag.json" >/dev/null 2>&1; then
    echo "{\"config\":\"$tag\",\"ok\":false,\"stage\":\"yosys\"}"
    continue
  fi
  awk -v n="$np" 'match($0, /"ws\[[0-9]+\]"/) {
      i = substr($0, RSTART + 4, RLENGTH - 6) + 0; if (i >= n) next } { print }' \
    "$HERE/tangnano9k_20p.cst" >"$OUT/$tag.cst"
  if "$NEXTPNR" --device GW1NR-LV9QN88PC6/I5 --vopt family=GW1N-9C \
    --vopt cst="$OUT/$tag.cst" --vopt sspi_as_gpio --json "$OUT/$tag.json" \
    --write "$OUT/$tag.pnr.json" --freq "$mhz" --report "$OUT/$tag.report.json" \
    >"$OUT/$tag.nextpnr.log" 2>&1; then ok=true; else ok=false; fi
  python3 - "$OUT/$tag.report.json" "$OUT/$tag.nextpnr.log" "$tag" "$ok" "$mhz" <<'PY'
import json, re, sys
rep, log, tag, ok, mhz = sys.argv[1:]
out = {"config": tag, "ok": ok == "true", "target_mhz": float(mhz)}
try:
    r = json.load(open(rep))
    util = r.get("utilization", {})
    for k, v in util.items():
        if v.get("available"):
            out[k] = "%d/%d" % (v["used"], v["available"])
    out["fmax"] = {k: round(v.get("achieved", 0), 1) for k, v in r.get("fmax", {}).items()}
except Exception as e:  # report missing on P&R failure
    out["report_error"] = str(e)
txt = open(log).read()
m = re.findall(r"(ERROR:.*)", txt)
if m:
    out["error"] = m[0][:240]
print(json.dumps(out))
PY
done
