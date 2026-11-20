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
FELL = {"ok": False, "error": core.FELL_BACK_ERROR, "join_s": 5.1}
TIMEOUT = {"ok": False, "error": core.JOIN_TIMEOUT, "join_s": None}
NO_DEVICE = {"ok": False, "error": "no Improv device found in scan"}


def _fallback(t, lease_after_ms=4200, redirect=False):
    out = f'[t={t}] [wifi] password for "hitl-rig-1" rejected -> back to "hitl-rig-1"\n'
    if redirect:
        out += f"[t={t + 100}] [ble] PROVISIONED -> redirect http://10.42.0.5/ (retrying)\n"
    if lease_after_ms is not None:
        out += f"[t={t + lease_after_ms}] *** DHCP LEASE ACQUIRED — IP 10.42.0.5 over heapless\n"
    return out


def _serial(n=1, extra="", fallbacks=None):
    fb = "".join(_fallback(20000 * (k + 1)) for k in range(n)) if fallbacks is None else fallbacks
    return core.parse_serial(ABANDON * n + REJECTED * n + fb + extra, ("s3cret-pw",))


def _grade(rounds, serial, fresh=None):
    return core.grade(OK, OK, rounds, serial, 15.0, 20.0, fresh=fresh, fallback_budget_s=20.0)


def test_provisioner_names_the_reason_byte():
    assert error_name(3) == "unable_to_connect"
    assert error_name(3, 2) == core.WRONG_ERROR
    assert error_name(3, 3) == core.FELL_BACK_ERROR
    assert error_name(3, 1) == "unable_to_connect:not_found"
    assert error_name(3, 9) == "unable_to_connect:reason 9"
    assert error_name(1, 2) == "invalid_rpc"  # a reason only qualifies unable_to_connect


def test_parse_counts_reports_fallbacks_and_flags_secrets():
    s = _serial(2)
    assert s["rejected"] == 2 and s["abandoned"] == 2 and s["rejected_ms"] == [4630, 4630]
    assert s["fallback_ms"] == [4200, 4200] and s["fallback_redirects"] == 0
    assert not s["secret_logged"] and not s["crashed"]
    assert core.parse_serial("PROV hitl-rig-1 s3cret-pw\n", ("s3cret-pw",))["secret_logged"]
    # A fallback with no lease before the next SendWifi: None.
    take = "[t=30000] [ble] wifi-settings received (ssid=hitl-rig-1) -> fresh join\n"
    late = "[t=31000] *** DHCP LEASE ACQUIRED — IP 10.42.0.5\n"
    assert core.fallbacks(_fallback(20000, None) + take + late)["fallback_ms"] == [None]


def test_fast_report_fallback_and_fixed_join_pass():
    # Two reports in the log (fresh + wrong#1), one fallback (the fresh board had none).
    g = _grade([{"wrong": FELL, "fixed": OK}], _serial(2, fallbacks=_fallback(20000)), fresh=WRONG)
    assert g == {"verdict": "PASS", "problems": [], "skip": None, "wrong_s": [4.8, 5.1]}


def test_fresh_board_must_not_claim_a_fallback_and_a_joined_one_must():
    g = _grade([{"wrong": FELL, "fixed": OK}], _serial(2, fallbacks=_fallback(20000)), fresh=FELL)
    assert g["problems"] == [f"fresh: want error {core.WRONG_ERROR}, got {core.FELL_BACK_ERROR}"]
    g = _grade([{"wrong": WRONG, "fixed": OK}], _serial())
    assert g["problems"] == [f"wrong#1: want error {core.FELL_BACK_ERROR}, got {core.WRONG_ERROR}"]


def test_fallback_must_lease_in_time_without_a_redirect():
    rounds = [{"wrong": FELL, "fixed": OK}]
    g = _grade(rounds, _serial(fallbacks=""))
    assert g["problems"] == ["serial: 0 fallback(s) to the previous network, want 1"]
    g = _grade(rounds, _serial(fallbacks=_fallback(20000, 25000)))
    assert g["problems"] == ["serial: fallback 1 leased after 25.0s, over the 20s budget"]
    g = _grade(rounds, _serial(fallbacks=_fallback(20000, None)))
    assert g["problems"] == ["serial: fallback 1 never leased on the previous network"]
    g = _grade(rounds, _serial(fallbacks=_fallback(20000, redirect=True)))
    assert g["verdict"] == "FAIL" and "redirect" in g["problems"][0]


def test_the_old_firmware_hang_fails():
    g = _grade([{"wrong": TIMEOUT, "fixed": OK}], _serial(0))
    assert g["verdict"] == "FAIL"
    assert g["problems"][0].startswith("wrong#1: no Improv error for the wrong password")


def test_slow_report_or_provisioned_fail():
    slow = {**FELL, "join_s": 31.0}
    g = _grade([{"wrong": slow, "fixed": OK}], _serial())
    assert g["problems"] == [
        "wrong#1: the password was reported rejected after 31.0s, over the 15s budget"
    ]
    g = _grade([{"wrong": OK, "fixed": OK}], _serial())
    assert g["problems"][0] == "wrong#1: a wrong password PROVISIONED"


def test_fix_must_provision():
    g = _grade([{"wrong": FELL, "fixed": TIMEOUT}], _serial())
    assert g["verdict"] == "FAIL"
    assert g["problems"][0].startswith("fixed#1: the right password did not provision")


def test_serial_must_show_the_report_and_never_the_password():
    g = _grade([{"wrong": FELL, "fixed": OK}], _serial(0, fallbacks=_fallback(20000)))
    assert g["problems"] == ["serial: 0 password-rejected report(s), want >= 1"]
    g = _grade([{"wrong": FELL, "fixed": OK}], _serial(1, "[wire] PROV hitl-rig-1 s3cret-pw\n"))
    assert g["problems"] == ["serial: a Wi-Fi password appeared in the DUT log"]


def test_infra_is_skip_not_fail():
    assert core.grade(NO_DEVICE, None, [], None, 15.0, 20.0)["verdict"] == "SKIP"
    g = _grade([{"wrong": NO_DEVICE, "fixed": OK}], _serial(0, fallbacks=""))
    assert g["verdict"] == "SKIP" and "wrong#1" in g["skip"]
