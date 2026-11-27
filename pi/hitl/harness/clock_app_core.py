"""Pure logic for the `clock_app_netstack` HITL (desk D-559 PR B, docs/design/wall-clock.md):
the app-style wall-clock push, the clock surviving a soft reset, and render never stalling
for it. No hardware here; unit-tested in //pi/hitl/tests:test_clock_app_core.

The harness keeps the reference: its own UTC (an NTP-disciplined host), read around each
get_clock, so a reading is bounded by [sent, received] on the harness clock. The DUT serial
log (stamped UTC by the rig) carries `[late] n= max= ago_ms=` (a late frame: see
flash_render_core) and the 1 Hz `[ft]` frame-timing line (render is running).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from flash_render_core import day_seconds, late_frames, stamped

_FT = re.compile(r"\[ft\] ")

# Read phases whose frames must not be late (the clock arms run on the loop task).
GATED = ("sync", "read", "after_restart")
# How far a reading may sit outside the device's own error bound: the harness host's
# own error against UTC (NTP on a LAN host: a few ms).
HOST_ERR_MS = 10.0
# A carried-over time must come back within this (the plan's clock_soft_reset bound).
CARRY_MAX_ERR_MS = 1500.0


def best_sync(samples: list[tuple[float, float, float, float]]) -> tuple[float, float]:
    """(offset_ms, rtt_ms) of the min-RTT time_sync round: samples are (t0, t1, t2, t3) with
    t0/t3 on the harness's monotonic ms clock and t1/t2 the device's ms. offset maps harness
    monotonic ms to device ms."""
    if not samples:
        raise ValueError("no sync samples")
    best = None
    for t0, t1, t2, t3 in samples:
        rtt = (t3 - t0) - (t2 - t1)
        off = ((t1 - t0) + (t2 - t3)) / 2.0
        if best is None or rtt < best[1]:
            best = (off, rtt)
    return best


@dataclass
class Reading:
    """One get_clock: the harness's UTC ms just before sending and just after the reply,
    and what the device said."""

    phase: str
    host_sent_ms: float
    host_recv_ms: float
    valid: bool
    unix_ms: float
    err_ms: float
    source: str

    def delta_ms(self) -> float:
        """How far the device's reading is outside [sent, received] (0 inside)."""
        if self.unix_ms < self.host_sent_ms:
            return self.unix_ms - self.host_sent_ms
        if self.unix_ms > self.host_recv_ms:
            return self.unix_ms - self.host_recv_ms
        return 0.0


def reading_ok(r: Reading) -> tuple[bool, str]:
    """The device's reading lies within its own reported error (plus the harness's) of the
    harness's [sent, received] window."""
    if not r.valid:
        return False, f"{r.phase}: clock not valid"
    d = r.delta_ms()
    if abs(d) > r.err_ms + HOST_ERR_MS:
        return False, f"{r.phase}: off by {d:+.1f} ms, outside its own ±{r.err_ms:.0f} ms"
    return True, ""


@dataclass
class Report:
    readings: list[Reading] = field(default_factory=list)
    set_result: str = ""
    restart_source: str = ""
    per_phase: dict[str, dict] = field(default_factory=dict)

    def late_in(self, name: str) -> int:
        return sum(x["n"] for x in self.per_phase.get(name, {}).get("late", []))


def frames(
    text: str, phases: dict[str, tuple[float, float]], tail_s: float = 1.0
) -> dict[str, dict]:
    """Late frames and `[ft]` lines per phase (UTC epoch spans)."""
    lines = stamped(text)
    late = late_frames(lines)
    ft = [t for t, line in lines if _FT.search(line)]
    out = {}
    for name, (a, b) in phases.items():
        a, b = day_seconds(a), day_seconds(b) + tail_s
        out[name] = {
            "late": [x for x in late if a <= x["t"] <= b],
            "ft": sum(1 for t in ft if a <= t <= b),
            "span_s": b - a,
        }
    return out


def verdict(rep: Report) -> tuple[str, list[str]]:
    """PASS: the push was accepted; every reading in sync/read is within its own error; after
    the soft reset the clock is valid, carried over, within CARRY_MAX_ERR_MS, and within its
    own error; render ran ([ft] lines) with no late frame in each gated phase."""
    why: list[str] = []
    if rep.set_result not in ("CLOCK_SET_RESULT_ACCEPTED", "accepted"):
        why.append(f"set_wall_clock: {rep.set_result or 'no reply'}")
    for phase in ("read", "after_restart"):
        if not any(r.phase == phase for r in rep.readings):
            why.append(f"{phase}: no reading")
    for r in rep.readings:
        ok, msg = reading_ok(r)
        if not ok:
            why.append(msg)
        if r.phase == "after_restart" and abs(r.delta_ms()) > CARRY_MAX_ERR_MS:
            why.append(f"after_restart: off by {r.delta_ms():+.0f} ms (> {CARRY_MAX_ERR_MS:.0f})")
    if rep.restart_source and rep.restart_source not in ("CLOCK_SOURCE_CARRY", "carry"):
        why.append(f"after_restart: source {rep.restart_source}, expected the carry-over")
    for name in GATED:
        p = rep.per_phase.get(name)
        if p is None:
            why.append(f"{name}: no frame data")
            continue
        if p["ft"] == 0:
            why.append(f"{name}: no [ft] line: render not running")
        n = rep.late_in(name)
        if n:
            worst = max(x["max_us"] for x in p["late"])
            why.append(f"{name}: {n} late frame(s), worst {worst} us")
    return ("PASS" if not why else "FAIL"), why
