"""Pure logic for the `schedule_fire_netstack` HITL (docs/design/schedule.md): wall-clock
schedule rules fire on time, on a frame boundary, without stalling render; a live-show hold
skips them; a soft reset applies the state in force (D-566). No hardware here; unit-tested
in //pi/hitl/tests:test_schedule_core.

The harness keeps the reference: its own UTC (an NTP-disciplined host). The DUT reports the
wall time of the frame each rule applied on (`schedule_state.last_fired_unix_ms`, and the
`[sched] applied id= at_ms= due_ms= late_ms= unix_ms=` serial line), on its own clock, which
the harness set from its UTC with a time_sync (error = min-RTT/2 + the host's own).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from clock_app_core import frames  # noqa: F401  (re-exported for the harness)

# A rule lands on the first frame at / after its instant: up to one frame late (the
# autoscaler's floor is 25 fps = 40 ms), plus the clock's own error against the harness.
FRAME_MS = 40.0
CLOCK_SLACK_MS = 10.0

_APPLIED = re.compile(
    r"\[sched\] applied id=(\d+) at_ms=(-?\d+) due_ms=(-?\d+) late_ms=(-?\d+) unix_ms=(-?\d+)"
)
_SKIP = re.compile(r"\[sched\] skip id=(\d+) why=(\d+)")


@dataclass
class Applied:
    rule: int
    at_ms: int
    due_ms: int
    late_ms: int
    unix_ms: int


def applied(text: str) -> list[Applied]:
    """Every `[sched] applied` line in the DUT serial log, in order."""
    return [
        Applied(int(m[1]), int(m[2]), int(m[3]), int(m[4]), int(m[5]))
        for m in _APPLIED.finditer(text)
    ]


def skipped(text: str) -> list[tuple[int, int]]:
    """Every `[sched] skip` line: (rule id, ScheduleSkip value)."""
    return [(int(m[1]), int(m[2])) for m in _SKIP.finditer(text)]


def on_time(fired_unix_ms: float, target_unix_ms: float, clock_err_ms: float) -> tuple[bool, str]:
    """A rule applied on the first frame at / after its instant: within one frame after,
    allowing the device clock's error (plus the host's) either way."""
    d = fired_unix_ms - target_unix_ms
    slack = clock_err_ms + CLOCK_SLACK_MS
    ok = -slack <= d <= FRAME_MS + slack
    return ok, f"fired {d:+.0f} ms from its instant (allowed {-slack:.0f}..{FRAME_MS + slack:.0f})"


@dataclass
class Report:
    # (phase, rule id) -> the device's reported fire time (UTC ms); the target instant per phase.
    fired: dict[str, float] = field(default_factory=dict)
    target: dict[str, float] = field(default_factory=dict)
    clock_err_ms: float = 0.0
    fired_count: dict[str, int] = field(default_factory=dict)
    skipped_count: int = 0
    last_skip: str = ""
    after_reset_effect: str = ""
    after_reset_crossfade: float = 0.0
    applied_lines: list[Applied] = field(default_factory=list)
    per_phase: dict[str, dict] = field(default_factory=dict)

    def late_in(self, name: str) -> int:
        return sum(x["n"] for x in self.per_phase.get(name, {}).get("late", []))


GATED = ("fire", "hold", "after_reset")


def verdict(rep: Report) -> tuple[str, list[str]]:
    """PASS: the rules fired on time (on the device clock vs the harness's UTC) and on a
    frame boundary (late_ms 0); the held rule was skipped as LIVE; after the soft reset the
    scheduled effect was back (D-566); render ran with no late frame in each gated phase."""
    why: list[str] = []
    if "fire" not in rep.fired:
        why.append("fire: no rule reported as fired")
    else:
        ok, msg = on_time(rep.fired["fire"], rep.target["fire"], rep.clock_err_ms)
        if not ok:
            why.append(f"fire: {msg}")
    if rep.fired_count.get("fire", 0) < 3:
        why.append(f"fire: {rep.fired_count.get('fire', 0)} of 3 rules applied")
    late = [a for a in rep.applied_lines if a.late_ms > FRAME_MS]
    if late:
        why.append(f"applied late: {[(a.rule, a.late_ms) for a in late]}")
    if rep.skipped_count < 1 or "LIVE" not in rep.last_skip:
        why.append(f"hold: expected a LIVE skip, got {rep.skipped_count} ({rep.last_skip})")
    if rep.after_reset_effect != "__sched_night":
        why.append(
            f"after_reset: showing {rep.after_reset_effect!r}, expected the scheduled effect"
        )
    for name in GATED:
        p = rep.per_phase.get(name)
        if p is None:
            why.append(f"{name}: phase missing")
            continue
        if p["ft"] == 0:
            why.append(f"{name}: no [ft] line: render not running")
        if p["late"]:
            why.append(f"{name}: {rep.late_in(name)} late frame(s)")
    return ("PASS" if not why else "FAIL"), why
