"""The on-hardware e2e run's traceability: what a run that stops early reports.

A run that stops between phases must not leave a report of passes only, and
rig trouble must not fail requirements (e2e_phases.record_incomplete). Checked
through rules_requirements' own ingestion and verdicts, as the HITL workflow
uses them.
"""

import os

import pytest
from e2e_phases import PHASES, planned, record_incomplete
from rules_requirements.hooks.junit_writer import JUnitWriter
from rules_requirements.ingest import collect
from rules_requirements.model import parse_documents
from rules_requirements.trace import build_matrix

pytestmark = pytest.mark.requirements("PR-23")

ALL = ["flash_boot", "improv_provision", "websocket_checks"]


def verdicts(report, tmp_path):
    """Requirement verdicts for this run's JUnit, as the HITL report computes them."""
    prs = sorted({pr for reqs in PHASES.values() for pr in reqs})
    model, _ = parse_documents(
        [
            (
                "model.yaml",
                {
                    "config": {"prefixes": {"requirement": "PR"}},
                    "user_needs": [{"id": "UN-1", "title": "n"}],
                    "requirements": [
                        {"id": pr, "title": pr, "satisfies": ["UN-1"], "method": "hitl"}
                        for pr in prs
                    ],
                },
            )
        ]
    )
    path = os.path.join(tmp_path, "test.xml")
    report.write(path)
    matrix = build_matrix(model, collect([path]))
    untraced = [g for g in matrix.gaps if g.kind == "untraced-failure"]
    return {pr: matrix.status(pr) for pr in prs}, untraced


def test_planned_phases_follow_the_options():
    assert planned(False, False, False, False) == ALL
    assert planned(True, True, False, False) == ["websocket_checks"]
    # Wired serial provisioning replaces the BLE Improv phase and verifies nothing itself.
    assert planned(False, False, True, False) == ["flash_boot", "websocket_checks"]
    assert planned(False, False, False, True) == ["flash_boot", "improv_provision"]


def test_a_stop_between_phases_fails_the_phases_that_never_ran(tmp_path):
    report = JUnitWriter("hitl_e2e", default_level="hitl")
    with report.case("flash_boot", PHASES["flash_boot"]):
        pass
    with report.case("improv_provision", PHASES["improv_provision"]):
        pass
    record_incomplete(report, ALL, "HarnessError: no device URL: provision the DUT")
    status, untraced = verdicts(report, tmp_path)
    # The WS phase never ran: its requirements fail, including PR-13, which the
    # passed phases would otherwise have verified on their own.
    assert {pr: status[pr] for pr in PHASES["websocket_checks"]} == {
        pr: "FAILED" for pr in PHASES["websocket_checks"]
    }
    assert status["PR-21"] == status["PR-26"] == status["PR-29"] == "VERIFIED"
    assert not untraced
    assert report.cases[-1].name == "incomplete_run" and "no device URL" in report.cases[-1].message


def test_a_failed_phase_is_not_recorded_twice(tmp_path):
    report = JUnitWriter("hitl_e2e", default_level="hitl")
    with pytest.raises(RuntimeError):
        with report.case("flash_boot", PHASES["flash_boot"]):
            raise RuntimeError("BLE never came up")
    record_incomplete(report, ALL, "HarnessError: BLE never came up")
    assert [c.name for c in report.cases] == ["flash_boot"]
    status, _ = verdicts(report, tmp_path)
    assert status["PR-21"] == "FAILED" and status["PR-22"] == "UNVERIFIED"


def test_rig_trouble_fails_no_requirement_but_is_reported(tmp_path):
    report = JUnitWriter("hitl_e2e", default_level="hitl")
    with report.case("flash_boot", PHASES["flash_boot"]):
        pass
    record_incomplete(report, ALL, "ReserveError: tunnel to the DUT failed", infrastructure=True)
    status, untraced = verdicts(report, tmp_path)
    assert status["PR-21"] == "VERIFIED" and status["PR-22"] == "UNVERIFIED"
    assert "FAILED" not in status.values()
    assert len(untraced) == 1  # listed as an untraced failure, not lost


def test_a_stop_before_any_phase_fails_every_planned_phase(tmp_path):
    report = JUnitWriter("hitl_e2e", default_level="hitl")
    record_incomplete(
        report, ["flash_boot", "websocket_checks"], "HarnessError: no flash-bundle in runfiles"
    )
    status, _ = verdicts(report, tmp_path)
    failed = sorted(pr for pr, s in status.items() if s == "FAILED")
    assert failed == sorted(set(PHASES["flash_boot"]) | set(PHASES["websocket_checks"]))
    assert status["PR-29"] == "UNVERIFIED"  # Improv provisioning was not planned
