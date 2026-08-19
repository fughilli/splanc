/**
 * Interactive-tutorial state (src/ui/guide/tourStore.ts) — the pure, DOM-free
 * contract: (de)serialization is tolerant of legacy/garbage blobs, the
 * first-run hint shows only when neither dismissed nor already seen, and the
 * catalog is well-formed enough that both consumers (the tour + the doc
 * generator) can rely on it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_TOUR_STATE,
  deserializeTourState,
  serializeTourState,
  shouldShowHint,
} from "../src/ui/guide/tourStore";
import {
  GUIDE_TOPICS,
  GUIDE_TAB_ORDER,
  GUIDE_TAB_LABELS,
  type GuideTab,
} from "../src/ui/guide/catalog";

test("deserialize tolerates null / garbage / partial blobs", () => {
  assert.deepEqual(deserializeTourState(null), DEFAULT_TOUR_STATE);
  assert.deepEqual(deserializeTourState("not json"), DEFAULT_TOUR_STATE);
  assert.deepEqual(deserializeTourState("[1,2,3]"), DEFAULT_TOUR_STATE);
  // Partial object fills in defaults and coerces types.
  const s = deserializeTourState(JSON.stringify({ dismissed: 1, completed: ["a", 2, "b"] }));
  assert.equal(s.dismissed, true);
  assert.equal(s.hintSeen, false);
  assert.deepEqual(s.completed, ["a", "b"]);
});

test("serialize/deserialize round-trips", () => {
  const s = { dismissed: true, hintSeen: false, completed: ["welcome"] };
  assert.deepEqual(deserializeTourState(serializeTourState(s)), s);
});

test("first-run hint shows only when neither dismissed nor seen", () => {
  assert.equal(shouldShowHint({ dismissed: false, hintSeen: false, completed: [] }), true);
  assert.equal(shouldShowHint({ dismissed: false, hintSeen: true, completed: [] }), false);
  assert.equal(shouldShowHint({ dismissed: true, hintSeen: false, completed: [] }), false);
  assert.equal(shouldShowHint({ dismissed: true, hintSeen: true, completed: [] }), false);
});

test("catalog is well-formed: unique ids, known tabs, non-empty content", () => {
  const ids = new Set<string>();
  for (const t of GUIDE_TOPICS) {
    assert.ok(t.id && !ids.has(t.id), `duplicate/empty topic id: ${t.id}`);
    ids.add(t.id);
    assert.ok(t.title.length > 0, `topic ${t.id} has no title`);
    assert.ok(t.summary.length > 0, `topic ${t.id} has no summary`);
    assert.ok((GUIDE_TAB_ORDER as GuideTab[]).includes(t.tab), `topic ${t.id} unknown tab ${t.tab}`);
    assert.ok(t.sections.length > 0, `topic ${t.id} has no sections`);
    for (const sec of t.sections) {
      const hasBody = (sec.body ?? []).length > 0;
      const hasBullets = (sec.bullets ?? []).length > 0;
      assert.ok(hasBody || hasBullets, `topic ${t.id} has an empty section`);
    }
    // Any interactive step must carry copy.
    for (const step of t.steps ?? []) {
      assert.ok(step.title.length > 0 && step.body.length > 0, `topic ${t.id} has an empty step`);
    }
  }
});

test("every tab in the order has a human label and at least one topic exists", () => {
  for (const tab of GUIDE_TAB_ORDER) {
    assert.ok(GUIDE_TAB_LABELS[tab], `no label for tab ${tab}`);
  }
  assert.ok(GUIDE_TOPICS.length >= GUIDE_TAB_ORDER.length, "expected topics across the tabs");
});
