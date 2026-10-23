"""Unit tests for the long-run video latency/jitter/burst analysis (video_latency_core).

The rig-side probe (wss_video_latency.py) prints raw CAL/F/P/T rows; these tests feed
synthetic rows with a known device clock offset + drift, known stalls and known TCP
counters, and pin the latency, jitter, stall attribution and verdict the HITL gate
reports."""

import pytest
from video_latency_core import (
    Policy,
    analyze,
    fit_clock,
    parse,
    percentile,
    result_line,
    run_status,
)

pytestmark = pytest.mark.requirements("PR-10")

OFF = 5000.0  # device clock = host clock - OFF (ms)
FPS = 30.0
PERIOD = 1000.0 / FPS


def _cal(phase, t, n=12, drift=0.0, rtt=2.0):
    rows = []
    for k in range(n):
        t0 = t + k * 20.0
        extra = 0.0 if k % 3 == 0 else 7.0  # only some pings are queue-free
        t3 = t0 + rtt + extra
        dev = (t0 + rtt / 2.0) - OFF + drift * (t0 - 1_000_000.0)
        rows.append(f"CAL {phase} {t0:.3f} {dev:.3f} {t3:.3f}")
    return rows


def _stream(
    n, t_start=1_000_500.0, lat=lambda i: 4.0, retrans=lambda i: 0, rwnd=lambda i: 0, drift=0.0
):
    rows = []
    for i in range(n):
        t = t_start + i * PERIOD
        rows.append(f"F {i} {t:.3f} {t:.3f} 0 1200 1210 0")
        dev = t + lat(i) - OFF + drift * (t - 1_000_000.0)
        rows.append(f"P {t:.3f} {dev:.3f} {t + lat(i) + 1:.3f}")
        rows.append(f"T {t:.3f} {retrans(i)} 0 1 2000 500 10 {rwnd(i)} 4096 0 200000")
    return rows


def _text(stream_rows, drift=0.0, end="done", post=True):
    rows = _cal("pre", 1_000_000.0, drift=drift)
    rows += stream_rows
    if post:
        rows += _cal("post", 1_000_500.0 + 3700 * PERIOD, drift=drift)
    rows.append(f"END {end}")
    return "\n".join(rows)


def test_clock_fit_uses_min_rtt_samples_and_drift():
    run = parse(_text(_stream(10), drift=20e-6))
    fit = fit_clock(run)
    assert fit is not None
    assert fit.rtt_ms == pytest.approx(2.0)
    assert fit.drift * 1e6 == pytest.approx(20.0, abs=0.5)
    # A device time maps back onto the host clock it came from.
    t = 1_050_000.0
    dev = t - OFF + 20e-6 * (t - 1_000_000.0)
    assert fit.to_host(dev) == pytest.approx(t, abs=0.1)


def test_steady_stream_has_tight_latency_and_no_stalls():
    stats = analyze(parse(_text(_stream(300), drift=30e-6)), FPS)
    assert stats is not None
    assert stats.frames_applied == 300
    assert stats.lat(50) == pytest.approx(4.0, abs=0.2)
    assert stats.lat(99) == pytest.approx(4.0, abs=0.2)
    assert percentile(stats.intervals_ms, 50) == pytest.approx(PERIOD, abs=0.1)
    assert stats.jitter_ms < 0.2
    assert stats.stalls == []
    assert stats.fps_applied == pytest.approx(30.0, abs=0.2)
    assert run_status(stats) == ("PASS", "ok")


def _burst_lat(i):
    # frames 100..108 queue behind a ~250 ms stall, then drain back to back
    if 100 <= i < 109:
        return 250.0 - (i - 100) * PERIOD + (i - 100) * 1.0
    return 4.0


def test_stall_with_catchup_is_attributed_to_tcp_retransmit():
    stats = analyze(
        parse(_text(_stream(300, lat=_burst_lat, retrans=lambda i: 1 if i >= 105 else 0))), FPS
    )
    assert len(stats.stalls) == 1
    st = stats.stalls[0]
    assert st.at_seq == 100
    assert st.gap_ms == pytest.approx(250.0 + PERIOD - 4.0, abs=1.0)
    assert st.catchup == 8
    assert st.cause == "tcp_retransmit"
    assert stats.lat(100) == pytest.approx(250.0, abs=1.0)
    line = result_line(stats, run_status(stats))
    assert "stalls=1" in line and "stall_causes=tcp_retransmit:1" in line


def test_stall_while_window_limited_is_attributed_to_device():
    stats = analyze(
        parse(_text(_stream(300, lat=_burst_lat, rwnd=lambda i: 400_000 if i >= 103 else 0))), FPS
    )
    assert [s.cause for s in stats.stalls] == ["device_window_full"]
    stats = analyze(parse(_text(_stream(300, lat=_burst_lat))), FPS)
    assert [s.cause for s in stats.stalls] == ["device_busy"]


def test_verdict_skip_without_calibration_and_fail_on_drop_or_loss():
    assert run_status(analyze(parse("END error:x"), FPS))[0] == "SKIP"
    rows = _stream(100)
    # drop every other pong -> half the frames never confirmed applied
    rows = [r for k, r in enumerate(rows) if not (r.startswith("P") and (k // 3) % 2)]
    stats = analyze(parse(_text(rows)), FPS)
    assert run_status(stats)[0] == "FAIL"
    stats = analyze(parse(_text(_stream(100), end="error:ConnectionError:closed")), FPS)
    assert run_status(stats) == ("FAIL", "stream ended early: error:ConnectionError:closed")
    stats = analyze(parse(_text(_stream(300, lat=_burst_lat))), FPS)
    assert run_status(stats, Policy(max_p99_ms=100.0))[0] == "FAIL"
    assert run_status(stats, Policy(max_stalls_per_min=0.1))[0] == "FAIL"


def test_parse_ignores_garbage_and_counts_unmatched_pongs():
    run = parse("noise\nF x y\nP 1.000 2.0 3.0\nE 1.0 device-error b'x'\nEND done\n")
    assert run.unmatched_pongs == 1
    assert run.errors and run.end == "done"
