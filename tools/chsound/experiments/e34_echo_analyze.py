# flake8: noqa
# Experiment script (research record; see docs/research/channel-sounding.md §12). Paths are the
# agent-host layout used for the measurements; adjust before reuse.
"""Hop stitching demo: per-tone magnitude ratio |H_A(echo)|/|H_A(direct)| inside paired bursts at
2422 and 2462 MHz; fit (a, Delta) with one 40 MHz LO vs both (80 MHz). Usage: e34 file.json a delta
"""
import base64
import json
import sys

import matplotlib
import numpy as np
import scipy.optimize as so

matplotlib.use("Agg")
import matplotlib.pyplot as plt

sys.path.insert(
    0,
    ""
    + __import__("os").path.dirname(
        __import__("os").path.dirname(__import__("os").path.abspath(__file__))
    )
    + "",
)
import cspipe as cp
import twoway
from cslib import decode_words

D = json.load(open(sys.argv[1]))
A_T, DLY_T = float(sys.argv[2]), float(sys.argv[3])
s = twoway.Sounder(None)
fk = twoway.KS * cp.FS / twoway.P
acc = {}
for rec in D["recs"]:
    s.fc = rec["fc"]
    for i in range(D["NEX"]):
        ca = rec["caps"].get(f"A{i}")
        if not ca:
            continue
        xa = decode_words(base64.b64decode(ca))[0].astype(complex)
        aA = s.analyse(xa, -61.2e-6, i == 0)
        if aA is None or aA["res"] > 1.2:
            continue
        acc.setdefault((rec["fc"], i % 2), []).append(np.abs(aA["H"]))
los = sorted(set(k[0] for k in acc))
R = {lo: np.median(acc[(lo, 1)], 0) / np.median(acc[(lo, 0)], 0) for lo in los}
good = ~((fk > -6e6) & (fk < 2e6)) & (np.abs(fk) < 19e6)


def fit(sel):
    f = np.concatenate([lo + fk[good] for lo in sel])
    y = np.concatenate([R[lo][good] for lo in sel])
    best = None
    for d0 in np.arange(3, 60, 0.5):
        for a0 in (0.3, 0.6, 0.9):
            r = so.least_squares(
                lambda p: p[2] * np.abs(1 + p[0] * np.exp(-2j * np.pi * f * p[1] * 1e-9)) - y,
                [a0, d0, 1 / (1 + a0)],
                bounds=([0, 0, 0], [2, 100, 10]),
            )
            if best is None or r.cost < best.cost:
                best = r
    J = best.jac
    cov = np.linalg.pinv(J.T @ J) * (2 * best.cost / max(len(y) - 3, 1))
    return best.x, np.sqrt(np.diag(cov)), f, y


fig, ax = plt.subplots(figsize=(9, 3.8))
for sel, lab in (
    ([los[0]], f"40 MHz @ {los[0]/1e6:.0f}"),
    ([los[-1]], f"40 MHz @ {los[-1]/1e6:.0f}"),
    (los, "80 MHz stitched"),
):
    x, sd, f, y = fit(sel)
    print(
        f"{lab:18s}: a={x[0]:.3f}+-{sd[0]:.3f} Delta={x[1]:.2f}+-{sd[1]:.2f} ns  (true a={A_T}, Delta={DLY_T})"
    )
    if len(sel) == 2:
        ax.plot(f / 1e6, y, ".", ms=2, label="measured |H_echo/H_direct|")
        ff = np.linspace(f.min(), f.max(), 2000)
        ax.plot(
            ff / 1e6,
            x[2] * np.abs(1 + x[0] * np.exp(-2j * np.pi * ff * x[1] * 1e-9)),
            "k-",
            lw=1,
            label=f"2-path fit, 80 MHz: Delta={x[1]:.2f}+-{sd[1]:.2f} ns",
        )
ax.set_xlabel("RF frequency (MHz)")
ax.set_ylabel("magnitude ratio")
ax.legend()
ax.set_title(f"Two HT40 LOs stitched: injected echo a={A_T}, Delta={DLY_T} ns")
fig.tight_layout()
fig.savefig(sys.argv[4] if len(sys.argv) > 4 else "/tmp/e34.png", dpi=90)
