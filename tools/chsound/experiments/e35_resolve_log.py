# flake8: noqa
# Experiment script (research record; see docs/research/channel-sounding.md §12). Paths are the
# agent-host layout used for the measurements; adjust before reuse.
"""Carrier-integer resolution from paired-burst analysis logs (e33 'lo ... dgd ... dphi ...' lines)."""
import json
import re
import sys

import numpy as np

rx = re.compile(
    r"lo (\d+) inj\s+([\d.]+): n=(\d+) cal gd\s+([\d.]+) dgd ([+-][\d.]+) ns\s+dphi\s+([+-][\d.]+)"
)
tests = []
for fn in sys.argv[1:]:
    for ln in open(fn):
        m = rx.search(ln)
        if m:
            tests.append(
                dict(
                    fc=float(m[1]) * 1e6,
                    inj=float(m[2]),
                    n=int(m[3]),
                    dg=float(m[5]) * 1e-9,
                    dphi=np.radians(float(m[6])),
                )
            )


def solve(units):
    dg = np.array([u["dg"] for u in units])
    dphi = np.array([u["dphi"] for u in units])
    f = np.array([u["fc"] for u in units])
    med = np.median(dg)
    keep = np.abs(dg - med) < 2.5e-9
    dg, dphi, f = dg[keep], dphi[keep], f[keep]
    d_g = np.median(dg)
    sg = 1.4826 * np.median(np.abs(dg - d_g)) * 1.25 / np.sqrt(len(dg))  # robust (median, MAD)
    grid = d_g + np.linspace(-6 * sg, 6 * sg, 12001)
    coh = np.real(
        (np.exp(1j * dphi)[None, :] * np.exp(2j * np.pi * np.outer(grid, f))).sum(1)
    ) / len(
        f
    )  # phase must match (paired cal = 0)
    score = 2 * len(f) * np.log(np.maximum(coh, 1e-6)) - 0.5 * ((grid - d_g) / sg) ** 2
    d_r = grid[np.argmax(score)]
    # carrier-only precision: residual phase scatter at the solution
    r = np.angle(np.exp(1j * (dphi + 2 * np.pi * f * d_r)))
    return d_g, sg, d_r, np.std(r) / (2 * np.pi * f.mean()) / np.sqrt(len(f)), len(f), coh.max()


out = {}
for inj in sorted(set(t["inj"] for t in tests)):
    u = [t for t in tests if t["inj"] == inj]
    d_g, sg, d_r, sc, n, coh = solve(u)
    pb = np.array([t["dg"] for t in u])
    pp = np.array([t["dphi"] for t in u])
    ff = np.array([t["fc"] for t in u])
    resid_deg = np.degrees(np.angle(np.exp(1j * (pp + 2 * np.pi * ff * inj * 1e-9))))
    out[inj] = dict(
        n=n,
        gd=d_g,
        gd_sigma=sg,
        resolved=d_r,
        carrier_sigma=sc,
        per_burst_gd_std=pb.std(),
        carrier_resid_deg_std=resid_deg.std(),
    )
    print(
        f"inj {inj:5.2f} ns (n={n} bursts): gd-only {d_g*1e9:+.3f}+-{sg*1e9:.3f} (err {d_g*1e9-inj:+.3f}) | carrier-resolved {d_r*1e9:+.4f} ns "
        f"err {(d_r*1e9-inj)*1e3:+.1f} ps (+-{sc*1e12:.1f} ps) | per-burst gd std {pb.std()*1e9:.3f} ns, carrier resid vs truth std {resid_deg.std():.1f} deg"
    )
json.dump(
    {str(k): v for k, v in out.items()},
    open(sys.argv[1].replace(".log", "_resolve.json"), "w"),
    default=float,
)
