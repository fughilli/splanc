# flake8: noqa
# Experiment script (research record; see docs/research/channel-sounding.md §14). Agent-host paths.
import json
import sys
import time

import numpy as np

sys.path.insert(0, "/workspace/.claude/worktrees/chsound/tools/chsound")
import twoway
from cslib import Bench

b = Bench()
out = {}
for a_, b_, d0 in (
    ("A", "B", 61.25e-6),
    ("B", "A", -61.25e-6),
    ("A", "B", 61.25e-6),
    ("B", "A", -61.25e-6),
):
    s = twoway.Sounder(b, fc=2442e6, delta0=d0, a=a_, b=b_)
    s.setup()
    v = []
    c = []
    while len(v) < 12:
        r = s.exchange()
        if "fail" in r:
            continue
        v.append(r["two_tau"])
        c.append(r["carrier"])
    v = np.array(v) * 1e9
    key = a_ + "->" + b_
    out.setdefault(key, []).extend(v.tolist())
    print(
        f"initiator {a_}: 2tau median {np.median(v):.3f} ns std {v.std():.3f} | carrier {np.degrees(np.angle(np.mean(np.exp(1j*np.array(c))))):+.1f} deg",
        flush=True,
    )
json.dump(out, open(f"/workspace/.claude/chsound/exp/e51_{int(time.time())}.json", "w"))
for k, v in out.items():
    print(k, "median %.3f n=%d" % (np.median(v), len(v)))
