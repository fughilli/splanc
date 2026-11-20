# flake8: noqa
# Experiment script (research record; see docs/research/channel-sounding.md §13). Agent-host paths.
import glob
import json
import sys

import numpy as np

sys.path.insert(0, "/workspace/.claude/worktrees/chsound/tools/chsound")
import cspipe as cp
import twoway
from cslib import Bench, b64_of, decode_words

b = Bench()
fc = 2442e6
d = 61.3e-6
OFF = 2048
NC = 6144
rec = json.load(open(sorted(glob.glob(sys.argv[1]))[-1]))["recs"][0]
s = twoway.Sounder(None, fc=fc)
for dev, dl, base in (("A", -d, 0x40820000), ("B", d, 0x40820000 + NC * 4)):
    vals = [v.split(",") for v in rec["caps"][dev][0].split()[2:6]]
    print(
        dev,
        rec["caps"][dev][0].split()[-2:],
        "fetch %.2fs burst %.2fs" % (rec["fetch_s"], rec["burst_s"]),
    )
    for i in range(4):
        raw = None
        while raw is None:
            raw = b64_of(b.cmd(dev, f"mem {base+i*NC*4} {NC}"))
        x = decode_words(raw)[0].astype(complex)
        a = s.analyse(x, dl, False)
        if a is None:
            print("  host fail")
            continue
        Dw = float(vals[i][0]) * 1e-9
        phw = np.radians(float(vals[i][1]))
        Dcap = (Dw / (1 + dl) + OFF / cp.FS) % twoway.TP
        phcap = np.angle(np.exp(1j * (phw - 2 * np.pi * dl * fc * OFF / cp.FS)))
        dd = ((Dcap - a["D"]) + twoway.TP / 2) % twoway.TP - twoway.TP / 2
        print(
            f"  slot{i}: host D {a['D']*1e9:10.3f} ph {np.degrees(a['ph']):+7.1f} | device D {Dcap*1e9:10.3f} ph {np.degrees(phcap):+7.1f}  dD {dd*1e9:+.3f} ns dph {np.degrees(np.angle(np.exp(1j*(phcap-a['ph'])))):+.1f}"
        )
