"""Score detector output (detect_eval.cjs JSON) against exact single-LED centres.

Truth per frame = LEDs lit in that step (frames/stride/plan_done.json) that are
  (a) reliably located in the single-LED scan (peak >= 12 DN, frame agreement <= 5 px), and
  (b) DETECTABLE in this frame: known-location response (frame - dark at this exposure,
      max-channel, gaussian sigma 3) > 5x its noise. Spots below that can't be asked of
      any blind detector.
Matching: greedy nearest within R = 15 px (about a third of the adjacent-LED spacing).
Metrics per (brightness, exposure):
  recall    matched detectable LEDs / detectable LEDs
  fp        blobs not within R of ANY lit LED (incl. undetectable/unlocated lit ones), per frame
  split     extra blobs within R of an already-matched LED, per frame
  err50/90  centre error of matches (px)
  miss_lit  blobs per frame near lit-but-undetectable LEDs (bonus finds, not penalised)
Usage: score.py <eval.json> [config ...]
"""

import json
import os
import re
import sys

import numpy as np
from PIL import Image
from scipy import ndimage as ndi

D = os.path.dirname(os.path.abspath(__file__))
R = 15.0
FR = os.environ.get("SCORE_FRAMES", "stride")
C = json.load(open(os.environ.get("SCORE_CENTERS", f"{D}/centers.json")))["leds"]
XY = np.array([[led["x"], led["y"]] for led in C])
GOOD = np.array([led["peak"] >= 12 and led["agree"] <= 5 for led in C])
plan = {s["name"]: s for s in json.load(open(f"{D}/frames/{FR}/plan_done.json"))}

_cache = f"{D}/detectable_{FR}.json"
if os.path.exists(_cache):
    DET = json.load(open(_cache))
else:

    def ld(p):
        return np.asarray(Image.open(p).convert("RGB")).astype(np.float32)

    darks, DET = {}, {}
    for name, s in plan.items():
        if name.startswith("dark"):
            continue
        x = s["exposure"]
        if x == "ae":
            # Auto exposure: this frame's own matched dark (same exposure + ISO).
            dk = ld(f"{D}/frames/{FR}/dark_{name}_0.png")
            m = ndi.gaussian_filter((ld(f"{D}/frames/{FR}/{name}_0.png") - dk).max(2), 3)
            sig = float(1.4826 * np.median(np.abs(m - np.median(m)))) + 1e-3
            lit = [b["start"] for b in s["blocks"]]
            DET[name] = {
                "lit": lit,
                "det": [
                    i
                    for i in lit
                    if GOOD[i] and m[int(round(XY[i, 1])), int(round(XY[i, 0]))] > 5 * sig
                ],
            }
            continue
        if x not in darks:
            a, b = ld(f"{D}/frames/{FR}/dark_x{x}_0.png"), ld(f"{D}/frames/{FR}/dark_x{x}_1.png")
            n = ndi.gaussian_filter((a - b).max(2), 3)  # noise of the smoothed response
            darks[x] = ((a + b) / 2, float(np.std(n) / np.sqrt(2)) + 1e-3)
        dk, sig = darks[x]
        m = ndi.gaussian_filter((ld(f"{D}/frames/{FR}/{name}_0.png") - dk).max(2), 3)
        lit = [b["start"] for b in s["blocks"]]
        DET[name] = {
            "lit": lit,
            "det": [
                i
                for i in lit
                if GOOD[i] and m[int(round(XY[i, 1])), int(round(XY[i, 0]))] > 5 * sig
            ],
        }
    json.dump(DET, open(_cache, "w"))


def score(frames):
    agg = {}
    for key, blobs in frames.items():
        name = key[:-2]  # strip _0 frame suffix
        mm = re.search(r"b([\d.]+)_x([\d.a-z]+)_", name)
        k = (float(mm.group(1)), -1.0 if mm.group(2) == "ae" else float(mm.group(2)))
        a = agg.setdefault(
            k, {"det": 0, "hit": 0, "fp": 0, "split": 0, "err": [], "n": 0, "bonus": 0}
        )
        a["n"] += 1
        lit, det = DET[name]["lit"], set(DET[name]["det"])
        a["det"] += len(det)
        B = np.array([[b[0], b[1]] for b in blobs]) if blobs else np.zeros((0, 2))
        litxy = XY[lit]
        # pairs sorted by distance between blobs and detectable LEDs
        pairs = []
        for j, (bx, by) in enumerate(B):
            d = np.hypot(litxy[:, 0] - bx, litxy[:, 1] - by)
            near = np.nonzero(d < R)[0]
            if len(near) == 0:
                a["fp"] += 1
                continue
            for q in near:
                pairs.append((d[q], j, lit[q]))
        pairs.sort()
        used_b, used_l = set(), set()
        for d, j, i in pairs:
            if j in used_b or i in used_l:
                continue
            used_b.add(j)
            used_l.add(i)
            if i in det:
                a["hit"] += 1
                a["err"].append(d)
            else:
                a["bonus"] += 1
        # blobs near a lit LED but not assigned = splits
        near_any = {j for _, j, _ in pairs}
        a["split"] += len(near_any - used_b)
    rows = []
    for k in sorted(agg):
        a = agg[k]
        e = np.array(a["err"]) if a["err"] else np.array([np.nan])
        rows.append(
            (
                k[0],
                k[1],
                a["det"] / a["n"],
                a["hit"] / max(1, a["det"]),
                a["fp"] / a["n"],
                a["split"] / a["n"],
                np.nanmedian(e),
                np.nanpercentile(e, 90),
            )
        )
    return rows


if __name__ == "__main__":
    res = json.load(open(sys.argv[1]))
    names = sys.argv[2:] or list(res)
    for n in names:
        rows = score(res[n])
        print(f"\n== {n}")
        print(" bright  exp  | detectable/frm  recall   fp/frm  split/frm  err50  err90")
        for r in rows:
            print(" %5.1f  %4.2f |   %6.1f       %5.2f   %6.1f    %5.1f    %5.1f  %5.1f" % r)
        R_ = np.array([r[3] for r in rows])
        W_ = np.array([r[2] for r in rows])
        tot = sum(r[2] * r[3] for r in rows) / sum(W_)
        print(
            " OVERALL recall %.3f  mean fp/frm %.1f  mean split/frm %.1f  median err %.1f"
            % (
                tot,
                np.mean([r[4] for r in rows]),
                np.mean([r[5] for r in rows]),
                np.nanmedian([r[6] for r in rows]),
            )
        )
