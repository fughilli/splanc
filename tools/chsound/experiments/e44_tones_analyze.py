# flake8: noqa
# Experiment script (research record; see docs/research/channel-sounding.md §13). Agent-host paths.
"""Paired-burst analysis from on-device FFT tones (e43). Light: no host DFT."""
import base64
import json
import sys

import numpy as np

sys.path.insert(0, "/workspace/.claude/worktrees/chsound/tools/chsound")
import cspipe as cp
import twoway

D = json.load(open(sys.argv[1]))
NEX = D["NEX"]
P, TP = twoway.P, twoway.TP
ks = twoway.KS
m = np.arange(len(ks))
ph = np.pi * m * m / len(ks)
X = np.zeros(P, complex)
X[ks % P] = np.exp(1j * ph)
x = np.fft.ifft(X) * P
S = np.exp(1j * ph) * 300 / np.max(np.abs(x))


def abs_c(line, op, n):
    t0 = int(line.split()[2].split("=")[1])
    return (t0 + cp.stamp(cp.parse_seq(line), op, n)) % (1 << 32)


wd = lambda a, c: ((a - c + (1 << 31)) % (1 << 32) - (1 << 31)) / cp.FCPU
delta = 61.3e-6
out = []
for rec in D["recs"]:
    fc = rec["fc"]
    off = rec.get("OFF", 3072)
    la, lb = rec["la"], rec["lb"]
    ex = []
    ref_arrB = None
    for i in range(NEX):
        ca, cb = rec["caps"].get(f"A{i}"), rec["caps"].get(f"B{i}")
        if not ca or not cb:
            continue
        XA = np.frombuffer(base64.b64decode(ca), "<i4").astype(float)
        XA = XA[0::2] + 1j * XA[1::2]
        XB = np.frombuffer(base64.b64decode(cb), "<i4").astype(float)
        XB = XB[0::2] + 1j * XB[1::2]
        cfoA, cfoB = round(-delta * fc), round(delta * fc)
        HA, fkA = cp.device_tones_to_H(XA, ks, S, -delta, fc, off, cfoA)
        HB, fkB = cp.device_tones_to_H(XB, ks, S, delta, fc, off, cfoB)
        DA, phA, resA, _ = cp.delay_estimate(HA, fkA, TP)
        DB, phB, resB, _ = cp.delay_estimate(HB, fkB, TP)
        if resA > 1 or resB > 1.2:
            continue
        phA = float(np.angle(np.sum(np.abs(HA) ** 2 * HA * np.exp(2j * np.pi * fkA * DA))))
        phB = float(np.angle(np.sum(np.abs(HB) ** 2 * HB * np.exp(2j * np.pi * fkB * DB))))
        xA, xB = abs_c(la, "X", i), abs_c(lb, "X", i)
        yA, yB = wd(abs_c(la, "Y", i), xA), wd(abs_c(lb, "Y", i), xB)
        arrB = yB + DB
        if ref_arrB is None:
            ref_arrB = arrB
        arrB += TP * np.round((ref_arrB - arrB) / TP)
        arrA = yA + DA
        tt = arrA + arrB * (1 + delta)
        tt = (tt + TP / 2) % TP - TP / 2
        car = np.angle(np.exp(1j * (phB + phA + 2 * np.pi * delta * fc * ((arrB - yB) + yA))))
        ex.append((tt, car, i, resA, resB))
    ev = [e for e in ex if e[2] % 2 == 0]
    od = [e for e in ex if e[2] % 2 == 1]
    if not ev or not od:
        continue
    ge = np.array([e[0] for e in ev])
    go = np.array([e[0] for e in od])
    ce = np.mean(np.exp(1j * np.array([e[1] for e in ev])))
    co = np.mean(np.exp(1j * np.array([e[1] for e in od])))
    dg = go.mean() - ge.mean()
    dphi = float(np.angle(co * np.conj(ce)))
    print(
        f"lo {fc/1e6:.0f} inj {rec['inj']:5.2f}: n={len(ex)} cal gd {ge.mean()*1e9:9.3f} dgd {dg*1e9:+.3f} ns  dphi {np.degrees(dphi):+7.1f} (exp {np.degrees(np.angle(np.exp(-2j*np.pi*fc*rec['inj']*1e-9))):+7.1f}) res {np.mean([e[3] for e in ex]):.2f}/{np.mean([e[4] for e in ex]):.2f} fetch {rec.get('fetch_s', 0):.2f}s",
        flush=True,
    )
