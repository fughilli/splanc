/**
 * MIDI → uniform routing (FUG-9). The layer that turns a hardware control event
 * into live uniform updates, resolving three independent tables at event time:
 *
 *   physical control ──(semantic layer)──▶ semantic name
 *   semantic name    ──(binding layer)───▶ uniform name (per effect)
 *   uniform name     ──(manifest)────────▶ slot + declared range
 *
 * {@link resolveControlUpdates} is the pure, tested core — given an event and
 * the three tables it returns the uniform writes to apply. {@link MidiRouter} is
 * the thin stateful wrapper the editor uses: it subscribes to the shared
 * {@link midiManager} + {@link midiStore}, tracks the current effect + manifest,
 * and calls back with `(name, slot, value[])` so the editor can move the panel
 * slider AND push to preview + device — the SAME seam a manual drag uses.
 *
 * Scalars (slider float/int, toggle) take one knob each. Colour, vector and
 * matrix uniforms (D-541 PR 3) are driven ONE CHANNEL per binding
 * (`UniformBinding.channel`): a colour as RGB (`r` `g` `b` `a`) or HSV (`h`
 * `s` `v`, with optional `fixed` S/V, e.g. hue-only on one knob), a vector by
 * component (`x` `y` `z` `w`), a matrix by index (`"0"`..`"15"`). The router
 * keeps a per-uniform {@link UniformShadow} of the full vector (and the HSV
 * the user is steering, so hue survives a trip through black or grey),
 * converts HSV to RGB on the host, and always sends the WHOLE value. No
 * firmware change: the device just sees a SetUniforms for the slot.
 */

import type { FxUniform } from "../fx/preview";
import type { MidiControlEvent } from "./manager";
import { midiManager, controlKey } from "./manager";
import type { SemanticControl, UniformBinding } from "../store/midiStore";
import { midiStore, normName, scaleToRange } from "../store/midiStore";
import { clamp01, hsvToRgb, rgbToHsv, type Hsv } from "../color/hsv";

/** A resolved uniform write produced from a control event. */
export interface UniformUpdate {
  uniform: string;
  slot: number;
  value: number[];
}

/** The declared range of a uniform's slider (or [0,1] for toggles/others). */
function uniformRange(u: FxUniform): { min: number; max: number } {
  if (u.ui.kind === "slider") return { min: u.ui.min, max: u.ui.max };
  return { min: 0, max: 1 };
}

/** A single scalar the editor panel shows as one slider/toggle row. */
export function isScalarDrivable(u: FxUniform): boolean {
  return u.width === 1 && (u.ui.kind === "slider" || u.ui.kind === "toggle");
}

/** A colour uniform (vec3 RGB, or vec4 RGBA). */
export function isColorUniform(u: FxUniform): boolean {
  return u.ui.kind === "color" && (u.width === 3 || u.width === 4);
}

const VEC_NAMES = ["x", "y", "z", "w"];

/** A vec2..vec4 driven per component: a ranged-slider vector, or a `: vector`
 * (XY pad) / `: direction` (dial/sphere) uniform. */
export function isVectorUniform(u: FxUniform): boolean {
  const k = u.ui.kind;
  return u.width >= 2 && u.width <= 4 && (k === "slider" || k === "vector" || k === "direction");
}

/**
 * The channels a binding may name on `u`: [] for a scalar (no channel); for
 * a colour `h` `s` `v` `r` `g` `b` (+ `a` for vec4); for a ranged vector its
 * component names; for a matrix its indices `"0"`..`"n-1"`. (A vector also
 * accepts a numeric index, see {@link componentIndex}.)
 */
export function bindingChannels(u: FxUniform): string[] {
  if (isScalarDrivable(u)) return [];
  if (isColorUniform(u)) return ["h", "s", "v", "r", "g", "b", ...(u.width === 4 ? ["a"] : [])];
  if (isVectorUniform(u)) return VEC_NAMES.slice(0, u.width);
  if (u.ui.kind === "matrix") return Array.from({ length: u.width }, (_, i) => String(i));
  return [];
}

/** A uniform is MIDI-drivable if it is a scalar slider/toggle, or a colour,
 * ranged vector or matrix (driven per channel). */
export function isDrivable(u: FxUniform): boolean {
  return isScalarDrivable(u) || bindingChannels(u).length > 0;
}

/** Drivable by a binding with NO channel, which is what name-based auto-binding
 * creates: a scalar, or a colour (whose default channel is hue). */
export function isAutoBindable(u: FxUniform): boolean {
  return isScalarDrivable(u) || isColorUniform(u);
}

/** The colour space a channel implies (null for a non-colour channel). */
export function channelSpace(channel: string): "rgb" | "hsv" | null {
  if (channel === "h" || channel === "s" || channel === "v") return "hsv";
  if (channel === "r" || channel === "g" || channel === "b" || channel === "a") return "rgb";
  return null;
}

/** The effective channel of a binding on `u`: its own, or `h` for a colour
 * binding without one (one knob on a colour = hue). Null if `u` needs a
 * channel and the binding names none, or names one `u` doesn't have. */
export function effectiveChannel(u: FxUniform, b: UniformBinding): string | null {
  if (isScalarDrivable(u)) return b.channel === undefined ? "" : null;
  const ch = b.channel ?? (isColorUniform(u) ? (b.space === "rgb" ? null : "h") : null);
  if (ch === null) return null;
  if (bindingChannels(u).includes(ch)) return ch;
  // Vectors also accept a numeric component index.
  if (isVectorUniform(u) && /^\d+$/.test(ch) && Number(ch) < u.width) return ch;
  return null;
}

/** The vector index a (validated) non-HSV channel writes. */
function componentIndex(ch: string): number {
  const rgb = "rgba".indexOf(ch);
  if (ch.length === 1 && rgb >= 0) return rgb;
  const vec = VEC_NAMES.indexOf(ch);
  if (vec >= 0) return vec;
  return Number(ch);
}

/** The range a component sweeps: per-component for a ranged vector (slider
 * or XY pad), -1..1 for a direction, the declared range for a matrix, 0..1
 * for a colour. */
export function componentRange(u: FxUniform, i: number): { min: number; max: number } {
  if (u.ui.kind === "slider" || u.ui.kind === "vector") {
    return { min: u.mins?.[i] ?? u.ui.min, max: u.maxs?.[i] ?? u.ui.max };
  }
  if (u.ui.kind === "direction") return { min: -1, max: 1 };
  if (u.ui.kind === "matrix") return { min: u.ui.min, max: u.ui.max };
  return { min: 0, max: 1 };
}

const EPS = 1e-4;

/**
 * The router's per-uniform memory of each driven vector: the full value (so
 * one channel's knob leaves the others alone) and, for a colour, the HSV the
 * knobs are steering. `live` reads the value the screen currently holds (the
 * editor panel), so a manual drag between knob turns is respected; without
 * it the shadow starts from the manifest default.
 */
export class UniformShadow {
  private readonly vals = new Map<string, number[]>();
  private readonly hsvs = new Map<string, Hsv>();

  constructor(private readonly live?: (u: FxUniform) => readonly number[] | undefined) {}

  private key(u: FxUniform): string {
    return `${u.name}|${u.width}`;
  }

  /** The current full value of `u` (a copy, padded to its width). */
  value(u: FxUniform): number[] {
    const src = this.live?.(u) ?? this.vals.get(this.key(u)) ?? u.default;
    return Array.from({ length: u.width }, (_, i) => src[i] ?? 0);
  }

  set(u: FxUniform, v: number[]): void {
    this.vals.set(this.key(u), v.slice());
  }

  /** The HSV being steered for colour `u` whose RGB is now `rgb`: the stored
   * one while it still produces `rgb` (it keeps hue at S=0 or V=0), else
   * re-derived from `rgb` (something else moved the colour). */
  hsv(u: FxUniform, rgb: readonly number[]): Hsv {
    const prev = this.hsvs.get(this.key(u));
    if (prev) {
      const back = hsvToRgb(prev[0], prev[1], prev[2]);
      if (back.every((c, i) => Math.abs(c - clamp01(rgb[i] ?? 0)) < EPS)) return [...prev];
    }
    return rgbToHsv(rgb[0] ?? 0, rgb[1] ?? 0, rgb[2] ?? 0, prev ? { h: prev[0], s: prev[1] } : undefined);
  }

  setHsv(u: FxUniform, hsv: Hsv): void {
    this.hsvs.set(this.key(u), [...hsv]);
  }

  clear(): void {
    this.vals.clear();
    this.hsvs.clear();
  }
}

/**
 * Pure resolution: given a control event and the current tables, compute every
 * uniform write it triggers. A control with no semantic name, or a semantic with
 * no binding in this effect, or a binding whose uniform isn't in the manifest
 * (or names a channel the uniform lacks), yields nothing. Several bindings of
 * one knob on one uniform merge into one write of the whole value. `shadow`
 * carries vector state between events (a fresh one starts from defaults).
 */
export function resolveControlUpdates(
  event: MidiControlEvent,
  manifest: FxUniform[],
  semantics: SemanticControl[],
  bindings: UniformBinding[],
  shadow: UniformShadow = new UniformShadow(),
): UniformUpdate[] {
  const id = controlKey(event.control);
  const semantic = semantics.find((s) => s.id === id);
  if (!semantic) return [];
  const want = normName(semantic.name);

  const out: UniformUpdate[] = [];
  // Uniform name -> [uniform, value being built], so several bindings of one
  // knob on one uniform compose before the single write.
  const touched = new Map<string, [FxUniform, number[]]>();
  for (const b of bindings) {
    if (normName(b.semantic) !== want) continue;
    const u = manifest.find((m) => m.name === b.uniform);
    if (!u || !isDrivable(u)) continue;
    const ch = effectiveChannel(u, b);
    if (ch === null) continue;
    if (ch === "") {
      out.push({ uniform: u.name, slot: u.slot, value: [scalarValue(u, b, event.value)] });
      continue;
    }
    const cur = touched.get(u.name)?.[1] ?? shadow.value(u);
    if (channelSpace(ch) === "hsv") {
      const hsv = shadow.hsv(u, cur);
      const k = "hsv".indexOf(ch);
      hsv[k] = scaleToRange(event.value, 0, 1, b);
      if (b.fixed?.s !== undefined && ch !== "s") hsv[1] = clamp01(b.fixed.s);
      if (b.fixed?.v !== undefined && ch !== "v") hsv[2] = clamp01(b.fixed.v);
      const rgb = hsvToRgb(hsv[0], hsv[1], hsv[2]);
      cur[0] = rgb[0];
      cur[1] = rgb[1];
      cur[2] = rgb[2];
      shadow.setHsv(u, hsv);
    } else {
      const i = componentIndex(ch);
      const { min, max } = componentRange(u, i);
      let v = scaleToRange(event.value, min, max, b);
      if ((u.ui.kind === "slider" || u.ui.kind === "vector") && u.ui.step > 0) v = snap(v, min, max, u.ui.step);
      cur[i] = v;
      // A direction stays a unit vector (as the picker and keypoint blend keep
      // it): the knob sets its component, the others rescale around it.
      if (u.ui.kind === "direction") renormalise(cur, i, u.width);
    }
    shadow.set(u, cur);
    touched.set(u.name, [u, cur]);
  }
  for (const [u, v] of touched.values()) out.push({ uniform: u.name, slot: u.slot, value: v.slice() });
  return out;
}

function scalarValue(u: FxUniform, b: UniformBinding, value01: number): number {
  if (u.ui.kind === "toggle") return value01 >= 0.5 ? 1 : 0;
  const { min, max } = uniformRange(u);
  const v = scaleToRange(value01, min, max, b);
  // Snap to the slider's step grid so int/quantized uniforms land cleanly.
  return u.ui.kind === "slider" && u.ui.step > 0 ? snap(v, min, max, u.ui.step) : v;
}

/** Make `v[0..w)` unit length keeping component `keep` fixed (clamped to
 * [-1,1]) and scaling the others; if they are all zero, spread the rest
 * evenly over them. */
function renormalise(v: number[], keep: number, w: number): void {
  const k = Math.max(-1, Math.min(1, v[keep] ?? 0));
  v[keep] = k;
  const rest = Math.sqrt(Math.max(0, 1 - k * k));
  let len = 0;
  for (let j = 0; j < w; j++) if (j !== keep) len += (v[j] ?? 0) ** 2;
  len = Math.sqrt(len);
  for (let j = 0; j < w; j++) {
    if (j === keep) continue;
    v[j] = len > EPS ? ((v[j] ?? 0) / len) * rest : rest / Math.sqrt(w - 1);
  }
}

function snap(v: number, min: number, max: number, step: number): number {
  const s = min + Math.round((v - min) / step) * step;
  return Math.min(Math.max(s, Math.min(min, max)), Math.max(min, max));
}

/** Callback fired for each resolved uniform write. */
type UpdateSink = (update: UniformUpdate) => void;

/**
 * Live router bound to the shared manager + store. Create one per editor, call
 * {@link setEffect} + {@link setManifest} as the effect compiles, and
 * {@link attach} to start listening. {@link detach} tears down subscriptions.
 */
export class MidiRouter {
  private effectId = "";
  private manifest: FxUniform[] = [];
  private unsubControl: (() => void) | null = null;
  private readonly shadow: UniformShadow;

  /** `live` (optional) reads a uniform's current on-screen value, so knob
   * turns on one colour/vector channel keep the other channels where the
   * user left them. */
  constructor(
    private readonly sink: UpdateSink,
    live?: (u: FxUniform) => readonly number[] | undefined,
  ) {
    this.shadow = new UniformShadow(live);
  }

  setEffect(effectId: string): void {
    if (effectId !== this.effectId) this.shadow.clear();
    this.effectId = effectId;
  }

  setManifest(manifest: FxUniform[]): void {
    this.manifest = manifest;
  }

  /** Start listening to hardware control events. Idempotent. */
  attach(): void {
    if (this.unsubControl !== null) return;
    this.unsubControl = midiManager.onControl((e) => this.onControl(e));
  }

  detach(): void {
    this.unsubControl?.();
    this.unsubControl = null;
  }

  private onControl(event: MidiControlEvent): void {
    if (this.manifest.length === 0 || !this.effectId) return;
    const updates = resolveControlUpdates(
      event,
      this.manifest,
      midiStore.semantics(),
      midiStore.bindings(this.effectId),
      this.shadow,
    );
    for (const u of updates) this.sink(u);
  }
}
