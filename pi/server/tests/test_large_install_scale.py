"""Larger installations on the host server (PR-12): batching, scale-aware solving,
and recovery from interrupted reconstructions.

What a big fixture stresses on the M2 server, each pinned without a socket or a
real solver:

  * batching — a capture of a 1024-LED installation arrives as many small
    detection batches; every record lands in the one session, in order, and the
    live coverage counts scale with it;
  * scale-aware solving — interim (live) solves subsample each LED to a fixed
    view budget, so their cost stays flat however long the walk gets, while the
    final solve still sees every observation; a slow interim solve never stacks
    further solves behind it;
  * recovery-oriented handling of reconstruction interruptions — an interim
    solve orphaned by a stop is never adopted into the next capture, and a final
    solve that dies leaves the server idle and ready for the next capture.

Every test verifies PR-12 only (see requirements/requirements.yaml).
"""

import asyncio
import json
import threading
from collections import Counter

import pytest
from ledmapper_protocol import DetectionRecord, LedEntry, OutputMap, OutputMapStats
from server import reconstruct as recon_mod
from server.codebook import code_params_for
from server.handler import ConnectionHandler, ServerContext
from server.reconstruct import LIVE_MAX_VIEWS_PER_LED, LiveSolver, ReconstructionRunner
from server.session import MapStore, SessionManager

# The design-scale installation: the server's default code-book size and the
# firmware's two-channel ceiling (1024 LEDs across 2 channels).
BIG_LED_COUNT = 1024

# A worker-thread solve must never hang the suite if a regression breaks the
# release choreography below.
_GATE_TIMEOUT_S = 10.0


def _det(led_id: int, t: float = 0.0) -> dict:
    """A posed DetectionRecord (wire dict) for ``led_id`` captured at ``t`` ms."""
    return {
        "ledId": led_id,
        "tCaptureMs": t,
        "u": 100.0 + led_id % 7,
        "v": 200.0 + led_id % 5,
        "imgW": 1280,
        "imgH": 720,
        "K": [900.0, 900.0, 640.0, 360.0],
        "pose": {"p": [t * 1e-3, 0.0, 0.0], "q": [0.0, 0.0, 0.0, 1.0]},
        "confidence": 1.0,
    }


def _map(map_id: str, n_leds: int = 1) -> OutputMap:
    return OutputMap(
        mapId=map_id,
        createdAt="2026-01-01T00:00:00Z",
        units="meters",
        frame="webxr_session_ref",
        ledCount=n_leds,
        leds=[
            LedEntry(
                id=i,
                xyz=(0.01 * i, 0.0, 0.0),
                confidence=0.9,
                nViews=4,
                rmsReprojPx=0.5,
                parallaxDeg=20.0,
            )
            for i in range(n_leds)
        ],
        unmapped=[],
        stats=OutputMapStats(rmsReprojPxGlobal=0.5, medianParallaxDeg=20.0),
    )


def _handler(tmp_path, reconstructor, map_store=None):
    ctx = ServerContext(
        SessionManager(tmp_path / "sessions"),
        reconstructor,
        default_led_count=BIG_LED_COUNT,
        bit_period_ms=100.0,
        id_factory=lambda: "big-install",
        clock=lambda: 1000.0,
        map_store=map_store,
    )
    return ConnectionHandler(ctx), ctx


def _send(handler, msg: dict):
    return asyncio.run(handler.handle(json.dumps(msg), recv_ms=1000.0))


def _dump(msg) -> dict:
    return json.loads(msg.model_dump_json())


async def _unused_reconstructor(log_path):  # pragma: no cover - never awaited here
    raise AssertionError("no host solve expected")


@pytest.mark.requirements("PR-12")
def test_installation_scale_capture_streams_as_many_batches_into_one_ordered_session(tmp_path):
    handler, ctx = _handler(tmp_path, _unused_reconstructor)
    started = _dump(
        _send(handler, {"type": "start_mapping", "options": {"ledCount": BIG_LED_COUNT}})[0]
    )
    assert started["codeParams"]["ledCount"] == BIG_LED_COUNT

    # Two passes over the whole fixture (each LED seen twice -> triangulable),
    # delivered the way the phone streams them: many small batches, no acks.
    sent = [
        _det(led, t=float(pass_ * 10_000 + led))
        for pass_ in range(2)
        for led in range(BIG_LED_COUNT)
    ]
    batch = 16
    for i in range(0, len(sent), batch):
        assert _send(handler, {"type": "detections", "batch": sent[i : i + batch]}) == []

    status = _dump(_send(handler, {"type": "get_status"})[0])
    assert (status["identified"], status["total"], status["lowParallax"]) == (
        BIG_LED_COUNT,
        BIG_LED_COUNT,
        0,
    )

    stopped = _dump(_send(handler, {"type": "stop_mapping", "solveOnHost": False})[0])
    assert stopped == {"type": "mapping_stopped", "detections": len(sent), "imuSamples": 0}
    log = json.loads((ctx.sessions.session_dir / "big-install.json").read_text())
    assert log["ledCount"] == BIG_LED_COUNT
    # Every batch accumulated into the one log, in arrival order.
    assert [(d["ledId"], d["tCaptureMs"]) for d in log["detections"]] == [
        (d["ledId"], d["tCaptureMs"]) for d in sent
    ]


@pytest.mark.requirements("PR-12")
def test_interim_solve_input_stays_bounded_per_led_as_the_capture_grows(tmp_path, monkeypatch):
    seen = []

    def fake_reconstruct(detections, **kwargs):
        seen.append((list(detections), kwargs))
        return _map("solved")

    monkeypatch.setattr(recon_mod, "reconstruct", fake_reconstruct)
    n_leds = 64

    def session(views_per_led: int):
        return [
            DetectionRecord.model_validate(_det(led, t=float(v * 100 + led)))
            for v in range(views_per_led)
            for led in range(n_leds)
        ]

    # A short and a 4x longer walk: the interim solve sees the same bounded,
    # whole-fixture sample either way (its cost does not grow with the walk).
    for views in (40, 160):
        seen.clear()
        recon_mod._live_solve(session(views), n_leds, "live")
        ((live_input, live_kwargs),) = seen
        per_led = Counter(d.ledId for d in live_input)
        assert set(per_led) == set(range(n_leds)), "every LED stays in the interim sample"
        assert max(per_led.values()) == LIVE_MAX_VIEWS_PER_LED
        assert len(live_input) == n_leds * LIVE_MAX_VIEWS_PER_LED
        assert live_kwargs["led_count"] == n_leds

    # The final solve of the same long capture uses EVERY observation.
    log = tmp_path / "final.json"
    long_session = session(160)
    log.write_text(
        json.dumps({"ledCount": n_leds, "detections": [d.model_dump() for d in long_session]})
    )
    seen.clear()
    recon_mod._reconstruct_sync(log)
    ((final_input, final_kwargs),) = seen
    assert len(final_input) == len(long_session)
    assert final_kwargs["led_count"] == n_leds


@pytest.mark.requirements("PR-12")
def test_slow_interim_solve_on_a_growing_session_never_stacks_more_solves(tmp_path):
    gate = threading.Event()
    calls = []

    def slow_solve(detections, led_count, session_id, prev_map=None, imu=()):
        calls.append(len(detections))
        assert gate.wait(_GATE_TIMEOUT_S), "test never released the solve"
        return _map(f"solve-{len(calls)}")

    solver = LiveSolver(slow_solve)
    sessions = SessionManager(tmp_path / "sessions")
    sessions.start("walk", code_params_for(BIG_LED_COUNT))
    try:
        sessions.add_detections([DetectionRecord.model_validate(_det(i)) for i in range(32)])
        assert solver.poll(sessions) == (True, None)  # kicks solve #1 (blocks in the worker)

        # The walk goes on while solve #1 grinds: new batches + polls must not
        # queue more solves behind it.
        for b in range(1, 6):
            sessions.add_detections(
                [DetectionRecord.model_validate(_det(32 * b + i)) for i in range(32)]
            )
            assert solver.poll(sessions) == (True, None)
    finally:
        gate.set()
    solver.flush()
    assert calls == [32], "only the first solve ran while it was in flight"

    # Once it lands, ONE fresh solve picks up the whole current snapshot.
    active, interim = solver.poll(sessions)
    assert active is True and interim is not None and interim.mapId == "solve-1"
    solver.flush()
    assert calls == [32, 32 * 6]


@pytest.mark.requirements("PR-12")
def test_interim_solve_interrupted_by_stop_is_never_adopted_by_the_next_capture(tmp_path):
    gate = threading.Event()

    def solve(detections, led_count, session_id, prev_map=None, imu=()):
        if session_id == "capture-a":
            assert gate.wait(_GATE_TIMEOUT_S), "test never released capture A's solve"
        return _map(f"interim-{session_id}")

    solver = LiveSolver(solve)
    sessions = SessionManager(tmp_path / "sessions")
    sessions.start("capture-a", code_params_for(8))
    sessions.add_detections([DetectionRecord.model_validate(_det(i)) for i in range(8)])
    solver.poll(sessions)  # capture A's interim solve is now in flight

    # The capture is interrupted (stopped) mid-solve and a new one begins.
    sessions.stop()
    sessions.start("capture-b", code_params_for(8))
    sessions.add_detections([DetectionRecord.model_validate(_det(i)) for i in range(8)])
    try:
        active, interim = solver.poll(sessions)
        assert active is True and interim is None
    finally:
        gate.set()  # capture A's orphaned solve finishes now
    solver.flush()

    active, interim = solver.poll(sessions)
    assert active is True and interim is not None
    assert interim.mapId == "interim-capture-b", "capture A's late result must not leak into B"


@pytest.mark.requirements("PR-12")
def test_final_solve_that_dies_leaves_the_server_ready_for_the_next_capture(tmp_path, monkeypatch):
    attempts = []

    def flaky_reconstruct_sync(log_path, progress_cb=None, status_cb=None):
        attempts.append(json.loads(log_path.read_text())["ledCount"])
        if len(attempts) == 1:
            raise MemoryError("solver ran out of memory on a big capture")
        return _map("second-capture", n_leds=4)

    monkeypatch.setattr(recon_mod, "_reconstruct_sync", flaky_reconstruct_sync)
    store = MapStore(tmp_path / "maps")
    runner = ReconstructionRunner(store)
    handler, _ctx = _handler(tmp_path, runner, map_store=store)

    _send(handler, {"type": "start_mapping", "options": {"ledCount": BIG_LED_COUNT}})
    _send(handler, {"type": "detections", "batch": [_det(i) for i in range(16)]})
    err = _dump(_send(handler, {"type": "stop_mapping"})[0])
    assert err["type"] == "error" and err["code"] == "reconstruction_failed"
    assert "MemoryError" in err["message"]

    # The interrupted solve did not wedge the solve state or the session slot.
    status = _dump(_send(handler, {"type": "get_solve_status"})[0])
    assert status["running"] is False
    assert _dump(_send(handler, {"type": "get_pattern"})[0])["active"] is False

    _send(handler, {"type": "start_mapping", "options": {"ledCount": 4}})
    _send(handler, {"type": "detections", "batch": [_det(i) for i in range(4)]})
    done = _dump(_send(handler, {"type": "stop_mapping"})[0])
    assert done == {"type": "result_ready", "mapId": "second-capture"}
    assert store.exists("second-capture")
    assert attempts == [BIG_LED_COUNT, 4]
