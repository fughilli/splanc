/**
 * The FX editor's Watch (D-541 PR 11; host preview only, owner answer D-550):
 * watched expressions, their values in the watch VM, a per-frame history for
 * the time plot, and the frame log that pause / step / scrub replay.
 *
 * The compiler's host watch build (`fx_compile_watch`) copies each watched
 * sub-expression's value into hidden storage: `state` words for one in
 * update() (one value per frame), hidden per-LED buffers for one in shade() or
 * a helper (one value per LED). The watch build runs on its OWN VM (a second
 * FxPreview fed the live preview's inputs), so an effect with feedback
 * buffers or state is never perturbed by watching it; the watch VM is synced
 * from the live preview's state + arena when it (re)starts, which the watch
 * build allows because its hidden storage comes after the program's own.
 *
 * Everything here is DOM-free (unit-tested in tests/fxWatch.test.ts); the pane
 * is effects/editor/watch-panel.ts.
 */

import type { FxCompiled } from "./preview";

/** What a watched value depends on (fx_compiler memo.rs `Variance`). */
export type WatchClass = "const" | "led" | "frame" | "dynamic";

/** One watch of a watch build (fx_compiler `watches_json`). */
export interface WatchInfo {
  error: string | null;
  /** Source type: float, vec2..vec4, int, fixed, fixed8, fixed16, bool, mat3, mat4, color. */
  ty: string;
  width: number;
  /** How a raw word reads: f32, i32, bool, qN (fixed-point, N fraction bits), u8. */
  decode: string;
  class: WatchClass | null;
  func: string;
  store: "none" | "state" | "led";
  state_slot: number;
  buffers: number[];
  line: number;
  col: number;
}

/** A watch build: the instrumented program and one entry per watched range. */
export interface WatchCompile {
  result: FxCompiled;
  watches: WatchInfo[];
}

/** A watched expression in the editor: its text and where it is in the source. */
export interface WatchExpr {
  id: number;
  text: string;
  start: number;
  end: number;
}

/** The message the compiler gives a selection that is not one expression. */
export const NOT_AN_EXPRESSION = "selection is not an expression";

/** Class labels for the pane (what the value varies with). */
export const CLASS_LABEL: Record<WatchClass, string> = {
  const: "Const",
  frame: "Frame",
  led: "Led",
  dynamic: "Dynamic",
};

export const CLASS_HINT: Record<WatchClass, string> = {
  const: "the same every frame and on every LED",
  frame: "one value per frame (time, uniforms, state)",
  led: "one value per LED, fixed by the map",
  dynamic: "varies per LED and per frame",
};

/**
 * Where `w` is in `src` after an edit: unchanged when its text is still at
 * the same offsets, else the occurrence of its text nearest the old start,
 * else null (the expression is gone).
 */
export function relocate(src: string, w: Pick<WatchExpr, "text" | "start" | "end">): { start: number; end: number } | null {
  if (w.text.length === 0) return null;
  if (src.slice(w.start, w.end) === w.text) return { start: w.start, end: w.end };
  let best = -1;
  for (let i = src.indexOf(w.text); i >= 0; i = src.indexOf(w.text, i + 1)) {
    if (best < 0 || Math.abs(i - w.start) < Math.abs(best - w.start)) best = i;
  }
  return best < 0 ? null : { start: best, end: best + w.text.length };
}

/** Flat (start, end) pairs for `fx_compile_watch`. */
export function watchRanges(ws: readonly Pick<WatchExpr, "start" | "end">[]): Uint32Array {
  const r = new Uint32Array(ws.length * 2);
  ws.forEach((w, i) => {
    r[2 * i] = w.start;
    r[2 * i + 1] = w.end;
  });
  return r;
}

const F32 = new Float32Array(1);
const U32 = new Uint32Array(F32.buffer);

/** One raw 32-bit VM word as a number, per the watch's `decode`. */
export function decodeWord(bits: number, decode: string): number {
  const u = bits >>> 0;
  switch (decode) {
    case "f32":
      U32[0] = u;
      return F32[0] ?? 0;
    case "i32":
    case "u8":
      return u | 0;
    case "bool": {
      // true is 1.0f (or a nonzero int); +0 / -0 / 0 are false.
      return (u & 0x7fffffff) !== 0 ? 1 : 0;
    }
    default: {
      const m = /^q(\d+)$/.exec(decode);
      return m ? (u | 0) / 2 ** Number(m[1]) : 0;
    }
  }
}

/** What the VM exposes for reading a watch build's values. */
export interface WatchReadout {
  /** The state words (raw). */
  state: Uint32Array;
  /** Buffer `id`'s bytes for the current LED count. */
  buffer: (id: number) => Uint8Array;
}

/**
 * The values of watch `w` this frame: `frame` for a per-frame watch (width
 * numbers), `leds` for a per-LED one (ledCount * width numbers, LED-major).
 */
export function readWatch(
  w: WatchInfo,
  r: WatchReadout,
  ledCount: number,
): { frame: number[] | null; leds: Float64Array | null } {
  if (w.error !== null || w.store === "none") return { frame: null, leds: null };
  if (w.store === "state") {
    const out: number[] = [];
    for (let c = 0; c < w.width; c++) out.push(decodeWord(r.state[w.state_slot + c] ?? 0, w.decode));
    return { frame: out, leds: null };
  }
  const leds = new Float64Array(ledCount * w.width);
  let comp = 0;
  for (const id of w.buffers) {
    const bytes = r.buffer(id);
    const n = Math.min(4, w.width - comp);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < ledCount; i++) {
      for (let k = 0; k < n; k++) {
        const o = (i * n + k) * 4;
        const bits = o + 4 <= bytes.byteLength ? dv.getUint32(o, true) : 0;
        leds[i * w.width + comp + k] = decodeWord(bits, w.decode);
      }
    }
    comp += n;
  }
  return { frame: null, leds };
}

/** Per-LED values as one number per component: the probe LED's, plus the
 * min / max over every LED (for the plot band and the "range" line). */
export function ledSummary(
  leds: Float64Array,
  width: number,
  probe: number,
): { value: number[]; min: number[]; max: number[] } {
  const n = width > 0 ? Math.floor(leds.length / width) : 0;
  const p = Math.max(0, Math.min(n - 1, probe));
  const value: number[] = [];
  const min: number[] = [];
  const max: number[] = [];
  for (let c = 0; c < width; c++) {
    value.push(n > 0 ? (leds[p * width + c] ?? 0) : 0);
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < n; i++) {
      const v = leds[i * width + c] ?? 0;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    min.push(n > 0 ? lo : 0);
    max.push(n > 0 ? hi : 0);
  }
  return { value, min, max };
}

/** A number for the pane: integers as such, others to 4 significant digits. */
export function fmtNum(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  if (Number.isInteger(v) && Math.abs(v) < 1e9) return String(v);
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-3 || a >= 1e6)) return v.toExponential(3);
  return String(Number(v.toPrecision(4)));
}

/** A watch value as text for its type. */
export function formatValue(ty: string, vals: readonly number[]): string {
  if (vals.length === 0) return "–";
  if (ty === "bool") return vals[0] ? "true" : "false";
  if (vals.length === 1) return fmtNum(vals[0] ?? 0);
  if (ty === "mat3" || ty === "mat4") {
    const n = ty === "mat3" ? 3 : 4;
    const cols: string[] = [];
    for (let c = 0; c < n; c++) cols.push(vals.slice(c * n, c * n + n).map(fmtNum).join(", "));
    return cols.map((c) => `(${c})`).join(" ");
  }
  return `(${vals.map(fmtNum).join(", ")})`;
}

/** Component names for a plot legend. */
export function componentNames(ty: string, width: number): string[] {
  if (width === 1) return [""];
  if (ty === "color") return ["r", "g", "b"];
  if (ty === "mat3" || ty === "mat4") {
    const n = ty === "mat3" ? 3 : 4;
    return Array.from({ length: width }, (_, i) => `[${Math.floor(i / n)}][${i % n}]`);
  }
  return ["x", "y", "z", "w"].slice(0, width);
}

/** One frame of watch history: per watch, its per-component value (the probe
 * LED's for a per-LED watch) and, per-LED only, the min / max band. */
export interface WatchSample {
  frame: number;
  time: number;
  values: (number[] | null)[];
  min: (number[] | null)[];
  max: (number[] | null)[];
}

/** A fixed-capacity ring of the last frames' samples (the time plot's data). */
export class WatchHistory {
  private readonly buf: (WatchSample | undefined)[];
  private head = 0;
  private n = 0;

  constructor(readonly capacity: number) {
    this.buf = new Array<WatchSample | undefined>(capacity);
  }

  get length(): number {
    return this.n;
  }

  push(s: WatchSample): void {
    this.buf[this.head] = s;
    this.head = (this.head + 1) % this.capacity;
    this.n = Math.min(this.n + 1, this.capacity);
  }

  /** The i-th oldest sample still held (0 = oldest). */
  at(i: number): WatchSample | undefined {
    if (i < 0 || i >= this.n) return undefined;
    return this.buf[(this.head - this.n + i + this.capacity * 2) % this.capacity];
  }

  /** The newest sample. */
  last(): WatchSample | undefined {
    return this.at(this.n - 1);
  }

  /** The sample of frame `frame`, if held. */
  find(frame: number): WatchSample | undefined {
    for (let i = this.n - 1; i >= 0; i--) {
      const s = this.at(i);
      if (s?.frame === frame) return s;
      if (s !== undefined && s.frame < frame) return undefined;
    }
    return undefined;
  }

  clear(): void {
    this.buf.fill(undefined);
    this.head = 0;
    this.n = 0;
  }
}

/** The y range of a set of series over the history (padded; never empty). */
export function plotRange(h: WatchHistory, watch: number, opts: { band?: boolean } = {}): { lo: number; hi: number } {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < h.length; i++) {
    const s = h.at(i);
    const vs = [s?.values[watch], opts.band ? s?.min[watch] : null, opts.band ? s?.max[watch] : null];
    for (const v of vs) {
      if (!v) continue;
      for (const x of v) {
        if (!Number.isFinite(x)) continue;
        if (x < lo) lo = x;
        if (x > hi) hi = x;
      }
    }
  }
  if (lo === Infinity) return { lo: 0, hi: 1 };
  if (hi - lo < 1e-9) {
    const d = Math.max(Math.abs(lo) * 0.1, 0.5);
    return { lo: lo - d, hi: hi + d };
  }
  const pad = (hi - lo) * 0.08;
  return { lo: lo - pad, hi: hi + pad };
}

// -- the watch VM + frame log (pause / step / scrub) -----------------------------

/** The VM surface the session drives (an FxPreview on the watch build). */
export interface WatchVm {
  setUniform(slot: number, vals: number[]): void;
  tick(time: number, dt: number, frame: number, ledCount: number): void;
  shadeAll(positions: Float32Array): Uint8Array;
  state(): Uint32Array;
  setState(words: Uint32Array): void;
  arena(): Uint8Array;
  setArena(bytes: Uint8Array): void;
  buffer(id: number, ledCount: number): Uint8Array;
}

/** A frame's inputs, as the live preview got them. */
interface FrameInput {
  frame: number;
  time: number;
  dt: number;
  /** Uniform changes made since the previous frame (applied before it). */
  uniforms: [number, number[]][];
}

/** The watch VM's state at the START of a logged frame. */
interface Keyframe {
  /** Index into the log. */
  at: number;
  state: Uint32Array;
  arena: Uint8Array;
  /** Every uniform's value at that point. */
  uniforms: Map<number, number[]>;
}

export interface WatchFrame {
  frame: number;
  time: number;
  colors: Uint8Array;
  /** Per watch (index-aligned with the build's watches). */
  values: { frame: number[] | null; leds: Float64Array | null }[];
}

export interface WatchSessionOpts {
  /** Frames the log (and so the scrub range) holds. */
  maxFrames?: number;
  /** A keyframe every this many frames (replay cost of a scrub). */
  keyEvery?: number;
}

/**
 * Runs the watch build in lockstep with the live preview and keeps the last
 * frames' inputs (plus periodic keyframes of the watch VM) so a paused preview
 * can be stepped back and forth: `seek(frame)` restores the keyframe before it
 * and replays the logged inputs. The live preview is never touched.
 */
export class WatchSession {
  private readonly log: FrameInput[] = [];
  private readonly keys: Keyframe[] = [];
  private readonly uniforms = new Map<number, number[]>();
  private pending: [number, number[]][] = [];
  private readonly maxFrames: number;
  private readonly keyEvery: number;
  /** Log index the VM's state is at the END of (-1: before any frame). */
  private pos = -1;
  private ledCount = 0;
  private positions: Float32Array = new Float32Array(0);

  constructor(
    private readonly vm: WatchVm,
    readonly watches: readonly WatchInfo[],
    opts: WatchSessionOpts = {},
  ) {
    this.maxFrames = Math.max(2, opts.maxFrames ?? 600);
    this.keyEvery = Math.max(1, opts.keyEvery ?? 30);
  }

  /** A uniform moved (applied to the VM before the next frame). */
  setUniform(slot: number, vals: readonly number[]): void {
    const v = [...vals];
    this.uniforms.set(slot, v);
    this.pending.push([slot, v]);
    this.vm.setUniform(slot, v);
  }

  /** Start from the live preview's current state + arena (and uniforms). */
  syncFrom(live: { state: Uint32Array; arena: Uint8Array }, uniforms: Iterable<[number, readonly number[]]>): void {
    const st = live.state.slice();
    // The watch slots stay zero until the program writes them.
    for (const w of this.watches) {
      if (w.store === "state" && w.error === null) st.fill(0, w.state_slot, w.state_slot + w.width);
    }
    this.vm.setState(st);
    // The live arena is a prefix of the watch arena (same buffers first);
    // update() grows it, keeping the bytes.
    this.vm.setArena(live.arena.slice());
    for (const [slot, vals] of uniforms) {
      this.uniforms.set(slot, [...vals]);
      this.vm.setUniform(slot, [...vals]);
    }
    this.pending = [];
    this.log.length = 0;
    this.keys.length = 0;
    this.pos = -1;
  }

  /** Frames held (the scrub range is `firstFrame()`..`lastFrame()`). */
  get length(): number {
    return this.log.length;
  }
  firstFrame(): number | null {
    return this.log[0]?.frame ?? null;
  }
  lastFrame(): number | null {
    return this.log[this.log.length - 1]?.frame ?? null;
  }
  /** The frame the VM is showing (null before the first). */
  currentFrame(): number | null {
    return this.log[this.pos]?.frame ?? null;
  }
  /** True when the VM is at the newest logged frame. */
  atHead(): boolean {
    return this.pos === this.log.length - 1;
  }

  /** The live preview ran a frame: run the same one here. */
  frame(time: number, dt: number, frame: number, ledCount: number, positions: Float32Array): WatchFrame {
    if (!this.atHead() && this.log.length > 0) this.seekIndex(this.log.length - 1);
    this.ledCount = ledCount;
    this.positions = positions;
    const input: FrameInput = { frame, time, dt, uniforms: this.pending };
    this.pending = [];
    if (this.log.length % this.keyEvery === 0 || this.keys.length === 0) {
      this.keys.push({ at: this.log.length, state: this.vm.state(), arena: this.vm.arena(), uniforms: cloneUniforms(this.uniforms) });
    }
    this.log.push(input);
    const out = this.run(input);
    this.pos = this.log.length - 1;
    this.trim();
    return out;
  }

  /** Show logged frame `frame` (nearest held). Null when nothing is logged. */
  seek(frame: number): WatchFrame | null {
    if (this.log.length === 0) return null;
    let i = this.log.findIndex((f) => f.frame >= frame);
    if (i < 0) i = this.log.length - 1;
    return this.seekIndex(i);
  }

  private seekIndex(i: number): WatchFrame {
    let k = this.keys.length - 1;
    while (k > 0 && (this.keys[k]?.at ?? 0) > i) k--;
    const key = this.keys[k];
    let from = 0;
    if (key) {
      this.vm.setState(key.state.slice());
      this.vm.setArena(key.arena.slice());
      for (const [slot, vals] of key.uniforms) this.vm.setUniform(slot, vals);
      from = key.at;
    }
    let out: WatchFrame | null = null;
    for (let j = from; j <= i; j++) {
      const f = this.log[j];
      if (f) out = this.run(f);
    }
    // The VM's uniforms are back to the latest values once it returns to the head.
    if (i === this.log.length - 1) for (const [slot, vals] of this.uniforms) this.vm.setUniform(slot, vals);
    this.pos = i;
    return out ?? { frame: 0, time: 0, colors: new Uint8Array(0), values: [] };
  }

  private run(f: FrameInput): WatchFrame {
    for (const [slot, vals] of f.uniforms) this.vm.setUniform(slot, vals);
    this.vm.tick(f.time, f.dt, f.frame, this.ledCount);
    const colors = this.vm.shadeAll(this.positions);
    const state = this.vm.state();
    const cache = new Map<number, Uint8Array>();
    const readout: WatchReadout = {
      state,
      buffer: (id) => {
        let b = cache.get(id);
        if (!b) {
          b = this.vm.buffer(id, this.ledCount);
          cache.set(id, b);
        }
        return b;
      },
    };
    return { frame: f.frame, time: f.time, colors, values: this.watches.map((w) => readWatch(w, readout, this.ledCount)) };
  }

  /** Drop frames older than the log holds, keeping a keyframe at the start. */
  private trim(): void {
    for (;;) {
      const next = this.keys[1];
      // Drop the oldest keyframe's frames while the rest still fill the log.
      if (!next || this.log.length - next.at < this.maxFrames) break;
      const drop = next.at;
      this.log.splice(0, drop);
      this.keys.shift();
      for (const key of this.keys) key.at -= drop;
      this.pos -= drop;
    }
  }
}

function cloneUniforms(m: Map<number, number[]>): Map<number, number[]> {
  return new Map([...m].map(([k, v]) => [k, [...v]]));
}
