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
  /** "default" = the shipped fallback; "calibrated" = fitted on hardware;
   * "semihost" = measured by the host benchmark over the real VM (no device). */
  origin: "default" | "calibrated" | "semihost";
  /** Available-execution-budget model (FUG-11). Optional for records persisted
   * before the budget model existed. */
  budget?: BudgetModel;
}

const DB_NAME = "ledmapper-perf";
const DB_VERSION = 1;
const STORE = "cost_tables";

export const CURRENT_TABLE_VERSION = 1;
export const DEFAULT_SOC = "esp32c6";
export const DEFAULT_CPU_HZ = 160_000_000;
export const BUDGET_MS = 1000 / 30; // 33.3ms, one 30fps frame

/**
 * Shipped DEFAULT cost table for the C6 (perf-monitoring.md: "shipped with the
 * app, with the last on-device calibration overriding it"). Cycle costs reflect
 * the C6's soft-float economics — transcendentals dear, int/branch/stack cheap
 * — as SCALAR (per-lane) costs; the model multiplies by lane count. These are
 * order-of-magnitude seeds; calibration replaces them with fitted values and a
 * measured residual. `residualError` is deliberately generous (25%) so the
 * uncalibrated model's error bars are honestly wide.
 */
export const DEFAULT_COSTS: CostMap = {
  // loads / stores / stack — cheap
  PushConst: 2,
  LoadUniform: 3,
  LoadState: 3,
  StoreState: 3,
  LoadLocal: 3,
  StoreLocal: 3,
  LoadCtx: 3,
  Swizzle: 4,
  Pop: 1,
  Swap: 3,
  // integer / fixed-point fast path — cheap (no FPU)
  AddI: 2,
  SubI: 2,
  MulI: 4,
  DivI: 20,
  ModI: 20,
  NegI: 2,
  CmpI: 2,
  MulFix: 6,
  DivFix: 24,
  I2F: 8,
  F2I: 8,
  Fix2F: 10,
  F2Fix: 10,
  I2Fix: 2,
  Fix2I: 2,
  // control flow / logic — cheap
  Cmp: 3,
  Logic: 2,
  BrFalse: 3,
  Jmp: 2,
  Call: 6,
  Ret: 4,
  RetFn: 4,
  // soft-float elementwise — moderate (per lane)
  Add: 12,
  Sub: 12,
  Mul: 14,
  Div: 45,
  Neg: 6,
  Scale: 14,
  Clamp: 16,
  Mix: 20,
  Smoothstep: 40,
  Dot: 18,
  Cross: 60,
  Length: 90,
  Normalize: 110,
  Distance: 100,
  // transcendentals / specials — dear
  UnMath: 120, // sin/cos/exp/log/sqrt/tan — dominant; refined per-fn by fit
  BinMath: 130, // pow/atan2/min/max/step/mod
  Hash1: 60,
  Hash3: 120,
  Hsv2Rgb: 90,
  Palette: 70,
};

export const DEFAULT_FIXED: FixedOverhead = {
  update_fixed: 200, // update() call framing + state writeback
  shade_fixed: 60, // per-LED loop: call/ret, ctx load, buffer store
  show_fixed: 40_000, // FastLED.show() DMA/RMT setup floor
  show_per_led: 480, // WS2812 transmit per LED (~30µs @160MHz ≈ 4800cy; scaled)
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
    residualError: 0.25,
    fallbackCost: 8,
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

function keyOf(soc: string, cpuHz: number, tableVersion: number): string {
  return `${soc}@${cpuHz}#${tableVersion}`;
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

  /** Load the stored calibrated table for a SoC+clock (current version), or
   * null if none — the caller falls back to {@link defaultCostTable}. */
  async load(
    soc = DEFAULT_SOC,
    cpuHz = DEFAULT_CPU_HZ,
    tableVersion = CURRENT_TABLE_VERSION,
  ): Promise<StoredCostTable | null> {
    const db = await this.db();
    const tx = db.transaction(STORE, "readonly");
    const rec = await CostTableStore.req(
      tx.objectStore(STORE).get(keyOf(soc, cpuHz, tableVersion)),
    );
    return (rec as StoredCostTable | undefined) ?? null;
  }

  /** Resolve the best CostTable for a SoC: the calibrated one if present, else
   * the shipped default. Also returns whether it was calibrated (for the badge). */
  async resolveTable(
    soc = DEFAULT_SOC,
    cpuHz = DEFAULT_CPU_HZ,
  ): Promise<{ table: CostTable; stored: StoredCostTable | null }> {
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

  /** Build the composite key for a record (soc/clock/version). */
  keyFor(soc: string, cpuHz: number, tableVersion = CURRENT_TABLE_VERSION): string {
    return keyOf(soc, cpuHz, tableVersion);
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
