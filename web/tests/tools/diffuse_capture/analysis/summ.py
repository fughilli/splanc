"""One line per config: overall recall, recall at low exposure (<=0.35), fp & split per frame, centre error."""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
from score import score

for path in sys.argv[1:]:
    res = json.load(open(path))
    for n, fr in res.items():
        rows = score(fr)
        W = np.array([r[2] for r in rows])
        rec = sum(r[2] * r[3] for r in rows) / W.sum()
        lo = [r for r in rows if r[1] <= 0.35]
        hi = [r for r in rows if r[1] >= 0.55]
        rl = sum(r[2] * r[3] for r in lo) / max(1e-9, sum(r[2] for r in lo))
        rh = sum(r[2] * r[3] for r in hi) / max(1e-9, sum(r[2] for r in hi))
        print(
            "%-34s recall %.3f (lo %.3f hi %.3f)  fp %5.2f (max %5.1f)  split %4.2f  err50 %.1f err90 %.1f"
            % (
                n,
                rec,
                rl,
                rh,
                np.mean([r[4] for r in rows]),
                max(r[4] for r in rows),
                np.mean([r[5] for r in rows]),
                np.nanmedian([r[6] for r in rows]),
                np.nanmedian([r[7] for r in rows]),
            )
        )
