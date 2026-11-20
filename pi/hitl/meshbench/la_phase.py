"""Display phase from the 16-channel logic analyser (docs/design/mesh-hitl-rig.md §8).

The analyser taps WS2812 data lines (one per tapped strip) plus the controller's
SYNC line. Per data channel: edges -> frames (a frame ends at an idle-low longer than
the latch reset) -> the first LEDs' decoded colours -> the meshFlipClock state of
every frame. A frame whose state differs from the previous one is a flip on the wire,
timestamped at the frame's first rising edge (the data starts; the LEDs latch at the
reset after the last bit, a fixed 3 x 30 us later for a 3-LED strip).

The flips feed the same offset fit as the camera (flip_cv.fit_offset), so camera and
analyser skews are directly comparable: their difference is the LED stage (latch,
PWM restart), which only the camera sees.

SYNC toggles on every controller commit, so matching its edges to the controller's
step log maps analyser time onto controller time (and so onto scenario events).
"""

from __future__ import annotations

import dataclasses
import re
from typing import Sequence

import flip_cv as fc
import numpy as np

RESET_US = 50.0  # idle-low that ends a frame (WS2812B latches at >= 50 us; V5 parts 280)
T1_THRESHOLD_US = 0.6  # high pulse longer than this = a 1 bit (T0H 0.4, T1H 0.8)


@dataclasses.dataclass
class Frame:
    t: float  # first rising edge (s, analyser clock)
    t_end: float  # last falling edge
    bits: int
    leds: list  # (g, r, b) per decoded LED

    def state(self, led: int, threshold: int = 127) -> int | None:
        if led >= len(self.leds):
            return None
        return 1 if self.leds[led][0] > threshold else 0


def parse_vcd(text: str) -> tuple[dict, float]:
    """sigrok-cli -O vcd: {channel name: (times_s array, levels array)}, end time."""
    scale = 1e-9
    m = re.search(r"\$timescale\s+(\d+)\s*(s|ms|us|ns|ps)\s+\$end", text)
    if m:
        scale = (
            int(m.group(1)) * {"s": 1, "ms": 1e-3, "us": 1e-6, "ns": 1e-9, "ps": 1e-12}[m.group(2)]
        )
    ids = {}
    for vm in re.finditer(r"\$var\s+\w+\s+1\s+(\S+)\s+(\S+)\s+\$end", text):
        ids[vm.group(1)] = vm.group(2)
    body = text[text.find("$enddefinitions") :]
    t = 0
    ch: dict = {name: ([], []) for name in ids.values()}
    for tok in body.split():
        if tok.startswith("#"):
            t = int(tok[1:])
        elif tok[0] in "01" and tok[1:] in ids:
            ts, lv = ch[ids[tok[1:]]]
            lv_i = int(tok[0])
            if not lv or lv[-1] != lv_i:
                ts.append(t * scale)
                lv.append(lv_i)
    out = {k: (np.asarray(v[0]), np.asarray(v[1], dtype=np.int8)) for k, v in ch.items()}
    return out, t * scale


def frames_from_edges(
    times: np.ndarray, levels: np.ndarray, n_leds: int = 3, reset_us: float = RESET_US
) -> list[Frame]:
    """Group a WS2812 line's level changes into frames and decode the first LEDs."""
    times = np.asarray(times, dtype=np.float64)
    levels = np.asarray(levels)
    rise = times[levels == 1]
    fall = times[levels == 0]
    if rise.size == 0:
        return []
    # pair each rise with the next fall
    k = np.searchsorted(fall, rise, side="right")
    ok = k < fall.size
    rise, high = rise[ok], fall[k[ok]] - rise[ok]
    fall_t = rise + high
    frames = []
    start = 0
    for i in range(1, rise.size + 1):
        if i == rise.size or rise[i] - fall_t[i - 1] > reset_us * 1e-6:
            bits = (high[start:i] > T1_THRESHOLD_US * 1e-6).astype(np.int64)
            leds = []
            for j in range(min(n_leds, bits.size // 24)):
                w = bits[j * 24 : (j + 1) * 24]
                g = int("".join(map(str, w[0:8])), 2)
                r = int("".join(map(str, w[8:16])), 2)
                b = int("".join(map(str, w[16:24])), 2)
                leds.append((g, r, b))
            frames.append(Frame(float(rise[start]), float(fall_t[i - 1]), int(i - start), leds))
            start = i
    return frames


def wire_flips(frames: Sequence[Frame], led: int) -> list[fc.Flip]:
    """State changes of one LED between consecutive frames, at the new frame's start."""
    out = []
    prev = None
    for f in frames:
        s = f.state(led)
        if s is None:
            continue
        if prev is not None and s != prev:
            out.append(fc.Flip(f.t, s == 1, "wire", 0.05e-6, 0))
        prev = s
    return out


def sync_map(
    sync_edges: Sequence[float], ctrl_steps_us: Sequence[int]
) -> tuple[float, float, float]:
    """Fit controller_us = a + b * la_s from SYNC edges matched in order to the
    controller's commit instants (both lists start at the same commit). Returns
    (a, b, rms_us)."""
    n = min(len(sync_edges), len(ctrl_steps_us))
    if n < 2:
        raise ValueError("need at least two SYNC edges")
    x = np.asarray(sync_edges[:n], dtype=np.float64)
    y = np.asarray(ctrl_steps_us[:n], dtype=np.float64)
    b, a = np.polyfit(x, y, 1)
    rms = float(np.sqrt(np.mean((y - (a + b * x)) ** 2)))
    return float(a), float(b), rms


@dataclasses.dataclass
class ChannelPhase:
    name: str
    frames: list
    offsets: list  # fc.Offset per LED


def analyse(channels: dict, pattern=fc.PATTERN, window: tuple[float, float] | None = None) -> dict:
    """channels: {dut name: (times, levels)} of the tapped data lines. Returns per-DUT
    offsets and skews against the first channel, plus frame-start stats."""
    frames = {}
    for name, (t, lv) in channels.items():
        fr = frames_from_edges(t, lv)
        if window:
            fr = [f for f in fr if window[0] <= f.t < window[1]]
        frames[name] = fr
    # one reference instant for every channel: with clock drift an offset is only
    # comparable at the same time
    starts = [f.t for fr in frames.values() for f in fr[:1]] + [
        f.t for fr in frames.values() for f in fr[-1:]
    ]
    t_ref = 0.5 * (min(starts) + max(starts)) if starts else None
    phases = {}
    for name, fr in frames.items():
        offs = [fc.fit_offset(wire_flips(fr, i), led, t_ref) for i, led in enumerate(pattern)]
        phases[name] = ChannelPhase(name, fr, offs)
    names = list(channels)
    ref = names[0]
    skews = {}
    per_flip = {}
    for n in names[1:]:
        try:
            s = fc.skew(
                fc.DutPhase(n, phases[n].offsets), fc.DutPhase(ref, phases[ref].offsets), pattern
            )
        except ValueError:
            s = None
        skews[n] = s
        if s is not None:
            fa = wire_flips(phases[n].frames, 0)
            fb = wire_flips(phases[ref].frames, 0)
            per_flip[n] = fc.per_flip_skews(fa, fb, s, 0.006)
    periods = {}
    for n in names:
        st = np.array([f.t for f in phases[n].frames])
        if st.size > 2:
            d = np.diff(st)
            periods[n] = {"median_ms": float(np.median(d) * 1e3), "max_ms": float(d.max() * 1e3)}
    return {
        "ref": ref,
        "phases": phases,
        "skew_s": skews,
        "per_flip_s": per_flip,
        "frame_period": periods,
    }


# ------------------------------------------------------------ synthetic capture


def synth_wire(
    latch_times: np.ndarray,
    colours: np.ndarray,
    rng=None,
    t_bit: float = 1.25e-6,
    t0h: float = 0.4e-6,
    t1h: float = 0.8e-6,
    sample_rate: float | None = None,
    data_lead: float = 0.0,
) -> tuple[np.ndarray, np.ndarray]:
    """Edges of a WS2812 line: frame k's data starts at latch_times[k] - data_lead and
    carries colours[k] = [(g, r, b) per LED]. Quantised to the analyser's sample rate."""
    ts, lv = [], []
    for t0, leds in zip(latch_times, colours):
        t = t0 - data_lead
        for g, r, b in leds:
            for byte in (g, r, b):
                for k in range(7, -1, -1):
                    hi = t1h if (int(byte) >> k) & 1 else t0h
                    ts += [t, t + hi]
                    lv += [1, 0]
                    t += t_bit
    ts = np.asarray(ts)
    if sample_rate:
        ts = np.ceil(ts * sample_rate) / sample_rate
    return ts, np.asarray(lv, dtype=np.int8)


def to_vcd(channels: dict, sample_rate: float = 10e6) -> str:
    """The sigrok-cli VCD dialect, for tests and for replaying captures."""
    ns = int(round(1e9 / sample_rate))
    syms = {}
    lines = ["$timescale %d ns $end" % ns, "$scope module sigrok $end"]
    for k, name in enumerate(channels):
        sym = chr(33 + k)
        syms[name] = sym
        lines.append(f"$var wire 1 {sym} {name} $end")
    lines += ["$upscope $end", "$enddefinitions $end"]
    ev = []
    for name, (t, lv) in channels.items():
        for ti, li in zip(t, lv):
            ev.append((int(round(ti * sample_rate)), f"{li}{syms[name]}"))
    ev.sort()
    cur = None
    for tk, s in ev:
        if tk != cur:
            lines.append(f"#{tk}")
            cur = tk
        lines.append(s)
    return "\n".join(lines) + "\n"
