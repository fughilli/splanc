"""The BLE live-rename HITL gate's pure logic (harness/ble_rename_core.py)."""

import ble_rename_core as core

BOOT = "ESP-ROM:esp32c6-20220919\nrst:0x15 (USB_UART_HPSYS),boot:0xc (SPI_FAST_FLASH_BOOT)\n"


def fx(n, t0=10.0, f0=600):
    return "".join(
        f"[fx] t={t0 + i:.2f} frame={f0 + 60 * i} update=ok shade_cancelled=0/120\n"
        for i in range(n)
    )


RUNNING = BOOT + fx(3, 0.0, 0) + '[player] renamed to "hitl-rn-ab12-adv"\n' + fx(20)


def name_phase(want, names, seen_s, lead=0.8):
    w = {"ok": seen_s is not None, "seen_s": seen_s, "names": names, "startup_s": 0.5}
    return {"want": want, "watch": w, "lead_s": lead, "on_air_s": core.on_air_s(w, lead)}


ADV_OK = name_phase("new", [[0.1, "old", True], [0.9, "new", True]], 0.9)


def test_on_air_adds_the_lead():
    assert core.on_air_s({"ok": True, "seen_s": 1.2}, 0.75) == 1.95
    assert core.on_air_s({"ok": False, "seen_s": None}, 0.75) is None
    assert core.on_air_s(None, 1.0) is None


def test_name_phase_pass_and_slow_fail():
    assert core.grade_name_phase(ADV_OK, 5.0)[0] == "PASS"
    slow = name_phase("new", [[0.1, "old", True], [6.0, "new", True]], 6.0)
    v, why = core.grade_name_phase(slow, 5.0)
    assert v == "FAIL" and "took" in why


def test_name_never_changes_is_a_fail():
    stuck = name_phase("new", [[0.1, "old", True]], None)
    v, why = core.grade_name_phase(stuck, 5.0)
    assert v == "FAIL" and "never advertised" in why and "'old'" in why


def test_scanner_saw_nothing_is_infra():
    blind = name_phase("new", [], None)
    assert core.grade_name_phase(blind, 5.0)[0] == "SKIP"
    assert core.grade_name_phase({"want": "x", "error": "ssh timeout (scanner hung)"}, 5)[0] == (
        "SKIP"
    )
    assert core.grade_name_phase({"want": "x", "error": "wss rename failed: Boom"}, 5)[0] == "FAIL"


def test_already_on_air_past_the_bound_is_inconclusive():
    # The adapter lock held the scan off for 7 s; the first sighting was already new.
    late = name_phase("new", [[0.1, "new", True]], 0.1, lead=7.0)
    assert core.grade_name_phase(late, 5.0)[0] == "SKIP"


def test_missing_improv_uuid_fails():
    bad = name_phase("new", [[0.1, "old", True], [0.9, "new", False]], 0.9)
    bad["watch"]["ok"] = False  # the watcher only matches Improv-carrying sightings
    bad["on_air_s"] = None
    assert core.grade_name_phase(bad, 5.0)[0] == "FAIL"


def test_conn_needs_the_link_to_survive():
    p = dict(ADV_OK, exchange={"ok": True}, reply_names=["old", "new", "new"])
    assert core.grade_conn(p, 5.0)[0] == "PASS"
    dropped = dict(ADV_OK, exchange={"ok": True}, reply_names=["old", "new"])
    assert core.grade_conn(dropped, 5.0)[0] == "FAIL"
    infra = {"want": "new", "exchange": {"ok": False, "error": "no player device found in scan"}}
    assert core.grade_conn(infra, 5.0)[0] == "SKIP"


def test_long_name_keeps_the_improv_advert():
    shown = name_phase("hitl-rn-ab12-LLLLLLLLLLLLLLLLL", [[0.4, "x" * 29, True]], 0.4)
    assert core.grade_long(shown)[0] == "PASS"
    masked = name_phase("hitl-rn-ab12-L", [[0.2, "hitl-rn-ab12-conn", True]], None)
    v, why = core.grade_long(masked)
    assert v == "PASS" and "cached" in why
    broken = name_phase("hitl-rn-ab12-L", [[0.2, "", False]], None)
    assert core.grade_long(broken)[0] == "FAIL"


def test_running_needs_no_reset_and_advancing_frames():
    assert core.grade_running(RUNNING)[0] == "PASS"
    rebooted = RUNNING + BOOT + fx(6, 0.0, 0)
    v, why = core.grade_running(rebooted)
    assert v == "FAIL" and "reset" in why
    stopped = BOOT + '[player] renamed to "x"\n' + fx(2)
    assert core.grade_running(stopped)[0] == "FAIL"
    assert core.grade_running(BOOT + fx(10))[0] == "SKIP"  # no rename captured


def test_grade_overall():
    conn = dict(ADV_OK, exchange={"ok": True}, reply_names=["a", "new", "new"])
    phases = {
        "adv": ADV_OK,
        "conn": conn,
        "long": ADV_OK,
        "final": ADV_OK,
        "improv": {"ok": True, "url": "http://10.42.0.5/"},
    }
    g = core.grade(phases, RUNNING, 5.0)
    assert g["verdict"] == "PASS", g
    g = core.grade(dict(phases, improv={"ok": False, "error": "improv error 3"}), RUNNING, 5.0)
    assert g["verdict"] == "FAIL" and g["problems"][0].startswith("improv")
    # Infra on the core phase: SKIP, not PASS.
    g = core.grade(dict(phases, adv=name_phase("new", [], None)), RUNNING, 5.0)
    assert g["verdict"] == "SKIP"
