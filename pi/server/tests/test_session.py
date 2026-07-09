"""SessionManager + MapStore (design doc §6 M2, §7.5)."""

import json

import pytest
from ledmapper_protocol import (
    DetectionRecord,
    ExposureStats,
    LedEntry,
    OutputMap,
    OutputMapStats,
)
from server.codebook import code_params_for
from server.session import MapStore, SessionManager


def _det(led_id: int, u: float = 100.0, v: float = 100.0) -> DetectionRecord:
    return DetectionRecord(
        ledId=led_id,
        tCaptureMs=0.0,
        u=u,
        v=v,
        imgW=1280,
        imgH=720,
        K=(900.0, 900.0, 640.0, 360.0),
        pose={"p": (0.0, 0.0, 0.0), "q": (0.0, 0.0, 0.0, 1.0)},
        confidence=1.0,
    )


def _exposure(t: float = 0.0) -> ExposureStats:
    return ExposureStats(
        tCaptureMs=t,
        frameIntervalMs=33.3,
        meanLuma=0.05,
        p95Luma=0.2,
        clipFrac=0.001,
        blobCount=8,
        detectorThreshold=0.6,
    )


def test_start_persist_and_clear(tmp_path):
    sm = SessionManager(tmp_path / "sessions")
    epoch = sm.start("sess-1", code_params_for(8))
    assert isinstance(epoch, float)
    assert sm.active is not None and sm.active.pattern_clock_epoch == epoch

    sm.add_detections([_det(0), _det(0), _det(1)])
    sm.add_exposure(_exposure(1.0))
    session_id, log_path = sm.stop()

    assert session_id == "sess-1"
    assert sm.active is None  # cleared after stop
    log = json.loads(log_path.read_text())
    assert log["ledCount"] == 8
    assert log["codeParams"]["ledCount"] == 8
    assert len(log["detections"]) == 3
    assert len(log["exposure"]) == 1 and log["exposure"][0]["frameIntervalMs"] == 33.3
    # Persisted records round-trip through the protocol model.
    DetectionRecord.model_validate(log["detections"][0])


def test_status_proxies(tmp_path):
    sm = SessionManager(tmp_path / "sessions")
    sm.start("sess", code_params_for(10))
    # led 0 seen twice (triangulable), led 1 once (low parallax proxy).
    sm.add_detections([_det(0), _det(0), _det(1)])
    identified, total, low = sm.status()
    assert (identified, total, low) == (1, 10, 1)


def test_reconfigure_swaps_params_and_restamps_epoch(tmp_path):
    sm = SessionManager(tmp_path / "sessions")
    epoch0 = sm.start("sess", code_params_for(8, 100.0, "gray"))
    sm.add_detections([_det(0), _det(0)])

    new_params = code_params_for(8, 200.0, "gray-hue")
    epoch1 = sm.reconfigure(new_params)
    assert epoch1 >= epoch0
    state = sm.pattern_state()
    assert state is not None
    got_epoch, got_params = state
    assert got_epoch == epoch1
    assert got_params.bitPeriodMs == 200.0 and got_params.encoding == "gray-hue"

    # Detections collected before the reconfigure survive it.
    _sid, log_path = sm.stop()
    log = json.loads(log_path.read_text())
    assert len(log["detections"]) == 2
    assert log["codeParams"]["bitPeriodMs"] == 200.0


def test_reconfigure_without_session_raises(tmp_path):
    sm = SessionManager(tmp_path / "sessions")
    with pytest.raises(RuntimeError):
        sm.reconfigure(code_params_for(8))


def test_exposure_without_session_is_dropped(tmp_path):
    sm = SessionManager(tmp_path / "sessions")
    sm.add_exposure(_exposure())  # no raise, no effect


def test_status_without_session_is_zero(tmp_path):
    sm = SessionManager(tmp_path / "sessions")
    assert sm.status() == (0, 0, 0)


def test_add_or_stop_without_session_raises(tmp_path):
    sm = SessionManager(tmp_path / "sessions")
    with pytest.raises(RuntimeError):
        sm.add_detections([_det(0)])
    with pytest.raises(RuntimeError):
        sm.stop()


def _map(map_id: str) -> OutputMap:
    return OutputMap(
        mapId=map_id,
        createdAt="2026-01-01T00:00:00Z",
        units="meters",
        frame="webxr_session_ref",
        ledCount=2,
        leds=[
            LedEntry(
                id=0,
                xyz=(1.0, 2.0, 3.0),
                confidence=0.9,
                nViews=5,
                rmsReprojPx=0.6,
                parallaxDeg=20.0,
            ),
        ],
        unmapped=[1],
        stats=OutputMapStats(rmsReprojPxGlobal=0.6, medianParallaxDeg=20.0),
    )


def test_map_store_save_json_and_csv(tmp_path):
    store = MapStore(tmp_path / "maps")
    assert not store.exists("m1")
    store.save(_map("m1"))
    assert store.exists("m1")

    saved = OutputMap.model_validate_json(store.json_path("m1").read_text())
    assert saved.mapId == "m1" and saved.leds[0].id == 0

    csv = store.csv_path("m1").read_text()
    lines = csv.strip().splitlines()
    assert lines[0] == "id,x,y,z,confidence,n_views"
    assert lines[1].startswith("0,1.000000,2.000000,3.000000,")
