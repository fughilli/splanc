/**
 * Uniforms by NAME (spec: "Names, not slots"). The compiler's manifest JSON maps
 * each uniform to a slot range; agents address uniforms by name and this module
 * resolves + validates them into the wire's `UniformValue { slot, value[] }`.
 *
 * Manifest fields today: name, slot, width, ui, default. Newer compilers may add
 * `doc`, `min`, `max`, `unit` per uniform (the device-side spec work); they are
 * read when present — explicit min/max win over the slider's ui range.
 *
 * Ranged vectors (`uniform vec3 p : -1 .. 1`) are `ui.kind "slider"` with width
 * > 1 (bounds may be negative); a per-component range adds `mins`/`maxs`.
 * mat3/mat4 are `ui.kind "matrix"`, width 9/16, column-major (GLSL). On the
 * wire a UniformValue carries at most 4 floats, so {@link resolve} splits a
 * matrix into consecutive slot chunks (web/src/net/uniformWire.ts).
 */

import type { UniformValueFlat } from "../../web/src/net/proto";
import { chunkUniformValues, reassembleUniformValues } from "../../web/src/net/uniformWire";

export type UiKind =
  | { kind: "slider"; min: number; max: number; step: number }
  | { kind: "color" }
  | { kind: "toggle" }
  | { kind: "dropdown"; options: string[] }
  | { kind: "matrix"; min: number; max: number };

export interface ManifestUniform {
  name: string;
  slot: number;
  width: number;
  ui: UiKind;
  default: number[];
  doc?: string;
  min?: number;
  max?: number;
  /** Per-component range of a vector declared `vecN(lo..) .. vecN(hi..)`
   * (min/max are then the envelope). */
  mins?: number[];
  maxs?: number[];
  unit?: string;
}

/** Parse the manifest JSON (bytes from effect_uniforms, or the compiler's string). */
export function parseManifest(raw: Uint8Array | string): ManifestUniform[] {
  const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
  if (text.trim() === "") return [];
  const arr = JSON.parse(text) as unknown;
  if (!Array.isArray(arr)) throw new Error("uniform manifest is not a JSON array");
  return arr as ManifestUniform[];
}

/** The numeric range a uniform's values must lie in, or null if unbounded. */
export function rangeOf(u: ManifestUniform): { min: number; max: number } | null {
  if (u.min !== undefined && u.max !== undefined) return { min: u.min, max: u.max };
  switch (u.ui.kind) {
    case "slider":
      return { min: u.ui.min, max: u.ui.max };
    case "color":
      return { min: 0, max: 1 };
    case "toggle":
      return { min: 0, max: 1 };
    case "dropdown":
      return { min: 0, max: Math.max(0, u.ui.options.length - 1) };
    case "matrix":
      return { min: u.ui.min, max: u.ui.max };
    default:
      return null;
  }
}

/** The range of each of the uniform's `width` components (per-component
 * `mins`/`maxs` when declared, else {@link rangeOf} for every one), or null. */
export function componentRanges(u: ManifestUniform): { min: number; max: number }[] | null {
  const w = Math.max(1, u.width);
  if (u.mins && u.maxs && u.mins.length === w && u.maxs.length === w) {
    return u.mins.map((min, i) => ({ min, max: u.maxs![i]! }));
  }
  const r = rangeOf(u);
  return r ? Array.from({ length: w }, () => r) : null;
}

/** N for an N×N matrix uniform (mat3 → 3, mat4 → 4), else null. */
export function matrixDim(u: ManifestUniform): number | null {
  if (u.ui.kind !== "matrix") return null;
  const n = Math.round(Math.sqrt(u.width));
  return n * n === u.width ? n : null;
}

export type UniformInput = number | boolean | string | number[];

export class UniformError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UniformError";
  }
}

/** One uniform value in the manifest's terms: a vector of `width` numbers. */
export function coerce(u: ManifestUniform, v: UniformInput): number[] {
  let vals: number[];
  if (typeof v === "boolean") vals = [v ? 1 : 0];
  else if (typeof v === "string") {
    if (u.ui.kind !== "dropdown") throw new UniformError(`${u.name}: a string value needs a dropdown uniform`);
    const i = u.ui.options.indexOf(v);
    if (i < 0) throw new UniformError(`${u.name}: "${v}" is not one of ${JSON.stringify(u.ui.options)}`);
    vals = [i];
  } else if (typeof v === "number") {
    // A scalar fills a vector; for a matrix it is GLSL's mat4(s): s on the diagonal.
    const n = matrixDim(u);
    vals = n ? Array.from({ length: u.width }, (_, i) => (i % (n + 1) === 0 ? v : 0)) : new Array<number>(u.width).fill(v);
  }
  else vals = v;
  if (vals.length !== u.width) {
    const n = matrixDim(u);
    const hint = n ? ` (a mat${n} is ${u.width} numbers, column-major)` : "";
    throw new UniformError(`${u.name}: expected ${u.width} value(s), got ${vals.length}${hint}`);
  }
  if (vals.some((x) => typeof x !== "number" || !Number.isFinite(x))) {
    throw new UniformError(`${u.name}: values must be finite`);
  }
  const rs = componentRanges(u);
  if (rs) {
    vals.forEach((x, i) => {
      const r = rs[i]!;
      if (x < r.min - 1e-9 || x > r.max + 1e-9) {
        const which = u.width > 1 ? `[${i}]` : "";
        throw new UniformError(`${u.name}${which}: ${x} is outside ${r.min}..${r.max}`);
      }
    });
  }
  return [...vals];
}

/** Resolve `{name: value}` against the manifest into wire UniformValues: one
 * per uniform, except that a uniform wider than 4 floats (mat3/mat4) becomes
 * consecutive ≤4-float slot chunks (the wire contract; old firmware too). */
export function resolve(manifest: ManifestUniform[], values: Record<string, UniformInput>): UniformValueFlat[] {
  return chunkUniformValues(resolveFull(manifest, values));
}

/** Like {@link resolve}, but one full-width value per named uniform, in the
 * order given (for ramps that interpolate by uniform). */
export function resolveFull(manifest: ManifestUniform[], values: Record<string, UniformInput>): UniformValueFlat[] {
  const byName = new Map(manifest.map((u) => [u.name, u]));
  const out: UniformValueFlat[] = [];
  for (const [name, v] of Object.entries(values)) {
    const u = byName.get(name);
    if (!u) {
      const known = manifest.map((m) => m.name).join(", ") || "(none)";
      throw new UniformError(`unknown uniform "${name}"; the active effect declares: ${known}`);
    }
    out.push({ slot: u.slot, value: coerce(u, v) });
  }
  return out;
}

/** Device-reported values (EffectUniforms.current / Keypoint.slots: a wide
 * uniform arrives as consecutive slot chunks) as full values by uniform name. */
export function currentByName(manifest: ManifestUniform[], values: readonly UniformValueFlat[]): Map<string, number[]> {
  const bySlot = new Map(reassembleUniformValues(values, manifest).map((v) => [v.slot, v.value]));
  const out = new Map<string, number[]>();
  for (const u of manifest) {
    const v = bySlot.get(u.slot);
    if (v) out.set(u.name, v);
  }
  return out;
}

/** Linear interpolation between two value vectors, component-wise (vectors and
 * matrices alike; dropdown/toggle snap at the end). A matrix lerp is
 * element-wise, NOT a proper rotation interpolation: halfway between two
 * rotations is generally not a rotation (it shears/shrinks). */
export function lerpValues(u: ManifestUniform, from: number[], to: number[], t: number): number[] {
  if (u.ui.kind === "dropdown" || u.ui.kind === "toggle") return t >= 1 ? to : from;
  return from.map((a, i) => a + ((to[i] ?? a) - a) * t);
}

/** A human/agent-facing description of one uniform (for list_uniforms). */
export function describe(u: ManifestUniform, current?: number[]): Record<string, unknown> {
  const r = rangeOf(u);
  const n = matrixDim(u);
  return {
    name: u.name,
    width: u.width,
    ui: u.ui,
    ...(r ? { min: r.min, max: r.max } : {}),
    ...(u.mins && u.maxs ? { mins: u.mins, maxs: u.maxs } : {}),
    ...(n ? { rows: n, cols: n, layout: "column-major" } : {}),
    ...(u.unit !== undefined ? { unit: u.unit } : {}),
    ...(u.doc !== undefined ? { doc: u.doc } : {}),
    default: u.default,
    ...(current ? { current } : {}),
  };
}
