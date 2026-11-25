/**
 * What the AI sees and does for MIDI auto-mapping (FUG-9, D-541 PR 3): the
 * `list_midi_controls` summary and the validation behind `set_midi_mapping`.
 * Shared by the effect editor and Acid Mode, which used to keep two copies.
 *
 * Colour and vector uniforms are listed with the channels a mapping may name,
 * and colour uniforms with their current RGB and HSV, so the model can offer
 * every option the owner asked for (D-541): one knob on hue with S and V fixed
 * at their current values, three knobs as H/S/V, or R/G/B on request. Pure (no
 * DOM, no store access): callers pass the tables in.
 */

import type { FxUniform } from "../fx/preview";
import type { MidiMappingCall } from "../effects/ai/generate";
import type { MidiControlId } from "./manager";
import { controlLabel } from "./manager";
import type { SemanticControl, UniformBinding } from "../store/midiStore";
import { sameTarget } from "../store/midiStore";
import {
  bindingChannels,
  channelSpace,
  effectiveChannel,
  isColorUniform,
  isDrivable,
  isScalarDrivable,
} from "./router";
import { clamp01, rgbToHsv } from "../color/hsv";

/** The guidance sent with the summary and repeated in the prompts. */
export const MIDI_COLOUR_GUIDANCE =
  "Colour uniforms can be mapped three ways: (1) ONE knob → hue: channel 'h', " +
  "with fixed {s, v} set to the colour's current saturation/value (from 'hsv' " +
  "here) so only the hue moves; (2) THREE knobs → channels 'h', 's', 'v'; " +
  "(3) RGB, only if the user asks: channels 'r', 'g', 'b' (and 'a' on a vec4). " +
  "Vectors map one knob per component ('x', 'y', 'z', 'w'); matrices by " +
  "component index ('0'..). Scalars take no channel. Prefer hue-only for a " +
  "single spare knob, and say which option you chose.";

/** The canned "✨ Remap" request the editor sends (FUG-9): the model reads the
 * uniforms + named controls and wires them via the mapping layer, never by
 * editing the effect source. */
export const MIDI_REMAP_PROMPT =
  "Map my MIDI controls to this effect's uniforms. First call list_midi_controls " +
  "to see the drivable uniforms and the named controls, then call set_midi_mapping " +
  "to wire them. Match by meaning (a 'speed'/'rate' knob → a speed uniform, " +
  "'brightness' → an intensity/gain uniform, etc.). Colour uniforms can be mapped " +
  "too: a single spare knob → hue only (channel 'h', fixed s/v at the current " +
  "values), three knobs → h, s, v, and r, g, b only if I ask for RGB; vectors per " +
  "component. Do NOT modify the effect source — the mapping is a separate layer.";

const r3 = (x: number): number => Math.round(x * 1000) / 1000;

/** The JSON summary list_midi_controls returns. `values` gives a uniform's
 * current value (falls back to its default). */
export function midiListSummary(input: {
  uniforms: readonly FxUniform[];
  values?: (u: FxUniform) => readonly number[] | undefined;
  semantics: readonly SemanticControl[];
  bindings: readonly UniformBinding[];
  midiEnabled: boolean;
}): string {
  const uniforms = input.uniforms.filter(isDrivable).map((u) => {
    if (isScalarDrivable(u)) {
      return {
        name: u.name,
        type: u.ui.kind,
        ...(u.ui.kind === "slider" ? { min: u.ui.min, max: u.ui.max } : {}),
      };
    }
    const channels = bindingChannels(u);
    if (isColorUniform(u)) {
      const cur = input.values?.(u) ?? u.default;
      const rgb = [0, 1, 2].map((i) => clamp01(cur[i] ?? 0));
      const [h, s, v] = rgbToHsv(rgb[0]!, rgb[1]!, rgb[2]!);
      return {
        name: u.name,
        type: "color",
        channels,
        rgb: rgb.map(r3),
        hsv: [r3(h), r3(s), r3(v)],
        ...(u.width === 4 ? { alpha: r3(clamp01(cur[3] ?? 1)) } : {}),
      };
    }
    if (u.ui.kind === "matrix") {
      return { name: u.name, type: "matrix", channels, min: u.ui.min, max: u.ui.max };
    }
    const ui = u.ui.kind === "slider" ? u.ui : null;
    return {
      name: u.name,
      type: "vector",
      channels,
      min: u.mins ?? channels.map(() => ui?.min ?? 0),
      max: u.maxs ?? channels.map(() => ui?.max ?? 1),
    };
  });
  const namedControls = input.semantics.map((s) => ({
    name: s.name,
    source: controlSource(s.control),
  }));
  const currentMappings = input.bindings.map((b) => ({
    uniform: b.uniform,
    control: b.semantic,
    ...(b.channel !== undefined ? { channel: b.channel } : {}),
    ...(b.space !== undefined ? { space: b.space } : {}),
    ...(b.fixed !== undefined ? { fixed: b.fixed } : {}),
    ...(b.min !== undefined ? { min: b.min } : {}),
    ...(b.max !== undefined ? { max: b.max } : {}),
    ...(b.invert ? { invert: true } : {}),
  }));
  const hasVectors = uniforms.some((u) => "channels" in u);
  return JSON.stringify(
    {
      uniforms,
      namedControls,
      currentMappings,
      midiEnabled: input.midiEnabled,
      ...(hasVectors ? { colourAndVectorMapping: MIDI_COLOUR_GUIDANCE } : {}),
    },
    null,
    2,
  );
}

function controlSource(c: MidiControlId): string {
  return `${c.device} · ${controlLabel(c)}`;
}

/** Validate the model's mappings against the manifest. Unknown or undrivable
 * uniforms, missing/unknown channels and a space that contradicts the channel
 * are skipped with a reason; a later mapping of the same uniform + channel
 * replaces an earlier one. */
export function validateMidiMappings(
  mappings: readonly MidiMappingCall[],
  uniforms: readonly FxUniform[],
): { applied: UniformBinding[]; skipped: string[] } {
  const applied: UniformBinding[] = [];
  const skipped: string[] = [];
  for (const m of mappings) {
    const u = uniforms.find((x) => x.name === m.uniform);
    if (!u || !isDrivable(u)) {
      skipped.push(`${m.uniform} (not a drivable uniform)`);
      continue;
    }
    const b: UniformBinding = {
      uniform: m.uniform,
      semantic: m.control,
      ...(typeof m.min === "number" ? { min: m.min } : {}),
      ...(typeof m.max === "number" ? { max: m.max } : {}),
      ...(m.invert ? { invert: true } : {}),
    };
    if (!isScalarDrivable(u)) {
      if (typeof m.channel === "string") b.channel = m.channel;
      if (m.space === "rgb" || m.space === "hsv") b.space = m.space;
      const ch = effectiveChannel(u, b);
      if (ch === null) {
        skipped.push(
          `${m.uniform} (needs a channel: one of ${bindingChannels(u).join(", ")})`,
        );
        continue;
      }
      b.channel = ch;
      const space = channelSpace(ch);
      if (isColorUniform(u) && space !== null) {
        if (b.space !== undefined && b.space !== space) {
          skipped.push(`${m.uniform} (channel '${ch}' is ${space}, not ${b.space})`);
          continue;
        }
        b.space = space;
      } else {
        delete b.space;
      }
      if (space === "hsv" && m.fixed && typeof m.fixed === "object") {
        const fixed: { s?: number; v?: number } = {};
        if (typeof m.fixed.s === "number" && ch !== "s") fixed.s = clamp01(m.fixed.s);
        if (typeof m.fixed.v === "number" && ch !== "v") fixed.v = clamp01(m.fixed.v);
        if (fixed.s !== undefined || fixed.v !== undefined) b.fixed = fixed;
      }
    }
    const dup = applied.findIndex((a) => sameTarget(a, b));
    if (dup >= 0) applied.splice(dup, 1);
    applied.push(b);
  }
  return { applied, skipped };
}
