"""Canonical §7 message examples (one per type/variant).

Shared by the proto_wire tests and the cross-language golden generator
(gen_proto_golden.py -> web/tests/golden_proto_frames.json): the SAME flats
are round-tripped in Python and TypeScript, and the byte frames must decode
identically on both sides.
"""

CODE_PARAMS = {
    "ledCount": 64,
    "bits": 12,
    "encoding": "gray-hue",
    "bitPeriodMs": 110.0,
    "syncPattern": "on_off",
    "cycleFrames": 14,
    "fec": "secded",
}

DETECTION = {
    "ledId": 3,
    "tCaptureMs": 123.5,
    "u": 100.25,
    "v": 200.75,
    "imgW": 1280,
    "imgH": 720,
    "K": [800.0, 800.0, 640.0, 360.0],
    "pose": {"p": [0.1, 1.2, -0.3], "q": [0.0, 0.38, 0.0, 0.92]},
    "confidence": 0.87,
}

POSELESS = {**DETECTION, "pose": None}

OUTPUT_MAP = {
    "mapId": "m-1",
    "createdAt": "2026-07-09T00:00:00Z",
    "units": "meters",
    "frame": "gravity_leveled",
    "ledCount": 2,
    "leds": [
        {
            "id": 0,
            "xyz": [0.1, 0.2, 0.3],
            "confidence": 0.9,
            "nViews": 12,
            "rmsReprojPx": 0.6,
            "parallaxDeg": 21.0,
        }
    ],
    "unmapped": [1],
    "trajectory": [[0.0, 0.0, 0.0], [0.05, 0.01, -0.02]],
    "stats": {"rmsReprojPxGlobal": 0.7, "medianParallaxDeg": 19.0},
}

CLIENT_FLATS = [
    {"type": "hello", "client": "android-web", "appVersion": "0.1.0"},
    {"type": "time_sync_ping", "t0": 123456.7},
    {"type": "start_mapping", "options": {"ledCount": 64}},
    {
        "type": "start_mapping",
        "options": {"ledCount": 64, "encoding": "gray-hue", "bitPeriodMs": 200.0},
    },
    {"type": "configure", "options": {"bitPeriodMs": 200.0}},
    {"type": "stop_mapping"},
    {"type": "stop_mapping", "solveOnHost": False},
    {"type": "submit_map", "map": OUTPUT_MAP},
    {"type": "detections", "batch": [DETECTION, POSELESS]},
    {
        "type": "imu_batch",
        "samples": [{"t": 1.0, "gyro": [0.01, -0.02, 0.005], "accel": [0.1, 9.75, -0.3]}],
    },
    {
        "type": "exposure_report",
        "report": {
            "tCaptureMs": 1.0,
            "frameIntervalMs": 33.3,
            "meanLuma": 0.05,
            "p95Luma": 0.2,
            "clipFrac": 0.001,
            "blobCount": 30,
            "detectorThreshold": 0.6,
            "iso": None,
            "exposureTimeMs": None,
            "ambientIntensity": 0.7,
        },
    },
    {"type": "get_status"},
    {"type": "get_pattern"},
    {"type": "get_live_map"},
    {"type": "get_solve_status"},
]

SERVER_FLATS = [
    {"type": "welcome", "sessionId": "s-1", "codeParams": CODE_PARAMS, "solverBenchMs": None},
    {"type": "welcome", "sessionId": "s-1", "codeParams": CODE_PARAMS, "solverBenchMs": 210.5},
    {"type": "time_sync_pong", "t0": 1.0, "t1": 2.0, "t2": 3.0},
    {"type": "mapping_started", "patternClockEpoch": 987.5, "codeParams": CODE_PARAMS},
    {"type": "mapping_stopped", "detections": 4200, "imuSamples": 3600},
    {"type": "status", "identified": 5, "total": 64, "lowParallax": 2},
    {
        "type": "pattern_state",
        "active": True,
        "patternClockEpoch": 987.5,
        "codeParams": CODE_PARAMS,
    },
    {
        "type": "pattern_state",
        "active": False,
        "patternClockEpoch": None,
        "codeParams": CODE_PARAMS,
    },
    {"type": "live_map", "active": True, "map": OUTPUT_MAP},
    {"type": "live_map", "active": False, "map": None},
    {
        "type": "solve_status",
        "running": True,
        "progress": 0.4,
        "rmsPx": 2.7,
        "leds": [{"id": 0, "xyz": [0.1, 0.2, 0.3]}],
        "trajectory": [[0.0, 0.0, 0.0], [0.05, 0.0, -0.01]],
    },
    {
        "type": "solve_status",
        "running": False,
        "progress": None,
        "rmsPx": None,
        "leds": None,
        "trajectory": None,
    },
    {"type": "result_ready", "mapId": "m-9"},
    {"type": "error", "code": "no_session", "message": "no active capture"},
]
