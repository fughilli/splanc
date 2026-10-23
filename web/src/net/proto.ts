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
  set_hardware_config: "setHardwareConfig",
  get_hardware_config: "getHardwareConfig",
  get_color_correction: "getColorCorrection",
  list_effects: "listEffects",
  set_fixture_pose: "setFixturePose",
  set_time_base: "setTimeBase",
  set_crossfade: "setCrossfade",
  save_keypoint: "saveKeypoint",
  delete_keypoint: "deleteKeypoint",
  list_keypoints: "listKeypoints",
  get_keypoint: "getKeypoint",
  blend_keypoints: "blendKeypoints",
  get_tls_info: "getTlsInfo",
  set_fps: "setFps",
  get_sensors: "getSensors",
  calibrate_sensors: "calibrateSensors",
  scan_i2c: "scanI2c",
  submit_driver: "submitDriver",
  remove_driver: "removeDriver",
  get_driver_state: "getDriverState",
  set_sensor_mount: "setSensorMount",
  set_capture_profile: "setCaptureProfile",
  get_capture_profile: "getCaptureProfile",
  ota_begin: "otaBegin",
  ota_chunk: "otaChunk",
  ota_finish: "otaFinish",
  ota_abort: "otaAbort",
  get_ota_status: "getOtaStatus",
  ota_reboot: "otaReboot",
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
  hardware_config_state: "hardwareConfigState",
  color_correction_state: "colorCorrectionState",
  effect_list: "effectList",
  keypoint_list: "keypointList",
  keypoint: "keypoint",
  tls_info: "tlsInfo",
  fps_state: "fpsState",
  sensor_state: "sensorState",
  i2c_scan_result: "i2cScanResult",
  driver_state: "driverState",
  capture_profile: "captureProfile",
  ota_status: "otaStatus",
  texture_ack: "textureAck",
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
const BYTES_KEYS_OUT = new Set([...BYTES_KEYS, "data", "payload", "keyEpoch"]);

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
      // OutputMapStats.warnings is optional in the flat types; alwaysEmitImplicit
      // would otherwise surface every warning-free map as `warnings: []`.
      if (k === "warnings" && Array.isArray(v) && v.length === 0) continue;
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

/** Upload a compiled effect (proto SubmitEffect). `deck` (FUG-110): 0 = A
 * (default), 1 = B — which of the two concurrent FX decks to load onto. */
export interface SubmitEffectMessage {
  type: "submit_effect";
  effectId: string;
  fxb: Uint8Array;
  activate: boolean;
  deck?: number;
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
  /** Firmware feature "texture_ack": non-zero asks for a TextureAck{seq} reply. */
  seq?: number;
  /** When to show the frame, ms on the shared effect time base (set_time_base). */
  presentAtMs?: number;
}

/** Reply to a set_texture carrying a seq (proto TextureAck): decode confirmed,
 * plus presentation telemetry. proto3 drops zero fields, hence the optionals. */
export interface TextureAckMessage {
  type: "texture_ack";
  seq?: number;
  shownSeq?: number;
  shownLateMs?: number;
  dropped?: number;
  queued?: number;
  shownAtMs?: number;
  clockJumps?: number;
}

/** Select the active effect by id (proto SetEffect). `deck` (FUG-110): 0 = A
 * (default), 1 = B. */
export interface SetEffectMessage {
  type: "set_effect";
  effectId: string;
  deck?: number;
}

/** Push live uniform values on a deck's effect (proto SetUniforms). `deck`
 * (FUG-110): 0 = A (default), 1 = B. */
export interface SetUniformsMessage {
  type: "set_uniforms";
  values: UniformValueFlat[];
  /** Persist (true / unset, the default) or apply live only (false): stream a
   * ramp uncommitted and commit once at the end. Firmware advertising the
   * "uniform_commit" feature honours it; older firmware always persists. */
  commit?: boolean;
  deck?: number;
}

/** Request an effect's manifest + current values (proto GetEffectUniforms).
 * `deck` (FUG-110): 0 = A (default), 1 = B. */
export interface GetEffectUniformsMessage {
  type: "get_effect_uniforms";
  effectId?: string;
  deck?: number;
}

/** Reply to get_effect_uniforms (proto EffectUniforms). `manifest` is the raw
 * compiler-emitted uniform-manifest JSON bytes. `deck` (FUG-110) echoes which
 * deck it describes. */
export interface EffectUniformsMessage {
  type: "effect_uniforms";
  effectId: string;
  manifest: Uint8Array;
  current: UniformValueFlat[];
  deck?: number;
}

/** Set the global FX crossfade (proto SetCrossfade, FUG-110). `position` is
 * 0.0 (all deck A) .. 1.0 (all deck B); `mode` is 0 = linear RGB, 1 = linear
 * HSV. Reply: welcome. */
export interface SetCrossfadeMessage {
  type: "set_crossfade";
  position: number;
  mode: number;
}

// -- Hardware-config arms (flat shapes) -------------------------------------
// GPIO / LED-type / wire-color-order config for an LED output channel (proto
// SetHardwareConfig / GetHardwareConfig / HardwareConfigState). New proto
// additions consumed only by the Hardware Setup page, so — like the effect arms
// above — the flat shapes live here rather than in the checked-in
// @ledmapper/protocol types. Field names are the proto3 JSON (camel) names.

/** The six wire color orders (permutations of "RGB"). "GRB" is the WS2812B
 * default. Each names which logical channel each of the three wire bytes
 * carries. */
export type ColorOrder = "RGB" | "RBG" | "GRB" | "GBR" | "BRG" | "BGR";
export const COLOR_ORDERS: ColorOrder[] = ["RGB", "RBG", "GRB", "GBR", "BRG", "BGR"];

/** Configure an LED output channel's hardware wiring (proto SetHardwareConfig).
 * Every field but the message tag is optional so the UI can nudge one setting at
 * a time; an unset field leaves that setting unchanged. Reply:
 * hardware_config_state. */
export interface SetHardwareConfigMessage {
  type: "set_hardware_config";
  channel?: number;
  gpio?: number;
  ledType?: string;
  colorOrder?: ColorOrder;
  /** Persist to flash (default) or apply from RAM only (false) — the color-order
   * test streams commit:false previews and commits once the user confirms. */
  commit?: boolean;
}

/** Request the per-channel hardware config (proto GetHardwareConfig). Reply:
 * hardware_config_state. */
export interface GetHardwareConfigMessage {
  type: "get_hardware_config";
}

/** One LED output channel's hardware config (proto HardwareChannel). */
export interface HardwareChannel {
  channel: number;
  gpio: number;
  ledType: string;
  colorOrder: ColorOrder;
  /** LEDs wired to this channel; 0 = not set (or firmware too old to store it).
   * Channels form one global LED index space in channel order. */
  ledCount: number;
}

/** Pin safety category (proto PinSafety). Rides the JSON boundary as its enum
 * NAME string (proto3 JSON), matching how toJson serializes enums. */
export type PinSafety =
  | "PIN_SAFETY_UNSPECIFIED"
  | "PIN_SAFETY_RECOMMENDED"
  | "PIN_SAFETY_CAUTION"
  | "PIN_SAFETY_AVOID";

/** One selectable GPIO for LED data output (proto GpioPin). */
export interface GpioPinFlat {
  gpio: number;
  safety: PinSafety;
  /** Board-specific reason for the confirm dialog; "" -> app uses default wording. */
  note: string;
}

/** One LED driver mode / chip family the firmware supports (proto LedMode). */
export interface LedModeFlat {
  id: string;
  label: string;
}

/** Static per-board hardware capabilities (proto BoardCapabilities): the pin
 * catalog + LED modes THIS board supports, for the Hardware Setup pickers. */
export interface BoardCapabilitiesFlat {
  board: string;
  gpioPins: GpioPinFlat[];
  ledModes: LedModeFlat[];
  /** Parallel LED output channels the firmware drives (0 = not reported). */
  ledChannels: number;
  /** Most LEDs the board drives, summed across channels (0 = not reported). */
  maxLeds: number;
  /** Most LEDs ONE channel carries (absent/0 = not reported: only maxLeds bounds
   * a channel). */
  maxLedsPerChannel?: number;
}

/** Reply to set/get_hardware_config (proto HardwareConfigState): the per-channel
 * config the device is running. */
export interface HardwareConfigStateMessage {
  type: "hardware_config_state";
  channels: HardwareChannel[];
  /** Static board capabilities (pin catalog + LED modes). Undefined on older
   * firmware that doesn't report them — the app falls back to a built-in catalog. */
  board?: BoardCapabilitiesFlat;
  /** The change outgrew this boot's LED buffers: persisted, and the device is
   * restarting to resize them (the connection drops; reconnect). */
  rebootRequired?: boolean;
  /** LEDs (summed across channels) this boot's buffers hold (absent on older
   * firmware). */
  ledCapacity?: number;
}

// -- Color-correction read-back (flat shapes) -------------------------------
// Request the device's current color correction + its reply (proto
// GetColorCorrection / ColorCorrectionState). Like the hardware-config arms
// above, these newer arms live as flat shapes here rather than in the checked-in
// @ledmapper/protocol types. Field names are the proto3 JSON (camel) names.

/** Request the device's current color correction (proto GetColorCorrection).
 * Reply: color_correction_state. */
export interface GetColorCorrectionMessage {
  type: "get_color_correction";
}

/** Reply to get_color_correction (proto ColorCorrectionState): the resolved
 * per-channel gamma + relative luminance the device is currently applying (what
 * the last set_color_correction stored). The Color Correction page hydrates its
 * curves from this on open; a gamma journey asserts the device reports the gamma
 * it was set to. Every field is present — the device always has a concrete
 * profile (the WS2812B default after a reboot). */
export interface ColorCorrectionStateMessage {
  type: "color_correction_state";
  gammaR: number;
  gammaG: number;
  gammaB: number;
  lumR: number;
  lumG: number;
  lumB: number;
}

/** List the effects the device stores (proto ListEffects): one slot today.
 * Firmware advertising the "list_effects" feature answers it. Reply: effect_list. */
export interface ListEffectsMessage {
  type: "list_effects";
}

/** One stored effect (proto StoredEffect). */
export interface StoredEffectFlat {
  effectId: string;
  /** .fxb bytecode size in bytes. */
  fxbBytes: number;
  /** Whether it is the active (rendering) effect. */
  active: boolean;
  /** The FX deck it is loaded on (0 = A, 1 = B). */
  deck?: number;
}

// -- Uniform keypoints (docs/design/uniform-keypoints.md) --------------------

/** One stored keypoint in a list (proto KeypointInfo). `stale` = saved against
 * another build of the effect (still recalls, by uniform name). */
export interface KeypointInfoFlat {
  index: number;
  name: string;
  stale: boolean;
}

/** Reply to save/delete/list_keypoints (proto KeypointList). */
export interface KeypointListMessage {
  type: "keypoint_list";
  effectId: string;
  deck?: number;
  keypoints: KeypointInfoFlat[];
  capacity: number;
}

/** A stored value by uniform name (proto KeypointValue). */
export interface KeypointValueFlat {
  uniform: string;
  value: number[];
}

/** Reply to get_keypoint (proto Keypoint). */
export interface KeypointMessage {
  type: "keypoint";
  effectId: string;
  index: number;
  name: string;
  stale: boolean;
  values: KeypointValueFlat[];
  /** The same values resolved to the loaded effect's slots. */
  slots: UniformValueFlat[];
}

/** One term of a keypoint blend (proto KeypointWeight). */
export interface KeypointWeightFlat {
  name: string;
  weight: number;
}

/** blend_keypoints options: `seconds` > 0 morphs; `colorMode` 0 = linear RGB,
 * 1 = HSV; `commit` persists the target (deck A). */
export interface BlendOptions {
  deck?: number;
  seconds?: number;
  colorMode?: number;
  commit?: boolean;
}

/** Ask for the device's TLS identity (proto GetTlsInfo; the "tls_info" feature):
 * works over BLE too, so the app can tell whether wss is up yet. Reply: tls_info. */
export interface GetTlsInfoMessage {
  type: "get_tls_info";
}

/** Reply to get_tls_info (proto TlsInfo): the device's own TLS identity
 * (docs/design/per-device-cert.md). */
export interface TlsInfoMessage {
  type: "tls_info";
  /** "generating" (first-boot keygen; wss:443 not open yet) or "ready". */
  state: string;
  /** SHA-256 of the served certificate (hex); "" while generating. */
  certSha256: string;
  /** False when the identity couldn't be saved to flash (changes on reboot). */
  persisted: boolean;
}

// -- framerate autoscaler (FUG-82; the "fps" feature) ------------------------
// The player runs effects at a consistent rate on a 5-fps ladder (25..80),
// adapted to each frame's cost with 5% headroom. An effect too heavy for the
// floor (or a pinned rate) is never parked: it keeps rendering as fast as it can
// ("lagging"), and the player pushes fps_state when that starts or stops.

/** Override the effect framerate (proto SetFps). `targetFps` 0 = autoscale,
 * otherwise pin that rate (snapped to the ladder). Reply: fps_state. */
export interface SetFpsMessage {
  type: "set_fps";
  targetFps: number;
  /** @deprecated Ignored by current firmware (nothing is parked any more); old
   * firmware read it as "hold the rung instead of parking the effect". */
  noAbort?: boolean;
}

/** Framerate autoscaler state (proto FpsState): the set_fps reply, and pushed
 * unsolicited when the effect starts or stops `lagging` (advisory: nothing
 * stops). `targetFps` = the pin (0 = auto); `currentFps` the rate the effect
 * really runs at (the rung, or the achieved rate while lagging). */
export interface FpsStateMessage {
  type: "fps_state";
  targetFps: number;
  currentFps: number;
  minFps: number;
  maxFps: number;
  auto: boolean;
  /** The effect can't hold `minFps` / the pinned rate and runs below it. */
  lagging: boolean;
  /** Measured rate of the last ~30-frame window (0 = not measured yet). */
  achievedFps: number;
  /** @deprecated Always false on current firmware; firmware before the lag
   * change set it when it parked (stopped) a slow effect. */
  aborted: boolean;
  /** @deprecated Always false (echo of the ignored SetFps.noAbort). */
  noAbort: boolean;
}

/** Normalize a decoded fps_state (proto3 drops zero / false fields). */
export function flatFpsState(m: Partial<FpsStateMessage>): FpsStateMessage {
  return {
    type: "fps_state",
    targetFps: m.targetFps ?? 0,
    currentFps: m.currentFps ?? 0,
    minFps: m.minFps ?? 0,
    maxFps: m.maxFps ?? 0,
    auto: m.auto ?? false,
    lagging: m.lagging ?? false,
    achievedFps: m.achievedFps ?? 0,
    aborted: m.aborted ?? false,
    noAbort: m.noAbort ?? false,
  };
}

/** Firmware update over the air (docs/design/ota.md): the device's update state —
 * the reply to every OTA arm, and `welcome.ota` from the update loader. Enums arrive
 * as their proto names (proto3 JSON). */
export interface OtaStatusFlat {
  /** "MODE_APP" (the player) | "MODE_LOADER" (the update loader / recovery). */
  mode: string;
  /** "STATE_IDLE" | "STATE_REBOOTING" | "STATE_RECEIVING" | "STATE_VERIFYING" |
   * "STATE_INSTALLED" | "STATE_FAILED". */
  state: string;
  version: number;
  size: number;
  /** The next byte the loader wants (resume point). */
  offset: number;
  /** Refusal code (bad_signature, out_of_order, legacy_layout, …); "" when fine. */
  error: string;
  appVersion: number;
  appFwVersion: string;
  loaderReason: string;
  lastResult: string;
  loaderVersion: number;
  maxChunk: number;
  slotSize: number;
}

export interface OtaStatusMessage extends OtaStatusFlat {
  type: "ota_status";
}

/** Motion-sensor status (proto SensorStatus), as its enum NAME (proto3 JSON). */
export type SensorStatus =
  | "SENSOR_STATUS_UNSPECIFIED"
  | "SENSOR_STATUS_ABSENT"
  | "SENSOR_STATUS_UNKNOWN_DEVICE"
  | "SENSOR_STATUS_STARTING"
  | "SENSOR_STATUS_RUNNING"
  | "SENSOR_STATUS_FAULT"
  | "SENSOR_STATUS_DISABLED";

/** Calibration actions (proto CalibrateSensors.Action). */
export type SensorCalibration = "gyro_bias" | "level" | "reset";

/** Reply to get_sensors / calibrate_sensors (proto SensorState; the "sensors"
 * feature, docs/design/sensor-core.md). Vectors are empty unless RUNNING. */
export interface SensorStateMessage {
  type: "sensor_state";
  status: SensorStatus;
  part: string;
  i2cAddress: number;
  whoAmI: number;
  sdaGpio: number;
  sclGpio: number;
  /** m/s^2, fixture frame, gravity included. */
  accel: number[];
  /** rad/s, fixture frame, bias-corrected. */
  gyro: number[];
  /** w, x, y, z: fixture -> world (z up; yaw drifts without a magnetometer). */
  quat: number[];
  /** Unit DOWN vector, fixture frame. */
  gravity: number[];
  /** m/s^2, world frame, gravity removed. */
  linearAccel: number[];
  gyroBias: number[];
  temperatureC: number;
  shake: number;
  tapCount: number;
  shakeCount: number;
  atRest: boolean;
  sampleRateHz: number;
  samples: number;
  fifoOverflows: number;
  busErrors: number;
  fifo: boolean;
  calibrated: boolean;
  accelScaleCorrected: boolean;
  fusionCycles: number;
  calibrationSeq: number;
  calibrationResult: string;
  /** MPU INT pin (-1 = none); recorded, the device polls today. */
  intGpio: number;
  /** Settled up in the RAW IMU frame while at rest (extrinsic calibration). */
  restUpImu: number[];
  restUpSigmaDeg: number;
  restSamples: number;
  /** R_fi (IMU -> map frame), w,x,y,z. */
  mountQuat: number[];
  mountExtrinsic: boolean;
  mountYawResolved: boolean;
  mountPoses: number;
  mountResidualDeg: number;
  mountCalibratedAtMs: number;
}

/** Reply to scan_i2c (proto I2cScanResult): ACKing 7-bit addresses. */
export interface I2cScanResultMessage {
  type: "i2c_scan_result";
  addresses: number[];
}

/** Reply to submit_driver / remove_driver / get_driver_state (proto
 * DriverState; the "drivers" feature, FUG-107). */
export interface DriverStateMessage {
  type: "driver_state";
  running: boolean;
  pollIntervalMs: number;
  exports: { name: string; value: number[] }[];
  lastPoll: string;
  polls: number;
  busErrors: number;
  pollCyclesMean: number;
  pollCyclesMax: number;
  pollInstrsMean: number;
  busOps: number;
  heapBytes: number;
  jitterUsMax: number;
  feedImu: boolean;
}

/** Reply to list_effects (proto EffectList). */
export interface EffectListMessage {
  type: "effect_list";
  effects: StoredEffectFlat[];
}

/** A fixture's pose in a shared room frame (proto FixturePose): room-frame LED
 * position = translation + rotation * (scale * led.pos). */
export interface FixturePoseFlat {
  room: string;
  /** metres, [x, y, z] */
  translation: number[];
  /** unit quaternion [x, y, z, w]; empty = identity */
  rotation: number[];
  /** 0 = 1 */
  scale: number;
  /** Optional room bounding box (room.min / room.max); empty = the fixture's own. */
  roomMin?: number[];
  roomMax?: number[];
}

/** Set (or clear) the fixture's room pose. Firmware advertising "fixture_pose"
 * answers it; persisted unless commit=false. Reply: welcome (with `pose`). */
export interface SetFixturePoseMessage {
  type: "set_fixture_pose";
  pose?: FixturePoseFlat;
  clear?: boolean;
  commit?: boolean;
}

/** Pin effect time to a shared epoch in the DEVICE's clock (time_sync_pong's
 * domain): time = (now - epochMs) / 1000. Firmware advertising "time_base"
 * answers it; runtime only. Reply: welcome (with `timeBaseMs`). */
export interface SetTimeBaseMessage {
  type: "set_time_base";
  epochMs: number;
  clear?: boolean;
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
  /** The framerate autoscaler's live target FPS (FUG-82); budgetCycles =
   * cpuHz / currentFps. 0/absent = firmware without it (fixed 30 fps budget). */
  currentFps?: number;
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
  heapLargestFree: number;
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
