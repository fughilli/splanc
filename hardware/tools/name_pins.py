#!/usr/bin/env python3
"""Add named pin-signals to an auto-generated atopile atomic part.

`ato create part` emits connectors/switches with bare `pin N` lines and no
`signal`, so a design can't wire them by name. This rewrites such a part so each
numeric pin N gets `signal pN ~ pin N` (idempotent), letting the board connect
`part.pN`. Non-numeric pads (e.g. USB-C `A5`) already carry named signals and
are left untouched. Usage: name_pins.py <part.ato>...
"""
import re
import sys

for path in sys.argv[1:]:
    lines = open(path).read().splitlines()
    have = {m.group(1) for ln in lines if (m := re.match(r"\s*signal p(\d+) ~ pin \d+", ln))}
    out, added = [], []
    for ln in lines:
        out.append(ln)
        m = re.match(r"(\s*)pin (\d+)\s*$", ln)
        if m and m.group(2) not in have:
            indent, n = m.group(1), m.group(2)
            out.append(f"{indent}signal p{n} ~ pin {n}")
            added.append(n)
    open(path, "w").write("\n".join(out) + "\n")
    print(f"{path}: added {len(added)} pin-signals ({','.join(added) or 'none'})")
