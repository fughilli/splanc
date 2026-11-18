"""compare.py <dir>: TS reference vs Swift detect buffers — kept-pixel mask agreement and value deltas."""

import os
import sys

import numpy as np

d = sys.argv[1]
worst = 0
mask_diff = 0
total_kept = 0
for f in sorted(os.listdir(d)):
    if not f.endswith(".ts.u8"):
        continue
    a = np.fromfile(os.path.join(d, f), np.uint8).reshape(-1, 4).astype(int)
    b = (
        np.fromfile(os.path.join(d, f.replace(".ts.u8", ".swift.u8")), np.uint8)
        .reshape(-1, 4)
        .astype(int)
    )
    ka, kb = a[:, 3] > 0, b[:, 3] > 0
    mask_diff += int((ka != kb).sum())
    total_kept += int(ka.sum())
    both = ka & kb
    if both.any():
        worst = max(worst, int(np.abs(a[both] - b[both]).max()))
print(
    f"kept px (TS) {total_kept}, mask mismatches {mask_diff} "
    f"({100 * mask_diff / max(1, total_kept):.3f}%), max |delta| on shared px {worst}"
)
sys.exit(0 if mask_diff <= 0.005 * total_kept and worst <= 1 else 1)
