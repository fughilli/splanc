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
  // indexed array/struct access (dynamic index)
  "LoadStateIdx", // 52
  "StoreStateIdx",
  "LoadLocalIdx",
  "StoreLocalIdx",
  // topology graph queries
  "GraphQuery", // 56
  // declared buffers / textures
  "LoadBuf", // 57
  "StoreBuf",
  "SampleTex",
  "PaintTex",
  "FloodFrom", // 61
  // reduced-precision fixed-point (Q1.f) fast path (FUG-10)
  "MulFixN", // 62
  "DivFixN",
  "FixRescale",
  "FixToF",
  "FixFromF",
  "SinFix", // 67
  "CosFix",
  "ExpFix", // 69
  // integer/fixed abs/min/max/clamp + frac-operand builtins
  "AbsI", // 70
  "MinI",
  "MaxI",
  "ClampI",
  "SignI",
  "StepI",
  "FloorFix",
  "CeilFix",
  "FractFix",
  "MixFix", // 79
  // FUG-122 fixed/int vector + transcendental + colour + I/O ops
  "SqrtFix", // 80
  "ScaleFix",
  "DotFix",
  "LengthFix",
  "DistanceFix",
  "NormalizeFix",
  "CrossFix",
  "SmoothstepFix",
  "ClampVFix",
  "MixVFix",
  "Hsv2RgbFix", // 90
  "PaletteFix",
  "Atan2Fix",
  "LogFix",
  "TanFix",
  "PowFix",
  "HashFix",
  "Hash3Fix",
  "RetRgb8",
  "RetRgbFix",
  "LoadCtxFix", // 100
  "FillLocal",
  // FUG-125 superinstructions + JIT dispatch
  "TeeLocal", // 102
  "IncLocalI",
  "BrCmpI",
  "JitCall", // 105
  // FUG-107 sensor-driver I2C intrinsics (drivers only, never in an effect)
  "I2cWrite", // 106
  "I2cRead",
  // per-LED memo bracket (fx_compiler memo.rs)
  "LoadLedCache", // 108
  "StoreLedCache", // 109
  // 110..=119 reserved (never emitted): the walker stops on them like any
  // unknown byte.
  "_reserved110",
  "_reserved111",
  "_reserved112",
  "_reserved113",
  "_reserved114",
  "_reserved115",
  "_reserved116",
  "_reserved117",
  "_reserved118",
  "_reserved119",
  // fx-perf-study R8 operand-fused superinstructions (fx_compiler opt.rs)
  "BinTop", // 120
  "BinPair",
  "PushConsts",
  "LoadCtxLanes",
  "MulAdd", // 124
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
 * The histogram/cost-map feature name for an opcode. Most opcodes are keyed by
 * their name; the two math-dispatch opcodes UnMath/BinMath are sub-keyed by the
 * fn-id operand byte (`"UnMath:sin"`, `"BinMath:pow"`, …) so per-builtin costs
 * — which differ by an order of magnitude on the C6's soft-float — are modeled
 * separately. An unknown fn id falls back to the bare family name. Keep the
 * fn-id decoding in lockstep with firmware/fx_vm/src/lib.rs (the F_ and B_
 * constants + the UnMath/BinMath operand layout [fn, n]). */
export function mathFeature(opName: string, fnId: number | undefined): string {
  if (opName === "UnMath") {
    const fn = UN_MATH_NAMES[fnId ?? -1];
    return fn ? `UnMath:${fn}` : "UnMath";
  }
  if (opName === "BinMath") {
    const fn = BIN_MATH_NAMES[fnId ?? -1];
    return fn ? `BinMath:${fn}` : "BinMath";
  }
  return opName;
}

/**
 * Look up an opcode's cost with a family fallback: an exact sub-keyed entry
 * (`"UnMath:sqrt"`) wins; else the family base (`"UnMath"`); else `fallback`.
 * This lets a device calibration price each math fn individually while older
 * tables / the host smoke profile — keyed only by the bare family — still
 * resolve every fn through the base tier. */
export function costFor(costs: CostMap, name: string, fallback: number): number {
  const exact = costs[name];
  if (exact !== undefined) return exact;
  const colon = name.indexOf(":");
  if (colon > 0) {
    const base = costs[name.slice(0, colon)];
    if (base !== undefined) return base;
  }
  return fallback;
}

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
  /** True for PushConsts: 2 * n bytes of const indices follow the n byte. */
  constTail?: boolean;
  /** Operand offset of the i16 branch rel when it isn't 0 (BrCmpI's kind byte
   * precedes it; LoadLedCache's slot,n). */
  relAt?: number;
  /** LoadLedCache: in steady state (cache bound + filled) the VM jumps past
   * the memoized expression — the estimate prices that path. */
  memoSkip?: boolean;
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
  // indexed access: base,stride,off,n,count — n (lane count) at operand offset 3.
  LoadStateIdx: { operandBytes: 5, lanesAt: 3 },
  StoreStateIdx: { operandBytes: 5, lanesAt: 3 },
  LoadLocalIdx: { operandBytes: 5, lanesAt: 3 },
  StoreLocalIdx: { operandBytes: 5, lanesAt: 3 },
  GraphQuery: { operandBytes: 1, lanesAt: -1 }, // u8 kind
  LoadBuf: { operandBytes: 1, lanesAt: -1 }, // u8 id (elem count is dynamic)
  StoreBuf: { operandBytes: 1, lanesAt: -1 },
  SampleTex: { operandBytes: 1, lanesAt: -1 },
  PaintTex: { operandBytes: 1, lanesAt: -1 },
  FloodFrom: { operandBytes: 0, lanesAt: -1 },
  // reduced-precision fixed-point (FUG-10): all scalar, u8 frac / i8 shift.
  MulFixN: { operandBytes: 1, lanesAt: -1 },
  DivFixN: { operandBytes: 1, lanesAt: -1 },
  FixRescale: { operandBytes: 1, lanesAt: -1 },
  FixToF: { operandBytes: 1, lanesAt: -1 },
  FixFromF: { operandBytes: 1, lanesAt: -1 },
  SinFix: { operandBytes: 1, lanesAt: -1 },
  CosFix: { operandBytes: 1, lanesAt: -1 },
  ExpFix: { operandBytes: 1, lanesAt: -1 },
  AbsI: { operandBytes: 0, lanesAt: -1 },
  MinI: { operandBytes: 0, lanesAt: -1 },
  MaxI: { operandBytes: 0, lanesAt: -1 },
  ClampI: { operandBytes: 0, lanesAt: -1 },
  SignI: { operandBytes: 1, lanesAt: -1 },
  StepI: { operandBytes: 1, lanesAt: -1 },
  FloorFix: { operandBytes: 1, lanesAt: -1 },
  CeilFix: { operandBytes: 1, lanesAt: -1 },
  FractFix: { operandBytes: 1, lanesAt: -1 },
  MixFix: { operandBytes: 1, lanesAt: -1 },
  SqrtFix: { operandBytes: 1, lanesAt: -1 },
  ScaleFix: { operandBytes: 2, lanesAt: 1 }, // frac, n
  DotFix: { operandBytes: 2, lanesAt: 1 },
  LengthFix: { operandBytes: 2, lanesAt: 1 },
  DistanceFix: { operandBytes: 2, lanesAt: 1 },
  NormalizeFix: { operandBytes: 2, lanesAt: 1 },
  CrossFix: { operandBytes: 1, lanesAt: -1 },
  SmoothstepFix: { operandBytes: 2, lanesAt: 1 },
  ClampVFix: { operandBytes: 1, lanesAt: 0 },
  MixVFix: { operandBytes: 2, lanesAt: 1 },
  Hsv2RgbFix: { operandBytes: 1, lanesAt: -1 },
  PaletteFix: { operandBytes: 2, lanesAt: -1 },
  Atan2Fix: { operandBytes: 1, lanesAt: -1 },
  LogFix: { operandBytes: 1, lanesAt: -1 },
  TanFix: { operandBytes: 1, lanesAt: -1 },
  PowFix: { operandBytes: 1, lanesAt: -1 },
  HashFix: { operandBytes: 1, lanesAt: -1 },
  Hash3Fix: { operandBytes: 1, lanesAt: -1 },
  RetRgb8: { operandBytes: 0, lanesAt: -1, ret: true },
  RetRgbFix: { operandBytes: 1, lanesAt: -1, ret: true },
  LoadCtxFix: { operandBytes: 3, lanesAt: -1 },
  FillLocal: { operandBytes: 2, lanesAt: 1 },
  TeeLocal: { operandBytes: 2, lanesAt: 1 },
  IncLocalI: { operandBytes: 3, lanesAt: -1 },
  BrCmpI: { operandBytes: 3, lanesAt: -1, branch: true, relAt: 1 },
  JitCall: { operandBytes: 2, lanesAt: -1 },
  I2cWrite: { operandBytes: 0, lanesAt: -1 },
  I2cRead: { operandBytes: 1, lanesAt: -1 },
  LoadLedCache: { operandBytes: 4, lanesAt: 1, branch: true, relAt: 2, memoSkip: true },
  StoreLedCache: { operandBytes: 2, lanesAt: 1 },
  // R8 fused ops: priced as the plain ops they replace minus their dispatches
  // (see `fusedFeatures`), so fitted tables need no new keys.
  BinTop: { operandBytes: 3, lanesAt: -1 }, // mode, u16
  BinPair: { operandBytes: 5, lanesAt: -1 }, // mode, u16, u16
  PushConsts: { operandBytes: 1, lanesAt: -1, constTail: true }, // n, n x u16
  LoadCtxLanes: { operandBytes: 4, lanesAt: -1 }, // id, src, k, m
  MulAdd: { operandBytes: 1, lanesAt: 0 },
};

const FUSED_SRC = ["PushConst", "LoadLocal", "LoadState", "LoadUniform"] as const;
const FUSED_ARITH = ["Add", "Sub", "Mul", "Div"] as const;
const FUSED_ARITH_INT = ["AddI", "SubI", "MulI", "MulFix"] as const;

/**
 * The cost features of an R8 operand-fused opcode at `at`: the plain ops it
 * stands for (each still priced by its own key), WITHOUT their dispatches —
 * the caller adds one `@dispatch` for the fused op. Undefined for other ops.
 */
export function fusedFeatures(name: string, code: Uint8Array, at: number): Array<[string, number]> | undefined {
  const b = (k: number) => code[at + 1 + k] ?? 0;
  const arith = (mode: number) => ((mode & 0x40) !== 0 ? FUSED_ARITH_INT : FUSED_ARITH)[mode & 3]!;
  switch (name) {
    case "BinTop":
      return [
        [FUSED_SRC[(b(0) >> 2) & 3]!, 1],
        [arith(b(0)), 1],
      ];
    case "BinPair":
      return [
        [FUSED_SRC[(b(0) >> 2) & 3]!, 1],
        [FUSED_SRC[(b(0) >> 4) & 3]!, 1],
        [arith(b(0)), 1],
      ];
    case "PushConsts":
      return [["PushConst", Math.max(1, b(0))]];
    case "LoadCtxLanes":
      return [
        ["LoadCtx", 1],
        ["Swizzle", 1],
      ];
    case "MulAdd":
      return [
        ["Mul", Math.max(1, b(0))],
        ["Add", Math.max(1, b(0))],
      ];
    default:
      return undefined;
  }
}

/** Histogram key for the interpreter's per-opcode dispatch (fetch/decode/
 * budget/jump) — counted once per executed op, NOT lane-weighted. Priced by
 * `@dispatch` in the cost table (absent = 0, so fitted tables that predate it
 * are unchanged). */
export const DISPATCH_FEATURE = "@dispatch";

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
  /** The const pool as raw 32-bit words (ints/fixed ride as bits). */
  consts: Uint32Array;
  updateEntry: number; // NO_ENTRY (0xFFFF) if absent
  shadeEntry: number;
  /** The per-frame prepare entry the compiler's variance pass hoisted
   * frame-invariant shade() work into (memo trailer); NO_ENTRY if absent. The
   * VM runs it once per frame. */
  prepEntry: number;
  /** Per-LED memo words the program requests (0 = none). */
  ledCacheWords: number;
}

const NO_ENTRY = 0xffff;

function rdU16(b: Uint8Array, o: number): number {
  return b[o]! | (b[o + 1]! << 8);
}
function rdI16(b: Uint8Array, o: number): number {
  const v = rdU16(b, o);
  return v >= 0x8000 ? v - 0x10000 : v;
}

/**
 * The uniform values a freshly loaded effect runs with on the device: the
 * manifest's `default` lanes by slot (the firmware seeds them on load since
 * R7), 0 elsewhere. Unparseable manifests give [] (all uniforms 0).
 */
export function manifestDefaults(buf: Uint8Array): number[] {
  if (buf.length < 18) return [];
  const manifestLen = rdU16(buf, 8);
  try {
    const json = JSON.parse(new TextDecoder().decode(buf.subarray(18, 18 + manifestLen))) as Array<{
      slot?: number;
      default?: number[];
    }>;
    const out: number[] = [];
    for (const u of Array.isArray(json) ? json : []) {
      if (typeof u.slot !== "number" || !Array.isArray(u.default)) continue;
      u.default.forEach((v, k) => {
        out[u.slot! + k] = Number(v) || 0;
      });
    }
    return Array.from(out, (v) => v ?? 0);
  } catch {
    return [];
  }
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
  const flags = buf[5]!;
  const o = 18 + manifestLen + nConsts * 4;
  const code = buf.subarray(o, o + codeLen);
  const consts = new Uint32Array(nConsts);
  const c0 = 18 + manifestLen;
  for (let i = 0; i < nConsts; i++) {
    const b = c0 + i * 4;
    consts[i] = (buf[b]! | (buf[b + 1]! << 8) | (buf[b + 2]! << 16) | (buf[b + 3]! << 24)) >>> 0;
  }
  // Optional trailers: buffer table (flags & 0x01), then the memo trailer
  // (flags & 0x20): prep_entry(u16) words(u8) n_groups(u8) groups...
  let t = o + codeLen;
  if (flags & 0x01) t += 1 + (buf[t] ?? 0) * 7;
  let prepEntry = NO_ENTRY;
  let ledCacheWords = 0;
  if (flags & 0x20 && t + 4 <= buf.length) {
    prepEntry = rdU16(buf, t);
    ledCacheWords = buf[t + 2]!;
  }
  return { code, consts, updateEntry, shadeEntry, prepEntry, ledCacheWords };
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
  /** Opcodes executed (NOT lane-weighted) on the min / max path — what the
   * interpreter's per-op dispatch cost ({@link DISPATCH_FEATURE}) scales with. */
  opsMin: number;
  opsMax: number;
  /** True if the walk followed a loop back-edge (a `for` body ran). */
  looped?: boolean;
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
export function walkEntry(
  code: Uint8Array,
  entry: number,
  consts?: Uint32Array,
  uniforms?: ArrayLike<number>,
): WalkResult {
  if (entry === NO_ENTRY || entry >= code.length) {
    return { min: {}, max: {}, branched: false, loopCapped: false, opsMin: 0, opsMax: 0 };
  }
  let branched = false;
  let loopCapped = false;
  let looped = false;
  const visits = new Map<number, number>(); // pc -> times entered (loop cap)
  let steps = 0;
  const STEP_BUDGET = 200_000;
  const OP = (n: OpcodeName): number => NAME_TO_CODE[n]!;
  const constInt = (pcOfPush: number): number | undefined =>
    consts ? (consts[rdU16(code, pcOfPush + 1)] ?? 0) | 0 : undefined;
  const cmpInt = (kind: number, a: number, b: number): boolean =>
    [a < b, a <= b, a > b, a >= b, a === b, a !== b][kind] ?? false;

  // DFS that returns {min,max} op-histograms for the straight-line-plus-branch
  // region starting at `pc`. `depth` bounds recursion for safety. `env` tracks
  // int locals with a compile-time-known value along this path (loop counters:
  // `int i = 0; i < 8; i = i + 1`), so a counted `for` loop is walked for its
  // real trip count instead of the 0..LOOP_TRIP_CAP band.
  type Region = { min: OpHistogram; max: OpHistogram; end: number; env: Map<number, number> };
  function walk(pc: number, depth: number, env: Map<number, number>, stopAt = -1): Region {
    const min: OpHistogram = {};
    const max: OpHistogram = {};
    if (depth > 512) return { min, max, end: -1, env };
    let p = pc;
    const recent: number[] = []; // start pcs of the last few ops on this run
    const prev = (k: number): number => recent[recent.length - k] ?? -1;
    const isOp = (at: number, n: OpcodeName): boolean => at >= 0 && code[at] === OP(n);
    for (;;) {
      if (p === stopAt) return { min, max, end: p, env };
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
      if (name === undefined || name.startsWith("_")) break; // unknown byte — stop this run
      const meta = OP_META[name]!;
      const operandStart = p + 1;
      // vector lane weight from the size operand (scalar cost × lane count).
      let weight = 1;
      if (meta.lanesAt >= 0) {
        const n = code[operandStart + meta.lanesAt] ?? 1;
        weight = Math.max(1, n);
      }
      // UnMath/BinMath collapse many math fns onto one opcode whose per-fn
      // costs differ by an order of magnitude on soft-float (sqrt/exp/log/pow
      // ≫ abs/floor/sign). Sub-key the histogram by the fn-id operand byte so
      // the cost map can price each builtin individually. `costFor` falls the
      // sub-key back to the family base for tables that only price the family.
      const histName = mathFeature(name, code[operandStart]);
      const fused = fusedFeatures(name, code, p);
      for (const [feat, w] of fused ?? [[histName, weight] as [string, number]]) {
        addOp(min, feat, w);
        addOp(max, feat, w);
      }
      addOp(min, DISPATCH_FEATURE, 1);
      addOp(max, DISPATCH_FEATURE, 1);

      // advance PC past operands
      let next = operandStart + meta.operandBytes;
      if (meta.swizzleTail) {
        const dstN = code[operandStart + 1] ?? 0;
        next += dstN;
      }
      if (meta.constTail) next += 2 * (code[operandStart] ?? 0);

      if (meta.ret) break; // Ret / RetFn ends this run

      // Known-int local tracking (see `env`).
      const slot = code[operandStart] ?? 0;
      const width = code[operandStart + 1] ?? 1;
      if (name === "StoreLocal" || name === "TeeLocal") {
        let v1 = isOp(prev(1), "PushConst") ? constInt(prev(1)) : undefined;
        // `int n = int(uniform)` with known uniform values (e.g. a loop bound).
        if (uniforms && isOp(prev(1), "F2I") && isOp(prev(2), "LoadUniform") && code[prev(2) + 2] === 1) {
          v1 = Math.trunc(uniforms[code[prev(2) + 1]!] ?? 0) | 0;
        }
        const inc =
          isOp(prev(1), "AddI") && isOp(prev(2), "PushConst") && isOp(prev(3), "LoadLocal") && code[prev(3) + 1] === slot
            ? constInt(prev(2))
            : undefined;
        for (let k = 0; k < width; k++) env.delete(slot + k);
        if (width === 1 && v1 !== undefined) env.set(slot, v1);
        else if (width === 1 && inc !== undefined && recentEnv.has(slot)) env.set(slot, (recentEnv.get(slot)! + inc) | 0);
      } else if (name === "IncLocalI") {
        const c = consts ? (consts[rdU16(code, operandStart + 1)] ?? 0) | 0 : undefined;
        const cur = env.get(slot);
        if (cur !== undefined && c !== undefined) env.set(slot, (cur + c) | 0);
        else env.delete(slot);
      } else if (name === "FillLocal") {
        for (let k = 0; k < width; k++) env.set(slot + k, 0);
      } else if (name === "StoreLocalIdx" || name === "Call") {
        env.clear();
      }
      if (name === "LoadLocal") recentEnv = new Map(env); // value as loaded (for `i = i + k`)

      if (meta.branch) {
        const rel = rdI16(code, operandStart + (meta.relAt ?? 0));
        const target = next + rel;
        if (name === "Jmp" || meta.memoSkip) {
          // Jmp: unconditional. LoadLedCache: the steady-state cache hit skips
          // the memoized expression (it ran once per LED, at the first frame).
          // Unconditional: follow it (backward jumps bounded by the visit cap).
          recent.push(p);
          // Leaving the current if-arm forward (if/else's jump over the else).
          if (stopAt >= 0 && target > stopAt) return { min, max, end: target, env };
          if (target <= p) looped = true;
          p = target;
          continue;
        }
        // A compile-time-known loop/if condition: follow the one path it takes.
        let known: boolean | undefined;
        // An int operand's value if its push is a const or a known local.
        const srcVal = (at: number): number | undefined =>
          isOp(at, "PushConst") ? constInt(at) : isOp(at, "LoadLocal") ? env.get(code[at + 1]!) : undefined;
        if (name === "BrCmpI") {
          const a = srcVal(prev(2));
          const b = srcVal(prev(1));
          if (a !== undefined && b !== undefined) known = !cmpInt(code[operandStart]!, a, b); // branches if NOT cmp
        } else if (name === "BrFalse" && isOp(prev(1), "CmpI")) {
          const a = srcVal(prev(3));
          const b = srcVal(prev(2));
          if (a !== undefined && b !== undefined) known = !cmpInt(code[prev(1) + 1]!, a, b); // branches if false
        }
        if (known !== undefined) {
          recent.length = 0;
          p = known ? target : next;
          continue;
        }
        // BrFalse: two continuations. Only treat a FORWARD skip as an
        // optional (data-dependent) arm; a backward BrFalse is a loop back-edge
        // we approximate by falling through (the trip cap bounds it).
        if (target > next) {
          branched = true;
          // Structured if / if-else: walk the arm(s) as bounded regions and
          // continue ONCE after them (min = cheaper arm or skip, max = dearer),
          // instead of re-walking the whole tail per path (2^n blow-up).
          const arm = walk(next, depth + 1, new Map(env), target);
          if (arm.end === target) {
            addHist(max, arm.max);
            env = meetEnv(env, arm.env);
            recent.length = 0;
            p = target;
            continue;
          }
          if (arm.end > target) {
            const els = walk(target, depth + 1, new Map(env), arm.end);
            if (els.end === arm.end) {
              const cheap = histTotal(arm.min) <= histTotal(els.min) ? arm.min : els.min;
              const dear = histTotal(arm.max) >= histTotal(els.max) ? arm.max : els.max;
              addHist(min, cheap);
              addHist(max, dear);
              env = meetEnv(arm.env, els.env);
              recent.length = 0;
              p = arm.end;
              continue;
            }
          }
          // Unstructured: both continuations to the end.
          const taken = walk(target, depth + 1, new Map(env), stopAt); // condition false: skip arm
          const fall = walk(next, depth + 1, new Map(env), stopAt); // condition true: run arm
          // min path = cheaper of the two continuations; max = costlier.
          mergeMinMax(min, max, taken, fall);
          return { min, max, end: taken.end === fall.end ? taken.end : -1, env };
        }
        // backward BrFalse: fall through (loop exit path).
        recent.length = 0;
        p = next;
        continue;
      }

      recent.push(p);
      if (recent.length > 4) recent.shift();
      p = next;
    }
    return { min, max, end: -1, env };
  }
  let recentEnv = new Map<number, number>();

  const { min, max } = walk(entry, 0, new Map());
  // The dispatch count rides the histograms during the walk (so branch min/max
  // bookkeeping covers it) but is reported separately: the histograms stay
  // pure opcode features.
  const opsMin = min[DISPATCH_FEATURE] ?? 0;
  const opsMax = max[DISPATCH_FEATURE] ?? 0;
  delete min[DISPATCH_FEATURE];
  delete max[DISPATCH_FEATURE];
  return { min, max, branched, loopCapped, opsMin, opsMax, looped };
}

/** A walk's shade histogram WITH the dispatch count as a {@link
 * DISPATCH_FEATURE} entry — the form the calibration fits consume, so a
 * fitted table prices dispatch separately from each op's compute. */
export function histWithDispatch(w: WalkResult): OpHistogram {
  return { ...w.max, [DISPATCH_FEATURE]: w.opsMax };
}

function addHist(into: OpHistogram, h: OpHistogram): void {
  for (const [k, v] of Object.entries(h)) into[k] = (into[k] ?? 0) + v;
}
function histTotal(h: OpHistogram): number {
  let t = 0;
  for (const v of Object.values(h)) t += v;
  return t;
}
/** Known-int facts that hold on BOTH paths. */
function meetEnv(a: Map<number, number>, b: Map<number, number>): Map<number, number> {
  const out = new Map<number, number>();
  for (const [k, v] of a) if (b.get(k) === v) out.set(k, v);
  return out;
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

/** Σ_op count[op] * cost[op], defaulting unlisted opcodes to `fallback` (and
 * synthetic `@` features such as {@link DISPATCH_FEATURE} to 0). */
export function histCycles(h: OpHistogram, costs: CostMap, fallback: number): number {
  let c = 0;
  for (const [name, count] of Object.entries(h)) {
    c += count * costFor(costs, name, name.startsWith("@") ? 0 : fallback);
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

/**
 * Available-execution-budget model (FUG-11, perf-monitoring.md §"Instruction
 * budget vs `for` bound" DECISION: "estimate how much of the budget we've
 * consumed, preferably in wall time"). The *frame period* (1/fps) is not all
 * available to the FX engine: the LED transmit (`show`) and other system tasks
 * (wss telemetry, scheduler) eat into it. This model captures what fraction of
 * each frame the effect's `update()`+`shade()` actually gets.
 *
 *   frameMs           = 1000 / fps
 *   systemReservedMs  = frameMs * (1 - cpuAvailableFraction)   // other tasks
 *   availableFxMs     = frameMs - systemReservedMs - showMs    // for update+shade
 *
 * `cpuAvailableFraction` is modeled offline and *measured* on-device from a
 * PerfReport (see budget.ts `budgetFromReport`). `transmitReservesCpu` marks
 * whether `show` burns CPU (bit-banged) or is async DMA/RMT (WS2812) — either
 * way the serial firmware render task must fit update+shade+show in one frame,
 * so `show` is subtracted from the FX-engine budget regardless; the flag is
 * carried for future LED types with CPU-bound transmit (the perf-monitoring
 * "other LED types" DECISION).
 */
export interface BudgetModel {
  /** Target frame rate (frames/s); the frame period is 1000/fps ms. */
  fps: number;
  /** Fraction of each frame's CPU available to the FX engine after other
   * system tasks (0..1). Measured on-device, modeled offline. */
  cpuAvailableFraction: number;
  /** True if the LED transmit burns CPU (bit-banged) rather than async DMA. */
  transmitReservesCpu: boolean;
}

/** Default budget model: 30 fps, ~15% of the frame reserved for system tasks,
 * async (DMA/RMT) transmit. Order-of-magnitude until a device measures it. */
export const DEFAULT_BUDGET_MODEL: BudgetModel = {
  fps: 30,
  cpuAvailableFraction: 0.85,
  transmitReservesCpu: false,
};

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
  /** Available-execution-budget model (FUG-11). Optional for back-compat with
   * tables persisted before the budget model existed; callers fall back to
   * {@link DEFAULT_BUDGET_MODEL}. */
  budget?: BudgetModel;
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
  /** Known uniform values by slot (absent slots read 0). Lets the walker
   * resolve uniform-driven loop bounds (`for i < int(waves)`) instead of
   * banding them. Omit when the values are unknown. */
  uniforms?: ArrayLike<number>;
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

  // update(): abstract-interpret once. update_fixed + Σ counts*cost. The
  // per-frame prepare entry (hoisted shade() work) also runs once per frame, so
  // it is priced with update().
  const upWalk = walkEntry(header.code, header.updateEntry, header.consts, inp.uniforms);
  const prepWalk = walkEntry(header.code, header.prepEntry, header.consts, inp.uniforms);
  for (const h of [upWalk.min, upWalk.max]) {
    for (const [k, v] of Object.entries(prepWalk.max)) h[k] = (h[k] ?? 0) + v;
  }
  const upOps = upWalk.opsMax + prepWalk.opsMax;
  upWalk.max[DISPATCH_FEATURE] = upOps;
  upWalk.min[DISPATCH_FEATURE] = upWalk.opsMin + prepWalk.opsMax;
  const updateCyclesMin = table.fixed.update_fixed + histCycles(upWalk.min, table.costs, fb);
  const updateCyclesMax = table.fixed.update_fixed + histCycles(upWalk.max, table.costs, fb);

  // shade(): per-LED. Prefer the dynamic profile histogram if supplied.
  let shadeLooped = false;
  let shadeMinPerLed: number;
  let shadeMaxPerLed: number;
  let shadeHistForHot: OpHistogram;
  let branched = upWalk.branched;
  let loopCapped = upWalk.loopCapped;
  if (inp.dynamicShadeHist && (inp.dynamicLedCount ?? 0) > 0) {
    const perLed: OpHistogram = {};
    let ops = 0;
    for (const [k, v] of Object.entries(inp.dynamicShadeHist)) {
      perLed[k] = v / inp.dynamicLedCount!;
      if (!k.startsWith("@")) ops += v;
    }
    // The dynamic profile counts executed ops (lane-weighted for vectors); its
    // total is a close upper bound on the dispatch count.
    if (perLed[DISPATCH_FEATURE] === undefined) perLed[DISPATCH_FEATURE] = ops / inp.dynamicLedCount!;
    const c = histCycles(perLed, table.costs, fb);
    shadeMinPerLed = c;
    shadeMaxPerLed = c; // exact executed path → no band from shade
    shadeHistForHot = perLed;
  } else {
    const shWalk = walkEntry(header.code, header.shadeEntry, header.consts, inp.uniforms);
    shadeLooped = shWalk.looped === true;
    shWalk.min[DISPATCH_FEATURE] = shWalk.opsMin;
    shWalk.max[DISPATCH_FEATURE] = shWalk.opsMax;
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
  // Control flow (data-dependent branches, loops) is priced less exactly than
  // the straight-line isolation programs the residual was fitted on: widen.
  const controlFlow = branched || loopCapped || upWalk.looped || shadeLooped;
  const resid = Math.max(0, table.residualError) + (controlFlow ? 0.05 : 0);
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
  for (const [k, v] of Object.entries(h)) if (!k.startsWith("@")) t += v;
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
    contrib[op] = (contrib[op] ?? 0) + n * costFor(table.costs, op, op.startsWith("@") ? 0 : fb);
  }
  for (const [op, n] of Object.entries(shadePerLedHist)) {
    contrib[op] = (contrib[op] ?? 0) + n * costFor(table.costs, op, op.startsWith("@") ? 0 : fb) * ledCount;
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
