"""The no-park / no-reboot HITL gate's pure logic (harness/no_reboot_no_park_core.py).

The FAIL fixtures are trimmed from the PixieLamp field log (bootloop.txt, build
8f10ae9e): the slow effect parked at ~6 s, and the board restarted to rescan every 20 s."""

import no_reboot_no_park_core as core


def fx(t0: float, f0: int, n: int, fps: float = 8.0, cancelled: int = 0, leds: int = 250) -> str:
    """n one-per-second [fx] lines starting at effect time t0 / frame f0."""
    return "".join(
        f"[fx] t={t0 + i:.2f} frame={f0 + int(i * fps)} update=ok shade_cancelled={cancelled}/{leds}\n"
        for i in range(n)
    )


# The field log: the effect renders ~6 s, gets parked, then the board restarts to rescan.
PARKED_THEN_REBOOT = (
    fx(0.09, 1, 7)
    + "[fps] effect parked: can't hold 25 fps with 5% headroom\n"
    + "[t=12110] deauth sent to clear any stale association for our MAC\n"
    + '[t=20000] [wifi] stored network "BigVibes" not in the boot scan — restarting to rescan (attempt 1/12)\n'
    + "ESP-ROM:esp32c6-20220919\nrst:0xc (SW_CPU),boot:0x6b (SPI_FAST_FLASH_BOOT)\n"
    + "[boot] reset_reason=SW (3)\n"
    + fx(0.09, 1, 7)
    + "[fps] effect parked: can't hold 25 fps with 5% headroom\n"
)

LAGGING = (
    fx(10.0, 80, 4)
    + "[fps] effect lagging: running at 7 fps, below its target (still playing)\n"
    + fx(14.0, 112, 72)
)

NONET_OK = (
    "[t=90000] [wire] PROV received (ssid=hitl-no-such-ap-1a2b3c) -> associating\n"
    + fx(90.0, 700, 5)
    + '[t=95100] [wifi] "hitl-no-such-ap-1a2b3c" not in the last scan — background scan 1 (effect keeps running)\n'
    + '[t=96700] [wifi] background scan: "hitl-no-such-ap-1a2b3c" not found; next in 10 s '
    + "(BLE Improv stays up to re-provision)\n"
    + fx(95.0, 740, 50)
    + '[t=106700] [wifi] "hitl-no-such-ap-1a2b3c" not in the last scan — background scan 2 (effect keeps running)\n'
    + fx(145.0, 1140, 45)
)


def test_fx_samples_parse_the_field_line():
    s = core.fx_samples("[fx] t=43.89 frame=1249 update=ok shade_cancelled=0/48\n")
    assert s == [(43.89, 1249, "ok", 0, 48)]


def test_resets_detect_the_boot_banner():
    assert core.resets(PARKED_THEN_REBOOT)
    assert core.resets("Rebooting...\n")
    assert not core.resets(LAGGING)
    assert not core.resets(NONET_OK)


def test_frames_must_strictly_advance():
    assert core.frames_advance(core.fx_samples(LAGGING))[0]
    ok, why = core.frames_advance(core.fx_samples(PARKED_THEN_REBOOT))
    assert not ok and "restarted" in why
    ok, why = core.frames_advance(core.fx_samples(fx(1.0, 10, 5, cancelled=3)))
    assert not ok and "cancelled" in why
    assert not core.frames_advance(core.fx_samples(fx(1.0, 10, 1)))[0]
    assert not core.frames_advance([])[0]


def test_slow_phase_passes_when_the_effect_lags_and_control_answers():
    g = core.grade_slow(LAGGING, 75.0, [0.4, 0.6, 0.5, 1.2])
    assert g["problems"] == []
    assert g["lag_line_fps"] == 7
    assert g["control_p50_s"] == 0.55
    assert 7.0 <= g["fps"] <= 8.0


def test_slow_phase_fails_on_the_field_behaviour():
    g = core.grade_slow(PARKED_THEN_REBOOT, 75.0, [0.5])
    text = " ".join(g["problems"])
    assert "PARKED" in text
    assert "reset" in text
    assert "span only" in text


def test_slow_phase_fails_on_an_unresponsive_device():
    g = core.grade_slow(LAGGING, 75.0, [0.5, None, 0.7])
    assert any("no reply" in p for p in g["problems"])
    g = core.grade_slow(LAGGING, 75.0, [4.0, 5.0, 6.0])
    assert any("median" in p for p in g["problems"])
    g = core.grade_slow(LAGGING, 75.0, [0.5, 0.5, 20.0])
    assert any("max" in p for p in g["problems"])
    g = core.grade_slow(LAGGING, 75.0, [])
    assert any("no control" in p for p in g["problems"])


def test_nonet_phase_passes_without_a_reset():
    g = core.grade_nonet(NONET_OK, 95.0)
    assert g["problems"] == [], g
    assert g["bg_scan_lines"] >= 2
    assert g["resets"] == []


def test_nonet_phase_fails_on_restart_to_rescan():
    g = core.grade_nonet(PARKED_THEN_REBOOT, 95.0)
    text = " ".join(g["problems"])
    assert "RESET" in text
    assert "restarts to rescan" in text
    assert "background-scan" in text


def test_verdict_skips_on_infra_and_fails_on_misbehaviour():
    assert core.verdict(False, None, None, None)["verdict"] == "SKIP"
    assert core.verdict(True, None, None, None)["verdict"] == "SKIP"
    slow = core.grade_slow(LAGGING, 75.0, [0.5])
    nonet = core.grade_nonet(NONET_OK, 95.0)
    assert core.verdict(True, slow, nonet, True)["verdict"] == "PASS"
    g = core.verdict(True, slow, nonet, False)
    assert g["verdict"] == "FAIL" and any("lease" in p for p in g["problems"])
    bad = core.grade_nonet(PARKED_THEN_REBOOT, 95.0)
    assert core.verdict(True, slow, bad, True)["verdict"] == "FAIL"
    line = core.result_line("c6-1", core.verdict(True, slow, nonet, True), slow, nonet)
    assert line.startswith("RESULT unit=c6-1 ") and line.endswith("verdict=PASS")
