"""The canned-ramp HITL analysis (ramp_shape_core): eases, the curve fit, the
duration measurement, two-fixture skew and the live-set cut, on synthetic
captures shaped like the analyzer's (quantized bytes, a fixed frame rate,
render->wire latency)."""

import math

from ramp_shape_core import brightness, crossing, cut_ramp, ease, ease_inv, fit_ramp, skew_ms, synth

EASES = ["linear", "ease", "ease_in", "ease_out", "smoothstep"]


def test_eases_and_inverse():
    for e in EASES:
        assert ease(e, 0) == 0 and ease(e, 1) == 1
        for y in (0.1, 0.5, 0.9):
            assert abs(ease(e, ease_inv(e, y)) - y) < 1e-9
    assert ease("ease", 0.25) == 0.0625
    assert ease("ease_in", 0.5) == 0.125


def test_fit_recovers_the_curve_at_any_frame_rate():
    for e in EASES:
        for fps in (25.0, 47.0, 80.0):
            s = synth(e, 2.0, start_s=1.234, fps=fps, seconds=5.0, latency_s=0.004, phase=0.37)
            f = fit_ramp(s, e, 2.0)
            assert f is not None
            assert abs(f.start_s - (1.234 + 0.004)) < 0.02, (e, fps, f)
            assert abs(f.duration_s - 2.0) / 2.0 < 0.03, (e, fps, f)
            assert f.max_err < 0.03 and f.rms_err < 0.01, (e, fps, f)


def test_a_wrong_curve_or_duration_shows():
    s = synth("ease_in", 2.0, start_s=1.0, fps=60.0, seconds=5.0)
    f = fit_ramp(s, "linear", 2.0)
    assert f.max_err > 0.1
    s = synth("linear", 3.0, start_s=1.0, fps=60.0, seconds=6.0)
    assert abs(fit_ramp(s, "linear", 2.0).duration_s - 3.0) < 0.05


def test_skew_between_two_fixtures():
    a = synth("ease", 2.0, start_s=1.0, fps=60.0, seconds=5.0, phase=0.1)
    b = synth("ease", 2.0, start_s=1.012, fps=43.0, seconds=5.0, phase=0.8)
    assert abs(skew_ms(a, b) - 12.0) < 3.0
    assert skew_ms(a, [(0.0, 0.0)]) is None


def test_live_set_cuts_the_ramp():
    # 0 -> 1 over 3 s from t=0.5; a live set to 0.2 at t=1.7 (ramp ~40% there).
    s = synth(
        "linear",
        3.0,
        start_s=0.5,
        fps=50.0,
        seconds=4.5,
        override=lambda r: 0.2 if r >= 1.7 else None,
    )
    c = cut_ramp(s, 0.2)
    assert c.held and not c.rose_after
    assert 0.35 < c.peak < 0.45
    # A ramp that kept going (no cut) neither holds 0.2 nor stays under the target.
    s2 = synth("linear", 3.0, start_s=0.5, fps=50.0, seconds=4.5)
    assert not cut_ramp(s2, 0.2).held


def test_brightness_and_crossing():
    frames = [
        (0.0, [(0, 0, 0)] * 4),
        (0.1, [(128, 128, 128)] * 4),
        (0.2, [(255, 255, 255)] * 4),
        (0.3, []),
    ]
    s = brightness(frames)
    assert [round(v, 3) for _, v in s] == [0.0, 0.502, 1.0]
    assert math.isclose(crossing(s, 0.25), 0.0498, abs_tol=1e-3)
    assert crossing(s, 2.0) is None
