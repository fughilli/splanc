/**
 * FX debugger — host side (docs/design/fx-debugger.md).
 *
 * The device can pause its FX engine, step frames at an exact time / dt, and
 * stream back what it rendered and the VM state behind it (firmware/player_app
 * fxdbg.rs). This module:
 *
 *   - drives that protocol over any {@link FxDebugLink} (the app's
 *     LedMapperClient, the agent bridge's session) and reassembles the chunked
 *     snapshot sections ({@link FxDebugger});
 *   - decodes the binary layouts (FX_FRAME_V1, FX_LED_V1);
 *   - REPLAYS a stepped frame on the host VM (the wasm build of the firmware VM,
 *     `FxReplay`) from the device's own pre-step state and inputs, and diffs it
 *     per LED against the device ({@link replayFrame});
 *   - and runs the whole "why doesn't the fixture match the preview?" procedure
 *     ({@link compareWithPreview}): device vs replay (engine bugs: VM, JIT,
 *     firmware), replay vs the preview's own inputs (map / topology / uv / LED
 *     order differences), and the output stage (brightness, colour LUT, wire
 *     order), with the VM locals of the first divergent LEDs on both sides.
 *
 * Shared by the effect workspace's live debugger panel and the agent bridge's
 * compare_with_preview tool, so both reach the same verdict.
 */

import {
  b64ToBytes,
  FX_DEBUG_ACTION,
  FX_SECTION,
  type DebugFxLedMessage,
  type FxDebugControlMessage,
  type FxDebugMessage,
  type FxDebugStateFlat,
  type FxSectionName,
  type GetFxSnapshotMessage,
  type MappingBundle,
} from "../net/proto";
import { deriveLedTopology, type FxSymbol } from "./preview";

// -- the link -----------------------------------------------------------------

/** The three debugger requests (LedMapperClient implements them). */
export interface FxDebugLink {
  fxDebugControl(msg: Omit<FxDebugControlMessage, "type">): Promise<FxDebugMessage>;
  getFxSnapshot(msg: Omit<GetFxSnapshotMessage, "type">): Promise<FxDebugMessage>;
  debugFxLed(msg: Omit<DebugFxLedMessage, "type">): Promise<FxDebugMessage>;
}

/** Bytes per FX_LED_V1 record / FX_FRAME_V1 context (ledmapper_fx_vm::dbg). */
export const LED_CTX_BYTES = 44;
export const FRAME_CTX_BYTES = 124;
/** VM sizes (firmware/fx_vm MAX_STATE / MAX_UNIFORM_SLOTS / MAX_LOCALS). */
export const MAX_STATE = 128;
export const MAX_UNIFORM_SLOTS = 128;
export const MAX_LOCALS = 128;

// -- decoded engine state ---------------------------------------------------------

export interface FxDeckInfo {
  deck: number;
  effectId: string;
  fxbHash: number;
  fxbBytes: number;
  renders: boolean;
  flags: number;
  jitBlocks: number;
  arenaBytes: number;
  morphRunning: boolean;
}

export interface FxEngineState {
  paused: boolean;
  stepsPending: number;
  holdRemainingMs: number;
  /** The last rendered frame. */
  time: number;
  dt: number;
  frame: number;
  ledCount: number;
  decks: FxDeckInfo[];
  crossfade: number;
  crossfadeMode: number;
  currentFps: number;
  targetFps: number;
  /** 0..255 nscale8 after the LUT (255 = unscaled). */
  brightness: number;
  lut: boolean;
  /** Per channel: wire byte k = output[perm[k]]. */
  colorOrder: [number[], number[]];
  channelLeds: [number, number];
  frameCtx: Uint8Array;
  lastUpdateOutcome: number;
  budget: number;
  timeBase: boolean;
  resumeReason: string;
  layoutVersion: number;
}

const bytesOf = (v: unknown): Uint8Array =>
  v instanceof Uint8Array ? v : typeof v === "string" && v.length > 0 ? b64ToBytes(v) : new Uint8Array(0);

export function parseEngineState(s: FxDebugStateFlat): FxEngineState {
  const order = bytesOf(s.colorOrder);
  return {
    paused: !!s.paused,
    stepsPending: s.stepsPending ?? 0,
    holdRemainingMs: s.holdRemainingMs ?? 0,
    time: s.time ?? 0,
    dt: s.dt ?? 0,
    frame: s.frame ?? 0,
    ledCount: s.ledCount ?? 0,
    decks: (s.decks ?? []).map((d) => ({
      deck: d.deck ?? 0,
      effectId: d.effectId ?? "",
      fxbHash: (d.fxbHash ?? 0) >>> 0,
      fxbBytes: d.fxbBytes ?? 0,
      renders: !!d.renders,
      flags: d.flags ?? 0,
      jitBlocks: d.jitBlocks ?? 0,
      arenaBytes: d.arenaBytes ?? 0,
      morphRunning: !!d.morphRunning,
    })),
    crossfade: s.crossfade ?? 0,
    crossfadeMode: s.crossfadeMode ?? 0,
    currentFps: s.currentFps ?? 0,
    targetFps: s.targetFps ?? 0,
    brightness: s.brightness ?? 255,
    lut: !!s.lut,
    colorOrder: [Array.from(order.subarray(0, 3)), Array.from(order.subarray(3, 6))],
    channelLeds: [s.channel0Leds ?? 0, s.channel1Leds ?? 0],
    frameCtx: bytesOf(s.frameCtx),
    lastUpdateOutcome: s.lastUpdateOutcome ?? 0,
    budget: s.budget ?? 0,
    timeBase: !!s.timeBase,
    resumeReason: s.resumeReason ?? "",
    layoutVersion: s.layoutVersion ?? 0,
  };
}

// -- layouts ------------------------------------------------------------------------

export interface LedInputs {
  pos: [number, number, number];
  s: number;
  dist: number;
  uv: [number, number];
  room: [number, number, number];
  seg: number;
  branch: boolean;
  /** The LED has a map entry (else it rendered black). */
  hasEntry: boolean;
  /** Its position was measured (not interpolated between neighbours). */
  measured: boolean;
}

/** Decode one FX_LED_V1 record. */
export function decodeLedRecord(rec: Uint8Array): LedInputs {
  const dv = new DataView(rec.buffer, rec.byteOffset, rec.byteLength);
  const f = (k: number): number => dv.getFloat32(k * 4, true);
  return {
    pos: [f(0), f(1), f(2)],
    s: f(3),
    dist: f(4),
    uv: [f(5), f(6)],
    room: [f(7), f(8), f(9)],
    seg: dv.getInt16(40, true),
    branch: rec[42] !== 0,
    hasEntry: ((rec[43] ?? 0) & 1) !== 0,
    measured: ((rec[43] ?? 0) & 2) !== 0,
  };
}

/** Encode FX_LED_V1 (the host builds records for the PREVIEW's inputs). */
export function encodeLedRecord(l: LedInputs): Uint8Array {
  const rec = new Uint8Array(LED_CTX_BYTES);
  const dv = new DataView(rec.buffer);
  const vals = [l.pos[0], l.pos[1], l.pos[2], l.s, l.dist, l.uv[0], l.uv[1], l.room[0], l.room[1], l.room[2]];
  vals.forEach((v, k) => dv.setFloat32(k * 4, v, true));
  dv.setInt16(40, l.hasEntry ? l.seg : -1, true);
  rec[42] = l.branch ? 1 : 0;
  rec[43] = (l.hasEntry ? 1 : 0) | (l.measured ? 2 : 0);
  return rec;
}

export interface FrameInputs {
  time: number;
  dt: number;
  frame: number;
  ledCount: number;
  imuAccel: number[];
  imuGyro: number[];
  roomPosed: boolean;
  roomMin: number[];
  roomMax: number[];
}

/** Decode FX_FRAME_V1. */
export function decodeFrameCtx(ctx: Uint8Array): FrameInputs | null {
  if (ctx.length < FRAME_CTX_BYTES) return null;
  const dv = new DataView(ctx.buffer, ctx.byteOffset, ctx.byteLength);
  const f = (k: number): number => dv.getFloat32(k * 4, true);
  const u = (k: number): number => dv.getUint32(k * 4, true);
  return {
    time: f(0),
    dt: f(1),
    frame: u(2),
    ledCount: u(3),
    imuAccel: [f(4), f(5), f(6)],
    imuGyro: [f(7), f(8), f(9)],
    roomPosed: u(18) !== 0,
    roomMin: [f(19), f(20), f(21)],
    roomMax: [f(22), f(23), f(24)],
  };
}

/** The device's output stage (main.cpp cc_apply): the colour LUT, then nscale8
 * by the global brightness unless it is 255. */
export function outputStage(rgb: ArrayLike<number>, lut: Uint8Array | null, brightness: number): [number, number, number] {
  const c = [0, 1, 2].map((k) => {
    const v = rgb[k] ?? 0;
    return lut && lut.length >= 768 ? (lut[k * 256 + v] ?? 0) : v;
  });
  if (brightness < 255) for (let k = 0; k < 3; k++) c[k] = (c[k]! * brightness) >> 8;
  return [c[0]!, c[1]!, c[2]!];
}

// -- the .fxb (header, manifest, buffer table) -----------------------------------

export interface FxbBuffer {
  /** 0 = per-LED buffer, 1 = 2D texture. */
  kind: number;
  /** Components per element. */
  elem: number;
  /** Component storage (fx_vm `comp`: 0 f32, 1 fixed16, 2 fixed8, 3 i16, 4 i8,
   * 5 fixed16->float, 6 fixed8->float, 7 i32). */
  comp: number;
  w: number;
  h: number;
}

export interface FxbLayout {
  version: number;
  flags: number;
  nState: number;
  nUniformSlots: number;
  manifest: { name: string; slot: number; width: number }[];
  buffers: FxbBuffer[];
}

/** Parse a .fxb's header, uniform manifest and buffer table (fx_vm Program::parse). */
export function parseFxbLayout(fxb: Uint8Array): FxbLayout | null {
  if (fxb.length < 18 || String.fromCharCode(...fxb.subarray(0, 4)) !== "FXB1") return null;
  const dv = new DataView(fxb.buffer, fxb.byteOffset, fxb.byteLength);
  const flags = fxb[5]!;
  const mlen = dv.getUint16(8, true);
  const nConsts = dv.getUint16(10, true);
  const codeLen = dv.getUint16(12, true);
  let manifest: FxbLayout["manifest"] = [];
  try {
    const parsed = JSON.parse(new TextDecoder().decode(fxb.subarray(18, 18 + mlen))) as unknown;
    if (Array.isArray(parsed)) manifest = parsed as FxbLayout["manifest"];
  } catch {
    manifest = [];
  }
  let o = 18 + mlen + nConsts * 4 + codeLen;
  const buffers: FxbBuffer[] = [];
  if (flags & 0x01 && o < fxb.length) {
    const nb = fxb[o]!;
    o++;
    for (let i = 0; i < nb && o + 7 <= fxb.length; i++, o += 7) {
      buffers.push({ kind: fxb[o]!, elem: fxb[o + 1]!, comp: fxb[o + 2]!, w: dv.getUint16(o + 3, true), h: dv.getUint16(o + 5, true) });
    }
  }
  return { version: fxb[4]!, flags, nState: fxb[6]!, nUniformSlots: fxb[7]!, manifest, buffers };
}

const COMP_BYTES = [4, 2, 1, 2, 1, 2, 1, 4];

/** Element `i` of buffer `b` from a deck's arena, as numbers (fx_vm
 * comp_load_num: fixed/int dequantized). `ledCount` sizes per-LED buffers. */
export function bufferElement(layout: FxbLayout, arena: Uint8Array, b: number, i: number, ledCount: number): number[] | null {
  let base = 0;
  for (let k = 0; k < b; k++) {
    const d = layout.buffers[k];
    if (!d) return null;
    base += d.elem * (COMP_BYTES[d.comp] ?? 4) * (d.kind === 0 ? ledCount : d.w * d.h);
  }
  const d = layout.buffers[b];
  if (!d) return null;
  const cb = COMP_BYTES[d.comp] ?? 4;
  const at = base + i * d.elem * cb;
  if (at + d.elem * cb > arena.length) return null;
  const dv = new DataView(arena.buffer, arena.byteOffset, arena.byteLength);
  const out: number[] = [];
  for (let c = 0; c < d.elem; c++) {
    const p = at + c * cb;
    switch (d.comp) {
      case 0:
        out.push(dv.getFloat32(p, true));
        break;
      case 7:
        out.push(dv.getInt32(p, true));
        break;
      case 3:
        out.push(dv.getInt16(p, true));
        break;
      case 4:
        out.push(dv.getInt8(p));
        break;
      case 1:
      case 5:
        out.push(dv.getInt16(p, true) / (1 << 14));
        break;
      case 2:
      case 6:
        out.push(dv.getInt8(p) / (1 << 6));
        break;
      default:
        out.push(0);
    }
  }
  return out;
}

/** FNV-1a of a .fxb (the device's fxb_hash), to match a compiled effect to a deck. */
export function fxbHash(b: Uint8Array): number {
  let h = 0x811c9dc5;
  for (const x of b) {
    h ^= x;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// -- the protocol driver ----------------------------------------------------------

export interface FxDeckSnapshot {
  deck: number;
  info: FxDeckInfo;
  program?: Uint8Array;
  uniforms?: Float32Array;
  /** SECTION_STATE words: MAX_STATE state slots, then the flood_from field. */
  state?: Uint32Array;
  arena?: Uint8Array;
  graph?: Uint32Array;
  /** FX_LED_V1 records for LEDs [first, first + count). */
  ledContext?: Uint8Array;
}

export interface FxSnapshot {
  state: FxEngineState;
  first: number;
  count: number;
  /** [first, first + count) x RGB, as the strip shows it (post LUT/brightness). */
  output?: Uint8Array;
  /** The same in wire order. */
  wire?: Uint8Array;
  lut?: Uint8Array | null;
  decks: FxDeckSnapshot[];
}

export type DeckSection = "program" | "uniforms" | "state" | "arena" | "graph" | "ledContext";
export type FrameSection = "output" | "wire" | "lut";

export interface SnapshotOptions {
  /** Decks to read (default: every loaded deck). */
  decks?: number[];
  deckSections?: DeckSection[];
  frameSections?: FrameSection[];
  /** LED range for per-LED sections (default: the whole frame). */
  first?: number;
  count?: number;
}

export interface FxLedDebug {
  led: number;
  deck: number;
  /** The deck's own shade() on the interpreter / the normal path (JIT). */
  rgb: number[];
  rgbJit: number[] | null;
  output: number[];
  outcome: number;
  locals: Float32Array;
  inputs: LedInputs;
  ledContext: Uint8Array;
  instructions: number;
  stackMax: number;
}

const toF32 = (v: number | string): number =>
  typeof v === "number" ? v : v === "NaN" ? NaN : v === "Infinity" ? Infinity : v === "-Infinity" ? -Infinity : Number(v);

/** Device-side debugger: pause / step / read, chunked and serialized. */
export class FxDebugger {
  /** Bytes per snapshot request (the device caps it at 1536). */
  chunkBytes: number;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly link: FxDebugLink,
    opts: { chunkBytes?: number } = {},
  ) {
    this.chunkBytes = Math.max(64, Math.min(1536, opts.chunkBytes ?? 768));
  }

  /** Run `fn` after every earlier call (the link is single-flight per reply). */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async control(msg: Omit<FxDebugControlMessage, "type">): Promise<FxEngineState> {
    const r = await this.link.fxDebugControl(msg);
    if (!r.state) throw new Error("fx_debug_control: no state in the reply");
    return parseEngineState(r.state);
  }

  status(holdMs?: number): Promise<FxEngineState> {
    return this.serial(() => this.control({ action: FX_DEBUG_ACTION.status, ...(holdMs ? { holdMs } : {}) }));
  }

  /** Freeze the engine (the strip holds the last frame). `holdMs`: the lease. */
  pause(holdMs?: number): Promise<FxEngineState> {
    return this.serial(() => this.control({ action: FX_DEBUG_ACTION.pause, ...(holdMs ? { holdMs } : {}) }));
  }

  resume(): Promise<FxEngineState> {
    return this.serial(() => this.control({ action: FX_DEBUG_ACTION.resume }));
  }

  /** Render `frames` (or one frame at exactly `toTime`) and wait until they have
   * rendered. Pauses first if running. */
  async step(
    opts: { frames?: number; dt?: number; toTime?: number; holdMs?: number; timeoutMs?: number } = {},
  ): Promise<FxEngineState> {
    let st = await this.serial(() =>
      this.control({
        action: FX_DEBUG_ACTION.step,
        frames: opts.frames ?? 1,
        ...(opts.dt !== undefined ? { dt: opts.dt } : {}),
        ...(opts.toTime !== undefined ? { toTime: opts.toTime } : {}),
        ...(opts.holdMs ? { holdMs: opts.holdMs } : {}),
      }),
    );
    const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
    while (st.stepsPending > 0) {
      if (Date.now() > deadline) throw new Error(`step: ${st.stepsPending} frames still pending`);
      await new Promise((r) => setTimeout(r, Math.min(200, 15 + st.stepsPending * 10)));
      st = await this.status(opts.holdMs);
    }
    return st;
  }

  /** Bytes [offset, offset + length) of a section (length -1 = to its end). */
  readSection(section: FxSectionName, deck = 0, offset = 0, length = -1): Promise<Uint8Array> {
    return this.serial(async () => {
      const parts: Uint8Array[] = [];
      let got = 0;
      let total = -1;
      let at = offset;
      for (;;) {
        const want = length < 0 ? this.chunkBytes : Math.min(this.chunkBytes, length - got);
        if (length >= 0 && want <= 0) break;
        const r = await this.link.getFxSnapshot({ section: FX_SECTION[section], deck, offset: at, maxLen: want });
        const c = r.chunk;
        if (!c) throw new Error("get_fx_snapshot: no chunk in the reply");
        total = c.totalLen ?? 0;
        const data = bytesOf(c.data);
        parts.push(data);
        got += data.length;
        at += data.length;
        if (data.length === 0 || at >= total) break;
      }
      const out = new Uint8Array(got);
      let o = 0;
      for (const p of parts) {
        out.set(p, o);
        o += p.length;
      }
      return out;
    });
  }

  /** Read a snapshot of the engine (pause first for a consistent one). */
  async snapshot(opts: SnapshotOptions = {}): Promise<FxSnapshot> {
    const state = await this.status();
    const n = state.ledCount;
    const first = Math.max(0, Math.min(n, opts.first ?? 0));
    const count = Math.max(0, Math.min(n - first, opts.count ?? n));
    const snap: FxSnapshot = { state, first, count, decks: [] };
    const fs = opts.frameSections ?? ["output"];
    if (fs.includes("output")) snap.output = await this.readSection("output", 0, first * 3, count * 3);
    if (fs.includes("wire")) snap.wire = await this.readSection("wire", 0, first * 3, count * 3);
    if (fs.includes("lut")) {
      const lut = await this.readSection("lut");
      snap.lut = lut.length >= 768 ? lut : null;
    }
    const ds = opts.deckSections ?? ["program", "uniforms", "state", "arena", "graph", "ledContext"];
    for (const info of state.decks) {
      if (opts.decks && !opts.decks.includes(info.deck)) continue;
      const d: FxDeckSnapshot = { deck: info.deck, info };
      if (ds.includes("program")) d.program = await this.readSection("program", info.deck);
      if (ds.includes("uniforms")) d.uniforms = f32View(await this.readSection("uniforms", info.deck));
      if (ds.includes("state")) d.state = u32View(await this.readSection("state", info.deck));
      if (ds.includes("arena")) d.arena = await this.readSection("arena", info.deck);
      if (ds.includes("graph")) d.graph = u32View(await this.readSection("graph", info.deck));
      if (ds.includes("ledContext"))
        d.ledContext = await this.readSection("ledContext", info.deck, first * LED_CTX_BYTES, count * LED_CTX_BYTES);
      snap.decks.push(d);
    }
    return snap;
  }

  /** Re-run LED `led` of the paused frame on deck `deck` with its VM locals. */
  debugLed(led: number, deck = 0, maxLocals = 0): Promise<FxLedDebug> {
    return this.serial(async () => {
      const r = await this.link.debugFxLed({ led, deck, maxLocals });
      const l = r.led;
      if (!l) throw new Error("debug_fx_led: no led in the reply");
      const ctx = bytesOf(l.ledContext);
      const jit = bytesOf(l.rgbJit);
      return {
        led: l.led ?? led,
        deck: l.deck ?? deck,
        rgb: Array.from(bytesOf(l.rgb)),
        rgbJit: jit.length === 3 ? Array.from(jit) : null,
        output: Array.from(bytesOf(l.output)),
        outcome: l.outcome ?? 0,
        locals: Float32Array.from((l.locals ?? []).map(toF32)),
        inputs: decodeLedRecord(ctx.length >= LED_CTX_BYTES ? ctx : new Uint8Array(LED_CTX_BYTES)),
        ledContext: ctx,
        instructions: l.instructions ?? 0,
        stackMax: l.stackMax ?? 0,
      };
    });
  }
}

function f32View(b: Uint8Array): Float32Array {
  const c = b.slice();
  return new Float32Array(c.buffer, 0, c.length >> 2);
}
function u32View(b: Uint8Array): Uint32Array {
  const c = b.slice();
  return new Uint32Array(c.buffer, 0, c.length >> 2);
}

// -- host replay ------------------------------------------------------------------

/** The wasm VM's replay surface (//firmware/fx_vm:fx_vm_web, bin/wasm_lib.rs). */
export interface FxReplayWasm {
  set_budget(n: number): void;
  set_uniforms(v: Float32Array): void;
  set_state(w: Uint32Array): void;
  state(): Uint32Array;
  set_graph_words(w: Uint32Array): void;
  set_arena(b: Uint8Array): void;
  arena(): Uint8Array;
  set_frame(ctx: Uint8Array): boolean;
  update(): number;
  shade(rec: Uint8Array, idx: number): Uint8Array;
  /** shade() with LED idx's per-LED buffer elements restored afterwards. */
  shade_isolated(rec: Uint8Array, idx: number): Uint8Array;
  /** The device's debug_fx_led run: isolated, zeroed scratch; + instrs/stack. */
  shade_debug(rec: Uint8Array, idx: number): Uint8Array;
  locals(): Float32Array;
  free(): void;
}

export interface ReplayVm {
  FxReplay: new (fxb: Uint8Array) => FxReplayWasm;
  fx_blend_rgb8(a: Uint8Array, b: Uint8Array, t: number, mode: number): Uint8Array;
}

export interface LedMismatch {
  led: number;
  device: number[];
  expected: number[];
  /** The replay's pre-output-stage colour (blended across decks). */
  raw: number[];
}

export interface ReplayResult {
  /** The replayed (stepped) frame. */
  frame: number;
  time: number;
  dt: number;
  first: number;
  count: number;
  /** Per deck: update() outcome. */
  updateOutcome: Record<number, number>;
  /** LEDs whose device output != the replay's (the engine diverged). */
  mismatches: LedMismatch[];
  /** Largest per-channel |device - expected|. */
  maxDelta: number;
  /** Per deck: state slots whose post-frame value differs (device vs host). */
  stateMismatch: Record<number, { slot: number; device: number; host: number }[]>;
  /** Per deck: buffer-arena bytes that differ after the frame (only with the
   * whole frame shaded: a buffer-writing shade() touches every LED's slot). */
  arenaMismatch: Record<number, { bytes: number; firstOffset: number } | null>;
  /** Per deck: the replay's raw shade() colours, [count x 3]. */
  deckRaw: Record<number, Uint8Array>;
  /** Blended raw colour, [count x 3]. */
  raw: Uint8Array;
  /** Expected strip colours (raw through the output stage). */
  expected: Uint8Array;
  notes: string[];
  /** Live replays per deck (positioned after the frame), for locals. Dispose with
   * {@link disposeReplay}. */
  vms: Record<number, FxReplayWasm>;
}

export function disposeReplay(r: ReplayResult): void {
  for (const v of Object.values(r.vms)) v.free();
  r.vms = {};
}

/** Which decks shade LED colours, per the firmware's two-deck rule (ffi.rs
 * fx_shade_decks): at an endpoint only that deck shades. */
function shadingDecks(st: FxEngineState): { a: boolean; b: boolean } {
  const ra = st.decks.find((d) => d.deck === 0)?.renders ?? false;
  const rb = st.decks.find((d) => d.deck === 1)?.renders ?? false;
  return {
    a: ra && !(rb && st.crossfade >= 1),
    b: rb && !(ra && st.crossfade <= 0),
  };
}

/**
 * Replay the frame `after` shows from the device's state in `before` (its
 * program / state / buffers, read while paused just before the step) and the
 * frame's own inputs from `after` (frame context, uniforms, graph, per-LED
 * inputs), then diff per LED. `before` needs program/state/arena per deck;
 * `after` needs output, ledContext, uniforms, graph (+ state/arena to diff them).
 */
export function replayFrame(vm: ReplayVm, before: FxSnapshot, after: FxSnapshot): ReplayResult {
  const st = after.state;
  const first = after.first;
  const count = after.count;
  const frame = decodeFrameCtx(st.frameCtx);
  const res: ReplayResult = {
    frame: st.frame,
    time: st.time,
    dt: st.dt,
    first,
    count,
    updateOutcome: {},
    mismatches: [],
    maxDelta: 0,
    stateMismatch: {},
    arenaMismatch: {},
    deckRaw: {},
    raw: new Uint8Array(count * 3),
    expected: new Uint8Array(count * 3),
    notes: [],
    vms: {},
  };
  if (!frame) {
    res.notes.push("the device sent no frame context (firmware layout mismatch?)");
    return res;
  }
  if (st.layoutVersion !== 1) res.notes.push(`snapshot layout v${st.layoutVersion} (this host speaks v1)`);
  const shading = shadingDecks(st);
  for (const d of after.decks) {
    const b = before.decks.find((x) => x.deck === d.deck);
    if (!d.info.renders) continue;
    if (!b?.program || !b.state || !b.arena || !d.uniforms || !d.ledContext) {
      res.notes.push(`deck ${d.deck}: snapshot is missing sections, not replayed`);
      continue;
    }
    if (b.info.fxbHash !== d.info.fxbHash) {
      res.notes.push(`deck ${d.deck}: the effect changed between the two snapshots`);
      continue;
    }
    const r = new vm.FxReplay(b.program);
    res.vms[d.deck] = r;
    r.set_budget(st.budget);
    r.set_uniforms(d.uniforms);
    r.set_state(b.state);
    if (d.graph) r.set_graph_words(d.graph);
    r.set_arena(b.arena);
    r.set_frame(st.frameCtx);
    res.updateOutcome[d.deck] = r.update();
    const raw = new Uint8Array(count * 3);
    const shades = d.deck === 0 ? shading.a : shading.b;
    for (let i = 0; i < count; i++) {
      const rec = d.ledContext.subarray(i * LED_CTX_BYTES, (i + 1) * LED_CTX_BYTES);
      if (rec.length < LED_CTX_BYTES || !shades) continue;
      const o = r.shade(rec, first + i);
      raw.set(o.subarray(0, 3), i * 3);
    }
    res.deckRaw[d.deck] = raw;
    if (d.state) {
      const host = r.state();
      const diffs: { slot: number; device: number; host: number }[] = [];
      for (let k = 0; k < Math.min(host.length, d.state.length); k++) {
        if (host[k] !== d.state[k]) {
          diffs.push({ slot: k, device: bitsToF32(d.state[k]!), host: bitsToF32(host[k]!) });
        }
      }
      res.stateMismatch[d.deck] = diffs;
    }
    if (d.arena && count === st.ledCount && first === 0) {
      const host = r.arena();
      let n = 0;
      let firstOff = -1;
      for (let k = 0; k < Math.min(host.length, d.arena.length); k++) {
        if (host[k] !== d.arena[k]) {
          n++;
          if (firstOff < 0) firstOff = k;
        }
      }
      res.arenaMismatch[d.deck] = n > 0 ? { bytes: n, firstOffset: firstOff } : null;
    }
  }
  // Blend + output stage, LED by LED, like ffi.rs fx_shade_decks + cc_apply.
  const a = res.deckRaw[0];
  const bRaw = res.deckRaw[1];
  const lut = after.lut ?? null;
  for (let i = 0; i < count; i++) {
    const hasEntry = after.decks.some((d) => d.ledContext && ((d.ledContext[i * LED_CTX_BYTES + 43] ?? 0) & 1) !== 0);
    let c: number[] = [0, 0, 0];
    if (hasEntry) {
      const ca = shading.a && a ? Array.from(a.subarray(i * 3, i * 3 + 3)) : null;
      const cb = shading.b && bRaw ? Array.from(bRaw.subarray(i * 3, i * 3 + 3)) : null;
      if (ca && cb) c = Array.from(vm.fx_blend_rgb8(Uint8Array.from(ca), Uint8Array.from(cb), st.crossfade, st.crossfadeMode));
      else c = ca ?? cb ?? [0, 0, 0];
    }
    res.raw.set(c, i * 3);
    const e = hasEntry ? outputStage(c, lut, st.brightness) : [0, 0, 0];
    res.expected.set(e, i * 3);
    if (after.output) {
      const dev = Array.from(after.output.subarray(i * 3, i * 3 + 3));
      const delta = Math.max(...dev.map((v, k) => Math.abs(v - (e[k] ?? 0))));
      if (delta > 0) res.mismatches.push({ led: first + i, device: dev, expected: e, raw: c });
      res.maxDelta = Math.max(res.maxDelta, delta);
    }
  }
  return res;
}

function bitsToF32(bits: number): number {
  const b = new Uint32Array([bits]);
  return new Float32Array(b.buffer)[0]!;
}

// -- the preview's inputs -------------------------------------------------------------

/**
 * The per-LED shade() inputs the EDITOR PREVIEW uses for a map (FxPreview /
 * wasm shade_all): LEDs in map-list order (`idx` = list position), positions as
 * the map's f32 xyz, topology from {@link deriveLedTopology}, uv over the list's
 * own XY bounds, and the fixture unposed (led.room = led.pos).
 */
export function previewLedInputs(bundle: MappingBundle): { ids: number[]; inputs: LedInputs[] } {
  const leds = bundle.map?.leds ?? [];
  const topo = deriveLedTopology(bundle.map, bundle.topology ?? undefined);
  const mn = [Infinity, Infinity];
  const mx = [-Infinity, -Infinity];
  const f = Math.fround;
  const pos = leds.map((l) => [f(l.xyz[0] ?? 0), f(l.xyz[1] ?? 0), f(l.xyz[2] ?? 0)] as [number, number, number]);
  for (const p of pos)
    for (let k = 0; k < 2; k++) {
      mn[k] = Math.min(mn[k]!, p[k]!);
      mx[k] = Math.max(mx[k]!, p[k]!);
    }
  const inv = [0, 1].map((k) => (mx[k]! - mn[k]! > 1e-6 ? f(1 / f(mx[k]! - mn[k]!)) : 0));
  const uvOf = (p: number[], k: number): number => Math.min(1, Math.max(0, f(f(p[k]! - mn[k]!) * inv[k]!)));
  return {
    ids: leds.map((l) => l.id),
    inputs: pos.map((p, i) => ({
      pos: p,
      s: topo.s[i] ?? 0,
      dist: topo.dist[i] ?? 0,
      uv: [uvOf(p, 0), uvOf(p, 1)] as [number, number],
      room: [0, 0, 0] as [number, number, number],
      seg: topo.seg[i] ?? -1,
      branch: (topo.branch[i] ?? 0) !== 0,
      hasEntry: true,
      measured: true,
    })),
  };
}

export interface InputDifference {
  led: number;
  /** Which shade() inputs differ between the device and the preview. */
  fields: string[];
  /** Largest position difference (m). */
  posDelta: number;
  device: LedInputs;
  preview: LedInputs | null;
  /** The preview's LED at this index is a different LED id (sparse map order). */
  previewId?: number;
}

/** Compare the device's per-LED inputs with the preview's (same LED index). */
export function diffLedInputs(device: LedInputs[], first: number, preview: { ids: number[]; inputs: LedInputs[] }, usesUv: boolean): InputDifference[] {
  const out: InputDifference[] = [];
  device.forEach((d, j) => {
    const i = first + j;
    const p = preview.inputs[i] ?? null;
    const fields: string[] = [];
    let posDelta = 0;
    if (!p) {
      if (d.hasEntry) fields.push("missing_in_preview");
    } else {
      posDelta = Math.max(...[0, 1, 2].map((k) => Math.abs(d.pos[k]! - p.pos[k]!)));
      if (posDelta > 0) fields.push("pos");
      if (d.seg !== p.seg) fields.push("seg");
      if (Math.fround(d.s) !== Math.fround(p.s)) fields.push("s");
      if (Math.fround(d.dist) !== Math.fround(p.dist)) fields.push("dist");
      if (d.branch !== p.branch) fields.push("branch");
      if (usesUv && (d.uv[0] !== p.uv[0] || d.uv[1] !== p.uv[1])) fields.push("uv");
      if (!d.hasEntry) fields.push("no_device_map_entry");
    }
    const pid = preview.ids[i];
    if (pid !== undefined && pid !== i) fields.push("led_order");
    if (fields.length > 0)
      out.push({ led: i, fields, posDelta, device: d, preview: p, ...(pid !== undefined && pid !== i ? { previewId: pid } : {}) });
  });
  return out;
}

// -- the whole procedure ----------------------------------------------------------------

export interface LocalsDiff {
  led: number;
  deck: number;
  /** device = the device's interpreted re-run; host = the replay's identical re-run. */
  deviceRgb: number[];
  deviceRgbJit: number[] | null;
  hostRgb: number[];
  /** Locals that differ, by slot (f32). */
  differing: { slot: number; device: number; host: number; name?: string }[];
  /** The preview-input re-run's locals that differ from the device-input run. */
  inputDriven?: { slot: number; deviceInputs: number; previewInputs: number; name?: string }[];
  deviceInstructions: number;
  hostInstructions: number;
}

export interface CompareReport {
  verdict: "match" | "engine" | "inputs" | "output_stage" | "mixed";
  /** Short human/agent-readable findings, most important first. */
  findings: string[];
  frame: number;
  time: number;
  dt: number;
  ledsCompared: number;
  /** Device output != host replay with the device's own inputs. */
  engine: { mismatched: number; firstDivergent: number | null; maxDelta: number; leds: LedMismatch[] };
  /** Post-frame state slots / buffer bytes that diverged. */
  state: Record<number, { slot: number; device: number; host: number; name?: string }[]>;
  arena: Record<number, { bytes: number; firstOffset: number } | null>;
  /** The preview's inputs differ from the device's (and change the colour). */
  inputs: { differing: number; colourChanging: number; leds: (InputDifference & { previewRgb?: number[]; deviceRgb?: number[] })[] } | null;
  /** The strip shows the effect colour through brightness / LUT / wire order. */
  outputStage: { brightness: number; lut: boolean; colorOrder: string[]; ledsChanged: number };
  locals: LocalsDiff[];
  decks: FxDeckInfo[];
  jit: boolean;
  notes: string[];
  /** LEDs [first, first + ledsCompared): the device's strip colours and the
   * replay's expected ones (RGB triples by LED index), for a diff view. */
  first: number;
  deviceOutput: Uint8Array | null;
  expected: Uint8Array;
}

const ORDER_NAMES = ["R", "G", "B"];

/**
 * Name a VM slot from the compiler's symbol table: `phase`, `c.y` / `acc[4]`
 * for a component of a wider variable, `shade:h` for a local. Undefined when
 * the table doesn't cover it (e.g. a compiler temporary).
 */
export function slotName(symbols: FxSymbol[] | undefined, kind: "state" | "local", slot: number): string | undefined {
  if (!symbols) return undefined;
  const s = symbols.find(
    (x) =>
      (kind === "state" ? x.kind === "state" : x.kind === "local" || x.kind === "param") &&
      slot >= x.slot &&
      slot < x.slot + x.width,
  );
  if (!s) return undefined;
  const k = slot - s.slot;
  const comp = s.width === 1 ? "" : s.width <= 4 ? `.${"xyzw"[k]}` : `[${k}]`;
  return `${s.func ? `${s.func}:` : ""}${s.name}${comp}`;
}

/** Attach slot names to a report's state / locals diffs (in place). */
export function nameSlots(r: CompareReport, symbols: FxSymbol[] | undefined): CompareReport {
  if (!symbols) return r;
  for (const v of Object.values(r.state)) for (const d of v) d.name = slotName(symbols, "state", d.slot) ?? "";
  for (const l of r.locals) {
    for (const d of l.differing) d.name = slotName(symbols, "local", d.slot) ?? "";
    for (const d of l.inputDriven ?? []) d.name = slotName(symbols, "local", d.slot) ?? "";
  }
  return r;
}

/**
 * Pause (if needed), snapshot, step ONE frame, snapshot again, replay it on the
 * host and explain every difference: see the module doc. `bundle` is the map +
 * topology the preview runs on (the agent's / editor's copy) — without it the
 * input comparison is skipped. Leaves the engine paused unless `resume`.
 */
export async function compareWithPreview(
  dbg: FxDebugger,
  vm: ReplayVm,
  opts: {
    bundle?: MappingBundle | null;
    first?: number;
    count?: number;
    dt?: number;
    holdMs?: number;
    /** Divergent LEDs to pull device + host VM locals for (default 3). */
    debugLeds?: number;
    resume?: boolean;
    /** The compiler's symbol table for the running effect (names the slots). */
    symbols?: FxSymbol[];
  } = {},
): Promise<CompareReport> {
  let st = await dbg.status(opts.holdMs);
  if (st.decks.every((d) => !d.renders)) throw new Error("no effect is rendering on the device");
  if (!st.paused) st = await dbg.pause(opts.holdMs);
  const range = { first: opts.first ?? 0, count: opts.count ?? st.ledCount };
  const before = await dbg.snapshot({ ...range, deckSections: ["program", "state", "arena"], frameSections: [] });
  await dbg.step({ frames: 1, ...(opts.dt !== undefined ? { dt: opts.dt } : {}), ...(opts.holdMs ? { holdMs: opts.holdMs } : {}) });
  const after = await dbg.snapshot({
    ...range,
    deckSections: ["uniforms", "state", "arena", "graph", "ledContext"],
    frameSections: ["output", "lut"],
  });
  for (const d of after.decks) {
    const b = before.decks.find((x) => x.deck === d.deck);
    if (b?.program) d.program = b.program;
  }
  const rep = replayFrame(vm, before, after);
  try {
    return nameSlots(await explain(dbg, vm, before, after, rep, opts), opts.symbols);
  } finally {
    disposeReplay(rep);
    if (opts.resume) await dbg.resume();
  }
}

async function explain(
  dbg: FxDebugger,
  vm: ReplayVm,
  before: FxSnapshot,
  after: FxSnapshot,
  rep: ReplayResult,
  opts: { bundle?: MappingBundle | null; debugLeds?: number; symbols?: FxSymbol[] },
): Promise<CompareReport> {
  const nm = (kind: "state" | "local", slot: number): string => {
    const n = slotName(opts.symbols, kind, slot);
    return n ? `${n} (slot ${slot})` : `slot ${slot}`;
  };
  const st = after.state;
  const findings: string[] = [];
  const notes = [...rep.notes];
  const jit = st.decks.some((d) => d.jitBlocks > 0);

  // 1) Engine: the device vs the host VM on the device's own inputs.
  const engine = {
    mismatched: rep.mismatches.length,
    firstDivergent: rep.mismatches[0]?.led ?? null,
    maxDelta: rep.maxDelta,
    leds: rep.mismatches.slice(0, 32),
  };
  const stateBad = Object.entries(rep.stateMismatch).filter(([, v]) => v.length > 0);
  const arenaBad = Object.entries(rep.arenaMismatch).filter(([, v]) => v !== null);
  if (engine.mismatched > 0) {
    findings.push(
      `ENGINE: ${engine.mismatched}/${rep.count} LEDs differ between the device and a host replay of the SAME ` +
        `program, state and inputs (first LED ${engine.firstDivergent}, max channel delta ${engine.maxDelta}) — ` +
        `a VM/JIT/firmware divergence, not an effect-source bug.`,
    );
  }
  for (const [d, v] of stateBad) {
    findings.push(`ENGINE: deck ${d} update() left ${v.length} state slot(s) different (first ${nm("state", v[0]!.slot)}: device ${v[0]!.device} vs host ${v[0]!.host}).`);
  }
  for (const [d, v] of arenaBad) {
    findings.push(`ENGINE: deck ${d} buffers differ after the frame (${v!.bytes} bytes, first at offset ${v!.firstOffset}).`);
  }

  // 2) Locals for the first divergent LEDs: the device's interpreted re-run vs
  // the host's identical re-run (zeroed scratch; both sides restore the LED's
  // per-LED buffer elements around every re-run, so neither perturbs the state).
  const locals: LocalsDiff[] = [];
  const want = opts.debugLeds ?? 3;
  for (const m of rep.mismatches.slice(0, want)) {
    for (const d of after.decks) {
      const r = rep.vms[d.deck];
      if (!d.info.renders || !d.ledContext || !r) continue;
      try {
        const dev = await dbg.debugLed(m.led, d.deck);
        const rec = d.ledContext.subarray((m.led - rep.first) * LED_CTX_BYTES, (m.led - rep.first + 1) * LED_CTX_BYTES);
        const h = r.shade_debug(rec, m.led);
        const hl = r.locals();
        const differing: LocalsDiff["differing"] = [];
        for (let k = 0; k < Math.min(hl.length, dev.locals.length); k++) {
          if (!sameF32(hl[k]!, dev.locals[k]!)) differing.push({ slot: k, device: dev.locals[k]!, host: hl[k]! });
        }
        locals.push({
          led: m.led,
          deck: d.deck,
          deviceRgb: dev.rgb,
          deviceRgbJit: dev.rgbJit,
          hostRgb: Array.from(h.subarray(0, 3)),
          differing,
          deviceInstructions: dev.instructions,
          hostInstructions: new DataView(h.buffer, h.byteOffset).getUint32(5, true),
        });
        if (dev.rgbJit && dev.rgbJit.some((v, k) => v !== dev.rgb[k])) {
          findings.push(`JIT: LED ${m.led} deck ${d.deck}: the device's JIT path gives ${fmt(dev.rgbJit)} but its interpreter ${fmt(dev.rgb)} — a JIT miscompile.`);
        }
        if (differing.length > 0) {
          findings.push(
            `ENGINE: LED ${m.led} deck ${d.deck}: ${differing.length} VM local(s) differ between the device's interpreter and the host's ` +
              `(first ${nm("local", differing[0]!.slot)}: device ${differing[0]!.device} vs host ${differing[0]!.host}).`,
          );
        }
      } catch (e) {
        notes.push(`locals for LED ${m.led} deck ${d.deck}: ${(e as Error).message}`);
      }
    }
  }

  // 3) Inputs: the preview's per-LED inputs vs the device's, each colour
  // re-shaded on the post-frame host VM both ways (and, for the first few, which
  // VM locals the input difference moves).
  let inputs: CompareReport["inputs"] = null;
  if (opts.bundle?.map) {
    const pv = previewLedInputs(opts.bundle);
    const d0 = after.decks.find((d) => d.info.renders && d.ledContext);
    const r = d0 ? rep.vms[d0.deck] : undefined;
    if (d0?.ledContext) {
      const usesUv = (d0.info.flags & 0x04) !== 0;
      const dev: LedInputs[] = [];
      for (let i = 0; i < rep.count; i++) dev.push(decodeLedRecord(d0.ledContext.subarray(i * LED_CTX_BYTES, (i + 1) * LED_CTX_BYTES)));
      const diffs = diffLedInputs(dev, rep.first, pv, usesUv);
      let changing = 0;
      let probed = 0;
      let probeFinding: string | null = null;
      const leds: (InputDifference & { previewRgb?: number[]; deviceRgb?: number[] })[] = [];
      for (const df of diffs) {
        const e: InputDifference & { previewRgb?: number[]; deviceRgb?: number[] } = { ...df };
        if (r && df.preview) {
          const prec = encodeLedRecord(df.preview);
          const drec = d0.ledContext.subarray((df.led - rep.first) * LED_CTX_BYTES, (df.led - rep.first + 1) * LED_CTX_BYTES);
          const pc = Array.from(r.shade_isolated(prec, df.led).subarray(0, 3));
          const dc = Array.from(r.shade_isolated(drec, df.led).subarray(0, 3));
          e.previewRgb = pc;
          e.deviceRgb = dc;
          const changes = pc.some((v, k) => v !== dc[k]);
          if (changes) changing++;
          if (changes && probed < want) {
            probed++;
            r.shade_debug(prec, df.led);
            const pl = r.locals();
            r.shade_debug(drec, df.led);
            const dl = r.locals();
            const inputDriven: NonNullable<LocalsDiff["inputDriven"]> = [];
            for (let k = 0; k < Math.min(pl.length, dl.length); k++) {
              if (!sameF32(pl[k]!, dl[k]!)) inputDriven.push({ slot: k, deviceInputs: dl[k]!, previewInputs: pl[k]! });
            }
            if (probed === 1 && inputDriven.length > 0) {
              const list = inputDriven
                .slice(0, 4)
                .map((x) => `${nm("local", x.slot)} ${x.deviceInputs} on the device vs ${x.previewInputs} in the preview`)
                .join("; ");
              probeFinding = `INPUTS: LED ${df.led} (${df.fields.join(", ")}): the input difference moves ${inputDriven.length} local(s): ${list}.`;
            }
            locals.push({
              led: df.led,
              deck: d0.deck,
              deviceRgb: dc,
              deviceRgbJit: null,
              hostRgb: pc,
              differing: [],
              inputDriven,
              deviceInstructions: 0,
              hostInstructions: 0,
            });
          }
        }
        leds.push(e);
      }
      inputs = { differing: diffs.length, colourChanging: changing, leds: leds.slice(0, 32) };
      if (diffs.length > 0) {
        const kinds = new Map<string, number>();
        for (const d of diffs) for (const f of d.fields) kinds.set(f, (kinds.get(f) ?? 0) + 1);
        const summary = [...kinds.entries()].map(([k, n]) => `${k}×${n}`).join(", ");
        const maxPos = Math.max(0, ...diffs.map((d) => d.posDelta));
        findings.push(
          `INPUTS: ${diffs.length}/${rep.count} LEDs get different shade() inputs on the device than in the preview ` +
            `(${summary}${maxPos > 0 ? `; max position delta ${maxPos.toExponential(2)} m` : ""}); ` +
            `${changing} of them change colour because of it.`,
        );
        if (kinds.has("led_order"))
          findings.push("INPUTS: the preview indexes LEDs by map-list position but the device by LED id (the map is sparse / unordered): led.idx and buffers line up differently.");
        if (kinds.has("pos") && maxPos < 1e-3)
          findings.push("INPUTS: position deltas are tiny — the device stores positions as 24-bit floats (F24); effects that hash/floor/step on positions can flip on them.");
        if (kinds.has("no_device_map_entry"))
          findings.push("INPUTS: some LEDs have no map entry on the device (they render black) but do in the preview — the device's map is shorter or different.");
        if (probeFinding) findings.push(probeFinding);
      }
    }
  } else {
    notes.push("no map bundle given: the preview-input comparison was skipped");
  }

  // 4) Output stage: brightness / LUT / wire colour order.
  let ledsChanged = 0;
  for (let i = 0; i < rep.count; i++) {
    const raw = rep.raw.subarray(i * 3, i * 3 + 3);
    const e = rep.expected.subarray(i * 3, i * 3 + 3);
    if (raw.some((v, k) => v !== e[k])) ledsChanged++;
  }
  const colorOrder = st.colorOrder.map((p) => (p.length === 3 ? p.map((k) => ORDER_NAMES[k] ?? "?").join("") : "?"));
  const outputStageR = { brightness: st.brightness, lut: st.lut, colorOrder, ledsChanged };
  if (ledsChanged > 0) {
    findings.push(
      `OUTPUT STAGE: ${ledsChanged}/${rep.count} LEDs leave the device brighter/darker or re-curved than the effect computed ` +
        `(brightness ${st.brightness}/255${st.lut ? ", colour-correction LUT on" : ""}) — the preview shows the raw effect colour.`,
    );
  }
  findings.push(
    `OUTPUT STAGE: wire colour order is ${colorOrder[0]} on channel 0` +
      (st.channelLeds[1] > 0 ? ` (${st.channelLeds[0]} LEDs) and ${colorOrder[1]} on channel 1 (${st.channelLeds[1]} LEDs)` : "") +
      " — if hues are swapped on the fixture (red shows green, ...), the strip's real order differs from this.",
  );

  const hasEngine = engine.mismatched > 0 || stateBad.length > 0 || arenaBad.length > 0;
  const hasInputs = (inputs?.colourChanging ?? 0) > 0;
  const hasOut = ledsChanged > 0;
  const kinds = [hasEngine, hasInputs, hasOut].filter(Boolean).length;
  const verdict: CompareReport["verdict"] =
    kinds === 0 ? "match" : kinds > 1 ? "mixed" : hasEngine ? "engine" : hasInputs ? "inputs" : "output_stage";
  if (verdict === "match") {
    findings.unshift(
      "MATCH: the device renders exactly what the host VM computes from the device's own state and inputs" +
        (opts.bundle ? ", and the preview's inputs give the same colours" : "") +
        ". A visible mismatch must come from the physical side (wire colour order, LED type, power/brightness limits, wiring/LED count) or from the preview's time/uniforms/state, which this frame used as listed.",
    );
  }
  const busy = before.state.frame !== st.frame - 1 ? [`frames between the snapshots: ${st.frame - before.state.frame}`] : [];
  return {
    verdict,
    findings,
    frame: st.frame,
    time: st.time,
    dt: st.dt,
    ledsCompared: rep.count,
    engine,
    state: rep.stateMismatch,
    arena: rep.arenaMismatch,
    inputs,
    outputStage: outputStageR,
    locals,
    decks: st.decks,
    jit,
    notes: [...notes, ...busy],
    first: rep.first,
    deviceOutput: after.output ?? null,
    expected: rep.expected,
  };
}

function sameF32(a: number, b: number): boolean {
  return Object.is(Math.fround(a), Math.fround(b)) || (Number.isNaN(a) && Number.isNaN(b));
}

function fmt(c: number[]): string {
  return `(${c.join(", ")})`;
}
