/**
 * Pure play-mode helpers (no DOM; unit-tested in tests/playMode.test.ts): which
 * sliders a preset shows and the uniform values to send after a deploy.
 */

import type { FxUniform } from "../fx/preview";
import type { UniformValueFlat } from "../net/proto";
import type { HalloweenPreset } from "./presets";

export interface PlaySliderSpec {
  name: string;
  slot: number;
  min: number;
  max: number;
  step: number;
  value: number;
}

function asArray(v: number | number[]): number[] {
  return Array.isArray(v) ? v : [v];
}

/** Up to two big sliders for a preset: its `sliders` names that exist in the
 * compiled manifest as SCALAR slider uniforms. `current` holds values the visitor
 * already moved (by name); else the preset override, else the declared default. */
export function sliderSpecs(
  preset: Pick<HalloweenPreset, "sliders" | "uniforms">,
  uniforms: FxUniform[],
  current: Record<string, number> = {},
): PlaySliderSpec[] {
  const out: PlaySliderSpec[] = [];
  for (const name of preset.sliders) {
    if (out.length >= 2) break;
    const u = uniforms.find((x) => x.name === name);
    if (!u || u.width !== 1 || u.ui.kind !== "slider") continue;
    const { min, max } = u.ui;
    const override = preset.uniforms[name];
    const base = current[name] ?? (override !== undefined ? asArray(override)[0] : undefined) ?? u.default[0] ?? min;
    const step = u.ui.step > 0 ? u.ui.step : (max - min) / 100;
    out.push({ name, slot: u.slot, min, max, step, value: Math.min(max, Math.max(min, base)) });
  }
  return out;
}

/** The device-derived uniform every Halloween preset declares: the first LED
 * of channel 1 (the rope), i.e. channel 0's LED count; 0 = no rope. */
export const ROPE_START_UNIFORM = "rope_start";

/** `rope_start` for a device's hardware config (0 when CH1 is unused). */
export function ropeStartFromChannels(channels: ReadonlyArray<{ channel: number; ledCount: number }>): number {
  const n = (ch: number): number => Math.max(0, channels.find((c) => c.channel === ch)?.ledCount ?? 0);
  return n(1) > 0 ? n(0) : 0;
}

/** The values to push right after deploying a preset: every declared default,
 * the preset's overrides on top, then device-derived values (`device`, e.g.
 * rope_start), then the visitor's slider positions. Unknown names and width
 * mismatches are skipped. */
export function presetUniformValues(
  preset: Pick<HalloweenPreset, "uniforms">,
  uniforms: FxUniform[],
  current: Record<string, number> = {},
  device: Record<string, number> = {},
): UniformValueFlat[] {
  return uniforms.map((u) => {
    let value = u.default.slice();
    const o = preset.uniforms[u.name];
    if (o !== undefined && asArray(o).length === u.width) value = asArray(o).slice();
    const d = device[u.name];
    if (d !== undefined && u.width === 1) value = [d];
    const c = current[u.name];
    if (c !== undefined && u.width === 1) value = [c];
    return { slot: u.slot, value };
  });
}
