# flake8: noqa
# Experiment script (research record; see docs/research/channel-sounding.md §13). Agent-host paths.
"""Collect raw tight bursts on a schedule (analysis offline, e31). Usage: e30_collect.py TAG LOS INJS REPS"""
import base64
import json
import sys
import time

import numpy as np

sys.path.insert(0, "/workspace/.claude/worktrees/chsound/tools/chsound")
import cspipe as cp
import twoway
from cslib import Bench, b64_of

b = Bench()
TAG = sys.argv[1]
LOS = [float(x) for x in sys.argv[2].split(",")]
INJS = [float(x) for x in sys.argv[3].split(",")]
REPS = int(sys.argv[4]) if len(sys.argv) > 4 else 1
NEX, TEX, NC, PRE = 4, 600, 6144, 300
OFF = 2048
DELTA = 61.3e-6


def progs():
    a = ["G20", "H2048", "O0x10400"]
    bb = ["G20", "O0x200", "N600,150000"]
    for i in range(NEX):
        a0 = 800 + PRE + i * TEX
        a += [
            f"A{a0 - (PRE if i == 0 else 0)}",
            "O0x10400",
            "K0",
            f"A{a0+40}",
            "X2048",
            "T",
            f"A{a0+150}",
            "V",
            "d",
            "O0x400",
            f"A{a0+330}",
            f"Y{NC}",
            f"Q{i}",
        ]
        b0 = PRE + i * TEX
        own = (
            "O0x10400" if i % 2 == 0 else "O0x200"
        )  # even: normal waveform, odd: injected (block 1)
        bb += [
            f"B{b0}",
            "O0x400",
            f"Y{NC}",
            f"Q{i+1}",
            f"B{b0+200}",
            own,
            "K0",
            f"B{b0+240}",
            "X2048",
            "T",
            f"B{b0+420}",
            "V",
            "d",
        ]
    return "seq " + " ".join(a), "seq G20 O0x0", "seq " + " ".join(bb)


APROG, BPREP, BPROG = progs()
import os

ECHO = [float(v) for v in os.environ["ECHO"].split(",")] if os.environ.get("ECHO") else None


def wave_b(fc, inj_ns):
    """Injected reply: a pure delay inj_ns, or (ECHO=a,delta_ns) direct path + a*echo at delta."""
    ks = twoway.KS
    m = np.arange(len(ks))
    ph = np.pi * m * m / len(ks)
    f = ks * cp.FS / twoway.P + fc
    X = np.zeros(twoway.P, complex)
    if ECHO:
        X[ks % twoway.P] = np.exp(1j * ph) * (
            1 + ECHO[0] * np.exp(-2j * np.pi * f * ECHO[1] * 1e-9)
        )
    else:
        X[ks % twoway.P] = np.exp(1j * ph) * np.exp(-2j * np.pi * f * inj_ns * 1e-9)
    x = np.fft.ifft(X) * twoway.P
    x *= 300 / np.max(np.abs(x))
    return cp.iqword(x.real, x.imag)


s = twoway.Sounder(b, fc=LOS[0])
s.setup()
recs = []
fails = 0
tried = 0
T_START = time.time()
BPC = int(sys.argv[5]) if len(sys.argv) > 5 else 4  # bursts per (LO, injection)


def load_b(lo, inj):
    for d in "AB":
        b.cmd(d, "nref 1000")
    cp.upload(b, "B", wave_b(lo * 1e6, inj))
    b.cmd("B", "seq J2048")
    cp.upload(b, "B", s.words)
    b.cmd("B", "seq H2048 O0x0")


def one_burst():
    global fails, tried
    for attempt in range(3):
        tried += 1
        out = b.run(
            [
                {"dev": "B", "cmd": BPREP},
                {"dev": "B", "cmd": BPROG, "nowait": True},
                {"sleep": 0.01},
                {"dev": "A", "cmd": APROG},
                {"wait": "B"},
            ]
        )
        try:
            la, lb = out[3]["lines"][0], out[4]["lines"][0]
            if cp.parse_seq(la)["ok"] and cp.parse_seq(lb)["ok"]:
                return la, lb
        except Exception:
            pass
        fails += 1
    return None


for rep in range(REPS):
    for lo in LOS:
        if s.fc != lo * 1e6:
            s.retune(lo * 1e6)
        for inj in INJS:
            load_b(lo, inj)
            for k in range(BPC):
                t_burst = time.time()
                got = one_burst()
                if got is None:
                    continue
                la, lb = got
                caps = {}
                t_fetch = time.time()
                steps = []
                for dev in "AB":
                    cfo = int(round((-1 if dev == "A" else 1) * DELTA * lo * 1e6))
                    a0 = 0x40820000 + (NC * 4 if dev == "B" else 0)
                    steps.append(
                        {
                            "dev": dev,
                            "cmd": f"proc {cfo} {OFF} 500 {NEX} {a0} {NC*4}",
                            "nowait": True,
                        }
                    )
                res = b.run(steps + [{"wait": "A", "timeout": 20}, {"wait": "B", "timeout": 20}])
                caps["A"], caps["B"] = res[2]["lines"], res[3]["lines"]
                fetch_s = time.time() - t_fetch
                recs.append(
                    dict(
                        t=time.time(),
                        fc=lo * 1e6,
                        inj=inj,
                        rep=rep,
                        la=la,
                        lb=lb,
                        caps=caps,
                        fetch_s=fetch_s,
                        OFF=OFF,
                        burst_s=time.time() - t_burst,
                    )
                )
                print(
                    f"rep{rep} lo {lo:.0f} inj {inj} burst {k}: ok ({len(recs)} bursts, {fails}/{tried} sync misses)",
                    flush=True,
                )
cp.upload(b, "B", s.words)
fn = f"/workspace/.claude/chsound/exp/e46_{TAG}_{int(time.time())}.json"
json.dump(
    dict(
        mode="pairs-proc",
        t_start=T_START,
        t_end=time.time(),
        recs=recs,
        fails=fails,
        tried=tried,
        NEX=NEX,
        TEX=TEX,
        NC=NC,
    ),
    open(fn, "w"),
)
print("saved", fn, "sync misses", fails, "/", tried)
