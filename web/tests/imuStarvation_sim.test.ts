/**
 * IMU starvation on a busy main thread: the radiolarian case (2026-11-12).
 *
 * DeviceMotion events are delivered on the main thread, and the browser
 * coalesces them while it is busy: a reading that arrives while an older one
 * is still waiting replaces it. The radiolarian captures' phone ran each camera
 * frame as one long task (detect, decode, track, then the overlay with a label
 * per LED) and got its IMU at ~15 Hz, starving the solver's only source of
 * metric scale (solver/src/regression_tests.rs reproduces that collapse).
 *
 * This runs the capture loop's real task scheduling (ui/taskPriority, as
 * ui/screens/capture.ts uses it) on a virtual main thread with a 60 Hz motion
 * sensor and a 30 fps camera, and counts the motion events that get through,
 * with the real perf counters (cv/capturePerf). The control is the old loop's
 * shape: every frame's work as one task. Stage costs are a mid-range Android
 * phone's on a dense fixture; the point is the structure, not the numbers.
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { CapturePerf } from "../src/cv/capturePerf";
import { CoalescedTask, OrderedTaskQueue } from "../src/ui/taskPriority";

const SENSOR_MS = 1000 / 60;
const FRAME_MS = 1000 / 30;
/** Per-frame stage costs (ms): GPU detect, CV decode + track, overlay draw. */
const COST = { detect: 6, decode: 18, overlay: 22 };
/** The overlay's rate cap in the capture screen (OVERLAY_MIN_INTERVAL_MS). */
const OVERLAY_MIN_INTERVAL_MS = 83;
const DURATION_MS = 20_000;

interface Queued {
  readyAt: number;
  seq: number;
  run: () => void;
}

/** A single-threaded event loop on a virtual clock: one task at a time, each
 * advancing the clock by its cost; a motion reading arriving while another is
 * still waiting replaces it (dropped). */
class VirtualMainThread {
  now = 0;
  private seq = 0;
  private tasks: Queued[] = [];
  private pendingMotion: number | null = null;
  private nextSensor = 0;
  private nextFrame = 0;
  delivered = 0;
  dropped = 0;
  longestTaskMs = 0;

  constructor(
    private readonly onMotion: (eventTimeMs: number) => void,
    private readonly onFrame: () => void,
  ) {}

  post(run: () => void, delayMs = 0): void {
    this.tasks.push({ readyAt: this.now + delayMs, seq: this.seq++, run });
  }

  work(ms: number): void {
    this.now += ms;
  }

  /** Readings and frames that came due while the last task ran. */
  private arrivals(): void {
    while (this.nextSensor <= this.now) {
      if (this.pendingMotion !== null) this.dropped++;
      this.pendingMotion = this.nextSensor;
      this.nextSensor += SENSOR_MS;
    }
    while (this.nextFrame <= this.now) {
      // rVFC: a frame callback per presented frame; a late one is skipped.
      const t = this.nextFrame;
      this.post(() => this.onFrame());
      this.tasks[this.tasks.length - 1]!.readyAt = t;
      this.nextFrame += FRAME_MS;
      while (this.nextFrame <= this.now) this.nextFrame += FRAME_MS;
    }
  }

  run(untilMs: number): void {
    while (this.now < untilMs) {
      this.arrivals();
      // A waiting motion event runs first (it is the oldest), then the oldest
      // ready task; idle until the next arrival otherwise.
      if (this.pendingMotion !== null) {
        const t = this.pendingMotion;
        this.pendingMotion = null;
        this.delivered++;
        this.onMotion(t);
        continue;
      }
      const ready = this.tasks.filter((q) => q.readyAt <= this.now).sort((a, b) => a.readyAt - b.readyAt || a.seq - b.seq);
      const next = ready[0];
      if (next === undefined) {
        const due = Math.min(this.nextSensor, this.nextFrame, ...this.tasks.map((q) => q.readyAt));
        this.now = Math.max(this.now, due);
        continue;
      }
      this.tasks.splice(this.tasks.indexOf(next), 1);
      const t0 = this.now;
      next.run();
      this.longestTaskMs = Math.max(this.longestTaskMs, this.now - t0);
    }
  }
}

const g = globalThis as { scheduler?: unknown };
afterEach(() => {
  delete g.scheduler;
});

function capture(split: boolean): { hz: number; delivered: number; dropped: number; longestTaskMs: number } {
  let perf: CapturePerf | null = null;
  let queue: OrderedTaskQueue | null = null;
  let overlay: CoalescedTask | null = null;
  const loop: VirtualMainThread = new VirtualMainThread(
    (t) => perf!.imuSample(t),
    () => {
      loop.work(COST.detect);
      if (!split) {
        // The old loop: decode, track and draw inside the frame callback.
        loop.work(COST.decode);
        loop.work(COST.overlay);
        return;
      }
      queue!.push(() => loop.work(COST.decode));
      overlay!.request(() => loop.work(COST.overlay));
    },
  );
  perf = new CapturePerf(() => loop.now);
  // The Prioritized Task Scheduling API, on the virtual thread.
  g.scheduler = {
    postTask: (cb: () => void, opts?: { delay?: number }) => {
      loop.post(cb, opts?.delay ?? 0);
      return Promise.resolve();
    },
  };
  queue = new OrderedTaskQueue("user-visible");
  overlay = new CoalescedTask(OVERLAY_MIN_INTERVAL_MS, "background", () => loop.now);
  loop.run(DURATION_MS);
  const s = perf.snapshot().imu;
  return { hz: s.idleHz ?? 0, delivered: loop.delivered, dropped: loop.dropped, longestTaskMs: loop.longestTaskMs };
}

test("one long task per frame starves the IMU; the prioritized loop keeps it near the sensor rate", () => {
  const before = capture(false);
  const after = capture(true);
  const fmt = (r: typeof before): string =>
    `imu ${r.hz.toFixed(1)} Hz, ${r.dropped} of ${r.delivered + r.dropped} readings dropped, longest task ${r.longestTaskMs.toFixed(0)} ms`;
  console.log(`one task per frame: ${fmt(before)} | prioritized: ${fmt(after)}`);
  // The control reproduces the radiolarian phone: ~15-20 Hz from a 60 Hz sensor.
  assert.ok(before.hz < 25, `control ${before.hz} Hz`);
  assert.ok(before.dropped > before.delivered, "most readings dropped");
  // Split into short tasks, every reading lands between them.
  assert.ok(after.longestTaskMs <= Math.max(COST.decode, COST.overlay, COST.detect) + 1e-9);
  assert.ok(after.hz > 50, `prioritized ${after.hz} Hz`);
  assert.ok(after.dropped < 0.1 * after.delivered, `dropped ${after.dropped}`);
});
