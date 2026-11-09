/**
 * #443 (software side): an AI-written effect over its frame budget is an
 * optimizing draft, not a ready replacement (src/effects/ai/agentDraft.ts).
 * Auto-push holds it back during the agent turn so the fixture keeps the last
 * effect; when the turn ends — finished, out of steps, or failed as in the demo
 * (network error at 314% of budget) — the operator sees that it is not ready and
 * gets recovery actions.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  draftNotice,
  draftVerdict,
  holdAgentAutoPush,
  optimizeAsk,
  trustedBudget,
  uncalibratedEstimateNote,
} from "../src/effects/ai/agentDraft";

/** A calibrated-model estimate (cost table benchmarked on the user's board). */
const est = (fraction: number) => ({ fraction, source: "estimate" as const, calibrated: true });
/** An estimate from the shipped, uncalibrated default model. */
const rough = (fraction: number) => ({ fraction, source: "estimate" as const, calibrated: false });
const measured = (fraction: number) => ({ fraction, source: "measured" as const });

test("verdicts: strictly over 1.0 is over budget; missing or bad readings are unknown", () => {
  assert.equal(draftVerdict(est(3.14)), "over");
  assert.equal(draftVerdict(est(1)), "within");
  assert.equal(draftVerdict(est(0.4)), "within");
  assert.equal(draftVerdict(null), "unknown");
  assert.equal(draftVerdict(est(Number.NaN)), "unknown");
});

test("auto-push holds only an agent draft that is known to be over budget", () => {
  assert.equal(holdAgentAutoPush({ agentTurn: true, budget: est(3.96) }), true);
  assert.equal(holdAgentAutoPush({ agentTurn: true, budget: est(0.8) }), false);
  assert.equal(holdAgentAutoPush({ agentTurn: false, budget: est(3.96) }), false, "a manual compile is the user's call");
  assert.equal(holdAgentAutoPush({ agentTurn: true, budget: null }), false, "an estimator failure never blocks pushes");
});

test("the demo case: network error at 314% is a visible stall with a recovery path", () => {
  const n = draftNotice({
    end: "error",
    error: "network error",
    budget: est(3.14),
    onDevice: false,
    held: true,
    connected: true,
    canResume: true,
  })!;
  assert.equal(n.tone, "error");
  assert.match(n.text, /Optimization stopped \(network error\)/);
  assert.match(n.text, /314% of the frame budget \(calibrated estimate\)/);
  assert.match(n.text, /the fixture keeps playing the previous effect/);
  assert.deepEqual(n.actions, ["continue", "optimize", "push"]);
});

test("a finished turn whose draft is still over budget is 'not ready', never a clean finish", () => {
  const n = draftNotice({ end: "complete", budget: est(1.07), onDevice: false, held: true, connected: true, canResume: false })!;
  assert.equal(n.tone, "warn");
  assert.match(n.text, /Not ready: over budget/);
  assert.match(n.text, /107%/);
  assert.deepEqual(n.actions, ["optimize", "push"]);
  // Out of steps while still over: "still optimizing", resumable.
  const x = draftNotice({ end: "exhausted", budget: est(1.35), onDevice: false, held: false, connected: true, canResume: true })!;
  assert.match(x.text, /Still optimizing/);
  assert.deepEqual(x.actions, ["continue", "optimize", "push"]);
});

test("device state is described honestly; no push offer when nothing can take it", () => {
  const playing = draftNotice({ end: "complete", budget: { fraction: 1.2, source: "measured" }, onDevice: true, held: false, connected: true, canResume: false })!;
  assert.match(playing.text, /\(measured\)/);
  assert.match(playing.text, /playing it now, so expect stutter/);
  assert.deepEqual(playing.actions, ["optimize"]);
  const offline = draftNotice({ end: "complete", budget: est(2), onDevice: false, held: false, connected: false, canResume: false })!;
  assert.match(offline.text, /No fixture is connected/);
  assert.deepEqual(offline.actions, ["optimize"]);
});

test("within budget (or unknown): presented as ready, no notice", () => {
  assert.equal(draftNotice({ end: "complete", budget: est(0.6), onDevice: true, held: false, connected: true, canResume: false }), null);
  assert.equal(draftNotice({ end: "error", budget: null, onDevice: false, held: false, connected: true, canResume: true }), null);
});

test("Keep optimizing asks for an honest, verified result", () => {
  const ask = optimizeAsk(est(3.14));
  assert.match(ask, /314% of the fixture's frame budget \(calibrated offline estimate\)/);
  assert.match(ask, /estimate_performance/);
  assert.match(ask, /measure_on_device/);
  assert.match(ask, /still over budget/);
});

// -- calibrated vs uncalibrated (owner decision on PR #462) ------------------------

test("only a measurement or a calibrated estimate is trusted", () => {
  assert.equal(trustedBudget(est(3)), true);
  assert.equal(trustedBudget(measured(3)), true);
  assert.equal(trustedBudget(rough(3)), false);
  assert.equal(trustedBudget({ fraction: 3, source: "estimate" }), false, "unknown calibration = uncalibrated");
  assert.equal(trustedBudget(null), false);
});

test("uncalibrated: an over-budget estimate does not hold auto-push", () => {
  assert.equal(holdAgentAutoPush({ agentTurn: true, budget: rough(3.14) }), false);
  assert.equal(holdAgentAutoPush({ agentTurn: true, budget: est(3.14) }), true);
  assert.equal(holdAgentAutoPush({ agentTurn: true, budget: measured(1.3) }), true);
});

test("uncalibrated: the agent is told the estimate is no verdict and to measure", () => {
  const note = uncalibratedEstimateNote(rough(3.14), true);
  assert.match(note, /314% of the frame budget, from the UNCALIBRATED default cost model/);
  assert.match(note, /not held back/);
  assert.match(note, /Call measure_on_device and treat the measured number as what counts/);
  assert.match(uncalibratedEstimateNote(rough(3.14), false), /No fixture is connected/);
  assert.equal(uncalibratedEstimateNote(est(3.14), true), "", "calibrated estimates speak for themselves");
  assert.equal(uncalibratedEstimateNote(measured(3.14), true), "");
  assert.equal(uncalibratedEstimateNote(rough(0.5), true), "");
});

test("uncalibrated: no 'not ready'/'stopped' verdict from the estimate; the measurement decides", () => {
  const n = draftNotice({ end: "error", error: "network error", budget: rough(3.14), onDevice: true, held: false, connected: true, canResume: true })!;
  assert.equal(n.tone, "info");
  assert.doesNotMatch(n.text, /Not ready|Optimization stopped|Still optimizing/);
  assert.match(n.text, /uncalibrated/);
  assert.match(n.text, /measured number \(measure_on_device\) is what counts/);
  assert.deepEqual(n.actions, []);
  // Once measured over budget, the visible outcome returns — from the measurement.
  const m = draftNotice({ end: "error", error: "network error", budget: measured(1.4), onDevice: true, held: false, connected: true, canResume: true })!;
  assert.equal(m.tone, "error");
  assert.match(m.text, /Optimization stopped \(network error\)[^]*140% of the frame budget \(measured\)/);
  // ...and a measurement within budget clears it entirely.
  assert.equal(draftNotice({ end: "complete", budget: measured(0.8), onDevice: true, held: false, connected: true, canResume: false }), null);
});
