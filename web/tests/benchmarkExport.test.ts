/**
 * Benchmark-export tests (FUG-11): the `.fx` files the HITL harness runs are
 * generated from the calibration source of truth, so they can't drift from the
 * in-browser calibration. Pins the file set, the fit/held-out split, and that
 * every fit program isolates a fitted opcode.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { benchmarkFxFiles } from "../src/effects/benchmarkExport";
import { BENCHMARKS, HELDOUT, FITTED_OPCODES } from "../src/effects/calibrationBenchmarks";

test("one file per benchmark plus exactly one held-out", () => {
  const files = benchmarkFxFiles();
  assert.equal(files.length, BENCHMARKS.length + 1);
  const heldout = files.filter((f) => f.heldout);
  assert.equal(heldout.length, 1);
  assert.equal(heldout[0]!.filename, `${HELDOUT.id}.heldout.fx`);
  // Only the held-out file uses the `.heldout.fx` suffix the harness keys on.
  for (const f of files) {
    assert.equal(f.filename.endsWith(".heldout.fx"), f.heldout, f.filename);
  }
});

test("fit filenames match benchmark ids and embed the source", () => {
  const files = benchmarkFxFiles();
  for (const b of BENCHMARKS) {
    const f = files.find((x) => x.filename === `${b.id}.fx`);
    assert.ok(f, `missing ${b.id}.fx`);
    assert.ok(f!.source.includes(b.source), `${b.id}.fx must contain its source`);
    assert.ok(f!.source.startsWith("//"), "leads with a generated-from header");
  }
});

test("every isolated fit program targets a fitted opcode", () => {
  for (const b of BENCHMARKS) {
    if (b.targetOp === null) continue; // overhead / sweep programs
    assert.ok(
      FITTED_OPCODES.includes(b.targetOp),
      `${b.id} targets ${b.targetOp}, not in FITTED_OPCODES`,
    );
  }
});
