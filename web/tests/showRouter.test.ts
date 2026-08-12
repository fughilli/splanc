/**
 * Show-Mode MIDI routing (src/midi/showRouter.ts) — the pure resolver that maps
 * a control event to the bound transport action, plus the action-kind lookup
 * that decides fader-vs-button handling.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SHOW_ACTIONS,
  resolveShowAction,
  showActionKind,
} from "../src/midi/showRouter";
import { controlKey, type MidiControlEvent, type MidiControlId } from "../src/midi/manager";

const FADER: MidiControlId = { device: "Nano", kind: "cc", channel: 0, number: 7 };
const BUTTON: MidiControlId = { device: "Nano", kind: "note", channel: 0, number: 36 };

function ev(control: MidiControlId, value: number): MidiControlEvent {
  return { control, value, raw: Math.round(value * 127) };
}

test("resolveShowAction returns the bound action + value, or null", () => {
  const bindings = {
    crossfade: FADER,
    "deckA.playPause": BUTTON,
  };
  const r = resolveShowAction(ev(FADER, 0.42), bindings);
  assert.deepEqual(r, { action: "crossfade", value: 0.42 });

  const r2 = resolveShowAction(ev(BUTTON, 1), bindings);
  assert.deepEqual(r2, { action: "deckA.playPause", value: 1 });

  // An unbound control resolves to nothing.
  const other: MidiControlId = { device: "Nano", kind: "cc", channel: 0, number: 99 };
  assert.equal(resolveShowAction(ev(other, 0.5), bindings), null);
});

test("resolveShowAction matches on the stable control key, not identity", () => {
  const bindings = { crossfade: FADER };
  // A fresh object with the same key must still resolve.
  const clone = { ...FADER };
  assert.equal(controlKey(clone), controlKey(FADER));
  assert.deepEqual(resolveShowAction(ev(clone, 0.1), bindings), {
    action: "crossfade",
    value: 0.1,
  });
});

test("crossfade is a value action; the rest are triggers", () => {
  assert.equal(showActionKind("crossfade"), "value");
  assert.equal(showActionKind("deckA.playPause"), "trigger");
  assert.equal(showActionKind("list.next"), "trigger");
  // Unknown ids default to trigger (safer than a phantom fader).
  assert.equal(showActionKind("nope"), "trigger");
});

test("SHOW_ACTIONS covers the transport surface the issue calls for", () => {
  const ids = new Set(SHOW_ACTIONS.map((a) => a.id));
  for (const id of [
    "crossfade",
    "crossfadeMode",
    "deckA.playPause",
    "deckB.playPause",
    "list.prev",
    "list.next",
    "deckA.cue",
    "deckB.cue",
  ]) {
    assert.ok(ids.has(id), `missing show action ${id}`);
  }
});
