/**
 * The 2000-LED wall profile harness (tests/wallPerf.ts), small: a 300-LED wall
 * through the production pipeline under the staggered pilot and v1, checked for
 * decode accuracy (the speed work must not change what decodes) and printing
 * per-stage ms/frame. The full 400/1000/2000 comparison, and the phone-like
 * CPU-throttled browser run (tests/wallPerf_browser.mjs), are run by hand:
 * /workspace/.claude/phase2/perf2000.md and the PR body have the tables.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { formatWallPerf, runWallPerf } from "./wallPerf";

for (const sync of ["stagger_pilot", "on_off"]) {
  test(`wall perf harness: 300 LEDs, ${sync}`, () => {
    const r = runWallPerf({ ledCount: 300, durationMs: 12_000, sync, seed: 5 });
    console.log(formatWallPerf(r));
    assert.ok(r.coverage >= 0.98, `coverage ${r.coverage}`);
    assert.ok(r.wrongPct <= 1, `wrong ${r.wrongPct}%`);
    assert.ok(r.goodPerLedPerS >= 3, `good ${r.goodPerLedPerS}/LED/s`);
    assert.ok(r.labelled >= 0.98, `labelled ${r.labelled}`);
  });
}
