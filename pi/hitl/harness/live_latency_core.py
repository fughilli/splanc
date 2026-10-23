"""Pure core of the live-control latency gate (hitl_live_latency.py).

docs/design/live-control.md. The on-hardware driver streams MIDI-like uniform
moves at a netstack C6 running a heavy effect and measures how stale the device's
view of the newest move is. Everything here is pure (no sockets, no clock) so it
unit-tests in //pi/hitl/tests and is the regression guard in a normal
`bazel test //...`:

- :class:`LiveSender` — a Python port of the web client's live-control channel
  (web/src/net/liveSender.ts + liveControl.ts): latest value wins per slot, at
  most one set_uniforms in flight (paced on its ControlAck / legacy reply, with
  an ack deadline), never faster than the device renders. The driver's
  ``--sender live`` is the app's behaviour since the fix; ``--sender naive`` is the
  app before it (one fire-and-forget set_uniforms per CC event).
- :class:`LagTracker` — the probe arithmetic: one control (slot 0) carries a
  counter; a periodic ``get_effect_uniforms`` echo reports which counter value the
  device has applied, and the lag is how long the oldest NOT-yet-applied value has
  been waiting at the moment the device answered.
- :func:`verdict` — the gate: p50 / p99 inside budget AND no growth between the
  first and the last minute. A run that never got a baseline is SKIP, not FAIL.
"""

from __future__ import annotations

import dataclasses
from typing import Callable, Optional

PASS = "pass"
FAIL = "fail"
SKIP = "skip"

# Lag budgets over the base round trip (the tunnel from the harness host to the
# rig adds its own RTT, so budgets are relative to a measured baseline).
P50_BUDGET_MS = 150.0
P99_BUDGET_MS = 600.0
# "Doesn't grow over time": the last minute's p50 may exceed the first minute's
# by at most this much (absolute) or GROWTH_RATIO x (whichever is larger).
GROWTH_ABS_MS = 60.0
GROWTH_RATIO = 1.5
# Fewer probe samples than this in a window = the window can't be judged.
MIN_SAMPLES = 20


def pct(xs: list[float], p: float) -> float:
    """Nearest-rank percentile (p in 0..100); 0.0 for an empty list."""
    if not xs:
        return 0.0
    s = sorted(xs)
    i = min(len(s) - 1, max(0, int(round(p / 100.0 * (len(s) - 1)))))
    return s[i]


class LiveSender:
    """Latest-wins, bounded-in-flight sender for set_uniforms (the app's live channel,
    web/src/net/liveControl.ts).

    The caller owns the clock and the socket: ``push`` / ``on_reply`` / ``poll``
    return the frames (flat dicts) to put on the wire now. ``acks`` selects the
    firmware's ControlAck (seq) or the legacy playback_state pacing (always one in
    flight). ``max_inflight`` seq'd batches may be unacknowledged at once (the app
    uses 1). ``ack_timeout_s=None`` is the app's adaptive
    timeout: 3x the median round trip of answered batches, 25..400 ms.
    """

    MIN_ACK_S = 0.025
    MAX_ACK_S = 0.4

    def __init__(
        self,
        acks: bool,
        commit_ok: bool = True,
        min_interval_s: float = 0.025,
        ack_timeout_s: Optional[float] = 0.4,
        max_inflight: int = 1,
    ):
        self.acks = acks
        self.commit_ok = commit_ok
        self.min_interval_s = min_interval_s
        self.fixed_ack_s = ack_timeout_s
        self.max_inflight = max(1, max_inflight) if acks else 1
        self.pending: dict[int, list[float]] = {}
        self.inflight: dict[int, float] = {}  # seq (or -1 for a legacy send) -> sent at
        self.sent_at = float("-inf")
        self.seq = 0
        self.rtts: list[float] = []
        self.stats = {"pushes": 0, "batches": 0, "coalesced": 0, "timeouts": 0}

    @property
    def in_flight(self) -> Optional[int]:
        """The oldest unacknowledged batch's seq (None: none)."""
        return next(iter(self.inflight), None)

    @property
    def ack_timeout_s(self) -> float:
        if self.fixed_ack_s is not None:
            return self.fixed_ack_s
        if len(self.rtts) < 5:
            return self.MAX_ACK_S
        med = sorted(self.rtts)[len(self.rtts) // 2]
        return min(self.MAX_ACK_S, max(self.MIN_ACK_S, 3.0 * med))

    def push(self, now: float, slot: int, value: list[float]) -> list[dict]:
        self.stats["pushes"] += 1
        if slot in self.pending:
            self.stats["coalesced"] += 1
        self.pending[slot] = list(value)
        return self.poll(now)

    def _answered(self, now: float, key: int) -> None:
        sent = self.inflight.pop(key)
        self.rtts.append(now - sent)
        del self.rtts[:-32]

    def on_reply(self, now: float, msg: dict) -> list[dict]:
        """Feed a server message; releases the batch it acknowledges."""
        t = msg.get("type")
        if self.acks and t == "control_ack" and int(msg.get("seq", 0)) in self.inflight:
            self._answered(now, int(msg.get("seq", 0)))
        elif not self.acks and t == "playback_state" and -1 in self.inflight:
            self._answered(now, -1)
        return self.poll(now)

    def next_wake(self) -> Optional[float]:
        """When ``poll`` may next have something to do (None: nothing pending)."""
        cands = []
        if self.inflight:
            cands.append(min(self.inflight.values()) + self.ack_timeout_s)
        if self.pending and len(self.inflight) < self.max_inflight:
            cands.append(self.sent_at + self.min_interval_s)
        return min(cands) if cands else None

    def poll(self, now: float) -> list[dict]:
        to = self.ack_timeout_s
        for k in [k for k, ts in self.inflight.items() if now - ts >= to]:
            del self.inflight[k]
            self.stats["timeouts"] += 1
        if len(self.inflight) >= self.max_inflight:
            return []
        if not self.pending or now - self.sent_at < self.min_interval_s:
            return []
        msg: dict = {
            "type": "set_uniforms",
            "values": [{"slot": s, "value": v} for s, v in self.pending.items()],
        }
        if self.commit_ok:
            msg["commit"] = False
        if self.acks:
            self.seq = self.seq % 0x7FFFFFFF + 1
            msg["seq"] = self.seq
            self.inflight[self.seq] = now
        else:
            self.inflight[-1] = now
        self.pending = {}
        self.sent_at = now
        self.stats["batches"] += 1
        return [msg]


@dataclasses.dataclass
class Sample:
    t: float  # when the probe reply arrived (s, driver clock)
    lag_ms: float
    rtt_ms: float  # the probe's own round trip
    applied: int  # the counter value the device reported


class LagTracker:
    """Input-to-applied lag from counter echoes (see the module docstring)."""

    def __init__(self) -> None:
        self.gen_at: dict[int, float] = {}
        self.samples: list[Sample] = []

    def generated(self, value: int, t: float) -> None:
        """The counter (slot 0) moved to `value` at time `t` (the INTENDED time)."""
        self.gen_at[value] = t

    def echo(self, t_query: float, t_reply: float, applied: int) -> Sample:
        """A probe sent at t_query, answered at t_reply, reported `applied`.

        The device processed the probe around the midpoint; any counter value
        generated before then should have been applied. The lag is how long the
        first value it had NOT applied had been waiting by then (0 when it was
        up to date)."""
        t_dev = (t_query + t_reply) / 2.0
        nxt = self.gen_at.get(applied + 1)
        lag = 0.0 if nxt is None or nxt >= t_dev else (t_dev - nxt) * 1000.0
        s = Sample(t=t_reply, lag_ms=lag, rtt_ms=(t_reply - t_query) * 1000.0, applied=applied)
        self.samples.append(s)
        return s

    def window(self, t0: float, t1: float) -> list[float]:
        return [s.lag_ms for s in self.samples if t0 <= s.t < t1]


@dataclasses.dataclass
class Stats:
    n: int
    p50: float
    p99: float
    max: float

    @staticmethod
    def of(xs: list[float]) -> "Stats":
        return Stats(len(xs), pct(xs, 50), pct(xs, 99), max(xs) if xs else 0.0)

    def fmt(self) -> str:
        return f"n={self.n} p50={self.p50:.0f}ms p99={self.p99:.0f}ms max={self.max:.0f}ms"


def verdict(
    baseline_ok: bool,
    first: list[float],
    last: list[float],
    overall: list[float],
    base_rtt_ms: float,
    probe_timeouts: int = 0,
) -> tuple[str, list[str]]:
    """The gate. SKIP without a baseline or with too few samples to judge (the
    bench, not the firmware); FAIL when the lag is over budget or grows between
    the first and the last minute.

    A backlogged device starves the probe itself (each echo waits behind the
    queue), so few samples are NOT automatically a SKIP: a probe that timed out,
    or the samples there are already over budget, is the symptom — FAIL."""
    if not baseline_ok:
        return SKIP, ["no baseline (device never answered before the stream)"]
    allow50 = base_rtt_ms + P50_BUDGET_MS
    allow99 = base_rtt_ms * 2 + P99_BUDGET_MS
    o = Stats.of(overall)
    if len(first) < MIN_SAMPLES or len(last) < MIN_SAMPLES:
        starved = []
        if probe_timeouts:
            starved.append(f"{probe_timeouts} probe echo(es) timed out behind the backlog")
        if overall and o.p50 > allow50:
            starved.append(f"p50 {o.p50:.0f}ms > {allow50:.0f}ms over {o.n} starved samples")
        if len(first) >= MIN_SAMPLES and len(last) < MIN_SAMPLES:
            starved.append(f"probe echoes starved in the last window ({len(last)} < {MIN_SAMPLES})")
        if starved:
            return FAIL, starved
        return SKIP, [f"too few probe samples (first={len(first)}, last={len(last)})"]
    reasons = []
    if probe_timeouts:
        reasons.append(f"{probe_timeouts} probe echo(es) timed out")
    if o.p50 > allow50:
        reasons.append(f"p50 {o.p50:.0f}ms > {allow50:.0f}ms")
    if o.p99 > allow99:
        reasons.append(f"p99 {o.p99:.0f}ms > {allow99:.0f}ms")
    f50, l50 = pct(first, 50), pct(last, 50)
    grow = max(GROWTH_ABS_MS, f50 * (GROWTH_RATIO - 1.0))
    if l50 > f50 + grow:
        reasons.append(f"lag grows: last-minute p50 {l50:.0f}ms > first {f50:.0f}ms + {grow:.0f}ms")
    return (FAIL if reasons else PASS), reasons


def result_line(
    status: str, sender: str, first: Stats, last: Stats, overall: Stats, extra: str = ""
) -> str:
    return (
        f"RESULT live_latency verdict={status.upper()} sender={sender} "
        f"all[{overall.fmt()}] first[{first.fmt()}] last[{last.fmt()}]"
        + (f" {extra}" if extra else "")
    )


def midi_schedule(controls: int, hz: float) -> Callable[[int], tuple[float, int]]:
    """Event k of a round-robin MIDI-like stream: (time offset s, slot). `controls`
    knobs each moving at `hz`, interleaved evenly."""
    period = 1.0 / (hz * controls)

    def at(k: int) -> tuple[float, int]:
        return k * period, k % controls

    return at


# -- on-LAN gate (the default path) --------------------------------------------
# The rig-side probe (ctrl_budget_probe.py --gate) runs the app's live channel inside
# the reservation, straight to the DUT over the rig AP, and echoes slot 0 with
# get_effect_uniforms every 250 ms. Budgets are relative to the effect's measured frame
# period (a value can only land at a frame boundary) with headroom for a shared rig AP:
# docs/design/live-control.md "Measuring the budget" has what they were derived from.
LAN_P50_FRAMES = 1.0
LAN_P50_MS = 50.0
LAN_P99_FRAMES = 3.0
LAN_P99_MS = 120.0


def parse_gate_rows(text: str, probe_timeout_s: float = 15.0) -> tuple[LagTracker, dict]:
    """The probe's G (counter moved) and P (echo) rows -> a LagTracker (seconds, rig
    clock) plus counts. A P row with applied -2 is a probe that timed out."""
    tr = LagTracker()
    info = {"end": "missing", "features": [], "probe_timeouts": 0, "errors": []}
    for line in text.splitlines():
        p = line.split(" ")
        try:
            if p[0] == "G":
                tr.generated(int(p[1]), float(p[2]) / 1e6)
            elif p[0] == "P":
                tq, trp, ap = float(p[1]) / 1e6, float(p[2]) / 1e6, int(p[3])
                if ap == -2:
                    info["probe_timeouts"] += 1
                    tr.samples.append(Sample(trp, probe_timeout_s * 1000.0, (trp - tq) * 1000, -1))
                elif ap >= 0:
                    tr.echo(tq, trp, ap)
            elif p[0] == "F":
                info["features"] = [f for f in (p[1] if len(p) > 1 else "").split(",") if f]
            elif p[0] == "END":
                info["end"] = " ".join(p[1:])
            elif p[0] == "E" and "device-error" in line:
                info["errors"].append(line)
        except (ValueError, IndexError):
            continue
    return tr, info


def verdict_lan(
    first: list[float],
    last: list[float],
    overall: list[float],
    frame_ms: float,
    probe_timeouts: int = 0,
) -> tuple[str, list[str]]:
    """The on-LAN gate: the tunnel's RTT is gone, so the budgets scale with the frame.
    Same SKIP/FAIL shape as `verdict` (a starved probe is the backlog: FAIL)."""
    allow50 = LAN_P50_FRAMES * frame_ms + LAN_P50_MS
    allow99 = LAN_P99_FRAMES * frame_ms + LAN_P99_MS
    o = Stats.of(overall)
    if len(first) < MIN_SAMPLES or len(last) < MIN_SAMPLES:
        if probe_timeouts or (overall and o.p50 > allow50):
            return FAIL, [
                f"probe starved ({probe_timeouts} timeouts, p50 {o.p50:.0f}ms over {o.n} samples)"
            ]
        return SKIP, [f"too few probe samples (first={len(first)}, last={len(last)})"]
    reasons = []
    if probe_timeouts:
        reasons.append(f"{probe_timeouts} probe echo(es) timed out")
    if o.p50 > allow50:
        reasons.append(f"p50 {o.p50:.0f}ms > {allow50:.0f}ms (frame {frame_ms:.0f}ms)")
    if o.p99 > allow99:
        reasons.append(f"p99 {o.p99:.0f}ms > {allow99:.0f}ms (frame {frame_ms:.0f}ms)")
    f50, l50 = pct(first, 50), pct(last, 50)
    grow = max(GROWTH_ABS_MS, f50 * (GROWTH_RATIO - 1.0))
    if l50 > f50 + grow:
        reasons.append(f"lag grows: last-minute p50 {l50:.0f}ms > first {f50:.0f}ms + {grow:.0f}ms")
    return (FAIL if reasons else PASS), reasons
