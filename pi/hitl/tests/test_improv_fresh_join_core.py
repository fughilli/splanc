"""The "an Improv join is always fresh" HITL gate's pure logic
(harness/improv_fresh_join_core.py): the serial-log parse and the run grading."""

import improv_fresh_join_core as core

BOOT = "rst:0x15 (USB_UART_HPSYS),boot:0xc (SPI_FAST_FLASH_BOOT)\n"
LEASE = "[t=6012] *** DHCP LEASE ACQUIRED — IP 10.42.0.221 over heapless WiFi ***\n"
REDIRECT = (
    "[t=6100] [ble] PROVISIONED -> redirect http://10.42.0.221/ (retrying until central acks)\n"
)
SETUP = (
    BOOT + "[t=3000] [ble] wifi-settings received (ssid=hitl-rig-1) -> fresh join: scan now, "
    "associating + PROVISIONING\n" + LEASE + REDIRECT
)
FRESH_SAME = (
    "[t=9000] [ble] wifi-settings received (ssid=hitl-rig-1, same as committed) -> fresh "
    "join: link dropped, scan now, associating + PROVISIONING\n" + LEASE + REDIRECT
)
RIDE = (
    "[t=9900] [ble] wifi-settings re-received (ssid=hitl-rig-1) — riding the fresh join "
    "started 900 ms ago (leased: re-answering redirect)\n" + REDIRECT
)
# The pre-fix firmware's short-circuits.
OLD_JOINING = (
    "[t=4000] [ble] wifi-settings received (ssid=hitl-rig-1) — already joining that "
    "network, PROVISIONING\n"
)
OLD_JOINED = (
    "[t=9000] [ble] wifi-settings re-received (ssid=hitl-rig-1) — already associated, "
    "re-answering redirect (link kept)\n"
)

OK = {"ok": True, "url": "http://10.42.0.221/"}
TIMEOUT = {"ok": False, "error": "ImprovBLE provisioning failed: " + core.JOIN_TIMEOUT}
NO_DEVICE = {"ok": False, "error": "ImprovBLE provisioning failed: no Improv device found in scan"}


def _all(r):
    return {n: r for n in core.PHASES}


def test_parse_counts_fresh_ride_and_old_lines():
    s = core.parse_serial(SETUP + FRESH_SAME + FRESH_SAME + RIDE)
    assert s["fresh"] == 3 and s["fresh_same"] == 2 and s["ride"] == 1
    assert s["old_keep"] == 0 and s["redirects"] == 4 and not s["crashed"]
    old = core.parse_serial(SETUP + OLD_JOINING + OLD_JOINED)
    assert old["old_keep"] == 2 and old["fresh_same"] == 0


def test_fixed_firmware_passes():
    s = core.parse_serial(SETUP + FRESH_SAME + FRESH_SAME + RIDE)
    g = core.grade(OK, _all(OK), s, 20.0)
    assert g["verdict"] == "PASS", g


def test_old_short_circuit_fails_even_when_the_join_was_quick():
    # On the rig the AP is always there, so the stored join usually finishes in time
    # anyway: the serial decision is what catches the old firmware.
    s = core.parse_serial(SETUP + OLD_JOINING + OLD_JOINED + OLD_JOINED)
    g = core.grade(OK, _all(OK), s, 20.0)
    assert g["verdict"] == "FAIL"
    assert any("short-circuit" in p for p in g["problems"])
    assert any("fresh join(s)" in p for p in g["problems"])


def test_join_timeout_fails():
    s = core.parse_serial(SETUP + FRESH_SAME + FRESH_SAME)
    g = core.grade(OK, {"stored": TIMEOUT, "joined": OK, "resend": OK}, s, 20.0)
    assert g["verdict"] == "FAIL"
    assert g["problems"] == ["stored: no PROVISIONED/redirect within the 20s budget"]


def test_over_budget_join_fails():
    s = core.parse_serial(SETUP + FRESH_SAME + FRESH_SAME)
    slow = {**OK, "join_s": 31.0}
    g = core.grade(OK, {"stored": OK, "joined": slow, "resend": OK}, s, 20.0)
    assert g["verdict"] == "FAIL"


def test_setup_or_ble_infra_is_skip():
    assert core.grade(None, _all(None), None, 20.0)["verdict"] == "SKIP"
    assert core.grade(NO_DEVICE, _all(None), None, 20.0)["verdict"] == "SKIP"
    s = core.parse_serial(SETUP + FRESH_SAME)
    g = core.grade(OK, {"stored": OK, "joined": NO_DEVICE, "resend": NO_DEVICE}, s, 20.0)
    assert g["verdict"] == "SKIP" and "joined" in g["skip"]


def test_no_serial_capture_grades_on_the_provisioner_alone():
    assert core.grade(OK, _all(OK), None, 20.0)["verdict"] == "PASS"


def test_crash_fails():
    s = core.parse_serial(SETUP + FRESH_SAME + FRESH_SAME + "Guru Meditation Error\n")
    assert core.grade(OK, _all(OK), s, 20.0)["verdict"] == "FAIL"
