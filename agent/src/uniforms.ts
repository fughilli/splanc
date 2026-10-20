/**
 * Uniforms by NAME (spec: "Names, not slots"). The compiler's manifest JSON maps
 * each uniform to a slot range; agents address uniforms by name and this module
 * resolves + validates them into the wire's `UniformValue { slot, value[] }`.
 *
 * Manifest fields today: name, slot, width, ui, default. Newer compilers may add
 * `doc`, `min`, `max`, `unit` per uniform (the device-side spec work); they are
 * read when present — explicit min/max win over the slider's ui range.
 */

import type { UniformValueFlat } from "../../web/src/net/proto";

export type UiKind =
  | { kind: "slider"; min: number; max: number; step: number }
  | { kind: "color" }
  | { kind: "toggle" }
  | { kind: "dropdown"; options: string[] };

export interface ManifestUniform {
  name: string;
  slot: number;
  width: number;
  ui: UiKind;
  default: number[];
  doc?: string;
  min?: number;
  max?: number;
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
  }
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
  } else if (typeof v === "number") vals = u.width > 1 ? new Array<number>(u.width).fill(v) : [v];
  else vals = v;
  if (vals.length !== u.width) {
    throw new UniformError(`${u.name}: expected ${u.width} value(s), got ${vals.length}`);
  }
  if (vals.some((x) => !Number.isFinite(x))) throw new UniformError(`${u.name}: values must be finite`);
  const r = rangeOf(u);
  if (r) {
    for (const x of vals) {
      if (x < r.min - 1e-9 || x > r.max + 1e-9) {
        throw new UniformError(`${u.name}: ${x} is outside ${r.min}..${r.max}`);
      }
    }
  }
  return vals;
}

/** Resolve `{name: value}` against the manifest into wire UniformValues. */
export function resolve(manifest: ManifestUniform[], values: Record<string, UniformInput>): UniformValueFlat[] {
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

/** Linear interpolation between two value vectors (dropdown/toggle snap at the end). */
export function lerpValues(u: ManifestUniform, from: number[], to: number[], t: number): number[] {
  if (u.ui.kind === "dropdown" || u.ui.kind === "toggle") return t >= 1 ? to : from;
  return from.map((a, i) => a + ((to[i] ?? a) - a) * t);
}

/** A human/agent-facing description of one uniform (for list_uniforms). */
export function describe(u: ManifestUniform, current?: number[]): Record<string, unknown> {
  const r = rangeOf(u);
  return {
    name: u.name,
    width: u.width,
    ui: u.ui,
    ...(r ? { min: r.min, max: r.max } : {}),
    ...(u.unit !== undefined ? { unit: u.unit } : {}),
    ...(u.doc !== undefined ? { doc: u.doc } : {}),
    default: u.default,
    ...(current ? { current } : {}),
  };
}
