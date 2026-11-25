/**
 * Pure helpers for uniform VALUES against their manifest entry: per-component
 * ranges (signed, and per-component for `vecN(lo..) .. vecN(hi..)`), clamping,
 * and matrix layout (mat3/mat4, column-major).
 * Shared by the uniform panel and anything else validating a value.
 */

import type { FxUniform } from "../fx/preview";

export interface Range {
  min: number;
  max: number;
}

/** The [min,max] each of the uniform's `width` components must lie in, or null
 * when unbounded. Per-component `mins`/`maxs` win; else explicit top-level
 * min/max; else the ui's range (colour/toggle 0..1, dropdown 0..n-1). */
export function componentRanges(u: FxUniform): Range[] | null {
  const w = Math.max(1, u.width);
  if (u.mins && u.maxs && u.mins.length === w && u.maxs.length === w) {
    return u.mins.map((min, i) => ({ min, max: u.maxs![i]! }));
  }
  let r: Range | null;
  if (u.min !== undefined && u.max !== undefined) r = { min: u.min, max: u.max };
  else {
    switch (u.ui.kind) {
      case "slider":
      case "matrix":
      case "vector":
        r = { min: u.ui.min, max: u.ui.max };
        break;
      case "direction":
        r = { min: -1, max: 1 };
        break;
      case "color":
      case "toggle":
        r = { min: 0, max: 1 };
        break;
      case "dropdown":
        r = { min: 0, max: Math.max(0, u.ui.options.length - 1) };
        break;
      default:
        r = null;
    }
  }
  return r ? Array.from({ length: w }, () => ({ ...r })) : null;
}

/** Clamp every component into its range (non-finite components -> range min /
 * default). Always returns exactly `width` components. */
export function clampUniformValue(u: FxUniform, value: readonly number[]): number[] {
  const rs = componentRanges(u);
  const w = Math.max(1, u.width);
  const out: number[] = [];
  for (let i = 0; i < w; i++) {
    let v = value[i];
    if (v === undefined || !Number.isFinite(v)) v = u.default[i] ?? rs?.[i]?.min ?? 0;
    const r = rs?.[i];
    if (r) v = Math.min(Math.max(v, Math.min(r.min, r.max)), Math.max(r.min, r.max));
    out.push(v);
  }
  return out;
}

/** N for an N×N matrix uniform (mat3 = 9 → 3, mat4 = 16 → 4), else null. */
export function matrixDim(u: { width: number; ui: { kind: string } }): number | null {
  if (u.ui.kind !== "matrix") return null;
  const n = Math.round(Math.sqrt(u.width));
  return n * n === u.width ? n : null;
}

/** Storage index of element (row r, column c) of an N×N column-major matrix. */
export function matIndex(r: number, c: number, n: number): number {
  return c * n + r;
}

/** Whether a uniform is a ranged vector (one slider per component). */
export function isRangedVector(u: FxUniform): boolean {
  return u.width > 1 && u.ui.kind === "slider";
}

// -- native precision (D-541) -------------------------------------------------
// Uniform values travel and persist as f32. A slider's `step` is the grid the
// compiler chose: 0 = continuous (a float), 1 = an int, or an explicit
// `step N` annotation. Controls must not invent a coarser grid of their own.

/** The `step` attribute for an `<input type=range|number>`: `"any"` when the
 * uniform is continuous (step 0; the HTML default would be 1). */
export function stepAttr(step: number): string {
  return step > 0 && Number.isFinite(step) ? String(step) : "any";
}

/** Clamp to [min,max] and snap to the step grid; step 0 only clamps. */
export function snapToStep(v: number, min: number, max: number, step: number): number {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  v = Math.min(hi, Math.max(lo, v));
  if (step > 0 && Number.isFinite(step)) v = min + Math.round((v - min) / step) * step;
  return Math.min(hi, Math.max(lo, v));
}

// Colour values are float RGB(A); the live HSV picker (ui/kit/hsvPicker.ts)
// and its maths (color/hsv.ts) replace the 8-bit <input type=color> path.
