"""Per-colour recall: which palette colours does a detector find?

usage: colorscore.py <eval.json> (env SCORE_FRAMES/SCORE_CENTERS as score.py)"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
import score as S

NAMES = {
    (1, 0, 0): "red",
    (0, 0, 1): "blue",
    (1, 0, 1): "magenta",
    (1, 1, 0): "yellow",
    (1, 1, 1): "white",
    (0, 1, 0): "green",
}
res = json.load(open(sys.argv[1]))
for cfg, frames in res.items():
    tot, hit = {}, {}
    for key, blobs in frames.items():
        name = key[:-2]
        st = S.plan[name]
        det = set(S.DET[name]["det"])
        B = np.array([[b[0], b[1]] for b in blobs]) if blobs else np.zeros((0, 2))
        for blk in st["blocks"]:
            i = blk["start"]
            if i not in det:
                continue
            col = NAMES[tuple(int(round(c / max(blk["rgb"]))) for c in blk["rgb"])]
            tot[col] = tot.get(col, 0) + 1
            if len(B) and np.min(np.hypot(*(B - S.XY[i]).T)) < S.R:
                hit[col] = hit.get(col, 0) + 1
    print(
        "%-30s " % cfg
        + "  ".join("%s %.2f (n=%d)" % (c, hit.get(c, 0) / tot[c], tot[c]) for c in sorted(tot))
    )
