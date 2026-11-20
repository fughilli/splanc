"""Two-way wideband channel sounding between two C6s (DUT A = initiator, DUT B = reflector).

One exchange (firmware `seq` programs, both devices on the same LO, HT40):
  A: CW preamble (vendor tone) -> its DAC plays the periodic multitone -> unkey -> RX
  B: detects A's CW (narrowband IQE detector), captures A's preamble tail + comb, then
     transmits its own preamble + comb back; A detects it and captures.
Both captures contain the CW->comb onset, which pins the waveform epoch; every engine trigger
is stamped with the CPU cycle counter. From the two captures and the stamps:

  2*tau = Tround_A - Treply_B - delta * Treply_B            (group delay, both clocks)
  phi   = phase_B(f=0) + phase_A(f=0) + 2*pi*delta*fc*(D_B + I_A)   (two-way carrier phase)

delta = eps_A - eps_B (relative crystal error, fitted per capture from the tone grid).
2*tau includes a fixed hardware offset (TX+RX chain delays of both boards), removed by
calibration (calib.json: per-LO offsets measured at a known distance).

Usage (rig daemon tunnel up, see README):
    from cslib import Bench; import twoway
    b = Bench(); s = twoway.Sounder(b, fc=2440e6); s.setup()
    r = s.exchange()   # dict with two_tau, carrier, delta, quality fields (or None)
"""

from __future__ import annotations

import cspipe as cp
import numpy as np
from cslib import b64_of, decode_words

P = 2048
TP = P / cp.FS
KS = np.r_[np.arange(-500, 0), np.arange(1, 501)]  # 1000 tones, 39.06 kHz, +-19.5 MHz

PREP = "seq G20 L2048 K0 T X2048 V d"
A_PROG = "seq A100 K0 O0x400 A250 X2048 T A400 V d O0x200 N1000,5000 B60 Y8192 O0x400"
B_PROG = "seq O0x200 N1000,100000 B60 Y8192 O0x400 B560 K0 B690 X2048 T B840 V d"


def _abs_c(line: str, op: str, n: int = 0) -> int:
    t0 = int(line.split()[2].split("=")[1])
    return (t0 + cp.stamp(cp.parse_seq(line), op, n)) % (1 << 32)


def _wrapdiff(a: int, b: int) -> float:
    return ((a - b + (1 << 31)) % (1 << 32) - (1 << 31)) / cp.FCPU


class Sounder:
    def __init__(
        self,
        bench,
        fc: float = 2440e6,
        delta0: float = 61.25e-6,
        peak: float = 300,
        ks: np.ndarray = KS,
        a="A",
        b="B",
    ):
        self.b = bench
        self.fc = fc
        self.delta = delta0
        self.ks = ks
        self.words, self.S = cp.multitone(P, ks, peak=peak, swap=False)
        self.A, self.B = a, b

    # -- device setup -------------------------------------------------------------------
    def setup(self, upload: bool = True):
        for d in (self.A, self.B):
            self.b.cmd(d, f"tune {int(round(self.fc / 1e6))} 0")
            # HT40-above is only valid up to ch 9; above that use HT40-below (same LO, other filter cfg)
            self.b.cmd(d, "ht40 1" if self.fc < 2452e6 else "ht40 2")
            self.b.cmd(d, "gain 20")
            if upload:
                cp.upload(self.b, d, self.words)

    def retune(self, fc: float):
        """Hop both devices to a new LO (vendor channel + PLL, HT40, gain re-forced)."""
        self.fc = fc
        self.setup(upload=False)

    # -- analysis -----------------------------------------------------------------------
    def _chan(self, x, delta, start):
        fbb, fk = cp.rx_freqs(self.ks, P, delta, self.fc)
        return cp.tone_phasors_rx(x, fbb, n0=-start) / self.S, fk

    def analyse(self, x, delta0, search: bool = True):
        x = x - x.mean()
        n_on = cp.comb_onset(x, P)
        start = n_on + 160
        L = (len(x) - start) // P * P
        if n_on < 0 or L < P:
            return None
        seg = x[start : start + L]
        best, span = delta0, 0.5e-6
        for _ in range(3 if search else 0):
            grid = best + np.linspace(-span, span, 11)
            e = [np.sum(np.abs(self._chan(seg, d, start)[0]) ** 2) for d in grid]
            best = grid[int(np.argmax(e))]
            span /= 5
        H, fk = self._chan(seg, best, start)
        D, ph, res, pk = cp.delay_estimate(H, fk, TP)
        # carrier phase at f = 0 with the full fitted delay removed
        ph0 = float(np.angle(np.sum(np.abs(H) ** 2 * H * np.exp(2j * np.pi * fk * D))))
        return dict(delta=best, D=D, ph=ph0, res=res, n_on=n_on, L=L, H=H, fk=fk)

    # -- one exchange -------------------------------------------------------------------
    def exchange(self, keep_raw: bool = False):
        b, A, B = self.b, self.A, self.B
        out = b.run(
            [
                {"dev": A, "cmd": PREP},
                {"dev": B, "cmd": PREP},
                {"dev": B, "cmd": B_PROG, "nowait": True},
                {"sleep": 0.01},
                {"dev": A, "cmd": A_PROG},
                {"wait": B},
                {"dev": A, "cmd": "mem 0x40820000 8192"},
                {"dev": B, "cmd": "mem 0x40820000 8192"},
            ]
        )
        try:
            la, lb = out[4]["lines"][0], out[5]["lines"][0]
            sa, sb = cp.parse_seq(la), cp.parse_seq(lb)
        except Exception:  # noqa: BLE001 - a rebooted DUT / garbled reply
            return {"fail": "parse", "raw": [o.get("lines") for o in out[4:6]]}
        if not (sa["ok"] and sb["ok"]):
            return {"fail": "seq", "A": la[:200], "B": lb[:200]}
        ra, rb = b64_of(out[6]["lines"]), b64_of(out[7]["lines"])
        for _ in range(3):
            if ra is None:
                ra = b64_of(b.cmd(A, "mem 0x40820000 8192"))
            if rb is None:
                rb = b64_of(b.cmd(B, "mem 0x40820000 8192"))
        if ra is None or rb is None:
            return {"fail": "b64"}
        xa = decode_words(ra)[0].astype(complex)
        xb = decode_words(rb)[0].astype(complex)
        aB, aA = self.analyse(xb, self.delta), self.analyse(xa, -self.delta)
        if aB is None or aA is None:
            return {"fail": "onset"}
        self.delta = aB["delta"]
        xA, xB = _abs_c(la, "X"), _abs_c(lb, "X")  # DAC epochs (each burst restarts the DAC)
        yA = _wrapdiff(_abs_c(la, "Y"), xA)
        yB = _wrapdiff(_abs_c(lb, "Y"), xB)
        tA = _wrapdiff(_abs_c(la, "T"), xA)
        tB = _wrapdiff(_abs_c(lb, "T"), xB)
        # arrival of the peer's epoch: capture start + D (+ j TP) nearest the observed onset
        predB = yB + aB["n_on"] / cp.FS - tA
        arrB = yB + aB["D"]
        arrB += TP * np.round((predB - arrB) / TP)
        predA = yA + aA["n_on"] / cp.FS - tB
        arrA = yA + aA["D"]
        arrA += TP * np.round((predA - arrA) / TP)
        Tround = arrA  # A clock, from A's epoch
        Treply = -arrB  # B clock: B's epoch (0) minus the arrival of A's epoch
        two_tau = Tround - Treply - aB["delta"] * Treply
        # A-side epoch-branch slips are exact multiples of TP in A's clock and carry no
        # delta term, so fold them away (B-side branches are reliable: B's onset is clean).
        two_tau = (two_tau + TP / 2) % TP - TP / 2
        dav = 0.5 * (aB["delta"] - aA["delta"])
        IA = yA
        carrier = float(
            np.angle(
                np.exp(1j * (aB["ph"] + aA["ph"] + 2 * np.pi * dav * self.fc * ((arrB - yB) + IA)))
            )
        )
        r = dict(
            fc=self.fc,
            two_tau=float(two_tau),
            carrier=carrier,
            deltaB=aB["delta"],
            deltaA=aA["delta"],
            Tround=float(Tround),
            Treply=float(Treply),
            DB=aB["D"],
            DA=aA["D"],
            onB=aB["n_on"],
            onA=aA["n_on"],
            resB=aB["res"],
            resA=aA["res"],
            snrB=float(np.mean(np.abs(aB["H"]))),
            snrA=float(np.mean(np.abs(aA["H"]))),
        )
        if keep_raw:
            r["HB"], r["HA"], r["xa"], r["xb"] = aB["H"], aA["H"], xa, xb
        return r
