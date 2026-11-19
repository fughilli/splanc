"""Build a diffuse-detector regression dataset (web/tests/testdata/<name>/) from a
static-camera capture session.

Inputs (one capture session, camera fixed on a tripod/stand, LEDs driven with
set_counting_pattern):
  --centers   JSON {leds: [{i, x, y, src, ...}]}: per-LED spot centres in FULL-RES
              px from a one-LED-at-a-time scan (src "none" = not located: hidden
              behind the fixture or too faint to centre reliably).
  --session   one or more  <frames_dir>:<detectable.json>  pairs. frames_dir holds
              <step>_0.png frames and plan_done.json ([{name, exposure,
              exposureTime, blocks:[{start,count,rgb}]}]); detectable.json maps
              step -> {lit: [i...], det: [i...]} where det = lit LEDs whose
              known-location response (frame - dark, max channel, gaussian
              sigma 3) clears 5x the dark-frame noise.
  --pick      step-name regexes; every matching step is included.

Output: frames as the detector's own input — the 2x2 box MEAN of each full-res
pixel quad, rounded to uint8 (the rounding adds <= 0.5 DN at detection
resolution; the lossless uint16 sum doubled the dataset for no regression
value), cropped to --crop and zlib-compressed — plus truth.json (frame metadata, lit LEDs + colour, detectable
set, centres in full-res px, the crop origin).
"""

import argparse
import json
import os
import re
import zlib

import numpy as np
from PIL import Image

ap = argparse.ArgumentParser()
ap.add_argument("--centers", required=True)
ap.add_argument("--session", nargs="+", required=True)
ap.add_argument("--pick", nargs="+", required=True)
ap.add_argument("--crop", default="40,220,660,860", help="x,y,w,h in full-res px (even)")
ap.add_argument("--out", required=True)
ap.add_argument("--note", default="")
a = ap.parse_args()

cx, cy, cw, ch = (int(v) for v in a.crop.split(","))
assert cx % 2 == 0 and cy % 2 == 0 and cw % 2 == 0 and ch % 2 == 0
os.makedirs(a.out, exist_ok=True)
leds = json.load(open(a.centers))["leds"]
truth = {
    "note": a.note,
    "crop": {"x": cx, "y": cy, "w": cw, "h": ch},
    "reduce": "2x2 box mean of RGB8, rounded to uint8 RGB, zlib; detection px = full-res / 2",
    "centers": [
        None if led["src"] == "none" else [round(led["x"], 2), round(led["y"], 2)] for led in leds
    ],
    "frames": [],
}
pats = [re.compile(p) for p in a.pick]
for spec in a.session:
    fdir, detp = spec.split(":")
    plan = json.load(open(os.path.join(fdir, "plan_done.json")))
    det = json.load(open(detp))
    for st in plan:
        name = st["name"]
        if name.startswith("dark") or not any(p.search(name) for p in pats):
            continue
        img = np.asarray(Image.open(os.path.join(fdir, f"{name}_0.png")).convert("RGB")).astype(
            np.uint16
        )
        img = img[cy : cy + ch, cx : cx + cw]
        s = img[0::2, 0::2] + img[1::2, 0::2] + img[0::2, 1::2] + img[1::2, 1::2]
        fn = f"{name}.rgbz"
        open(os.path.join(a.out, fn), "wb").write(
            zlib.compress(((s + 2) // 4).astype(np.uint8).tobytes(), 9)
        )
        m = re.search(r"b([\d.]+)_x([\d.]+)_", name)
        truth["frames"].append(
            {
                "file": fn,
                "brightness": float(m.group(1)),
                "exposure": float(m.group(2)),
                "exposureMs": round(st.get("exposureTime", 0) * 0.1, 3),
                "kind": (
                    "stride2"
                    if name.startswith("s2_")
                    else "palette" if name.startswith("pal_") else "stride3"
                ),
                "lit": [
                    [b["start"], [round(c / max(max(b["rgb"]), 1e-9)) for c in b["rgb"]]]
                    for b in st["blocks"]
                ],
                "detectable": det[name]["det"],
            }
        )
json.dump(truth, open(os.path.join(a.out, "truth.json"), "w"), separators=(",", ":"))
total = sum(os.path.getsize(os.path.join(a.out, f)) for f in os.listdir(a.out))
print(len(truth["frames"]), "frames,", round(total / 1e6, 2), "MB")
