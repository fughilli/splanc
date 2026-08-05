/**
 * Fleet resolution tests (FUG-11): mapping a persisted fleet selection + stored
 * profiles into the device targets the multi-device estimator consumes. Pure
 * core only (fleetTargetsFrom / fallbackTarget) — no IndexedDB/localStorage.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { fleetTargetsFrom, fallbackTarget } from "../src/effects/fleet";
import {
  DEFAULT_COSTS,
  DEFAULT_FIXED,
  defaultCostTable,
  type StoredCostTable,
} from "../src/store/costTableStore";

function rec(over: Partial<StoredCostTable>): StoredCostTable {
  return {
    id: "esp32c6@160000000#1",
    soc: "esp32c6",
    cpuHz: 160_000_000,
    tableVersion: 1,
    firmwareBuild: "test",
    timestamp: "2026-01-01T00:00:00Z",
    residualError: 0.1,
    budgetMs: 1000 / 30,
    fallbackCost: 8,
    costs: { ...DEFAULT_COSTS },
    fixedOverhead: { ...DEFAULT_FIXED },
    observations: [],
    deviceLabel: "",
    origin: "calibrated",
    ...over,
  };
}

test("maps entries to targets, preferring deviceKey + label + calibrated flag", () => {
  const records = [
    rec({ id: "A", deviceKey: "aa:bb", deviceLabel: "Stage-left", origin: "calibrated" }),
    rec({ id: "B", deviceLabel: "", soc: "esp32s3", origin: "host" }),
  ];
  const targets = fleetTargetsFrom(
    [
      { tableId: "A", ledCount: 64 },
      { tableId: "B", ledCount: 300 },
    ],
    records,
  );
  assert.equal(targets.length, 2);
  assert.equal(targets[0]!.key, "aa:bb");
  assert.equal(targets[0]!.label, "Stage-left");
  assert.equal(targets[0]!.calibrated, true);
  assert.equal(targets[0]!.ledCount, 64);
  // no deviceKey → key falls back to the record id; no label → the soc.
  assert.equal(targets[1]!.key, "B");
  assert.equal(targets[1]!.label, "esp32s3");
  assert.equal(targets[1]!.calibrated, false);
});

test("skips entries whose profile no longer exists (self-healing)", () => {
  const targets = fleetTargetsFrom(
    [
      { tableId: "A", ledCount: 64 },
      { tableId: "gone", ledCount: 64 },
    ],
    [rec({ id: "A" })],
  );
  assert.equal(targets.length, 1);
  assert.equal(targets[0]!.key, "A"); // no deviceKey on this record → falls back to id
  assert.equal(targets[0]!.ledCount, 64);
});

test("floors LED counts to >=1", () => {
  const targets = fleetTargetsFrom([{ tableId: "A", ledCount: 0 }], [rec({ id: "A" })]);
  assert.equal(targets[0]!.ledCount, 1);
});

test("fallbackTarget wraps a resolved table at the given LED count", () => {
  const t = fallbackTarget(defaultCostTable("esp32c6", 160_000_000), 128, false);
  assert.equal(t.ledCount, 128);
  assert.equal(t.calibrated, false);
  assert.equal(t.table.soc, "esp32c6");
  assert.match(t.key, /esp32c6/);
});
