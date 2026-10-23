#!/usr/bin/env python3
"""Parse `fxpb ...` lines from the FX perf-study bench (run_bench.py output)
into JSON: {micro_prim: {name: cyc}, micro_vm: {name: cyc/op}, vm: [...],
jit: [...], native: [...], skip: [...]}. Used by report.py and the study doc."""
from __future__ import annotations

import json
import re
import sys

KV = re.compile(r"(\w+)=(\S+)")


def _num(v: str):
    try:
        return int(v)
    except ValueError:
        try:
            return float(v)
        except ValueError:
            return v


def parse_lines(lines: list[str]) -> dict:
    out: dict = {"micro_prim": {}, "micro_vm": {}, "vm": [], "jit": [], "native": [], "skip": []}
    for ln in lines:
        ln = ln.strip()
        if not ln.startswith("fxpb "):
            continue
        body = ln[5:]
        if body.startswith("micro prim "):
            m = re.match(r"micro prim (\S+) (\d+) cyc", body)
            if m:
                out["micro_prim"][m.group(1)] = int(m.group(2))
        elif body.startswith("micro vm run_empty"):
            out["micro_vm"]["run_empty"] = int(body.split()[3])
        elif body.startswith("micro vm "):
            m = re.match(r"micro vm (.+?): (\d+) cyc/unit \((\d+) ops\) = (\d+) cyc/op", body)
            if m:
                out["micro_vm"][m.group(1)] = {
                    "unit": int(m.group(2)),
                    "ops": int(m.group(3)),
                    "per_op": int(m.group(4)),
                }
        else:
            parts = body.split()
            kind = parts[0]
            if kind not in ("vm", "jit", "native", "skip"):
                continue
            rec = {k: _num(v) for k, v in KV.findall(body)}
            rec["name"] = parts[1]
            if kind == "native":
                rec["variant"] = parts[2]
                rec["fixture"] = parts[3]
            else:
                rec["fixture"] = parts[2]
            out[kind].append(rec)
    return out


def main() -> int:
    with open(sys.argv[1]) as f:
        d = parse_lines(f.read().splitlines())
    json.dump(d, open(sys.argv[2], "w"), indent=1)
    print({k: len(v) for k, v in d.items()})
    return 0


if __name__ == "__main__":
    sys.exit(main())
