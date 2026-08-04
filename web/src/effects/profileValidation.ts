/**
 * Cost-model validation (FUG-11 review: "validate that the cost estimator
 * together with the fitted model correctly predicts the execution cost of the
 * program on the actual hardware").
 *
 * After the HITL device benchmark fits a cost table from calibration
 * micro-programs, we must check it PREDICTS held-out programs — ones NOT in the
 * fit — against what the real hardware measured. This module is the pure,
 * shared scoring: given a fitted {@link CostTable} and a set of held-out
 * samples (each a compiled `.fxb`, its LED count, and the frame time the device
 * measured), it runs the offline estimator and reports the predicted-vs-measured
 * error. That error becomes the profile's `measuredError` — the trustworthy
 * accuracy signal (vs `residualError`, an in-sample fit quality).
 *
 * Pure + CJS-safe: the harness (pi/hitl) supplies the measured samples; this
 * runs under node:test and in the browser identically.
 */

import { estimateFrameTime, type CostTable } from "./costModel";

/** One held-out measurement: a compiled program the device ran, its LED count,
 * and the frame wall-time the device measured (ms; from a PerfReport's
 * (frame + show) cycles / cpu_hz). NOT used in the fit. */
export interface HeldoutSample {
  label: string;
  bytecode: Uint8Array;
  ledCount: number;
  /** Measured total frame time on real hardware, ms. */
  measuredMs: number;
}

/** Per-sample predicted-vs-measured result. */
export interface SampleResult {
  label: string;
  ledCount: number;
  measuredMs: number;
  predictedMs: number;
  /** Signed relative error (predicted - measured) / measured. */
  relError: number;
  /** |relError|. */
  absRelError: number;
}

/** Aggregate validation verdict for a fitted model. */
export interface ValidationResult {
  samples: SampleResult[];
  /** Mean |relative error| across samples (0..∞). */
  meanAbsError: number;
  /** RMS relative error — the headline `measuredError` (0..∞). */
  rmsError: number;
  /** Worst |relative error|. */
  maxAbsError: number;
  /** Coefficient of determination R² of predicted vs measured (can be < 0). */
  r2: number;
  /** True if the model predicts within `tolerance` on RMS (fit is trustworthy). */
  passed: boolean;
  /** The tolerance used for `passed`. */
  tolerance: number;
}

/**
 * Score a fitted cost table against held-out hardware measurements.
 * `tolerance` (default 0.15) is the RMS relative-error bar for `passed`.
 */
export function validateCostModel(
  table: CostTable,
  samples: HeldoutSample[],
  tolerance = 0.15,
): ValidationResult {
  const results: SampleResult[] = samples.map((s) => {
    const est = estimateFrameTime({ bytecode: s.bytecode, ledCount: s.ledCount, table });
    const predictedMs = est.totalMs;
    const relError = s.measuredMs > 0 ? (predictedMs - s.measuredMs) / s.measuredMs : 0;
    return {
      label: s.label,
      ledCount: s.ledCount,
      measuredMs: s.measuredMs,
      predictedMs,
      relError,
      absRelError: Math.abs(relError),
    };
  });

  const n = results.length;
  const meanAbsError = n > 0 ? results.reduce((a, r) => a + r.absRelError, 0) / n : 0;
  const rmsError =
    n > 0 ? Math.sqrt(results.reduce((a, r) => a + r.relError * r.relError, 0) / n) : 0;
  const maxAbsError = results.reduce((a, r) => Math.max(a, r.absRelError), 0);
  const r2 = rSquared(results);

  return {
    samples: results,
    meanAbsError,
    rmsError,
    maxAbsError,
    r2,
    passed: n > 0 && rmsError <= tolerance,
    tolerance,
  };
}

/** R² of predicted vs measured frame times (1 = perfect; ≤0 = worse than the
 * mean). A high R² means the model tracks the hardware across programs. */
function rSquared(results: SampleResult[]): number {
  const n = results.length;
  if (n === 0) return 0;
  const mean = results.reduce((a, r) => a + r.measuredMs, 0) / n;
  let ssRes = 0;
  let ssTot = 0;
  for (const r of results) {
    ssRes += (r.measuredMs - r.predictedMs) ** 2;
    ssTot += (r.measuredMs - mean) ** 2;
  }
  if (ssTot === 0) return ssRes === 0 ? 1 : 0;
  return 1 - ssRes / ssTot;
}

/** The `measuredError` to stamp on a profile: the validation RMS error (0..1
 * clamped), i.e. the held-out accuracy band. */
export function measuredErrorFrom(v: ValidationResult): number {
  return Math.min(1, Math.max(0, v.rmsError));
}
