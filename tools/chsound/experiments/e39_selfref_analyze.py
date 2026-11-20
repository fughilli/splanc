# flake8: noqa
# Experiment script (research record; see docs/research/channel-sounding.md §13). Agent-host paths.
"""Self-referenced two-way delay: each capture contains the device's OWN DAC waveform (leakage,
own tone set) and the PEER's reply (other tone set). u = D_peer - D_own needs no CPU stamps and
no DAC-start epoch. 2tau_raw = u_A + u_B (+const)."""
import base64
import json
import sys

import numpy as np

sys.path.insert(0, "/workspace/.claude/worktrees/chsound/tools/chsound")
import cspipe as cp
import twoway
from cslib import decode_words

D = json.load(open(sys.argv[1]))
P = twoway.P
FS = cp.FS
KS_A = np.r_[np.arange(-500, 0, 2), np.arange(2, 501, 2)]
KS_B = np.r_[np.arange(-499, 0, 2), np.arange(1, 500, 2)]


def S_of(ks):
    m = np.arange(len(ks))
    ph = np.pi * m * m / len(ks)
    X = np.zeros(P, complex)
    X[ks % P] = np.exp(1j * ph)
    x = np.fft.ifft(X) * P
    return np.exp(1j * ph) * 300 / np.max(np.abs(x))


SA, SB = S_of(KS_A), S_of(KS_B)


def chan(x, ks, S, delta, fc, start):
    fbb, fk = cp.rx_freqs(ks, P, delta, fc)
    return cp.tone_phasors_rx(x, fbb, n0=-start) / S, fk


def est(x, ks, S, delta, fc):
    x = x - x.mean()
    start = 1600
    L = (len(x) - start) // P * P  # past any onset (CW tail), integer periods
    seg = x[start : start + L]
    H, fk = chan(seg, ks, S, delta, fc, start)
    Dd, ph, res, pk = cp.delay_estimate(H, fk, P / FS)
    ph0 = float(np.angle(np.sum(np.abs(H) ** 2 * H * np.exp(2j * np.pi * fk * Dd))))
    return Dd, ph0, res, float(np.mean(np.abs(H)))


TPh = P / FS / 2  # the even-bin set repeats every P/2 -> work modulo P/2 for differences
wrap = lambda v: (v + TPh / 2) % TPh - TPh / 2
rows = []
delta = 61.3e-6
for rec in D["recs"]:
    fc = rec["fc"]
    for i in range(D["NEX"]):
        ca, cb = rec["caps"].get(f"A{i}"), rec["caps"].get(f"B{i}")
        if not ca or not cb:
            continue
        xa = decode_words(base64.b64decode(ca))[0].astype(complex)
        xb = decode_words(base64.b64decode(cb))[0].astype(complex)
        oA = est(xa, KS_A, SA, 0.0, fc)
        pA = est(xa, KS_B, SB, -delta, fc)
        oB = est(xb, KS_B, SB, 0.0, fc)
        pB = est(xb, KS_A, SA, delta, fc)
        uA = wrap(pA[0] - oA[0])
        uB = wrap(pB[0] - oB[0])
        tt = wrap(uA + uB)
        car = np.angle(np.exp(1j * (pA[1] - oA[1] + pB[1] - oB[1])))
        rows.append(
            dict(
                fc=fc,
                inj=rec["inj"],
                t=rec["t"],
                i=i,
                uA=uA,
                uB=uB,
                tt=tt,
                car=car,
                res=(oA[2], pA[2], oB[2], pB[2]),
                lvl=(oA[3], pA[3], oB[3], pB[3]),
            )
        )
        print(
            f"lo {fc/1e6:.0f} inj {rec['inj']:4.2f} i{i}: uA {uA*1e9:9.3f} uB {uB*1e9:9.3f} 2tau {tt*1e9:9.3f} ns car {np.degrees(car):+7.1f} | "
            f"res own/peer A {oA[2]:.2f}/{pA[2]:.2f} B {oB[2]:.2f}/{pB[2]:.2f} lvl A {oA[3]:.3f}/{pA[3]:.3f} B {oB[3]:.3f}/{pB[3]:.3f}",
            flush=True,
        )
json.dump(rows, open(sys.argv[1].replace(".json", "_rows.json"), "w"), default=float)
