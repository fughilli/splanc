"""Round-trip tests for the LED Mapper protocol.

This is the M10 acceptance criterion (design doc §6): construct an example of
every message/type, serialize to JSON, deserialize, assert equality.

In addition to the Pydantic round-trip, every example is also validated
against its JSON Schema using `jsonschema.Draft202012Validator`. The two
validators are independent: a discrepancy between them means the schemas and
the Pydantic models have drifted, which is exactly the contract bug this
package exists to surface.

The strict-mode (`extra='forbid'`) tests are deliberate: drift in the wire
contract should crash this test, not silently propagate to the Pi or the
phone.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import pytest
from jsonschema import Draft202012Validator
from ledmapper_protocol import (
    BranchPoint,
    ClientMessage,
    CodeParams,
    ColorBlock,
    ConfigureMessage,
    ConfigureOptions,
    CountingStateMessage,
    DetectionRecord,
    DetectionsMessage,
    ErrorMessage,
    ExposureReportMessage,
    ExposureStats,
    GetLiveMapMessage,
    GetPatternMessage,
    GetPlaybackMessage,
    GetSolveStatusMessage,
    GetStatusMessage,
    HelloMessage,
    ImuBatchMessage,
    ImuSample,
    LedAssociation,
    LedCountStateMessage,
    LedEntry,
    LiveMapMessage,
    MappingStartedMessage,
    OutputMap,
    OutputMapStats,
    PatternStateMessage,
    PlaybackParams,
    PlaybackStateMessage,
    Pose,
    ResultReadyMessage,
    ServerMessage,
    SetCountingPatternMessage,
    SetLedCountMessage,
    SetPlaybackMessage,
    SolveLed,
    SolveStatusMessage,
    StartMappingMessage,
    StartMappingOptions,
    StatusMessage,
    StopMappingMessage,
    SubmitTopologyMessage,
    TimeSyncPingMessage,
    TimeSyncPongMessage,
    Topology,
    TopologySegment,
    WelcomeMessage,
)
from pydantic import ValidationError
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012

# ---------------------------------------------------------------------------
# JSON Schema loading. The schemas live alongside the test file in the source
# tree, but under Bazel they're staged into the runfiles tree as data deps.
# We resolve them by walking up from this file or via an env var the genrule
# plumbs in for non-default layouts.
# ---------------------------------------------------------------------------


def _find_schema_dir() -> Path:
    env = os.environ.get("LEDMAPPER_PROTOCOL_SCHEMA_DIR")
    if env:
        p = Path(env)
        if p.is_dir():
            return p
    # Walk upward from this test file looking for shared/protocol/schemas/.
    here = Path(__file__).resolve()
    for parent in [here, *here.parents]:
        candidate = parent / "shared" / "protocol" / "schemas"
        if candidate.is_dir():
            return candidate
        # When running under Bazel, the test file lives at
        # shared/protocol/tests/test_roundtrip.py and schemas/ is a sibling.
        candidate = parent.parent / "schemas" if parent.name == "tests" else None
        if candidate and candidate.is_dir():
            return candidate
    raise RuntimeError("Could not locate shared/protocol/schemas/")


SCHEMA_DIR = _find_schema_dir()


def _load_schema(name: str) -> dict[str, Any]:
    return json.loads((SCHEMA_DIR / f"{name}.json").read_text())


SCHEMAS = {
    name: _load_schema(name)
    for name in (
        "detection_record",
        "code_params",
        "output_map",
        "topology",
        "playback_params",
        "client_messages",
        "server_messages",
    )
}


def _make_registry() -> Registry:
    """Register every schema under both its `$id` and its filename so the
    relative `$ref`s in the schemas (e.g. `detection_record.json`) resolve."""
    registry = Registry()
    for name, schema in SCHEMAS.items():
        resource = Resource(contents=schema, specification=DRAFT202012)
        registry = registry.with_resource(uri=f"{name}.json", resource=resource)
        if "$id" in schema:
            registry = registry.with_resource(uri=schema["$id"], resource=resource)
    return registry


REGISTRY = _make_registry()


def _validator_for(schema_name: str) -> Draft202012Validator:
    return Draft202012Validator(SCHEMAS[schema_name], registry=REGISTRY)


# ---------------------------------------------------------------------------
# Example builders. Every shape from §7 is represented at least once.
# ---------------------------------------------------------------------------


def make_code_params(symbols: int = 2, fec: str = "none") -> CodeParams:
    frames = -(-10 // (1 if symbols == 2 else 2))  # ceil(bits / log2(symbols))
    return CodeParams(
        ledCount=1024,
        bits=10,
        encoding="hue",
        symbols=symbols,
        bitPeriodMs=100.0,
        syncPattern="on_off",
        cycleFrames=2 + frames,
        fec=fec,
    )


def make_detection_record(led_id: int = 412) -> DetectionRecord:
    return DetectionRecord(
        ledId=led_id,
        tCaptureMs=123456.8,
        u=980.5,
        v=540.2,
        imgW=1920,
        imgH=1080,
        K=(1450.2, 1451.0, 959.5, 539.7),
        pose=Pose(p=(0.21, 1.05, -0.83), q=(0.0, 0.38, 0.0, 0.92)),
        confidence=0.87,
    )


def make_output_map() -> OutputMap:
    return OutputMap(
        mapId="11111111-2222-3333-4444-555555555555",
        createdAt="2026-06-18T12:00:00Z",
        units="meters",
        frame="webxr_session_ref",
        ledCount=1024,
        leds=[
            LedEntry(
                id=0,
                xyz=(0.10, 1.20, -0.55),
                confidence=0.93,
                nViews=34,
                rmsReprojPx=0.6,
                parallaxDeg=22.4,
            ),
            LedEntry(
                id=1,
                xyz=(0.11, 1.20, -0.55),
                confidence=0.88,
                nViews=29,
                rmsReprojPx=0.7,
                parallaxDeg=18.1,
            ),
        ],
        unmapped=[128, 129, 700],
        stats=OutputMapStats(rmsReprojPxGlobal=0.7, medianParallaxDeg=19.0),
    )


def make_topology() -> Topology:
    return Topology(
        mapId="11111111-2222-3333-4444-555555555555",
        branchPoints=[BranchPoint(id=0, xyz=(0.0, 1.0, 0.0))],
        segments=[
            TopologySegment(
                id=0,
                a=0,
                b=-1,
                polyline=[(0.0, 1.0, 0.0), (0.5, 1.0, 0.0), (0.5, 1.5, 0.0)],
                length=1.0,
            )
        ],
        associations=[LedAssociation(ledId=0, segmentId=0, footArclength=0.25, dPerp=0.004)],
    )


def make_playback_params() -> PlaybackParams:
    return PlaybackParams(
        intensity=0.8,
        glowRadius=0.12,
        agentCount=3,
        speed=1.5,
        palette=[0xFF0000, 0x00FF00, 0x0000FF],
        leadIn=0.1,
        splitProb=0.25,
        decay=0.5,
    )


# ---------------------------------------------------------------------------
# Standalone-type round-trips. Each example is run through both the Pydantic
# round-trip and the JSON Schema validator.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("model_cls", "instance_factory", "schema_name"),
    [
        (DetectionRecord, make_detection_record, "detection_record"),
        (CodeParams, make_code_params, "code_params"),
        (CodeParams, lambda: make_code_params(4), "code_params"),
        (CodeParams, lambda: make_code_params(fec="secded"), "code_params"),
        (OutputMap, make_output_map, "output_map"),
        (Topology, make_topology, "topology"),
        (PlaybackParams, make_playback_params, "playback_params"),
        (PlaybackParams, PlaybackParams, "playback_params"),
    ],
    ids=[
        "DetectionRecord",
        "CodeParams",
        "CodeParams4Sym",
        "CodeParamsSecded",
        "OutputMap",
        "Topology",
        "PlaybackParams",
        "PlaybackParamsEmpty",
    ],
)
def test_standalone_types_roundtrip(model_cls, instance_factory, schema_name) -> None:
    original = instance_factory()
    wire = original.model_dump_json()
    parsed = json.loads(wire)
    rebuilt = model_cls.model_validate(parsed)
    assert rebuilt == original
    # The wire payload must also satisfy the JSON Schema. If this fails, the
    # schema and the Pydantic model have drifted.
    _validator_for(schema_name).validate(parsed)


# ---------------------------------------------------------------------------
# Client -> server message round-trips. One example per variant.
# ---------------------------------------------------------------------------


CLIENT_VARIANTS = [
    HelloMessage(type="hello", client="android-web", appVersion="0.1.0"),
    TimeSyncPingMessage(type="time_sync_ping", t0=123456.7),
    StartMappingMessage(
        type="start_mapping",
        options=StartMappingOptions(ledCount=1024),
    ),
    StartMappingMessage(
        type="start_mapping",
        # Fully client-configured: the phone measured the scene and chose the
        # carrier + rate (§7.1).
        options=StartMappingOptions(ledCount=64, symbols=4, bitPeriodMs=200.0),
    ),
    ConfigureMessage(
        type="configure",
        options=ConfigureOptions(bitPeriodMs=200.0),
    ),
    ConfigureMessage(
        type="configure",
        options=ConfigureOptions(ledCount=64, symbols=2, bitPeriodMs=133.0),
    ),
    ExposureReportMessage(
        type="exposure_report",
        report=ExposureStats(
            tCaptureMs=123456.7,
            frameIntervalMs=66.7,
            meanLuma=0.04,
            p95Luma=0.11,
            clipFrac=0.002,
            blobCount=31,
            detectorThreshold=0.6,
        ),
    ),
    ExposureReportMessage(
        type="exposure_report",
        # A client that CAN read the 3A/ISP state (native app) fills these in.
        report=ExposureStats(
            tCaptureMs=123456.7,
            frameIntervalMs=33.3,
            meanLuma=0.35,
            p95Luma=0.83,
            clipFrac=0.01,
            blobCount=140,
            detectorThreshold=0.7,
            iso=800.0,
            exposureTimeMs=16.6,
            ambientIntensity=0.9,
        ),
    ),
    StopMappingMessage(type="stop_mapping"),
    DetectionsMessage(
        type="detections",
        batch=[make_detection_record(0), make_detection_record(1)],
    ),
    DetectionsMessage(
        type="detections",
        # WebXR-free path: pose-less records (the VIO reconstructor solves
        # the trajectory from the session's imu_batch stream).
        batch=[make_detection_record(0).model_copy(update={"pose": None})],
    ),
    ImuBatchMessage(
        type="imu_batch",
        samples=[
            ImuSample(t=1000.0, gyro=(0.01, -0.02, 0.005), accel=(0.1, 9.75, -0.3)),
            ImuSample(t=1016.7, gyro=(0.012, -0.018, 0.004), accel=(0.12, 9.74, -0.28)),
        ],
    ),
    GetStatusMessage(type="get_status"),
    GetPatternMessage(type="get_pattern"),
    GetLiveMapMessage(type="get_live_map"),
    GetSolveStatusMessage(type="get_solve_status"),
    SetCountingPatternMessage(
        type="set_counting_pattern",
        blocks=[
            ColorBlock(start=0, count=64, rgb=(1.0, 0.0, 0.0)),
            ColorBlock(start=64, count=64, rgb=(0.0, 0.0, 1.0)),
        ],
        channel=1,
    ),
    SetCountingPatternMessage(type="set_counting_pattern", blocks=[]),
    SetLedCountMessage(type="set_led_count", ledCount=300),
    SubmitTopologyMessage(type="submit_topology", topology=make_topology()),
    SetPlaybackMessage(
        type="set_playback", effect="pulse", params=make_playback_params(), mapId="m-1"
    ),
    SetPlaybackMessage(type="set_playback", effect="off"),
    GetPlaybackMessage(type="get_playback"),
]


@pytest.mark.parametrize(
    "variant",
    CLIENT_VARIANTS,
    ids=[v.type for v in CLIENT_VARIANTS],
)
def test_client_message_roundtrip(variant) -> None:
    """Each variant goes through the discriminated-union ClientMessage."""
    msg = ClientMessage(variant)
    wire = msg.model_dump_json()
    parsed = ClientMessage.model_validate_json(wire)
    assert parsed.root == variant
    assert parsed.root.type == variant.type
    # Re-serializing produces identical JSON.
    parsed_dict = json.loads(parsed.model_dump_json())
    assert parsed_dict == json.loads(wire)
    # And the wire payload validates against the discriminated-union schema.
    _validator_for("client_messages").validate(parsed_dict)


# ---------------------------------------------------------------------------
# Server -> client message round-trips. One example per variant.
# ---------------------------------------------------------------------------


SERVER_VARIANTS = [
    WelcomeMessage(
        type="welcome",
        sessionId="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        codeParams=make_code_params(),
    ),
    TimeSyncPongMessage(type="time_sync_pong", t0=123456.7, t1=988.1, t2=988.3),
    MappingStartedMessage(
        type="mapping_started",
        patternClockEpoch=988.5,
        codeParams=make_code_params(),
    ),
    StatusMessage(type="status", identified=812, total=1024, lowParallax=37),
    PatternStateMessage(
        type="pattern_state",
        active=True,
        patternClockEpoch=988.5,
        codeParams=make_code_params(),
    ),
    PatternStateMessage(
        type="pattern_state",
        active=False,
        patternClockEpoch=None,
        codeParams=make_code_params(),
    ),
    LiveMapMessage(type="live_map", active=True, map=make_output_map()),
    LiveMapMessage(type="live_map", active=False, map=None),
    SolveStatusMessage(
        type="solve_status",
        running=True,
        progress=0.4,
        rmsPx=2.7,
        leds=[SolveLed(id=0, xyz=(0.1, 0.2, 0.3)), SolveLed(id=3, xyz=(0.2, 0.2, 0.3))],
        trajectory=[(0.0, 0.0, 0.0), (0.05, 0.01, -0.02)],
    ),
    SolveStatusMessage(
        type="solve_status", running=False, progress=None, rmsPx=None, leds=None, trajectory=None
    ),
    ResultReadyMessage(type="result_ready", mapId="ffffffff-0000-1111-2222-333333333333"),
    ErrorMessage(type="error", code="capture_aborted", message="user pressed stop"),
    CountingStateMessage(type="counting_state", active=True, epochMs=12345.5),
    CountingStateMessage(type="counting_state", active=False, epochMs=None),
    LedCountStateMessage(type="led_count_state", ledCount=300, channel=0),
    PlaybackStateMessage(
        type="playback_state",
        active=True,
        effect="pulse",
        params=make_playback_params(),
        mapId="m-1",
    ),
    PlaybackStateMessage(
        type="playback_state", active=False, effect="off", params=None, mapId=None
    ),
]


@pytest.mark.parametrize(
    "variant",
    SERVER_VARIANTS,
    ids=[v.type for v in SERVER_VARIANTS],
)
def test_server_message_roundtrip(variant) -> None:
    msg = ServerMessage(variant)
    wire = msg.model_dump_json()
    parsed = ServerMessage.model_validate_json(wire)
    assert parsed.root == variant
    assert parsed.root.type == variant.type
    parsed_dict = json.loads(parsed.model_dump_json())
    assert parsed_dict == json.loads(wire)
    _validator_for("server_messages").validate(parsed_dict)


# ---------------------------------------------------------------------------
# Strictness checks. extra='forbid' is part of the contract; it should fail
# loudly on unknown fields rather than silently dropping them.
# ---------------------------------------------------------------------------


def test_unknown_field_on_detection_record_rejected() -> None:
    payload = make_detection_record().model_dump()
    payload["bogus"] = 1
    with pytest.raises(ValidationError):
        DetectionRecord.model_validate(payload)


def test_unknown_field_on_client_message_rejected() -> None:
    bad = {"type": "hello", "client": "android-web", "appVersion": "0.1.0", "bogus": 1}
    with pytest.raises(ValidationError):
        ClientMessage.model_validate(bad)


def test_unknown_message_type_rejected() -> None:
    with pytest.raises(ValidationError):
        ClientMessage.model_validate({"type": "not_a_real_message"})


def test_quaternion_must_be_length_4() -> None:
    payload = make_detection_record().model_dump()
    payload["pose"]["q"] = [0.0, 0.0, 1.0]  # 3 elements, not 4
    with pytest.raises(ValidationError):
        DetectionRecord.model_validate(payload)


def test_intrinsics_must_be_length_4() -> None:
    payload = make_detection_record().model_dump()
    payload["K"] = [1.0, 2.0, 3.0]
    with pytest.raises(ValidationError):
        DetectionRecord.model_validate(payload)


# ---------------------------------------------------------------------------
# Round-trip via the wire JSON example shapes from the design doc, to make
# sure we can decode a raw dict the way an incoming WebSocket frame would
# arrive (no Pydantic types on the sender's side).
# ---------------------------------------------------------------------------


def test_decode_raw_dict_detections_message() -> None:
    raw = {
        "type": "detections",
        "batch": [
            {
                "ledId": 412,
                "tCaptureMs": 123456.8,
                "u": 980.5,
                "v": 540.2,
                "imgW": 1920,
                "imgH": 1080,
                "K": [1450.2, 1451.0, 959.5, 539.7],
                "pose": {
                    "p": [0.21, 1.05, -0.83],
                    "q": [0.0, 0.38, 0.0, 0.92],
                },
                "confidence": 0.87,
            }
        ],
    }
    parsed = ClientMessage.model_validate(raw)
    assert isinstance(parsed.root, DetectionsMessage)
    assert parsed.root.batch[0].ledId == 412
    _validator_for("client_messages").validate(raw)


def test_decode_raw_dict_welcome_message() -> None:
    raw = {
        "type": "welcome",
        "sessionId": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        "solverBenchMs": None,
        "mac": "AA:BB:CC:DD:EE:FF",
        "deviceName": "Led Widget AABBCC",
        "fwGitCommit": "0123456789abcdef0123456789abcdef01234567",
        "fwGitDirty": False,
        "fwVersion": "1.2.0",
        "codeParams": {
            "ledCount": 1024,
            "bits": 10,
            "encoding": "hue",
            "symbols": 2,
            "bitPeriodMs": 100.0,
            "syncPattern": "on_off",
            "cycleFrames": 12,
        },
    }
    parsed = ServerMessage.model_validate(raw)
    assert isinstance(parsed.root, WelcomeMessage)
    assert parsed.root.codeParams.cycleFrames == 12
    _validator_for("server_messages").validate(raw)


# ---------------------------------------------------------------------------
# Schema-level negative tests: an obvious wire violation must be caught by
# the JSON Schema validator independently of Pydantic.
# ---------------------------------------------------------------------------


def test_schema_rejects_missing_required_field() -> None:
    from jsonschema import ValidationError as JsonSchemaValidationError

    bad = make_detection_record().model_dump()
    del bad["confidence"]
    with pytest.raises(JsonSchemaValidationError):
        _validator_for("detection_record").validate(bad)


def test_schema_rejects_extra_field() -> None:
    from jsonschema import ValidationError as JsonSchemaValidationError

    bad = make_detection_record().model_dump()
    bad["bogus"] = 1
    with pytest.raises(JsonSchemaValidationError):
        _validator_for("detection_record").validate(bad)
