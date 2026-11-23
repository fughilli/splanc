"""Analyze an FTM spike run dir (hitl_ftm_spike.py --out): per job, the RTT statistics in
every fine-field mode, the parts, and an averaging curve. Writes analysis.json + prints."""

from __future__ import annotations

import glob
import json
import os
import statistics
import sys

import ftm_spike_core as c


def lines(path: str) -> list[str]:
    with open(path, errors="replace") as f:
        return [ln.rstrip("\n") for ln in f]


def main(run: str) -> int:
    rec = json.load(open(os.path.join(run, "record.json")))
    logs = {}
    for lab in "ab":
        g = glob.glob(os.path.join(run, f"serial-{lab}-*.log"))
        logs[lab] = lines(g[0]) if g else []
    out = {"units": rec["units"], "jobs": {}}
    for j in rec["jobs"]:
        ex = c.parse_logs(logs[j["tx"]], logs[j["rx"]], int(j["tag"]))
        res = {"n_tx": sum(1 for t in logs[j["tx"]] if f"ftmtx tag={j['tag']} " in t), "n": len(ex)}
        for mode in ("fold", "neg", "signed", "none"):
            r = [e.rtt_raw(mode) for e in ex]
            st = c.robust(r)
            if st["n"]:
                st["stdev_m"] = st["stdev"] * c.M_PER_RAW_ONEWAY
                st["mad_m"] = st["mad_sigma"] * c.M_PER_RAW_ONEWAY
                st["avg"] = {k: v * c.M_PER_RAW_ONEWAY for k, v in c.averaging_curve(r).items()}
            res[mode] = st
        ppm = c.relative_ppm(ex)
        res["ppm_rx_minus_tx"] = ppm
        if ppm is not None:
            dc = [c.rtt_drift_corrected(e, ppm) for e in ex]
            st = c.robust(dc)
            st["stdev_m"] = st["stdev"] * c.M_PER_RAW_ONEWAY
            st["avg"] = {k: v * c.M_PER_RAW_ONEWAY for k, v in c.averaging_curve(dc).items()}
            res["corrected"] = st
        parts = [e.parts() for e in ex]
        if parts:
            for k in parts[0]:
                vals = [p[k] for p in parts]
                res.setdefault("parts", {})[k] = {
                    "min": min(vals),
                    "median": statistics.median(vals),
                    "max": max(vals),
                    "distinct": len(set(vals)),
                }
        out["jobs"][j["name"]] = res
        f = res.get("corrected", {})
        rs = res.get("parts", {}).get("rssi", {}).get("median")
        avg = {k: round(v, 3) for k, v in f.get("avg", {}).items()}
        print(
            f"{j['name']:22s} n={res['n']}/{res['n_tx']} rssi={rs} ppm={ppm if ppm is None else round(ppm, 2)} "
            f"corr mean={f.get('mean', 0):.2f} sd={f.get('stdev', 0):.2f}raw ({f.get('stdev_m', 0):.2f} m) "
            f"avg_m={avg} "
            f"uncorr med={res.get('fold', {}).get('median')}"
        )
    json.dump(out, open(os.path.join(run, "analysis.json"), "w"), indent=1)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
