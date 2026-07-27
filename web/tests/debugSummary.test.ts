/**
 * Topology-diagnostics summary/format helpers (src/topology/debugSummary.ts):
 * the terse one-line summary + metric length labels the Debug section renders.
 * Pure + DOM-free, so it runs under node:test.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { TopologyDebug } from "../src/topology/extract";
import { countChords, fmtLen, summarizeTopologyDebug } from "../src/topology/debugSummary";

const mk = (
  coincident: TopologyDebug["coincident"],
  edges: TopologyDebug["edges"],
  spacing: number,
): TopologyDebug => ({ coincident, edges, spacing });

test("fmtLen picks mm / cm / m by magnitude", () => {
  assert.equal(fmtLen(0.004), "4mm");
  assert.equal(fmtLen(0.041), "4.1cm");
  assert.equal(fmtLen(0.5), "50cm");
  assert.equal(fmtLen(2.3), "2.3m");
});

test("countChords only counts chord edges", () => {
  const d = mk(
    [],
    [
      { a: [0, 0, 0], b: [1, 0, 0], d: 1, chord: false },
      { a: [0, 0, 0], b: [0, 1, 0], d: 1, chord: true },
      { a: [0, 0, 0], b: [0, 0, 1], d: 1, chord: true },
    ],
    0.04,
  );
  assert.equal(countChords(d), 2);
});

test("summary reads plural counts + spacing, with a ⚠ prefix when coincident", () => {
  const d = mk(
    [
      { a: [0, 0, 0], b: [0, 0, 0], dist: 0 },
      { a: [1, 0, 0], b: [1, 0, 0], dist: 0.001 },
      { a: [2, 0, 0], b: [2, 0, 0], dist: 0.002 },
    ],
    [
      { a: [0, 0, 0], b: [0, 1, 0], d: 1, chord: true },
      { a: [0, 0, 0], b: [0, 0, 1], d: 1, chord: true },
    ],
    0.041,
  );
  assert.equal(summarizeTopologyDebug(d), "⚠ 3 coincident pairs · 2 loop-chords · spacing 4.1cm");
});

test("summary is singular + has no warning prefix when clean", () => {
  const d = mk([], [{ a: [0, 0, 0], b: [0, 1, 0], d: 1, chord: true }], 0.04);
  assert.equal(summarizeTopologyDebug(d), "0 coincident pairs · 1 loop-chord · spacing 4.0cm");
  const one = mk([{ a: [0, 0, 0], b: [0, 0, 0], dist: 0 }], [], 0.04);
  assert.equal(summarizeTopologyDebug(one), "⚠ 1 coincident pair · 0 loop-chords · spacing 4.0cm");
});
