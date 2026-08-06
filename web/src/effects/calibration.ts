/**
 * Calibration orchestration (docs/design/perf-monitoring.md §"Calibration
 * flow"). Runs the micro-benchmarks on a connected device and fits a cost
 * table:
 *   1. compile each benchmark `.fxb` in-browser,
 *   2. abstract-interpret it for the predicted opcode counts,
 *   3. upload + activate it, set_perf(FULL), read back a stable PerfReport,
 *   4. least-squares fit opcode costs + fixed overheads,
 *   5. produce a StoredCostTable (metadata + observations for re-derivation),
 *   6. the caller restores the user's effect.
 *
 * Browser-only at RUNTIME (device + compiler wasm) but module-safe under the
 * CJS test build: the compiler is loaded via fx/preview's dynamic import; no
 * import.meta here.
 */

import { compileScript } from "../fx/preview";
import { parseFxb, walkEntry, costFor, OPCODE_NAMES } from "./costModel";
import type { OpHistogram } from "./costModel";
import {
  benchmarksForTier,
  FITTED_OPCODES,
  type Benchmark,
  type BenchTier,
} from "./calibrationBenchmarks";
import { fitCosts, presentFeatures, type BenchSample } from "./calibrationFit";
import {
  BUDGET_MS,
  CURRENT_TABLE_VERSION,
  DEFAULT_COSTS,
  DEFAULT_CPU_HZ,
  DEFAULT_FIXED,
  DEFAULT_SOC,
  type CalibObservation,
  type StoredCostTable,
} from "../store/costTableStore";
import type { LedMapperClient } from "../net/client";
import type { PerfReportMessage } from "../net/proto";

/** A device driver seam so calibration is testable with a fake. */
export interface CalibDevice {
  submitEffect(effectId: string, fxb: Uint8Array, activate: boolean): Promise<unknown>;
  setPerf(mode: "OFF" | "BASIC" | "FULL", intervalMs: number): Promise<PerfReportMessage>;
  getPerfReport(): Promise<PerfReportMessage>;
}

export interface CalibProgress {
  step: number;
  total: number;
  label: string;
  /** live measured cycles for the current benchmark's target op, if known. */
  detail?: string;
}

/** Wrap the real client as a CalibDevice. */
export function clientDevice(client: LedMapperClient): CalibDevice {
  return {
    submitEffect: (id, fxb, act) => client.submitEffect(id, fxb, act),
    setPerf: (mode, iv) => client.setPerf(mode, iv),
    getPerfReport: () => client.getPerfReport(),
  };
}

/**
 * Abstract-interpret a benchmark's shade() opcode histogram (lane-weighted),
 * summed as the count for ONE shade() call. Uses the max-arm walk (benchmarks
 * are straight-line so min==max).
 */
function shadeHistogram(fxb: Uint8Array): OpHistogram {
  const hdr = parseFxb(fxb);
  return walkEntry(hdr.code, hdr.shadeEntry).max;
}

/** FNV-1a 32-bit truncated hash of the bytecode (pins observations to a build). */
function hashFxb(fxb: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < fxb.length; i++) {
    h ^= fxb[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Average a PerfReport's window means; returns null if the report looks empty. */
function stableCycles(r: PerfReportMessage): {
  frame: number;
  show: number;
  led: number;
  instrShade: number;
  stackMax: number;
} | null {
  const led = r.ticks.length > 0 ? r.ticks[r.ticks.length - 1]!.ledCount : 0;
  const instrShade = r.ticks.length > 0 ? r.ticks[r.ticks.length - 1]!.instrShade : 0;
  const stackMax = r.ticks.length > 0 ? r.ticks[r.ticks.length - 1]!.stackMax : 0;
  if (r.frameCyclesMean === 0 && (r.ticks.length === 0 || r.ticks[r.ticks.length - 1]!.frameCycles === 0))
    return null;
  const frame = r.frameCyclesMean || (r.ticks.length > 0 ? r.ticks[r.ticks.length - 1]!.frameCycles : 0);
  const show = r.showCyclesMean || (r.ticks.length > 0 ? r.ticks[r.ticks.length - 1]!.showCycles : 0);
  return { frame, show, led, instrShade, stackMax };
}

export interface CalibrationResult {
  table: StoredCostTable;
  observations: CalibObservation[];
  /** cpu_hz read back from the device. */
  cpuHz: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Run the full calibration. Uploads/samples each benchmark, fits, and returns a
 * StoredCostTable. `onProgress` drives the progress UI. `settleMs` is how long
 * to let the device warm up before draining a stable window per benchmark.
 */
export async function runCalibration(
  device: CalibDevice,
  opts: {
    deviceLabel: string;
    firmwareBuild?: string;
    onProgress?: (p: CalibProgress) => void;
    settleMs?: number;
    /** Which benchmark tier to run. `full` (default) sweeps every opcode →
     * 100% coverage; `core` is a faster cost-dominant subset. */
    tier?: BenchTier;
  },
): Promise<CalibrationResult> {
  const settleMs = opts.settleMs ?? 800;
  const benchmarks = benchmarksForTier(opts.tier ?? "full");
  const total = benchmarks.length;
  const samples: BenchSample[] = [];
  const observations: CalibObservation[] = [];
  let cpuHz = DEFAULT_CPU_HZ;

  for (let i = 0; i < benchmarks.length; i++) {
    const b: Benchmark = benchmarks[i]!;
    opts.onProgress?.({ step: i, total, label: `measuring ${b.label}…` });

    const compiled = await compileScript(b.source);
    if (!compiled.ok) {
      // A benchmark that doesn't compile is skipped (shouldn't happen); keep going.
      continue;
    }
    const fxb = compiled.bytecode;
    const hist = shadeHistogram(fxb);
    const hash = hashFxb(fxb);

    await device.submitEffect(`__calib_${b.id}`, fxb, true);
    await device.setPerf("FULL", 0);
    await sleep(settleMs);
    const report = await device.getPerfReport();
    if (report.cpuHz > 0) cpuHz = report.cpuHz;
    const stable = stableCycles(report);
    if (!stable) continue;

    // predicted with the DEFAULT table (for the observation record + a coarse
    // "measuring… N cyc" tick); the real fit uses measured cycles vs counts.
    const predicted = predictWithDefault(hist, stable.led);
    observations.push({
      bytecodeHash: hash,
      label: b.label,
      predicted,
      measured: stable.frame + stable.show,
    });
    opts.onProgress?.({
      step: i,
      total,
      label: b.label,
      detail: b.targetOp
        ? `${b.targetOp}: ${Math.round(stable.frame / Math.max(1, stable.led))} cyc/LED`
        : `${Math.round((stable.frame + stable.show) / 1000)}k cyc`,
    });

    // Build the fit row: per-LED op counts × led_count = total shade counts.
    const opCounts: Record<string, number> = {};
    for (const [op, n] of Object.entries(hist)) opCounts[op] = n * stable.led;
    samples.push({
      label: b.label,
      opCounts,
      updateRuns: 1,
      shadeRuns: stable.led,
      ledCount: stable.led,
      measuredFrameCycles: stable.frame,
      measuredShowCycles: stable.show,
      bytecodeHash: hash,
    });
  }

  await device.setPerf("OFF", 0);

  // Fit only the opcodes this run actually measured (presence-aware), so a
  // partial/`core` run never zeroes an op it didn't exercise.
  const fitted = presentFeatures(samples, FITTED_OPCODES);
  const fit = fitCosts(samples, fitted);
  // Merge: measured opcodes override the default table; everything else
  // (unfit + not-measured) keeps its seeded default.
  const costs: Record<string, number> = { ...DEFAULT_COSTS };
  for (const op of fitted) {
    if (op in fit.costs && Number.isFinite(fit.costs[op])) costs[op] = fit.costs[op]!;
  }
  const fixed = {
    update_fixed: pickFinite(fit.fixed.update_fixed, DEFAULT_FIXED.update_fixed),
    shade_fixed: pickFinite(fit.fixed.shade_fixed, DEFAULT_FIXED.shade_fixed),
    show_fixed: pickFinite(fit.fixed.show_fixed, DEFAULT_FIXED.show_fixed),
    show_per_led: pickFinite(fit.fixed.show_per_led, DEFAULT_FIXED.show_per_led),
  };

  const table: StoredCostTable = {
    id: `${DEFAULT_SOC}@${cpuHz}#${CURRENT_TABLE_VERSION}`,
    soc: DEFAULT_SOC,
    cpuHz,
    tableVersion: CURRENT_TABLE_VERSION,
    firmwareBuild: opts.firmwareBuild ?? "unknown",
    timestamp: new Date().toISOString(),
    residualError: fit.residualError,
    budgetMs: BUDGET_MS,
    fallbackCost: 8,
    costs,
    fixedOverhead: fixed,
    observations,
    deviceLabel: opts.deviceLabel,
    origin: "calibrated",
  };
  opts.onProgress?.({ step: total, total, label: "fitting model…" });
  return { table, observations, cpuHz };
}

function pickFinite(v: number, fallback: number): number {
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function predictWithDefault(hist: OpHistogram, ledCount: number): number {
  let perLed = 0;
  // costFor resolves math sub-keys (UnMath:sqrt) through the family base.
  for (const [op, n] of Object.entries(hist)) perLed += n * costFor(DEFAULT_COSTS, op, 8);
  return DEFAULT_FIXED.update_fixed + ledCount * (DEFAULT_FIXED.shade_fixed + perLed);
}

void OPCODE_NAMES;
