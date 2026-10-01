"""The on-hardware e2e run's phases, and the requirements each one verifies.

hitl_e2e.py records every phase as a JUnit testcase tagged with these PR ids
(rules_requirements' JUnitWriter), which the HITL workflow turns into the
hitl-traceability-report. A run that stops *between* phases (no device URL, a
missing bundle, a rig/tunnel error) must still leave a record, or the report
would show the phases that passed and silently drop the failure:
record_incomplete() adds that record.

@rr(PR-23): on-hardware evidence for the HITL runs, failures included
"""

from __future__ import annotations

from typing import Any

# Phase name -> the PRs it verifies (level hitl).
PHASES: dict[str, list[str]] = {
    # Flash the bundle; the app boots and brings the Improv BLE service up.
    "flash_boot": ["PR-13", "PR-21", "PR-26"],
    # Browser-style provisioning over BLE Improv.
    "improv_provision": ["PR-13", "PR-29"],
    # WS connect (TLS heap) + time sync + rename over the protobuf protocol.
    "websocket_checks": ["PR-13", "PR-22", "PR-35"],
}


def planned(skip_flash: bool, skip_improv: bool, wire_provision: bool, skip_ws: bool) -> list[str]:
    """The phases a run with these options performs, in order.

    Wired (serial) provisioning is a harness convenience, not a provisioning
    flow under test, so it verifies nothing: a failure there is recorded by
    record_incomplete() against the phases that never ran.
    """
    phases = []
    if not skip_flash:
        phases.append("flash_boot")
    if not wire_provision and not skip_improv:
        phases.append("improv_provision")
    if not skip_ws:
        phases.append("websocket_checks")
    return phases


def record_incomplete(
    report: Any, phases: list[str], failure: str, infrastructure: bool = False
) -> None:
    """Record a run that stopped outside every phase, unless a phase already did.

    The failure is filed against the requirements of the planned phases that
    never completed, so they read FAILED rather than verified by the phases that
    happened to pass. Rig or reservation trouble (``infrastructure``) says
    nothing about the device: it is recorded untagged, so the report lists it as
    an untraced failure without failing any requirement.
    """
    if any(case.status in ("failed", "error") for case in report.cases):
        return  # the failing phase recorded it
    if infrastructure:
        report.add("rig", [], "error", failure)
        return
    done = {case.name for case in report.cases}
    pending = sorted({pr for name in phases if name not in done for pr in PHASES[name]})
    report.add("incomplete_run", pending, "failed", failure)
