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
 * the worker stays mostly idle for the capture loop. Pure apart from the
 * injected `run` and clock — unit-tested.
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
}

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
  private readonly dutyCycle: number;
  /** Solves started (for the HUD/tests). */
  solves = 0;

  constructor(
    private readonly run: (recordCount: number) => Promise<OutputMap>,
    private readonly onResult: (map: OutputMap) => void,
    opts: LiveSolveOptions = {},
    private readonly now: () => number = () => performance.now(),
  ) {
    this.minRecords = opts.minRecords ?? 120;
    this.minNewRecords = opts.minNewRecords ?? 60;
    this.minIntervalMs = opts.minIntervalMs ?? 2500;
    this.dutyCycle = Math.min(1, Math.max(0.05, opts.dutyCycle ?? 0.35));
  }

  /** Whether a solve would start now for `recordCount` records. */
  due(recordCount: number): boolean {
    if (this.stopped || this.busy !== null) return false;
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
    this.busy = this.run(recordCount)
      .then((map) => {
        if (!this.stopped) this.onResult(map);
      })
      .catch(() => undefined)
      .finally(() => {
        const t1 = this.now();
        this.lastDurationMs = t1 - t0;
        this.lastEnd = t1;
        this.busy = null;
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
