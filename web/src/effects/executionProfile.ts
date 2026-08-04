/**
 * Common execution-profile format (FUG-11: "Export a common profile format so
 * that different execution targets can feed their profiles into the simulator
 * in a uniform way").
 *
 * An {@link ExecutionProfile} is the single, versioned, portable artifact that
 * ANY execution target emits and the offline simulator (costModel.ts) consumes:
 *
 *   - the **semihost benchmark** (tools/fx_semihost_bench, a host binary that
 *     runs the real firmware VM over calibration micro-programs) emits one with
 *     `source: "semihost"` — a usable per-opcode cost model with NO hardware;
 *   - the **on-device calibration** flow (calibrate.ts + PerfReport) emits one
 *     with `source: "device"` — cycle-accurate for that board;
 *   - the shipped **default** table is `source: "default"`.
 *
 * All three share this schema, so the estimator, the budget bar, and the AI
 * loop don't care which target produced the numbers. Every profile carries
 * provenance metadata AND the raw experimental OBSERVATIONS, per the
 * perf-monitoring.md multi-SoC DECISION ("save/restore models … including the
 * direct experimental observations so they can be rederived if the modeling
 * approach changes").
 *
 * The Rust semihost benchmark serializes the identical JSON shape (serde,
 * camelCase top-level + snake_case `fixed` to match {@link FixedOverhead}); see
 * tools/fx_semihost_bench and the golden at web/tests/testdata. Keep the two in
 * sync.
 *
 * Pure + CJS-safe (no DOM / import.meta) so it runs under the node:test build.
 */

import {
  DEFAULT_BUDGET_MODEL,
  OPCODE_NAMES,
  type BudgetModel,
  type CostMap,
  type CostTable,
  type FixedOverhead,
} from "./costModel";
import {
  DEFAULT_COSTS,
  DEFAULT_CPU_HZ,
  DEFAULT_FIXED,
  DEFAULT_SOC,
  type StoredCostTable,
} from "../store/costTableStore";

/** Canonical VM opcode names in discriminant order — the profile's `costs` map
 * is keyed by these, and a complete profile covers all of them. Reuses
 * costModel.ts's `OPCODE_NAMES` (the VM-mirrored list) so the format can't drift
 * from the abstract interpreter's opcode set. */
export const CANONICAL_OPCODES = OPCODE_NAMES;

export type CanonicalOpcode = (typeof CANONICAL_OPCODES)[number];

/** Which kind of target measured a profile. */
export type ProfileSource = "device" | "semihost" | "default";

/** Unit the `costs` are expressed in. `cycles` = target CPU cycles (the
 * simulator converts to ms via `cpuHz`). The semihost benchmark normalizes its
 * host-nanosecond measurements to device-equivalent cycles via `cpuHz`. */
export type ProfileUnit = "cycles";

/** One raw benchmark measurement, kept so the model can be re-fit under a new
 * form. Mirrors the Rust `Observation` and the store's `CalibObservation`. */
export interface ProfileObservation {
  /** Human label ("Mul x64", "empty shade", "transmit @128"). */
  label: string;
  /** Opcode this bench isolates, or null for a fixed/overhead/sweep bench. */
  targetOp: string | null;
  /** Opcode repetitions in the micro-program (the M/2M slope points), or 0. */
  reps: number;
  /** LED count the bench ran at. */
  ledCount: number;
  /** Measured cost in the profile's `unit` (cycles). */
  measured: number;
  /** Model prediction at fit time (device calibration bookkeeping), if any. */
  predicted?: number;
}

export const PROFILE_KIND = "ledmapper-execution-profile";
export const PROFILE_VERSION = 1;

/** The portable, cross-target execution profile (FUG-11 "common profile
 * format"). Serializes to JSON that the Rust semihost benchmark also emits. */
export interface ExecutionProfile {
  kind: typeof PROFILE_KIND;
  version: number;
  // -- provenance -----------------------------------------------------------
  soc: string;
  source: ProfileSource;
  cpuHz: number;
  unit: ProfileUnit;
  /** Producer + version ("fx-semihost-bench 0.1.0", "web-calibrate 1"). */
  toolVersion: string;
  /** ISO timestamp, or "" when the producer has no clock (deterministic run). */
  timestamp: string;
  firmwareBuild?: string;
  deviceLabel?: string;
  // -- cost model -----------------------------------------------------------
  /** Per-opcode SCALAR (per-lane) cost, keyed by {@link CANONICAL_OPCODES}. */
  costs: CostMap;
  fixed: FixedOverhead;
  /** Cheap-op fallback cost for opcodes absent from `costs`. */
  fallbackCost: number;
  /** Fit residual as a fraction (0..1). Semihost profiles carry a wide band
   * (host != device); device calibration tightens it. */
  residualError: number;
  // -- budget model (FUG-11) ------------------------------------------------
  budget: BudgetModel;
  // -- raw observations (re-derivable) --------------------------------------
  observations: ProfileObservation[];
}

// -- validation --------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
function num(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`profile: ${field} must be a finite number`);
  return v;
}
function str(v: unknown, field: string): string {
  if (typeof v !== "string") throw new Error(`profile: ${field} must be a string`);
  return v;
}

function validFixed(v: unknown): FixedOverhead {
  if (!isRecord(v)) throw new Error("profile: fixed must be an object");
  return {
    update_fixed: num(v["update_fixed"], "fixed.update_fixed"),
    shade_fixed: num(v["shade_fixed"], "fixed.shade_fixed"),
    show_fixed: num(v["show_fixed"], "fixed.show_fixed"),
    show_per_led: num(v["show_per_led"], "fixed.show_per_led"),
  };
}

function validBudget(v: unknown): BudgetModel {
  if (!isRecord(v)) return { ...DEFAULT_BUDGET_MODEL };
  return {
    fps: num(v["fps"], "budget.fps"),
    cpuAvailableFraction: num(v["cpuAvailableFraction"], "budget.cpuAvailableFraction"),
    transmitReservesCpu: Boolean(v["transmitReservesCpu"]),
  };
}

function validCosts(v: unknown): CostMap {
  if (!isRecord(v)) throw new Error("profile: costs must be an object");
  const out: CostMap = {};
  for (const [k, val] of Object.entries(v)) out[k] = num(val, `costs.${k}`);
  return out;
}

function validObservations(v: unknown): ProfileObservation[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new Error("profile: observations must be an array");
  return v.map((o, i) => {
    if (!isRecord(o)) throw new Error(`profile: observations[${i}] must be an object`);
    const targetOp = o["targetOp"];
    const obs: ProfileObservation = {
      label: str(o["label"], `observations[${i}].label`),
      targetOp: targetOp === null || targetOp === undefined ? null : str(targetOp, `observations[${i}].targetOp`),
      reps: num(o["reps"], `observations[${i}].reps`),
      ledCount: num(o["ledCount"], `observations[${i}].ledCount`),
      measured: num(o["measured"], `observations[${i}].measured`),
    };
    if (typeof o["predicted"] === "number") obs.predicted = o["predicted"];
    return obs;
  });
}

/** Validate an unknown value as an {@link ExecutionProfile}. Throws with a
 * field-specific message on any malformation. */
export function validateProfile(v: unknown): ExecutionProfile {
  if (!isRecord(v)) throw new Error("profile: not an object");
  if (v["kind"] !== PROFILE_KIND) throw new Error("profile: bad kind");
  const version = num(v["version"], "version");
  if (version !== PROFILE_VERSION) throw new Error(`profile: unsupported version ${version}`);
  const source = str(v["source"], "source");
  if (source !== "device" && source !== "semihost" && source !== "default")
    throw new Error(`profile: bad source ${source}`);
  const unit = str(v["unit"], "unit");
  if (unit !== "cycles") throw new Error(`profile: unsupported unit ${unit}`);
  const p: ExecutionProfile = {
    kind: PROFILE_KIND,
    version: PROFILE_VERSION,
    soc: str(v["soc"], "soc"),
    source,
    cpuHz: num(v["cpuHz"], "cpuHz"),
    unit,
    toolVersion: str(v["toolVersion"], "toolVersion"),
    timestamp: v["timestamp"] === undefined ? "" : str(v["timestamp"], "timestamp"),
    costs: validCosts(v["costs"]),
    fixed: validFixed(v["fixed"]),
    fallbackCost: num(v["fallbackCost"], "fallbackCost"),
    residualError: num(v["residualError"], "residualError"),
    budget: validBudget(v["budget"]),
    observations: validObservations(v["observations"]),
  };
  if (typeof v["firmwareBuild"] === "string") p.firmwareBuild = v["firmwareBuild"];
  if (typeof v["deviceLabel"] === "string") p.deviceLabel = v["deviceLabel"];
  return p;
}

/** Parse an execution-profile JSON document. Throws on malformed input. */
export function parseProfile(json: string): ExecutionProfile {
  return validateProfile(JSON.parse(json));
}

/** Serialize a profile to canonical JSON (stable key order for golden diffs). */
export function serializeProfile(p: ExecutionProfile): string {
  return JSON.stringify(p, null, 2);
}

// -- conversion to/from the simulator's CostTable ----------------------------

/** Turn a profile into the runtime {@link CostTable} the estimator consumes. */
export function profileToCostTable(p: ExecutionProfile): CostTable {
  return {
    soc: p.soc,
    cpuHz: p.cpuHz,
    budgetMs: 1000 / (p.budget.fps > 0 ? p.budget.fps : DEFAULT_BUDGET_MODEL.fps),
    costs: { ...p.costs },
    fixed: { ...p.fixed },
    residualError: p.residualError,
    fallbackCost: p.fallbackCost,
    budget: { ...p.budget },
  };
}

/** Build a profile from a runtime cost table + provenance (e.g. to export a
 * device calibration or the default table in the common format). */
export function costTableToProfile(
  table: CostTable,
  meta: {
    source: ProfileSource;
    toolVersion: string;
    timestamp?: string;
    firmwareBuild?: string;
    deviceLabel?: string;
    observations?: ProfileObservation[];
  },
): ExecutionProfile {
  const p: ExecutionProfile = {
    kind: PROFILE_KIND,
    version: PROFILE_VERSION,
    soc: table.soc,
    source: meta.source,
    cpuHz: table.cpuHz,
    unit: "cycles",
    toolVersion: meta.toolVersion,
    timestamp: meta.timestamp ?? "",
    costs: { ...table.costs },
    fixed: { ...table.fixed },
    fallbackCost: table.fallbackCost,
    residualError: table.residualError,
    budget: { ...(table.budget ?? DEFAULT_BUDGET_MODEL) },
    observations: meta.observations ?? [],
  };
  if (meta.firmwareBuild !== undefined) p.firmwareBuild = meta.firmwareBuild;
  if (meta.deviceLabel !== undefined) p.deviceLabel = meta.deviceLabel;
  return p;
}

/** The shipped default profile, expressed in the common format so even the
 * fallback flows through the same path. */
export function defaultProfile(soc = DEFAULT_SOC, cpuHz = DEFAULT_CPU_HZ): ExecutionProfile {
  return {
    kind: PROFILE_KIND,
    version: PROFILE_VERSION,
    soc,
    source: "default",
    cpuHz,
    unit: "cycles",
    toolVersion: "web-default 1",
    timestamp: "",
    costs: { ...DEFAULT_COSTS },
    fixed: { ...DEFAULT_FIXED },
    fallbackCost: 8,
    residualError: 0.25,
    budget: { ...DEFAULT_BUDGET_MODEL },
    observations: [],
  };
}

/** Coverage report: which canonical opcodes a profile does/doesn't price. Used
 * to warn when a benchmark run missed opcodes (they ride the fallback cost). */
export function opcodeCoverage(p: ExecutionProfile): { covered: string[]; missing: string[] } {
  const covered: string[] = [];
  const missing: string[] = [];
  for (const op of CANONICAL_OPCODES) {
    if (typeof p.costs[op] === "number") covered.push(op);
    else missing.push(op);
  }
  return { covered, missing };
}

// -- bridge to the persisted cost-table store --------------------------------

/** Adapt a profile into a {@link StoredCostTable} record so an imported
 * semihost/device profile persists (and badges) through the existing store. */
export function profileToStored(p: ExecutionProfile, tableVersion: number): StoredCostTable {
  const origin = p.source === "default" ? "default" : p.source === "device" ? "calibrated" : "semihost";
  return {
    id: `${p.soc}@${p.cpuHz}#${tableVersion}`,
    soc: p.soc,
    cpuHz: p.cpuHz,
    tableVersion,
    firmwareBuild: p.firmwareBuild ?? "",
    timestamp: p.timestamp,
    residualError: p.residualError,
    budgetMs: 1000 / (p.budget.fps > 0 ? p.budget.fps : DEFAULT_BUDGET_MODEL.fps),
    fallbackCost: p.fallbackCost,
    costs: { ...p.costs },
    fixedOverhead: { ...p.fixed },
    observations: p.observations.map((o) => ({
      bytecodeHash: 0,
      label: o.label,
      predicted: o.predicted ?? 0,
      measured: o.measured,
    })),
    deviceLabel: p.deviceLabel ?? (p.source === "semihost" ? "semihost" : ""),
    origin,
    budget: { ...p.budget },
  };
}
