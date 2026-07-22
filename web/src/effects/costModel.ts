/**
 * Offline effect cost model (docs/design/perf-monitoring.md §"Offline device
 * model"). Predicts an effect's per-frame time on the device from its compiled
 * `.fxb` alone — no hardware needed — so a user editing a shader in the browser
 * still sees "this will overrun at 256 LEDs".
 *
 * Form (perf-monitoring.md §"Model form"):
 *
 *   frame_cycles = update_fixed
 *                + Σ_op count_update[op] * cost[op]
 *                + led_count * ( shade_fixed
 *                              + Σ_op count_shade_per_led[op] * cost[op] )
 *   show_cycles  = show_fixed + led_count * show_per_led
 *   total        = frame_cycles + show_cycles
 *
 * Opcode counts come from an ABSTRACT INTERPRETER that walks the `.fxb` code
 * (this module) rather than executing it: it decodes each opcode's operand
 * bytes (mirroring firmware/fx_vm/src/lib.rs), follows the CFG, and multiplies
 * basic-block counts by loop trip bounds. Data-dependent branches contribute a
 * band (best case = skip the arm, worst case = take it), so the estimate is a
 * range, not a point — the DECISION in perf-monitoring.md is to ALWAYS surface
 * that error band and colorize headroom by confidence.
 *
 * Vector-op cost = scalar cost × lane count (the DECISION), where the lane
 * count is the opcode's size operand. Transcendentals dominate; the default
 * table below reflects the C6's soft-float economics until calibration refines
 * it.
 *
 * This file is pure + CJS-safe (no import.meta / DOM) so it compiles under the
 * node:test unit build and is exercised by tests/costModel.test.ts.
 */

// -- Opcode model -----------------------------------------------------------
// Names mirror firmware/fx_vm/src/lib.rs `enum Op` (discriminant order is the
// wire encoding). Keep in sync with the VM; the abstract interpreter decodes
// operand widths from OPCODES below.

/** Canonical opcode names, indexed by their `.fxb` byte value (Op discriminant). */
export const OPCODE_NAMES = [
  "PushConst", // 0
  "LoadUniform",
  "LoadState",
  "StoreState",
  "LoadLocal",
  "StoreLocal",
  "LoadCtx",
  "Add",
  "Sub",
  "Mul",
  "Div",
  "Neg",
  "Scale",
  "UnMath",
  "BinMath",
  "Clamp",
  "Mix",
  "Smoothstep",
  "Dot",
  "Cross",
  "Length",
  "Normalize",
  "Distance",
  "Swizzle",
  "Cmp",
  "Logic",
  "BrFalse",
  "Jmp",
  "Hash1",
  "Hash3",
  "Hsv2Rgb",
  "Palette",
  "Pop",
  "Ret",
  "Swap",
  "AddI",
  "SubI",
  "MulI",
  "DivI",
  "ModI",
  "NegI",
  "CmpI",
  "MulFix",
  "DivFix",
  "I2F",
  "F2I",
  "Fix2F",
  "F2Fix",
  "I2Fix",
  "Fix2I",
  "Call",
  "RetFn",
] as const;

export type OpcodeName = (typeof OPCODE_NAMES)[number];

const NAME_TO_CODE: Record<string, number> = Object.fromEntries(
  OPCODE_NAMES.map((n, i) => [n, i]),
);

/** unary-math fn ids (UnMath operand). Mirror firmware F_* constants. */
const UN_MATH_NAMES = [
  "sin", "cos", "abs", "floor", "ceil", "fract", "sqrt", "exp", "log", "sign", "tan",
];
/** binary-math fn ids (BinMath operand). Mirror firmware B_* constants. */
const BIN_MATH_NAMES = ["min", "max", "pow", "mod", "step", "atan2"];

/**
 * Operand-byte width for each opcode, so the interpreter can advance the PC
 * exactly like the VM. `lanes` marks the byte offset (into the operand) that
 * holds the vector lane count (the size operand) — used for scalar×lanes cost.
 * `swizzleTail`/`branch` mark the two variable/structural cases.
 */
interface OpMeta {
  /** Fixed operand bytes after the opcode byte (excluding a swizzle tail). */
  operandBytes: number;
  /** Operand offset holding the vector lane count (n), or -1 if scalar (=1 lane). */
  lanesAt: number;
  /** True for BrFalse/Jmp (relative i16 branch target). */
  branch?: boolean;
  /** True for Swizzle: extra dst_n bytes of component indices follow. */
  swizzleTail?: boolean;
  /** True for Call (u16 absolute target). */
  call?: boolean;
  /** True for Ret/RetFn — ends a linear run. */
  ret?: boolean;
}

const OP_META: Record<string, OpMeta> = {
  PushConst: { operandBytes: 2, lanesAt: -1 },
  LoadUniform: { operandBytes: 2, lanesAt: 1 }, // slot, n
  LoadState: { operandBytes: 2, lanesAt: 1 },
  StoreState: { operandBytes: 2, lanesAt: 1 },
  LoadLocal: { operandBytes: 2, lanesAt: 1 },
  StoreLocal: { operandBytes: 2, lanesAt: 1 },
  LoadCtx: { operandBytes: 1, lanesAt: -1 },
  Add: { operandBytes: 1, lanesAt: 0 },
  Sub: { operandBytes: 1, lanesAt: 0 },
  Mul: { operandBytes: 1, lanesAt: 0 },
  Div: { operandBytes: 1, lanesAt: 0 },
  Neg: { operandBytes: 1, lanesAt: 0 },
  Scale: { operandBytes: 1, lanesAt: 0 },
  UnMath: { operandBytes: 2, lanesAt: 1 }, // fn, n
  BinMath: { operandBytes: 2, lanesAt: 1 },
  Clamp: { operandBytes: 1, lanesAt: 0 },
  Mix: { operandBytes: 1, lanesAt: 0 },
  Smoothstep: { operandBytes: 1, lanesAt: 0 },
  Dot: { operandBytes: 1, lanesAt: 0 },
  Cross: { operandBytes: 1, lanesAt: -1 },
  Length: { operandBytes: 1, lanesAt: 0 },
  Normalize: { operandBytes: 1, lanesAt: 0 },
  Distance: { operandBytes: 1, lanesAt: 0 },
  Swizzle: { operandBytes: 2, lanesAt: -1, swizzleTail: true }, // srcN, dstN, then dstN bytes
  Cmp: { operandBytes: 1, lanesAt: -1 },
  Logic: { operandBytes: 1, lanesAt: -1 },
  BrFalse: { operandBytes: 2, lanesAt: -1, branch: true },
  Jmp: { operandBytes: 2, lanesAt: -1, branch: true },
  Hash1: { operandBytes: 0, lanesAt: -1 },
  Hash3: { operandBytes: 0, lanesAt: -1 },
  Hsv2Rgb: { operandBytes: 0, lanesAt: -1 },
  Palette: { operandBytes: 1, lanesAt: -1 },
  Pop: { operandBytes: 1, lanesAt: -1 },
  Ret: { operandBytes: 1, lanesAt: -1, ret: true },
  Swap: { operandBytes: 2, lanesAt: -1 },
  AddI: { operandBytes: 0, lanesAt: -1 },
  SubI: { operandBytes: 0, lanesAt: -1 },
  MulI: { operandBytes: 0, lanesAt: -1 },
  DivI: { operandBytes: 0, lanesAt: -1 },
  ModI: { operandBytes: 0, lanesAt: -1 },
  NegI: { operandBytes: 0, lanesAt: -1 },
  CmpI: { operandBytes: 1, lanesAt: -1 },
  MulFix: { operandBytes: 0, lanesAt: -1 },
  DivFix: { operandBytes: 0, lanesAt: -1 },
  I2F: { operandBytes: 0, lanesAt: -1 },
  F2I: { operandBytes: 0, lanesAt: -1 },
  Fix2F: { operandBytes: 0, lanesAt: -1 },
  F2Fix: { operandBytes: 0, lanesAt: -1 },
  I2Fix: { operandBytes: 0, lanesAt: -1 },
  Fix2I: { operandBytes: 0, lanesAt: -1 },
  Call: { operandBytes: 2, lanesAt: -1, call: true },
  RetFn: { operandBytes: 0, lanesAt: -1, ret: true },
};

// -- Cost table -------------------------------------------------------------

/** Fixed/per-LED overheads, in cycles (perf-monitoring.md §"Model form"). */
export interface FixedOverhead {
  update_fixed: number;
  shade_fixed: number;
  show_fixed: number;
  show_per_led: number;
}

/** A per-opcode cost, in cycles. Vector ops store the SCALAR (per-lane) cost;
 * the model multiplies by the lane count from the opcode's size operand. */
export type CostMap = Record<string, number>;

// -- Bytecode header parse (mirror Program::parse in fx_vm) ------------------

interface FxbHeader {
  code: Uint8Array; // the code segment only
  updateEntry: number; // NO_ENTRY (0xFFFF) if absent
  shadeEntry: number;
}

const NO_ENTRY = 0xffff;

function rdU16(b: Uint8Array, o: number): number {
  return b[o]! | (b[o + 1]! << 8);
}
function rdI16(b: Uint8Array, o: number): number {
  const v = rdU16(b, o);
  return v >= 0x8000 ? v - 0x10000 : v;
}

/** Parse the `.fxb` header and slice out the code segment. Throws on a bad or
 * truncated buffer. Layout: magic(4) ver(1) flags(1) n_state(1) n_uniform(1)
 * manifest_len(2) n_consts(2) code_len(2) update_entry(2) shade_entry(2). */
export function parseFxb(buf: Uint8Array): FxbHeader {
  if (buf.length < 18) throw new Error("fxb too short");
  if (buf[0] !== 0x46 || buf[1] !== 0x58 || buf[2] !== 0x42 || buf[3] !== 0x31)
    throw new Error("bad fxb magic");
  if (buf[4] !== 1) throw new Error("bad fxb version");
  const manifestLen = rdU16(buf, 8);
  const nConsts = rdU16(buf, 10);
  const codeLen = rdU16(buf, 12);
  const updateEntry = rdU16(buf, 14);
  const shadeEntry = rdU16(buf, 16);
  let o = 18 + manifestLen + nConsts * 4;
  const code = buf.subarray(o, o + codeLen);
  return { code, updateEntry, shadeEntry };
}

// -- Abstract interpreter ----------------------------------------------------
// Walks the code from an entry, decoding operand widths to advance the PC. It
// does NOT run float math; it accumulates a weighted opcode histogram. Forward
// conditional branches (BrFalse/Jmp skipping ahead) are the "arm" boundaries:
// the min-count path takes the skip, the max-count path falls through. Backward
// jumps (loops) are bounded by a trip cap so the walk always terminates.

/** A per-opcode weighted execution count. Weight = lane count (vec cost). */
export type OpHistogram = Record<string, number>;

export interface WalkResult {
  /** Lower bound histogram (cheap arms taken at data-dependent branches). */
  min: OpHistogram;
  /** Upper bound histogram (expensive arms taken). */
  max: OpHistogram;
  /** True if a data-dependent branch made min != max (estimate is a band). */
  branched: boolean;
  /** True if a loop trip cap was hit (count may under-report). */
  loopCapped: boolean;
}

const LOOP_TRIP_CAP = 64; // compile-time `for` bounds are small; cap the walk.

function addOp(h: OpHistogram, name: string, weight: number): void {
  h[name] = (h[name] ?? 0) + weight;
}

/**
 * Abstract-interpret one entry (update or shade) once. Linear walk with simple
 * branch handling: at a forward BrFalse we recurse into both the taken and
 * fall-through continuations and keep the min/max op totals; at a Jmp we follow
 * it (bounding backward jumps by a trip cap). Recursion is bounded by a visit
 * budget so pathological CFGs can't hang the browser.
 */
export function walkEntry(code: Uint8Array, entry: number): WalkResult {
  if (entry === NO_ENTRY || entry >= code.length) {
    return { min: {}, max: {}, branched: false, loopCapped: false };
  }
  let branched = false;
  let loopCapped = false;
  const visits = new Map<number, number>(); // pc -> times entered (loop cap)
  let steps = 0;
  const STEP_BUDGET = 200_000;

  // DFS that returns {min,max} op-histograms for the straight-line-plus-branch
  // region starting at `pc`. `depth` bounds recursion for safety.
  function walk(pc: number, depth: number): { min: OpHistogram; max: OpHistogram } {
    const min: OpHistogram = {};
    const max: OpHistogram = {};
    if (depth > 512) return { min, max };
    let p = pc;
    for (;;) {
      if (p < 0 || p >= code.length) break;
      if (++steps > STEP_BUDGET) {
        loopCapped = true;
        break;
      }
      const seen = visits.get(p) ?? 0;
      if (seen >= LOOP_TRIP_CAP) {
        loopCapped = true;
        break;
      }
      visits.set(p, seen + 1);

      const opCode = code[p]!;
      const name = OPCODE_NAMES[opCode];
      if (name === undefined) break; // unknown byte — stop this run
      const meta = OP_META[name]!;
      const operandStart = p + 1;
      // vector lane weight from the size operand (scalar cost × lane count).
      let weight = 1;
      if (meta.lanesAt >= 0) {
        const n = code[operandStart + meta.lanesAt] ?? 1;
        weight = Math.max(1, n);
      }
      addOp(min, name, weight);
      addOp(max, name, weight);

      // advance PC past operands
      let next = operandStart + meta.operandBytes;
      if (meta.swizzleTail) {
        const dstN = code[operandStart + 1] ?? 0;
        next += dstN;
      }

      if (meta.ret) break; // Ret / RetFn ends this run

      if (meta.branch) {
        const rel = rdI16(code, operandStart);
        const target = next + rel;
        if (name === "Jmp") {
          // Unconditional: follow it (backward jumps bounded by the visit cap).
          p = target;
          continue;
        }
        // BrFalse: two continuations. Only treat a FORWARD skip as an
        // optional (data-dependent) arm; a backward BrFalse is a loop back-edge
        // we approximate by falling through (the trip cap bounds it).
        if (target > next) {
          branched = true;
          const taken = walk(target, depth + 1); // condition false: skip arm
          const fall = walk(next, depth + 1); // condition true: run arm
          // min path = cheaper of the two continuations; max = costlier.
          mergeMinMax(min, max, taken, fall);
          return { min, max };
        }
        // backward BrFalse: fall through (loop exit path).
        p = next;
        continue;
      }

      p = next;
    }
    return { min, max };
  }

  const { min, max } = walk(entry, 0);
  return { min, max, branched, loopCapped };
}

/** Fold two continuation results into the accumulated min/max at a branch. */
function mergeMinMax(
  min: OpHistogram,
  max: OpHistogram,
  a: { min: OpHistogram; max: OpHistogram },
  b: { min: OpHistogram; max: OpHistogram },
): void {
  const aMin = histTotalWith(min, a.min);
  const bMin = histTotalWith(min, b.min);
  const cheaper = aMin <= bMin ? a.min : b.min;
  const dearer = costOf(a.max) >= costOf(b.max) ? a.max : b.max;
  for (const [k, v] of Object.entries(cheaper)) min[k] = (min[k] ?? 0) + v;
  for (const [k, v] of Object.entries(dearer)) max[k] = (max[k] ?? 0) + v;
}

function histTotalWith(base: OpHistogram, add: OpHistogram): number {
  let t = 0;
  for (const v of Object.values(base)) t += v;
  for (const v of Object.values(add)) t += v;
  return t;
}

/** Total weighted op count (lane-weighted), a cheap proxy when no table given. */
function costOf(h: OpHistogram): number {
  let t = 0;
  for (const v of Object.values(h)) t += v;
  return t;
}

/** Σ_op count[op] * cost[op], defaulting unlisted opcodes to `fallback`. */
export function histCycles(h: OpHistogram, costs: CostMap, fallback: number): number {
  let c = 0;
  for (const [name, count] of Object.entries(h)) {
    c += count * (costs[name] ?? fallback);
  }
  return c;
}

// -- Estimation -------------------------------------------------------------

export type Confidence = "green" | "yellow" | "red";

export interface PhaseSplit {
  updateMs: number;
  shadeMs: number;
  showMs: number;
}

export interface ErrorBand {
  /** Low estimate (cheap-arm counts + optimistic residual), ms. */
  lowMs: number;
  /** High estimate (expensive-arm counts + pessimistic residual), ms. */
  highMs: number;
  /** ± as a fraction of the point estimate. */
  fraction: number;
}

export interface HotOpcode {
  op: string;
  /** Total cycles this opcode contributes per frame (× led_count in shade). */
  cycles: number;
  /** Fraction of total frame cycles. */
  fraction: number;
}

export interface FrameEstimate {
  totalMs: number;
  budgetMs: number;
  /** Fraction of budget consumed (wall-time estimate, per the DECISION). */
  budgetFraction: number;
  phaseSplit: PhaseSplit;
  /** instr_shade / led_count — ops executed per LED (lane-weighted). */
  opsPerLed: number;
  errorBand: ErrorBand;
  hotOpcodes: HotOpcode[];
  /** Colorized confidence the effect fits the budget (red/yellow/green). */
  confidence: Confidence;
  /** True if opcode counts came from a data-dependent branch band. */
  branched: boolean;
  loopCapped: boolean;
}

export interface CostTable {
  soc: string;
  cpuHz: number;
  budgetMs: number; // 33.3 ms = 1/30fps
  costs: CostMap;
  fixed: FixedOverhead;
  /** Residual error fraction from the last fit (0 for the shipped default). */
  residualError: number;
  /** Cheap-op fallback cost (cycles) for opcodes absent from `costs`. */
  fallbackCost: number;
}

export interface EstimateInputs {
  /** Compiled bytecode (.fxb). */
  bytecode: Uint8Array;
  ledCount: number;
  table: CostTable;
  /** Optional dynamic per-LED shade histogram (from the wasm preview profile),
   * already summed over all LEDs. When present it OVERRIDES the static walk for
   * shade — the exact executed path for the current uniforms/map (the headline
   * dynamic-profile estimator). */
  dynamicShadeHist?: OpHistogram;
  /** Number of LEDs the dynamic histogram was summed over (to get per-LED). */
  dynamicLedCount?: number;
}

const CYCLES_PER_MS_DIVISOR = 1_000_000; // cpuHz(Hz) * ms / 1000 ... see toMs

function toMs(cycles: number, cpuHz: number): number {
  return (cycles / cpuHz) * 1000;
}
void CYCLES_PER_MS_DIVISOR;

/**
 * Estimate one frame's wall-time from the compiled bytecode + a cost table.
 * Returns the point estimate, phase split, ops-per-LED, an error band, the hot
 * opcodes, and a red/yellow/green confidence (per the DECISION: colorize by how
 * likely the effect is to fit the budget).
 */
export function estimateFrameTime(inp: EstimateInputs): FrameEstimate {
  const { bytecode, ledCount, table } = inp;
  const cpuHz = table.cpuHz;
  const fb = table.fallbackCost;
  const budgetMs = table.budgetMs;

  const header = parseFxb(bytecode);

  // update(): abstract-interpret once. update_fixed + Σ counts*cost.
  const upWalk = walkEntry(header.code, header.updateEntry);
  const updateCyclesMin = table.fixed.update_fixed + histCycles(upWalk.min, table.costs, fb);
  const updateCyclesMax = table.fixed.update_fixed + histCycles(upWalk.max, table.costs, fb);

  // shade(): per-LED. Prefer the dynamic profile histogram if supplied.
  let shadeMinPerLed: number;
  let shadeMaxPerLed: number;
  let shadeHistForHot: OpHistogram;
  let branched = upWalk.branched;
  let loopCapped = upWalk.loopCapped;
  if (inp.dynamicShadeHist && (inp.dynamicLedCount ?? 0) > 0) {
    const perLed: OpHistogram = {};
    for (const [k, v] of Object.entries(inp.dynamicShadeHist)) {
      perLed[k] = v / inp.dynamicLedCount!;
    }
    const c = histCycles(perLed, table.costs, fb);
    shadeMinPerLed = c;
    shadeMaxPerLed = c; // exact executed path → no band from shade
    shadeHistForHot = perLed;
  } else {
    const shWalk = walkEntry(header.code, header.shadeEntry);
    shadeMinPerLed = histCycles(shWalk.min, table.costs, fb);
    shadeMaxPerLed = histCycles(shWalk.max, table.costs, fb);
    shadeHistForHot = shWalk.max;
    branched = branched || shWalk.branched;
    loopCapped = loopCapped || shWalk.loopCapped;
  }

  const perLedFixed = table.fixed.shade_fixed;
  const shadeCyclesMin = ledCount * (perLedFixed + shadeMinPerLed);
  const shadeCyclesMax = ledCount * (perLedFixed + shadeMaxPerLed);

  const showCycles = table.fixed.show_fixed + ledCount * table.fixed.show_per_led;

  const frameCyclesMin = updateCyclesMin + shadeCyclesMin;
  const frameCyclesMax = updateCyclesMax + shadeCyclesMax;
  const totalCyclesMin = frameCyclesMin + showCycles;
  const totalCyclesMax = frameCyclesMax + showCycles;

  // Point estimate = midpoint of the branch band, then widen by the table's
  // residual error (the fit's known inaccuracy) for the reported error band.
  const totalCyclesMid = (totalCyclesMin + totalCyclesMax) / 2;
  const totalMs = toMs(totalCyclesMid, cpuHz);
  const resid = Math.max(0, table.residualError);
  const lowMs = toMs(totalCyclesMin, cpuHz) * (1 - resid);
  const highMs = toMs(totalCyclesMax, cpuHz) * (1 + resid);
  const fraction = totalMs > 0 ? (highMs - lowMs) / (2 * totalMs) : 0;

  const phaseSplit: PhaseSplit = {
    updateMs: toMs((updateCyclesMin + updateCyclesMax) / 2, cpuHz),
    shadeMs: toMs((shadeCyclesMin + shadeCyclesMax) / 2, cpuHz),
    showMs: toMs(showCycles, cpuHz),
  };

  const opsPerLed = totalWeighted(shadeHistForHot);

  // Hot-opcode histogram (× cost, in shade also × led_count). Sorted desc.
  const hotOpcodes = hotOpcodesOf(
    upWalk.max,
    shadeHistForHot,
    ledCount,
    table,
    totalCyclesMax,
  );

  const confidence = confidenceOf(lowMs, highMs, budgetMs);

  return {
    totalMs,
    budgetMs,
    budgetFraction: budgetMs > 0 ? totalMs / budgetMs : 0,
    phaseSplit,
    opsPerLed,
    errorBand: { lowMs, highMs, fraction },
    hotOpcodes,
    confidence,
    branched,
    loopCapped,
  };
}

function totalWeighted(h: OpHistogram): number {
  let t = 0;
  for (const v of Object.values(h)) t += v;
  return t;
}

function hotOpcodesOf(
  updateHist: OpHistogram,
  shadePerLedHist: OpHistogram,
  ledCount: number,
  table: CostTable,
  totalCycles: number,
): HotOpcode[] {
  const contrib: Record<string, number> = {};
  const fb = table.fallbackCost;
  for (const [op, n] of Object.entries(updateHist)) {
    contrib[op] = (contrib[op] ?? 0) + n * (table.costs[op] ?? fb);
  }
  for (const [op, n] of Object.entries(shadePerLedHist)) {
    contrib[op] = (contrib[op] ?? 0) + n * (table.costs[op] ?? fb) * ledCount;
  }
  const denom = totalCycles > 0 ? totalCycles : 1;
  return Object.entries(contrib)
    .map(([op, cycles]) => ({ op, cycles, fraction: cycles / denom }))
    .sort((a, b) => b.cycles - a.cycles);
}

/**
 * Colorize by confidence the effect fits the 33 ms budget (the DECISION):
 *  - green  = even the HIGH estimate leaves > 15% headroom (likely to fit)
 *  - yellow = the band straddles the budget (might fit)
 *  - red    = even the LOW estimate overruns (unlikely to fit)
 */
export function confidenceOf(lowMs: number, highMs: number, budgetMs: number): Confidence {
  if (highMs <= budgetMs * 0.85) return "green";
  if (lowMs > budgetMs) return "red";
  return "yellow";
}

export { NAME_TO_CODE, UN_MATH_NAMES, BIN_MATH_NAMES };
