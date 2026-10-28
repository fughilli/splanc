/**
 * Wide uniforms on the wire (mat3/mat4, and anything else wider than a vec4).
 *
 * The proto's `UniformValue { slot, value[] }` historically carried 1..4 floats,
 * and older firmware rejects / truncates anything wider. The device's
 * set_uniform writes `value` into CONSECUTIVE slots starting at `slot`, so a
 * 16-float mat4 at slot 8 is sent as `{8, v[0..4]}, {12, v[4..8]}, {16, ...},
 * {20, ...}` — exactly the same write, understood by old and new firmware alike.
 * Values the device sends back (EffectUniforms.current, Keypoint.slots) arrive
 * chunked the same way; {@link reassembleUniformValues} stitches them back into
 * one value per manifest uniform.
 *
 * Shared by the app and the MCP bridge (//web:agent_reuse_srcs).
 */

import type { UniformValueFlat } from "./proto";

/** The most floats one UniformValue may carry on the wire. */
export const MAX_WIRE_FLOATS = 4;

/** Split every value wider than {@link MAX_WIRE_FLOATS} into consecutive
 * slot-addressed chunks. Values of 0..4 floats pass through unchanged
 * (idempotent: chunking chunks is a no-op). */
export function chunkUniformValues(values: readonly UniformValueFlat[]): UniformValueFlat[] {
  const out: UniformValueFlat[] = [];
  for (const v of values) {
    const vals = v.value ?? [];
    if (vals.length <= MAX_WIRE_FLOATS) {
      out.push({ slot: v.slot, value: [...vals] });
      continue;
    }
    for (let i = 0; i < vals.length; i += MAX_WIRE_FLOATS) {
      out.push({ slot: v.slot + i, value: vals.slice(i, i + MAX_WIRE_FLOATS) });
    }
  }
  return out;
}

/**
 * Reassemble slot-addressed values (possibly chunked; a value at slot s with n
 * floats covers slots s..s+n-1) into one full-width value per manifest uniform.
 * A uniform none of whose slots were reported is omitted; a partly reported one
 * fills the missing components from its default (or 0).
 */
export function reassembleUniformValues(
  values: readonly UniformValueFlat[],
  manifest: readonly { slot: number; width: number; default?: readonly number[] }[],
): UniformValueFlat[] {
  const flat = new Map<number, number>();
  for (const v of values) (v.value ?? []).forEach((x, i) => flat.set(v.slot + i, x));
  const out: UniformValueFlat[] = [];
  for (const u of manifest) {
    const w = Math.max(1, u.width);
    let any = false;
    const value: number[] = [];
    for (let i = 0; i < w; i++) {
      const x = flat.get(u.slot + i);
      if (x !== undefined) any = true;
      value.push(x ?? u.default?.[i] ?? 0);
    }
    if (any) out.push({ slot: u.slot, value });
  }
  return out;
}
