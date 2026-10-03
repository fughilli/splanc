/**
 * The MIDI pane's ✨ Remap button (src/effects/editor/midi-panel.ts, FUG-51)
 * hands the whole mapping job to a multi-second AI chat turn. Before FUG-51 the
 * button gave no sign the agent was working or had finished; this suite pins the
 * feedback contract: idle → a disabled spinner + "Remapping…" for exactly as long
 * as the editor's turn runs (surviving the mid-turn re-renders the AI's own
 * mapping writes trigger) → a "✓ Mapped" completion flash → back to idle, and a
 * second remap started during the flash is not cut short by the first one's
 * pending reset. Driven through the real panel on the fake DOM with mocked
 * timers (no real waits).
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";

import { installFakeDom, asFake, textOf, type FakeElement } from "./fakeDom";

installFakeDom();

import { MidiMapPanel } from "../src/effects/editor/midi-panel";
import { midiStore } from "../src/store/midiStore";

/** A remap turn the test finishes by hand. */
function deferredTurn(): { onRemap: () => Promise<void>; finish: () => void; calls: () => number } {
  let n = 0;
  let resolve: (() => void) | null = null;
  return {
    onRemap: () => {
      n++;
      return new Promise<void>((r) => (resolve = r));
    },
    finish: () => resolve?.(),
    calls: () => n,
  };
}

/** Let the panel's awaited turn settle (promise continuations only, no timers). */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

let panel: MidiMapPanel | null = null;
const remapBtn = (): FakeElement => asFake(panel!.node.querySelector(".midimap-remap"));

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout"] });
  localStorage.clear();
});
afterEach(() => {
  panel?.dispose();
  panel?.node.remove();
  panel = null;
  mock.timers.reset();
});

test("Remap shows a busy spinner for the whole AI turn, then a completion flash, then idle [rr:PR-6]", async () => {
  const turn = deferredTurn();
  panel = new MidiMapPanel("fx-remap", { onRemap: turn.onRemap });
  document.body.appendChild(panel.node);

  assert.equal(textOf(remapBtn()), "✨ Remap");
  assert.equal(remapBtn().disabled, false);

  remapBtn().click();
  assert.equal(turn.calls(), 1);
  // Working: spinner + label, disabled, explained.
  const busy = remapBtn();
  assert.ok(busy.classList.contains("working"));
  assert.equal(busy.disabled, true);
  assert.equal(textOf(busy), "Remapping…");
  assert.ok(busy.querySelector(".midimap-remap-spinner"), "spinner shown");
  assert.match(String(busy.title), /AI is mapping/);

  // The AI applies its mappings mid-turn → the store change re-renders the pane;
  // the rebuilt button must still read as busy (state lives on the panel).
  midiStore.replaceBindings("fx-remap", [{ uniform: "speed", semantic: "speed" }]);
  assert.notEqual(remapBtn(), busy, "the pane re-rendered");
  assert.ok(remapBtn().classList.contains("working"));
  assert.equal(textOf(remapBtn()), "Remapping…");
  // Clicking while busy can't start a second turn.
  remapBtn().click();
  assert.equal(turn.calls(), 1);
  // Time alone never ends the busy state — only the turn finishing does.
  mock.timers.tick(60_000);
  assert.equal(textOf(remapBtn()), "Remapping…");

  turn.finish();
  await settle();
  const done = remapBtn();
  assert.ok(done.classList.contains("done"));
  assert.ok(!done.classList.contains("working"));
  assert.equal(done.disabled, false);
  assert.equal(textOf(done), "✓ Mapped");
  assert.match(String(done.title), /finished mapping/);

  // The completion flash holds briefly, then the button returns to idle.
  mock.timers.tick(1599);
  assert.equal(textOf(remapBtn()), "✓ Mapped");
  mock.timers.tick(1);
  assert.equal(textOf(remapBtn()), "✨ Remap");
  assert.ok(!remapBtn().classList.contains("done"));
});

test("a remap started during the completion flash keeps its busy state until it finishes [rr:PR-6]", async () => {
  const turn = deferredTurn();
  panel = new MidiMapPanel("fx-remap", { onRemap: turn.onRemap });
  document.body.appendChild(panel.node);

  remapBtn().click();
  turn.finish();
  await settle();
  assert.equal(textOf(remapBtn()), "✓ Mapped");

  // Re-run from the "✓ Mapped" flash before it resets.
  mock.timers.tick(1000);
  remapBtn().click();
  assert.equal(turn.calls(), 2);
  assert.equal(textOf(remapBtn()), "Remapping…");
  // The first run's pending reset (due at 1600 ms) must not flip the busy button.
  mock.timers.tick(2000);
  assert.equal(textOf(remapBtn()), "Remapping…");
  assert.equal(remapBtn().disabled, true);

  turn.finish();
  await settle();
  assert.equal(textOf(remapBtn()), "✓ Mapped");
  mock.timers.tick(1600);
  assert.equal(textOf(remapBtn()), "✨ Remap");
});
