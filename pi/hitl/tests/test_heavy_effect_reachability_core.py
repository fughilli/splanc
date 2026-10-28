"""The heavy-effect reachability HITL gate's pure logic (harness/heavy_effect_reachability_core.py).

Field regression (1.12.3): under a near-budget effect the netstack loop starved, so NEW
clients timed out (no TLS/WebSocket handshake within 8 s) while the LEDs kept running."""

import heavy_effect_reachability_core as core


def att(cat: str, s: float = 1.2, t: float = 0.0) -> dict:
    return {"cat": cat, "s": s, "t": t}


def test_classify():
    assert core.classify(None, 1.0) == core.OK
    assert core.classify(None, core.HANDSHAKE_S + 0.1) == core.SLOW
    assert core.classify(TimeoutError(), 8.5) == core.TIMEOUT
    assert core.classify(ConnectionResetError(), 0.1) == core.REJECTED
    assert core.classify(EOFError(), 0.1) == core.REJECTED

    class SSLError(Exception):
        pass

    assert core.classify(SSLError(), 0.1) == core.REJECTED
    assert core.classify(ValueError("bug"), 0.1) == core.ERROR


def test_calibration_sizes_the_map_to_the_floor_budget():
    # 128 LEDs measured at 1.6 M cycles (12.5 k/LED): 93 % of 6.4 M -> 476 LEDs.
    assert core.leds_for_budget(1_600_000, 128) == 476
    assert 0.92 < core.frame_duty(476 * 12_500) < 0.94
    # Clamped: a very cheap effect can't exceed the 25 fps floor's 512 LEDs ...
    assert core.leds_for_budget(10_000, 128) == core.CAL_MAX_LEDS
    # ... and a very heavy one keeps a usable map.
    assert core.leds_for_budget(50_000_000, 128) == core.CAL_MIN_LEDS


def test_idle_passes_on_a_streak():
    a = [att(core.OK)] * core.STREAK
    g = core.grade_idle(a)
    assert g["verdict"] == "PASS" and g["streak"] == core.STREAK


def test_idle_fails_when_a_quiet_live_session_was_dropped():
    a = [att(core.OK)] * core.STREAK
    g = core.grade_idle(a, held=False)
    assert g["verdict"] == "FAIL" and "silent" in g["why"]


def test_idle_tolerates_an_early_miss_then_a_streak():
    a = [att(core.TIMEOUT, 8.5)] + [att(core.OK)] * core.STREAK
    assert core.grade_idle(a)["verdict"] == "PASS"


def test_idle_fails_when_new_clients_time_out():
    # The field state: every new handshake times out (main: 1.12.3 under the effect).
    a = [att(core.TIMEOUT, 8.5)] * core.MAX_ATTEMPTS
    g = core.grade_idle(a)
    assert g["verdict"] == "FAIL"
    assert "0/5" in g["why"]


def test_idle_fails_on_slow_but_completed_handshakes():
    a = [att(core.SLOW, 9.5)] * core.MAX_ATTEMPTS
    assert core.grade_idle(a)["verdict"] == "FAIL"


def test_idle_skips_when_the_rig_is_gone():
    a = [att(core.REJECTED, 0.1)] * 3
    assert core.grade_idle(a, rig_ok=False)["verdict"] == "SKIP"
    assert core.grade_idle([])["verdict"] == "SKIP"


def test_reconnect_pass_fail_skip():
    ok = [att(core.TIMEOUT, 8.5, 5), att(core.OK, 1.0, 20)] + [att(core.OK, 1.0, 25)] * 3
    g = core.grade_reconnect(ok, 60)
    assert g["verdict"] == "PASS" and g["first_ok_s"] == 20 and g["follow"] == 3
    late = [att(core.TIMEOUT, 8.5, 30), att(core.OK, 1.0, 75)] + [att(core.OK, 1.0, 80)] * 3
    assert core.grade_reconnect(late, 60)["verdict"] == "FAIL"
    never = [att(core.TIMEOUT, 8.5, t) for t in range(0, 80, 10)]
    assert core.grade_reconnect(never, 60)["verdict"] == "FAIL"
    flaky = [att(core.OK, 1.0, 20), att(core.TIMEOUT, 8.5, 30), att(core.OK, 1.0, 40)]
    flaky += [att(core.TIMEOUT, 8.5, 50)]
    assert core.grade_reconnect(flaky, 60)["verdict"] == "FAIL"
    assert core.grade_reconnect(never, 60, booted=False)["verdict"] == "SKIP"
    assert core.grade_reconnect(never, 60, rig_ok=False)["verdict"] == "SKIP"


CONSOLE = (
    "[net] t=40000 segs=0 ooo=0 dup=0 trunc=0 zwnd=0 rto=0 frx=0 ring_hwm=16 ring_full=9 "
    "loop_gap_max=1830000us mtx_wait_max=0us handle_max=0us\n"
    "[fx] t=12.00 frame=300 update=ok shade_cancelled=0/476\n"
    "[ft] r24:40100/40300/41800 w24:40000/40300/41900 dt42 fps=25 sl=2-3\n"
    "[net] t=45000 segs=0 ooo=0 dup=0 trunc=0 zwnd=0 rto=0 frx=0 ring_hwm=16 ring_full=9 "
    "loop_gap_max=950000us mtx_wait_max=0us handle_max=0us\n"
    "*** DHCP LEASE ACQUIRED — IP 10.42.0.17 ***\n"
)


def test_console_summary():
    assert core.loop_gaps_ms(CONSOLE) == [1830.0, 950.0]
    assert core.render_fps(CONSOLE) == [25]
    assert core.render_sleep_ms(CONSOLE) == [2]
    s = core.summarize_console(CONSOLE)
    assert s["loop_gap_max_ms"] == 1830.0 and s["fps_p50"] == 25 and s["sleep_min_p50_ms"] == 2
    assert core.leased(CONSOLE)
    assert not core.booted(CONSOLE)
    assert core.booted("ESP-ROM:esp32c6-20220919\nrst:0x15 (USB_UART_HPSYS)\n")


def test_overall_verdict():
    p = {"verdict": "PASS"}
    f = {"verdict": "FAIL", "why": "x"}
    s = {"verdict": "SKIP"}
    assert core.verdict(False, True, {"idle": f})["verdict"] == "SKIP"
    assert core.verdict(True, False, {})["verdict"] == "SKIP"
    assert core.verdict(True, True, {"idle": p, "boot": s})["verdict"] == "PASS"
    g = core.verdict(True, True, {"idle": p, "rejoin": f})
    assert g["verdict"] == "FAIL" and g["problems"] == ["rejoin: x"]
    assert core.verdict(True, True, {"idle": s})["verdict"] == "SKIP"


def test_result_line():
    phases = {
        "idle": core.grade_idle([att(core.TIMEOUT, 8.5)] * core.MAX_ATTEMPTS),
        "boot": core.grade_reconnect([att(core.OK, 1, 20)] + [att(core.OK, 1, 25)] * 3, 60),
    }
    g = core.verdict(True, True, phases)
    line = core.result_line("c6-123170", {"leds": 476, "duty": 0.93}, phases, g)
    assert line.startswith("RESULT unit=c6-123170 leds=476 duty=0.93 idle=FAIL(0/5,ok=0/10)")
    assert "boot=PASS(first_ok_s=20)" in line and line.endswith("verdict=FAIL")


def test_idle_window_covers_the_hold_the_wait_and_every_dial():
    # main 49475165: the held session dropped somewhere in a 35 s hold; the window must
    # span that hold, the 30 s closed wait and all MAX_ATTEMPTS dials (each up to 8.5 s).
    w = core.idle_window_s(core.HOLD_IDLE_S, core.IDLE_WAIT_S, 2.0, 25.0)
    dials = core.MAX_ATTEMPTS * (core.HANDSHAKE_S + 0.5 + 2.0)
    assert w >= 25.0 + core.HOLD_IDLE_S + 15.0 + core.IDLE_WAIT_S + dials
    # No hold: the window covers only the wait and the dials.
    assert core.idle_window_s(0, core.IDLE_WAIT_S, 2.0, 25.0) == core.IDLE_WAIT_S + dials + (
        core.WINDOW_SLACK_S
    )


def test_a_failing_phase_prints_its_whole_window():
    f = {"verdict": "FAIL", "why": "x"}
    p = {"verdict": "PASS"}
    windows = ["idle", "rejoin_drop", "rejoin", "boot"]
    assert core.windows_to_print({"idle": f, "rejoin": p, "boot": p}, windows) == [
        ("idle", True),
        ("rejoin_drop", False),
        ("rejoin", False),
        ("boot", False),
    ]
    assert core.windows_to_print({"idle": p, "rejoin": f}, windows) == [
        ("idle", False),
        ("rejoin_drop", True),
        ("rejoin", True),
        ("boot", False),
    ]
    # Only captured windows print; an unknown phase never crashes it.
    assert core.windows_to_print({"idle": f, "other": f}, ["idle"]) == [("idle", True)]


def live(**kw) -> dict:
    base = {
        "opened": True,
        "s": 150.0,
        "deaths": 0,
        "dropped": [],
        "max_silence_s": 4.2,
        "pings": 20,
        "pings_missed": 0,
        "reports": 65,
        "churn": {"cycles": 20, "ok": 20, "reset": 0, "other": 0},
    }
    base.update(kw)
    return base


def test_session_passes_a_serviced_session():
    g = core.grade_session(live(), {"ok": True})
    assert g["verdict"] == "PASS"
    assert g["held"] is True and g["churn"]["reset"] == 0


def test_session_fails_when_the_heartbeat_declares_it_dead():
    # 1.12.7 PixieLamp: "no reply from the player for 14.1 s (2 heartbeat pings unanswered)".
    g = core.grade_session(live(deaths=1, max_silence_s=14.1), {"ok": True})
    assert g["verdict"] == "FAIL" and "declared dead 1x" in g["why"] and "14.1" in g["why"]


def test_session_fails_on_a_drop_a_reset_reconnect_or_a_dropped_hold():
    assert core.grade_session(live(dropped=["@40s reset"]), None)["verdict"] == "FAIL"
    g = core.grade_session(live(churn={"cycles": 20, "ok": 10, "reset": 10, "other": 0}), None)
    assert g["verdict"] == "FAIL" and "10/20 immediate reconnects were RST-refused" in g["why"]
    g = core.grade_session(live(), {"ok": False, "err": "ConnectionResetError"})
    assert g["verdict"] == "FAIL" and "silent live session" in g["why"]
    # A slow (timed-out) reconnect under contention is reported, never gated.
    g = core.grade_session(live(churn={"cycles": 20, "ok": 18, "reset": 0, "other": 2}), None)
    assert g["verdict"] == "PASS"


def test_session_needs_reports_and_skips_on_infra():
    assert core.grade_session(live(reports=0), None)["verdict"] == "FAIL"
    assert core.grade_session(live(opened=False), None, rig_ok=False)["verdict"] == "SKIP"
    assert core.grade_session(live(opened=False), None)["verdict"] == "FAIL"
    assert core.grade_session(live(deaths=2), None, rig_ok=False)["verdict"] == "SKIP"


def test_session_result_line_and_window():
    g = {"verdict": "PASS", "skip": None, "problems": []}
    phases = {"session": core.grade_session(live(), {"ok": True})}
    line = core.result_line("c6-003f08", {"leds": 450, "duty": 0.93}, phases, g)
    assert "session=PASS(deaths=0,max_silence_s=4.2)" in line
    assert core.session_window_s(150.0, 35.0, 25.0) == 25.0 + 150.0 + 30.0 + 75.0 + 30.0
    f = {"verdict": "FAIL"}
    assert core.windows_to_print({"session": f}, ["idle", "session"]) == [
        ("idle", False),
        ("session", True),
    ]
