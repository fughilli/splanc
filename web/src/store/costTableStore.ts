/**
 * Cost-table store (docs/design/perf-monitoring.md §"Offline device model" +
 * §"Calibration flow" + the multi-SoC DECISION). Persists calibrated
 * per-opcode cost tables in IndexedDB, keyed by SoC + clock + table version, so
 * an offline effect estimate uses the device's real economics.
 *
 * Each record carries METADATA and the raw experimental OBSERVATIONS (predicted
 * vs measured cycles per benchmark), per the DECISION: models must be
 * saveable/restorable and re-derivable if the modeling approach later changes.
 * A calibration therefore fully round-trips to a file (exportTable/importTable).
 *
 * Ships a sensible DEFAULT table (the C6 soft-float economics) used as the
 * fallback before any calibration.
 *
 * IndexedDB is touched only inside methods (runtime), so this module stays
 * CJS-safe for the node:test unit build.
 */

import {
  DEFAULT_BUDGET_MODEL,
  type BudgetModel,
  type CostMap,
  type CostTable,
  type FixedOverhead,
} from "../effects/costModel";

/** One calibration observation: a benchmark's predicted vs measured cycles. */
export interface CalibObservation {
  /** Truncated hash of the benchmark `.fxb` (pins the observation to a build). */
  bytecodeHash: number;
  /** Human label ("Mul×256", "empty shade", …). */
  label: string;
  predicted: number;
  measured: number;
}

/** A persisted, versioned cost table + everything needed to re-derive it. */
export interface StoredCostTable {
  /** Composite key: `${soc}@${cpuHz}#${tableVersion}`. */
  id: string;
  soc: string;
  cpuHz: number;
  tableVersion: number;
  /** Firmware build id the calibration ran against (from PerfReport/welcome). */
  firmwareBuild: string;
  /** ISO timestamp of the calibration. */
  timestamp: string;
  /** Residual fit error as a fraction (0..1). */
  residualError: number;
  budgetMs: number;
  fallbackCost: number;
  costs: CostMap;
  fixedOverhead: FixedOverhead;
  /** Raw observations so the table can be re-fit under a new model form. */
  observations: CalibObservation[];
  /** Label for the device this was measured on (for the "calibrated on…" badge). */
  deviceLabel: string;
  /** "default" = the shipped fallback; "calibrated" = fitted on real hardware
   * (HITL/device, authoritative); "host" = the native host smoke benchmark
   * (never a device model). */
  origin: "default" | "calibrated" | "host";
  /** Available-execution-budget model (FUG-11). Optional for records persisted
   * before the budget model existed. */
  budget?: BudgetModel;
  /** Stable device identity (hardware MAC / device id) for a PER-DEVICE profile.
   * Absent for SoC-wide records. Part of the composite `id` when present. */
  deviceKey?: string;
  /** Held-out predicted-vs-measured error (0..1) once validated on hardware. */
  measuredError?: number;
}

const DB_NAME = "ledmapper-perf";
const DB_VERSION = 1;
const STORE = "cost_tables";

export const CURRENT_TABLE_VERSION = 1;
export const DEFAULT_SOC = "esp32c6";
export const DEFAULT_CPU_HZ = 160_000_000;
export const BUDGET_MS = 1000 / 30; // 33.3ms, one 30fps frame

/**
 * Shipped DEFAULT cost table for the C6 @160 MHz — CALIBRATED, not guessed.
 *
 * The model is `Σ ops × @dispatch + Σ lane-weighted ops × cost[op]`: every
 * interpreted opcode pays the interpreter's dispatch (fetch/decode/budget
 * check/jump table, `@dispatch`) once, plus its compute per lane. The values are
 * a least-squares fit of that form to the HITL fx_bench bundle
 * (web/tests/testdata/device-bench-esp32c6.json, 69 straight-line programs;
 * rms error 0.4%, worst 1.5%) — see docs/design/fx-memoization.md
 * "Calibration". The old seed table priced cheap ops at 2-3 cycles and had no
 * dispatch term, so an effect of many cheap ops was underestimated ~40× (an
 * offline "3 ms" that ran 132 ms on a 500-LED C6). The integer/fixed ISA rows
 * are from the memo HITL fixed-point micro-benchmarks where measured, else
 * conservative estimates (marked). fx_compiler's memo.rs `op_cycles` mirrors
 * this table for its cache-selection cost model. `residualError` stays a
 * generous 15% for programs unlike the benchmarks (loops, branches, buffers).
 */
export const DEFAULT_COSTS: CostMap = {
  // per-op interpreter dispatch (counted once per executed op, not per lane)
  "@dispatch": 69,
  // per-LED Q16.16 context mirrors the firmware builds when an effect reads
  // fixed(led.*) (FLAG_USES_CTXFIX) — 7 soft-float converts per LED; fitted
  // on the fx-perf-study bench set (fixed effects with mostly-skipped branches)
  "@ctxfix": 700,
  // loads / stores / stack: dispatch + a per-word slot move
  PushConst: 0,
  LoadUniform: 18,
  LoadState: 18,
  StoreState: 18,
  LoadLocal: 18,
  StoreLocal: 18,
  TeeLocal: 18,
  FillLocal: 4,
  LoadCtx: 10,
  LoadCtxFix: 0,
  Swizzle: 8,
  Pop: 0,
  Swap: 8,
  // integer / fixed-point ISA. MEASURED on the C6 (memo HITL M/2M chains,
  // docs/design/fx-memoization.md): AddI 32, MulFixN 45, SinFix 79, Atan2Fix
  // 279, SqrtFix 414, FixFromF 249. The rest are set by analogy to those.
  AddI: 32,
  SubI: 32,
  MulI: 45,
  DivI: 80,
  ModI: 80,
  NegI: 32,
  CmpI: 10,
  IncLocalI: 40,
  AbsI: 32,
  MinI: 32,
  MaxI: 32,
  ClampI: 40,
  SignI: 32,
  StepI: 32,
  FloorFix: 32,
  CeilFix: 32,
  FractFix: 32,
  MixFix: 50,
  MulFix: 45,
  DivFix: 80,
  MulFixN: 45,
  DivFixN: 80,
  FixRescale: 32,
  SinFix: 79,
  CosFix: 79,
  ExpFix: 100,
  SqrtFix: 414,
  LogFix: 300,
  TanFix: 300,
  PowFix: 650,
  Atan2Fix: 279,
  ScaleFix: 45,
  DotFix: 45,
  LengthFix: 450,
  DistanceFix: 450,
  NormalizeFix: 700,
  CrossFix: 200,
  SmoothstepFix: 150,
  ClampVFix: 40,
  MixVFix: 50,
  Hsv2RgbFix: 300,
  PaletteFix: 200,
  HashFix: 60,
  Hash3Fix: 80,
  RetRgb8: 0,
  RetRgbFix: 10,
  // float<->int/fixed boundary (soft-float convert; FixFromF measured 249)
  I2F: 249,
  F2I: 249,
  Fix2F: 249,
  F2Fix: 249,
  FixToF: 249,
  FixFromF: 249,
  I2Fix: 2,
  Fix2I: 2,
  // control flow / logic
  Cmp: 60,
  Logic: 10,
  BrFalse: 10,
  BrCmpI: 10,
  Jmp: 0,
  Call: 30,
  Ret: 0,
  RetFn: 10,
  // per-LED memo bracket: a hit is dispatch + record lookup + word copy
  LoadLedCache: 48,
  StoreLedCache: 30,
  // soft-float elementwise (per lane) — fitted
  Add: 124,
  Sub: 131,
  Mul: 126,
  Div: 278,
  Neg: 4,
  Scale: 126,
  Clamp: 166,
  Mix: 283,
  Smoothstep: 637,
  Dot: 124,
  Cross: 650,
  Length: 316,
  Normalize: 505,
  Distance: 387,
  // transcendentals / specials — fitted per fn. UnMath/BinMath are dispatch
  // opcodes that collapse many fns of very different cost, so the model keys
  // them per-fn (`UnMath:sqrt`, `BinMath:pow`, …) — see costModel.ts
  // `mathFeature`/`costFor`. The bare keys are the family FALLBACK tier.
  UnMath: 600,
  "UnMath:abs": 41,
  "UnMath:sign": 64,
  "UnMath:floor": 188,
  "UnMath:ceil": 343,
  "UnMath:fract": 269,
  "UnMath:sqrt": 614,
  "UnMath:sin": 504,
  "UnMath:cos": 577,
  "UnMath:tan": 1238,
  "UnMath:exp": 816,
  "UnMath:log": 783,
  BinMath: 600,
  "BinMath:min": 110,
  "BinMath:max": 109,
  "BinMath:step": 116,
  "BinMath:mod": 522,
  "BinMath:atan2": 969,
  "BinMath:pow": 1741,
  Hash1: 115,
  Hash3: 147,
  Hsv2Rgb: 1242,
  Palette: 433,
  // resource ops (estimates; resource tier not benchmarked yet)
  LoadStateIdx: 40,
  StoreStateIdx: 40,
  LoadLocalIdx: 40,
  StoreLocalIdx: 40,
  GraphQuery: 30,
  LoadBuf: 60,
  StoreBuf: 60,
  // Bilinear, edge-clamped, dequantized float sample: ~9 soft-float ops of
  // setup + ~5 per element. MEASURED on the bench (fx-perf study texture.fx,
  // vec3 f32 16x16: the 400 seed under-read it 2.5x); scalar textures cost less.
  SampleTex: 4300,
  PaintTex: 80,
  FloodFrom: 2000,
};

export const DEFAULT_FIXED: FixedOverhead = {
  update_fixed: 12_926, // per-frame framing (fitted)
  shade_fixed: 1_986, // per-LED loop framing: call/ret, ctx build, store (fitted)
  show_fixed: 48_146, // LED transmit setup floor (fitted)
  show_per_led: 1_980, // WS2812 transmit per LED (fitted)
};

/** The default (uncalibrated) cost table used before any device calibration. */
export function defaultCostTable(
  soc = DEFAULT_SOC,
  cpuHz = DEFAULT_CPU_HZ,
): CostTable {
  return {
    soc,
    cpuHz,
    budgetMs: BUDGET_MS,
    costs: { ...DEFAULT_COSTS },
    fixed: { ...DEFAULT_FIXED },
    residualError: 0.15,
    fallbackCost: 20,
    budget: { ...DEFAULT_BUDGET_MODEL },
  };
}

/** Compose the runtime CostTable (used by the estimator) from a stored record. */
export function toCostTable(rec: StoredCostTable): CostTable {
  return {
    soc: rec.soc,
    cpuHz: rec.cpuHz,
    budgetMs: rec.budgetMs,
    costs: rec.costs,
    fixed: rec.fixedOverhead,
    residualError: rec.residualError,
    fallbackCost: rec.fallbackCost,
    budget: rec.budget ?? { ...DEFAULT_BUDGET_MODEL },
  };
}

/** Composite record key. A `deviceKey` (hardware MAC / device id) makes it a
 * PER-DEVICE profile; without one it is the SoC-wide table. Per-device profiles
 * let a heterogeneous fleet each carry its own measured model. */
export function costTableId(
  soc: string,
  cpuHz: number,
  tableVersion: number,
  deviceKey?: string,
): string {
  const base = `${soc}@${cpuHz}#${tableVersion}`;
  return deviceKey ? `${base}@${deviceKey}` : base;
}

function keyOf(soc: string, cpuHz: number, tableVersion: number, deviceKey?: string): string {
  return costTableId(soc, cpuHz, tableVersion, deviceKey);
}

type Listener = () => void;

class CostTableStore {
  private dbp: Promise<IDBDatabase> | null = null;
  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  private db(): Promise<IDBDatabase> {
    if (this.dbp === null) {
      this.dbp = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE)) {
            db.createObjectStore(STORE, { keyPath: "id" });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return this.dbp;
  }

  private static req<T>(r: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }

  /** Persist a fitted cost table (supersedes any table with the same key). */
  async save(rec: StoredCostTable): Promise<void> {
    const db = await this.db();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.objectStore(STORE).put(rec);
    });
    this.emit();
  }

  /** Load a stored table by SoC+clock (+optional device), current version, or
   * null if none — the caller falls back to {@link defaultCostTable}. */
  async load(
    soc = DEFAULT_SOC,
    cpuHz = DEFAULT_CPU_HZ,
    tableVersion = CURRENT_TABLE_VERSION,
    deviceKey?: string,
  ): Promise<StoredCostTable | null> {
    const db = await this.db();
    const tx = db.transaction(STORE, "readonly");
    const rec = await CostTableStore.req(
      tx.objectStore(STORE).get(keyOf(soc, cpuHz, tableVersion, deviceKey)),
    );
    return (rec as StoredCostTable | undefined) ?? null;
  }

  /** Resolve the best CostTable for a target, most-specific first: the
   * per-DEVICE calibrated table (if `deviceKey` given and present) → the
   * SoC-wide calibrated table → the shipped default. Returns the stored record
   * (if any) for the "calibrated on…" badge. */
  async resolveTable(
    soc = DEFAULT_SOC,
    cpuHz = DEFAULT_CPU_HZ,
    deviceKey?: string,
  ): Promise<{ table: CostTable; stored: StoredCostTable | null }> {
    if (deviceKey) {
      const perDevice = await this.load(soc, cpuHz, CURRENT_TABLE_VERSION, deviceKey).catch(() => null);
      if (perDevice) return { table: toCostTable(perDevice), stored: perDevice };
    }
    const stored = await this.load(soc, cpuHz).catch(() => null);
    if (stored) return { table: toCostTable(stored), stored };
    return { table: defaultCostTable(soc, cpuHz), stored: null };
  }

  /** All stored tables (for a "calibrated devices" list / management UI). */
  async list(): Promise<StoredCostTable[]> {
    const db = await this.db();
    const tx = db.transaction(STORE, "readonly");
    const all = await CostTableStore.req(tx.objectStore(STORE).getAll());
    return (all as StoredCostTable[]) ?? [];
  }

  async delete(id: string): Promise<void> {
    const db = await this.db();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.objectStore(STORE).delete(id);
    });
    this.emit();
  }

  /** Build the composite key for a record (soc/clock/version, optional device). */
  keyFor(
    soc: string,
    cpuHz: number,
    tableVersion = CURRENT_TABLE_VERSION,
    deviceKey?: string,
  ): string {
    return keyOf(soc, cpuHz, tableVersion, deviceKey);
  }
}

export const costTableStore = new CostTableStore();

// -- Save/restore files (metadata + observations, per the DECISION) ----------

/** Serialize a stored table to a JSON file blob (with metadata + observations
 * so it can be re-derived under a future model form). */
export function exportTable(rec: StoredCostTable): string {
  return JSON.stringify({ kind: "ledmapper-cost-table", version: 1, table: rec }, null, 2);
}

/** Parse a cost-table file back into a StoredCostTable. Throws if malformed. */
export function importTable(json: string): StoredCostTable {
  const obj = JSON.parse(json) as { kind?: string; table?: StoredCostTable };
  if (obj.kind !== "ledmapper-cost-table" || !obj.table)
    throw new Error("not a cost-table file");
  return obj.table;
}
