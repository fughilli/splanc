"""LED Mapper protocol — Python public surface.

This is a hand-curated module that re-exports everything from the
auto-generated `_generated` module. Imports should target this package, not
the generated module directly:

    from ledmapper_protocol import DetectionRecord, ClientMessage, ServerMessage

The split (hand-curated package + generated module) exists so this file is a
stable place to add helpers, deprecation shims, or convenience constructors
later without touching the generator.

Source of truth: shared/protocol/schemas/*.json. See design doc §7.
Regenerate the bindings via:  bazel build //shared/protocol:codegen
"""

from __future__ import annotations

from ._generated import (
    ClientMessage,
    CodeParams,
    ConfigureMessage,
    ConfigureOptions,
    DetectionRecord,
    DetectionsMessage,
    Encoding,
    ErrorMessage,
    ExposureReportMessage,
    ExposureStats,
    Fec,
    GetLiveMapMessage,
    GetPatternMessage,
    GetSolveStatusMessage,
    GetStatusMessage,
    HelloMessage,
    ImuBatchMessage,
    ImuSample,
    Intrinsics,
    LedEntry,
    LiveMapMessage,
    MappingStartedMessage,
    OutputMap,
    OutputMapStats,
    PatternStateMessage,
    Pose,
    Quat,
    ResultReadyMessage,
    ServerMessage,
    SolveLed,
    SolveStatusMessage,
    StartMappingMessage,
    StartMappingOptions,
    StatusMessage,
    StopMappingMessage,
    SyncPattern,
    TimeSyncPingMessage,
    TimeSyncPongMessage,
    Vec3,
    WelcomeMessage,
)

__all__ = [
    "ClientMessage",
    "CodeParams",
    "ConfigureMessage",
    "ConfigureOptions",
    "DetectionRecord",
    "DetectionsMessage",
    "Encoding",
    "ErrorMessage",
    "ExposureReportMessage",
    "ExposureStats",
    "Fec",
    "GetLiveMapMessage",
    "GetPatternMessage",
    "GetSolveStatusMessage",
    "GetStatusMessage",
    "HelloMessage",
    "ImuBatchMessage",
    "ImuSample",
    "Intrinsics",
    "LedEntry",
    "LiveMapMessage",
    "MappingStartedMessage",
    "OutputMap",
    "OutputMapStats",
    "PatternStateMessage",
    "Pose",
    "Quat",
    "ResultReadyMessage",
    "ServerMessage",
    "SolveLed",
    "SolveStatusMessage",
    "StartMappingMessage",
    "StartMappingOptions",
    "StatusMessage",
    "StopMappingMessage",
    "SyncPattern",
    "TimeSyncPingMessage",
    "TimeSyncPongMessage",
    "Vec3",
    "WelcomeMessage",
]
