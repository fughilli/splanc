/**
 * Actionable cost findings for an effect: what to change, and roughly how many
 * cycles per LED each change would save. Returned next to the frame estimate
 * (the agent's `estimate_effect`, the editor AI's `estimate_performance`) so a
 * model that is over budget knows WHAT to change, not just that it is slow
 * (docs/design/fx-perf-study.md, Q2: "close the estimate loop").
 *
 * A TypeScript port of the perf-lint rules in tools/fx_agent_eval/analyze.py,
 * working on the compiled `.fxb` (so it sees what the optimizer and the
 * variance pass left, and works with any compiler build):
 *
 *  - per-op execution counts for one shade() (callees inlined, counted loops
 *    walked by their trip count, every branch arm counted — an upper bound —
 *    except the steady-state per-LED cache hit and the first-frame
 *    `if (!ready) { buf[i] = ... }` fill, which don't run every frame);
 *  - a variance analysis (abstract interpretation of the operand stack and the
 *    locals over the shade CFG): every value is const / frame (time, uniforms,
 *    state) / led (led.* only) / dynamic, with control taint from branches;
 *  - rules that price the cheaper form with the cost table, ranked by savings.
 *
 * Source lines are found textually (the builtin's occurrences inside the
 * per-LED functions), so they are a pointer, not a proof. Pure + CJS-safe.
 */

import {
  costFor,
  decodeOp,
  DISPATCH_FEATURE,
  fusedFeatures,
  mathFeature,
  parseFxb,
  type CostTable,
  type DecodedOp,
} from "./costModel";

export interface PerfFinding {
  /** Stable rule id (mirrors analyze.py's rule names). */
  rule: string;
  /** One sentence: what is slow and what to write instead. */
  message: string;
  /** Estimated cycles per LED per frame the change saves (upper bound). */
  cyclesPerLed: number;
  /** 1-based source lines it points at (textual match), when source was given. */
  lines: number[];
}

export interface FindingsOptions {
  table: CostTable;
  /** Effect source, for line numbers. */
  source?: string | undefined;
  /** The compiler's perf warnings for this source (line-precise; folded in). */
  warnings?: { line: number; col: number; msg: string }[] | undefined;
  /** Max findings (default 3). */
  max?: number | undefined;
}

// -- variance lattice (analyze.py's C/F/L/Dy) ---------------------------------
const C = 0; // const
const F = 1; // per-frame
const L = 2; // per-LED (led.* only)
const D = 3; // dynamic
type V = 0 | 1 | 2 | 3;
const join = (a: V, b: V): V => (a === b ? a : (a === F && b === L) || (a === L && b === F) ? D : (Math.max(a, b) as V));
const joinAll = (xs: V[], init: V = C): V => xs.reduce<V>((r, x) => join(r, x), init);

// Context ids (fx_compiler fx_ctx / the disassembler's ctx_name).
const CTX_WIDTH: Record<number, number> = { 3: 3, 9: 3, 10: 3, 12: 2, 13: 3, 14: 3, 15: 3 };
const CTX_FRAME = new Set([0, 1, 2, 5, 9, 10, 14, 15]); // time dt frame led.count imu.* room.*
// Fixed per map (memo.rs ctx_variance): pos idx seg s branch uv. Everything
// else is dynamic — led.dist (flood_from() re-roots it per frame), led.room
// (follows the fixture pose, not a map upload) and any id added later.
const CTX_LED = new Set([3, 4, 6, 7, 8, 12]);
const UN = ["sin", "cos", "abs", "floor", "ceil", "fract", "sqrt", "exp", "log", "sign", "tan"];
const BIN = ["min", "max", "pow", "mod", "step", "atan2"];

/** Builtin name of a FLOAT heavy op (the ones the rules price), else null. */
function heavyName(o: DecodedOp): string | null {
  if (o.name === "UnMath") {
    const f = UN[o.operand(0)];
    return f && ["sin", "cos", "tan", "sqrt", "exp", "log"].includes(f) ? f : null;
  }
  if (o.name === "BinMath") {
    const f = BIN[o.operand(0)];
    return f === "pow" || f === "atan2" ? f : null;
  }
  return (
    {
      Length: "length",
      Normalize: "normalize",
      Distance: "distance",
      Smoothstep: "smoothstep",
      Hsv2Rgb: "hsv2rgb",
      Palette: "palette",
      Hash1: "hash",
      Hash3: "hash",
      SampleTex: "sample",
    } as Record<string, string>
  )[o.name] ?? null;
}

const FLOAT_ARITH = new Set(["Add", "Sub", "Mul", "Div", "Scale", "Mix", "Clamp", "Dot", "MulAdd"]);

// R8 operand-fused ops (fx_compiler opt.rs `fuse_operands`): `BinTop mode a`
// is `X a ; OP` and `BinPair mode a b` is `X a ; Y b ; OP`, where the mode's
// bits 2-3 / 4-5 say what X / Y load (const, local, state, uniform), bits 0-1
// the op (add/sub/mul/div) and bit 6 the integer form (AddI/SubI/MulI/MulFix).
// The loaded operand is NOT on the stack, so its variance must come from the
// mode — reading only the stack would call `led.uv.x * 9.0 + state0`
// (= led.uv.x * 9.0 + time * speed after hoisting) LED-invariant.
const fusedSrc = (mode: number, slot: 0 | 1): number => (mode >> (slot === 0 ? 2 : 4)) & 3;
const fusedFloatOp = (o: DecodedOp): string | null =>
  (o.name === "BinTop" || o.name === "BinPair") && (o.operand(0) & 0x40) === 0
    ? (["Add", "Sub", "Mul", "Div"][o.operand(0) & 3] ?? null)
    : null;
const TO_FLOAT = new Set(["I2F", "Fix2F", "FixToF"]);
const FROM_FLOAT = new Set(["F2I", "F2Fix", "FixFromF"]);

interface Prog {
  ops: DecodedOp[];
  byPc: Map<number, number>;
  shade: number;
  entries: number[];
  bufWidth: (id: number) => number;
  consts: Uint32Array;
  code: Uint8Array;
}

function decodeProgram(fxb: Uint8Array): Prog | null {
  let h: ReturnType<typeof parseFxb>;
  try {
    h = parseFxb(fxb);
  } catch {
    return null;
  }
  if (h.shadeEntry === 0xffff) return null;
  const ops: DecodedOp[] = [];
  const byPc = new Map<number, number>();
  for (let pc = 0; pc < h.code.length; ) {
    const o = decodeOp(h.code, pc);
    if (!o) break;
    byPc.set(pc, ops.length);
    ops.push(o);
    pc = o.next;
  }
  // Buffer element widths (buffer table after the code; flags bit 0).
  const widths: number[] = [];
  const flags = fxb[5] ?? 0;
  const manifestLen = fxb[8]! | (fxb[9]! << 8);
  const nConsts = fxb[10]! | (fxb[11]! << 8);
  const codeLen = fxb[12]! | (fxb[13]! << 8);
  let t = 18 + manifestLen + nConsts * 4 + codeLen;
  if (flags & 0x01) {
    const n = fxb[t] ?? 0;
    for (let i = 0; i < n; i++) widths.push(Math.max(1, fxb[t + 1 + i * 7 + 1] ?? 1));
    t += 1 + n * 7;
  }
  const calls = ops.filter((o) => o.name === "Call").map((o) => o.target!);
  const entries = [...new Set([h.updateEntry, h.shadeEntry, h.prepEntry, ...calls].filter((e) => e !== 0xffff))].sort(
    (a, b) => a - b,
  );
  const bufWidth = (id: number): number => widths[id] ?? 1;
  return { ops, byPc, shade: h.shadeEntry, entries, bufWidth, consts: h.consts, code: h.code };
}

/** (pops, pushes) in stack slots. */
function effect(o: DecodedOp, p: Prog): [number, number] {
  const n = o.lanes;
  const a = o.operand;
  switch (o.name) {
    case "PushConst":
      return [0, 1];
    case "LoadUniform":
    case "LoadState":
    case "LoadLocal":
      return [0, a(1)];
    case "StoreState":
    case "StoreLocal":
      return [a(1), 0];
    case "TeeLocal":
      return [a(1), a(1)];
    case "FillLocal":
    case "IncLocalI":
    case "Jmp":
    case "Call":
    case "RetFn":
    case "JitCall":
      return [0, 0];
    case "LoadCtx":
      return [0, CTX_WIDTH[a(0)] ?? 1];
    case "LoadCtxFix":
      return [0, 1];
    case "LoadCtxLanes": // id, src, k, m
      return [0, a(3)];
    case "PushConsts":
      return [0, a(0)];
    case "BinTop":
      return [1, 1];
    case "BinPair":
      return [0, 1];
    case "MulAdd":
      return [3 * n, n];
    case "Add":
    case "Sub":
    case "Mul":
    case "Div":
    case "BinMath":
      return [2 * n, n];
    case "Neg":
    case "UnMath":
    case "Normalize":
    case "NormalizeFix":
      return [n, n];
    case "Scale":
    case "ScaleFix":
      return [n + 1, n];
    case "Clamp":
    case "Smoothstep":
    case "SmoothstepFix":
    case "ClampVFix":
      return [3 * n, n];
    case "Mix":
    case "MixVFix":
      return [2 * n + 1, n];
    case "Dot":
    case "Distance":
    case "DotFix":
    case "DistanceFix":
      return [2 * n, 1];
    case "Length":
    case "LengthFix":
      return [n, 1];
    case "Cross":
    case "CrossFix":
      return [6, 3];
    case "Swizzle":
      return [a(0), a(1)];
    case "Logic":
      return a(0) === 2 ? [1, 1] : [2, 1];
    case "BrFalse":
      return [1, 0];
    case "BrCmpI":
      return [2, 0];
    case "Hash1":
    case "HashFix":
      return [1, 1];
    case "Hash3":
    case "Hash3Fix":
      return [3, 1];
    case "Hsv2Rgb":
    case "Hsv2RgbFix":
      return [3, 3];
    case "Palette":
    case "PaletteFix":
      return [1, 3];
    case "Pop":
    case "Ret":
      return [a(0), 0];
    case "RetRgb8":
    case "RetRgbFix":
      return [3, 0];
    case "Swap":
      return [a(0) + a(1), a(0) + a(1)];
    case "ClampI":
    case "MixFix":
      return [3, 1];
    case "LoadStateIdx":
    case "LoadLocalIdx":
      return [1, a(3)];
    case "StoreStateIdx":
    case "StoreLocalIdx":
      return [a(3) + 1, 0];
    case "GraphQuery":
      return [({ 1: 1, 2: 2, 3: 1, 4: 2, 5: 2, 7: 1 } as Record<number, number>)[a(0)] ?? 0, 1];
    case "LoadBuf":
      return [1, p.bufWidth(a(0))];
    case "StoreBuf":
      return [p.bufWidth(a(0)) + 1, 0];
    case "SampleTex":
      return [2, p.bufWidth(a(0))];
    case "PaintTex":
      return [p.bufWidth(a(0)) + 2, 0];
    case "FloodFrom":
      return [1, 0];
    case "I2cWrite":
      return [2, 0];
    case "LoadLedCache":
      return [0, a(1)];
    case "StoreLedCache":
      return [a(1), a(1)];
    case "Cmp":
    case "CmpI":
    case "MulFix":
    case "DivFix":
    case "MulFixN":
    case "DivFixN":
    case "AddI":
    case "SubI":
    case "MulI":
    case "DivI":
    case "ModI":
    case "MinI":
    case "MaxI":
    case "StepI":
    case "Atan2Fix":
    case "PowFix":
      return [2, 1];
    default:
      // unary int/fixed ops + conversions (NegI AbsI SignI FloorFix ... I2F ...)
      return [1, 1];
  }
}

interface Rec {
  res: V;
  args: V[];
}

/** Worklist abstract interpretation of shade() (callees inlined). */
class Variance {
  rec = new Map<number, Rec>();
  cond = new Map<number, V>();
  private readonly p: Prog;
  private readonly ctrl: Map<number, V>;
  constructor(p: Prog, ctrl: Map<number, V>) {
    this.p = p;
    this.ctrl = ctrl;
  }

  run(entry: number, stack: V[], locs: Map<number, V>, depth: number): [V[], Map<number, V>] {
    if (depth > 16) return [stack, locs];
    const p = this.p;
    const states = new Map<number, [V[], Map<number, V>]>([[entry, [stack, new Map(locs)]]]);
    const work = [entry];
    let exit: [V[], Map<number, V>] | null = null;
    let iters = 0;
    while (work.length && iters++ < 20000) {
      const pc = work.pop()!;
      const i = p.byPc.get(pc);
      if (i === undefined) continue;
      const [st0, lc0] = states.get(pc)!;
      let st = [...st0];
      const lc = new Map(lc0);
      const o = p.ops[i]!;
      const [pops, pushes] = effect(o, p);
      if (st.length < pops) st = [...new Array<V>(pops - st.length).fill(C), ...st];
      const args = pops ? st.slice(st.length - pops) : [];
      const base = pops ? st.slice(0, st.length - pops) : st;
      const ct = this.ctrl.get(pc) ?? C;
      let out: V[] = [];
      let succ: number[] = [o.next];
      const a = o.operand;
      switch (o.name) {
        case "PushConst":
        case "PushConsts":
          out = new Array<V>(pushes).fill(C);
          break;
        case "BinTop":
        case "BinPair": {
          // The fused operand(s): const / local / state / uniform.
          const src = (slot: 0 | 1): V => {
            const kind = fusedSrc(a(0), slot);
            const idx = a(1 + 2 * slot) | (a(2 + 2 * slot) << 8);
            return kind === 0 ? C : kind === 1 ? (lc.get(idx) ?? C) : F;
          };
          const fused = o.name === "BinTop" ? src(0) : join(src(0), src(1));
          out = [joinAll(args, fused)];
          break;
        }
        case "LoadUniform":
        case "LoadState":
          out = new Array<V>(pushes).fill(F);
          break;
        case "LoadLocal":
          for (let j = 0; j < pushes; j++) out.push(lc.get(a(0) + j) ?? C);
          break;
        case "StoreLocal":
        case "TeeLocal":
          for (let j = 0; j < a(1); j++) lc.set(a(0) + j, join(args[j] ?? C, ct));
          out = o.name === "TeeLocal" ? [...args] : [];
          break;
        case "FillLocal":
          for (let j = 0; j < a(1); j++) lc.set(a(0) + j, ct);
          break;
        case "IncLocalI":
          lc.set(a(0), join(lc.get(a(0)) ?? C, ct));
          break;
        case "LoadLocalIdx": {
          const cells: V[] = [];
          for (let s = a(0); s < a(0) + a(1) * a(4); s++) cells.push(lc.get(s) ?? C);
          out = new Array<V>(pushes).fill(joinAll([...args, ...cells]));
          break;
        }
        case "StoreLocalIdx": {
          const v = join(joinAll(args), ct);
          for (let s = a(0) + a(2); s < a(0) + a(1) * a(4); s += Math.max(1, a(1)))
            for (let j = 0; j < a(3); j++) lc.set(s + j, join(lc.get(s + j) ?? C, v));
          break;
        }
        case "LoadStateIdx":
          out = new Array<V>(pushes).fill(join(F, joinAll(args)));
          break;
        case "LoadCtx":
        case "LoadCtxFix":
        case "LoadCtxLanes": {
          const id = a(0);
          const c: V = CTX_FRAME.has(id) ? F : CTX_LED.has(id) ? L : D;
          out = new Array<V>(pushes).fill(c);
          break;
        }
        case "LoadBuf":
        case "SampleTex":
          out = new Array<V>(pushes).fill(D); // mutable storage
          break;
        case "LoadLedCache":
          // Steady state: a cache hit pushes the LED-invariant value and skips
          // the memoized body.
          out = new Array<V>(pushes).fill(L);
          succ = [o.target!];
          break;
        case "Swizzle":
          for (let j = 0; j < a(1); j++) out.push(args[a(2 + j)] ?? C);
          break;
        case "Swap":
          out = [...args.slice(a(0)), ...args.slice(0, a(0))];
          break;
        case "BrFalse":
        case "BrCmpI":
          this.cond.set(pc, join(this.cond.get(pc) ?? C, joinAll(args)));
          succ = [o.next, o.target!];
          break;
        case "Jmp":
          succ = [o.target!];
          break;
        case "Call": {
          const [rst, rlc] = this.run(o.target!, st, lc, depth + 1);
          if (!this.rec.has(pc)) this.rec.set(pc, { res: C, args: [] });
          this.merge(states, work, o.next, rst, rlc);
          continue;
        }
        case "RetFn":
        case "Ret":
        case "RetRgb8":
        case "RetRgbFix": {
          if (o.name === "RetFn") {
            exit = exit === null ? [st, lc] : joinState(exit, [st, lc]);
          }
          if (!this.rec.has(pc)) this.rec.set(pc, { res: C, args });
          continue;
        }
        default:
          out = pushes ? new Array<V>(pushes).fill(joinAll(args)) : [];
      }
      const r = this.rec.get(pc) ?? { res: C, args: new Array<V>(args.length).fill(C) };
      if (out.length) r.res = join(r.res, joinAll(out));
      if (r.args.length === args.length) r.args = r.args.map((x, k) => join(x, args[k]!));
      this.rec.set(pc, r);
      const next = [...base, ...out];
      for (const s of succ) this.merge(states, work, s, next, lc);
    }
    return exit ?? [stack, locs];
  }

  private merge(states: Map<number, [V[], Map<number, V>]>, work: number[], pc: number, st: V[], lc: Map<number, V>): void {
    const prev = states.get(pc);
    if (!prev) {
      states.set(pc, [st, new Map(lc)]);
      work.push(pc);
      return;
    }
    const j = joinState(prev, [st, lc]);
    if (!sameState(j, prev)) {
      states.set(pc, j);
      work.push(pc);
    }
  }
}

function joinState(a: [V[], Map<number, V>], b: [V[], Map<number, V>]): [V[], Map<number, V>] {
  let [sa, la] = a;
  let [sb] = b;
  const lb = b[1];
  if (sa.length !== sb.length) {
    const m = Math.min(sa.length, sb.length);
    sa = sa.slice(sa.length - m);
    sb = sb.slice(sb.length - m);
  }
  const lc = new Map(la);
  for (const [k, v] of lb) lc.set(k, join(lc.get(k) ?? C, v));
  return [sa.map((x, i) => join(x, sb[i]!)), lc];
}

function sameState(a: [V[], Map<number, V>], b: [V[], Map<number, V>]): boolean {
  if (a[0].length !== b[0].length || a[0].some((x, i) => x !== b[0][i])) return false;
  if (a[1].size !== b[1].size) return false;
  for (const [k, v] of a[1]) if (b[1].get(k) !== v) return false;
  return true;
}

/** pc -> control-taint class from enclosing data-dependent forward branches. */
function ctrlRegions(p: Prog, cond: Map<number, V>): Map<number, V> {
  const ctrl = new Map<number, V>();
  for (const [bpc, c] of cond) {
    if (c === C) continue;
    const o = p.ops[p.byPc.get(bpc)!]!;
    const t = o.target!;
    if (t <= bpc) continue;
    const regions: [number, number][] = [[o.next, t]];
    const ti = p.byPc.get(t);
    const before = ti !== undefined && ti > 0 ? p.ops[ti - 1]! : null;
    if (before && before.name === "Jmp" && before.target! > t) regions.push([t, before.target!]);
    for (const [lo, hi] of regions)
      for (const op of p.ops) if (op.pc >= lo && op.pc < hi) ctrl.set(op.pc, join(ctrl.get(op.pc) ?? C, c));
  }
  return ctrl;
}

function variance(p: Prog): { rec: Map<number, Rec>; cond: Map<number, V> } {
  let ctrl = new Map<number, V>();
  let v = new Variance(p, ctrl);
  for (let k = 0; k < 4; k++) {
    v = new Variance(p, ctrl);
    v.run(p.shade, [], new Map(), 0);
    const next = ctrlRegions(p, v.cond);
    if (next.size === ctrl.size && [...next].every(([pc, c]) => ctrl.get(pc) === c)) break;
    ctrl = next;
  }
  return { rec: v.rec, cond: v.cond };
}

// -- execution counts -----------------------------------------------------------

interface Loop {
  head: number;
  back: number;
  trips: number;
  known: boolean;
  mult: number;
}

/** Op indices of the function starting at `entry` (functions are contiguous). */
function region(p: Prog, entry: number): number[] {
  const end = p.entries.find((e) => e > entry) ?? Infinity;
  const out: number[] = [];
  for (let i = p.byPc.get(entry) ?? p.ops.length; i < p.ops.length && p.ops[i]!.pc < end; i++) out.push(i);
  return out;
}

function constInt(p: Prog, o: DecodedOp): number {
  return (p.consts[o.operand(0) | (o.operand(1) << 8)] ?? 0) | 0;
}

function loopsOf(p: Prog, entry: number): Omit<Loop, "mult">[] {
  const out: Omit<Loop, "mult">[] = [];
  for (const i of region(p, entry)) {
    const o = p.ops[i]!;
    if (o.name !== "Jmp" || o.target! >= o.pc) continue;
    let trips = 8;
    let known = false;
    const h = p.byPc.get(o.target!);
    if (h !== undefined) {
      const [x, y, z] = [p.ops[h], p.ops[h + 1], p.ops[h + 2]];
      if (x?.name === "LoadLocal" && y?.name === "PushConst" && z?.name === "BrCmpI") {
        const slot = x.operand(0);
        const n = constInt(p, y);
        let init = 0;
        let step = 1;
        const st = p.ops[h - 1];
        const pv = p.ops[h - 2];
        if (st?.name === "StoreLocal" && st.operand(0) === slot && pv?.name === "PushConst") init = constInt(p, pv);
        const inc = p.ops[i - 1];
        if (inc?.name === "IncLocalI" && inc.operand(0) === slot) {
          step = (p.consts[inc.operand(1) | (inc.operand(2) << 8)] ?? 1) | 0 || 1;
        }
        const span = n - init + (z.operand(0) === 1 ? 1 : 0);
        if (step > 0 && span >= 0) {
          trips = Math.ceil(span / step);
          known = true;
        }
      }
    }
    out.push({ head: o.target!, back: o.pc, trips, known });
  }
  return out;
}

function execCounts(p: Prog, skip: Set<number>): { counts: Map<number, number>; loops: Loop[] } {
  const counts = new Map<number, number>();
  const loops: Loop[] = [];
  const walk = (entry: number, mult: number, depth: number): void => {
    if (depth > 16) return;
    const lps = loopsOf(p, entry);
    for (const l of lps) loops.push({ ...l, mult });
    for (const i of region(p, entry)) {
      const o = p.ops[i]!;
      if (skip.has(o.pc)) continue;
      let m = mult;
      for (const l of lps) if (o.pc >= l.head && o.pc <= l.back) m *= l.trips;
      counts.set(o.pc, (counts.get(o.pc) ?? 0) + m);
      if (o.name === "Call") walk(o.target!, m, depth + 1);
    }
  };
  walk(p.shade, 1, 0);
  return { counts, loops };
}

/** PCs that don't run per LED per frame in steady state: memoized bodies behind
 * a LoadLedCache hit, and the first-frame fill `if (<frame cond>) { buf[i]=… }`. */
function steadyStateSkips(p: Prog, cond: Map<number, V>): Set<number> {
  const skip = new Set<number>();
  for (const o of p.ops) {
    if (o.name === "LoadLedCache") for (const x of p.ops) if (x.pc >= o.next && x.pc < o.target!) skip.add(x.pc);
  }
  for (const [bpc, c] of cond) {
    const o = p.ops[p.byPc.get(bpc)!]!;
    if ((c !== F && c !== C) || o.name !== "BrFalse" || o.target! <= bpc) continue;
    const body = p.ops.filter((x) => x.pc > bpc && x.pc < o.target!);
    if (body.some((x) => x.name === "StoreBuf" || x.name === "PaintTex")) for (const x of body) skip.add(x.pc);
  }
  return skip;
}

// -- source lines ---------------------------------------------------------------

interface SrcFn {
  name: string;
  start: number;
  end: number;
}

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

function sourceFunctions(src: string): SrcFn[] {
  const s = stripComments(src);
  const lines = s.split("\n");
  const out: SrcFn[] = [];
  const re = /^\s*\w+\s+(\w+)\s*\([^)]*\)\s*\{/;
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]!);
    if (!m || ["if", "for", "while"].includes(m[1]!)) continue;
    let depth = 0;
    let j = i;
    for (; j < lines.length; j++) {
      for (const ch of lines[j]!) depth += ch === "{" ? 1 : ch === "}" ? -1 : 0;
      if (depth <= 0 && j >= i) break;
    }
    out.push({ name: m[1]!, start: i + 1, end: j + 1 });
  }
  return out;
}

/** 1-based lines in per-LED code (everything but update/poll) matching `re`. */
function perLedLines(src: string | undefined, re: RegExp): number[] {
  if (!src) return [];
  const s = stripComments(src).split("\n");
  const fns = sourceFunctions(src).filter((f) => f.name !== "update" && f.name !== "poll");
  const out: number[] = [];
  for (const f of fns) for (let ln = f.start; ln <= f.end; ln++) if (re.test(s[ln - 1] ?? "")) out.push(ln);
  return [...new Set(out)].sort((a, b) => a - b);
}

// -- rules ------------------------------------------------------------------------

/** Cycles of one execution of `o` under the table (dispatch + lanes × compute;
 * a fused op is priced as the plain ops it stands for, like the estimator). */
function opCycles(o: DecodedOp, t: CostTable, code: Uint8Array): number {
  const disp = t.costs[DISPATCH_FEATURE] ?? 0;
  const fused = fusedFeatures(o.name, code, o.pc);
  if (fused) return disp + fused.reduce((s, [f, w]) => s + w * costFor(t.costs, f, t.fallbackCost), 0);
  return disp + o.lanes * costFor(t.costs, mathFeature(o.name, o.operand(0)), t.fallbackCost);
}

const cyc = (t: CostTable, feature: string, lanes = 1): number =>
  (t.costs[DISPATCH_FEATURE] ?? 0) + lanes * costFor(t.costs, feature, t.fallbackCost);

const fmt = (n: number): string => Math.round(n).toLocaleString("en-US");

/** The top cost findings for compiled `.fxb` (most cycles saved first). */
export function perfFindings(fxb: Uint8Array, opts: FindingsOptions): PerfFinding[] {
  const p = decodeProgram(fxb);
  if (!p) return [];
  const t = opts.table;
  const src = opts.source;
  const { rec, cond } = variance(p);
  const skip = steadyStateSkips(p, cond);
  const { counts, loops } = execCounts(p, skip);
  const all: PerfFinding[] = [];
  const add = (rule: string, cyclesPerLed: number, message: string, lines: number[] = []): void => {
    if (cyclesPerLed >= 100) all.push({ rule, cyclesPerLed: Math.round(cyclesPerLed), message, lines: lines.slice(0, 4) });
  };
  const classOf = (pc: number): V => rec.get(pc)?.res ?? D;

  // Heavy float builtins, grouped by (name, class).
  const heavy = new Map<string, { name: string; cls: V; n: number; cycles: number; lanes: number }>();
  for (const [pc, m] of counts) {
    const o = p.ops[p.byPc.get(pc)!]!;
    const name = heavyName(o);
    if (!name) continue;
    const cls = classOf(pc);
    const key = `${name}/${cls === C ? F : cls}`;
    const h = heavy.get(key) ?? { name, cls: cls === C ? F : cls, n: 0, cycles: 0, lanes: o.lanes };
    h.n += m;
    h.cycles += m * opCycles(o, t, p.code);
    heavy.set(key, h);
  }
  const fixedCost: Record<string, string> = {
    sin: "SinFix",
    cos: "CosFix",
    tan: "TanFix",
    sqrt: "SqrtFix",
    exp: "ExpFix",
    log: "LogFix",
    atan2: "Atan2Fix",
    pow: "PowFix",
    hsv2rgb: "Hsv2RgbFix",
  };
  const times = (n: number): string => (n === 1 ? "" : ` ×${Math.round(n * 10) / 10}`);
  const callRe = (name: string): RegExp => new RegExp(`\\b${name === "hash" ? "hash" : name}\\s*\\(`);
  for (const h of heavy.values()) {
    const lines = perLedLines(src, callRe(h.name));
    const each = h.cycles / Math.max(1, h.n);
    if (h.cls === F) {
      add(
        "frame_invariant_in_shade",
        h.cycles,
        `${h.name}()${times(h.n)} per LED depends only on time/uniforms/state (~${fmt(each)} cycles each): ` +
          `compute it once in update() into a state (the compiler can't hoist it from a helper function)`,
        lines,
      );
      continue;
    }
    if (h.cls === L) {
      add(
        "led_invariant_heavy",
        h.cycles - h.n * cyc(t, "LoadBuf"),
        `${h.name}()${times(h.n)} per LED depends only on led.* (~${fmt(each)} cycles each, every frame): ` +
          `compute it once into a \`buffer\` on the first frame (if (!ready) { buf[led.idx] = …; }) and read it back`,
        lines,
      );
      continue;
    }
    switch (h.name) {
      case "sin":
      case "cos":
      case "tan":
        add(
          "float_trig_in_shade",
          h.cycles - h.n * (cyc(t, fixedCost[h.name]!) + cyc(t, "F2Fix") * 0.5),
          `float ${h.name}()${times(h.n)} per LED (~${fmt(each)} cycles each): keep the phase as a \`fixed\` in ` +
            `TURNS (radians / 6.2832) and call ${h.name}() on it — an integer LUT, ~${fmt(cyc(t, fixedCost[h.name]!))}`,
          lines,
        );
        break;
      case "exp":
      case "pow":
        add(
          `${h.name}_per_led`,
          h.cycles - h.n * cyc(t, "Mul") * 2,
          `float ${h.name}()${times(h.n)} per LED (~${fmt(each)} cycles each): use multiplies (x*x), a clamp/mix ` +
            `ramp or a polynomial in fixed point${h.name === "exp" ? " (exp of a fixed covers only -2..0.69)" : ""}`,
          lines,
        );
        break;
      case "sqrt":
      case "length":
      case "distance":
        add(
          "length_per_led",
          h.cycles - h.n * cyc(t, "Dot", h.lanes),
          `${h.name}()${times(h.n)} per LED (~${fmt(each)} cycles each): compare squared distances ` +
            `(dot(d, d) < r * r) instead, or take sqrt() of a fixed (~${fmt(cyc(t, "SqrtFix"))})`,
          lines,
        );
        break;
      case "normalize":
        add(
          "normalize_per_led",
          h.cycles * 0.7,
          `normalize()${times(h.n)} per LED (~${fmt(each)} cycles each): drop it where only a direction ` +
            `sign or a dot ratio is needed, or precompute normalized vectors in update()`,
          lines,
        );
        break;
      case "smoothstep":
        add(
          "smoothstep_per_led",
          h.cycles - h.n * h.lanes * (cyc(t, "SubI") + cyc(t, "MulFix") + cyc(t, "ClampI")),
          `smoothstep()${times(h.n)} per LED (~${fmt(each)} cycles each, always float): in fixed point ` +
            `clamp((x - a) * k, fixed(0.0), fixed(1.0)) is ~${fmt(cyc(t, "SubI") + cyc(t, "MulFix") + cyc(t, "ClampI"))}`,
          lines,
        );
        break;
      case "hsv2rgb":
      case "palette":
        add(
          "float_color_per_led",
          h.cycles - h.n * cyc(t, h.name === "hsv2rgb" ? "Hsv2RgbFix" : "PaletteFix"),
          `float ${h.name}()${times(h.n)} per LED (~${fmt(each)} cycles each): pass ${
            h.name === "hsv2rgb" ? "three args of the same fixed type (hsv2rgb(h, fixed(0.9), fixed(1.0)))" : "a fixed arg"
          } for the integer path and return it from shade(), or precompute a colour table`,
          lines,
        );
        break;
      case "atan2":
        add(
          "atan2_per_led",
          h.cycles - h.n * cyc(t, "Atan2Fix"),
          `float atan2()${times(h.n)} per LED (~${fmt(each)} cycles each): atan2 of two fixed args is ~${fmt(
            cyc(t, "Atan2Fix"),
          )} and returns TURNS (-0.5..0.5)`,
          lines,
        );
        break;
      case "hash":
        if (h.n >= 4)
          add(
            "noise_octaves_per_led",
            h.cycles * 0.75,
            `${Math.round(h.n)} hash() calls per LED (value-noise corners/octaves, ~${fmt(each)} each plus the ` +
              `floor/fract/mix around them): bake the noise into a \`state fixed\` lattice in update() and look it up`,
            lines,
          );
        break;
      case "sample":
        add(
          "texture_sample_per_led",
          h.cycles * 0.5,
          `sample()${times(h.n)} per LED (a bilinear float sample): if the texture is static or coarse, ` +
            `index it as tex[i] (nearest) or cache the sample in a buffer`,
          lines,
        );
        break;
    }
  }

  // Cheap per-frame work left per LED (aggregate).
  let frameCheap = 0;
  let frameCheapN = 0;
  for (const [pc, m] of counts) {
    const o = p.ops[p.byPc.get(pc)!]!;
    // Frame class only: const-class ops left after constant folding are loop
    // counters, not hoistable work.
    if (heavyName(o) || rec.get(pc)?.res !== F) continue;
    const [, pushes] = effect(o, p);
    if (pushes === 0 || /^(Load|Push|Swizzle|Swap)/.test(o.name)) continue;
    frameCheap += m * opCycles(o, t, p.code);
    frameCheapN += m;
  }
  if (frameCheapN >= 3)
    add(
      "frame_invariant_in_shade",
      frameCheap,
      `${Math.round(frameCheapN)} per-LED ops compute values that depend only on time/uniforms/state ` +
        `(time * speed, uniform maths): compute them once in update() into state`,
      perLedLines(src, /\b(time|dt|frame)\b/),
    );

  // Float literals / values pushing fixed maths through soft-float: a convert
  // to float followed (within a few ops) by a convert back.
  let roundTrips = 0;
  for (let i = 0; i < p.ops.length; i++) {
    const o = p.ops[i]!;
    const m = counts.get(o.pc);
    if (!m || !TO_FLOAT.has(o.name) || o.name === "I2F") continue;
    for (let j = i + 1; j < Math.min(i + 8, p.ops.length); j++) {
      const x = p.ops[j]!;
      if (FROM_FLOAT.has(x.name) && x.name !== "F2I") {
        roundTrips += m;
        break;
      }
      if (/^(StoreLocal|TeeLocal|Ret|BrFalse|Jmp|Call|BrCmpI)/.test(x.name)) break;
    }
  }
  const litWarnings = (opts.warnings ?? []).filter((w) => /float literal/.test(w.msg));
  const warnLines = [...new Set(litWarnings.map((w) => w.line))];
  if (roundTrips > 0 || litWarnings.length > 0)
    add(
      "float_literal_in_fixed",
      Math.max(roundTrips, litWarnings.length) * (2 * cyc(t, "Fix2F") + cyc(t, "Mul") - cyc(t, "MulFix")),
      `${Math.max(roundTrips, litWarnings.length)} fixed→float→fixed round trip(s) per LED (a float literal or ` +
        `float value inside fixed maths): wrap literals in fixed(…) and keep both operands fixed`,
      warnLines.length ? warnLines : [],
    );

  // pow(x, 2.0)-style warnings from the compiler (line-precise).
  for (const w of opts.warnings ?? [])
    if (/^perf: pow\(/.test(w.msg))
      add("pow_const_exponent", cyc(t, "BinMath:pow") - 2 * cyc(t, "Mul"), w.msg.replace(/^perf: /, ""), [w.line]);

  // Many float arithmetic ops (a per-LED float pipeline) → fixed point.
  let fArith = 0;
  let fArithN = 0;
  for (const [pc, m] of counts) {
    const o = p.ops[p.byPc.get(pc)!]!;
    if (!FLOAT_ARITH.has(o.name) && !fusedFloatOp(o)) continue;
    const c = rec.get(pc)?.res ?? D;
    if (c === F || c === C) continue;
    fArith += m * opCycles(o, t, p.code);
    fArithN += m * o.lanes;
  }
  if (fArithN >= 12)
    add(
      "float_arith_per_led",
      fArith * 0.4,
      `${Math.round(fArithN)} float arithmetic lanes per LED (~${fmt(fArith)} cycles; a vec3 op pays 3 lanes): ` +
        `do the per-LED maths in \`fixed\` scalars (~110 per op) and build the colour vec3 once at the end`,
    );

  // Float division by a constant.
  let divC = 0;
  for (const [pc, m] of counts) {
    const o = p.ops[p.byPc.get(pc)!]!;
    if (fusedFloatOp(o) === "Div") {
      // `x / c` fused as BinTop (divisor = the fused operand) or BinPair (its second).
      if (fusedSrc(o.operand(0), o.name === "BinTop" ? 0 : 1) === 0) divC += m;
      continue;
    }
    if (o.name !== "Div") continue;
    const r = rec.get(pc);
    if (r && r.args.length && joinAll(r.args.slice(r.args.length - o.lanes)) === C) divC += m * o.lanes;
  }
  if (divC)
    add(
      "div_by_const",
      divC * (cyc(t, "Div") - cyc(t, "Mul")),
      `${Math.round(divC)} float division(s) by a constant per LED: multiply by the reciprocal`,
      perLedLines(src, /\/\s*\(?\s*[0-9]+\.[0-9]*/),
    );

  // Loops per LED.
  const forLines = perLedLines(src, /\bfor\s*\(/);
  loops.forEach((l, k) => {
    const n = l.trips * l.mult;
    if (n < 2) return;
    let body = 0;
    for (const o of p.ops)
      if (o.pc >= l.head && o.pc <= l.back) body += (counts.get(o.pc) ?? 0) * opCycles(o, t, p.code);
    add(
      "loop_per_led",
      body * 0.5,
      `a loop runs ${l.trips}${l.known ? "" : "?"} times per LED (~${fmt(body)} cycles): precompute per-item ` +
        `data in update(), skip items far from the LED early, or cut the count`,
      forLines[k] !== undefined ? [forLines[k]!] : [],
    );
  });

  // Conversions not explained by the round-trip rule.
  let conv = 0;
  for (const [pc, m] of counts) {
    const o = p.ops[p.byPc.get(pc)!]!;
    if (TO_FLOAT.has(o.name) || FROM_FLOAT.has(o.name)) conv += m;
  }
  conv -= 2 * roundTrips;
  if (conv >= 4)
    add(
      "conversions_per_led",
      conv * cyc(t, "I2F") * 0.6,
      `${Math.round(conv)} int/fixed↔float conversions per LED (~${fmt(cyc(t, "I2F"))} cycles each): keep a ` +
        `value in one type end to end (all-fixed maths, fixed() context reads)`,
    );

  // Merge same-rule findings (keep the costliest message), rank by savings.
  const byRule = new Map<string, PerfFinding>();
  for (const f of all) {
    const k = `${f.rule}:${f.message.slice(0, 24)}`;
    const prev = byRule.get(k);
    if (!prev || prev.cyclesPerLed < f.cyclesPerLed) byRule.set(k, f);
  }
  return [...byRule.values()].sort((a, b) => b.cyclesPerLed - a.cyclesPerLed).slice(0, opts.max ?? 3);
}

/** One line per finding, with the saving at `ledCount` LEDs. */
export function findingsToLines(fs: PerfFinding[], ledCount: number, cpuHz: number): string[] {
  return fs.map((f) => {
    const ms = (f.cyclesPerLed * ledCount * 1000) / cpuHz;
    const at = f.lines.length ? ` (line${f.lines.length > 1 ? "s" : ""} ${f.lines.join(", ")})` : "";
    return `${f.message}${at} — saves up to ~${fmt(f.cyclesPerLed)} cycles/LED (~${ms.toFixed(1)} ms at ${ledCount} LEDs)`;
  });
}
