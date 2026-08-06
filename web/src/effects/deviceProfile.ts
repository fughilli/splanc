/**
 * Device execution-profile builder (FUG-11 review: "Use the HITL rig to do the
 * actual … measurements against the real hardware … validate that the cost
 * estimator together with the fitted model correctly predicts the execution
 * cost of the program on the actual hardware").
 *
 * The HITL harness (pi/hitl/harness/fx_bench.py) flashes the real C6, runs the
 * calibration micro-programs, and records cycle-accurate PerfReports into a
 * raw {@link DeviceBenchmarkBundle}. This module turns that bundle into an
 * AUTHORITATIVE {@link ExecutionProfile} (`source: "device"`) by reusing the
 * SAME least-squares fit as the in-browser calibration ({@link fitCosts}), then
 * VALIDATES it against held-out programs the fit never saw ({@link
 * validateCostModel}) and stamps the resulting held-out error as the profile's
 * `measuredError`.
 *
 * It is Node-safe (no compiler wasm, no device, no DOM): opcode counts come
 * from abstract-interpreting the supplied `.fxb` bytes, so the harness only has
 * to ship bytecode + measured cycles. This is the pure, testable core; the
 * hardware collection lives in the Python harness.
 */

import { parseFxb, walkEntry, type OpHistogram } from "./costModel";
import { fitCosts, presentFeatures, type BenchSample } from "./calibrationFit";
import { FITTED_OPCODES } from "./calibrationBenchmarks";
import {
  costTableToProfile,
  type ExecutionProfile,
} from "./executionProfile";
import { validateCostModel, measuredErrorFrom, type HeldoutSample } from "./profileValidation";
import { DEFAULT_BUDGET_MODEL, type BudgetModel, type CostTable } from "./costModel";
import {
  BUDGET_MS,
  DEFAULT_COSTS,
  DEFAULT_CPU_HZ,
  DEFAULT_FIXED,
  DEFAULT_SOC,
} from "../store/costTableStore";

/** One measured micro-program from a real device run. `fxb` is the exact
 * bytecode that ran; `measuredFrameCycles`/`measuredShowCycles` are the stable
 * window means from its PerfReport. */
export interface DeviceSample {
  label: string;
  fxb: Uint8Array;
  ledCount: number;
  measuredFrameCycles: number;
  measuredShowCycles: number;
}

/** Raw device benchmark bundle emitted by the HITL harness. */
export interface DeviceBenchmarkBundle {
  soc: string;
  cpuHz: number;
  /** Stable device identity (hardware MAC / id) for a per-device profile. */
  deviceKey?: string;
  deviceLabel?: string;
  firmwareBuild?: string;
  timestamp?: string;
  budget?: BudgetModel;
  /** Benchmarks used to FIT the cost table (single-op isolation + overhead). */
  fit: DeviceSample[];
  /** HELD-OUT programs (not in the fit) for predicted-vs-measured validation. */
  heldout: DeviceSample[];
}

/** FNV-1a 32-bit hash (mirrors calibration.ts) so observations pin to a build. */
function hashFxb(fxb: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < fxb.length; i++) {
    h ^= fxb[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Abstract-interpret a program's shade() opcode histogram (one shade() call). */
function shadeHistogram(fxb: Uint8Array): OpHistogram {
  const hdr = parseFxb(fxb);
  return walkEntry(hdr.code, hdr.shadeEntry).max;
}

function pickFinite(v: number, fallback: number): number {
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export interface DeviceProfileResult {
  profile: ExecutionProfile;
  /** Validation of the fitted table against the held-out samples. */
  validation: ReturnType<typeof validateCostModel>;
  /** The runtime cost table (also inside the profile). */
  table: CostTable;
}

/**
 * Build + validate a device profile from a raw measurement bundle. Reuses the
 * calibration fit for the cost table, then validates on the held-out set and
 * stamps `measuredError`. `tolerance` is the RMS bar for the validation verdict.
 */
export function buildDeviceProfile(
  bundle: DeviceBenchmarkBundle,
  tolerance = 0.15,
): DeviceProfileResult {
  const cpuHz = bundle.cpuHz > 0 ? bundle.cpuHz : DEFAULT_CPU_HZ;
  const soc = bundle.soc || DEFAULT_SOC;

  // Build fit rows from the measured samples (opcode counts from the bytecode).
  const samples: BenchSample[] = bundle.fit.map((s) => {
    const hist = shadeHistogram(s.fxb);
    const opCounts: Record<string, number> = {};
    for (const [op, n] of Object.entries(hist)) opCounts[op] = n * s.ledCount;
    return {
      label: s.label,
      opCounts,
      updateRuns: 1,
      shadeRuns: s.ledCount,
      ledCount: s.ledCount,
      measuredFrameCycles: s.measuredFrameCycles,
      measuredShowCycles: s.measuredShowCycles,
      bytecodeHash: hashFxb(s.fxb),
    };
  });

  // Fit only opcodes the bundle actually measured (presence-aware), so an op a
  // run didn't exercise keeps its seeded default rather than being zeroed.
  const fitted = presentFeatures(samples, FITTED_OPCODES);
  const fit = fitCosts(samples, fitted);
  // Measured opcodes override the default table; everything else keeps defaults.
  const costs: Record<string, number> = { ...DEFAULT_COSTS };
  for (const op of fitted) {
    if (op in fit.costs && Number.isFinite(fit.costs[op]!)) costs[op] = fit.costs[op]!;
  }
  const budget: BudgetModel = bundle.budget ?? { ...DEFAULT_BUDGET_MODEL };
  const table: CostTable = {
    soc,
    cpuHz,
    budgetMs: budget.fps > 0 ? 1000 / budget.fps : BUDGET_MS,
    costs,
    fixed: {
      update_fixed: pickFinite(fit.fixed.update_fixed, DEFAULT_FIXED.update_fixed),
      shade_fixed: pickFinite(fit.fixed.shade_fixed, DEFAULT_FIXED.shade_fixed),
      show_fixed: pickFinite(fit.fixed.show_fixed, DEFAULT_FIXED.show_fixed),
      show_per_led: pickFinite(fit.fixed.show_per_led, DEFAULT_FIXED.show_per_led),
    },
    residualError: fit.residualError,
    fallbackCost: 8,
    budget,
  };

  // Validate on the held-out programs the fit never saw.
  const heldoutSamples: HeldoutSample[] = bundle.heldout.map((s) => ({
    label: s.label,
    bytecode: s.fxb,
    ledCount: s.ledCount,
    measuredMs: ((s.measuredFrameCycles + s.measuredShowCycles) / cpuHz) * 1000,
  }));
  const validation = validateCostModel(table, heldoutSamples, tolerance);

  // Observations: every measured program (fit + held-out) for re-derivation.
  const observations = [...bundle.fit, ...bundle.heldout].map((s) => ({
    label: s.label,
    targetOp: null,
    reps: 0,
    ledCount: s.ledCount,
    measured: s.measuredFrameCycles + s.measuredShowCycles,
  }));

  const profile = costTableToProfile(table, {
    source: "device",
    toolVersion: "hitl-fx-bench 1",
    timestamp: bundle.timestamp ?? "",
    deviceLabel: bundle.deviceLabel ?? "",
    observations,
    ...(bundle.deviceKey !== undefined ? { deviceKey: bundle.deviceKey } : {}),
    ...(bundle.firmwareBuild !== undefined ? { firmwareBuild: bundle.firmwareBuild } : {}),
    ...(heldoutSamples.length > 0 ? { measuredError: measuredErrorFrom(validation) } : {}),
  });

  return { profile, validation, table };
}

// -- bundle JSON I/O (base64 bytecode, cross-env) ----------------------------

function b64decode(s: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(s, "base64"));
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64encode(b: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(b).toString("base64");
  let bin = "";
  for (const byte of b) bin += String.fromCharCode(byte);
  return btoa(bin);
}

interface SampleJson {
  label: string;
  fxbBase64: string;
  ledCount: number;
  measuredFrameCycles: number;
  measuredShowCycles: number;
}

/** Parse the harness's JSON bundle (base64 `.fxb`) into a {@link
 * DeviceBenchmarkBundle}. Throws on malformed input. */
export function parseDeviceBundle(json: string): DeviceBenchmarkBundle {
  const o = JSON.parse(json) as Record<string, unknown>;
  if (o["kind"] !== "ledmapper-device-benchmark") throw new Error("not a device-benchmark bundle");
  const sample = (v: unknown): DeviceSample => {
    const s = v as SampleJson;
    return {
      label: String(s.label),
      fxb: b64decode(s.fxbBase64),
      ledCount: Number(s.ledCount),
      measuredFrameCycles: Number(s.measuredFrameCycles),
      measuredShowCycles: Number(s.measuredShowCycles),
    };
  };
  const bundle: DeviceBenchmarkBundle = {
    soc: String(o["soc"] ?? DEFAULT_SOC),
    cpuHz: Number(o["cpuHz"] ?? DEFAULT_CPU_HZ),
    fit: Array.isArray(o["fit"]) ? (o["fit"] as unknown[]).map(sample) : [],
    heldout: Array.isArray(o["heldout"]) ? (o["heldout"] as unknown[]).map(sample) : [],
  };
  if (typeof o["deviceKey"] === "string") bundle.deviceKey = o["deviceKey"];
  if (typeof o["deviceLabel"] === "string") bundle.deviceLabel = o["deviceLabel"];
  if (typeof o["firmwareBuild"] === "string") bundle.firmwareBuild = o["firmwareBuild"];
  if (typeof o["timestamp"] === "string") bundle.timestamp = o["timestamp"];
  if (o["budget"] && typeof o["budget"] === "object") bundle.budget = o["budget"] as BudgetModel;
  return bundle;
}

/** Serialize a bundle to the harness JSON shape (base64 `.fxb`). */
export function serializeDeviceBundle(bundle: DeviceBenchmarkBundle): string {
  const sample = (s: DeviceSample): SampleJson => ({
    label: s.label,
    fxbBase64: b64encode(s.fxb),
    ledCount: s.ledCount,
    measuredFrameCycles: s.measuredFrameCycles,
    measuredShowCycles: s.measuredShowCycles,
  });
  return JSON.stringify(
    {
      kind: "ledmapper-device-benchmark",
      version: 1,
      soc: bundle.soc,
      cpuHz: bundle.cpuHz,
      deviceKey: bundle.deviceKey,
      deviceLabel: bundle.deviceLabel,
      firmwareBuild: bundle.firmwareBuild,
      timestamp: bundle.timestamp,
      budget: bundle.budget,
      fit: bundle.fit.map(sample),
      heldout: bundle.heldout.map(sample),
    },
    null,
    2,
  );
}
