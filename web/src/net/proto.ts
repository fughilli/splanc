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
  submit_effect: "submitEffect",
  set_effect: "setEffect",
  set_uniforms: "setUniforms",
  get_effect_uniforms: "getEffectUniforms",
  set_perf: "setPerf",
  get_perf_report: "getPerfReport",
  set_device_name: "setDeviceName",
  set_texture: "setTexture",
  upload_chunk: "uploadChunk",
  set_color_correction: "setColorCorrection",
  set_brightness: "setBrightness",
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
  effect_uniforms: "effectUniforms",
  perf_report: "perfReport",
  chunk_ack: "chunkAck",
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

// Keys carrying a proto `bytes` field. proto3 JSON encodes bytes as a base64
// string, but the flat TS shapes use Uint8Array (submit_effect.fxb outbound,
// effect_uniforms.manifest inbound) — convert at this boundary.
const BYTES_KEYS = new Set(["fxb", "manifest"]);
// `data` is a bytes field on both SetTexture (outbound, a Uint8Array we send)
// and StoredMapChunk (inbound, kept as a base64 string the map decoder unpacks
// itself). So convert it on ENCODE only, leaving the inbound StoredMapChunk.data
// as-is. `payload` is UploadChunk's outbound byte-window (same encode-only need).
const BYTES_KEYS_OUT = new Set([...BYTES_KEYS, "data", "payload"]);

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Turn Uint8Array bytes fields into base64 strings (flat -> proto JSON). */
function bytesToProto(value: unknown): unknown {
  if (value instanceof Uint8Array) return bytesToB64(value);
  if (Array.isArray(value)) return value.map(bytesToProto);
  if (value !== null && typeof value === "object") {
    const out: Json = {};
    for (const [k, v] of Object.entries(value as Json)) {
      out[k] = BYTES_KEYS_OUT.has(k) && v instanceof Uint8Array ? bytesToB64(v) : bytesToProto(v);
    }
    return out;
  }
  return value;
}

/** Turn base64 bytes fields back into Uint8Array (proto JSON -> flat). */
function bytesFromProto(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(bytesFromProto);
  if (value !== null && typeof value === "object") {
    const out: Json = {};
    for (const [k, v] of Object.entries(value as Json)) {
      out[k] = BYTES_KEYS.has(k) && typeof v === "string" ? b64ToBytes(v) : bytesFromProto(v);
    }
    return out;
  }
  return value;
}

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
  // bytes -> base64 first: stripNulls would otherwise walk a Uint8Array's
  // numeric indices and destroy the field.
  const inner = trajectoryToProto(stripNulls(bytesToProto(rest)));
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
    ...(bytesFromProto(trajectoryFromProto(json[arm])) as Json),
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
  return {
    type,
    ...(bytesFromProto(trajectoryFromProto(json[arm])) as Json),
  } as unknown as ClientMessage;
}

export function encodeServer(msg: ServerMessage): Uint8Array {
  const { type, ...rest } = msg as unknown as Json & { type: string };
  const arm = SERVER_ARMS[type];
  if (arm === undefined) throw new Error(`unknown server message type ${type}`);
  const inner = trajectoryToProto(stripNulls(bytesToProto(rest)));
  const env = create(ServerMessageSchema);
  const parsed = fromJsonEnvelope(ServerMessageSchema, arm, inner as Json);
  env.msg = parsed.msg;
  return toBinary(ServerMessageSchema, env);
}

// -- Effect arms (flat shapes) ----------------------------------------------
// The checked-in @ledmapper/protocol flat types don't yet carry these arms
// (they're new proto additions consumed only by the effects editor), so the
// flat shapes live here alongside the arm-table entries above. Field names are
// the proto3 JSON (camel) names, matching how encode/decodeClient round-trip.

/** A single uniform's live value (proto UniformValue). */
export interface UniformValueFlat {
  slot: number;
  value: number[];
}

/** Upload a compiled effect (proto SubmitEffect). */
export interface SubmitEffectMessage {
  type: "submit_effect";
  effectId: string;
  fxb: Uint8Array;
  activate: boolean;
}

/** Stream a video frame into a loaded effect's 2D texture (proto SetTexture).
 * `data` is the frame quantized to `format`, optionally XOR-delta'd (flags bit0)
 * and RLE'd (flags bit1) — see textureCodec.ts. Fire-and-forget (no reply). */
export interface SetTextureMessage {
  type: "set_texture";
  texIndex: number;
  format: number;
  width: number;
  height: number;
  flags: number;
  data: Uint8Array;
  palette?: number[];
}

/** Select the active effect by id (proto SetEffect). */
export interface SetEffectMessage {
  type: "set_effect";
  effectId: string;
}

/** Push live uniform values on the active effect (proto SetUniforms). */
export interface SetUniformsMessage {
  type: "set_uniforms";
  values: UniformValueFlat[];
}

/** Request an effect's manifest + current values (proto GetEffectUniforms). */
export interface GetEffectUniformsMessage {
  type: "get_effect_uniforms";
  effectId?: string;
}

/** Reply to get_effect_uniforms (proto EffectUniforms). `manifest` is the raw
 * compiler-emitted uniform-manifest JSON bytes. */
export interface EffectUniformsMessage {
  type: "effect_uniforms";
  effectId: string;
  manifest: Uint8Array;
  current: UniformValueFlat[];
}

// -- Chunked-upload arms (flat shapes) --------------------------------------
// Shard a large submit_map / submit_topology across several small frames so no
// single one forces the player's mbedtls to allocate a big contiguous TLS
// record buffer (the C6 OOMs its handshake trying to alloc a ~15 KB record for
// a full map). The client slices the encoded envelope into `payload` windows;
// the player reassembles + decodes on `last`. See client.ts sendChunked().

/** One byte-window of a sharded upload (proto UploadChunk). `payload` is a
 * slice of the encoded submit_map / submit_topology frame, in `seq` order. */
export interface UploadChunkMessage {
  type: "upload_chunk";
  uploadId: number;
  seq: number;
  last: boolean;
  kind: "MAP" | "TOPOLOGY"; // proto enum rides the JSON boundary as its name
  payload: Uint8Array;
}

/** Reply to a non-final UploadChunk (proto ChunkAck): the player has the
 * window and is ready for the next; echoes upload_id/seq for pacing. */
export interface ChunkAckMessage {
  type: "chunk_ack";
  uploadId: number;
  seq: number;
}

// -- Perf arms (flat shapes) ------------------------------------------------
// Perf-monitoring instrumentation (docs/design/perf-monitoring.md). Same
// firmware↔phone drain-on-poll shape as FrameTiming; native integer units
// (cycles/bytes/counts). Proto enum SetPerf.Mode rides the JSON boundary as its
// name string ("OFF"|"BASIC"|"FULL"), matching how fromJson resolves enums.

/** Instrumentation tier: OFF = no stream, BASIC = Tier-0 cycle/heap spans,
 * FULL = Tier-0 + Tier-1 per-opcode counting + stack high-water. */
export type PerfMode = "OFF" | "BASIC" | "FULL";

/** Configure effect perf instrumentation (proto SetPerf). `intervalMs` = 0 is
 * poll-only; > 0 asks the device to push perf_report unsolicited. */
export interface SetPerfMessage {
  type: "set_perf";
  mode: PerfMode;
  intervalMs: number;
}

/** Drain the perf ring + current window now (proto GetPerfReport). */
export interface GetPerfReportMessage {
  type: "get_perf_report";
}

/** One instrumented effect frame (proto PerfFrame). All native integer units. */
export interface PerfFrameFlat {
  seq: number;
  updateCycles: number;
  shadeCycles: number;
  frameCycles: number;
  showCycles: number;
  ledCount: number;
  instrUpdate: number;
  instrShade: number;
  stackMax: number;
}

/** Rolled-up perf report (proto PerfReport). Reply to get_perf_report/set_perf
 * and the unsolicited push when intervalMs > 0. */
export interface PerfReportMessage {
  type: "perf_report";
  effectId: string;
  fxbHash: number;
  cpuHz: number;
  budgetCycles: number;
  frameCyclesMin: number;
  frameCyclesMean: number;
  frameCyclesMax: number;
  updateCyclesMean: number;
  shadeCyclesMean: number;
  showCyclesMean: number;
  overruns: number;
  droppedFrames: number;
  samplesDropped: number;
  heapFree: number;
  heapMinFree: number;
  ticks: PerfFrameFlat[];
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
