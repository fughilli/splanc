"""The on-hardware e2e run's traceability: what a run that stops early reports.

The rule (e2e_phases): a requirement reads VERIFIED from a run only if every
phase of that run that verifies it passed. Device failures fail the PRs of the
phases that never completed; rig or setup trouble fails none (it shows as an
untraced failure). Checked on e2e_phases directly and by driving hitl_e2e.run()
with a fake rig, through rules_requirements' own ingestion and verdicts, as the
HITL workflow uses them.
"""

import os
import subprocess
from contextlib import contextmanager

import hitl_e2e
import pytest
from e2e_phases import (
    PHASES,
    SetupError,
    is_infrastructure,
    phase,
    planned,
    record_incomplete,
    tracked,
)
from hitl_client import DutUnreachable, ReserveError
from provision import HarnessError
from rules_requirements.hooks.junit_writer import JUnitWriter
from rules_requirements.ingest import collect
from rules_requirements.model import parse_documents
from rules_requirements.trace import build_matrix

pytestmark = pytest.mark.requirements("PR-23")

ALL = ["flash_boot", "improv_provision", "websocket_checks"]
PRS = sorted({pr for reqs in PHASES.values() for pr in reqs})


def verdicts(xml_path):
    """Requirement verdicts for a run's JUnit, as the HITL report computes them."""
    model, _ = parse_documents(
        [
            (
                "model.yaml",
                {
                    "config": {"prefixes": {"requirement": "PR"}},
                    "user_needs": [{"id": "UN-1", "title": "n"}],
                    "requirements": [
                        {"id": pr, "title": pr, "satisfies": ["UN-1"], "method": "hitl"}
                        for pr in PRS
                    ],
                },
            )
        ]
    )
    matrix = build_matrix(model, collect([xml_path]))
    untraced = [g for g in matrix.gaps if g.kind == "untraced-failure"]
    return {pr: matrix.status(pr) for pr in PRS}, len(untraced)


def written(report, tmp_path):
    path = os.path.join(tmp_path, "test.xml")
    report.write(path)
    return verdicts(path)


# --------------------------------------------------------------------------- unit


def test_planned_phases_follow_the_options():
    assert planned(False, False, False, False) == ALL
    assert planned(True, True, False, False) == ["websocket_checks"]
    # Wired serial provisioning replaces the BLE Improv phase and verifies nothing itself.
    assert planned(False, False, True, False) == ["flash_boot", "websocket_checks"]
    assert planned(False, False, False, True) == ["flash_boot", "improv_provision"]


@pytest.mark.parametrize(
    "exc, infrastructure",
    [
        (HarnessError("BLE never came up"), False),
        (DutUnreachable("DUT 10.0.0.5 is unreachable from the rig"), False),
        (KeyError("caps"), False),
        (subprocess.CalledProcessError(2, ["esptool", "write_flash"]), False),
        (ReserveError("tunnel did not come up"), True),
        (SetupError("no WiFi credentials"), True),
        (KeyboardInterrupt(), True),
        (subprocess.CalledProcessError(255, ["scp", "a", "rig:/tmp"]), True),
        (subprocess.CalledProcessError(1, ["scp", "a", "rig:/tmp"]), False),
        # A hung rig and a hung DUT look the same: counted against the device.
        (subprocess.TimeoutExpired(["ssh", "rig", "true"], 30), False),
    ],
)
def test_what_counts_as_rig_trouble(exc, infrastructure):
    assert is_infrastructure(exc) is infrastructure


def test_phases_record_device_failures_but_not_rig_trouble():
    report = JUnitWriter("hitl_e2e", default_level="hitl")
    with phase(report, "flash_boot"):
        pass
    with pytest.raises(HarnessError):
        with phase(report, "improv_provision"):
            raise HarnessError("join timed out")
    with pytest.raises(ReserveError):
        with phase(report, "websocket_checks"):
            raise ReserveError("tunnel did not come up")
    assert [(c.name, c.status, c.requirements) for c in report.cases] == [
        ("flash_boot", "passed", PHASES["flash_boot"]),
        ("improv_provision", "failed", PHASES["improv_provision"]),
    ]


def test_a_device_stop_between_phases_fails_the_phases_that_never_ran(tmp_path):
    report = JUnitWriter("hitl_e2e", default_level="hitl")
    with pytest.raises(HarnessError):
        with tracked(report, ALL):
            with phase(report, "flash_boot"):
                pass
            with phase(report, "improv_provision"):
                pass
            raise HarnessError("no device URL")
    status, untraced = written(report, tmp_path)
    assert status == {"PR-13": "FAILED", "PR-21": "VERIFIED", "PR-22": "FAILED", "PR-26": "VERIFIED",
                      "PR-29": "VERIFIED", "PR-35": "FAILED"}  # fmt: skip
    assert untraced == 0 and report.cases[-1].name == "incomplete_run"


def test_rig_trouble_fails_nothing_and_verifies_only_completed_requirements(tmp_path):
    report = JUnitWriter("hitl_e2e", default_level="hitl")
    with pytest.raises(ReserveError):
        with tracked(report, ALL):
            with phase(report, "flash_boot"):
                pass
            raise ReserveError("tunnel did not come up")
    status, untraced = written(report, tmp_path)
    # PR-13 also needs the phases that never ran: not verified by flash_boot alone.
    assert status == {"PR-13": "UNVERIFIED", "PR-21": "VERIFIED", "PR-22": "UNVERIFIED", "PR-26": "VERIFIED",
                      "PR-29": "UNVERIFIED", "PR-35": "UNVERIFIED"}  # fmt: skip
    assert untraced == 1  # listed, not lost


def test_a_failed_phase_is_not_recorded_twice(tmp_path):
    report = JUnitWriter("hitl_e2e", default_level="hitl")
    with pytest.raises(HarnessError):
        with tracked(report, ALL):
            with phase(report, "flash_boot"):
                raise HarnessError("BLE never came up")
    assert [c.name for c in report.cases] == ["flash_boot"]
    status, _ = written(report, tmp_path)
    assert status["PR-21"] == "FAILED" and status["PR-22"] == "UNVERIFIED"


def test_record_incomplete_before_any_phase(tmp_path):
    report = JUnitWriter("hitl_e2e", default_level="hitl")
    record_incomplete(report, ["flash_boot", "websocket_checks"], "HarnessError: no device URL")
    status, _ = written(report, tmp_path)
    failed = sorted(pr for pr, s in status.items() if s == "FAILED")
    assert failed == sorted(set(PHASES["flash_boot"]) | set(PHASES["websocket_checks"]))
    assert status["PR-29"] == "UNVERIFIED"  # Improv provisioning was not planned


# --------------------------------------------------------------------------- run()


class FakeRig:
    """The parts of hitl_client.Reservation that run() uses."""

    def __init__(
        self,
        xml_path,
        wifi=("rig-ap", "psk"),
        forward_error=None,
        release_error=None,
        acquire_error=None,
        forward_exit_error=None,
    ):
        self.xml_path, self._wifi = xml_path, wifi
        self.forward_error, self.release_error = forward_error, release_error
        self.acquire_error, self.forward_exit_error = acquire_error, forward_exit_error
        self.report_written_before_release = None
        self.acquired = self.released = False

    def acquire(self):
        if self.acquire_error:
            raise self.acquire_error
        self.acquired = True

    def wifi(self):
        return self._wifi

    @contextmanager
    def forward(self, host, port):
        if self.forward_error:
            raise self.forward_error
        yield 40443
        if self.forward_exit_error:
            raise self.forward_exit_error

    def release(self):
        self.released = True
        self.report_written_before_release = os.path.exists(self.xml_path)
        if self.release_error:
            raise self.release_error


@pytest.fixture
def drive(tmp_path, monkeypatch):
    """run() with a fake rig; returns (exit code or exception, verdicts, untraced, cases, rig)."""
    bundle = tmp_path / "esp32c6_netstack_flashbundle.tar"
    bundle.write_bytes(b"firmware")
    xml = str(tmp_path / "test.xml")
    monkeypatch.setenv("XML_OUTPUT_FILE", xml)
    monkeypatch.setattr(hitl_e2e, "default_bundle", lambda: str(bundle))
    monkeypatch.setattr(hitl_e2e, "default_board_caps", lambda: None)
    monkeypatch.setattr(hitl_e2e, "dut_target", lambda redirect, scheme: ("10.0.0.5", 443))

    def go(argv=(), flash=None, provision=None, ws=None, wire=None, **rig_kwargs):
        rig = FakeRig(xml, **rig_kwargs)
        monkeypatch.setattr(hitl_e2e, "Reservation", lambda **_: rig)
        monkeypatch.setattr(hitl_e2e, "flash", flash or (lambda *a: "booted"))
        monkeypatch.setattr(hitl_e2e, "provision_dut", provision or (lambda *a: "http://10.0.0.5"))
        monkeypatch.setattr(hitl_e2e, "ws_checks", ws or (lambda *a: None))
        monkeypatch.setattr(hitl_e2e, "wire_provision_dut", wire or (lambda *a: "http://10.0.0.5"))
        try:
            outcome = hitl_e2e.run(hitl_e2e.parse_args(list(argv)))
        except BaseException as exc:  # noqa: BLE001 — the outcome under test
            outcome = exc
        if not os.path.exists(xml):
            return outcome, None, None, None, rig
        status, untraced = verdicts(xml)
        with open(xml, encoding="utf-8") as fh:
            cases = fh.read()
        return outcome, status, untraced, cases, rig

    return go


def raises(exc):
    def f(*_):
        raise exc

    return f


def test_run_success(drive):
    outcome, status, untraced, cases, rig = drive()
    assert outcome == 0 and set(status.values()) == {"VERIFIED"} and untraced == 0
    assert rig.report_written_before_release
    assert "esp32c6_netstack_flashbundle.tar@sha256:" in cases  # the firmware's content identity


def test_run_dut_unreachable_after_provisioning_is_a_device_failure(drive):
    outcome, status, _, cases, _ = drive(
        forward_error=DutUnreachable("DUT 10.0.0.5 is unreachable")
    )
    assert outcome == 1 and 'name="incomplete_run"' in cases
    assert {pr for pr, s in status.items() if s == "FAILED"} == {"PR-13", "PR-22", "PR-35"}
    assert status["PR-21"] == status["PR-29"] == "VERIFIED"


def test_run_tunnel_trouble_fails_nothing(drive):
    outcome, status, untraced, _, _ = drive(forward_error=ReserveError("tunnel did not come up"))
    assert outcome == 1 and "FAILED" not in status.values() and untraced == 1
    assert status["PR-13"] == "UNVERIFIED" and status["PR-21"] == status["PR-29"] == "VERIFIED"


def test_run_without_wifi_credentials_stops_before_flashing(drive):
    flashed = []
    outcome, status, untraced, _, _ = drive(wifi=None, flash=lambda *a: flashed.append(a))
    assert outcome == 1 and not flashed
    assert set(status.values()) == {"UNVERIFIED"} and untraced == 1


def test_run_device_failure_in_a_phase(drive):
    outcome, status, _, _, _ = drive(provision=raises(HarnessError("join timed out")))
    assert outcome == 1
    assert status["PR-13"] == status["PR-29"] == "FAILED" and status["PR-21"] == "VERIFIED"
    assert status["PR-22"] == "UNVERIFIED"  # never ran, and nothing about it failed


def test_run_rig_transport_error_inside_a_phase(drive):
    outcome, status, untraced, _, _ = drive(
        flash=raises(subprocess.CalledProcessError(255, ["scp", "b", "rig:"]))
    )
    assert isinstance(outcome, subprocess.CalledProcessError)
    assert "FAILED" not in status.values() and untraced == 1


def test_run_interrupted_still_writes_its_report(drive):
    outcome, status, untraced, _, _ = drive(ws=raises(KeyboardInterrupt()))
    assert isinstance(outcome, KeyboardInterrupt)
    assert "FAILED" not in status.values() and untraced == 1 and status["PR-21"] == "VERIFIED"


def test_run_report_survives_a_failing_release(drive):
    outcome, status, _, _, rig = drive(release_error=KeyboardInterrupt())
    assert isinstance(outcome, KeyboardInterrupt) and rig.report_written_before_release
    assert set(status.values()) == {"VERIFIED"}


def test_run_rig_outage_while_reserving_fails_nothing(drive):
    import urllib.error

    outcome, status, untraced, _, _ = drive(
        acquire_error=urllib.error.URLError("connection refused")
    )
    assert isinstance(outcome, urllib.error.URLError)
    assert set(status.values()) == {"UNVERIFIED"} and untraced == 1


def test_run_skip_improv_without_a_url_is_a_setup_mistake(drive):
    outcome, status, untraced, _, rig = drive(["--skip-improv"])
    assert outcome == 1 and not rig.acquired  # caught before reserving a rig
    assert set(status.values()) == {"UNVERIFIED"} and untraced == 1


def test_run_wired_provisioning_with_a_space_in_the_ssid_stops_before_flashing(drive):
    flashed = []
    outcome, status, _, _, _ = drive(
        ["--wire-provision"], wifi=("rig ap", "psk"), flash=lambda *a: flashed.append(a)
    )
    assert outcome == 1 and not flashed and "FAILED" not in status.values()


def test_run_device_hang_counts_against_the_device(drive):
    hang = subprocess.TimeoutExpired(["ssh", "rig", "hitl-flash"], 180)
    outcome, status, _, _, _ = drive(flash=raises(hang))
    assert isinstance(outcome, subprocess.TimeoutExpired)
    assert status["PR-21"] == status["PR-26"] == "FAILED"


def test_run_harness_error_after_every_phase_passed(drive):
    outcome, status, untraced, cases, _ = drive(forward_exit_error=RuntimeError("tunnel cleanup"))
    assert isinstance(outcome, RuntimeError)
    assert set(status.values()) == {"VERIFIED"} and untraced == 1 and 'name="after_phases"' in cases


def test_run_releases_the_rig_even_if_writing_the_report_fails(drive, monkeypatch):
    def broken(*_):
        raise KeyboardInterrupt

    monkeypatch.setattr(hitl_e2e, "_write_report", broken)
    outcome, _, _, _, rig = drive()
    assert isinstance(outcome, KeyboardInterrupt) and rig.released


def test_run_skip_flash_evidence_is_never_current(drive, monkeypatch):
    monkeypatch.setenv("GITHUB_SHA", "abc123")
    _, _, _, cases, _ = drive(["--skip-flash"])
    assert 'value="unknown (not flashed by this run)"' in cases and "abc123" not in cases
    assert "firmware_build_id" not in cases


def test_an_unknown_phase_fails_before_its_work_blaming_no_one():
    report = JUnitWriter("hitl_e2e", default_level="hitl")
    ran = []
    with pytest.raises(SetupError):
        with phase(report, "websocket_check"):
            ran.append(True)
    assert not ran and not report.cases and is_infrastructure(SetupError("x"))


def test_the_reachability_probe_tells_the_rig_from_the_dut():
    from hitl_client import Reservation

    rig = object.__new__(Reservation)
    for code, error in ((7, DutUnreachable), (255, ReserveError), (127, ReserveError)):
        rig.ssh = lambda *a, code=code, **k: subprocess.CompletedProcess([], code, "", "")
        with pytest.raises(error) as exc:
            rig.assert_reachable("10.0.0.5")
        assert (type(exc.value) is DutUnreachable) == (code == 7)

    def hung(*a, **k):
        raise subprocess.TimeoutExpired(["ssh", "rig"], 57)

    rig.ssh = hung
    with pytest.raises(ReserveError) as exc:
        rig.assert_reachable("10.0.0.5")
    assert type(exc.value) is ReserveError and is_infrastructure(exc.value)


@pytest.mark.parametrize(
    "argv, failure",
    [
        # Without the flash phase, the device work starts with wired provisioning...
        (
            ["--skip-flash", "--wire-provision"],
            dict(wire=raises(HarnessError("DUT never acked PROV"))),
        ),
        # ...or with the reachability probe of an already-provisioned DUT.
        (
            ["--skip-flash", "--skip-improv", "--device-url", "http://10.0.0.5"],
            dict(forward_error=DutUnreachable("DUT 10.0.0.5 is unreachable")),
        ),
    ],
)
def test_run_skip_flash_device_failures_still_fail(drive, argv, failure):
    outcome, status, _, cases, _ = drive(argv, **failure)
    assert outcome == 1 and 'name="incomplete_run"' in cases
    assert {pr for pr, s in status.items() if s == "FAILED"} == {"PR-13", "PR-22", "PR-35"}


def test_run_explicit_ssid_with_a_space_is_refused_before_reserving(drive):
    outcome, _, _, _, rig = drive(["--wire-provision", "--wifi-ssid", "my ap"])
    assert outcome == 1 and not rig.acquired


def test_run_missing_bundle_file_is_refused_before_reserving(drive, tmp_path):
    outcome, status, untraced, _, rig = drive(["--bundle", str(tmp_path / "nope.tar")])
    assert outcome == 1 and not rig.acquired
    assert set(status.values()) == {"UNVERIFIED"} and untraced == 1


def test_run_leaves_no_partial_report(drive, tmp_path):
    drive()
    assert not [f for f in os.listdir(tmp_path) if f.endswith(".tmp")]
