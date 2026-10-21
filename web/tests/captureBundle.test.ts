/** Capture reproduction bundles (solver/captureBundle + store pruning). */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { OutputMap } from "@ledmapper/protocol";
import {
  BUNDLE_FORMAT,
  bundleFileName,
  buildBundle,
  InterimLog,
  shouldLogRun,
  type CaptureParamsSnapshot,
  type InterimRecord,
} from "../src/solver/captureBundle";
import { decideFinal } from "../src/solver/degeneracy";
import { pruneList, type CaptureBundleMeta } from "../src/store/captureBundleStore";

function map(n: number, rms = 1): OutputMap {
  return {
    mapId: "live",
    createdAt: "",
    units: "meters",
    frame: "gravity_leveled",
    ledCount: 60,
    leds: Array.from({ length: n }, (_, id) => ({
      id,
      xyz: [0.05 * Math.cos(id), 0.002 * id, 0.05 * Math.sin(id)] as [number, number, number],
      confidence: 1,
      nViews: 5,
      rmsReprojPx: rms,
      parallaxDeg: 10,
    })),
    unmapped: [],
    trajectory: [[0.7, 0, 0]],
    stats: { rmsReprojPxGlobal: rms, medianParallaxDeg: 10 },
  };
}

function rec(recordCount: number, m: OutputMap | null): InterimRecord {
  return {
    source: "phone",
    tMs: recordCount,
    recordCount,
    imuCount: recordCount * 2,
    ledCount: 60,
    mapId: "live",
    createdAt: "",
    options: { maxKeyframes: 120 },
    map: m,
    diag: null,
    error: m === null ? "too few observation frames" : null,
    assessment: null,
  };
}

test("InterimLog keeps the best interim and the last few, chronologically", () => {
  const log = new InterimLog(2);
  log.add(rec(100, null));
  log.add(rec(200, map(40)));
  log.add(rec(300, map(58))); // best: most LEDs
  log.add(rec(400, map(50, 60))); // degenerate (huge residual)
  log.add(rec(500, map(55)));
  log.add(rec(600, null));
  assert.equal(log.count, 6);
  assert.equal(log.best()?.recordCount, 300);
  const kept = log.records();
  assert.deepEqual(
    kept.map((r) => r.recordCount),
    [300, 500, 600],
  );
  assert.deepEqual(
    kept.map((r) => r.best === true),
    [true, false, false],
  );
  // A degenerate interim never becomes the best over a healthy one.
  assert.equal(log.best()?.assessment?.degenerate, false);
});

test("buildBundle is self-describing and summarizes the decision", () => {
  const log = new InterimLog();
  log.add(rec(300, map(58)));
  const best = log.best()!;
  const decision = decideFinal(
    { map: null, assessment: null, error: "too few IMU samples for a VIO solve (12)" },
    { map: best.map!, assessment: best.assessment! },
  );
  const capture = { ledCount: 60 } as CaptureParamsSnapshot;
  const b = buildBundle({
    id: "b1",
    createdAt: "2026-10-21T07:05:12.345Z",
    decision,
    app: { version: "1.8.0", gitCommit: "abc", gitDirty: false },
    solver: { version: "0.1.0", wasmSha256: null },
    device: { userAgent: "t", platform: null, language: null, hardwareConcurrency: null, deviceMemoryGb: null, screen: null },
    capture,
    problem: { detections: [], imu: [], ledCount: 60, mapId: "x", createdAt: "" },
    interims: log,
    final: { map: null, diag: null, error: "too few IMU samples for a VIO solve (12)", assessment: null, timing: null },
    supplement: null,
    frames: [],
  });
  assert.equal(b.format, BUNDLE_FORMAT);
  assert.equal(b.outcome, "fallback-failed");
  assert.equal(b.interims.length, 1);
  assert.equal(b.interims[0]!.best, true);
  assert.match(b.summary, /^fallback-failed: no map — final-error: too few IMU samples/);
  assert.equal(bundleFileName(b), "splanc-capture-2026-10-21T07-05-12Z-fallback-failed.splanc-capture.json");
  // JSON round trip is lossless (what Export writes is what replay reads).
  assert.deepEqual(JSON.parse(JSON.stringify(b)), b);
});

test("only failed/degenerate/flagged runs are logged unless keeping successes", () => {
  assert.equal(shouldLogRun("ok", false), false);
  assert.equal(shouldLogRun("ok", true), true);
  for (const o of ["flagged", "fallback-degenerate", "fallback-failed", "degenerate", "failed"] as const) {
    assert.equal(shouldLogRun(o, false), true, o);
  }
});

test("pruneList drops the oldest beyond the count and byte caps, never the newest", () => {
  const metas: CaptureBundleMeta[] = [5, 4, 3, 2, 1].map((i) => ({
    id: `b${i}`,
    createdAt: `2026-10-2${i}`,
    outcome: "failed",
    summary: "",
    ledCount: 60,
    bytes: 10,
    frames: 0,
  }));
  assert.deepEqual(pruneList(metas, 3, 1000), ["b2", "b1"]);
  assert.deepEqual(pruneList(metas, 10, 25), ["b3", "b2", "b1"]);
  assert.deepEqual(pruneList([{ ...metas[0]!, bytes: 999 }], 10, 5), []);
});
