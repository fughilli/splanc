#!/usr/bin/env python3
"""Estimator accuracy (docs/design/fx-perf-study.md, Q3): run the app/agent
offline cost model (costModel.ts + the shipped default table) on every program
the bench measured and compare to the device.

  python3 tools/fx_perf/estimator_eval.py --bench runs/v1.json --est-src <dir with costModel.ts+costTableStore.ts> \
      --fx-compile <fx_compile> --src <name>=<file.fx>... --framing 600 --out est.json

What is compared: the estimator's frame cycles (update + shade, its show term
excluded) vs the bench's measured VM frame cycles + `--framing` cycles/LED (the
firmware's extra per-LED framing — map read + colour correction — that the
radio-less bench doesn't run; ≈600 measured as fx_bench `empty`/`sweep256` on
main minus the bench's own). fx_bench's goldens can be passed with --golden
(fxbBase64 + measuredFrameCycles, already firmware numbers: no framing added).
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))


def compile_b64(fxc: str, path: str, opt: bool) -> str | None:
    fd, out = tempfile.mkstemp(suffix=".fxb")
    os.close(fd)
    try:
        args = [fxc] + ([] if opt else ["--no-opt"]) + [path, out]
        if subprocess.run(args, capture_output=True).returncode != 0:
            return None
        return base64.b64encode(open(out, "rb").read()).decode()
    finally:
        os.unlink(out)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--bench", help="parse_bench.py JSON")
    ap.add_argument("--golden", action="append", default=[], help="device-bench-*.json golden(s)")
    ap.add_argument("--est-src", required=True)
    ap.add_argument("--fx-compile", required=True)
    ap.add_argument("--src", action="append", default=[], help="name=path.fx (opt compile)")
    ap.add_argument(
        "--valid-src", action="append", default=[], help="name=path.fx (--no-opt compile)"
    )
    ap.add_argument("--framing", type=float, default=600.0)
    ap.add_argument("--fixtures", default="helix,sign,linear")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    srcs = {}
    for s in a.src:
        k, v = s.split("=", 1)
        srcs[k] = (v, True)
    for s in a.valid_src:
        k, v = s.split("=", 1)
        srcs[k] = (v, False)
    rows = []
    fixtures = set(a.fixtures.split(","))
    if a.bench:
        b = json.load(open(a.bench))
        cache: dict = {}
        for r in b["vm"]:
            if r["fixture"] not in fixtures or r["name"] not in srcs:
                continue
            path, opt = srcs[r["name"]]
            if r["name"] not in cache:
                cache[r["name"]] = compile_b64(a.fx_compile, path, opt)
            fxb = cache[r["name"]]
            if fxb is None:
                continue
            framing = a.framing * r["n"]
            rows.append(
                {
                    "label": r["name"],
                    "fixture": r["fixture"],
                    "leds": r["n"],
                    "fxb": fxb,
                    "measured": r["frame"] + framing,
                    "measured_vm": r["frame"],
                    "ops_per_led": r["ops"] / r["n"],
                    "source": "bench",
                }
            )
    for g in a.golden:
        d = json.load(open(g))
        for r in d["fit"] + d["heldout"]:
            rows.append(
                {
                    "label": r["label"],
                    "fixture": "fx_bench",
                    "leds": r["ledCount"],
                    "fxb": r["fxbBase64"],
                    "measured": r["measuredFrameCycles"],
                    "source": os.path.basename(g),
                }
            )
    with tempfile.TemporaryDirectory() as td:
        inp = os.path.join(td, "in.json")
        outp = os.path.join(td, "out.json")
        json.dump(rows, open(inp, "w"))
        subprocess.run(
            [
                "node",
                "--experimental-strip-types",
                "--no-warnings",
                os.path.join(HERE, "estimate.mjs"),
                a.est_src,
                inp,
                outp,
            ],
            check=True,
        )
        est = json.load(open(outp))
    for r in est:
        if "frameCycles" in r:
            r["ratio"] = r["frameCycles"] / r["measured"]
    json.dump(est, open(a.out, "w"), indent=1)
    rs = sorted(x["ratio"] for x in est if "ratio" in x)
    if rs:

        def q(p: float) -> float:
            return rs[min(len(rs) - 1, int(p * len(rs)))]

        print(
            f"{len(rs)} programs: predicted/measured p10={q(0.1):.3f} median={q(0.5):.3f} "
            f"p90={q(0.9):.3f} min={rs[0]:.3f} max={rs[-1]:.3f}"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
