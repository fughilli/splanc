"""Hue fidelity of matched blobs vs the true LED colour (palette frames). usage: hue_score.py <eval.json>"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np  # noqa: E402
import score as S  # noqa: E402


def hue(r, g, b):
    mx, mn = max(r, g, b), min(r, g, b)
    c = mx - mn
    if mx <= 0 or c <= 0:
        return None, 0
    if mx == r:
        h = ((g - b) / c) % 6
    elif mx == g:
        h = (b - r) / c + 2
    else:
        h = (r - g) / c + 4
    return (h * 60) % 360, c / mx


NAMES = {
    (1, 0, 0): "red",
    (0, 0, 1): "blue",
    (1, 0, 1): "magenta",
    (1, 1, 0): "yellow",
    (1, 1, 1): "white",
    (0, 1, 0): "green",
}
TH = {"red": 0, "yellow": 60, "green": 120, "blue": 240, "magenta": 300}
P4 = [240, 300, 60, 0]  # blue, magenta, yellow, red
res = json.load(open(sys.argv[1]))
for det, frames in res.items():
    errs = {}
    sats = {}
    cls4 = {}
    for key, blobs in frames.items():
        if not key.startswith("pal_"):
            continue
        name = key[:-2]
        st = S.plan[name]
        D_ = set(S.DET[name]["det"])
        B = np.array([[b[0], b[1]] for b in blobs]) if blobs else np.zeros((0, 2))
        for blk in st["blocks"]:
            i = blk["start"]
            if i not in D_ or not len(B):
                continue
            d = np.hypot(*(B - S.XY[i]).T)
            j = int(np.argmin(d))
            if d[j] >= S.R:
                continue
            col = NAMES[tuple(int(round(c / max(blk["rgb"]))) for c in blk["rgb"])]
            h, s = hue(*blobs[j][5:8])
            sats.setdefault(col, []).append(s)
            if col in TH and h is not None:
                e = (h - TH[col] + 180) % 360 - 180
                errs.setdefault(col, []).append(e)
                if TH[col] in P4:
                    near = min(P4, key=lambda p: abs((h - p + 180) % 360 - 180))
                    cls4.setdefault(col, []).append(near == TH[col])
    print(f"== {det}")
    for col in ["red", "yellow", "green", "blue", "magenta", "white"]:
        if col not in sats:
            continue
        e = np.array(errs.get(col, [np.nan]))
        print(
            "  %-8s n=%3d  sat med %.2f  hue err med %+6.1f  |err| p90 %5.1f  4-sym correct %s"
            % (
                col,
                len(sats[col]),
                np.median(sats[col]),
                np.nanmedian(e),
                np.nanpercentile(np.abs(e), 90),
                ("%.2f" % np.mean(cls4[col])) if col in cls4 else "-",
            )
        )
