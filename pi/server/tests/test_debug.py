"""Solver diagnostics (server/debug.py): report correctness on known geometry."""

import numpy as np
from ledmapper_protocol import DetectionRecord, LedEntry, OutputMap, OutputMapStats
from reconstruction.camera import look_at_quat, project
from server.debug import led_report, session_overview

LED = np.array([0.3, 0.1, 0.0])
K = (500.0, 500.0, 320.0, 240.0)


def _pose(i):
    a = -0.6 + i * 0.06
    eye = np.array([2.0 * np.sin(a), 0.2, 2.0 * np.cos(a)])
    return eye, look_at_quat(eye, np.zeros(3))


def _record(i, led_id=5):
    eye, q = _pose(i)
    uv, depth = project(eye, q, K, LED)
    assert depth > 0
    return DetectionRecord(
        ledId=led_id,
        tCaptureMs=float(i * 100),
        u=float(uv[0]),
        v=float(uv[1]),
        imgW=640,
        imgH=480,
        K=K,
        pose={"p": tuple(float(c) for c in eye), "q": tuple(float(c) for c in q)},
        confidence=0.9,
    )


def _map_with(led_id, xyz):
    return OutputMap(
        mapId="live-x",
        createdAt="2026-01-01T00:00:00Z",
        units="meters",
        frame="webxr_session_ref",
        ledCount=8,
        leds=[
            LedEntry(
                id=led_id, xyz=xyz, confidence=0.8, nViews=9, rmsReprojPx=0.4, parallaxDeg=20.0
            )
        ],
        unmapped=[],
        stats=OutputMapStats(rmsReprojPxGlobal=0.4, medianParallaxDeg=20.0),
    )


def test_led_report_recovers_clean_geometry():
    detections = [_record(i) for i in range(12)]
    live = _map_with(5, tuple(LED))
    history = [
        (1000.0 + 100 * j, 4 * j, _map_with(5, (LED[0], LED[1] + 0.001 * j, LED[2])))
        for j in range(5)
    ]

    r = led_report(detections, 5, live, history)
    assert r["nObservations"] == 12
    # Perfect synthetic observations: triangulation lands on the true point...
    assert np.allclose(r["geometry"]["triangulated"], LED, atol=1e-6)
    # ...residuals vanish, and the rays pass through it.
    assert r["geometry"]["residualTriPx"]["max"] < 1e-6
    assert r["geometry"]["residualLivePx"]["max"] < 1e-6
    assert r["geometry"]["rayMissM"]["max"] < 1e-9
    # The arc gives real parallax; the camera moves.
    assert r["geometry"]["maxParallaxDeg"] > 10
    assert r["pose"]["pathLenM"] > 0.5
    assert all(o["speedMps"] >= 0 for o in r["observations"])
    # Per-observation trace carries the ray + both residuals.
    o = r["observations"][0]
    for key in ("rayOrigin", "rayDir", "residualTriPx", "residualLivePx", "u", "v", "p", "q"):
        assert key in o
    # Live entry + history series for this LED came through.
    assert r["live"]["nViews"] == 9
    assert len(r["solveHistory"]) == 5
    assert r["solveJitter"]["meanStepM"] > 0


def test_led_report_flags_corrupted_observation():
    # 11 clean views + one with a wildly wrong v (a mis-identified detection):
    # the report's per-observation residuals must single it out.
    detections = [_record(i) for i in range(11)]
    bad = _record(11).model_dump()
    bad["v"] += 80.0
    detections.append(DetectionRecord.model_validate(bad))

    r = led_report(detections, 5, None, [])
    residuals = [o["residualTriPx"] for o in r["observations"]]
    worst = max(range(len(residuals)), key=lambda i: residuals[i])
    assert r["observations"][worst]["t"] == 1100.0  # the corrupted one
    # The bad view drags the DLT point, so clean views pick up residual too —
    # but the corrupted one still stands clear of the pack.
    assert residuals[worst] > 3 * sorted(residuals)[len(residuals) // 2]


def test_led_report_handles_no_observations():
    r = led_report([_record(0)], 99, None, [])
    assert r["nObservations"] == 0
    assert "note" in r


def test_session_overview_counts():
    detections = [_record(i, led_id=i % 3) for i in range(9)]
    o = session_overview(detections, led_count=8)
    assert o["nDetections"] == 9
    assert o["ledsSeen"] == 3
    assert o["viewsPerLed"] == {"0": 3, "1": 3, "2": 3}
    assert o["posePathLenM"] > 0
