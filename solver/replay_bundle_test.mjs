/**
 * The capture-bundle replay is bit-for-bit through the wasm solver: record a
 * bundle from a fixed synthetic problem the way the app builds one (interim
 * solves on prefixes, the best one's state as the final's warm start), take
 * it through JSON text like an exported file, and replay it.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { identicalMaps, loadSolver, recordBundle, replayBundle } from "./replay_bundle_lib.mjs";

const solver = await loadSolver();
const problem = JSON.parse(readFileSync(new URL("./testdata/synth_coil_small.json", import.meta.url), "utf8"));
const n = problem.detections.length;

test("a recorded bundle replays bit-for-bit", () => {
  const bundle = JSON.parse(JSON.stringify(recordBundle(solver, problem, [Math.floor(n / 2), n])));
  assert.equal(bundle.interims.filter((i) => i.best).length, 1);
  assert.ok(bundle.problem.options.warmStart, "final warm-started from the best interim");
  const cases = replayBundle(solver, bundle);
  assert.equal(cases.length, 3);
  for (const c of cases) {
    assert.equal(c.error, null, `${c.label}: ${c.error}`);
    assert.equal(c.identical, true, `${c.label} differs by ${c.maxLedDeltaM} m`);
  }
  const final = cases.at(-1);
  assert.equal(final.assessment.degenerate, false, final.assessment.reasons.join());
});

test("an interim that failed on the phone fails identically on replay", () => {
  // 50 records is under the solver's 8-frame minimum.
  const bundle = JSON.parse(JSON.stringify(recordBundle(solver, problem, [50, n])));
  assert.match(bundle.interims[0].error, /too few observation frames/);
  const cases = replayBundle(solver, bundle, { interims: true });
  assert.equal(cases[0].identical, true);
});

test("--cold drops the warm start; the solve is deterministic run to run", () => {
  const bundle = recordBundle(solver, problem, [n]);
  const [a] = replayBundle(solver, bundle, { interims: false, cold: true });
  const [b] = replayBundle(solver, bundle, { interims: false, cold: true });
  assert.equal(a.label, "final (cold only)");
  assert.equal(a.start, "cold");
  assert.deepEqual(a, b);
  const r1 = solver.solve(bundle.problem);
  const r2 = solver.solve(JSON.parse(JSON.stringify(bundle.problem)));
  assert.ok(identicalMaps(r1.map, r2.map));
});
