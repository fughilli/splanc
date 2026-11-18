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


def progs():
    """Continuous DAC: started ONCE per burst (X); exchanges only key/unkey and switch the
    SRAM owner (the DAC read pointer keeps running, so the waveform epoch never restarts)."""
    a = ["G20", "H2048", "O0x10400", "X2048", "V"]
    bb = ["G20", "O0x10400", "X2048", "V", "O0x400", "N600,150000"]
    for i in range(NEX):
        a0 = 800 + PRE + i * TEX
        a += [
            f"A{a0 - (PRE if i == 0 else 0)}",
            "O0x10400",
            "K0",
            f"A{a0+40}",
            "T",
            f"A{a0+150}",
            "V",
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
            "T",
            f"B{b0+420}",
            "V",
        ]
    a += ["d"]
    bb += ["d"]
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
BPC = int(sys.argv[5]) if len(sys.argv) > 5 else 4  # bursts per (LO, injection)


def load_b(lo, inj):
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
                got = one_burst()
                if got is None:
                    continue
                la, lb = got
                caps = {}
                for dev in "AB":
                    for i in range(NEX):
                        raw = None
                        slot = i + 1 if dev == "B" else i
                        for _ in range(4):
                            raw = b64_of(b.cmd(dev, f"mem {0x40820000 + slot*NC*4} {NC}"))
                            if raw is not None:
                                break
                        caps[f"{dev}{i}"] = base64.b64encode(raw).decode() if raw else None
                recs.append(
                    dict(t=time.time(), fc=lo * 1e6, inj=inj, rep=rep, la=la, lb=lb, caps=caps)
                )
                print(
                    f"rep{rep} lo {lo:.0f} inj {inj} burst {k}: ok ({len(recs)} bursts, {fails}/{tried} sync misses)",
                    flush=True,
                )
cp.upload(b, "B", s.words)
fn = f"/workspace/.claude/chsound/exp/e36_{TAG}_{int(time.time())}.json"
json.dump(
    dict(mode="pairs-contdac", recs=recs, fails=fails, tried=tried, NEX=NEX, TEX=TEX, NC=NC),
    open(fn, "w"),
)
print("saved", fn, "sync misses", fails, "/", tried)
