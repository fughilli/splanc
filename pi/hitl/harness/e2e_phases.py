"""The on-hardware e2e run's phases, the requirements each one verifies, and how
a run that does not complete is recorded.

hitl_e2e.py records every phase as a JUnit testcase tagged with these PR ids
(rules_requirements' JUnitWriter), which the HITL workflow turns into the
hitl-traceability-report. The rule: a requirement reads VERIFIED from a run
only if every phase of that run that verifies it passed.

- A device failure (a phase's check failing, no device URL after
  provisioning, the DUT unreachable from the rig) fails the requirements of
  the failing phase, or, between phases, of every planned phase that never ran.
  A timeout or a rig tool failing inside a phase counts here too: it cannot be
  told apart from a hung or failing DUT.
- Rig or setup trouble (anything before setup_done(): reserving the rig,
  WiFi credentials, the invocation and bundle; afterwards, reservation and
  tunnel errors, scp's exit 255, the reachability probe failing to reach the
  rig, an operator's Ctrl-C) fails nothing: it is recorded untagged, so the
  report shows it as an untraced failure, and the passed phases stop counting
  toward requirements they share with the phases that never ran. ssh dropping
  during a phase's remote command is indistinguishable from the device
  failing it, and counts against the device.

@rr(PR-23): on-hardware evidence for the HITL runs, failures included
"""

from __future__ import annotations

import os
import subprocess
import time
from contextlib import contextmanager
from typing import Any, Iterator

from hitl_client import DutUnreachable, ReserveError

# Phase name -> the PRs it verifies (level hitl).
PHASES: dict[str, list[str]] = {
    # Flash the bundle; the app boots and brings the Improv BLE service up.
    "flash_boot": ["PR-13", "PR-21", "PR-26"],
    # Browser-style provisioning over BLE Improv.
    "improv_provision": ["PR-13", "PR-29"],
    # WS connect (TLS heap) + time sync + rename over the protobuf protocol.
    "websocket_checks": ["PR-13", "PR-22", "PR-35"],
}


class SetupError(RuntimeError):
    """The run cannot proceed as configured (no bundle, no WiFi credentials):
    nothing about the device."""


def planned(skip_flash: bool, skip_improv: bool, wire_provision: bool, skip_ws: bool) -> list[str]:
    """The phases a run with these options performs, in order.

    Wired (serial) provisioning is a harness convenience, not a provisioning
    flow under test, so it verifies nothing; a failure there is recorded
    against the phases that never ran.
    """
    phases = []
    if not skip_flash:
        phases.append("flash_boot")
    if not wire_provision and not skip_improv:
        phases.append("improv_provision")
    if not skip_ws:
        phases.append("websocket_checks")
    return phases


def is_infrastructure(exc: BaseException) -> bool:
    """Whether ``exc`` is identifiably rig or setup trouble, not the device.

    Anything else counts against the device, conservatively: a timeout or a
    tool failing on the rig cannot be told apart from a hung or failing DUT.
    """
    if isinstance(exc, DutUnreachable):
        return False  # the device did not come up on the rig's network
    if isinstance(exc, (ReserveError, SetupError, KeyboardInterrupt, SystemExit)):
        return True
    if isinstance(exc, subprocess.CalledProcessError):
        cmd = exc.cmd if isinstance(exc.cmd, (list, tuple)) else str(exc.cmd).split()
        tool = os.path.basename(str(cmd[0])) if cmd else ""
        return tool in ("ssh", "scp") and exc.returncode == 255  # ssh's own failure
    return False


_SETUP_DONE = "_e2e_setup_done"  # set on the report when the device work begins


def setup_done(report: Any) -> None:
    """Mark the end of setup (rig reserved, credentials and bundle checked):
    from here on, a stop is the device's unless it is identifiable rig trouble."""
    setattr(report, _SETUP_DONE, True)


@contextmanager
def phase(report: Any, name: str) -> Iterator[None]:
    """Run one phase: a pass or a device failure is recorded against its PRs;
    rig or setup trouble is left to :func:`tracked` (the phase did not run)."""
    if name not in PHASES:  # a harness bug: fails before the work, blaming no one
        raise SetupError(f"unknown e2e phase {name!r}")
    prs = PHASES[name]
    setup_done(report)
    start = time.monotonic()
    try:
        yield
    except BaseException as exc:
        if not is_infrastructure(exc):
            report.add(
                name, prs, "failed", f"{type(exc).__name__}: {exc}", time.monotonic() - start
            )
        raise
    report.add(name, prs, "passed", "", time.monotonic() - start)


@contextmanager
def tracked(report: Any, phases: list[str]) -> Iterator[None]:
    """Wrap a whole run: whatever stops it is recorded (see :func:`record_incomplete`).

    A stop before :func:`setup_done` (reserving the rig, fetching WiFi
    credentials, checking the invocation and the bundle) is setup trouble,
    whatever raised it.
    """
    try:
        yield
    except BaseException as exc:
        infrastructure = is_infrastructure(exc) or not getattr(report, _SETUP_DONE, False)
        record_incomplete(report, phases, f"{type(exc).__name__}: {exc}", infrastructure)
        raise


def record_incomplete(
    report: Any, phases: list[str], failure: str, infrastructure: bool = False
) -> None:
    """Record a run that stopped before completing its planned phases."""
    pending = [name for name in phases if name not in {case.name for case in report.cases}]
    pending_prs = sorted({pr for name in pending for pr in PHASES[name]})
    if infrastructure:
        # Nothing about the device: untagged, so the report lists an untraced
        # failure; and partial passes do not verify requirements whose other
        # phases never ran.
        for case in report.cases:
            case.requirements = [pr for pr in case.requirements if pr not in pending_prs]
        report.add("rig", [], "error", failure)
    elif any(case.status in ("failed", "error") for case in report.cases):
        pass  # the failing phase recorded it
    elif pending_prs:
        # A device failure between phases.
        report.add("incomplete_run", pending_prs, "failed", failure)
    else:
        # Every planned phase had passed (e.g. a wired-provisioning step under
        # --skip-ws, or tunnel cleanup): no requirement is affected, but the stop
        # is listed as an untraced failure.
        report.add("after_phases", [], "error", failure)
