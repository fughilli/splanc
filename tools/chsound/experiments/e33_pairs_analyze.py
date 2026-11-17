# flake8: noqa
# Experiment script (research record; see docs/research/channel-sounding.md §12). Paths are the
# agent-host layout used for the measurements; adjust before reuse.
"""Analyse e30 raw bursts -> per-exchange rows; then per-LO interleaved calibration and carrier-integer
resolution of the injected delays. Usage: e31_analyze.py e30_file.json"""
import base64
import json
import sys

import numpy as np

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
NEX = D["NEX"]
s = twoway.Sounder(None)
P, TP = twoway.P, twoway.TP


def abs_c(line, op, n):
    t0 = int(line.split()[2].split("=")[1])
    return (t0 + cp.stamp(cp.parse_seq(line), op, n)) % (1 << 32)


wd = lambda a, c: ((a - c + (1 << 31)) % (1 << 32) - (1 << 31)) / cp.FCPU
bursts = []
tests = []
for bi, rec in enumerate(D["recs"]):
    s.fc = rec["fc"]
    ex = []
    for i in range(NEX):
        ca, cb = rec["caps"].get(f"A{i}"), rec["caps"].get(f"B{i}")
        if not ca or not cb:
            continue
        xa = decode_words(base64.b64decode(ca))[0].astype(complex)
        xb = decode_words(base64.b64decode(cb))[0].astype(complex)
        srch = i == 0
        aB, aA = s.analyse(xb, s.delta, srch), s.analyse(xa, -s.delta, srch)
        if aB is None or aA is None or aA["res"] > 1 or aB["res"] > 1.2:
            continue
        if srch:
            s.delta = aB["delta"]
        la, lb = rec["la"], rec["lb"]
        xA, xB = abs_c(la, "X", i), abs_c(lb, "X", i)
        yA, yB = wd(abs_c(la, "Y", i), xA), wd(abs_c(lb, "Y", i), xB)
        tA = wd(abs_c(la, "T", i), xA)
        predB = yB + aB["n_on"] / cp.FS - tA
        arrB = yB + aB["D"]
        arrB += TP * np.round((predB - arrB) / TP)
        arrA = yA + aA["D"]
        tt = arrA + arrB * (1 + aB["delta"])
        tt = (tt + TP / 2) % TP - TP / 2
        dav = 0.5 * (aB["delta"] - aA["delta"])
        car = np.angle(
            np.exp(1j * (aB["ph"] + aA["ph"] + 2 * np.pi * dav * s.fc * ((arrB - yB) + yA)))
        )
        ex.append((tt, car))
        ex[-1] = (tt, car, i)
    if not ex:
        continue
    ev = [e for e in ex if e[2] % 2 == 0]
    od = [e for e in ex if e[2] % 2 == 1]
    if not ev or not od:
        continue
    ge = np.array([e[0] for e in ev])
    go = np.array([e[0] for e in od])
    ce = np.mean(np.exp(1j * np.array([e[1] for e in ev])))
    co = np.mean(np.exp(1j * np.array([e[1] for e in od])))
    tests.append(
        dict(
            t=rec["t"],
            fc=rec["fc"],
            inj=rec["inj"],
            dg=go.mean() - ge.mean(),
            dphi=float(np.angle(co * np.conj(ce))),
            g_even=ge.mean(),
            phi_even=float(np.angle(ce)),
            n=len(ex),
        )
    )
    print(
        f"lo {rec['fc']/1e6:.0f} inj {rec['inj']:5.2f}: n={len(ex)} cal gd {ge.mean()*1e9:9.3f} dgd {tests[-1]['dg']*1e9:+.3f} ns  dphi {np.degrees(tests[-1]['dphi']):+7.1f} (exp {np.degrees(np.angle(np.exp(-2j*np.pi*rec['fc']*rec['inj']*1e-9))):+7.1f})",
        flush=True,
    )


def solve(units):
    dg = np.array([u["dg"] for u in units])
    dphi = np.array([u["dphi"] for u in units])
    f = np.array([u["fc"] for u in units])
    d_g = dg.mean()
    sg = max(dg.std(ddof=1) / np.sqrt(len(dg)) if len(dg) > 1 else 0.3e-9, 0.02e-9)
    grid = d_g + np.linspace(-5 * sg, 5 * sg, 6001)
    coh = np.abs(
        (np.exp(1j * dphi)[None, :] * np.exp(2j * np.pi * np.outer(grid, f))).sum(1)
    ) / len(f)
    # candidates = carrier-coherence peaks (spaced 1/f ~0.41 ns); choose by gd prior + coherence
    score = len(f) * np.log(np.maximum(coh, 1e-6)) * 4 - 0.5 * ((grid - d_g) / sg) ** 2
    return d_g, grid[np.argmax(score)], sg, coh.max()


print("\ninterleaved tests (per LO):")
for t in tests:
    print(
        f"  lo {t['fc']/1e6:.0f} inj {t['inj']:5.2f}: dgd {t['dg']*1e9:+.3f} ns  dphi {np.degrees(t['dphi']):+7.1f} deg (expected {np.degrees(np.angle(np.exp(-2j*np.pi*t['fc']*t['inj']*1e-9))):+7.1f})  cal drift {t['cal_drift_deg']:+.1f} deg"
    )
print("\nresolution (all LOs combined per injection):")
res = {}
for inj in sorted(set(t["inj"] for t in tests)):
    u = [t for t in tests if t["inj"] == inj]
    d_g, d_r, sg, coh = solve(u)
    res[inj] = (d_g, d_r)
    print(
        f"  inj {inj:5.2f} ns: n_LO={len(u)}  gd-only {d_g*1e9:+.3f} ns (err {d_g*1e9-inj:+.3f}, sigma {sg*1e9:.3f})  "
        f"carrier-resolved {d_r*1e9:+.4f} ns (err {(d_r*1e9-inj)*1e3:+.1f} ps)  coherence {coh:.2f}"
    )
json.dump(
    dict(tests=tests, res={str(k): v for k, v in res.items()}),
    open(sys.argv[1].replace(".json", "_resolve.json"), "w"),
    default=float,
)
