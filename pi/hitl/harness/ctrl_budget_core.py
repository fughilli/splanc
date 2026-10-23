"""Pure core of the live-control latency budget (docs/design/live-control.md
"Measuring the budget"): parse the rig-side probe's rows (ctrl_budget_probe.py) and the
LM_CTRL_TRACE device dumps they carry, map device time onto the probe's clock, and
attribute every counter value's input-to-photon latency to its stages.

Stages, for a counter value v moved at t_gen (host clock):

  pace       t_send - t_gen       waiting in the client for a send slot (batch in flight,
                                  rate cap); 0 for OSC (one datagram per move)
  uplink     reap - t_send        Wi-Fi + AP + the device's RX ring until loopTask reaped
                                  the frame (``ring`` <= reap - the last empty poll bounds
                                  the ring part)
  decode     decoded - reap       TCP + TLS record decode (until ws_pump ran)
  queue      enter - decoded      other messages of the same record ahead of it
  mutex      locked - enter       waiting for the render task's player_mutex
  handle     handled - locked     the handler itself
  frame_wait fs - handled         until the next frame starts (reads the uniforms)
  render     fe - fs              update() + shade() of that frame
  wire       wd - fe              LED transmit (incl. waiting for the previous transmit)

``apply`` = fs - t_gen (the value is in a frame), ``photon`` = wd - t_gen (on the LEDs).
``gate`` reproduces the HITL gate's metric without its probe: at every sampled instant,
how long the oldest not-yet-handled value had been waiting.

The device clock is esp_timer µs (32-bit); per window it is mapped onto the host's
monotonic µs with an NTP-style min-delay fit over the window's own request/reply pairs
(offset = (min(reap - send) - min(rx - reply)) / 2, i.e. symmetric one-way floors).
"""

from __future__ import annotations

import base64
import dataclasses
import json
import struct
from typing import Optional

STAGES = (
    "pace",
    "uplink",
    "ring",
    "decode",
    "queue",
    "mutex",
    "handle",
    "frame_wait",
    "render",
    "wire",
    "apply",
    "photon",
)

RX_FMT = "<IBBH7I"  # TrRx: idx, kind, flags, len, empty, reap, decoded, enter, locked, handled, reply
FR_FMT = "<5I"  # TrFrame: seq, fs, fe, xs, wd
HDR_FMT = "<8I"


def pct(xs: list[float], p: float) -> float:
    if not xs:
        return float("nan")
    s = sorted(xs)
    i = min(len(s) - 1, max(0, int(round(p / 100.0 * (len(s) - 1)))))
    return s[i]


@dataclasses.dataclass
class RxEntry:
    idx: int
    kind: int
    flags: int
    length: int
    empty: Optional[float]
    reap: Optional[float]
    decoded: Optional[float]
    enter: Optional[float]
    locked: Optional[float]
    handled: Optional[float]
    reply: Optional[float]


@dataclasses.dataclass
class Frame:
    seq: int
    fs: Optional[float]
    fe: Optional[float]
    xs: Optional[float]
    wd: Optional[float]


@dataclasses.dataclass
class Dump:
    """A trace image with device stamps as signed µs relative to the header's now."""

    rx: list[RxEntry]
    frames: list[Frame]
    rx_overrun: bool
    frame_overrun: bool


def decode_dump(img: bytes) -> Dump:
    h = struct.unpack_from(HDR_FMT, img, 0)
    if h[0] != 0x31525443:
        raise ValueError("not a CTR1 trace image")
    now, rx_n, fr_n, n_rx, n_fr, sz_rx, sz_fr = h[1:]
    if sz_rx != struct.calcsize(RX_FMT) or sz_fr != struct.calcsize(FR_FMT):
        raise ValueError(f"trace entry size mismatch ({sz_rx}/{sz_fr})")
    off_rx = struct.calcsize(HDR_FMT)
    off_fr = off_rx + n_rx * sz_rx

    def rel(v: int) -> Optional[float]:
        if v == 0:
            return None
        d = (v - now) & 0xFFFFFFFF
        if d >= 1 << 31:
            d -= 1 << 32
        return float(d)

    def ring(n_total: int, cap: int) -> list[int]:
        if n_total <= cap:
            return list(range(n_total))
        start = n_total % cap
        return [(start + i) % cap for i in range(cap)]

    rx = []
    for i in ring(rx_n, n_rx):
        f = struct.unpack_from(RX_FMT, img, off_rx + i * sz_rx)
        rx.append(RxEntry(f[0], f[1], f[2], f[3], *[rel(v) for v in f[4:]]))
    frames = []
    for i in ring(fr_n, n_fr):
        f = struct.unpack_from(FR_FMT, img, off_fr + i * sz_fr)
        frames.append(Frame(f[0], *[rel(v) for v in f[1:]]))
    frames.sort(key=lambda fr: fr.seq)
    return Dump(rx, frames, rx_n > n_rx, fr_n > n_fr)


@dataclasses.dataclass
class Window:
    k: int
    t0: float
    sent: dict = dataclasses.field(default_factory=dict)  # idx -> (t, kind, seq, counter)
    gen: dict = dataclasses.field(default_factory=dict)  # counter -> t_gen
    osc: dict = dataclasses.field(default_factory=dict)  # counter -> t_send
    replies: list = dataclasses.field(default_factory=list)  # (t, kind, key)
    dump: Optional[Dump] = None
    dump_t: float = 0.0
    events: list = dataclasses.field(default_factory=list)


@dataclasses.dataclass
class Run:
    meta: dict
    windows: list
    end: str


def parse(text: str) -> Run:
    meta: dict = {}
    windows: list[Window] = []
    end = "missing"
    cur: Optional[Window] = None
    for line in text.splitlines():
        p = line.split(" ")
        tag = p[0]
        try:
            if tag == "META":
                meta = json.loads(line[5:])
            elif tag == "W":
                cur = Window(int(p[1]), float(p[2]))
                windows.append(cur)
            elif cur is None:
                if tag == "END":
                    end = " ".join(p[1:])
                continue
            elif tag == "S":
                cur.sent[int(p[1])] = (float(p[2]), p[3], int(p[4]), int(p[5]))
            elif tag == "G":
                cur.gen[int(p[1])] = float(p[2])
            elif tag == "O":
                cur.osc[int(p[1])] = float(p[2])
            elif tag == "R":
                cur.replies.append((float(p[1]), p[2], int(p[3])))
            elif tag == "D":
                cur.dump_t = float(p[2])
                cur.dump = decode_dump(base64.b64decode(p[3]))
            elif tag == "E":
                cur.events.append(line)
            elif tag == "END":
                end = " ".join(p[1:])
        except (ValueError, IndexError, struct.error):
            continue
    return Run(meta, windows, end)


@dataclasses.dataclass
class Fit:
    offset: float  # host = dev - offset (dev relative to the dump header)
    up_floor: float  # min one-way (µs), half the min network RTT
    n: int


def clock_fit(w: Window) -> Optional[Fit]:
    """Map the window's device stamps onto the host clock (see the module docstring)."""
    if w.dump is None:
        return None
    by_idx = {e.idx: e for e in w.dump.rx if e.kind == 1}
    seq_idx = {s[2]: i for i, s in w.sent.items() if s[1] == "u" and s[2]}
    ups, downs = [], []
    for t_rx, kind, key in w.replies:
        idx = seq_idx.get(key) if kind == "a" else key if kind == "p" else None
        e = by_idx.get(idx) if idx is not None else None
        if e is None or e.reply is None:
            continue
        downs.append(t_rx - e.reply)
    for idx, (t_send, _k, _s, _c) in w.sent.items():
        e = by_idx.get(idx)
        if e is not None and e.reap is not None:
            ups.append(e.reap - t_send)
    if not ups or not downs:
        return None
    a, b = min(ups), min(downs)
    return Fit(offset=(a - b) / 2.0, up_floor=(a + b) / 2.0, n=min(len(ups), len(downs)))


@dataclasses.dataclass
class Sample:
    counter: int
    stages: dict  # stage -> µs (None = not measurable)


def _first_frame_after(frames: list[Frame], t: float) -> Optional[Frame]:
    lo, hi = 0, len(frames)
    starts = [f.fs if f.fs is not None else float("-inf") for f in frames]
    while lo < hi:
        mid = (lo + hi) // 2
        if starts[mid] <= t:
            lo = mid + 1
        else:
            hi = mid
    return frames[lo] if lo < len(frames) else None


def _d(a: Optional[float], b: Optional[float]) -> Optional[float]:
    return None if a is None or b is None else a - b


def attribute(w: Window, fit: Fit) -> list[Sample]:
    """Per counter value: the stage breakdown of its trip to the LEDs."""
    if w.dump is None:
        return []
    off = fit.offset
    frames = [f for f in w.dump.frames if f.fs is not None]
    first_fs = frames[0].fs if frames else None
    out: list[Sample] = []

    def tail(e: RxEntry, t_gen: float, t_send: float, pace: float) -> Optional[dict]:
        if e.handled is None or first_fs is None or e.handled < first_fs:
            return None  # handled before the frame ring's coverage starts
        fr = _first_frame_after(frames, e.handled)
        if fr is None:
            return None
        st = {
            "pace": pace,
            "uplink": _d(e.reap, t_send + off),
            "ring": _d(e.reap, e.empty)
            if e.empty is not None and e.reap is not None and e.empty <= e.reap
            else None,
            "decode": _d(e.decoded, e.reap) if e.kind == 1 else None,
            "queue": _d(e.enter, e.decoded) if e.kind == 1 else None,
            "mutex": _d(e.locked, e.enter) if e.kind == 1 else None,
            "handle": _d(e.handled, e.locked if e.kind == 1 else e.enter),
            "frame_wait": _d(fr.fs, e.handled),
            "render": _d(fr.fe, fr.fs),
            "wire": _d(fr.wd, fr.fe),
            "apply": fr.fs - off - t_gen,
            "photon": None if fr.wd is None else fr.wd - off - t_gen,
        }
        return st

    if w.osc:
        by_val = {e.idx: e for e in w.dump.rx if e.kind == 2}
        for v, t_send in sorted(w.osc.items()):
            e = by_val.get(v)
            t_gen = w.gen.get(v, t_send)
            if e is None:
                continue
            st = tail(e, t_gen, t_send, t_send - t_gen)
            if st:
                out.append(Sample(v, st))
        return out

    by_idx = {e.idx: e for e in w.dump.rx if e.kind == 1}
    batches = sorted(
        (s[0], i, s[3]) for i, s in w.sent.items() if s[1] == "u" and s[3] >= 0
    )  # (t_send, idx, counter)
    j = 0
    for v, t_gen in sorted(w.gen.items()):
        while j < len(batches) and batches[j][2] < v:
            j += 1
        if j >= len(batches):
            break
        t_send, idx, _c = batches[j]
        e = by_idx.get(idx)
        if e is None:
            continue
        st = tail(e, t_gen, t_send, t_send - t_gen)
        if st:
            out.append(Sample(v, st))
    return out


def gate_metric(w: Window, fit: Fit, step_us: float = 10000.0) -> list[float]:
    """The gate's "oldest unapplied value's age", sampled every step (no probe needed):
    applied = the newest counter whose message the device has HANDLED."""
    if w.dump is None or not w.gen:
        return []
    off = fit.offset
    handled: list[tuple[float, int]] = []
    if w.osc:
        for e in w.dump.rx:
            if e.kind == 2 and e.handled is not None:
                handled.append((e.handled - off, e.idx))
    else:
        by_idx = {e.idx: e for e in w.dump.rx if e.kind == 1}
        for i, s in w.sent.items():
            e = by_idx.get(i)
            if s[1] == "u" and s[3] >= 0 and e is not None and e.handled is not None:
                handled.append((e.handled - off, s[3]))
    if not handled:
        return []
    handled.sort()
    gens = sorted(w.gen.items())
    t = handled[0][0]
    t_end = handled[-1][0]
    out = []
    hi = 0
    best = 0
    while t < t_end:
        while hi < len(handled) and handled[hi][0] <= t:
            best = max(best, handled[hi][1])
            hi += 1
        nxt = w.gen.get(best + 1)
        out.append(0.0 if nxt is None or nxt >= t else (t - nxt))
        t += step_us
    del gens
    return out


@dataclasses.dataclass
class Budget:
    label: str
    n: int
    stages: dict  # stage -> (p50_ms, p99_ms, mean_ms)
    gate: tuple  # (p50_ms, p99_ms)
    fits: list
    frame_ms: float  # median frame period
    render_ms: float  # median render span
    end: str
    notes: list


def budget(run: Run, label: str = "") -> Budget:
    samples: list[Sample] = []
    gate: list[float] = []
    fits = []
    periods: list[float] = []
    renders: list[float] = []
    notes = []
    for w in run.windows:
        fit = clock_fit(w)
        if fit is None:
            notes.append(f"window {w.k}: no clock fit")
            continue
        fits.append(fit)
        samples += attribute(w, fit)
        gate += gate_metric(w, fit)
        fr = [f for f in w.dump.frames if f.fs is not None]
        periods += [b.fs - a.fs for a, b in zip(fr, fr[1:]) if b.seq == a.seq + 1]
        renders += [f.fe - f.fs for f in fr if f.fe is not None]
        if w.dump.rx_overrun:
            notes.append(f"window {w.k}: rx trace ring wrapped")
        if w.dump.frame_overrun:
            notes.append(f"window {w.k}: frame trace ring wrapped")
        notes += [e for e in w.events if "ack-timeout" in e][:3]
    stages = {}
    for st in STAGES:
        xs = [s.stages[st] / 1000.0 for s in samples if s.stages.get(st) is not None]
        stages[st] = (pct(xs, 50), pct(xs, 99), sum(xs) / len(xs) if xs else float("nan"))
    g = [x / 1000.0 for x in gate]
    return Budget(
        label=label or run.meta.get("label", ""),
        n=len(samples),
        stages=stages,
        gate=(pct(g, 50), pct(g, 99)),
        fits=fits,
        frame_ms=pct(periods, 50) / 1000.0 if periods else float("nan"),
        render_ms=pct(renders, 50) / 1000.0 if renders else float("nan"),
        end=run.end,
        notes=notes,
    )


def table(budgets: list[Budget]) -> str:
    """Markdown: one row per configuration, p50/p99 (ms) per stage."""
    cols = ["pace", "uplink", "ring", "decode", "mutex", "frame_wait", "render", "wire"]
    hdr = (
        "| config | n | frame | "
        + " | ".join(cols)
        + " | **apply** p50/p99 | **photon** p50/p99 | gate p50/p99 |"
    )
    sep = "|" + "---|" * (len(cols) + 6)
    rows = [hdr, sep]
    for b in budgets:

        def c(st):
            p50, p99, _m = b.stages[st]
            return f"{p50:.1f} / {p99:.1f}"

        rows.append(
            f"| {b.label} | {b.n} | {b.frame_ms:.1f} | "
            + " | ".join(c(s) for s in cols)
            + f" | **{c('apply')}** | **{c('photon')}** | {b.gate[0]:.1f} / {b.gate[1]:.1f} |"
        )
    return "\n".join(rows)


def result_line(b: Budget) -> str:
    a50, a99, _ = b.stages["apply"]
    p50, p99, _ = b.stages["photon"]
    return (
        f"RESULT ctrl_budget config={b.label.replace(' ', '_')} n={b.n} "
        f"apply_p50={a50:.1f}ms apply_p99={a99:.1f}ms photon_p50={p50:.1f}ms "
        f"photon_p99={p99:.1f}ms gate_p50={b.gate[0]:.1f}ms gate_p99={b.gate[1]:.1f}ms "
        f"frame={b.frame_ms:.1f}ms end={b.end}"
    )
