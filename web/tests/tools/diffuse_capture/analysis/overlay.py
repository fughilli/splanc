"""overlay.py <eval.json> <config> <frame> <out.png>: truth (yellow=located+detectable, grey=lit but
not detectable/unlocated position) vs blobs (green=matched, red=false)."""

import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageEnhance

D = os.path.dirname(os.path.abspath(__file__))
ev, cfg, name, out = sys.argv[1:5]
C = json.load(open(os.environ.get("SCORE_CENTERS", f"{D}/centers.json")))["leds"]
XY = np.array([[led["x"], led["y"]] for led in C])
det = json.load(open(f"{D}/detectable_" + os.environ.get("SCORE_FRAMES", "stride") + ".json"))[name]
blobs = json.load(open(ev))[cfg][name + "_0"]
im = Image.open(
    f"{D}/frames/" + os.environ.get("SCORE_FRAMES", "stride") + f"/{name}_0.png"
).convert("RGB")
a = np.asarray(im).astype(float)
g = 200 / max(8, np.percentile(a.max(2), 99.9))
im = ImageEnhance.Brightness(im).enhance(g)
dr = ImageDraw.Draw(im)
for i in det["lit"]:
    if C[i]["src"] == "none":
        continue
    x, y = XY[i]
    dr.rectangle(
        (x - 7, y - 7, x + 7, y + 7),
        outline="yellow" if i in det["det"] else (110, 110, 110),
        width=2,
    )
lit = XY[[i for i in det["lit"] if C[i]["src"] != "none"]]
for b in blobs:
    x, y = b[0], b[1]
    ok = len(lit) and np.min(np.hypot(*(lit - [x, y]).T)) < 15
    dr.ellipse((x - 4, y - 4, x + 4, y + 4), outline="lime" if ok else "red", width=2)
im.crop((60, 240, 680, 1060)).save(out)
