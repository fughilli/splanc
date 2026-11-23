"""Pure verdict + helpers for the lamp-power HITL gate (hitl_lamp_power.py,
docs/design/lamp-power.md).

One `Check` per assertion, grouped by phase. Only phases that ran on a reached,
provisioned DUT are graded: the bench (no DUT, flash / provisioning failure, a
reboot that never reconnects) is SKIP, never FAIL.
"""

from __future__ import annotations

from dataclasses import dataclass, field

PASS, FAIL, SKIP = "PASS", "FAIL", "SKIP"

PHASES = ("setup", "power", "transition", "trigger", "reboot", "fps", "driver")

# PowerState.phase / source (ledmapper.proto "Lamp power").
OFF, ON, TURNING_ON, TURNING_OFF = 0, 1, 2, 3
SRC_BOOT, SRC_CLIENT, SRC_TRIGGER = 0, 1, 2


@dataclass
class Check:
    phase: str
    name: str
    ok: bool
    detail: str = ""


@dataclass
class Run:
    reached: bool = False
    checks: list[Check] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)

    def check(self, phase: str, name: str, ok: bool, detail: str = "") -> bool:
        self.checks.append(Check(phase, name, bool(ok), detail))
        return bool(ok)

    def skip(self, phase: str, why: str) -> None:
        self.skipped.append(f"{phase}:{why}")


def phase(st: dict | None) -> int:
    """PowerState.phase of a decoded power_state (proto3 JSON drops 0)."""
    return int((st or {}).get("phase", 0) or 0)


def is_on(st: dict | None) -> bool:
    return bool((st or {}).get("on", False))


def source(st: dict | None) -> int:
    return int((st or {}).get("source", 0) or 0)


def fps_kept(before: float | None, after: float | None, tol: float = 0.1) -> bool:
    """The effect runs at (about) the same rate after the power cycle: within
    `tol` (10%) of the rate before any power change."""
    if not before or not after:
        return False
    return after >= before * (1.0 - tol)


def settle_time_ok(elapsed_s: float, duration_ms: int, slack_s: float = 1.5) -> bool:
    """A transition of `duration_ms` settles no sooner than ~its length and no
    later than its length + `slack_s` (push + loop latency)."""
    d = duration_ms / 1000.0
    return d * 0.8 <= elapsed_s <= d + slack_s


def verdict(run: Run) -> str:
    if not run.reached:
        return SKIP
    if any(not c.ok for c in run.checks):
        return FAIL
    return PASS if run.checks else SKIP


def failures(run: Run) -> list[str]:
    return [f"{c.phase}/{c.name}: {c.detail}" for c in run.checks if not c.ok]


def result_line(run: Run, fw: str | None = None) -> str:
    by_phase: dict[str, list[bool]] = {}
    for c in run.checks:
        by_phase.setdefault(c.phase, []).append(c.ok)
    parts = [f"{p}={sum(v)}/{len(v)}" for p in PHASES if (v := by_phase.get(p)) is not None]
    if run.skipped:
        parts.append("skipped=" + ",".join(run.skipped))
    return f"RESULT lamp_power verdict={verdict(run)} fw={fw} " + " ".join(parts)
