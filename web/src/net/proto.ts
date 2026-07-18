/**
 * Protobuf wire boundary (proto-comms): binary frames <-> flat §7 objects.
 *
 * Mirror of pi/server/server/proto_wire.py — see its docstring for the
 * design (JSON-parity proto, envelope arm == "type", null == unset,
 * trajectory shape conversion). The app keeps using the flat §7 TypeScript
 * types from @ledmapper/protocol; this module is the only place that knows
 * protobuf exists.
 *
 * Normalization on decode: fields the flat types declare as `T | null` are
 * filled with null when the proto leaves them unset, because the app's
 * strict null checks (`x !== null`) must not meet `undefined`.
 */

import { create, fromBinary, fromJson, toBinary, toJson } from "@bufbuild/protobuf";
import type { DescMessage, JsonValue, MessageShape } from "@bufbuild/protobuf";
import type { ClientMessage, OutputMap, ServerMessage, Topology } from "@ledmapper/protocol";
import {
  ClientMessageSchema,
  MappingBundleSchema,
  ServerMessageSchema,
} from "../gen/ledmapper_pb";

// Envelope arm names: snake ("type" values, proto field names) <-> camel
// (proto3 JSON names). Explicit tables — no string munging surprises.
const CLIENT_ARMS: Record<string, string> = {
  hello: "hello",
  time_sync_ping: "timeSyncPing",
  start_mapping: "startMapping",
  configure: "configure",
  stop_mapping: "stopMapping",
  detections: "detections",
  imu_batch: "imuBatch",
  exposure_report: "exposureReport",
  get_status: "getStatus",
  get_pattern: "getPattern",
  get_live_map: "getLiveMap",
  get_solve_status: "getSolveStatus",
  submit_map: "submitMap",
  set_counting_pattern: "setCountingPattern",
  set_led_count: "setLedCount",
  submit_topology: "submitTopology",
  set_playback: "setPlayback",
  get_playback: "getPlayback",
  get_frame_timing: "getFrameTiming",
  get_stored_map: "getStoredMap",
};
const SERVER_ARMS: Record<string, string> = {
  welcome: "welcome",
  time_sync_pong: "timeSyncPong",
  mapping_started: "mappingStarted",
  mapping_stopped: "mappingStopped",
  status: "status",
  pattern_state: "patternState",
  live_map: "liveMap",
  solve_status: "solveStatus",
  result_ready: "resultReady",
  error: "error",
  counting_state: "countingState",
  led_count_state: "ledCountState",
  playback_state: "playbackState",
  frame_timing: "frameTiming",
  stored_map_chunk: "storedMapChunk",
};
const CLIENT_TYPES: Record<string, string> = Object.fromEntries(
  Object.entries(CLIENT_ARMS).map(([snake, camel]) => [camel, snake]),
);
const SERVER_TYPES: Record<string, string> = Object.fromEntries(
  Object.entries(SERVER_ARMS).map(([snake, camel]) => [camel, snake]),
);

type Json = Record<string, unknown>;

function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (value !== null && typeof value === "object") {
    const out: Json = {};
    for (const [k, v] of Object.entries(value as Json)) {
      if (v !== null && v !== undefined) out[k] = stripNulls(v);
    }
    return out;
  }
  return value;
}

// Keys whose JSON shape is a nested point list [[x,y,z], ...] carried as
// `repeated Vec3` on the proto side: camera trajectories and topology
// segment polylines.
const VEC3_LIST_KEYS = new Set(["trajectory", "polyline"]);

function trajectoryToProto(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(trajectoryToProto);
  if (value !== null && typeof value === "object") {
    const out: Json = {};
    for (const [k, v] of Object.entries(value as Json)) {
      out[k] =
        VEC3_LIST_KEYS.has(k) && Array.isArray(v)
          ? v.map((p) => ({ v: p }))
          : trajectoryToProto(v);
    }
    return out;
  }
  return value;
}

function trajectoryFromProto(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(trajectoryFromProto);
  if (value !== null && typeof value === "object") {
    const out: Json = {};
    for (const [k, v] of Object.entries(value as Json)) {
      out[k] =
        VEC3_LIST_KEYS.has(k) && Array.isArray(v)
          ? v.map((p) => (p as { v?: number[] }).v ?? [])
          : trajectoryFromProto(v);
    }
    return out;
  }
  return value;
}

/** Fill `null` for unset optionals whose flat types are `T | null`. */
function fillNulls(type: string, flat: Json): Json {
  const ensure = (obj: Json, key: string): void => {
    if (!(key in obj)) obj[key] = null;
  };
  if (type === "welcome") ensure(flat, "solverBenchMs");
  if (type === "pattern_state") ensure(flat, "patternClockEpoch");
  if (type === "live_map") ensure(flat, "map");
  if (type === "solve_status") {
    ensure(flat, "progress");
    ensure(flat, "rmsPx");
  }
  if (type === "counting_state") ensure(flat, "epochMs");
  if (type === "playback_state") {
    ensure(flat, "params");
    ensure(flat, "mapId");
  }
  if (type === "frame_timing") ensure(flat, "patternClockEpochMs");
  return flat;
}

export function encodeClient(msg: ClientMessage): Uint8Array {
  const { type, ...rest } = msg as unknown as Json & { type: string };
  const arm = CLIENT_ARMS[type];
  if (arm === undefined) throw new Error(`unknown client message type ${type}`);
  const inner = trajectoryToProto(stripNulls(rest));
  const env = create(ClientMessageSchema);
  // fromJson via the envelope keeps oneof/arm handling in the runtime.
  const parsed = fromJsonEnvelope(ClientMessageSchema, arm, inner as Json);
  env.msg = parsed.msg;
  return toBinary(ClientMessageSchema, env);
}

export function decodeServer(data: Uint8Array): ServerMessage {
  const env = fromBinary(ServerMessageSchema, data);
  const json = toJson(ServerMessageSchema, env, { alwaysEmitImplicit: true }) as Json;
  const arm = Object.keys(json)[0];
  if (arm === undefined) throw new Error("server envelope has no message set");
  const type = SERVER_TYPES[arm];
  if (type === undefined) throw new Error(`unknown server envelope arm ${arm}`);
  const flat = fillNulls(type, {
    type,
    ...(trajectoryFromProto(json[arm]) as Json),
  });
  return flat as unknown as ServerMessage;
}

// The mirrors below exist for tests (fake sockets must decode what the app
// sent, and synthesize server frames): same boundary, opposite direction.

export function decodeClient(data: Uint8Array): ClientMessage {
  const env = fromBinary(ClientMessageSchema, data);
  const json = toJson(ClientMessageSchema, env, { alwaysEmitImplicit: true }) as Json;
  const arm = Object.keys(json)[0];
  if (arm === undefined) throw new Error("client envelope has no message set");
  const type = CLIENT_TYPES[arm];
  if (type === undefined) throw new Error(`unknown client envelope arm ${arm}`);
  return { type, ...(trajectoryFromProto(json[arm]) as Json) } as unknown as ClientMessage;
}

export function encodeServer(msg: ServerMessage): Uint8Array {
  const { type, ...rest } = msg as unknown as Json & { type: string };
  const arm = SERVER_ARMS[type];
  if (arm === undefined) throw new Error(`unknown server message type ${type}`);
  const inner = trajectoryToProto(stripNulls(rest));
  const env = create(ServerMessageSchema);
  const parsed = fromJsonEnvelope(ServerMessageSchema, arm, inner as Json);
  env.msg = parsed.msg;
  return toBinary(ServerMessageSchema, env);
}

// -- MappingBundle (.binpb file format) -------------------------------------
// A standalone map+topology file for offline effect experimentation: exported
// by the phone (post-solve) or dumped from a player, imported into the effects
// workspace. Same flat<->proto boundary as the envelopes (null == unset, the
// Vec3-list shape conversion for trajectory/polyline), just no oneof arm.

export interface MappingBundle {
  map: OutputMap;
  topology: Topology;
}

export function encodeMappingBundle(bundle: MappingBundle): Uint8Array {
  const inner = trajectoryToProto(stripNulls(bundle)) as Json;
  return toBinary(MappingBundleSchema, fromJson(MappingBundleSchema, inner as JsonValue));
}

export function decodeMappingBundle(data: Uint8Array): MappingBundle {
  const msg = fromBinary(MappingBundleSchema, data);
  const json = toJson(MappingBundleSchema, msg, { alwaysEmitImplicit: true }) as Json;
  const flat = trajectoryFromProto(json) as Json;
  return {
    map: (flat["map"] ?? null) as unknown as OutputMap,
    topology: (flat["topology"] ?? null) as unknown as Topology,
  };
}

function fromJsonEnvelope<T extends DescMessage>(
  schema: T,
  arm: string,
  inner: Json,
): MessageShape<T> {
  return fromJson(schema, { [arm]: inner } as JsonValue);
}
