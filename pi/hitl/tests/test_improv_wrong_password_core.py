"""The "a mistyped Wi-Fi password fails fast" HITL gate's pure logic
(harness/improv_wrong_password_core.py): the serial-log parse and the run grading."""

import improv_wrong_password_core as core
from improv import error_name

REJECTED = (
    '[t=9100] [ble] "hitl-rig-1": password rejected (2 sessions, 4630 ms) — Improv '
    "UNABLE_TO_CONNECT\n"
)
ABANDON = "[t=6500] [join] 4-way: M2 refused (M1 re-sent), session 1 rejected\n"
OK = {"ok": True, "join_s": 4.2}
WRONG = {"ok": False, "error": core.WRONG_ERROR, "join_s": 4.8}
TIMEOUT = {"ok": False, "error": core.JOIN_TIMEOUT, "join_s": None}
NO_DEVICE = {"ok": False, "error": "no Improv device found in scan"}


def _serial(n=1, extra=""):
    return core.parse_serial(ABANDON * n + REJECTED * n + extra, ("s3cret-pw",))


def test_provisioner_names_the_reason_byte():
    assert error_name(3) == "unable_to_connect"
    assert error_name(3, 2) == core.WRONG_ERROR
    assert error_name(3, 1) == "unable_to_connect:not_found"
    assert error_name(3, 9) == "unable_to_connect:reason 9"
    assert error_name(1, 2) == "invalid_rpc"  # a reason only qualifies unable_to_connect


def test_parse_counts_reports_and_flags_secrets():
    s = _serial(2)
    assert s["rejected"] == 2 and s["abandoned"] == 2 and s["rejected_ms"] == [4630, 4630]
    assert not s["secret_logged"] and not s["crashed"]
    assert core.parse_serial("PROV hitl-rig-1 s3cret-pw\n", ("s3cret-pw",))["secret_logged"]


def test_fast_report_and_fixed_join_pass():
    g = core.grade(OK, OK, [{"wrong": WRONG, "fixed": OK}], _serial(), 15.0, 20.0)
    assert g == {"verdict": "PASS", "problems": [], "skip": None, "wrong_s": [4.8]}


def test_the_old_firmware_hang_fails():
    g = core.grade(OK, OK, [{"wrong": TIMEOUT, "fixed": OK}], _serial(0), 15.0, 20.0)
    assert g["verdict"] == "FAIL"
    assert g["problems"][0].startswith("wrong#1: no Improv error for the wrong password")


def test_slow_report_generic_error_or_provisioned_fail():
    slow = {**WRONG, "join_s": 31.0}
    g = core.grade(OK, OK, [{"wrong": slow, "fixed": OK}], _serial(), 15.0, 20.0)
    assert g["problems"] == [
        "wrong#1: the password was reported rejected after 31.0s, over the 15s budget"
    ]
    generic = {"ok": False, "error": "unable_to_connect", "join_s": 30.0}
    g = core.grade(OK, OK, [{"wrong": generic, "fixed": OK}], _serial(), 15.0, 20.0)
    assert g["problems"] == [f"wrong#1: want error {core.WRONG_ERROR}, got unable_to_connect"]
    g = core.grade(OK, OK, [{"wrong": OK, "fixed": OK}], _serial(), 15.0, 20.0)
    assert g["problems"] == ["wrong#1: a wrong password PROVISIONED"]


def test_fix_must_provision():
    g = core.grade(OK, OK, [{"wrong": WRONG, "fixed": TIMEOUT}], _serial(), 15.0, 20.0)
    assert g["verdict"] == "FAIL"
    assert g["problems"][0].startswith("fixed#1: the right password did not provision")


def test_serial_must_show_the_report_and_never_the_password():
    g = core.grade(OK, OK, [{"wrong": WRONG, "fixed": OK}], _serial(0), 15.0, 20.0)
    assert g["problems"] == ["serial: 0 password-rejected report(s), want >= 1"]
    leaky = _serial(1, "[wire] PROV hitl-rig-1 s3cret-pw\n")
    g = core.grade(OK, OK, [{"wrong": WRONG, "fixed": OK}], leaky, 15.0, 20.0)
    assert g["problems"] == ["serial: a Wi-Fi password appeared in the DUT log"]


def test_infra_is_skip_not_fail():
    assert core.grade(NO_DEVICE, None, [], None, 15.0, 20.0)["verdict"] == "SKIP"
    g = core.grade(OK, OK, [{"wrong": NO_DEVICE, "fixed": OK}], _serial(0), 15.0, 20.0)
    assert g["verdict"] == "SKIP" and "wrong#1" in g["skip"]
