/**
 * Lamp power for the agent (docs/design/lamp-power.md; the "power" feature):
 * the pure pieces the set_power / get_power / set_transitions tools share —
 * the agent-facing view of a power_state, and the wire PowerTransition a
 * transition spec becomes. The device round trips live in DeviceSession.
 */

import {
  POWER_BOOT_LAST,
  POWER_BOOT_OFF,
  POWER_BOOT_ON,
  POWER_STYLE_CUT,
  POWER_STYLE_EFFECT,
  POWER_STYLE_FADE,
  type PowerState,
  type PowerTransitionFlat,
  type UniformValueFlat,
} from "../../web/src/net/proto";
import type { ManifestUniform } from "./uniforms";

export type PowerStyle = "cut" | "fade" | "effect";
export type PowerBoot = "last" | "on" | "off";

/** Uniform preset values per transition (PowerTransition.uniforms cap). */
export const MAX_TRANSITION_UNIFORMS = 8;
/** The device's duration bounds (0 = its default). */
export const TRANSITION_MIN_MS = 100;
export const TRANSITION_MAX_MS = 30_000;

const STYLE_WIRE: Record<PowerStyle, number> = { cut: POWER_STYLE_CUT, fade: POWER_STYLE_FADE, effect: POWER_STYLE_EFFECT };
const BOOT_WIRE: Record<PowerBoot, number> = { last: POWER_BOOT_LAST, on: POWER_BOOT_ON, off: POWER_BOOT_OFF };

export const styleWire = (s: PowerStyle): number => STYLE_WIRE[s];
export const bootWire = (b: PowerBoot): number => BOOT_WIRE[b];

function styleName(n: number): PowerStyle | string {
  return n === POWER_STYLE_CUT ? "cut" : n === POWER_STYLE_FADE ? "fade" : n === POWER_STYLE_EFFECT ? "effect" : `style ${n}`;
}

const PHASES = ["off", "on", "turning_on", "turning_off"];
const SOURCES = ["boot", "app/agent", "trigger"];
const BOOTS = ["last", "on", "off"];

const named = (table: string[], n: number): string => table[n] ?? `unknown (${n})`;

/** A transition as the agent reports it. */
function transitionView(t: PowerState["onTransition"], dir: "on" | "off"): Record<string, unknown> {
  const style = styleName(t.style);
  const out: Record<string, unknown> = {
    style,
    duration_s: t.durationMs > 0 ? t.durationMs / 1000 : dir === "on" ? 0.7 : 0.9,
  };
  if (t.durationMs === 0) out["duration_note"] = "device default";
  if (t.effectId) out["stored_effect"] = t.effectId;
  if (t.label) out["look"] = t.label;
  if (t.uniformCount > 0) out["preset_uniforms"] = t.uniformCount;
  if (style === "effect" && !t.effectId) {
    out["note"] = "no transition effect is stored: the device plays a fade";
  }
  return out;
}

/** The agent-facing view of a power_state. */
export function powerView(p: PowerState): Record<string, unknown> {
  const out: Record<string, unknown> = {
    on: p.on,
    phase: named(PHASES, p.phase),
    brightness: Math.round(p.brightness * 1000) / 1000,
    effect_id: p.effectId || null,
    last_change: named(SOURCES, p.source),
    boot: named(BOOTS, p.boot),
    on_transition: transitionView(p.onTransition, "on"),
    off_transition: transitionView(p.offTransition, "off"),
  };
  if (p.transitionLeftMs > 0) out["transition_left_s"] = p.transitionLeftMs / 1000;
  // The pool trigger (a driver export such as the lid's touch sensor) that toggles power.
  out["toggle_trigger"] = p.toggleTrigger
    ? { name: p.toggleTrigger, fired_since_boot: p.triggerCount }
    : null;
  return out;
}

/** What one direction of set_transitions asks for. */
export interface TransitionSpec {
  style?: PowerStyle | undefined;
  durationS?: number | undefined;
  /** effect style: the effect's id on the device + its compiled .fxb + manifest. */
  effect?: { effectId: string; fxb: Uint8Array; uniforms: ManifestUniform[] } | undefined;
  /** effect style: slot-addressed preset (resolved by the session). */
  uniforms?: UniformValueFlat[] | undefined;
  /** Display label (the keypoint's name). */
  label?: string | undefined;
}

/** Duration in seconds -> the wire ms (0 = device default when unset). */
export function durationMs(s: number | undefined): number {
  if (s === undefined) return 0;
  const ms = Math.round(s * 1000);
  return Math.min(TRANSITION_MAX_MS, Math.max(TRANSITION_MIN_MS, ms));
}

/** The wire PowerTransition for a spec (effect implied by an effect, else fade). */
export function wireTransition(spec: TransitionSpec): PowerTransitionFlat {
  const style: PowerStyle = spec.style ?? (spec.effect ? "effect" : "fade");
  const t: PowerTransitionFlat = { style: styleWire(style), durationMs: durationMs(spec.durationS) };
  if (style === "effect" && spec.uniforms?.length) t.uniforms = spec.uniforms;
  if (spec.label) t.label = spec.label;
  return t;
}
