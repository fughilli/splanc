"""WebSocket message handler (design doc §7 contract)."""

import asyncio
import json

from ledmapper_protocol import DetectionRecord, OutputMap, OutputMapStats
from server.handler import ConnectionHandler, ServerContext
from server.reconstruct import LiveSolver, _decimate_per_led
from server.session import SessionManager


def _stub_map() -> OutputMap:
    return OutputMap(
        mapId="map-stub",
        createdAt="2026-01-01T00:00:00Z",
        units="meters",
        frame="webxr_session_ref",
        ledCount=0,
        leds=[],
        unmapped=[],
        stats=OutputMapStats(rmsReprojPxGlobal=0.0, medianParallaxDeg=0.0),
    )


def _make_handler(tmp_path, *, clock_value=2000.0, live_solver=None):
    recon_calls = []

    async def stub_reconstructor(log_path):
        recon_calls.append(log_path)
        return _stub_map()

    ctx = ServerContext(
        SessionManager(tmp_path / "sessions"),
        stub_reconstructor,
        default_led_count=512,
        bit_period_ms=100.0,
        id_factory=lambda: "sess-fixed",
        clock=lambda: clock_value,
        live_solver=live_solver,
    )
    return ConnectionHandler(ctx), ctx, recon_calls


def _run(handler, raw, recv_ms=1000.0):
    return asyncio.run(handler.handle(raw, recv_ms=recv_ms))


def _dump(msg):
    return json.loads(msg.model_dump_json())


def test_hello_returns_welcome(tmp_path):
    handler, _ctx, _ = _make_handler(tmp_path)
    out = _run(handler, '{"type":"hello","client":"android-web","appVersion":"1.0"}')
    assert len(out) == 1
    m = _dump(out[0])
    assert m["type"] == "welcome"
    assert m["sessionId"] == "sess-fixed"
    assert m["codeParams"]["ledCount"] == 512  # server default until start_mapping


def test_time_sync_pong_timestamps(tmp_path):
    handler, _ctx, _ = _make_handler(tmp_path, clock_value=2000.0)
    out = _run(handler, '{"type":"time_sync_ping","t0":123.5}', recv_ms=1500.0)
    m = _dump(out[0])
    assert m["type"] == "time_sync_pong"
    assert m["t0"] == 123.5  # echoed
    assert m["t1"] == 1500.0  # receive time
    assert m["t2"] == 2000.0  # send time
    assert m["t1"] <= m["t2"]


def test_start_mapping_uses_requested_led_count(tmp_path):
    handler, ctx, _ = _make_handler(tmp_path)
    out = _run(handler, '{"type":"start_mapping","options":{"ledCount":64}}')
    m = _dump(out[0])
    assert m["type"] == "mapping_started"
    assert m["codeParams"]["ledCount"] == 64
    # 7 data bits (ceil(log2(64+1)), id+1 codewords) + SEC-DED parity = 12.
    assert m["codeParams"]["fec"] == "secded"
    assert m["codeParams"]["bits"] == 12
    assert "patternClockEpoch" in m
    assert ctx.sessions.active is not None


def test_detections_require_active_session(tmp_path):
    handler, _ctx, _ = _make_handler(tmp_path)
    det = {
        "ledId": 0,
        "tCaptureMs": 0.0,
        "u": 1.0,
        "v": 2.0,
        "imgW": 100,
        "imgH": 100,
        "K": [9.0, 9.0, 5.0, 5.0],
        "pose": {"p": [0, 0, 0], "q": [0, 0, 0, 1]},
        "confidence": 1.0,
    }
    raw = json.dumps({"type": "detections", "batch": [det]})

    # Before start_mapping → error.
    err = _dump(_run(handler, raw)[0])
    assert err["type"] == "error" and err["code"] == "no_session"

    # After start_mapping → accepted (no response), reflected in status.
    _run(handler, '{"type":"start_mapping","options":{"ledCount":4}}')
    assert _run(handler, raw) == []
    status = _dump(_run(handler, '{"type":"get_status"}')[0])
    assert status["type"] == "status"
    assert status["total"] == 4
    assert status["lowParallax"] == 1  # one LED seen once


def test_get_pattern_idle_reports_inactive_with_default_codebook(tmp_path):
    handler, _ctx, _ = _make_handler(tmp_path)
    m = _dump(_run(handler, '{"type":"get_pattern"}')[0])
    assert m["type"] == "pattern_state"
    assert m["active"] is False
    assert m["patternClockEpoch"] is None
    assert m["codeParams"]["ledCount"] == 512  # server default


def test_get_pattern_active_reports_session_epoch_and_led_count(tmp_path):
    handler, _ctx, _ = _make_handler(tmp_path)
    started = _dump(_run(handler, '{"type":"start_mapping","options":{"ledCount":64}}')[0])
    # A second connection (e.g. the virtual LED wall) polls the pattern state
    # and must see the same clock the phone was handed.
    wall = ConnectionHandler(_ctx)
    m = _dump(_run(wall, '{"type":"get_pattern"}')[0])
    assert m["type"] == "pattern_state"
    assert m["active"] is True
    assert m["patternClockEpoch"] == started["patternClockEpoch"]
    assert m["codeParams"] == started["codeParams"]


def test_get_pattern_after_stop_reports_inactive(tmp_path):
    handler, _ctx, _ = _make_handler(tmp_path)
    _run(handler, '{"type":"start_mapping","options":{"ledCount":4}}')
    _run(handler, '{"type":"stop_mapping"}')
    m = _dump(_run(handler, '{"type":"get_pattern"}')[0])
    assert m["active"] is False and m["patternClockEpoch"] is None


def _detections_raw(led_id=0):
    det = {
        "ledId": led_id,
        "tCaptureMs": 0.0,
        "u": 1.0,
        "v": 2.0,
        "imgW": 100,
        "imgH": 100,
        "K": [9.0, 9.0, 5.0, 5.0],
        "pose": {"p": [0, 0, 0], "q": [0, 0, 0, 1]},
        "confidence": 1.0,
    }
    return json.dumps({"type": "detections", "batch": [det]})


def test_get_live_map_idle_reports_inactive(tmp_path):
    solve_calls = []
    solver = LiveSolver(
        lambda d, n, s, prev_map=None, imu=(): solve_calls.append(len(d)) or _stub_map()
    )
    handler, _ctx, _ = _make_handler(tmp_path, live_solver=solver)
    m = _dump(_run(handler, '{"type":"get_live_map"}')[0])
    assert m["type"] == "live_map"
    assert m["active"] is False and m["map"] is None
    assert solve_calls == []  # nothing to solve when idle


def test_get_live_map_solves_continuously_single_flight(tmp_path):
    solve_calls = []

    def stub_solve(detections, led_count, session_id, prev_map=None, imu=()):
        solve_calls.append((len(detections), led_count, session_id))
        return _stub_map()

    solver = LiveSolver(stub_solve)
    handler, _ctx, _ = _make_handler(tmp_path, live_solver=solver)
    _run(handler, '{"type":"start_mapping","options":{"ledCount":4}}')

    # Active but no detections yet: nothing to solve.
    m = _dump(_run(handler, '{"type":"get_live_map"}')[0])
    assert m["active"] is True and m["map"] is None
    assert solve_calls == []

    # Detections arrive → the poll kicks a solve; its result shows up on a
    # later poll (never blocks the reply).
    _run(handler, _detections_raw(0))
    m = _dump(_run(handler, '{"type":"get_live_map"}')[0])
    assert m["active"] is True
    solver.flush()
    m = _dump(_run(handler, '{"type":"get_live_map"}')[0])
    assert m["map"] is not None and m["map"]["mapId"] == "map-stub"
    assert solve_calls == [(1, 4, "sess-fixed")]

    # No new detections → no re-solve; the cached interim map is reused.
    m = _dump(_run(handler, '{"type":"get_live_map"}')[0])
    assert m["map"]["mapId"] == "map-stub"
    assert len(solve_calls) == 1

    # New detections → exactly one more solve.
    _run(handler, _detections_raw(1))
    _run(handler, '{"type":"get_live_map"}')
    solver.flush()
    _run(handler, '{"type":"get_live_map"}')
    assert len(solve_calls) == 2 and solve_calls[1][0] == 2


def test_get_live_map_survives_solve_failure(tmp_path):
    calls = []

    def flaky_solve(detections, led_count, session_id, prev_map=None, imu=()):
        calls.append(len(detections))
        if len(calls) == 1:
            raise ValueError("degenerate geometry")
        return _stub_map()

    solver = LiveSolver(flaky_solve)
    handler, _ctx, _ = _make_handler(tmp_path, live_solver=solver)
    _run(handler, '{"type":"start_mapping","options":{"ledCount":4}}')
    _run(handler, _detections_raw(0))
    _run(handler, '{"type":"get_live_map"}')
    solver.flush()
    # Failed solve → still no map, but no error either (best-effort).
    m = _dump(_run(handler, '{"type":"get_live_map"}')[0])
    assert m["active"] is True and m["map"] is None
    # New detections trigger a retry that succeeds.
    _run(handler, _detections_raw(1))
    _run(handler, '{"type":"get_live_map"}')
    solver.flush()
    m = _dump(_run(handler, '{"type":"get_live_map"}')[0])
    assert m["map"] is not None


def test_live_decimation_bounds_views_and_keeps_pose_spread():
    def rec(led_id, t):
        return DetectionRecord(
            ledId=led_id,
            tCaptureMs=float(t),
            u=1.0,
            v=2.0,
            imgW=100,
            imgH=100,
            K=(9.0, 9.0, 5.0, 5.0),
            pose={"p": (float(t), 0.0, 0.0), "q": (0.0, 0.0, 0.0, 1.0)},
            confidence=1.0,
        )

    # LED 0: 40 obs; LED 1: 3 obs (below the cap); interleaved arrival.
    detections = [rec(0, t) for t in range(40)] + [rec(1, t) for t in range(3)]
    out = _decimate_per_led(detections, 8)
    by_led = {}
    for d in out:
        by_led.setdefault(d.ledId, []).append(d)
    assert len(by_led[0]) == 8
    assert len(by_led[1]) == 3  # untouched below the cap
    times = [d.tCaptureMs for d in by_led[0]]
    # Even stride: first and last observations survive (full parallax span),
    # samples strictly chronological and roughly uniform.
    assert times[0] == 0.0 and times[-1] == 39.0
    assert times == sorted(times) and len(set(times)) == 8
    gaps = [b - a for a, b in zip(times, times[1:])]
    assert max(gaps) - min(gaps) <= 2.0


def test_get_live_map_resets_after_stop(tmp_path):
    solver = LiveSolver(lambda d, n, s, prev_map=None, imu=(): _stub_map())
    handler, _ctx, _ = _make_handler(tmp_path, live_solver=solver)
    _run(handler, '{"type":"start_mapping","options":{"ledCount":4}}')
    _run(handler, _detections_raw(0))
    _run(handler, '{"type":"get_live_map"}')
    solver.flush()
    assert _dump(_run(handler, '{"type":"get_live_map"}')[0])["map"] is not None
    _run(handler, '{"type":"stop_mapping"}')
    m = _dump(_run(handler, '{"type":"get_live_map"}')[0])
    assert m["active"] is False and m["map"] is None


def test_stop_triggers_reconstruction_and_result_ready(tmp_path):
    handler, _ctx, recon_calls = _make_handler(tmp_path)
    _run(handler, '{"type":"start_mapping","options":{"ledCount":4}}')
    out = _run(handler, '{"type":"stop_mapping"}')
    m = _dump(out[0])
    assert m["type"] == "result_ready"
    assert m["mapId"] == "map-stub"
    assert len(recon_calls) == 1  # reconstructor was invoked with the log path


def test_second_capture_on_one_connection_gets_its_own_log(tmp_path):
    # A page that isn't reloaded runs many captures over one socket; each
    # must persist to a distinct log (a shared id silently overwrote the
    # earlier capture — observed live 2026-07-05).
    handler, ctx, _ = _make_handler(tmp_path)
    _run(handler, '{"type":"start_mapping","options":{"ledCount":4}}')
    _run(handler, _detections_raw(0))
    _run(handler, '{"type":"stop_mapping"}')
    _run(handler, '{"type":"start_mapping","options":{"ledCount":4}}')
    _run(handler, _detections_raw(1))
    _run(handler, '{"type":"stop_mapping"}')
    logs = sorted(p.name for p in (ctx.sessions.session_dir).glob("*.json"))
    assert logs == ["sess-fixed-2.json", "sess-fixed.json"]
    first = json.loads((ctx.sessions.session_dir / "sess-fixed.json").read_text())
    second = json.loads((ctx.sessions.session_dir / "sess-fixed-2.json").read_text())
    assert first["detections"][0]["ledId"] == 0
    assert second["detections"][0]["ledId"] == 1


def test_stop_without_session_errors(tmp_path):
    handler, _ctx, _ = _make_handler(tmp_path)
    err = _dump(_run(handler, '{"type":"stop_mapping"}')[0])
    assert err["type"] == "error" and err["code"] == "no_session"


def test_malformed_message_returns_error(tmp_path):
    handler, _ctx, _ = _make_handler(tmp_path)
    err = _dump(_run(handler, '{"type":"nonsense"}')[0])
    assert err["type"] == "error" and err["code"] == "bad_message"

    bad_json = _dump(_run(handler, "not json at all")[0])
    assert bad_json["type"] == "error" and bad_json["code"] == "bad_message"


# ---------------------------------------------------------------------------
# Client-driven configuration (§7.1 start_mapping options / configure) and
# exposure telemetry. The client measured the scene; the server adopts its
# choices — no CLI flags are needed for any alphabet/rate.
# ---------------------------------------------------------------------------


def test_start_mapping_adopts_client_symbols_and_rate(tmp_path):
    handler, _ctx, _ = _make_handler(tmp_path)
    out = _run(
        handler,
        '{"type":"start_mapping","options":{"ledCount":64,"symbols":4,"bitPeriodMs":200}}',
    )
    m = _dump(out[0])
    assert m["type"] == "mapping_started"
    assert m["codeParams"]["symbols"] == 4
    assert m["codeParams"]["bitPeriodMs"] == 200
    assert m["codeParams"]["ledCount"] == 64
    # 4 symbols halve the data frames: 12 SEC-DED bits -> 6 frames + sync.
    assert m["codeParams"]["cycleFrames"] == 8
    # Followers see the same client-chosen code-book.
    p = _dump(_run(handler, '{"type":"get_pattern"}')[0])
    assert p["active"] is True and p["codeParams"] == m["codeParams"]


def test_start_mapping_without_options_uses_server_defaults(tmp_path):
    handler, _ctx, _ = _make_handler(tmp_path)
    m = _dump(_run(handler, '{"type":"start_mapping","options":{"ledCount":64}}')[0])
    assert m["codeParams"]["symbols"] == 2  # ctx default
    assert m["codeParams"]["bitPeriodMs"] == 100.0  # ctx default


def test_configure_renegotiates_mid_capture(tmp_path):
    handler, ctx, _ = _make_handler(tmp_path)
    _run(handler, '{"type":"start_mapping","options":{"ledCount":4}}')
    _run(handler, _detections_raw(0))

    out = _run(handler, '{"type":"configure","options":{"bitPeriodMs":200,"symbols":4}}')
    m = _dump(out[0])
    assert m["type"] == "pattern_state" and m["active"] is True
    # Unset fields keep the capture's values; set fields overlay.
    assert m["codeParams"]["ledCount"] == 4
    assert m["codeParams"]["bitPeriodMs"] == 200
    assert m["codeParams"]["symbols"] == 4
    # The pattern epoch is restamped so all parties re-anchor the cycle.
    assert m["patternClockEpoch"] is not None

    # Followers polling get_pattern see the new code-book immediately.
    p = _dump(_run(handler, '{"type":"get_pattern"}')[0])
    assert p["codeParams"] == m["codeParams"]
    assert p["patternClockEpoch"] == m["patternClockEpoch"]

    # Detections from before the renegotiation are preserved in the log.
    _run(handler, '{"type":"stop_mapping"}')
    log = json.loads((ctx.sessions.session_dir / "sess-fixed.json").read_text())
    assert len(log["detections"]) == 1
    assert log["codeParams"]["bitPeriodMs"] == 200


def test_configure_without_session_errors(tmp_path):
    handler, _ctx, _ = _make_handler(tmp_path)
    err = _dump(_run(handler, '{"type":"configure","options":{"bitPeriodMs":200}}')[0])
    assert err["type"] == "error" and err["code"] == "no_session"


def _exposure_raw(t=1.0, interval=33.3):
    return json.dumps(
        {
            "type": "exposure_report",
            "report": {
                "tCaptureMs": t,
                "frameIntervalMs": interval,
                "meanLuma": 0.05,
                "p95Luma": 0.2,
                "clipFrac": 0.001,
                "blobCount": 8,
                "detectorThreshold": 0.6,
            },
        }
    )


def test_exposure_reports_logged_with_session(tmp_path):
    handler, ctx, _ = _make_handler(tmp_path)
    # Telemetry when idle is silently dropped (no error, no reply).
    assert _run(handler, _exposure_raw()) == []

    _run(handler, '{"type":"start_mapping","options":{"ledCount":4}}')
    assert _run(handler, _exposure_raw(1.0)) == []
    assert _run(handler, _exposure_raw(2.0, interval=66.7)) == []
    _run(handler, _detections_raw(0))
    _run(handler, '{"type":"stop_mapping"}')

    log = json.loads((ctx.sessions.session_dir / "sess-fixed.json").read_text())
    assert [e["tCaptureMs"] for e in log["exposure"]] == [1.0, 2.0]
    assert log["exposure"][1]["frameIntervalMs"] == 66.7


# ---------------------------------------------------------------------------
# WebXR-free capture path (§7.1 imu_batch + pose-less records) — phase 4 of
# docs/vio-exploration.md.
# ---------------------------------------------------------------------------


def _imu_batch_raw(t0=0.0, n=3):
    return json.dumps(
        {
            "type": "imu_batch",
            "samples": [
                {
                    "t": t0 + i * 16.7,
                    "gyro": [0.01, -0.02, 0.005],
                    "accel": [0.1, 9.75, -0.3],
                }
                for i in range(n)
            ],
        }
    )


def _poseless_detections_raw(led_id=0, t=1.0):
    return json.dumps(
        {
            "type": "detections",
            "batch": [
                {
                    "ledId": led_id,
                    "tCaptureMs": t,
                    "u": 100.0,
                    "v": 100.0,
                    "imgW": 1280,
                    "imgH": 720,
                    "K": [900.0, 900.0, 640.0, 360.0],
                    "pose": None,
                    "confidence": 1.0,
                }
            ],
        }
    )


def test_imu_batches_and_poseless_records_persist_in_the_log(tmp_path):
    handler, ctx, _ = _make_handler(tmp_path)
    # IMU when idle is dropped silently (races stop like exposure telemetry).
    assert _run(handler, _imu_batch_raw()) == []

    _run(handler, '{"type":"start_mapping","options":{"ledCount":4}}')
    assert _run(handler, _imu_batch_raw(0.0)) == []
    assert _run(handler, _imu_batch_raw(50.0)) == []
    assert _run(handler, _poseless_detections_raw(0)) == []
    _run(handler, '{"type":"stop_mapping"}')

    log = json.loads((ctx.sessions.session_dir / "sess-fixed.json").read_text())
    assert len(log["imu"]) == 6
    assert log["imu"][0]["gyro"] == [0.01, -0.02, 0.005]
    assert log["detections"][0]["pose"] is None


def test_snapshot_carries_imu_for_the_live_solver(tmp_path):
    handler, ctx, _ = _make_handler(tmp_path)
    _run(handler, '{"type":"start_mapping","options":{"ledCount":4}}')
    _run(handler, _imu_batch_raw())
    snap = ctx.sessions.snapshot()
    assert snap is not None
    _sid, _n, _dets, imu = snap
    assert len(imu) == 3


def test_get_solve_status_idle_and_running(tmp_path):
    handler, ctx, _ = _make_handler(tmp_path)
    m = _dump(_run(handler, '{"type":"get_solve_status"}')[0])
    assert m["type"] == "solve_status"
    assert m == {
        "type": "solve_status",
        "running": False,
        "progress": None,
        "rmsPx": None,
        "leds": None,
        "trajectory": None,
    }

    # A running solve exposes the optimizer's latest snapshot through the
    # reconstructor's poll-visible status (ReconstructionRunner contract).
    ctx.reconstructor.status = {
        "running": True,
        "progress": 0.42,
        "rmsPx": 3.1,
        "leds": [{"id": 0, "xyz": [0.1, 0.2, 0.3]}],
        "trajectory": [[0.0, 0.0, 0.0], [0.05, 0.0, -0.01]],
    }
    m = _dump(_run(handler, '{"type":"get_solve_status"}')[0])
    assert m["running"] is True and m["progress"] == 0.42
    assert m["leds"][0]["id"] == 0
    assert len(m["trajectory"]) == 2


# -- solver placement (stop_mapping.solveOnHost / submit_map) ---------------


def _start_and_feed(handler):
    _run(handler, '{"type":"start_mapping","options":{"ledCount":4}}')
    rec = {
        "ledId": 1,
        "tCaptureMs": 1.0,
        "u": 10.0,
        "v": 20.0,
        "imgW": 1280,
        "imgH": 720,
        "K": [800.0, 800.0, 640.0, 360.0],
        "pose": None,
        "confidence": 0.9,
    }
    _run(handler, json.dumps({"type": "detections", "batch": [rec]}))
    _run(
        handler,
        json.dumps(
            {
                "type": "imu_batch",
                "samples": [{"t": 1.0, "gyro": [0, 0, 0], "accel": [0, 9.8, 0]}],
            }
        ),
    )


def test_welcome_carries_solver_bench_score(tmp_path):
    handler, ctx, _ = _make_handler(tmp_path)
    m = _dump(_run(handler, '{"type":"hello","client":"c","appVersion":"1"}')[0])
    assert m["solverBenchMs"] is None  # not measured yet
    ctx.solver_bench_ms = 123.4
    m = _dump(_run(handler, '{"type":"hello","client":"c","appVersion":"1"}')[0])
    assert m["solverBenchMs"] == 123.4


def test_stop_without_host_solve_persists_but_skips_reconstruction(tmp_path):
    handler, _ctx, recon_calls = _make_handler(tmp_path)
    _start_and_feed(handler)
    out = _run(handler, '{"type":"stop_mapping","solveOnHost":false}')
    m = _dump(out[0])
    assert m["type"] == "mapping_stopped"
    assert m["detections"] == 1
    assert m["imuSamples"] == 1
    assert recon_calls == []  # no host solve ran


def test_submit_map_persists_and_acks_result_ready(tmp_path):
    from server.session import MapStore

    handler, ctx, _ = _make_handler(tmp_path)
    ctx.map_store = MapStore(tmp_path / "maps")
    out = _run(handler, json.dumps({"type": "submit_map", "map": _stub_map().model_dump()}))
    m = _dump(out[0])
    assert m["type"] == "result_ready"
    assert m["mapId"] == "map-stub"
    assert ctx.map_store.exists("map-stub")


def test_submit_map_without_store_errors(tmp_path):
    handler, _ctx, _ = _make_handler(tmp_path)
    m = _dump(_run(handler, json.dumps({"type": "submit_map", "map": _stub_map().model_dump()}))[0])
    assert m["type"] == "error"
    assert m["code"] == "unsupported"


# -- player protocol (counting / topology / playback, §7.7–§7.9) ------------


def test_set_counting_pattern_latches_and_acks(tmp_path):
    handler, ctx, _ = _make_handler(tmp_path, clock_value=4321.0)
    raw = json.dumps(
        {
            "type": "set_counting_pattern",
            "blocks": [{"start": 0, "count": 32, "rgb": [1.0, 0.0, 0.0]}],
            "channel": 1,
        }
    )
    m = _dump(_run(handler, raw)[0])
    assert m == {"type": "counting_state", "active": True, "epochMs": 4321.0}
    epoch, blocks, channel = ctx.counting
    assert epoch == 4321.0
    assert channel == 1
    assert blocks[0].count == 32


def test_set_counting_pattern_empty_blocks_clears(tmp_path):
    handler, ctx, _ = _make_handler(tmp_path)
    _run(handler, '{"type":"set_counting_pattern","blocks":[{"start":0,"count":1,"rgb":[0,1,0]}]}')
    m = _dump(_run(handler, '{"type":"set_counting_pattern","blocks":[]}')[0])
    assert m == {"type": "counting_state", "active": False, "epochMs": None}
    assert ctx.counting is None


def test_set_led_count_persists_and_defaults_channel_zero(tmp_path):
    handler, ctx, _ = _make_handler(tmp_path)
    m = _dump(_run(handler, '{"type":"set_led_count","ledCount":300}')[0])
    assert m == {"type": "led_count_state", "ledCount": 300, "channel": 0}
    # Channel 0 becomes the fallback code-book ledCount...
    assert ctx.default_led_count == 300
    welcome = _dump(_run(handler, '{"type":"hello","client":"c","appVersion":"1"}')[0])
    assert welcome["codeParams"]["ledCount"] == 300
    # ...while other channels are recorded without touching the default.
    m = _dump(_run(handler, '{"type":"set_led_count","ledCount":150,"channel":1}')[0])
    assert m == {"type": "led_count_state", "ledCount": 150, "channel": 1}
    assert ctx.default_led_count == 300
    assert ctx.led_counts == {0: 300, 1: 150}


def _stub_topology(map_id="map-stub"):
    return {
        "mapId": map_id,
        "branchPoints": [{"id": 0, "xyz": [0.0, 0.0, 0.0]}],
        "segments": [
            {
                "id": 0,
                "a": 0,
                "b": -1,
                "polyline": [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0]],
                "length": 1.0,
            }
        ],
        "associations": [{"ledId": 0, "segmentId": 0, "footArclength": 0.5, "dPerp": 0.01}],
    }


def test_submit_topology_persists_next_to_its_map(tmp_path):
    from server.session import MapStore

    handler, ctx, _ = _make_handler(tmp_path)
    ctx.map_store = MapStore(tmp_path / "maps")
    ctx.map_store.save(_stub_map())
    out = _run(handler, json.dumps({"type": "submit_topology", "topology": _stub_topology()}))
    m = _dump(out[0])
    assert m == {"type": "result_ready", "mapId": "map-stub"}
    saved = json.loads(ctx.map_store.topology_path("map-stub").read_text())
    assert saved["segments"][0]["length"] == 1.0


def test_submit_topology_for_unknown_map_errors(tmp_path):
    from server.session import MapStore

    handler, ctx, _ = _make_handler(tmp_path)
    ctx.map_store = MapStore(tmp_path / "maps")
    out = _run(handler, json.dumps({"type": "submit_topology", "topology": _stub_topology("nope")}))
    m = _dump(out[0])
    assert m["type"] == "error"
    assert m["code"] == "unknown_map"


def test_playback_off_is_universal_other_effects_unsupported_until_phase_g(tmp_path):
    handler, _ctx, _ = _make_handler(tmp_path)
    state = _dump(_run(handler, '{"type":"get_playback"}')[0])
    assert state["type"] == "playback_state"
    assert state["active"] is False
    assert state["effect"] == "off"
    ok = _dump(_run(handler, '{"type":"set_playback","effect":"off"}')[0])
    assert ok["type"] == "playback_state"
    err = _dump(_run(handler, '{"type":"set_playback","effect":"pulse"}')[0])
    assert err["type"] == "error"
    assert err["code"] == "unsupported_effect"
