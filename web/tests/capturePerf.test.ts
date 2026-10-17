/** FUG-112 — perf counters for the capture hot loop and the live solver. */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CapturePerf,
  formatPerfLine,
  formatPhaseLine,
  RollingStat,
  type FrameTiming,
  type SolveTiming,
} from "../src/cv/capturePerf";

const frame = (tCaptureMs: number, totalMs = 5, extra: Partial<FrameTiming> = {}): FrameTiming => ({
  tCaptureMs,
  detectMs: totalMs * 0.6,
  decodeMs: totalMs * 0.3,
  overlayMs: totalMs * 0.1,
  totalMs,
  ...extra,
});

const solve = (extra: Partial<SolveTiming> = {}): SolveTiming => ({
  records: 500,
  uploadedRecords: 100,
  queueMs: 0,
  postMs: 0.5,
  roundTripMs: 400,
  workerSerializeMs: 10,
  workerSolveMs: 380,
  workerParseMs: 2,
  applyMs: 3,
  ok: true,
  ...extra,
});

test("RollingStat keeps the last N samples", () => {
  const r = new RollingStat(4);
  for (const v of [100, 1, 2, 3, 4]) r.push(v);
  assert.equal(r.count, 4);
  assert.equal(r.max(), 4);
  assert.equal(r.mean(), 2.5);
  assert.equal(r.quantile(0.5), 2);
  assert.equal(r.quantile(0.95), 4);
  r.push(NaN);
  assert.equal(r.count, 4, "non-finite samples are ignored");
});

test("frames split by solver state; cost while solving is visible as the difference", () => {
  let now = 0;
  const p = new CapturePerf(() => now);
  let t = 0;
  for (let i = 0; i < 30; i++) p.frame(frame((t += 33), 4));
  p.solveBegin();
  for (let i = 0; i < 30; i++) p.frame(frame((t += 33), 9));
  now = 1000;
  p.solveEnd(solve());
  const s = p.snapshot();
  assert.equal(s.idle.frames, 30);
  assert.equal(s.solving.frames, 30);
  assert.equal(s.idle.totalMsP95, 4);
  assert.equal(s.solving.totalMsP95, 9);
  assert.ok(Math.abs(s.idle.fps! - 1000 / 33) < 0.01);
  assert.equal(s.solves, 1);
  assert.equal(s.solveWorkerMsP95, 392);
  assert.equal(s.solveMainThreadMsP95, 3.5);
});

test("dropped frames from capture-time gaps; throughput ratio of a solve", () => {
  let now = 0;
  const p = new CapturePerf(() => now);
  let t = 0;
  for (let i = 0; i < 20; i++) p.frame(frame((t += 33)));
  p.solveBegin();
  // 10 delivered frames during the solve, with two 3-frame gaps (2 drops each).
  for (let i = 0; i < 10; i++) p.frame(frame((t += i === 3 || i === 7 ? 99 : 33)));
  now = 500;
  const ratio = p.solveEnd(solve());
  const s = p.snapshot();
  assert.equal(s.solving.dropped, 4);
  assert.equal(s.idle.dropped, 0);
  assert.ok(Math.abs(ratio! - 10 / 14) < 1e-9, `ratio ${ratio}`);
  assert.equal(s.lastThroughputRatio, ratio);
  assert.ok(Math.abs(s.solving.fps! - 1000 / 33) < 0.01, "gaps don't skew the frame rate");
});

test("exact drops from a frame sequence number", () => {
  const p = new CapturePerf(() => 0);
  p.frame(frame(0, 5, { seq: 10 }));
  p.frame(frame(33, 5, { seq: 11 }));
  p.frame(frame(133, 5, { seq: 14 })); // 12, 13 never presented
  const s = p.snapshot();
  assert.equal(s.idle.dropped, 2);
  assert.ok(Math.abs(s.idle.fps! - 1000 / 33) < 1);
});

test("a clean solve reports full throughput; too few frames reports null", () => {
  let now = 0;
  const p = new CapturePerf(() => now);
  let t = 0;
  for (let i = 0; i < 10; i++) p.frame(frame((t += 33)));
  p.solveBegin();
  for (let i = 0; i < 10; i++) p.frame(frame((t += 33)));
  assert.equal(p.solveEnd(solve()), 1);
  p.solveBegin();
  p.frame(frame((t += 33)));
  assert.equal(p.solveEnd(solve({ ok: false })), null);
  assert.equal(p.snapshot().solveFailures, 1);
});

test("duty cycle counts wall time with a solve in flight", () => {
  let now = 0;
  const p = new CapturePerf(() => now);
  now = 1000;
  p.solveBegin();
  now = 2000;
  p.solveEnd(solve());
  now = 3000;
  p.solveBegin();
  now = 4000;
  assert.equal(p.snapshot().solveDuty, 0.5, "in-flight time counts too");
});

test("format lines carry the numbers that matter", () => {
  let now = 0;
  const p = new CapturePerf(() => now);
  let t = 0;
  for (let i = 0; i < 10; i++) p.frame(frame((t += 33), 4, { prepMs: 1, latencyMs: 2 }));
  assert.match(formatPerfLine(p.snapshot()), /^perf idle 30\.3fps p95 4\.0ms drop 0\/10$/);
  p.solveBegin();
  for (let i = 0; i < 10; i++) p.frame(frame((t += 33), 6));
  now = 400;
  p.solveEnd(solve());
  const line = formatPerfLine(p.snapshot());
  assert.match(line, /solving 30\.3fps p95 6\.0ms/);
  assert.match(line, /solve n=1 duty 100% last 400ms \(wasm 380 post 0\.5 apply 3\.0\) 500rec thr 100%/);
  assert.match(formatPhaseLine(p.snapshot()), /idle\[prep 1\.0 detect 2\.4 decode 1\.2 overlay 0\.4 max 4\.0 latency 2\.0\]/);
});
