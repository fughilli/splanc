/** FUG-112 — interim phone solves that drive the live overlay during capture. */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { OutputMap } from "@ledmapper/protocol";
import { LiveSolveScheduler, MIN_DUTY_CYCLE, SUSPEND_AFTER } from "../src/solver/liveSolve";

const MAP: OutputMap = {
  mapId: "live",
  createdAt: "",
  units: "meters",
  frame: "gravity_leveled",
  ledCount: 4,
  leds: [{ id: 0, xyz: [0, 0, 0], confidence: 1, nViews: 3, rmsReprojPx: 1, parallaxDeg: 10 }],
  unmapped: [],
  stats: { rmsReprojPxGlobal: 1, medianParallaxDeg: 10 },
};

/** A controllable solve: resolves when the test says so, at a chosen clock. */
function harness(opts = {}) {
  let clock = 0;
  const pending: { resolve: (m: OutputMap) => void; reject: (e: unknown) => void }[] = [];
  const results: OutputMap[] = [];
  const sched = new LiveSolveScheduler(
    () => new Promise<OutputMap>((resolve, reject) => pending.push({ resolve, reject })),
    (m) => results.push(m),
    { minRecords: 100, minNewRecords: 50, minIntervalMs: 2000, dutyCycle: 0.25, ...opts },
    () => clock,
  );
  return {
    sched,
    results,
    pending,
    setClock: (t: number) => {
      clock = t;
    },
  };
}

const flush = () => new Promise<void>((r) => setImmediate(r));

test("waits for enough observations before the first interim solve", () => {
  const h = harness();
  assert.equal(h.sched.tick(50), false);
  assert.equal(h.sched.tick(120), true);
  assert.equal(h.pending.length, 1);
});

test("one solve at a time; results reach the overlay callback", async () => {
  const h = harness();
  h.sched.tick(120);
  assert.equal(h.sched.tick(500), false, "busy");
  h.setClock(1000);
  h.pending[0]!.resolve(MAP);
  await flush();
  assert.deepEqual(h.results, [MAP]);
});

test("duty cycle: a slow solve pushes the next one out proportionally", async () => {
  const h = harness();
  h.sched.tick(120);
  h.setClock(4000); // the solve took 4 s
  h.pending[0]!.resolve(MAP);
  await flush();
  // 25% duty -> idle 3× the solve time (12 s) before the next one.
  h.setClock(4000 + 11_000);
  assert.equal(h.sched.tick(1000), false);
  h.setClock(4000 + 12_000);
  assert.equal(h.sched.tick(1000), true);
});

test("needs new evidence to re-solve; failed solves are retried later", async () => {
  const h = harness();
  h.sched.tick(120);
  h.setClock(100);
  h.pending[0]!.reject(new Error("too few observation frames"));
  await flush();
  assert.equal(h.results.length, 0);
  h.setClock(10_000);
  assert.equal(h.sched.tick(140), false, "only 20 new records");
  assert.equal(h.sched.tick(170), true);
});

test("stop() waits out the in-flight solve and drops its result", async () => {
  const h = harness();
  h.sched.tick(120);
  let stopped = false;
  const p = h.sched.stop().then(() => {
    stopped = true;
  });
  await flush();
  assert.equal(stopped, false, "still waiting on the worker");
  h.pending[0]!.resolve(MAP);
  await p;
  assert.equal(h.results.length, 0);
  assert.equal(h.sched.tick(10_000), false);
});

/** Run one solve to completion at a chosen duration, with a chosen camera
 * throughput reported by the `settled` hook. */
async function solveOnce(h: ReturnType<typeof harness>, at: number, records: number) {
  h.setClock(at);
  assert.equal(h.sched.tick(records), true, `solve due at ${at}`);
  h.setClock(at + 100);
  h.pending[h.pending.length - 1]!.resolve(MAP);
  await flush();
}

test("governor: a solve that cost camera frames halves the duty cycle; clean ones win it back", async () => {
  const ratios: (number | null)[] = [];
  const h = harness({ settled: () => ratios.shift() ?? null });
  ratios.push(0.8);
  await solveOnce(h, 0, 120);
  assert.equal(h.sched.dutyCycle, 0.125);
  assert.equal(h.sched.impacted, 1);
  ratios.push(1);
  await solveOnce(h, 10_000, 200);
  assert.equal(h.sched.dutyCycle, 0.125 * 1.25);
  ratios.push(0.97); // neither costly nor clean: hold
  await solveOnce(h, 20_000, 300);
  assert.equal(h.sched.dutyCycle, 0.125 * 1.25);
  for (let i = 0; i < 10; i++) {
    ratios.push(1);
    await solveOnce(h, 30_000 + i * 10_000, 400 + i * 100);
  }
  assert.equal(h.sched.dutyCycle, 0.25, "never above the configured duty cycle");
});

test("governor: a backed-off duty cycle spaces solves further apart", async () => {
  const h = harness({ settled: () => 0.5 });
  h.sched.tick(120);
  h.setClock(1000); // 1 s solve
  h.pending[0]!.resolve(MAP);
  await flush();
  // 12.5% duty -> idle 7 s after a 1 s solve (was 3 s at 25%).
  h.setClock(1000 + 6_900);
  assert.equal(h.sched.tick(1000), false);
  h.setClock(1000 + 7_000);
  assert.equal(h.sched.tick(1000), true);
});

test("governor: live solving suspends if it still costs frames at the floor", async () => {
  const h = harness({ settled: () => 0.5 });
  let t = 0;
  let records = 120;
  while (h.sched.dutyCycle > MIN_DUTY_CYCLE) {
    await solveOnce(h, t, records);
    t += 100_000;
    records += 100;
  }
  for (let i = 0; i < SUSPEND_AFTER; i++) {
    assert.equal(h.sched.suspended, false);
    await solveOnce(h, t, records);
    t += 100_000;
    records += 100;
  }
  assert.equal(h.sched.suspended, true);
  h.setClock(t + 1e6);
  assert.equal(h.sched.tick(records + 10_000), false, "no more live solves this capture");
});

test("governor: a throwing settled hook doesn't break scheduling", async () => {
  const h = harness({
    settled: () => {
      throw new Error("instrumentation bug");
    },
  });
  h.sched.tick(120);
  h.setClock(100);
  h.pending[0]!.resolve(MAP);
  await flush();
  h.setClock(10_000);
  assert.equal(h.sched.tick(500), true);
});

test("governor: the settled hook sees whether the solve succeeded", async () => {
  const seen: boolean[] = [];
  const h = harness({ settled: (ok: boolean) => (seen.push(ok), null) });
  h.sched.tick(120);
  h.pending[0]!.reject(new Error("diverged"));
  await flush();
  h.setClock(10_000);
  h.sched.tick(500);
  h.pending[1]!.resolve(MAP);
  await flush();
  assert.deepEqual(seen, [false, true]);
});
