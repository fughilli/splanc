"""End-to-end M2 integration (design doc §6 M2 acceptance, §9 Phase 0).

Boots a real uvicorn server, drives the full §7 WebSocket flow over a real
socket using simulator detections (no phone, no hardware), reconstructs, and
serves the resulting map over HTTP:

    hello → welcome
    time_sync_ping × N → time_sync_pong (offset/rtt sane)
    start_mapping → mapping_started
    detections … → (buffered)
    get_status → status (coverage > 0)
    stop_mapping → reconstruction → result_ready
    GET /healthz, GET /maps/{id}, GET /maps/{id}.csv

This is the server side of "a recorded detection session persists to disk and is
reconstructable" (§6 M2 acceptance).
"""

import contextlib
import json
import socket
import threading
import time
import urllib.error
import urllib.request

import pytest
import uvicorn
from server import proto_wire
from server.app import create_app
from simulator import generate_log
from websockets.sync.client import connect

# Traceability: PR(s) this suite verifies (see requirements/requirements.yaml).
pytestmark = pytest.mark.requirements("PR-11", "PR-13")


def _free_port() -> int:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


@contextlib.contextmanager
def _running_server(app, host="127.0.0.1", port=0):
    config = uvicorn.Config(app, host=host, port=port, log_level="warning")
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    try:
        # Wait until /healthz answers (or the thread dies).
        base = f"http://{host}:{port}"
        deadline = time.monotonic() + 15.0
        while time.monotonic() < deadline:
            if not thread.is_alive():
                raise RuntimeError("uvicorn thread exited during startup")
            try:
                with urllib.request.urlopen(base + "/healthz", timeout=1.0) as r:
                    if r.status == 200:
                        break
            except (urllib.error.URLError, ConnectionError, OSError):
                time.sleep(0.1)
        else:
            raise RuntimeError("server did not become healthy in time")
        yield base
    finally:
        server.should_exit = True
        thread.join(timeout=10.0)


def _http_get(url, timeout=10.0):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return r.status, r.read().decode()


def test_full_capture_flow(tmp_path):
    log, _truth = generate_log("cube", 64, seed=0)  # no-noise default
    detections = log["detections"]
    led_count = log["ledCount"]
    assert len(detections) > 100  # sanity: the walk saw plenty

    app = create_app(session_dir=tmp_path / "sessions", maps_dir=tmp_path / "maps")
    port = _free_port()

    with _running_server(app, port=port) as base:
        # /healthz is implied by startup, but assert it explicitly.
        status_code, body = _http_get(base + "/healthz")
        assert status_code == 200 and json.loads(body)["status"] == "ok"

        # Ground-truth relay: 404 before the wall publishes, roundtrip after.
        with pytest.raises(urllib.error.HTTPError) as no_truth:
            _http_get(base + "/truth")
        assert no_truth.value.code == 404
        truth = {
            "kind": "virtual_wall",
            "cols": 3,
            "rows": 2,
            "units": "led_pitch",
            "leds": [{"id": i, "xyz": [i % 3, i // 3, 0]} for i in range(4)],
        }
        req = urllib.request.Request(
            base + "/truth",
            data=json.dumps(truth).encode(),
            headers={"content-type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            assert r.status == 200
        code, body = _http_get(base + "/truth")
        assert code == 200 and json.loads(body) == truth

        ws_url = f"ws://127.0.0.1:{port}/ws"
        with connect(ws_url) as ws:
            # hello → welcome
            ws.send(
                proto_wire.encode_client({"type": "hello", "client": "test", "appVersion": "0"})
            )
            welcome = proto_wire.decode_server(ws.recv(timeout=10))
            assert welcome["type"] == "welcome"
            session_id = welcome["sessionId"]
            assert session_id

            # clock sync: a few rounds; min-RTT sample should be sane.
            best_rtt = None
            for i in range(5):
                t0 = float(i)
                ws.send(proto_wire.encode_client({"type": "time_sync_ping", "t0": t0}))
                pong = proto_wire.decode_server(ws.recv(timeout=10))
                assert pong["type"] == "time_sync_pong"
                assert pong["t0"] == t0
                assert pong["t1"] <= pong["t2"]  # server recv ≤ send
                rtt = pong["t2"] - pong["t1"]
                best_rtt = rtt if best_rtt is None else min(best_rtt, rtt)
            assert best_rtt is not None and best_rtt >= 0.0

            # start_mapping → mapping_started
            ws.send(
                proto_wire.encode_client(
                    {"type": "start_mapping", "options": {"ledCount": led_count}}
                )
            )
            started = proto_wire.decode_server(ws.recv(timeout=10))
            assert started["type"] == "mapping_started"
            assert started["codeParams"]["ledCount"] == led_count
            assert "patternClockEpoch" in started

            # stream detections in batches (no per-batch response by contract)
            for chunk in _batches(detections, 400):
                ws.send(proto_wire.encode_client({"type": "detections", "batch": chunk}))

            # get_status → status reflects coverage
            ws.send(proto_wire.encode_client({"type": "get_status"}))
            st = proto_wire.decode_server(ws.recv(timeout=10))
            assert st["type"] == "status"
            assert st["total"] == led_count
            assert st["identified"] > 0

            # get_live_map: first poll kicks the continuous solver (reply is
            # immediate, map may still be null), then poll until the interim
            # map lands. Real solver, so give it time.
            ws.send(proto_wire.encode_client({"type": "get_live_map"}))
            live = proto_wire.decode_server(ws.recv(timeout=10))
            assert live["type"] == "live_map"
            assert live["active"] is True
            deadline = time.monotonic() + 60.0
            while live.get("map") is None and time.monotonic() < deadline:
                time.sleep(0.5)
                ws.send(proto_wire.encode_client({"type": "get_live_map"}))
                live = proto_wire.decode_server(ws.recv(timeout=10))
            assert live.get("map") is not None, "continuous solver produced no interim map"
            assert live.get("map")["ledCount"] == led_count
            assert len(live.get("map")["leds"]) >= int(0.8 * led_count)

            # stop_mapping → reconstruction runs → result_ready
            ws.send(proto_wire.encode_client({"type": "stop_mapping"}))
            result = proto_wire.decode_server(ws.recv(timeout=60))
            assert result["type"] == "result_ready"
            map_id = result["mapId"]
            assert map_id

        # The session log was persisted under session_dir.
        assert (tmp_path / "sessions" / f"{session_id}.json").is_file()

        # Map is served as JSON and CSV.
        code, body = _http_get(f"{base}/maps/{map_id}")
        assert code == 200
        out = json.loads(body)
        assert out["mapId"] == map_id
        assert out["ledCount"] == led_count
        # No-noise cube: the great majority of LEDs should be reconstructed.
        assert len(out["leds"]) >= int(0.8 * led_count)
        assert len(out["leds"]) + len(out["unmapped"]) == led_count

        code, csv_body = _http_get(f"{base}/maps/{map_id}.csv")
        assert code == 200
        assert csv_body.splitlines()[0] == "id,x,y,z,confidence,n_views"

        # Unknown map → 404.
        with pytest.raises(urllib.error.HTTPError) as ei:
            _http_get(f"{base}/maps/does-not-exist")
        assert ei.value.code == 404


def _batches(items, n):
    for i in range(0, len(items), n):
        yield items[i : i + n]
