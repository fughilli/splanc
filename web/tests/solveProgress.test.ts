/** One monotonic progress bar across a final solve's passes and phases. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { SolveProgress, stageLabel, type PlannedStage, type StageSnapshot } from "../src/solver/solveProgress";

const PLAN: PlannedStage[] = [
  { name: "initial-cold", weight: 60 },
  { name: "outlier-round-0", weight: 30 },
  { name: "outlier-round-1", weight: 15 },
  { name: "outlier-round-2", weight: 15 },
];

/** What the solver emits: each pass's own fraction running 0 → 0.99. */
function passSnaps(plan: PlannedStage[], passes: number[], steps = 10): StageSnapshot[] {
  const out: StageSnapshot[] = [];
  for (const idx of passes) {
    for (let k = 0; k <= steps; k++) {
      out.push({ progress: (0.99 * k) / steps, stage: plan[idx]!.name, stageIndex: idx, plan });
    }
  }
  return out;
}

function assertMonotonic(xs: number[]): void {
  for (let i = 1; i < xs.length; i++) {
    assert.ok(xs[i]! >= xs[i - 1]!, `bar went back at ${i}: ${xs[i - 1]} -> ${xs[i]}`);
  }
}

test("per-pass resets become one monotonic bar that reaches 1", () => {
  const p = new SolveProgress();
  const fr = passSnaps(PLAN, [0, 1, 2, 3]).map((s) => p.update(s).fraction);
  assertMonotonic(fr);
  assert.ok(fr[fr.length - 1]! > 0.98 && fr[fr.length - 1]! < 1, `${fr[fr.length - 1]}`);
  assert.equal(p.complete().fraction, 1);
});

test("passes are weighted by their evaluation budget", () => {
  const p = new SolveProgress();
  // End of the cold pass (60 of 120): about half.
  p.update({ progress: 1, stageIndex: 0, plan: PLAN });
  assert.ok(Math.abs(p.view().fraction - 0.5) < 1e-9);
  // Midway through the first outlier round (30 of 120 → +0.125).
  p.update({ progress: 0.5, stageIndex: 1, plan: PLAN });
  assert.ok(Math.abs(p.view().fraction - 0.625) < 1e-9);
});

test("a pass that converges early does not make the bar jump", () => {
  const p = new SolveProgress();
  // The cold pass stops at 23 % of its budget (ftol), as on a real capture.
  for (let k = 0; k <= 23; k++) p.update({ progress: k / 100, stageIndex: 0, plan: PLAN });
  const end = p.view().fraction;
  const next = p.update({ progress: 0, stageIndex: 1, plan: PLAN }).fraction;
  assert.ok(Math.abs(next - end) < 1e-9, `${end} -> ${next}`);
  // ...and the remaining passes share the rest of the bar.
  const fr = passSnaps(PLAN, [1, 2, 3]).map((s) => p.update(s).fraction);
  assertMonotonic(fr);
  assert.ok(fr[fr.length - 1]! > 0.98);
});

test("skipped adaptive passes jump forward, never back", () => {
  const plan = [...PLAN, { name: "strip-prior", weight: 30 }];
  const p = new SolveProgress();
  // Outlier rounds stop after round 0 (nothing left to drop) → strip prior.
  const fr = passSnaps(plan, [0, 1, 4]).map((s) => p.update(s).fraction);
  assertMonotonic(fr);
  assert.ok(fr[fr.length - 1]! > 0.98);
  assert.equal(p.complete().fraction, 1);
});

test("a solve that ends early still completes at 1", () => {
  const p = new SolveProgress();
  passSnaps(PLAN, [0]).forEach((s) => p.update(s));
  assert.ok(p.view().fraction < 0.6);
  assert.equal(p.complete().fraction, 1);
});

test("unknown pass count: resets detected, the remainder is rescaled", () => {
  const p = new SolveProgress();
  const fr: number[] = [];
  // No plan / stageIndex (a host solve, an older wasm build): five passes.
  for (let pass = 0; pass < 5; pass++) {
    for (let k = 0; k <= 10; k++) fr.push(p.update({ progress: k / 10 }).fraction);
  }
  assertMonotonic(fr);
  // Each pass covers half of what is left: 1 - 0.5^5.
  assert.ok(Math.abs(fr[fr.length - 1]! - (1 - 0.5 ** 5)) < 1e-9, `${fr[fr.length - 1]}`);
  assert.ok(fr[fr.length - 1]! < 1);
  assert.match(p.view().label, /pass 5/);
  assert.equal(p.complete().fraction, 1);
});

test("unknown pass count: a stage-index change marks a new pass even without a fall", () => {
  const p = new SolveProgress();
  p.update({ progress: 0.3, stageIndex: 0 });
  // Throttled reports can miss a pass's low fractions: 0.3 → 0.6 of the NEXT pass.
  const before = p.view().fraction;
  p.update({ progress: 0.6, stageIndex: 1 });
  assert.ok(p.view().fraction > before);
  assert.match(p.view().label, /pass 2/);
});

test("outer phases (standalone + joint re-solve) share the bar by weight", () => {
  const p = new SolveProgress([
    { label: "Solving the scan", weight: 1 },
    { label: "Joint re-solve", weight: 3 },
  ]);
  const fr: number[] = [];
  for (const s of passSnaps(PLAN, [0, 1, 2, 3])) fr.push(p.update(s).fraction);
  assert.ok(fr[fr.length - 1]! <= 0.25 + 1e-9);
  fr.push(p.beginPhase(1).fraction);
  assert.ok(Math.abs(fr[fr.length - 1]! - 0.25) < 1e-9);
  assert.match(p.view().label, /Joint re-solve \(2\/2\)/);
  for (const s of passSnaps(PLAN, [0, 1, 2, 3])) fr.push(p.update(s).fraction);
  assertMonotonic(fr);
  assert.ok(fr[fr.length - 1]! > 0.98);
  assert.equal(p.complete().fraction, 1);
});

test("going back a phase or a pass, or garbage input, never decreases the bar", () => {
  const p = new SolveProgress([
    { label: "a", weight: 1 },
    { label: "b", weight: 1 },
  ]);
  p.beginPhase(1);
  p.update({ progress: 0.5, stageIndex: 2, plan: PLAN });
  const hi = p.view().fraction;
  for (const s of [
    { progress: 0, stageIndex: 0, plan: PLAN },
    { progress: Number.NaN },
    { progress: -3, stageIndex: 99, plan: PLAN },
    { progress: 0.1, plan: [] },
  ] as StageSnapshot[]) {
    p.update(s);
    assert.ok(p.view().fraction >= hi);
  }
  p.beginPhase(0);
  assert.ok(p.view().fraction >= hi);
});

test("restart: a fallback solve carries on from the current position", () => {
  const p = new SolveProgress();
  for (let k = 0; k <= 10; k++) p.update({ progress: k / 10 }); // host solve, no plan
  const at = p.view().fraction;
  assert.equal(p.restart().fraction, at);
  const fr = passSnaps(PLAN, [0, 1, 2, 3]).map((s) => p.update(s).fraction);
  assert.ok(fr[0]! >= at);
  assertMonotonic(fr);
  assert.ok(fr[0]! < fr[fr.length - 1]!, "the fallback solve moves the bar");
  assert.ok(fr[fr.length - 1]! > 0.98);
});

test("labels name the pass and stage", () => {
  const p = new SolveProgress();
  const v = p.update({ progress: 0.2, stage: "outlier-round-1", stageIndex: 2, plan: PLAN });
  assert.equal(v.label, "Solving · pass 3 of 4 (outlier rejection 2)");
  assert.equal(stageLabel("initial-cold"), "initial solve");
  assert.equal(stageLabel("strip-prior"), "strip refinement");
});
