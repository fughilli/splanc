/**
 * The device's effect store, app side (docs/design/effect-store.md; firmware
 * feature "effect_store"): normalizing the stored_effect_list reply, the
 * one-line descriptions the device sheet shows, and turning the manifest the
 * device reports for a loaded effect into the uniform panel's controls.
 */

import type { FxUniform } from "../fx/preview";
import type { StoredEffectListMessage } from "./proto";

/** One stored effect, every field present. */
export interface StoredEffectEntry {
  effectId: string;
  name: string;
  fxbBytes: number;
  uniforms: string[];
  decks: number[];
}

export interface StoredEffects {
  effects: StoredEffectEntry[];
  capacity: number;
}

/** Whether the device keeps an effect store. */
export function deviceHasEffectStore(w: { features?: string[] } | null | undefined): boolean {
  return (w?.features ?? []).includes("effect_store");
}

/** The reply with proto3's omitted defaults filled in, sorted by display name. */
export function normalizeStoredEffects(m: Partial<StoredEffectListMessage> | null | undefined): StoredEffects {
  const effects = (m?.effects ?? []).map((e) => ({
    effectId: e.effectId ?? "",
    name: e.name ?? "",
    fxbBytes: e.fxbBytes ?? 0,
    uniforms: [...(e.uniforms ?? [])],
    decks: [...(e.decks ?? [])],
  }));
  effects.sort((a, b) => displayName(a).localeCompare(displayName(b)));
  return { effects, capacity: m?.capacity ?? 0 };
}

/** What to call a stored effect: its name, else its id. */
export function displayName(e: Pick<StoredEffectEntry, "name" | "effectId">): string {
  return e.name.trim() || e.effectId;
}

/** "2.1 KB · speed, tint · playing" style detail line. */
export function storedEffectDetail(e: StoredEffectEntry): string {
  const parts = [e.fxbBytes >= 1024 ? `${(e.fxbBytes / 1024).toFixed(1)} KB` : `${e.fxbBytes} B`];
  if (e.uniforms.length > 0) parts.push(e.uniforms.join(", "));
  if (e.decks.includes(0)) parts.push("on deck A");
  if (e.decks.includes(1)) parts.push("on deck B");
  return parts.join(" · ");
}

/** "3 of 8 stored". */
export function storeUsage(s: StoredEffects): string {
  return `${s.effects.length} of ${s.capacity} stored`;
}

/** The uniform panel's controls for a loaded effect, from the manifest bytes
 * get_effect_uniforms reports (the compiler's uniform JSON). Malformed or empty:
 * no controls. */
export function uniformsFromManifest(manifest: Uint8Array | string | undefined): FxUniform[] {
  if (manifest === undefined || manifest.length === 0) return [];
  try {
    const text = typeof manifest === "string" ? manifest : new TextDecoder().decode(manifest);
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (u): u is FxUniform =>
        u !== null && typeof u === "object" && typeof (u as FxUniform).name === "string" &&
        typeof (u as FxUniform).slot === "number",
    );
  } catch {
    return [];
  }
}

/** Why a store call failed, in words (the device's error codes). */
export function storeErrorText(e: unknown): string {
  const code = (e as { code?: string } | null)?.code;
  if (code === "store_full") return "the device's effect store is full — delete one first";
  if (code === "not_found") return "that effect isn't stored on the device any more";
  if (code === "no_store") return "the device's effect store is unavailable";
  if (code === "effect_too_large") return "the effect is too large for this device";
  if (code === "bad_fxb") return "the device rejected the effect";
  if (code === "kiosk_locked") return "the device is locked — unlock it first";
  return e instanceof Error ? e.message : String(e);
}
