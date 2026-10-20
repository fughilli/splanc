/**
 * Uniform keypoints, app side (src/effects/keypoints.ts): feature detection, the
 * morph fader's weights, keypoint stepping, name validation and the fader-rate
 * throttle (never drops the final value).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  Throttle,
  defaultKeypointName,
  morphWeights,
  stepKeypoint,
  supportsDecks,
  supportsKeypoints,
  validKeypointName,
} from "../src/effects/keypoints";
import { SHOW_ACTIONS, showActionKind } from "../src/midi/showRouter";

const KP = [
  { index: 3, name: "storm", stale: false },
  { index: 0, name: "calm", stale: false },
  { index: 1, name: "dawn", stale: true },
];

test("feature detection reads welcome.features", () => {
  assert.equal(supportsKeypoints({ features: ["effects", "keypoints"] }), true);
  assert.equal(supportsKeypoints({ features: ["effects"] }), false);
  assert.equal(supportsKeypoints(null), false);
  assert.equal(supportsDecks({ features: ["decks", "crossfade"] }), true);
  assert.equal(supportsDecks({ features: ["decks"] }), false);
});

test("morphWeights: endpoints are exact recalls, the middle is a two-way blend", () => {
  assert.deepEqual(morphWeights(0, "a", "b"), [{ name: "a", weight: 1 }]);
  assert.deepEqual(morphWeights(1, "a", "b"), [{ name: "b", weight: 1 }]);
  assert.deepEqual(morphWeights(-3, "a", "b"), [{ name: "a", weight: 1 }]);
  assert.deepEqual(morphWeights(0.25, "a", "b"), [
    { name: "a", weight: 0.75 },
    { name: "b", weight: 0.25 },
  ]);
  assert.deepEqual(morphWeights(0.5, "a", "a"), [{ name: "a", weight: 1 }]);
  assert.deepEqual(morphWeights(Number.NaN, "a", "b"), [{ name: "a", weight: 1 }]);
});

test("stepKeypoint walks storage order and wraps", () => {
  assert.equal(stepKeypoint(KP, null, 1), "calm");
  assert.equal(stepKeypoint(KP, "calm", 1), "dawn");
  assert.equal(stepKeypoint(KP, "storm", 1), "calm");
  assert.equal(stepKeypoint(KP, "calm", -1), "storm");
  assert.equal(stepKeypoint([], "calm", 1), null);
});

test("names: trimmed, 1..32 bytes; defaults skip taken ones", () => {
  assert.equal(validKeypointName("  dusk "), "dusk");
  assert.equal(validKeypointName("   "), null);
  assert.equal(validKeypointName("x".repeat(32)), "x".repeat(32));
  assert.equal(validKeypointName("x".repeat(33)), null);
  assert.equal(validKeypointName("é".repeat(17)), null); // 34 bytes
  assert.equal(defaultKeypointName([]), "Look 1");
  assert.equal(
    defaultKeypointName([
      { index: 0, name: "Look 1", stale: false },
      { index: 1, name: "Look 3", stale: false },
    ]),
    "Look 2",
  );
});

test("Throttle sends the first value at once and always the last one", () => {
  const sent: number[] = [];
  const timers: (() => void)[] = [];
  const t = new Throttle<number>((v) => sent.push(v), 40, (fn) => timers.push(fn));
  t.push(1);
  t.push(2);
  t.push(3);
  assert.deepEqual(sent, [1]);
  timers.shift()!(); // window closes: the pending (latest) value goes out
  assert.deepEqual(sent, [1, 3]);
  timers.shift()!(); // nothing pending: the next push is immediate again
  t.push(4);
  assert.deepEqual(sent, [1, 3, 4]);
});

test("Show Mode maps the keypoint morph faders + step/save triggers", () => {
  const ids = new Set(SHOW_ACTIONS.map((a) => a.id));
  for (const id of ["deckA.morph", "deckB.morph", "deckA.kpNext", "deckB.kpPrev", "deckA.kpSave"]) {
    assert.ok(ids.has(id), `missing ${id}`);
  }
  assert.equal(showActionKind("deckA.morph"), "value");
  assert.equal(showActionKind("deckB.kpNext"), "trigger");
});
