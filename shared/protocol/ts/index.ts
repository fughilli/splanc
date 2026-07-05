// LED Mapper protocol — TypeScript public surface.
//
// This is a hand-curated re-exporter. The actual type definitions are
// auto-generated from shared/protocol/schemas/*.json into ./generated/index.ts
// by shared/protocol/codegen.py (driven by the Bazel codegen genrule).
//
// Consumers should import from `@ledmapper/protocol`, never from the
// generated path:
//
//     import type { DetectionRecord } from "@ledmapper/protocol";
//
// Source of truth: shared/protocol/schemas/*.json. See design doc §7.
// Regenerate via: bazel build //shared/protocol:codegen

export type {
  ClientMessage,
  CodeParams,
  DetectionRecord,
  DetectionsMessage,
  Encoding,
  ErrorMessage,
  GetLiveMapMessage,
  GetPatternMessage,
  GetStatusMessage,
  HelloMessage,
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
  StartMappingMessage,
  StartMappingOptions,
  StatusMessage,
  StopMappingMessage,
  SyncPattern,
  TimeSyncPingMessage,
  TimeSyncPongMessage,
  Vec3,
  WelcomeMessage,
} from "./generated/index.js";
