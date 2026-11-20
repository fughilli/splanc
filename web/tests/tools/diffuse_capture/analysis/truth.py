"""Reference LED-spot positions from the static-camera sweep, and per-frame lit truth.

1. Every frame -> max-channel luma, minus a large-scale background (gaussian
   sigma 40 px), smoothed at the spot scale (sigma 6 px) -> "spot response".
2. Local maxima above 6 sigma (sigma = robust noise of the response) in the
   high-SNR frames are clustered across frames (camera is static): each
   cluster with enough hits = one LED spot centre (mean of members).
3. Per frame, an LED is LIT when its response at the known centre is > 5 sigma.
   Known-location test = far more sensitive than blind detection, so it is a fair
   bar for "this spot is clearly in the frame".
Writes truth.json: {centers: [[x,y],...], frames: {name: {lit: [idx...], sigma}}}.
"""
import glob, json, os, sys
import numpy as np
from PIL import Image
from scipy import ndimage as ndi

D = os.path.dirname(os.path.abspath(__file__))
files = sorted(glob.glob(f"{D}/frames/sweep/*.png"))

def response(path):
    a = np.asarray(Image.open(path).convert("RGB")).astype(np.float32) / 255.0
    lum = a.max(2)
    bg = ndi.gaussian_filter(lum, 40)
    r = ndi.gaussian_filter(lum - bg, 6)
    mad = np.median(np.abs(r - np.median(r))) * 1.4826 + 1e-6
    return r, mad

R = {}
for f in files:
    R[os.path.basename(f)[:-4]] = response(f)

# High-SNR set for positions.
hi = [k for k in R if any(k.startswith(p) for p in ("b100_x0.22", "b100_x0.32", "b60_x0.32", "b100_x0.14", "b60_x0.22"))]
pts = []
for k in hi:
    r, s = R[k]
    mx = (r == ndi.maximum_filter(r, size=15)) & (r > 6 * s)
    ys, xs = np.nonzero(mx)
    pts += [(x, y) for x, y in zip(xs, ys)]
pts = np.array(pts, float)
print("peaks", len(pts), "from", len(hi), "frames", file=sys.stderr)

# Greedy clustering, radius 7 px.
centers, counts = [], []
used = np.zeros(len(pts), bool)
order = np.argsort(-np.array([R[hi[0]][0][int(y), int(x)] for x, y in pts]))  # arbitrary but deterministic
for i in order:
    if used[i]:
        continue
    d = np.hypot(*(pts - pts[i]).T)
    m = (d < 7) & ~used
    used |= m
    centers.append(pts[m].mean(0)); counts.append(int(m.sum()))
centers, counts = np.array(centers), np.array(counts)
keep = counts >= 3
centers = centers[keep]
print("clusters", len(counts), "kept (>=3 hits)", int(keep.sum()), file=sys.stderr)

out = {"centers": centers.round(2).tolist(), "frames": {}}
for k, (r, s) in R.items():
    v = np.array([r[int(round(y)), int(round(x))] for x, y in centers])
    out["frames"][k] = {"lit": np.nonzero(v > 5 * s)[0].tolist(), "sigma": float(s)}
json.dump(out, open(f"{D}/truth.json", "w"))

# Overlay on one bright frame for eyeballing.
im = Image.open(f"{D}/frames/sweep/b100_x0.22_003.png").convert("RGB")
from PIL import ImageDraw, ImageEnhance
im = ImageEnhance.Brightness(im).enhance(2.5)
dr = ImageDraw.Draw(im)
lit = set(out["frames"]["b100_x0.22_003"]["lit"])
for i, (x, y) in enumerate(centers):
    c = "yellow" if i in lit else (90, 90, 90)
    dr.ellipse((x - 4, y - 4, x + 4, y + 4), outline=c, width=2)
im.crop((60, 260, 660, 1000)).save(f"{D}/truth_overlay.png")
for k in sorted(out["frames"]):
    if k.endswith("_000"):
        print(k, "lit", len(out["frames"][k]["lit"]), "sigma %.4f" % out["frames"][k]["sigma"])
