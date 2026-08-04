/**
 * Available-execution-budget tests (FUG-11): the budget breakdown, the
 * consumed-fraction, and the progress-bar color bands (<=70% green, >70%
 * yellow, >90% red).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BUDGET_RED_AT,
  BUDGET_YELLOW_AT,
  budgetColor,
  budgetConsumption,
  budgetFromEstimate,
  budgetFromPhases,
  computeBudget,
  measureAvailableFraction,
} from "../src/effects/budget";
import type { BudgetModel, FrameEstimate, PhaseSplit } from "../src/effects/costModel";

const MODEL: BudgetModel = { fps: 30, cpuAvailableFraction: 0.85, transmitReservesCpu: false };

test("budgetColor uses the FUG-11 70/90 bands", () => {
  assert.equal(budgetColor(0), "green");
  assert.equal(budgetColor(0.7), "green"); // <=70% green
  assert.equal(budgetColor(0.70001), "yellow"); // >70% yellow
  assert.equal(budgetColor(0.9), "yellow"); // ==90% still yellow
  assert.equal(budgetColor(0.90001), "red"); // >90% red
  assert.equal(budgetColor(1.5), "red");
  assert.equal(BUDGET_YELLOW_AT, 0.7);
  assert.equal(BUDGET_RED_AT, 0.9);
});

test("computeBudget splits the frame period correctly", () => {
  const b = computeBudget(MODEL, 5); // showMs = 5
  assert.ok(Math.abs(b.frameMs - 1000 / 30) < 1e-9);
  // systemReserved = frame * (1 - 0.85)
  assert.ok(Math.abs(b.systemReservedMs - b.frameMs * 0.15) < 1e-9);
  assert.equal(b.showMs, 5);
  assert.ok(Math.abs(b.availableFxMs - (b.frameMs - b.systemReservedMs - 5)) < 1e-9);
});

test("computeBudget clamps a starved frame to zero available", () => {
  const b = computeBudget(MODEL, 1000); // transmit dwarfs the frame
  assert.equal(b.availableFxMs, 0);
});

test("budgetConsumption computes fraction + color", () => {
  const b = computeBudget(MODEL, 5);
  const avail = b.availableFxMs;
  // consume ~60% of available → comfortably green.
  const s60 = budgetConsumption(MODEL, avail * 0.6, 5);
  assert.ok(Math.abs(s60.fraction - 0.6) < 1e-9);
  assert.equal(s60.color, "green");
  // 80% → yellow.
  assert.equal(budgetConsumption(MODEL, avail * 0.8, 5).color, "yellow");
  // 95% → red.
  assert.equal(budgetConsumption(MODEL, avail * 0.95, 5).color, "red");
});

test("budgetConsumption flags a starved budget as red overrun", () => {
  const s = budgetConsumption(MODEL, 2, 1000);
  assert.ok(s.starved);
  assert.equal(s.color, "red");
  assert.equal(s.fraction, Number.POSITIVE_INFINITY);
  // zero work in a starved frame is not an overrun.
  const z = budgetConsumption(MODEL, 0, 1000);
  assert.equal(z.fraction, 0);
  assert.equal(z.color, "green");
});

test("budgetFromPhases consumes update+shade, not show", () => {
  const phases: PhaseSplit = { updateMs: 3, shadeMs: 10, showMs: 4 };
  const s = budgetFromPhases(phases, MODEL);
  assert.equal(s.consumedFxMs, 13); // update + shade
  assert.equal(s.breakdown.showMs, 4);
});

test("budgetFromEstimate reads an offline estimate", () => {
  const est = {
    totalMs: 20,
    budgetMs: 1000 / 30,
    budgetFraction: 0.6,
    phaseSplit: { updateMs: 2, shadeMs: 12, showMs: 6 },
    opsPerLed: 10,
    errorBand: { lowMs: 15, highMs: 25, fraction: 0.2 },
    hotOpcodes: [],
    confidence: "yellow",
    branched: false,
    loopCapped: false,
  } as FrameEstimate;
  const s = budgetFromEstimate(est, MODEL);
  assert.equal(s.consumedFxMs, 14);
  assert.equal(s.breakdown.showMs, 6);
  assert.ok(s.fraction > 0);
});

test("measureAvailableFraction derives the fraction from other-task time", () => {
  const frameMs = 1000 / 30;
  // 10% of the frame spent on other tasks → 0.9 available.
  const f = measureAvailableFraction(frameMs, frameMs * 0.1);
  assert.ok(Math.abs(f - 0.9) < 1e-9);
  // degenerate inputs fall back safely.
  assert.ok(measureAvailableFraction(0, 5) > 0);
  assert.equal(measureAvailableFraction(frameMs, frameMs * 2), 0.01);
});
