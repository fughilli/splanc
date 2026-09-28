/**
 * MIDI mapping store (FUG-9) — the configuration layer that lives OUTSIDE the
 * effect code. localStorage-backed and observable (mirrors store/appearance.ts).
 *
 * Two decoupled layers, matching the issue:
 *
 *  1. Semantic controls (GLOBAL): a physical MIDI control given a human name,
 *     e.g. "speed". Captured once via the learn/wiggle flow; reused across every
 *     effect. This is what makes "annotate a knob as speed such that all effects
 *     which want a speed uniform can map to it" work.
 *
 *  2. Uniform bindings (PER EFFECT): for a given effect, which uniform is driven
 *     by which semantic control (with an optional sub-range / invert). Keyed by
 *     effectId and by uniform NAME (stable across recompiles — never the slot).
 *     The effect source is never touched.
 *
 * The pure normalize/scale helpers are exported for unit tests; the live store
 * only touches localStorage behind typeof guards so it runs under Node.
 */

import type { MidiControlId } from "../midi/manager";
import { controlKey } from "../midi/manager";

/** A physical MIDI control given a semantic name (global, effect-independent). */
export interface SemanticControl {
  /** Stable id (== controlKey of the physical control). */
  id: string;
  /** User-facing semantic name, e.g. "speed". Case preserved; matched loosely. */
  name: string;
  control: MidiControlId;
}

/** A per-effect binding: `uniform` (by name) is driven by `semantic` (by name).
 * `min`/`max` optionally override the uniform's declared range (so a knob can
 * sweep a sub-range); `invert` flips the direction. */
export interface UniformBinding {
  uniform: string;
  semantic: string;
  min?: number;
  max?: number;
  invert?: boolean;
}

interface MidiConfig {
  semantics: SemanticControl[];
  /** effectId -> bindings. */
  bindings: Record<string, UniformBinding[]>;
  /** Show-Mode action id -> the physical control bound to it (FUG-110). Unlike
   * uniform bindings these map straight to a fixed set of transport actions
   * (crossfade, play/pause, cue, list navigation) rather than to a semantic. */
  showBindings: Record<string, MidiControlId>;
}

const STORAGE_KEY = "ledmapper.midi";

function emptyConfig(): MidiConfig {
  return { semantics: [], bindings: {}, showBindings: {} };
}

function read(): MidiConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyConfig();
    const parsed = JSON.parse(raw) as Partial<MidiConfig>;
    return {
      semantics: Array.isArray(parsed.semantics) ? parsed.semantics : [],
      bindings: parsed.bindings && typeof parsed.bindings === "object" ? parsed.bindings : {},
      showBindings:
        parsed.showBindings && typeof parsed.showBindings === "object" ? parsed.showBindings : {},
    };
  } catch {
    return emptyConfig();
  }
}

function write(cfg: MidiConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  } catch {
    // storage unavailable (private mode / quota) — non-fatal
  }
}

/** Loose match for auto-binding: collapse case and non-alphanumerics so
 * "Speed", "speed", "SPEED_1" all compare on their core token. */
export function normName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Map a normalized 0..1 MIDI value into a uniform's range. `uMin`/`uMax` are the
 * uniform's declared range; a binding may narrow it via `min`/`max` and flip it
 * via `invert`. Pure — the router's hot path and the tests both call this.
 */
export function scaleToRange(
  value01: number,
  uMin: number,
  uMax: number,
  binding?: Pick<UniformBinding, "min" | "max" | "invert">,
): number {
  const lo = binding?.min ?? uMin;
  const hi = binding?.max ?? uMax;
  const t = binding?.invert ? 1 - value01 : value01;
  const v = lo + (hi - lo) * clamp01(t);
  // Guard against an inverted [lo,hi] so the result still lands within bounds.
  return clampRange(v, lo, hi);
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
function clampRange(x: number, a: number, b: number): number {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return x < lo ? lo : x > hi ? hi : x;
}

type Listener = () => void;

class MidiStore {
  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  // -- semantic controls (global) -----------------------------------------

  semantics(): SemanticControl[] {
    return read().semantics;
  }

  /** Look up a semantic control by (loose) name. */
  semanticByName(name: string): SemanticControl | undefined {
    const want = normName(name);
    return this.semantics().find((s) => normName(s.name) === want);
  }

  /**
   * Name a physical control (create or rename). Keyed by the control's stable
   * id, so re-learning the same knob updates its name rather than duplicating.
   * A name already used by ANOTHER control is moved to this one (names are the
   * user's addressing scheme, so they stay unique).
   */
  assignSemantic(control: MidiControlId, name: string): void {
    const trimmed = name.trim();
    if (!trimmed) return;
    const cfg = read();
    const id = controlKey(control);
    const want = normName(trimmed);
    // Drop any other control currently holding this name.
    cfg.semantics = cfg.semantics.filter((s) => s.id === id || normName(s.name) !== want);
    const existing = cfg.semantics.find((s) => s.id === id);
    if (existing) {
      existing.name = trimmed;
      existing.control = control;
    } else {
      cfg.semantics.push({ id, name: trimmed, control });
    }
    write(cfg);
    this.emit();
  }

  removeSemantic(id: string): void {
    const cfg = read();
    const gone = cfg.semantics.find((s) => s.id === id);
    cfg.semantics = cfg.semantics.filter((s) => s.id !== id);
    // Drop bindings that referenced the removed semantic name.
    if (gone) {
      const want = normName(gone.name);
      for (const eff of Object.keys(cfg.bindings)) {
        cfg.bindings[eff] = cfg.bindings[eff]!.filter((b) => normName(b.semantic) !== want);
      }
    }
    write(cfg);
    this.emit();
  }

  // -- per-effect uniform bindings ----------------------------------------

  bindings(effectId: string): UniformBinding[] {
    return read().bindings[effectId] ?? [];
  }

  /** The binding for one uniform in an effect, if any. */
  bindingFor(effectId: string, uniform: string): UniformBinding | undefined {
    return this.bindings(effectId).find((b) => b.uniform === uniform);
  }

  /** Create or replace the binding for a uniform (by name). */
  setBinding(effectId: string, binding: UniformBinding): void {
    const cfg = read();
    const list = (cfg.bindings[effectId] ?? []).filter((b) => b.uniform !== binding.uniform);
    list.push(binding);
    cfg.bindings[effectId] = list;
    write(cfg);
    this.emit();
  }

  /** Remove a uniform's binding in an effect. */
  clearBinding(effectId: string, uniform: string): void {
    const cfg = read();
    const list = cfg.bindings[effectId];
    if (!list) return;
    cfg.bindings[effectId] = list.filter((b) => b.uniform !== uniform);
    write(cfg);
    this.emit();
  }

  /** Replace ALL bindings for an effect at once (used by the AI remap tool). */
  replaceBindings(effectId: string, bindings: UniformBinding[]): void {
    const cfg = read();
    cfg.bindings[effectId] = bindings.slice();
    write(cfg);
    this.emit();
  }

  // -- Show-Mode action bindings (FUG-110) --------------------------------

  /** All Show-Mode action bindings (action id -> physical control). */
  showBindings(): Record<string, MidiControlId> {
    return read().showBindings;
  }

  /** The control bound to a Show-Mode action, if any. */
  showBindingFor(action: string): MidiControlId | undefined {
    return read().showBindings[action];
  }

  /** The Show-Mode action a physical control drives (reverse lookup by key),
   * so the router can dispatch a live event. */
  showActionForControl(key: string): string | undefined {
    const b = read().showBindings;
    for (const action of Object.keys(b)) {
      if (controlKey(b[action]!) === key) return action;
    }
    return undefined;
  }

  /** Bind a physical control to a Show-Mode action. A control already bound to
   * another action is moved (one control drives one action). */
  setShowBinding(action: string, control: MidiControlId): void {
    const cfg = read();
    const key = controlKey(control);
    for (const a of Object.keys(cfg.showBindings)) {
      if (controlKey(cfg.showBindings[a]!) === key) delete cfg.showBindings[a];
    }
    cfg.showBindings[action] = control;
    write(cfg);
    this.emit();
  }

  /** Remove a Show-Mode action binding. */
  clearShowBinding(action: string): void {
    const cfg = read();
    if (action in cfg.showBindings) {
      delete cfg.showBindings[action];
      write(cfg);
      this.emit();
    }
  }

  /**
   * Zero-click binding: for each uniform with NO existing binding whose name
   * matches (loosely) a named control, create a binding to it. This is the
   * "name a knob 'speed' and every effect with a speed uniform maps to it"
   * behaviour. Only fills gaps — it never overrides a user/AI binding. Returns
   * the number of bindings created (0 = nothing to do, no emit).
   */
  autoBind(effectId: string, uniformNames: string[]): number {
    const cfg = read();
    const list = cfg.bindings[effectId] ?? [];
    const bound = new Set(list.map((b) => b.uniform));
    let added = 0;
    for (const uniform of uniformNames) {
      if (bound.has(uniform)) continue;
      const sem = cfg.semantics.find((s) => normName(s.name) === normName(uniform));
      if (!sem) continue;
      list.push({ uniform, semantic: sem.name });
      bound.add(uniform);
      added++;
    }
    if (added === 0) return 0;
    cfg.bindings[effectId] = list;
    write(cfg);
    this.emit();
    return added;
  }
}

export const midiStore = new MidiStore();
