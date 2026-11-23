/**
 * Lamp power, app side (docs/design/lamp-power.md; firmware feature "power"):
 * the pure logic behind the device sheet's power toggle, the Transitions flow
 * and the Hardware Setup touch-sensor section. No DOM, no client — unit-tested
 * in tests/power.test.ts.
 */

import {
  POWER_BOOT_LAST,
  POWER_BOOT_OFF,
  POWER_BOOT_ON,
  POWER_PHASE_OFF,
  POWER_PHASE_ON,
  POWER_PHASE_TURNING_OFF,
  POWER_PHASE_TURNING_ON,
  POWER_SOURCE_TRIGGER,
  POWER_STYLE_CUT,
  POWER_STYLE_EFFECT,
  POWER_STYLE_FADE,
  type KeypointValueFlat,
  type PowerState,
  type PowerTransitionFlat,
  type UniformValueFlat,
} from "../net/proto";

/** Whether the connected firmware has lamp power (welcome.features "power"). */
export function deviceHasPower(welcome: { features?: string[] | null } | null | undefined): boolean {
  return (welcome?.features ?? []).includes("power");
}

/** Device defaults when a transition's durationMs is 0 (firmware lamp-power.md). */
export const DEFAULT_ON_MS = 700;
export const DEFAULT_OFF_MS = 900;
/** The firmware clamps durations to this range. */
export const MIN_DURATION_MS = 100;
export const MAX_DURATION_MS = 30_000;
/** The Transitions slider's range (the firmware accepts up to 30 s; past 10 s
 * a lamp just looks stuck, so the slider stops there). */
export const SLIDER_MAX_MS = 10_000;
/** Uniform values one transition preset carries (PowerTransition.uniforms). */
export const MAX_PRESET_VALUES = 8;
/** PowerTransition.label limit (bytes on the device). */
export const MAX_LABEL_BYTES = 32;

export type Direction = "on" | "off";

/** The power slot for a direction (SubmitEffect.power_slot). */
export function slotFor(dir: Direction): 1 | 2 {
  return dir === "on" ? 1 : 2;
}

/** The effective duration of a transition (0 = the device default). */
export function effectiveDurationMs(t: Pick<PowerTransitionFlat, "durationMs">, dir: Direction): number {
  const d = t.durationMs ?? 0;
  if (d <= 0) return dir === "on" ? DEFAULT_ON_MS : DEFAULT_OFF_MS;
  return Math.min(MAX_DURATION_MS, Math.max(MIN_DURATION_MS, Math.round(d)));
}

/** "0.7 s" / "1.2 s" / "12 s". */
export function formatSeconds(ms: number): string {
  const s = ms / 1000;
  if (s >= 10) return `${Math.round(s)} s`;
  return `${s.toFixed(1)} s`;
}

/** Headline for the power toggle. */
export function powerHeadline(s: PowerState | null): string {
  if (!s) return "Reading…";
  switch (s.phase) {
    case POWER_PHASE_ON:
      return "On";
    case POWER_PHASE_TURNING_ON:
      return "Turning on…";
    case POWER_PHASE_TURNING_OFF:
      return "Turning off…";
    case POWER_PHASE_OFF:
    default:
      return "Off";
  }
}

/** Whether the switch should show "on": the TARGET state, so it flips at once
 * when a transition starts rather than when it settles. */
export function switchOn(s: PowerState | null): boolean {
  return s?.on ?? false;
}

/** The status line under the toggle. */
export function powerDetail(s: PowerState | null): string {
  if (!s) return "";
  const parts: string[] = [];
  if (s.phase === POWER_PHASE_OFF) parts.push("LEDs dark, effect paused. Still connected.");
  else if (s.phase === POWER_PHASE_ON && s.effectId) parts.push("Effect running.");
  if (s.source === POWER_SOURCE_TRIGGER) parts.push("Last changed by a tap on the lid.");
  if (s.toggleTrigger && s.source !== POWER_SOURCE_TRIGGER) parts.push("Tap the lid to toggle.");
  return parts.join(" ");
}

/** The style name shown to the user. */
export function styleName(style: number): string {
  if (style === POWER_STYLE_CUT) return "Cut";
  if (style === POWER_STYLE_EFFECT) return "Effect";
  return "Fade";
}

/** One-line summary of a configured transition, e.g. "Fade · 0.7 s" or
 * "Bloom (Warm) · 2.0 s". */
export function transitionSummary(
  t: PowerState["onTransition"],
  dir: Direction,
  lookup?: (id: string) => string | undefined,
): string {
  if (t.style === POWER_STYLE_CUT) return "Cut (instant)";
  const dur = formatSeconds(effectiveDurationMs(t, dir));
  if (t.style === POWER_STYLE_EFFECT) {
    if (!t.effectId) return `Fade · ${dur} (no effect stored yet)`;
    const name = effectDisplayName(t.effectId, lookup);
    return `${t.label ? `${name} (${t.label})` : name} · ${dur}`;
  }
  return `Fade · ${dur}`;
}

/** Effect ids the app stores transitions under: library ids as-is, built-in
 * presets as "transition:<preset>". Display names drop the prefix. */
export const PRESET_PREFIX = "transition:";
export function effectDisplayName(effectId: string, lookup?: (id: string) => string | undefined): string {
  const found = lookup?.(effectId);
  if (found) return found;
  if (effectId.startsWith(PRESET_PREFIX)) {
    const p = TRANSITION_PRESETS.find((x) => x.id === effectId);
    return p ? p.name : effectId.slice(PRESET_PREFIX.length);
  }
  return effectId;
}

/** What the user picked in the Transitions flow for one direction. */
export interface TransitionChoice {
  style: number;
  durationMs: number;
  /** EFFECT: the library / preset effect id. */
  effectId?: string;
  /** EFFECT: a saved look's name (keypoint), if one was picked. */
  label?: string;
  /** EFFECT: the look's values, slot-addressed. */
  uniforms?: UniformValueFlat[];
}

/** Truncate a string to `max` UTF-8 bytes without splitting a character. */
export function clampUtf8(s: string, max: number): string {
  const enc = new TextEncoder();
  if (enc.encode(s).length <= max) return s;
  let out = "";
  for (const ch of s) {
    if (enc.encode(out + ch).length > max) break;
    out += ch;
  }
  return out;
}

/** The PowerTransition to send for a choice (set_power_config). */
export function transitionMessage(c: TransitionChoice): PowerTransitionFlat {
  const style = c.style === POWER_STYLE_CUT || c.style === POWER_STYLE_EFFECT ? c.style : POWER_STYLE_FADE;
  const t: PowerTransitionFlat = {
    style,
    durationMs: Math.min(MAX_DURATION_MS, Math.max(MIN_DURATION_MS, Math.round(c.durationMs))),
  };
  if (style === POWER_STYLE_EFFECT) {
    if (c.label) t.label = clampUtf8(c.label, MAX_LABEL_BYTES);
    if (c.uniforms && c.uniforms.length > 0) t.uniforms = c.uniforms.slice(0, MAX_PRESET_VALUES);
  }
  return t;
}

/** A choice seeded from the device's current config for one direction. */
export function choiceFromState(s: PowerState | null, dir: Direction): TransitionChoice {
  const t = s ? (dir === "on" ? s.onTransition : s.offTransition) : null;
  if (!t) return { style: POWER_STYLE_FADE, durationMs: dir === "on" ? DEFAULT_ON_MS : DEFAULT_OFF_MS };
  const c: TransitionChoice = { style: t.style, durationMs: effectiveDurationMs(t, dir) };
  if (t.effectId) c.effectId = t.effectId;
  if (t.label) c.label = t.label;
  return c;
}

/** A keypoint's by-name values resolved to slot-addressed chunks of <= 4
 * floats against the compiled effect's uniform manifest (names it no longer
 * declares are dropped). Returns null when they don't fit one preset. */
export function keypointToUniforms(
  values: KeypointValueFlat[],
  manifest: Array<{ name: string; slot: number; width: number }>,
): UniformValueFlat[] | null {
  const out: UniformValueFlat[] = [];
  for (const v of values) {
    const u = manifest.find((m) => m.name === v.uniform);
    if (!u) continue;
    const vals = v.value.slice(0, Math.max(1, u.width));
    for (let k = 0; k < vals.length; k += 4) out.push({ slot: u.slot + k, value: vals.slice(k, k + 4) });
  }
  return out.length <= MAX_PRESET_VALUES ? out : null;
}

/** Boot behaviour options (PowerConfig.boot). */
export const BOOT_OPTIONS: Array<{ value: number; label: string; hint: string }> = [
  { value: POWER_BOOT_LAST, label: "Restore the last state", hint: "Comes back on if it was on when it lost power." },
  { value: POWER_BOOT_ON, label: "Always on", hint: "Lights up whenever it gets power, e.g. from a wall switch." },
  { value: POWER_BOOT_OFF, label: "Always off", hint: "Stays dark after power returns until you turn it on." },
];

// -- Built-in transition effects -------------------------------------------
// Written for the transition uniforms: `power` is the lamp's light level
// (0 -> 1 turning on, 1 -> 0 turning off), so one effect serves both
// directions; `transition` is the 0 -> 1 progress.

export interface TransitionPreset {
  id: string;
  name: string;
  description: string;
  source: string;
}

export const TRANSITION_PRESETS: TransitionPreset[] = [
  {
    id: `${PRESET_PREFIX}bloom`,
    name: "Bloom",
    description: "Light grows out from the centre (on) and shrinks back into it (off).",
    source: `uniform float power : 0.0 .. 1.0 = 1.0;
uniform vec3 tint : color = 1.0, 0.62, 0.28;
uniform float edge : 0.05 .. 0.6 = 0.25;

vec3 shade(Led led) {
  float d = length(led.uv - vec2(0.5, 0.5)) * 1.42;
  float r = power * (1.0 + edge);
  float lit = 1.0 - smoothstep(r - edge, r, d);
  return tint * lit * (0.35 + 0.65 * power);
}
`,
  },
  {
    id: `${PRESET_PREFIX}sparkle`,
    name: "Sparkle",
    description: "LEDs twinkle on one by one (on) or drop out in sparkles (off).",
    source: `uniform float power : 0.0 .. 1.0 = 1.0;
uniform vec3 tint : color = 0.85, 0.9, 1.0;
uniform float twinkle : 0.0 .. 10.0 = 4.0;
state float ph;

void update() { ph = fract(ph + dt * twinkle * 0.25); }

vec3 shade(Led led) {
  float h = hash(float(led.idx));
  float on = step(h, power);
  float tw = 0.65 + 0.35 * sin((ph + h) * 6.2832);
  return tint * on * tw;
}
`,
  },
  {
    id: `${PRESET_PREFIX}wipe`,
    name: "Wipe up",
    description: "Light fills the lamp from the bottom up (on) and drains down (off).",
    source: `uniform float power : 0.0 .. 1.0 = 1.0;
uniform vec3 tint : color = 1.0, 0.75, 0.45;
uniform float soft : 0.02 .. 0.5 = 0.12;

vec3 shade(Led led) {
  float h = power * (1.0 + soft);
  float lit = 1.0 - smoothstep(h - soft, h, led.uv.y);
  return tint * lit;
}
`,
  },
];

// -- Touch sensor (a driver-VM driver whose trigger toggles power) ---------

/** GPIOs offered for the touch sensor: the board's recommended pins minus the
 * pins the LED channels drive (and any other busy pin), plus the current pin
 * so a hydrated config always has a matching option. Sorted. */
export function touchPinOptions(recommended: number[], busy: number[], current: number): number[] {
  const set = new Set(recommended.filter((g) => !busy.includes(g)));
  if (current >= 0) set.add(current);
  return [...set].sort((a, b) => a - b);
}

/** The pin the app suggests first (the COIL kit's GPIO 3), or the lowest free
 * option when that one is taken. */
export function suggestedTouchPin(options: number[]): number | null {
  if (options.includes(3)) return 3;
  return options[0] ?? null;
}

/** Live readout of the power binding: which trigger toggles the lamp and how
 * often it has fired. */
export function triggerLiveLine(s: PowerState | null): string {
  if (!s) return "Waiting for the lamp…";
  if (!s.toggleTrigger) return "No sensor toggles the lamp yet.";
  const n = s.triggerCount === 1 ? "1 tap" : `${s.triggerCount} taps`;
  return `"${s.toggleTrigger}" toggles the lamp · ${n} since boot`;
}

/** Edge detector for a growing counter (the trigger count): true when it went
 * up since the last call. The first observation never counts. */
export class CountWatch {
  private last: number | null = null;
  bumped(n: number | null | undefined): boolean {
    if (n === null || n === undefined || !Number.isFinite(n)) return false;
    const up = this.last !== null && n > this.last;
    this.last = n;
    return up;
  }
}

/** What the TTP223 wiring means for the setup form (DAOKI-style 15x11 mm
 * board: header GND / I/O / VCC, 2.5-5.5 V). */
export const TTP223_WIRING =
  "TTP223 board: VCC to 3V3 (not 5V: I/O would then swing to 5 V), GND to GND, I/O to the GPIO below. " +
  "Don't touch the lid for about 1 s after the lamp powers up: the board calibrates then.";

/** The A/B solder-pad table (0 = open, 1 = bridged). As shipped (A=0, B=0)
 * is the target: momentary, active-high. */
export const TTP223_PADS: Array<{ a: 0 | 1; b: 0 | 1; mode: string; activeLow: boolean; recommended: boolean }> = [
  { a: 0, b: 0, mode: "Momentary", activeLow: false, recommended: true },
  { a: 0, b: 1, mode: "Toggle (self-lock)", activeLow: false, recommended: false },
  { a: 1, b: 0, mode: "Momentary", activeLow: true, recommended: false },
  { a: 1, b: 1, mode: "Toggle (self-lock)", activeLow: true, recommended: false },
];

/** The "check the A/B pads or meter I/O" notes under the table. */
export const TTP223_CHECK: string[] = [
  "As shipped both pads are open: momentary, active-high. That's the setting to use.",
  "A toggle (self-lock) board still works, but momentary is simpler: open pad B if it's bridged.",
  "No magnifier? Meter I/O against GND: about 0 V idle and 3.3 V while you touch the pad = momentary, active-high.",
];
