# flake8: noqa
# Experiment script (research record; see docs/research/channel-sounding.md §13). Agent-host paths.
"""Paired-burst analysis from on-device results (PROC lines: per slot D_win ns, phase deg, |H|)."""
import json
import sys

import numpy as np

sys.path.insert(0, "/workspace/.claude/worktrees/chsound/tools/chsound")
import cspipe as cp
import twoway

D = json.load(open(sys.argv[1]))
NEX = D["NEX"]
TP = twoway.TP
FS = cp.FS


def abs_c(line, op, n):
    t0 = int(line.split()[2].split("=")[1])
    return (t0 + cp.stamp(cp.parse_seq(line), op, n)) % (1 << 32)


wd = lambda a, c: ((a - c + (1 << 31)) % (1 << 32) - (1 << 31)) / cp.FCPU
delta = 61.3e-6


def parse(lines):
    ln = [l for l in lines if l.startswith("PROC")][0].split()
    v = [x.split(",") for x in ln[2 : 2 + NEX]]
    return [(float(a) * 1e-9, np.radians(float(b)), float(c)) for a, b, c in v]


t0 = None
nb = 0
for rec in D["recs"]:
    fc = rec["fc"]
    off = rec["OFF"]
    la, lb = rec["la"], rec["lb"]
    try:
        pA, pB = parse(rec["caps"]["A"]), parse(rec["caps"]["B"])
    except Exception:
        continue
    ex = []
    ref = None
    for i in range(NEX):
        DA = (pA[i][0] / (1 - delta) + off / FS) % TP
        phA = pA[i][1] - 2 * np.pi * (-delta) * fc * off / FS
        DB = (pB[i][0] / (1 + delta) + off / FS) % TP
        phB = pB[i][1] - 2 * np.pi * delta * fc * off / FS
        xA, xB = abs_c(la, "X", i), abs_c(lb, "X", i)
        yA, yB = wd(abs_c(la, "Y", i), xA), wd(abs_c(lb, "Y", i), xB)
        arrB = yB + DB
        if ref is None:
            ref = arrB
        arrB += TP * np.round((ref - arrB) / TP)
        tt = yA + DA + arrB * (1 + delta)
        tt = (tt + TP / 2) % TP - TP / 2
        car = np.angle(np.exp(1j * (phB + phA + 2 * np.pi * delta * fc * ((arrB - yB) + yA))))
        ex.append((tt, car, i))
    ev = [e for e in ex if e[2] % 2 == 0]
    od = [e for e in ex if e[2] % 2 == 1]
    ge = np.array([e[0] for e in ev])
    go = np.array([e[0] for e in od])
    if len(ge) == 0 or len(go) == 0:
        continue
    ce = np.mean(np.exp(1j * np.array([e[1] for e in ev])))
    co = np.mean(np.exp(1j * np.array([e[1] for e in od])))
    dg = go.mean() - ge.mean()
    dphi = float(np.angle(co * np.conj(ce)))
    nb += 1
    print(
        f"lo {fc/1e6:.0f} inj {rec['inj']:5.2f}: n={len(ex)} cal gd {ge.mean()*1e9:9.3f} dgd {dg*1e9:+.3f} ns  dphi {np.degrees(dphi):+7.1f} (exp {np.degrees(np.angle(np.exp(-2j*np.pi*fc*rec['inj']*1e-9))):+7.1f}) burst {rec['burst_s']:.2f}s"
    )
if "t_end" in D:
    print(
        f"# rate: {nb} bursts x {NEX} exchanges in {D['t_end'] - D['t_start']:.1f} s wall = {nb*NEX/(D['t_end'] - D['t_start']):.2f} exchanges/s (incl. waveform uploads, retries)"
    )
