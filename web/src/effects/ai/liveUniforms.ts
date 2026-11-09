/**
 * The effect agent's view of, and control over, LIVE uniform values (#452).
 *
 * The editor's uniform panel deliberately keeps a control's live value across
 * recompiles (uniform-panel.ts reconciles by name/width/ui, NOT by default), so
 * a user's tuning survives a script edit. The agent, though, only saw the source:
 * changing `uniform vec3 tint = …`'s default compiled fine yet left the live
 * tint (and so the preview and fixture) unchanged. This module gives it the
 * missing half of the contract:
 *  - `describeLiveUniforms`: the effective values, side by side with the source
 *    defaults (and any MIDI binding), for the turn context;
 *  - `retainedLiveNote`: after a set_script compile, which kept live values now
 *    differ from the new defaults;
 *  - `planLiveUniformChange` / `describeLiveUniformResult`: the set_live_uniforms
 *    tool — set or reset NAMED uniforms only (unrelated tuning and MIDI mappings
 *    are left alone), with an honest report of which sinks got the change.
 *
 * Pure (no DOM): the editor applies the plan to its panel, preview and device.
 */

import type { FxUniform } from "../../fx/preview";
import { clampUniformValue } from "../uniformValues";

/** A live value, keyed by manifest slot (UniformPanel.values()). */
export interface LiveValue {
  slot: number;
  value: number[];
}

/** A uniform→MIDI binding (only the fields this module reads). */
export interface LiveBinding {
  uniform: string;
  semantic: string;
}

/** The set_live_uniforms tool name. */
export const LIVE_UNIFORMS_TOOL_NAME = "set_live_uniforms";

const fmtNum = (v: number): string => {
  if (!Number.isFinite(v)) return String(v);
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? "0" : String(r);
};
const fmtVal = (v: readonly number[]): string => (v.length === 1 ? fmtNum(v[0]!) : `(${v.map(fmtNum).join(", ")})`);

/** Component-wise equality at display precision (what the agent can act on). */
export function sameValue(a: readonly number[], b: readonly number[]): boolean {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (Math.abs(x - y) > 5e-4 * Math.max(1, Math.abs(x), Math.abs(y))) return false;
  }
  return true;
}

function kindLabel(u: FxUniform): string {
  if (u.ui.kind === "color") return " (color)";
  if (u.ui.kind === "toggle") return " (toggle)";
  if (u.ui.kind === "dropdown") return ` (dropdown: ${u.ui.options.join("/")})`;
  if (u.ui.kind === "matrix") return " (matrix)";
  return "";
}

/**
 * The turn-context block: every uniform's EFFECTIVE live value next to its
 * source default, flagged where they differ, with MIDI bindings. Empty string
 * when the effect has no uniforms (nothing to say).
 */
export function describeLiveUniforms(
  manifest: readonly FxUniform[],
  live: readonly LiveValue[],
  bindings: readonly LiveBinding[] = [],
): string {
  if (manifest.length === 0) return "";
  const bySlot = new Map(live.map((v) => [v.slot, v.value] as const));
  const midi = new Map(bindings.map((b) => [b.uniform, b.semantic] as const));
  const lines = [
    "Live uniform values (EFFECTIVE values the preview and connected fixture use now — not the source " +
      "defaults). The panel keeps an existing control's live value across recompiles, so editing a " +
      "uniform's default in the source does NOT change it; use set_live_uniforms to set or reset live values.",
  ];
  let differ = 0;
  for (const u of manifest) {
    const cur = bySlot.get(u.slot) ?? u.default;
    const same = sameValue(cur, u.default);
    if (!same) differ++;
    const b = midi.get(u.name);
    lines.push(
      `- ${u.name}${kindLabel(u)}: live ${fmtVal(cur)}; source default ${fmtVal(u.default)}${
        same ? "" : " ← LIVE DIFFERS FROM DEFAULT"
      }${b ? ` [MIDI-mapped to "${b}"]` : ""}`,
    );
  }
  if (differ === 0) lines.push("(All live values equal their source defaults.)");
  return lines.join("\n");
}

/**
 * After a recompile: the kept live values that differ from the NEW source
 * defaults — exactly the case where a source edit "did nothing" on screen.
 * Empty string when every live value matches its default.
 */
export function retainedLiveNote(manifest: readonly FxUniform[], live: readonly LiveValue[]): string {
  const bySlot = new Map(live.map((v) => [v.slot, v.value] as const));
  const kept = manifest.filter((u) => {
    const cur = bySlot.get(u.slot);
    return cur !== undefined && !sameValue(cur, u.default);
  });
  if (kept.length === 0) return "";
  const list = kept.map((u) => `${u.name} live ${fmtVal(bySlot.get(u.slot)!)} vs default ${fmtVal(u.default)}`);
  return (
    `Live values kept from before (they override the source defaults on the preview and fixture): ${list.join(
      "; ",
    )}. ` + "To change what is shown, call set_live_uniforms (set a value, or reset it to the new default)."
  );
}

/** set_live_uniforms arguments. */
export interface LiveUniformCall {
  set: { name: string; value: number[] }[];
  reset: string[];
  resetAll: boolean;
}

/** Coerce the model's set_live_uniforms input (tolerating a bare number value). */
export function parseLiveUniformCall(input: unknown): LiveUniformCall {
  const o = (input ?? {}) as { set?: unknown; reset?: unknown; reset_all?: unknown };
  const set = Array.isArray(o.set)
    ? o.set.flatMap((e) => {
        const x = e as { name?: unknown; value?: unknown };
        if (typeof x.name !== "string") return [];
        const raw = typeof x.value === "number" ? [x.value] : Array.isArray(x.value) ? x.value : [];
        const nums = raw.filter((n): n is number => typeof n === "number" && Number.isFinite(n));
        return [{ name: x.name, value: nums }];
      })
    : [];
  const reset = Array.isArray(o.reset) ? o.reset.filter((n): n is string => typeof n === "string") : [];
  return { set, reset, resetAll: o.reset_all === true };
}

export interface LiveUniformChange {
  name: string;
  slot: number;
  from: number[];
  to: number[];
  /** True when `to` is the source default (a reset). */
  reset: boolean;
  /** The requested value was clamped into the uniform's declared range. */
  clamped: boolean;
}

export interface LiveUniformPlan {
  changes: LiveUniformChange[];
  /** Names that are not uniforms of the current compile. */
  unknown: string[];
  /** Entries rejected for a bad value (e.g. no numbers), with why. */
  invalid: string[];
  /** Requested names whose live value already equals the target. */
  unchanged: string[];
}

/**
 * Plan a set/reset against the current manifest + live values. Only the named
 * uniforms change (resetAll resets every one to its default); a set wins over a
 * reset of the same name. Values are clamped into the declared range.
 */
export function planLiveUniformChange(
  manifest: readonly FxUniform[],
  live: readonly LiveValue[],
  call: LiveUniformCall,
): LiveUniformPlan {
  const bySlot = new Map(live.map((v) => [v.slot, v.value] as const));
  const plan: LiveUniformPlan = { changes: [], unknown: [], invalid: [], unchanged: [] };
  const targets = new Map<string, { to: number[]; reset: boolean; clamped: boolean }>();
  const byName = new Map(manifest.map((u) => [u.name, u] as const));

  const resetNames = call.resetAll ? manifest.map((u) => u.name) : call.reset;
  for (const name of resetNames) {
    const u = byName.get(name);
    if (!u) {
      plan.unknown.push(name);
      continue;
    }
    targets.set(name, { to: u.default.slice(), reset: true, clamped: false });
  }
  for (const s of call.set) {
    const u = byName.get(s.name);
    if (!u) {
      plan.unknown.push(s.name);
      continue;
    }
    const w = Math.max(1, u.width);
    if (s.value.length === 0) {
      plan.invalid.push(`${s.name} (no numeric value)`);
      continue;
    }
    // A single number for a vector fills every component (a grey / uniform vec).
    const wanted = s.value.length === 1 && w > 1 ? Array.from({ length: w }, () => s.value[0]!) : s.value;
    if (wanted.length !== w) {
      plan.invalid.push(`${s.name} (needs ${w} components, got ${s.value.length})`);
      continue;
    }
    const to = clampUniformValue(u, wanted);
    targets.set(s.name, { to, reset: false, clamped: !sameValue(to, wanted) });
  }
  for (const u of manifest) {
    const t = targets.get(u.name);
    if (!t) continue;
    const from = (bySlot.get(u.slot) ?? u.default).slice();
    if (sameValue(from, t.to)) {
      plan.unchanged.push(u.name);
      continue;
    }
    plan.changes.push({ name: u.name, slot: u.slot, from, to: t.to, reset: t.reset, clamped: t.clamped });
  }
  return plan;
}

/** Where the change landed on the connected fixture. */
export type LiveDeviceSink =
  | "sent" // the fixture runs this effect: values sent on the live channel
  | "sent-maybe-stale" // sent, but the fixture may run an earlier build of this effect
  | "not-connected"
  | "other-effect" // the fixture runs a different effect: NOT sent (would mis-tune it)
  | "unknown-effect" // connected, running effect unknown: NOT sent
  | "demo"; // public playground: no fixture

/** The tool result text: what changed, where it was applied, and caveats. */
export function describeLiveUniformResult(
  plan: LiveUniformPlan,
  sinks: { preview: boolean; device: LiveDeviceSink; midiBound?: readonly LiveBinding[] },
): string {
  const out: string[] = [];
  if (plan.changes.length === 0) {
    out.push("set_live_uniforms: no live value changed.");
  } else {
    const list = plan.changes.map(
      (c) =>
        `${c.name} ${fmtVal(c.from)} → ${fmtVal(c.to)}${c.reset ? " (reset to source default)" : ""}${
          c.clamped ? " (clamped to its declared range)" : ""
        }`,
    );
    out.push(`set_live_uniforms: ${list.join("; ")}.`);
    out.push(sinks.preview ? "Applied to the live preview." : "The live preview is not running; the panel holds the values.");
    const device: Record<LiveDeviceSink, string> = {
      sent: "Sent to the connected fixture (it is running this effect).",
      "sent-maybe-stale":
        "Sent to the connected fixture, which runs this effect id — but possibly an earlier build; push the current compile if it looks wrong.",
      "not-connected": "No fixture is connected: NOT sent to any device (the values go with the next push).",
      "other-effect":
        "The connected fixture is running a DIFFERENT effect: NOT sent to it (push this effect first; the values go with the push).",
      "unknown-effect":
        "A fixture is connected but which effect it runs is unknown: NOT sent (push this effect to apply them there).",
      demo: "Playground: there is no fixture; preview only.",
    };
    out.push(device[sinks.device]);
    const mapped = new Map((sinks.midiBound ?? []).map((b) => [b.uniform, b.semantic] as const));
    const hit = plan.changes.filter((c) => mapped.has(c.name));
    if (hit.length > 0) {
      out.push(
        `Note: ${hit.map((c) => `${c.name} is MIDI-mapped to "${mapped.get(c.name)!}"`).join("; ")} — moving that control ` +
          "will override this value again. The mapping was left unchanged.",
      );
    }
  }
  if (plan.unchanged.length > 0) out.push(`Already at the requested value: ${plan.unchanged.join(", ")}.`);
  if (plan.unknown.length > 0) out.push(`Unknown uniforms (not in the current compile): ${plan.unknown.join(", ")}.`);
  if (plan.invalid.length > 0) out.push(`Rejected: ${plan.invalid.join("; ")}.`);
  out.push("Other uniforms and MIDI mappings were not touched.");
  return out.join("\n");
}

/** Decide the device sink for a live change (pure; the editor supplies state). */
export function liveDeviceSink(s: {
  demo: boolean;
  connected: boolean;
  runningEffectId: string | null;
  effectId: string;
  /** The device was last pushed exactly the current compile. */
  pushedCurrent: boolean;
}): LiveDeviceSink {
  if (s.demo) return "demo";
  if (!s.connected) return "not-connected";
  if (s.runningEffectId === null) return "unknown-effect";
  if (s.runningEffectId !== s.effectId) return "other-effect";
  return s.pushedCurrent ? "sent" : "sent-maybe-stale";
}
