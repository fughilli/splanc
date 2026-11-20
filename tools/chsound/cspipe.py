"""Channel-sounding pipeline: waveforms, per-tone channel extraction, two-way combination.

Model (docs/research/channel-sounding.md §"Two-way model"): device X transmits a periodic
multitone from its DAC engine (period P samples at 80 MS/s of ITS clock) and the peer captures
it with its dump engine. Every engine trigger is stamped with the CPU cycle counter (160 MHz
of the same crystal). Each device X has one fractional clock error eps_X (LO, DAC, ADC and CPU
all come from one 40 MHz crystal). The relative error delta = eps_A - eps_B is measured from
the carrier offset (CFO = delta * f_c).
"""

from __future__ import annotations

import base64

import numpy as np

FS = 80e6
FCPU = 160e6


def iqword(i: np.ndarray, q: np.ndarray) -> np.ndarray:
    """DAC word: I 9:0, Q 19:10 (signed 10-bit). The playback engine's RF-positive sample is
    I + jQ with I in bits 9:0? — see note in multitone(): we pass (re, im) the way the dump
    engine reads them, (19:10) + j(9:0), and verify the orientation on air (e05/e06)."""
    i = np.clip(np.round(i), -511, 511).astype(np.int32) & 0x3FF
    q = np.clip(np.round(q), -511, 511).astype(np.int32) & 0x3FF
    return (i | (q << 10)).astype(np.uint32)


def multitone(P: int, ks: np.ndarray, peak: float = 300.0, seed: int = 1, swap: bool = True):
    """Periodic multitone with tones at bins ks (k*FS/P), Newman phases. Returns (words, S)
    where S[k] is the complex amplitude of each tone in DAC units (for channel division)."""
    ks = np.asarray(ks)
    m = np.arange(len(ks))
    ph = np.pi * m * m / len(ks)
    X = np.zeros(P, complex)
    X[ks % P] = np.exp(1j * ph)
    x = np.fft.ifft(X) * P
    scale = peak / np.max(np.abs(x))
    x *= scale
    S = np.exp(1j * ph) * scale
    # The dump engine's RF-positive sample is (19:10) + j(9:0); assume the DAC mirrors it, so
    # Re -> bits 19:10, Im -> bits 9:0 when swap=True.
    w = iqword(x.imag, x.real) if swap else iqword(x.real, x.imag)
    return w, S


def upload(bench, dev: str, words: np.ndarray, chunk: int = 96):
    bench.cmd(dev, f"wlen {len(words)}")
    for off in range(0, len(words), chunk):
        b = base64.b64encode(words[off : off + chunk].astype("<u4").tobytes()).decode()
        r = bench.cmd(dev, f"wup {off} {b}")
        assert r and r[0].startswith("WUP"), r


def parse_seq(line: str) -> dict:
    """'SEQ ok=1 t0=.. K10@5150 T0@.. D2048@.. ...' -> {'ok':1, 'stamps':[(op,arg,cyc),...]}"""
    parts = line.split()
    out = {"ok": int(parts[1].split("=")[1]), "stamps": []}
    for p in parts[3:]:
        if "@" not in p:
            continue
        a, c = p.split("@")
        out["stamps"].append((a[0], int(a[1:]), int(c)))
    return out


def stamp(seq: dict, op: str, nth: int = 0) -> int:
    hits = [c for (o, _, c) in seq["stamps"] if o == op]
    return hits[nth]


def tone_phasors(
    x: np.ndarray, ks: np.ndarray, P: int, delta: float, fc: float, n0: int = 0
) -> np.ndarray:
    """Complex amplitude of each tone k at sample n0 of the capture (receiver's clock). The
    transmitter's tone k (k*FS/P on its clock, carrier fc on its clock) lands at
    (fc + k*FS/P) * (1 + delta) - fc on the receiver's clock (delta = eps_tx - eps_rx)."""
    n = np.arange(len(x)) - n0
    f = ((fc + ks * FS / P) * (1 + delta) - fc) / FS
    E = np.exp(-2j * np.pi * np.outer(f, n))
    w = np.hanning(len(x))
    return (E * w) @ x / w.sum()


def refine_delta(x, ks, P, delta0, fc, span=4e-6, iters=3):
    """Refine delta by maximising coherent tone energy (golden-section-ish grid search)."""
    best = delta0
    for _ in range(iters):
        grid = best + np.linspace(-span, span, 21)
        e = [np.sum(np.abs(tone_phasors(x, ks, P, d, fc)) ** 2) for d in grid]
        best = grid[int(np.argmax(e))]
        span /= 8
    return best


def cfo_from_split(x, ks, P, delta, fc):
    """Fine delta from the phase advance between the first and second half of the capture."""
    h = len(x) // 2
    a = tone_phasors(x[:h], ks, P, delta, fc)
    b = tone_phasors(x[h:], ks, P, delta, fc, n0=-h)  # both referenced to sample 0
    # residual frequency per tone; weighted average -> common residual (Hz) at fc
    dphi = np.angle(np.sum(b * np.conj(a)))
    fres = dphi / (2 * np.pi * (h / FS))
    return delta + fres / fc


def group_delay(H: np.ndarray, ks: np.ndarray, P: int, w: np.ndarray | None = None):
    """Least-squares phase slope -> delay (s) and intercept. Unwraps along increasing k."""
    o = np.argsort(ks)
    kk, hh = ks[o], H[o]
    ph = np.unwrap(np.angle(hh))
    fk = kk * FS / P
    ww = np.ones_like(fk) if w is None else w[o]
    A = np.vstack([fk, np.ones_like(fk)]).T * ww[:, None]
    sol, *_ = np.linalg.lstsq(A, ph * ww, rcond=None)
    return -sol[0] / (2 * np.pi), sol[1]


def cir(H: np.ndarray, ks: np.ndarray, P: int, nfft: int = 8192, window=True):
    """Channel impulse response (complex) on a fine time grid from per-tone H (dense ks)."""
    X = np.zeros(nfft, complex)
    w = np.kaiser(len(ks), 6) if window else np.ones(len(ks))
    o = np.argsort(ks)
    X[(ks[o]) % nfft] = H[o] * w
    h = np.fft.ifft(X)
    t = np.arange(nfft) / (nfft * FS / P)  # tone spacing FS/P -> time span P/FS
    return t, h


def tone_phasors_rx(x: np.ndarray, f_bb: np.ndarray, n0: int = 0, chunk: int = 256):
    """Complex amplitude of tones at receiver-clock baseband frequencies f_bb (Hz) at sample
    n0, Hann-weighted (memory-safe chunking)."""
    n = (np.arange(len(x)) - n0).astype(np.float64)
    w = np.hanning(len(x))
    xw = (x * w).astype(np.complex128)
    out = np.empty(len(f_bb), complex)
    for i in range(0, len(f_bb), chunk):
        E = np.exp(-2j * np.pi * np.outer(f_bb[i : i + chunk] / FS, n))
        out[i : i + chunk] = E @ xw
    return out / w.sum()


def rx_freqs(ks: np.ndarray, P: int, delta: float, fc: float):
    """(per-tone baseband frequency at the receiver incl. CFO, the k-dependent part only)."""
    fk = ks * FS / P * (1 + delta)
    cfo = fc * delta
    return fk + cfo, fk


def channel(x, ks, P, S, delta, fc):
    fbb, fk = rx_freqs(ks, P, delta, fc)
    Y = tone_phasors_rx(x, fbb)
    return Y / S, fk


def fine_delta(x, ks, P, S, delta0, fc, span=3e-6, n=13, iters=3):
    """Refine delta (relative clock error tx-rx) by maximising |sum_k H_k|-coherence energy
    of the first vs second half (phase continuity)."""
    best = delta0
    for _ in range(iters):
        grid = best + np.linspace(-span, span, n)
        sc = []
        for d in grid:
            H, _ = channel(x, ks, P, S, d, fc)
            sc.append(np.sum(np.abs(H) ** 2))
        best = grid[int(np.argmax(sc))]
        span /= 6
    return best


def delay_estimate(
    H: np.ndarray, fk: np.ndarray, tp: float, nfft: int = 1 << 15, w: np.ndarray | None = None
):
    """Delay D (s, in [0, tp)) such that H_k ~ |H| exp(-j 2 pi fk D). Coarse: peak of the
    zero-padded IFFT over the (uniform) tone grid; fine: weighted LS phase slope after removing
    the coarse delay. Returns (D, intercept_phase, residual_rms_rad, peak_to_sidelobe)."""
    df = np.median(np.diff(np.sort(fk)))
    idx = np.round((fk - fk.min()) / df).astype(int)
    X = np.zeros(nfft, complex)
    X[idx % nfft] = H
    h = np.fft.ifft(X)
    tgrid = np.arange(nfft) / (nfft * df)
    i = int(np.argmax(np.abs(h)))
    # ifft of X[n] = exp(-j2pi (f0 + n df) D) peaks at t = D (mod 1/df)
    D0 = tgrid[i]
    r = H * np.exp(2j * np.pi * fk * D0)
    ww = np.abs(H) ** 2 if w is None else w
    ph = np.angle(r * np.exp(-1j * np.angle(np.sum(r * ww))))
    A = np.vstack([fk - np.average(fk, weights=ww), np.ones_like(fk)]).T
    sw = np.sqrt(ww)
    sol, *_ = np.linalg.lstsq(A * sw[:, None], ph * sw, rcond=None)
    D = D0 - sol[0] / (2 * np.pi)
    res = ph - A @ sol
    ab = np.abs(h)
    side = np.max(np.r_[ab[: max(i - 40, 0)], ab[i + 40 :]]) if len(ab) > 100 else 0
    return (
        D % tp,
        float(np.angle(np.sum(r * ww))),
        float(np.sqrt(np.average(res**2, weights=ww))),
        float(ab[i] / max(side, 1e-12)),
    )


def comb_onset(x: np.ndarray, P: int, win: int = 256) -> int:
    """Sample index where the periodic comb starts in a capture that begins with the CW
    preamble (or silence). Uses the lag-P self-similarity |sum x[n] x*[n+P]| (high only for
    the periodic comb... and for a CW, so the CW tone is notched out first)."""
    # notch the dominant (CW) tone estimated from the first 1/8 of the capture
    head = x[: max(len(x) // 8, 512)]
    N = len(head)
    F = np.fft.fft(head * np.hanning(N), 8 * N)
    f0 = np.fft.fftfreq(8 * N)[np.argmax(np.abs(F))]
    n = np.arange(len(x))
    y = x * np.exp(-2j * np.pi * f0 * n)
    # remove the (slowly varying) tone: subtract a 64-sample moving average (a narrow LPF)
    k = 64
    y = y - np.convolve(y, np.ones(k) / k, mode="same")
    e = np.abs(y) ** 2
    es = np.convolve(e, np.ones(win) / win, mode="same")
    lo = np.median(es[: len(es) // 10])
    hi = np.median(es[-len(es) // 10 :])
    thr = lo + 0.5 * (hi - lo)
    idx = np.where(es > thr)[0]
    return int(idx[0]) if len(idx) else -1


def device_tones_to_H(
    Xdev: np.ndarray,
    ks: np.ndarray,
    S: np.ndarray,
    delta: float,
    fc: float,
    off: int,
    cfo_used: float,
    N: int = 2048,
    scale: float = 32767 / 64,
):
    """Convert the firmware's `tones` output (an unnormalised 2048-point FFT of one period at
    sample `off`, de-rotated by cfo_used) into the same H the host path computes (complex tone
    amplitude referenced to the capture start, divided by S)."""
    fk = ks * FS / N
    fprime = fk * (1 + delta) + delta * fc  # receiver-clock tone frequency incl. CFO
    eps = (fprime - cfo_used - fk) * N / FS  # residual offset from the bin, in bins
    A0 = Xdev / (N * scale) * np.exp(-2j * np.pi * fprime * off / FS) * np.exp(-1j * np.pi * eps)
    A0 /= np.sinc(eps)
    return A0 / S, fk * (1 + delta)
