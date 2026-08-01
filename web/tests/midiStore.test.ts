/**
 * MIDI store (src/store/midiStore.ts) round-trip logic under a localStorage
 * shim: naming a control, renaming (dedup by id), moving a name between
 * controls (names stay unique), removing a semantic (and its bindings), and
 * per-effect binding create/replace/clear. The store reads `localStorage`
 * lazily inside each call, so a global shim installed before use suffices.
 */

import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";

import { midiStore } from "../src/store/midiStore";
import { controlKey } from "../src/midi/manager";

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, String(v));
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
  clear(): void {
    this.m.clear();
  }
}
(globalThis as { localStorage?: unknown }).localStorage = new MemStorage();

const KNOB = { device: "Nano", kind: "cc", channel: 0, number: 74 } as const;
const FADER = { device: "Nano", kind: "cc", channel: 0, number: 7 } as const;

beforeEach(() => {
  (globalThis.localStorage as MemStorage).clear();
});

test("assignSemantic creates, then renames the same control (no dup)", () => {
  midiStore.assignSemantic(KNOB, "speed");
  midiStore.assignSemantic(KNOB, "Rate");
  const list = midiStore.semantics();
  assert.equal(list.length, 1);
  assert.equal(list[0]!.name, "Rate");
  assert.equal(list[0]!.id, controlKey(KNOB));
});

test("a name moves to the newest control that claims it", () => {
  midiStore.assignSemantic(KNOB, "speed");
  midiStore.assignSemantic(FADER, "speed");
  const list = midiStore.semantics();
  assert.equal(list.length, 1);
  assert.equal(list[0]!.id, controlKey(FADER));
  assert.ok(midiStore.semanticByName("SPEED"));
});

test("removeSemantic drops the control and its bindings", () => {
  midiStore.assignSemantic(KNOB, "speed");
  midiStore.setBinding("eff1", { uniform: "speed", semantic: "speed" });
  midiStore.setBinding("eff1", { uniform: "width", semantic: "other" });
  midiStore.removeSemantic(controlKey(KNOB));
  assert.equal(midiStore.semantics().length, 0);
  const b = midiStore.bindings("eff1");
  assert.equal(b.length, 1);
  assert.equal(b[0]!.uniform, "width");
});

test("setBinding replaces the same uniform; clearBinding removes it", () => {
  midiStore.setBinding("eff1", { uniform: "speed", semantic: "a" });
  midiStore.setBinding("eff1", { uniform: "speed", semantic: "b", min: 1, max: 2 });
  const b = midiStore.bindings("eff1");
  assert.equal(b.length, 1);
  assert.equal(b[0]!.semantic, "b");
  assert.equal(b[0]!.min, 1);
  midiStore.clearBinding("eff1", "speed");
  assert.equal(midiStore.bindings("eff1").length, 0);
});

test("replaceBindings overwrites the whole effect table", () => {
  midiStore.setBinding("eff1", { uniform: "x", semantic: "a" });
  midiStore.replaceBindings("eff1", [
    { uniform: "speed", semantic: "speed" },
    { uniform: "width", semantic: "width" },
  ]);
  const b = midiStore.bindings("eff1");
  assert.equal(b.length, 2);
  assert.deepEqual(
    b.map((x) => x.uniform).sort(),
    ["speed", "width"],
  );
});

test("bindingFor finds a specific uniform's binding", () => {
  midiStore.setBinding("eff1", { uniform: "speed", semantic: "speed" });
  assert.equal(midiStore.bindingFor("eff1", "speed")?.semantic, "speed");
  assert.equal(midiStore.bindingFor("eff1", "nope"), undefined);
});
