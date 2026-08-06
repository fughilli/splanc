/**
 * Opcode-coverage assertions (FUG-79 acceptance criteria). Proves the
 * calibration suite gives 100% builtin/opcode coverage: EVERY opcode reachable
 * from user source is either FITTED with ≥1 isolating benchmark, or explicitly
 * BUCKETED / EXCLUDED with a documented rationale — no silent gaps. Also pins
 * the per-fn sub-keying of UnMath/BinMath and that the held-out program
 * exercises the hash/normalize/loop-guard shape the old suite never measured.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { OPCODE_NAMES, UN_MATH_NAMES, BIN_MATH_NAMES } from "../src/effects/costModel";
import { costFor } from "../src/effects/costModel";
import {
  BENCHMARKS,
  HELDOUT,
  HELDOUTS,
  FITTED_OPCODES,
  BUCKETED_OPCODES,
  EXCLUDED_OPCODES,
  benchmarksForTier,
} from "../src/effects/calibrationBenchmarks";
import { DEFAULT_COSTS } from "../src/store/costTableStore";

/** The base opcode name behind a (possibly sub-keyed) feature name. */
const baseOf = (feature: string): string =>
  feature.includes(":") ? feature.slice(0, feature.indexOf(":")) : feature;

test("FITTED / BUCKETED / EXCLUDED exactly partition the opcode set", () => {
  const all = new Set(OPCODE_NAMES as readonly string[]);
  const fittedBases = new Set(FITTED_OPCODES.map(baseOf));
  const bucketed = new Set(Object.keys(BUCKETED_OPCODES));
  const excluded = new Set(Object.keys(EXCLUDED_OPCODES));

  // every partition member is a real opcode
  for (const s of [fittedBases, bucketed, excluded]) {
    for (const op of s) assert.ok(all.has(op), `${op} is not a canonical opcode`);
  }
  // pairwise disjoint
  for (const op of fittedBases) {
    assert.ok(!bucketed.has(op), `${op} is both fitted and bucketed`);
    assert.ok(!excluded.has(op), `${op} is both fitted and excluded`);
  }
  for (const op of bucketed) assert.ok(!excluded.has(op), `${op} is both bucketed and excluded`);
  // union covers every opcode — no silent gaps
  for (const op of all) {
    const where = fittedBases.has(op) ? "fitted" : bucketed.has(op) ? "bucketed" : excluded.has(op) ? "excluded" : null;
    assert.ok(where, `opcode ${op} is unaccounted for (add to FITTED/BUCKETED/EXCLUDED)`);
  }
  assert.equal(fittedBases.size + bucketed.size + excluded.size, all.size);
});

test("every fitted opcode feature has ≥1 isolating benchmark", () => {
  const targets = new Set(BENCHMARKS.map((b) => b.targetOp).filter((t): t is string => t !== null));
  for (const op of FITTED_OPCODES) {
    assert.ok(targets.has(op), `fitted op ${op} has no isolating benchmark`);
  }
});

test("every isolating benchmark targets a fitted opcode", () => {
  for (const b of BENCHMARKS) {
    if (b.targetOp === null) continue;
    assert.ok(FITTED_OPCODES.includes(b.targetOp), `${b.id} targets ${b.targetOp}, not fitted`);
  }
});

test("UnMath and BinMath are fitted per fn (all fn ids covered)", () => {
  for (const fn of UN_MATH_NAMES as readonly string[]) {
    assert.ok(FITTED_OPCODES.includes(`UnMath:${fn}`), `missing UnMath:${fn}`);
  }
  for (const fn of BIN_MATH_NAMES as readonly string[]) {
    assert.ok(FITTED_OPCODES.includes(`BinMath:${fn}`), `missing BinMath:${fn}`);
  }
  // the bare family names are NOT fitted features (they're the fallback tier).
  assert.ok(!FITTED_OPCODES.includes("UnMath"));
  assert.ok(!FITTED_OPCODES.includes("BinMath"));
});

test("excluded opcodes are real, unreachable, and documented", () => {
  const all = new Set(OPCODE_NAMES as readonly string[]);
  assert.ok(Object.keys(EXCLUDED_OPCODES).length >= 1);
  for (const [op, why] of Object.entries(EXCLUDED_OPCODES)) {
    assert.ok(all.has(op), `${op} not an opcode`);
    assert.ok(why.length > 10, `${op} needs a real rationale`);
  }
  // Scale + Pop are the known compiler-unreachable opcodes.
  assert.ok("Scale" in EXCLUDED_OPCODES && "Pop" in EXCLUDED_OPCODES);
});

test("bucketed opcodes each carry a documented rationale", () => {
  for (const [op, why] of Object.entries(BUCKETED_OPCODES)) {
    assert.ok(why.length > 10, `${op} needs a real rationale`);
  }
});

test("the default cost table resolves every fitted feature (exact or family base)", () => {
  // costFor must return a real (non-fallback) cost for each fitted feature, so
  // even an uncalibrated table prices every builtin sensibly.
  const FALLBACK = -1;
  for (const op of FITTED_OPCODES) {
    assert.notEqual(costFor(DEFAULT_COSTS, op, FALLBACK), FALLBACK, `default has no cost for ${op}`);
  }
});

test("the full tier is the whole suite; core is a covering subset", () => {
  assert.deepEqual(benchmarksForTier("full"), BENCHMARKS);
  const core = benchmarksForTier("core");
  assert.ok(core.length < BENCHMARKS.length, "core is a strict subset");
  // every overhead/sweep bench is in core (needed to fit fixed/per-LED terms).
  for (const b of BENCHMARKS) {
    if (b.targetOp === null) assert.ok(core.includes(b), `core must keep overhead bench ${b.id}`);
  }
  // the full run isolates every fitted feature.
  const fullTargets = new Set(benchmarksForTier("full").map((b) => b.targetOp));
  for (const op of FITTED_OPCODES) assert.ok(fullTargets.has(op), `full tier missing ${op}`);
});

test("held-out program exercises hash + normalize + a data-dependent loop", () => {
  assert.ok(HELDOUTS.includes(HELDOUT));
  const src = HELDOUT.source;
  assert.match(src, /hash\(/, "held-out must use hash()");
  assert.match(src, /normalize\(/, "held-out must use normalize()");
  assert.match(src, /dot\(/, "held-out must use dot()");
  assert.match(src, /for \(/, "held-out must have a bounded loop");
  assert.match(src, /if \(i < n\)/, "held-out must have a data-dependent guard");
  // it is NOT part of the fit set.
  assert.ok(!BENCHMARKS.some((b) => b.id === HELDOUT.id));
});
