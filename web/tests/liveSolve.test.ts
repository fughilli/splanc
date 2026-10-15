/** FUG-112 — interim phone solves that drive the live overlay during capture. */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { OutputMap } from "@ledmapper/protocol";
import { LiveSolveScheduler } from "../src/solver/liveSolve";

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
