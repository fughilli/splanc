"""la_phase on synthetic WS2812 captures (decoded through the sigrok VCD dialect)."""

import camsim
import flip_cv as fc
import la_phase as la
import numpy as np
import pytest


def _wire(d: camsim.DutModel, duration: float, rng, sample_rate=10e6):
    lt, pt, n = d.frames(0.0, duration, rng)
    keep = (lt > 0.0) & (lt < duration)
    lt, n = lt[keep], n[keep]
    states = np.stack([d.led_states(n, i) for i in range(3)], axis=1)
    colours = [[(255 * int(s), 0, 0) for s in row] for row in states]
    return la.synth_wire(lt, colours, sample_rate=sample_rate, data_lead=140e-6)


def test_decode_frames():
    t, lv = la.synth_wire(
        np.array([0.001, 0.0135]),
        [[(255, 0, 0), (0, 7, 1), (128, 0, 0)]] * 2,
        sample_rate=10e6,
        data_lead=0.0,
    )
    fr = la.frames_from_edges(t, lv)
    assert len(fr) == 2
    assert fr[0].leds == [(255, 0, 0), (0, 7, 1), (128, 0, 0)]
    assert fr[0].bits == 72
    assert fr[0].t == pytest.approx(0.001, abs=0.11e-6)
    assert [fr[0].state(i) for i in range(3)] == [1, 0, 1]


@pytest.mark.parametrize("skew_ms", [0.0, 0.29, 4.0, -61.0, 1000.0])
def test_skew_from_wire(skew_ms):
    rng = np.random.default_rng(0)
    a = camsim.DutModel("a", offset=0.0021, drift_ppm=8)
    b = camsim.DutModel("b", offset=0.0021 + skew_ms * 1e-3, drift_ppm=8)
    chans = {"a": _wire(a, 8.0, rng), "b": _wire(b, 8.0, rng)}
    res = la.analyse(chans)
    # both clocks run 8 ppm fast: at one camera instant the offsets differ by
    # skew * (1 - 8 ppm), which is what is measured
    assert res["skew_s"]["b"] == pytest.approx(skew_ms * 1e-3 * (1 - 8e-6), abs=0.3e-6)
    assert res["frame_period"]["a"]["median_ms"] == pytest.approx(12.5, abs=0.01)


def test_vcd_round_trip_and_jitter():
    rng = np.random.default_rng(1)
    a = camsim.DutModel("a", offset=0.001, jitter=0.001)
    b = camsim.DutModel("b", offset=0.0013, jitter=0.001)
    chans = {"D0": _wire(a, 6.0, rng), "D1": _wire(b, 6.0, rng)}
    vcd = la.to_vcd(chans, 10e6)
    back, t_end = la.parse_vcd(vcd)
    res = la.analyse(back)
    assert res["skew_s"]["D1"] == pytest.approx(0.0003, abs=50e-6)  # mean of jittered flips
    per = res["per_flip_s"]["D1"]
    assert per.size > 150
    assert np.std(per) == pytest.approx(np.sqrt(2) * 0.001 / np.sqrt(12), rel=0.2)


def test_sync_map():
    ctrl = np.array([0, 80_000, 160_000, 400_000, 1_000_000, 2_000_000], dtype=np.int64) + 5_000_000
    la_t = (ctrl - 5_000_000) * 1e-6 * (1 + 30e-6) + 0.123
    a, b, rms = la.sync_map(la_t, ctrl)
    assert rms < 0.01
    assert a + b * (0.123 + 1.5 * (1 + 30e-6)) == pytest.approx(6_500_000, abs=0.05)


def test_camera_and_wire_agree_up_to_the_led_stage():
    """The same two DUTs seen by both instruments: the skew agrees; per DUT the
    camera's offset trails the wire's by the data + latch time (a constant)."""
    rng = np.random.default_rng(2)
    a = camsim.DutModel("a", offset=0.002)
    b = camsim.DutModel("b", offset=0.0027)
    wire = la.analyse({"a": _wire(a, 8.0, rng), "b": _wire(b, 8.0, rng)})
    s, ser, _ = camsim.series([a, b], camsim.CameraModel(fps=120), 8.0, rng)
    strips = [
        fc.Strip(n, [fc.Roi(f"{n}{i}", np.zeros(1, int), np.zeros(1, int), 0.0) for i in range(3)])
        for n in "ab"
    ]
    cam = fc.analyse(None, s, fc.Camera(0.95 / 120), strips, series=ser)
    assert cam["windows"][0]["skew_s"]["b"] == pytest.approx(wire["skew_s"]["b"], abs=30e-6)
    lag = cam["windows"][0]["phases"]["a"].offsets[0].phase - wire["phases"]["a"].offsets[0].phase
    assert fc.wrap(lag, 0.0625) == pytest.approx(140e-6, abs=30e-6)
