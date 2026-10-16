/**
 * FUG-112 — interim solves on the phone DURING capture, so the registered 3D
 * overlay has something to draw on every capture path.
 *
 * Only a host-solver device (the Pi) runs a continuous solver the app can poll
 * (getLiveMap). An embedded player has none — before this, a capture against
 * one had NO live solve at all, so the overlay could only ever show a prior map
 * seeded at the start of a supplemental scan. The phone already carries the
 * full wasm solver for the final solve; this re-runs it on the observations
 * gathered so far, on a cheaper budget, whenever enough new evidence arrived.
 *
 * Scheduling is duty-cycle bounded: the next solve waits at least
 * max(minIntervalMs, lastDuration · (1/dutyCycle − 1)) after the previous one
 * finished, so a growing problem (slower solves) is re-solved less often and
 * the worker stays mostly idle for the capture loop.
 *
 * The live solve must never slow the capture. The worker runs on another
 * thread, but on a phone it still competes for cores and thermal budget, so
 * the scheduler is also a governor: after every solve the injected `settled`
 * hook reports the camera throughput during it (cv/capturePerf — delivered
 * frames / expected, 1 = nothing lost). A solve that cost frames halves the
 * duty cycle; clean solves win it back gradually; and if solving still costs
 * frames at the floor duty cycle, live solving suspends for the rest of the
 * capture (the overlay keeps the last result; the final solve is unaffected).
 * Pure apart from the injected `run` and clock — unit-tested.
 */

import type { OutputMap } from "@ledmapper/protocol";

export interface LiveSolveOptions {
  /** Don't solve before this many detection records exist. */
  minRecords?: number;
  /** New records needed since the last solve to bother re-solving. */
  minNewRecords?: number;
  /** Floor on the idle time between solves (ms). */
  minIntervalMs?: number;
  /** Max fraction of wall time spent solving (0..1]. */
  dutyCycle?: number;
  /** Called when a solve settles (after `onResult`); returns the camera
   * throughput ratio during it (null = unknown), which governs the duty cycle. */
  settled?: (ok: boolean) => number | null;
}

/** Throughput below this during a solve means it cost camera frames. */
export const IMPACT_RATIO = 0.95;
/** Throughput at or above this lets the duty cycle recover. */
export const CLEAN_RATIO = 0.99;
/** Duty-cycle floor the governor backs off to. */
export const MIN_DUTY_CYCLE = 0.05;
/** Consecutive impacting solves at the floor before live solving suspends. */
export const SUSPEND_AFTER = 3;

/** Cheap reconstruct_vio options for interim solves: fewer keyframes and
 * optimizer evaluations, no outlier-rejection loop. Positions are close enough
 * to draw; the final solve on Stop is unchanged. */
export const LIVE_SOLVE_OPTIONS = { maxKeyframes: 120, maxNfev: 20, rejectOutliers: false } as const;

export class LiveSolveScheduler {
  private busy: Promise<void> | null = null;
  private lastEnd = -Infinity;
  private lastDurationMs = 0;
  private lastRecords = 0;
  private stopped = false;
  private readonly minRecords: number;
  private readonly minNewRecords: number;
  private readonly minIntervalMs: number;
  private readonly maxDutyCycle: number;
  private readonly settled: ((ok: boolean) => number | null) | undefined;
  /** Current duty cycle after governor back-off (≤ the configured one). */
  dutyCycle: number;
  /** Solves started (for the HUD/tests). */
  solves = 0;
  /** Solves the governor judged to have cost camera frames. */
  impacted = 0;
  private impactedAtFloor = 0;
  /** True once live solving gave up for this capture (kept costing frames). */
  suspended = false;

  constructor(
    private readonly run: (recordCount: number) => Promise<OutputMap>,
    private readonly onResult: (map: OutputMap) => void,
    opts: LiveSolveOptions = {},
    private readonly now: () => number = () => performance.now(),
  ) {
    this.minRecords = opts.minRecords ?? 120;
    this.minNewRecords = opts.minNewRecords ?? 60;
    this.minIntervalMs = opts.minIntervalMs ?? 2500;
    this.maxDutyCycle = Math.min(1, Math.max(MIN_DUTY_CYCLE, opts.dutyCycle ?? 0.35));
    this.dutyCycle = this.maxDutyCycle;
    this.settled = opts.settled;
  }

  /** Fold one solve's camera-throughput ratio into the duty cycle. */
  private govern(ratio: number | null): void {
    if (ratio === null) return;
    if (ratio < IMPACT_RATIO) {
      this.impacted++;
      const atFloor = this.dutyCycle <= MIN_DUTY_CYCLE;
      this.dutyCycle = Math.max(MIN_DUTY_CYCLE, this.dutyCycle / 2);
      if (atFloor && ++this.impactedAtFloor >= SUSPEND_AFTER) this.suspended = true;
    } else {
      this.impactedAtFloor = 0;
      if (ratio >= CLEAN_RATIO) this.dutyCycle = Math.min(this.maxDutyCycle, this.dutyCycle * 1.25);
    }
  }

  /** Whether a solve would start now for `recordCount` records. */
  due(recordCount: number): boolean {
    if (this.stopped || this.suspended || this.busy !== null) return false;
    if (recordCount < this.minRecords) return false;
    if (recordCount - this.lastRecords < this.minNewRecords) return false;
    const idle = Math.max(this.minIntervalMs, this.lastDurationMs * (1 / this.dutyCycle - 1));
    return this.now() - this.lastEnd >= idle;
  }

  /** Call periodically with the current record count; starts a solve when due.
   * Returns true when one was started. A failed interim solve (too few frames
   * yet, a divergence) is ignored — the next one will try again. */
  tick(recordCount: number): boolean {
    if (!this.due(recordCount)) return false;
    const t0 = this.now();
    this.lastRecords = recordCount;
    this.solves++;
    let ok = false;
    this.busy = this.run(recordCount)
      .then((map) => {
        ok = true;
        if (!this.stopped) this.onResult(map);
      })
      .catch(() => undefined)
      .finally(() => {
        const t1 = this.now();
        this.lastDurationMs = t1 - t0;
        this.lastEnd = t1;
        this.busy = null;
        let ratio: number | null = null;
        try {
          ratio = this.settled?.(ok) ?? null;
        } catch {
          // Instrumentation must never break scheduling.
        }
        this.govern(ratio);
      });
    return true;
  }

  /** Stop scheduling and wait for an in-flight solve to finish (so the final
   * solve gets the worker to itself). Its result is discarded. */
  async stop(): Promise<void> {
    this.stopped = true;
    await this.busy;
  }
}
