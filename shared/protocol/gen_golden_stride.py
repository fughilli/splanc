#!/usr/bin/env python3
"""Generate web/tests/golden_stride.json — the cross-language authority for the
diffuse-capture stride schedule (mirror of web/src/code/stride.ts and
firmware/pattern/src/lib.rs `stride_lit`). Both the phone (TS) and the firmware
(Rust) verify against this file, so a divergence is a test failure, not a field
bug.

    python3 shared/protocol/gen_golden_stride.py

Deterministic: re-running with no logic change is byte-identical.
"""

import json
from pathlib import Path

OUT = Path(__file__).resolve().parents[2] / "web" / "tests" / "golden_stride.json"

CASES = [
    {"ledCount": 32, "spacing": 3, "anchorDensity": 3},
    {"ledCount": 64, "spacing": 4, "anchorDensity": 3},
    {"ledCount": 50, "spacing": 5, "anchorDensity": 4},
]


def phase_count(spacing: int) -> int:
    return 1 if spacing <= 1 else 2 * spacing - 1


def stride_lit(led: int, phase: int, spacing: int, anchor_density: int) -> bool:
    s = spacing
    if s <= 1:
        return True
    n = 2 * s - 1
    ph = phase % n
    if ph < s:
        return led % s == ph
    j = ph - s + 1
    a = max(3, anchor_density)
    period = a * s
    m = led % period
    return m == 0 or m == (a // 2) * s + j


def main() -> None:
    out = {"cases": []}
    for c in CASES:
        n = c["ledCount"]
        pc = phase_count(c["spacing"])
        phases = [
            [led for led in range(n) if stride_lit(led, ph, c["spacing"], c["anchorDensity"])]
            for ph in range(pc)
        ]
        out["cases"].append({**c, "phaseCount": pc, "phases": phases})
    OUT.write_text(json.dumps(out, indent=2) + "\n")
    print(f"wrote {OUT} ({len(out['cases'])} cases)")


if __name__ == "__main__":
    main()
