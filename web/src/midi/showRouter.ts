/**
 * Show-Mode MIDI routing (FUG-110). The pure resolver maps a normalized MIDI
 * control event to a Show-Mode transport action, given the user's show
 * bindings. Kept pure + separate from the DOM so it unit-tests under Node (the
 * screen wires it to midiManager.onControl and dispatches the result).
 */

import type { MidiControlEvent, MidiControlId } from "./manager";
import { controlKey } from "./manager";

/** The fixed set of MIDI-mappable Show-Mode actions. `value` actions consume
 * the control's 0..1 position (a fader); `trigger` actions fire on a button
 * press (rising edge). */
export type ShowActionKind = "value" | "trigger";

export interface ShowAction {
  id: string;
  label: string;
  kind: ShowActionKind;
}

export const SHOW_ACTIONS: readonly ShowAction[] = [
  { id: "crossfade", label: "Crossfade A ↔ B", kind: "value" },
  { id: "crossfadeMode", label: "Toggle blend mode", kind: "trigger" },
  { id: "deckA.playPause", label: "Deck A play / pause", kind: "trigger" },
  { id: "deckB.playPause", label: "Deck B play / pause", kind: "trigger" },
  { id: "list.prev", label: "Effect list — previous", kind: "trigger" },
  { id: "list.next", label: "Effect list — next", kind: "trigger" },
  { id: "deckA.cue", label: "Cue selection → Deck A", kind: "trigger" },
  { id: "deckB.cue", label: "Cue selection → Deck B", kind: "trigger" },
];

/** The kind of a Show action id (defaults to `trigger` for an unknown id). */
export function showActionKind(id: string): ShowActionKind {
  return SHOW_ACTIONS.find((a) => a.id === id)?.kind ?? "trigger";
}

export interface ResolvedShowAction {
  action: string;
  /** Normalized 0..1 value from the control. */
  value: number;
}

/**
 * Resolve a control event to the Show action bound to that physical control, or
 * null if nothing is bound to it. Pure — the router hot path and the tests both
 * call this.
 */
export function resolveShowAction(
  event: MidiControlEvent,
  bindings: Record<string, MidiControlId>,
): ResolvedShowAction | null {
  const key = controlKey(event.control);
  for (const action of Object.keys(bindings)) {
    const bound = bindings[action];
    if (bound && controlKey(bound) === key) return { action, value: event.value };
  }
  return null;
}
