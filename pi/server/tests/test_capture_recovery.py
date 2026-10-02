"""Large or interrupted captures do not lose the user's work on the host (PR-31).

The capture is the expensive part — a long walk around the fixture — so the host
keeps it independent of the solve and of the phone's connection:

  * the session log (every detection + IMU sample) is written BEFORE the final
    solve runs, so a solve that dies leaves a complete log behind, and that log
    reconstructs offline with the M3 CLI — no device or re-capture needed;
  * a phone whose socket drops mid-capture reconnects into the SAME capture (the
    session belongs to the server, not to the connection);
  * a phone that vanishes while the final solve runs does not cancel it: the
    solve finishes and its map is persisted; only the late reply is lost.

Every test verifies PR-31 only (see requirements/requirements.yaml).
"""

import asyncio
import json
import threading

import numpy as np
import pytest
from ledmapper_protocol import DetectionRecord, ImuSample, LedEntry, OutputMap, OutputMapStats
from reconstruction import look_at_quat, project
from reconstruction.__main__ import main as reconstruct_cli
from server import proto_wire
from server import reconstruct as recon_mod
from server.app import create_app
from server.handler import ConnectionHandler, ServerContext
from server.reconstruct import ReconstructionRunner
from server.session import MapStore, SessionManager

K = [900.0, 900.0, 640.0, 360.0]
_GATE_TIMEOUT_S = 10.0


def _fixture_points(n: int = 12) -> np.ndarray:
    """A small 3D LED cloud (a loose helix) around the origin."""
    t = np.linspace(0.0, 2.0 * np.pi, n, endpoint=False)
    return np.stack([0.25 * np.cos(t), 0.08 * t - 0.25, 0.25 * np.sin(t)], axis=1)


def _posed_detections(points: np.ndarray, n_views: int = 8) -> list:
    """Noise-free posed DetectionRecords (wire dicts) from an arc of viewpoints."""
    dets = []
    for v, a in enumerate(np.linspace(-0.9, 0.9, n_views)):
        eye = np.array([2.0 * np.sin(a), 0.3, 2.0 * np.cos(a)])
        q = look_at_quat(eye, points.mean(axis=0))
        for led_id, x in enumerate(points):
            uv, depth = project(eye, q, K, x)
            assert depth > 0
            dets.append(
                {
                    "ledId": led_id,
                    "tCaptureMs": float(v * 100),
                    "u": float(uv[0]),
                    "v": float(uv[1]),
                    "imgW": 1280,
                    "imgH": 720,
                    "K": list(K),
                    "pose": {"p": [float(c) for c in eye], "q": [float(c) for c in q]},
                    "confidence": 1.0,
                }
            )
    return dets


def _imu(t0: float, n: int = 5) -> list:
    return [
        {"t": t0 + i * 10.0, "gyro": [0.01, 0.0, -0.02], "accel": [0.1, 9.8, 0.0]} for i in range(n)
    ]


def _map(map_id: str) -> OutputMap:
    return OutputMap(
        mapId=map_id,
        createdAt="2026-01-01T00:00:00Z",
        units="meters",
        frame="webxr_session_ref",
        ledCount=1,
        leds=[
            LedEntry(
                id=0,
                xyz=(0.0, 0.0, 0.0),
                confidence=0.9,
                nViews=4,
                rmsReprojPx=0.5,
                parallaxDeg=20.0,
            )
        ],
        unmapped=[],
        stats=OutputMapStats(rmsReprojPxGlobal=0.5, medianParallaxDeg=20.0),
    )


def _ctx(tmp_path, reconstructor, map_store=None, ids=("capture-1",)):
    it = iter(ids)
    return ServerContext(
        SessionManager(tmp_path / "sessions"),
        reconstructor,
        default_led_count=64,
        bit_period_ms=100.0,
        id_factory=lambda: next(it),
        clock=lambda: 1000.0,
        map_store=map_store,
    )


def _send(handler, msg: dict) -> list:
    return [
        json.loads(m.model_dump_json())
        for m in asyncio.run(handler.handle(json.dumps(msg), recv_ms=1.0))
    ]


async def _dying_solver(log_path):
    raise RuntimeError("socket closed")  # e.g. the solve died with the device link


def _stream_capture(handler, detections: list, batch: int = 10) -> list:
    """start_mapping + the capture as the phone streams it: detection batches
    interleaved with IMU batches. Returns the IMU samples sent."""
    _send(
        handler,
        {"type": "start_mapping", "options": {"ledCount": 1 + max(d["ledId"] for d in detections)}},
    )
    imu = []
    for i in range(0, len(detections), batch):
        assert _send(handler, {"type": "detections", "batch": detections[i : i + batch]}) == []
        samples = _imu(float(i))
        imu.extend(samples)
        assert _send(handler, {"type": "imu_batch", "samples": samples}) == []
    return imu


@pytest.mark.requirements("PR-31")
@pytest.mark.parametrize(
    "n_leds,n_views,batch",
    [(12, 8, 10), (1024, 8, 128)],  # a small fixture, and a large 1024-LED capture
)
def test_failed_host_solve_leaves_the_complete_capture_on_disk(tmp_path, n_leds, n_views, batch):
    ctx = _ctx(tmp_path, _dying_solver)
    handler = ConnectionHandler(ctx)
    detections = _posed_detections(_fixture_points(n_leds), n_views=n_views)
    imu = _stream_capture(handler, detections, batch=batch)

    (err,) = _send(handler, {"type": "stop_mapping"})
    assert err["type"] == "error" and err["code"] == "reconstruction_failed"

    log = json.loads((ctx.sessions.session_dir / "capture-1.json").read_text())
    assert log["ledCount"] == n_leds
    assert len(log["detections"]) == n_leds * n_views
    assert [DetectionRecord.model_validate(d) for d in log["detections"]] == [
        DetectionRecord.model_validate(d) for d in detections
    ]
    assert [ImuSample.model_validate(s) for s in log["imu"]] == [
        ImuSample.model_validate(s) for s in imu
    ]


@pytest.mark.requirements("PR-31")
def test_capture_left_by_a_failed_solve_reconstructs_offline_from_its_log(tmp_path):
    ctx = _ctx(tmp_path, _dying_solver)
    handler = ConnectionHandler(ctx)
    truth = _fixture_points()
    _stream_capture(handler, _posed_detections(truth))
    assert _send(handler, {"type": "stop_mapping"})[0]["code"] == "reconstruction_failed"

    # Recover the map from the persisted log alone (no device, no re-capture).
    out = tmp_path / "recovered.json"
    assert reconstruct_cli([str(ctx.sessions.session_dir / "capture-1.json"), "-o", str(out)]) == 0
    recovered = OutputMap.model_validate_json(out.read_text())
    assert recovered.ledCount == len(truth) and recovered.unmapped == []
    err_mm = [np.linalg.norm(np.asarray(e.xyz) - truth[e.id]) * 1000.0 for e in recovered.leds]
    assert len(err_mm) == len(truth) and max(err_mm) < 1.0


@pytest.mark.requirements("PR-31")
def test_phone_reconnecting_mid_capture_keeps_adding_to_the_same_capture(tmp_path):
    ctx = _ctx(tmp_path, _dying_solver, ids=("conn-a", "conn-b"))
    detections = _posed_detections(_fixture_points())
    half = len(detections) // 2

    first = ConnectionHandler(ctx)
    _send(first, {"type": "start_mapping", "options": {"ledCount": 12}})
    assert _send(first, {"type": "detections", "batch": detections[:half]}) == []

    # The phone's socket drops; it reconnects (new connection, new hello) and
    # flushes the batches it queued while it was down.
    second = ConnectionHandler(ctx)
    (hello,) = _send(second, {"type": "hello", "client": "android-web", "appVersion": "1"})
    assert hello["type"] == "welcome"
    assert _send(second, {"type": "detections", "batch": detections[half:]}) == []
    status = _send(second, {"type": "get_status"})[0]
    assert (status["identified"], status["total"]) == (12, 12)

    (stopped,) = _send(second, {"type": "stop_mapping", "solveOnHost": False})
    assert stopped["detections"] == len(detections)
    logs = sorted(p.name for p in ctx.sessions.session_dir.glob("*.json"))
    assert logs == ["conn-a.json"], "one capture, not two half-captures"
    log = json.loads((ctx.sessions.session_dir / "conn-a.json").read_text())
    assert [(d["ledId"], d["tCaptureMs"]) for d in log["detections"]] == [
        (d["ledId"], d["tCaptureMs"]) for d in detections
    ]


class _PhoneThatDropsMidSolve:
    """Starlette-WebSocket stand-in: delivers the phone's frames, then
    disconnects once the final solve is running; sends after that fail like a
    closed socket's."""

    def __init__(self, frames: list, solve_started: threading.Event):
        self.frames = list(frames)
        self.solve_started = solve_started
        self.received: list = []
        self.closed = False

    async def accept(self) -> None:
        pass

    async def receive(self) -> dict:
        await asyncio.sleep(0)  # let the dispatched frames run, as a real socket would
        if self.frames:
            return {"type": "websocket.receive", "bytes": self.frames.pop(0)}
        started = await asyncio.to_thread(self.solve_started.wait, _GATE_TIMEOUT_S)
        assert started, "final solve never started"
        self.closed = True
        return {"type": "websocket.disconnect"}

    async def send_bytes(self, data: bytes) -> None:
        if self.closed:
            raise RuntimeError('Cannot call "send" once a close message has been sent.')
        self.received.append(proto_wire.decode_server(data)["type"])


@pytest.mark.requirements("PR-31")
def test_phone_dropping_during_the_final_solve_still_gets_the_map_persisted(tmp_path, monkeypatch):
    solve_started, release = threading.Event(), threading.Event()

    def slow_solve(log_path, progress_cb=None, status_cb=None):
        solve_started.set()
        assert release.wait(_GATE_TIMEOUT_S), "test never released the solve"
        return _map("solved-after-the-drop")

    monkeypatch.setattr(recon_mod, "_reconstruct_sync", slow_solve)
    store = MapStore(tmp_path / "maps")
    ctx = _ctx(tmp_path, ReconstructionRunner(store), map_store=store)
    app = create_app(session_dir=tmp_path / "sessions", maps_dir=tmp_path / "maps", context=ctx)
    (ws_route,) = [r for r in app.routes if getattr(r, "path", None) == "/ws"]

    detections = _posed_detections(_fixture_points(), n_views=3)
    frames = [
        proto_wire.encode_client(m)
        for m in (
            {"type": "hello", "client": "android-web", "app_version": "1"},
            {"type": "start_mapping", "options": {"led_count": 12}},
            {"type": "detections", "batch": detections},
            {"type": "stop_mapping"},
        )
    ]
    phone = _PhoneThatDropsMidSolve(frames, solve_started)

    async def scenario() -> None:
        await ws_route.endpoint(phone)  # returns at the disconnect, solve still running
        assert not store.exists("solved-after-the-drop")
        release.set()
        others = [t for t in asyncio.all_tasks() if t is not asyncio.current_task()]
        await asyncio.gather(*others)

    asyncio.run(scenario())

    assert phone.received == ["welcome", "mapping_started"], "result_ready went to a closed socket"
    persisted = store.exists("solved-after-the-drop")
    assert persisted, "the solve finished and persisted without the phone"
    log = json.loads((tmp_path / "sessions" / "capture-1.json").read_text())
    assert len(log["detections"]) == len(detections)
