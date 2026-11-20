"""PNG frames -> raw RGB (.rgb) for detect_eval.cjs. Usage: to_raw.py <pngdir> <rawdir>"""
import os, sys, numpy as np
from PIL import Image
src, dst = sys.argv[1:3]
os.makedirs(dst, exist_ok=True)
for f in sorted(os.listdir(src)):
    if f.endswith(".png"):
        np.asarray(Image.open(os.path.join(src, f)).convert("RGB"), np.uint8).tofile(os.path.join(dst, f[:-4] + ".rgb"))
