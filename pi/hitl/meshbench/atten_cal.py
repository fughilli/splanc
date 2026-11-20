"""Per-unit VNA calibration of the Jeanoko attenuators, and the bench calibration
the scenario compiler loads (docs/design/mesh-hitl-rig.md §5.8).

Two JSON files:

- **unit file** (schema `meshbench.atten_cal/1`), one per physical unit, written
  once on the VNA: S21 at every one of the 128 settings at the mesh channels, plus
  the measured command-to-RF latency. It follows the unit, not the rig slot.
- **bench file** (schema `meshbench.bench_cal/1`), one per assembled bench: which
  unit sits on which rfctl device, each unit's loss table at the bench channel
  (copied in, so the bench file stands alone), and each pair's fixed loss F_ij
  (end to end with both units at 0 dB, minus the two units' own 0 dB loss).
  `scenarios.Bench(..., cal=load(path))` uses it; the harness reads its path from
  HITL_MESHBENCH_CAL_JSON.

    # 1. one unit on the VNA (rfctl drives it; or --jeanoko PORT for its USB port)
    atten_cal.py sweep --unit J1 --rfctl /dev/ttyACM0 --dev att0 \\
        --scpi 192.168.1.50:5025 --freqs 2412,2437,2462 --out J1.csv
    atten_cal.py unit --unit J1 --csv J1.csv --latency-us 2600 --out J1.json
    atten_cal.py check J1.json
    # 2. the assembled bench
    atten_cal.py bench --channel 2462 --map att0=J1.json,att1=J2.json,... \\
        --pairs 01=50.9,02=51.2,... --out bench_cal.json

Pure Python (the SCPI client uses a socket); pyserial only for --jeanoko.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import math
import socket
import sys
import time
from typing import Callable, Mapping, Sequence

UNIT_SCHEMA = "meshbench.atten_cal/1"
BENCH_SCHEMA = "meshbench.bench_cal/1"
N_SETTINGS = 128
STEP_DB = 0.25
SETTINGS = [k * STEP_DB for k in range(N_SETTINGS)]
MESH_FREQS_MHZ = (2412, 2437, 2462)  # Wi-Fi channels 1, 6, 11


def _now() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ------------------------------------------------------------------ unit files


def unit_from_rows(
    unit: str,
    rows: Sequence[tuple[float, float, float]],
    latency_us: int | None = None,
    meta: Mapping | None = None,
) -> dict:
    """(setting_db, freq_mhz, s21_db) rows -> a unit calibration. Every setting
    must be present at every frequency."""
    freqs = sorted({float(f) for _, f, _ in rows})
    table = {(round(s / STEP_DB), float(f)): float(x) for s, f, x in rows}
    s21 = []
    for f in freqs:
        col = []
        for k in range(N_SETTINGS):
            if (k, f) not in table:
                raise ValueError(f"{unit}: no S21 for {k * STEP_DB} dB at {f} MHz")
            col.append(round(table[(k, f)], 3))
        s21.append(col)
    out = {
        "schema": UNIT_SCHEMA,
        "unit": unit,
        "model": "Jeanoko 0-6 GHz digital attenuator (B0FHSZ6N8G)",
        "measured_at": _now(),
        "freqs_mhz": freqs,
        "settings_db": SETTINGS,
        "s21_db": s21,
        "latency_us": latency_us,
    }
    out.update(dict(meta or {}))
    return out


def unit_from_csv(unit: str, path: str, latency_us: int | None = None, meta=None) -> dict:
    """CSV with columns setting_db, freq_mhz, s21_db (extra columns ignored)."""
    with open(path, newline="") as f:
        rows = [
            (float(r["setting_db"]), float(r["freq_mhz"]), float(r["s21_db"]))
            for r in csv.DictReader(f)
        ]
    return unit_from_rows(unit, rows, latency_us, meta)


def loss_at(unit_cal: Mapping, mhz: float) -> list[float]:
    """The unit's loss (dB, positive, insertion loss included) per setting at
    `mhz`, interpolated linearly between the measured frequencies."""
    fs = [float(f) for f in unit_cal["freqs_mhz"]]
    s21 = unit_cal["s21_db"]
    if mhz <= fs[0]:
        col = s21[0]
    elif mhz >= fs[-1]:
        col = s21[-1]
    else:
        k = max(i for i in range(len(fs)) if fs[i] <= mhz)
        w = (mhz - fs[k]) / (fs[k + 1] - fs[k])
        col = [a + w * (b - a) for a, b in zip(s21[k], s21[k + 1])]
    return [round(-x, 3) for x in col]


def check(unit_cal: Mapping, mhz: float | None = None) -> dict:
    """Quality summary at one frequency (default: the middle one)."""
    fs = unit_cal["freqs_mhz"]
    mhz = float(mhz if mhz is not None else fs[len(fs) // 2])
    loss = loss_at(unit_cal, mhz)
    il = loss[0]
    rel = [x - il for x in loss]
    err = [r - k * STEP_DB for k, r in enumerate(rel)]
    nonmono = [k for k in range(1, N_SETTINGS) if loss[k] < loss[k - 1] - 0.05]
    return {
        "unit": unit_cal.get("unit"),
        "freq_mhz": mhz,
        "insertion_loss_db": round(il, 2),
        "range_db": round(rel[-1], 2),
        "max_abs_error_db": round(max(abs(e) for e in err), 2),
        "rms_error_db": round(math.sqrt(sum(e * e for e in err) / len(err)), 3),
        "non_monotonic_settings": nonmono,
        "latency_us": unit_cal.get("latency_us"),
    }


# ------------------------------------------------------------------ bench file


def build_bench(
    units: Mapping[str, Mapping],
    channel_mhz: float,
    pair_end_to_end_db: Mapping[str, float],
    node_side_db: float = 12.3,
    splitter_isolation_db: float = 20.0,
    cut_isolation_db: float = 55.0,
) -> dict:
    """units: {rfctl device ("att0"): unit calibration}. pair_end_to_end_db: each
    pair's measured loss with both of its node units at 0 dB (cut through, delay
    bank at 0 cm). The bench file stores F_ij = that minus the two units' 0 dB loss."""
    atten = {}
    for dev, u in units.items():
        atten[dev] = {
            "unit": u["unit"],
            "loss_db": loss_at(u, channel_mhz),
            "latency_us": u.get("latency_us"),
        }
    fixed = {}
    for p, e2e in pair_end_to_end_db.items():
        ends = [f"att{c}" for c in p]
        missing = [d for d in ends if d not in atten]
        if missing:
            raise ValueError(f"pair {p}: no calibrated unit on {missing}")
        fixed[p] = round(float(e2e) - sum(atten[d]["loss_db"][0] for d in ends), 2)
    return {
        "schema": BENCH_SCHEMA,
        "built_at": _now(),
        "channel_mhz": channel_mhz,
        "units": {d: a["unit"] for d, a in atten.items()},
        "atten": atten,
        "pair_fixed_db": fixed,
        "node_side_db": node_side_db,
        "splitter_isolation_db": splitter_isolation_db,
        "cut_isolation_db": cut_isolation_db,
    }


def load(path: str) -> dict:
    with open(path) as f:
        d = json.load(f)
    if d.get("schema") not in (UNIT_SCHEMA, BENCH_SCHEMA):
        raise ValueError(f"{path}: unknown schema {d.get('schema')!r}")
    if d["schema"] == BENCH_SCHEMA:
        for dev, a in d.get("atten", {}).items():
            if len(a.get("loss_db", [])) != N_SETTINGS:
                raise ValueError(f"{path}: {dev} needs {N_SETTINGS} loss values")
    return d


# ------------------------------------------------------------------ the sweep


class Scpi:
    """Minimal SCPI-over-TCP client (port 5025 on most bench VNAs)."""

    def __init__(self, hostport: str, timeout: float = 10.0) -> None:
        host, _, port = hostport.partition(":")
        self.s = socket.create_connection((host, int(port or 5025)), timeout=timeout)
        self.f = self.s.makefile("rb")

    def write(self, cmd: str) -> None:
        self.s.sendall((cmd + "\n").encode())

    def query(self, cmd: str) -> str:
        self.write(cmd)
        return self.f.readline().decode().strip()


def scpi_measure(
    v: Scpi, trigger: str, read: str, freqs_query: str
) -> Callable[[], list[tuple[float, float]]]:
    """A measure() for sweep(): one triggered sweep, [(freq_mhz, s21_db)] from a
    formatted log-magnitude trace. The defaults suit Keysight/R&S/Copper-Mountain
    style SCPI; check them against the owner's VNA manual."""

    def measure():
        v.query(trigger)
        mags = [float(x) for x in v.query(read).split(",") if x.strip()]
        fq = [float(x) / 1e6 for x in v.query(freqs_query).split(",") if x.strip()]
        if len(mags) == 2 * len(fq):  # (real, imag)-style pairs: take the first
            mags = mags[::2]
        return list(zip(fq, mags))

    return measure


def sweep(
    set_db: Callable[[float], None],
    measure: Callable[[], list[tuple[float, float]]],
    freqs_mhz: Sequence[float],
    settle_s: float = 0.05,
    order: Sequence[int] | None = None,
) -> list[tuple[float, float, float]]:
    """Step every setting (0..31.75 by default), measure S21, and keep the points
    nearest the requested frequencies: [(setting, freq, s21)]. The 0 dB state is
    measured again at the end (compare the two for drift; the last one wins)."""
    order = list(order if order is not None else range(N_SETTINGS)) + [0]
    rows = []
    for k in order:
        db = k * STEP_DB
        set_db(db)
        time.sleep(settle_s)
        trace = measure()
        for f in freqs_mhz:
            fm, s21 = min(trace, key=lambda t: abs(t[0] - f))
            rows.append((db, float(f), s21))
    return rows


def _setter(args) -> Callable[[float], None]:
    if args.jeanoko:
        import jeanoko

        j = jeanoko.Jeanoko(args.jeanoko)
        return lambda db: j.set(db)
    import rfctl

    rf = rfctl.Rfctl.open(args.rfctl)
    return lambda db: rf.set({args.dev: float(db)})


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("sweep", help="step one unit through its 128 settings on the VNA")
    s.add_argument("--unit", required=True)
    g = s.add_mutually_exclusive_group(required=True)
    g.add_argument("--rfctl", help="rfctl serial port (the unit on its ATT header)")
    g.add_argument("--jeanoko", help="the unit's own USB serial port")
    s.add_argument("--dev", default="att0", help="rfctl device the unit is on")
    s.add_argument("--scpi", required=True, help="VNA host:port")
    s.add_argument("--scpi-trigger", default="INIT:IMM;*OPC?")
    s.add_argument("--scpi-read", default="CALC:DATA:FDAT?")
    s.add_argument("--scpi-freqs", default="SENS:FREQ:DATA?")
    s.add_argument("--freqs", default=",".join(str(f) for f in MESH_FREQS_MHZ))
    s.add_argument("--settle-s", type=float, default=0.05)
    s.add_argument("--out", required=True, help="CSV: setting_db,freq_mhz,s21_db")
    u = sub.add_parser("unit", help="CSV -> unit calibration JSON")
    u.add_argument("--unit", required=True)
    u.add_argument("--csv", required=True)
    u.add_argument("--latency-us", type=int)
    u.add_argument("--vna", default="")
    u.add_argument("--out", required=True)
    c = sub.add_parser("check", help="summarise a unit calibration")
    c.add_argument("path")
    c.add_argument("--mhz", type=float)
    b = sub.add_parser("bench", help="unit files + pair measurements -> bench_cal.json")
    b.add_argument("--channel", type=float, required=True, help="bench channel, MHz")
    b.add_argument("--map", required=True, help="att0=J1.json,att1=J2.json,...")
    b.add_argument("--pairs", required=True, help="01=50.9,02=51.2,... (dB, units at 0)")
    b.add_argument("--out", required=True)
    a = ap.parse_args(argv)
    if a.cmd == "sweep":
        freqs = [float(x) for x in a.freqs.split(",")]
        rows = sweep(
            _setter(a),
            scpi_measure(Scpi(a.scpi), a.scpi_trigger, a.scpi_read, a.scpi_freqs),
            freqs,
            a.settle_s,
        )
        with open(a.out, "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["setting_db", "freq_mhz", "s21_db"])
            w.writerows(rows)
        print(f"{a.out}: {len(rows)} points")
    elif a.cmd == "unit":
        d = unit_from_csv(a.unit, a.csv, a.latency_us, {"vna": a.vna})
        json.dump(d, open(a.out, "w"), indent=1)
        print(json.dumps(check(d)))
    elif a.cmd == "check":
        print(json.dumps(check(load(a.path), a.mhz), indent=1))
    else:
        units = {k: load(v) for k, v in (x.split("=", 1) for x in a.map.split(","))}
        pairs = {k: float(v) for k, v in (x.split("=", 1) for x in a.pairs.split(","))}
        d = build_bench(units, a.channel, pairs)
        json.dump(d, open(a.out, "w"), indent=1)
        print(f"{a.out}: {len(d['atten'])} units, {len(d['pair_fixed_db'])} pairs")
    return 0


if __name__ == "__main__":
    sys.exit(main())
