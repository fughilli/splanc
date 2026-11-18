# flake8: noqa
# Experiment script (research record; see docs/research/channel-sounding.md §13). Agent-host paths.
import re
import sys

import numpy as np

sys.argv = [sys.argv[0]] + sys.argv[1:]
exec(open("e35_resolve_log.py").read().split("out = {}")[0])  # reuse parsing + solve()
rng = np.random.default_rng(1)
print("bursts/estimate  slip-rate (all injections)  rms err when right (ps)")
res = {}
for n in (3, 5, 10, 20, 30):
    slips = 0
    tot = 0
    errs = []
    for inj in sorted(set(t["inj"] for t in tests)):
        u = [t for t in tests if t["inj"] == inj]
        for _ in range(200):
            sub = [u[i] for i in rng.choice(len(u), size=min(n, len(u)), replace=False)]
            if len(sub) < 3:
                continue
            d_g, sg, d_r, sc, nn, coh = solve(sub)
            e = d_r * 1e9 - inj
            tot += 1
            if abs(e) > 0.2:
                slips += 1
            else:
                errs.append(e * 1e3)
    res[n] = (slips / tot, np.sqrt(np.mean(np.square(errs))))
    print(f"{n:3d}              {slips/tot*100:6.2f} %                  {res[n][1]:.1f}")
