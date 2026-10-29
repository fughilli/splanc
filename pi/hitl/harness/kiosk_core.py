"""Pure verdict for the kiosk-mode HITL gate (hitl_kiosk.py, docs/design/kiosk-mode.md).

The driver records one `Check` per assertion, grouped by phase. Only the phases
that ran on a reachable, provisioned DUT are graded: the bench (no DUT, flash or
provisioning failure, a reboot that never comes back) is SKIP, never FAIL.
"""

from __future__ import annotations

from dataclasses import dataclass, field

PASS, FAIL, SKIP = "PASS", "FAIL", "SKIP"

# Phases in run order. "setup" failing before kiosk is enabled is a bench/infra
# problem only when the DUT never answered; a setup assertion that ran is graded.
PHASES = ("setup", "enable", "refuse", "visitor", "reboot", "revert", "unlock", "console")

# What every refused op must come back as.
LOCKED = "kiosk_locked"


@dataclass
class Check:
    phase: str
    name: str
    ok: bool
    detail: str = ""


@dataclass
class Run:
    reached: bool = False  # a baseline hello -> welcome on the DUT
    checks: list[Check] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)  # phases skipped for bench reasons

    def check(self, phase: str, name: str, ok: bool, detail: str = "") -> bool:
        self.checks.append(Check(phase, name, bool(ok), detail))
        return bool(ok)

    def skip(self, phase: str, why: str) -> None:
        self.skipped.append(f"{phase}:{why}")


def refused(reply: dict | None) -> bool:
    """A refusal is exactly an error reply with code kiosk_locked."""
    return bool(reply) and reply.get("type") == "error" and reply.get("code") == LOCKED


def uniform(reply: dict, slot: int) -> float | None:
    """One float of get_effect_uniforms' `current` (slot-keyed <= 4-float chunks)."""
    for c in reply.get("current", []) or []:
        base = int(c.get("slot", 0))
        vals = c.get("value", []) or []
        if base <= slot < base + len(vals):
            return float(vals[slot - base])
    return None


def near(a: float | None, b: float, tol: float = 0.02) -> bool:
    return a is not None and abs(a - b) <= tol


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
    return f"RESULT kiosk verdict={verdict(run)} fw={fw} " + " ".join(parts)
