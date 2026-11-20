# flake8: noqa
# Experiment script (research record; see docs/research/channel-sounding.md §14). Agent-host paths.
"""In-burst LO stepping: per exchange two-way carrier phase at its own LO; per burst slope -> RF phase delay."""
import base64
import json
import sys

import numpy as np

sys.path.insert(0, "/workspace/.claude/worktrees/chsound/tools/chsound")
import cspipe as cp
import twoway
from cslib import decode_words

D = json.load(open(sys.argv[1]))
LOS = [x * 1e6 for x in D["step_los"]]
NEX = len(LOS)
TP = twoway.TP
s = twoway.Sounder(None)


def abs_c(line, op, n):
    t0 = int(line.split()[2].split("=")[1])
    return (t0 + cp.stamp(cp.parse_seq(line), op, n)) % (1 << 32)


wd = lambda a, c: ((a - c + (1 << 31)) % (1 << 32) - (1 << 31)) / cp.FCPU
slopes = []
gds = []
first = True
for rec in D["recs"]:
    la, lb = rec["la"], rec["lb"]
    car = {}
    gd = []
    for i in range(NEX):
        ca, cb = rec["caps"].get(f"A{i}"), rec["caps"].get(f"B{i}")
        if not ca or not cb:
            continue
        s.fc = LOS[i]
        xa = decode_words(base64.b64decode(ca))[0].astype(complex)
        xb = decode_words(base64.b64decode(cb))[0].astype(complex)
        aB, aA = s.analyse(xb, s.delta, first), s.analyse(xa, -s.delta, first)
        if aB is None or aA is None or aA["res"] > 1 or aB["res"] > 1.2:
            continue
        if first:
            s.delta = aB["delta"]
            first = False
        xA, xB = abs_c(la, "X", i), abs_c(lb, "X", i)
        yA, yB = wd(abs_c(la, "Y", i), xA), wd(abs_c(lb, "Y", i), xB)
        tA = wd(abs_c(la, "T", i), xA)
        predB = yB + aB["n_on"] / cp.FS - tA
        arrB = yB + aB["D"]
        arrB += TP * np.round((predB - arrB) / TP)
        tt = yA + aA["D"] + arrB * (1 + aB["delta"])
        tt = (tt + TP / 2) % TP - TP / 2
        dav = 0.5 * (aB["delta"] - aA["delta"])
        car[i] = np.angle(
            np.exp(1j * (aB["ph"] + aA["ph"] + 2 * np.pi * dav * LOS[i] * ((arrB - yB) + yA)))
        )
        gd.append(tt)
    if len(car) < 3:
        continue
    ii = sorted(car)
    f = np.array([LOS[i] for i in ii])
    ph = np.unwrap(np.array([car[i] for i in ii]))
    p = np.polyfit(f, ph, 1)
    slopes.append(-p[0] / (2 * np.pi))
    gds.append(np.median(gd))
    print(
        f"burst: n={len(ii)} carrier deg {np.round(np.degrees(ph),1)} -> phase delay 2tau_ph {slopes[-1]*1e9:7.3f} ns | gd {gds[-1]*1e9:.3f} ns",
        flush=True,
    )
sl = np.array(slopes) * 1e9
g = np.array(gds) * 1e9
if len(sl):
    med = np.median(sl)
    k = np.abs(sl - med) < 10
    print(
        f"RF phase delay (round trip) median {med:.3f} ns, mean {sl[k].mean():.3f} +- {sl[k].std()/np.sqrt(k.sum()):.3f} ns (std/burst {sl[k].std():.3f}, n={k.sum()}); gd {np.median(g):.3f} ns"
    )
