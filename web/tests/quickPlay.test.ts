/**
 * The out-of-box Effects tab helpers (src/effects/quickPlay.ts): library
 * sections, starter blurbs, user-only tag chips, the fixture card's copy and
 * action, readable uniform names. See docs/ux/oobe-review.md.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  STARTER_ORDER,
  effectSections,
  fixtureCard,
  friendlyUniformName,
  starterBlurb,
  userTags,
} from "../src/effects/quickPlay";
import { nowPlaying } from "../src/store/nowPlaying";

const fx = (id: string, name: string, tags: string[] = []) => ({ id, name, tags });

const LIB = [
  fx("builtin-color-test", "Color test (gradient)", ["starter", "test"]),
  fx("builtin-agentic-pulse", "Agentic chaser", ["starter", "topology"]),
  fx("builtin-rainbow-sweep", "Rainbow sweep", ["starter"]),
  fx("demo-tree", "Tree of Light", ["demo", "topology", "spatial"]),
  fx("u1", "Porch glow", ["porch", "warm"]),
  fx("u2", "Breathing pulse (copy)", ["starter"]),
];

test("starters lead a fresh library, in the curated order, tools last", () => {
  const fresh = LIB.filter((e) => !e.id.startsWith("u"));
  const s = effectSections(fresh);
  assert.deepEqual(
    s.map((x) => x.id),
    ["starters", "examples"],
  );
  assert.deepEqual(
    s[0]!.items.map((e) => e.id),
    ["builtin-rainbow-sweep", "builtin-agentic-pulse", "builtin-color-test"],
  );
});

test("the user's own effects come first once they have some; a copy of a starter is theirs", () => {
  const s = effectSections(LIB);
  assert.deepEqual(
    s.map((x) => x.id),
    ["mine", "starters", "examples"],
  );
  assert.deepEqual(
    s[0]!.items.map((e) => e.id),
    ["u1", "u2"],
  );
  assert.equal(s[2]!.title, "Examples for the sample maps");
});

test("every curated starter has a blurb; non-starters have none", () => {
  for (const id of STARTER_ORDER) assert.ok(starterBlurb(id), id);
  assert.equal(starterBlurb("u1"), null);
});

test("tag chips list only the user's own tags", () => {
  assert.deepEqual(userTags(LIB), ["porch", "starter", "warm"]);
  assert.deepEqual(userTags(LIB.slice(0, 4)), []);
});

test("fixture card: nothing known → connect", () => {
  const m = fixtureCard({ state: "offline", deviceName: null, playing: null });
  assert.equal(m.kind, "none");
  assert.equal(m.action?.label, "Connect a fixture");
});

test("fixture card: known but unreachable → explains a Wi-Fi move needs no reflash", () => {
  const m = fixtureCard({ state: "error", deviceName: "Tegani", playing: null });
  assert.equal(m.kind, "unreachable");
  assert.equal(m.title, "Can't reach Tegani");
  assert.match(m.body, /different Wi-Fi/);
  assert.match(m.body, /No need to flash/);
  assert.equal(m.action?.label, "Open devices");
});

test("fixture card: connecting has no action; connected names what's playing", () => {
  assert.equal(fixtureCard({ state: "connecting", deviceName: "Lamp", playing: null }).action, null);
  const c = fixtureCard({ state: "connected", deviceName: "Lamp", playing: "Rainbow sweep" });
  assert.equal(c.kind, "connected");
  assert.equal(c.title, "Lamp");
  assert.match(c.body, /Playing Rainbow sweep/);
  assert.equal(c.action, null);
  assert.match(fixtureCard({ state: "connected", deviceName: "", playing: null }).body, /Tap an effect/);
});

test("friendly uniform names", () => {
  assert.equal(friendlyUniformName("drift"), "Drift");
  assert.equal(friendlyUniformName("base_color"), "Base color");
  assert.equal(friendlyUniformName("glowWidth"), "Glow width");
  assert.equal(friendlyUniformName("_"), "_");
});

test("nowPlaying tracks per device and notifies on change only", () => {
  let n = 0;
  const off = nowPlaying.subscribe(() => n++);
  nowPlaying.set("dev-a", "fx1");
  nowPlaying.set("dev-a", "fx1");
  nowPlaying.set(null, "fx2");
  assert.equal(nowPlaying.get("dev-a"), "fx1");
  assert.equal(nowPlaying.get("dev-b"), null);
  nowPlaying.set("dev-a", null);
  assert.equal(nowPlaying.get("dev-a"), null);
  assert.equal(n, 2);
  off();
});
