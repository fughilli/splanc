"""The Identify-blink HITL gate's pure grading (harness/identify_blink_core.py)."""

import identify_blink_core as core

BLE = {"found": True, "name": "Led Widget CA2BFE", "capabilities": 1, "sent": True}


def fx(t0, f0, n):
    return "".join(
        f"10:00:{t0 + i:06.3f}Z [fx] t={i}.00 frame={f0 + 60 * i} update=ok shade_cancelled=0/1200\n"
        for i in range(n)
    )


GOOD = (
    fx(10, 600, 3)
    + "10:00:12.500Z [identify] blink requested\n"
    + "10:00:13.420Z [identify] blink done (539 LEDs x 2 ports)\n"
    + fx(14, 840, 3)
)


def test_pass():
    g = core.grade(BLE, GOOD, 539, 2)
    assert g["verdict"] == "PASS", g


def test_wrong_length_fails():
    g = core.grade(BLE, GOOD, 256, 2)
    assert g["verdict"] == "FAIL" and "539 LEDs x 2 ports" in g["problems"][0]


def test_old_firmware_capability_fails():
    g = core.grade({**BLE, "capabilities": 0}, GOOD, 539, 2)
    assert g["verdict"] == "FAIL" and "capabilities=0" in g["problems"][0]


def test_no_blink_logged_fails():
    g = core.grade(BLE, fx(10, 600, 6), 539, 2)
    assert g["verdict"] == "FAIL"
    assert any("requested" in p for p in g["problems"])


def test_effect_stalled_or_frozen_fails():
    head = (
        fx(10, 600, 3)
        + "10:00:12.500Z [identify] blink requested\n"
        + "10:00:13.420Z [identify] blink done (539 LEDs x 2 ports)\n"
    )
    stalled = core.grade(BLE, head, 539, 2)  # no [fx] line after the blink
    assert stalled["verdict"] == "FAIL" and any("frame counter" in p for p in stalled["problems"])
    frozen = core.grade(
        BLE,
        head + fx(14, 720, 3).replace("frame=780", "frame=720").replace("frame=840", "frame=720"),
        539,
        2,
    )
    assert frozen["verdict"] == "FAIL"  # the first frame after == the last before (720)


def test_reboot_fails():
    g = core.grade(BLE, GOOD + "10:00:15.000Z [boot] reset_reason=PANIC (4)\n", 539, 2)
    assert g["verdict"] == "FAIL" and any("rebooted" in p for p in g["problems"])


def test_too_long_fails():
    slow = GOOD.replace(
        "10:00:13.420Z [identify] blink done", "10:00:15.900Z [identify] blink done"
    )
    g = core.grade(BLE, slow, 539, 2)
    assert g["verdict"] == "FAIL" and any("lasted" in p for p in g["problems"])


def test_dut_not_found_is_a_skip():
    assert core.grade({"found": False}, "", 539, 2)["verdict"] == "SKIP"


# Firmware with the device-measured blink (ms=): graded on it, not on host stamps.
def _with_ms(ms, req="10:00:12.500Z", done="10:00:13.420Z"):
    return (
        fx(10, 600, 3)
        + f"{req} [identify] blink requested\n"
        + f"{done} [identify] blink done (539 LEDs x 2 ports) ms={ms}\n"
        + fx(14, 840, 3)
    )


def test_device_ms_is_parsed():
    p = core.parse(_with_ms(903))
    assert (p["len"], p["ports"], p["ms"]) == (539, 2, 903)
    assert core.parse(GOOD)["ms"] is None  # old line: still matches, no ms


def test_device_ms_passes_despite_quantised_host_stamps():
    # main 1412e9fad CI: the capture stamps per 0.2 s read, so the 0.9 s blink's lines
    # landed 0.8 s apart (0.79999 in float). The device's own ms= is what is graded.
    g = core.grade(BLE, _with_ms(903, "10:00:12.489Z", "10:00:13.289Z"), 539, 2)
    assert g["verdict"] == "PASS", g


def test_device_ms_short_fails():
    # The clear frame only comes once 900 ms have elapsed: below that is a firmware bug,
    # even when the host stamps look fine.
    g = core.grade(BLE, _with_ms(450), 539, 2)
    assert g["verdict"] == "FAIL" and any("450 ms on the device" in p for p in g["problems"])


def test_device_ms_long_fails():
    g = core.grade(BLE, _with_ms(2400), 539, 2)
    assert g["verdict"] == "FAIL" and any("2400 ms on the device" in p for p in g["problems"])


def test_old_firmware_host_gap_allows_one_capture_read():
    # No ms=: the host gap is the blink +- one 0.2 s capture read; 0.8 s (stored as
    # 0.79999) is a 0.9 s blink, not a short one.
    quantised = GOOD.replace("10:00:12.500Z", "10:00:12.489Z").replace(
        "10:00:13.420Z", "10:00:13.289Z"
    )
    assert core.grade(BLE, quantised, 539, 2)["verdict"] == "PASS"
    short = GOOD.replace("10:00:13.420Z", "10:00:12.900Z")  # 0.4 s
    g = core.grade(BLE, short, 539, 2)
    assert g["verdict"] == "FAIL" and any("by host stamps" in p for p in g["problems"])
