"""WebSocket message handler (design doc §7 contract)."""

import asyncio
import json

from ledmapper_protocol import OutputMap, OutputMapStats
from server.handler import ConnectionHandler, ServerContext
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


def _make_handler(tmp_path, *, clock_value=2000.0):
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
    assert m["codeParams"]["bits"] == 6
    assert "patternClockEpoch" in m
    assert ctx.sessions.active is not None


def test_detections_require_active_session(tmp_path):
    handler, _ctx, _ = _make_handler(tmp_path)
    det = {
        "ledId": 0, "tCaptureMs": 0.0, "u": 1.0, "v": 2.0, "imgW": 100, "imgH": 100,
        "K": [9.0, 9.0, 5.0, 5.0], "pose": {"p": [0, 0, 0], "q": [0, 0, 0, 1]}, "confidence": 1.0,
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


def test_stop_triggers_reconstruction_and_result_ready(tmp_path):
    handler, _ctx, recon_calls = _make_handler(tmp_path)
    _run(handler, '{"type":"start_mapping","options":{"ledCount":4}}')
    out = _run(handler, '{"type":"stop_mapping"}')
    m = _dump(out[0])
    assert m["type"] == "result_ready"
    assert m["mapId"] == "map-stub"
    assert len(recon_calls) == 1  # reconstructor was invoked with the log path


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
