/**
 * MIDI → uniform routing (FUG-9). The layer that turns a hardware control event
 * into live uniform updates, resolving three independent tables at event time:
 *
 *   physical control ──(semantic layer)──▶ semantic name
 *   semantic name    ──(binding layer)───▶ uniform name (per effect)
 *   uniform name     ──(manifest)────────▶ slot + declared range
 *
 * {@link resolveControlUpdates} is the pure, tested core — given an event and
 * the three tables it returns the uniform writes to apply. {@link MidiRouter} is
 * the thin stateful wrapper the editor uses: it subscribes to the shared
 * {@link midiManager} + {@link midiStore}, tracks the current effect + manifest,
 * and calls back with `(name, slot, value[])` so the editor can move the panel
 * slider AND push to preview + device — the SAME seam a manual drag uses.
 *
 * Only scalar-ish uniforms are driven (slider float/int, toggle). Colors/vectors
 * (width > 1) are skipped: a single CC can't meaningfully address a vec3, and
 * the design keeps MIDI to one-knob-one-value.
 */

import type { FxUniform } from "../fx/preview";
import type { MidiControlEvent } from "./manager";
import { midiManager, controlKey } from "./manager";
import type { SemanticControl, UniformBinding } from "../store/midiStore";
import { midiStore, normName, scaleToRange } from "../store/midiStore";

/** A resolved uniform write produced from a control event. */
export interface UniformUpdate {
  uniform: string;
  slot: number;
  value: number[];
}

/** The declared range of a uniform's slider (or [0,1] for toggles/others). */
function uniformRange(u: FxUniform): { min: number; max: number } {
  if (u.ui.kind === "slider") return { min: u.ui.min, max: u.ui.max };
  return { min: 0, max: 1 };
}

/** A uniform is MIDI-drivable if it's a single scalar (slider or toggle). */
export function isDrivable(u: FxUniform): boolean {
  return u.width === 1 && (u.ui.kind === "slider" || u.ui.kind === "toggle");
}

/**
 * Pure resolution: given a control event and the current tables, compute every
 * uniform write it triggers. A control with no semantic name, or a semantic with
 * no binding in this effect, or a binding whose uniform isn't in the manifest,
 * yields nothing.
 */
export function resolveControlUpdates(
  event: MidiControlEvent,
  manifest: FxUniform[],
  semantics: SemanticControl[],
  bindings: UniformBinding[],
): UniformUpdate[] {
  const id = controlKey(event.control);
  const semantic = semantics.find((s) => s.id === id);
  if (!semantic) return [];
  const want = normName(semantic.name);

  const out: UniformUpdate[] = [];
  for (const b of bindings) {
    if (normName(b.semantic) !== want) continue;
    const u = manifest.find((m) => m.name === b.uniform);
    if (!u || !isDrivable(u)) continue;
    if (u.ui.kind === "toggle") {
      out.push({ uniform: u.name, slot: u.slot, value: [event.value >= 0.5 ? 1 : 0] });
      continue;
    }
    const { min, max } = uniformRange(u);
    let v = scaleToRange(event.value, min, max, b);
    if (u.ui.kind === "slider" && u.ui.step > 0) {
      // Snap to the slider's step grid so int/quantized uniforms land cleanly.
      v = min + Math.round((v - min) / u.ui.step) * u.ui.step;
      v = Math.min(Math.max(v, Math.min(min, max)), Math.max(min, max));
    }
    out.push({ uniform: u.name, slot: u.slot, value: [v] });
  }
  return out;
}

/** Callback fired for each resolved uniform write. */
type UpdateSink = (update: UniformUpdate) => void;

/**
 * Live router bound to the shared manager + store. Create one per editor, call
 * {@link setEffect} + {@link setManifest} as the effect compiles, and
 * {@link attach} to start listening. {@link detach} tears down subscriptions.
 */
export class MidiRouter {
  private effectId = "";
  private manifest: FxUniform[] = [];
  private unsubControl: (() => void) | null = null;

  constructor(private readonly sink: UpdateSink) {}

  setEffect(effectId: string): void {
    this.effectId = effectId;
  }

  setManifest(manifest: FxUniform[]): void {
    this.manifest = manifest;
  }

  /** Start listening to hardware control events. Idempotent. */
  attach(): void {
    if (this.unsubControl !== null) return;
    this.unsubControl = midiManager.onControl((e) => this.onControl(e));
  }

  detach(): void {
    this.unsubControl?.();
    this.unsubControl = null;
  }

  private onControl(event: MidiControlEvent): void {
    if (this.manifest.length === 0 || !this.effectId) return;
    const updates = resolveControlUpdates(
      event,
      this.manifest,
      midiStore.semantics(),
      midiStore.bindings(this.effectId),
    );
    for (const u of updates) this.sink(u);
  }
}
