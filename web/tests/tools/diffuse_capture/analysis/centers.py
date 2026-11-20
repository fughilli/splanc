"""Exact per-LED spot centres from the single-LED scan (frames/single).

Each LED i: mean of its 2 frames minus the mean dark frame, max-channel luma,
smoothed (sigma 3). Centre = intensity-weighted centroid of the connected region
above 50% of the peak around the peak; size = sqrt(area) of that region (~FWHM).
Visible = peak SNR > 8 vs dark-frame noise. Also checks frame-0/frame-1 agreement
(a stale previous LED would show as disagreement).
"""

import json
import os

import numpy as np
from PIL import Image
from scipy import ndimage as ndi

D = os.path.dirname(os.path.abspath(__file__))
import sys

F = f"{D}/frames/" + (sys.argv[1] if len(sys.argv) > 1 else "single")
OUT = sys.argv[2] if len(sys.argv) > 2 else "centers.json"
ld = lambda p: np.asarray(Image.open(p).convert("RGB")).astype(np.float32)
dark = np.mean([ld(f"{F}/dark_{k}.png") for k in range(4)], 0)
noise = float(np.std(ld(f"{F}/dark_0.png").max(2) - ld(f"{F}/dark_1.png").max(2)) / np.sqrt(2))
out = {"noise": noise, "leds": []}
for i in range(250):
    a0, a1 = ld(f"{F}/led{i:03d}_0.png") - dark, ld(f"{F}/led{i:03d}_1.png") - dark
    m = ndi.gaussian_filter(((a0 + a1) / 2).max(2), 3)
    py, px = np.unravel_index(np.argmax(m), m.shape)
    peak = float(m[py, px])
    lab, _ = ndi.label(m > 0.5 * peak)
    reg = lab == lab[py, px]
    ys, xs = np.nonzero(reg)
    w = m[ys, xs]
    cx, cy = float((xs * w).sum() / w.sum()), float((ys * w).sum() / w.sum())
    # frame agreement: peak location of each frame alone
    p0 = np.unravel_index(np.argmax(ndi.gaussian_filter(a0.max(2), 3)), m.shape)
    p1 = np.unravel_index(np.argmax(ndi.gaussian_filter(a1.max(2), 3)), m.shape)
    out["leds"].append(
        {
            "i": i,
            "x": round(cx, 2),
            "y": round(cy, 2),
            "peak": round(peak, 1),
            "snr": round(peak / (noise / 3 + 1e-6), 1),  # smoothing sigma 3 cuts noise ~3x+
            "size": round(float(np.sqrt(reg.sum())), 1),
            "agree": round(float(np.hypot(p0[0] - p1[0], p0[1] - p1[1])), 1),
            "sat": float(((a0 + dark).max(2) >= 250).sum()),
        }
    )
json.dump(out, open(f"{D}/" + OUT, "w"))
L = out["leds"]
peaks = np.array([l["peak"] for l in L])
sizes = np.array([l["size"] for l in L])
agree = np.array([l["agree"] for l in L])
print("dark noise %.2f DN" % noise)
print("peak DN  p10 %.1f  p50 %.1f  p90 %.1f" % tuple(np.percentile(peaks, [10, 50, 90])))
print("size px  p10 %.1f  p50 %.1f  p90 %.1f" % tuple(np.percentile(sizes, [10, 50, 90])))
print(
    "frame disagreement >5px:",
    int((agree > 5).sum()),
    "LEDs:",
    [l["i"] for l in L if l["agree"] > 5][:20],
)
print("weak (peak < 6 DN):", [l["i"] for l in L if l["peak"] < 6])
# neighbour spacing along the strip
xy = np.array([[l["x"], l["y"]] for l in L])
step = np.hypot(*np.diff(xy, axis=0).T)
print(
    "adjacent-LED spacing px  p10 %.1f  p50 %.1f  p90 %.1f"
    % tuple(np.percentile(step, [10, 50, 90]))
)
