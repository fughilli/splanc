/**
 * Micro-benchmark calibration programs (docs/design/perf-monitoring.md
 * §"Micro-benchmarks" + §"Calibration flow"). Each isolates one cost so the fit
 * can recover per-opcode cycles + fixed/per-LED overheads:
 *   - per-opcode isolation: a branch-free shade() that is a long chain of one
 *     op; two rep counts (M and 2M) so the slope cancels fixed overhead;
 *   - fixed-overhead isolation: an empty shade / empty update;
 *   - per-LED / transmit isolation: a trivial shader swept over led_count.
 *
 * These ship as effect SOURCE; the calibration flow compiles them in-browser
 * (fx/preview.compileScript), profiles the opcode counts with the same abstract
 * interpreter the offline model uses, uploads them to the device, and reads back
 * a PerfReport. Kept as data (CJS-safe: pure strings + metadata).
 *
 * FUG-79: the suite now covers EVERY opcode the abstract interpreter can emit
 * for a user effect — not just the five float ops it used to fit. The
 * UnMath/BinMath math-dispatch opcodes are fitted PER FN (`UnMath:sqrt`,
 * `BinMath:pow`, …) because a single opcode collapses fns whose soft-float cost
 * differs by an order of magnitude (see costModel.ts `mathFeature`). The
 * coverage partition below ({@link FITTED_OPCODES} / {@link BUCKETED_OPCODES} /
 * {@link EXCLUDED_OPCODES}) is exhaustive and auditable: every opcode reachable
 * from user source is either FITTED with ≥1 isolating benchmark or explicitly
 * BUCKETED/EXCLUDED with a documented rationale — no silent gaps (asserted by
 * tests/calibrationCoverage.test.ts).
 *
 * Isolation is BRANCH-FREE (straight-line chains) so the abstract interpreter's
 * op count is EXACT (min==max, no data-dependent band). Chains feed back through
 * one local so the only per-rep structural ops (one LoadLocal + one StoreLocal)
 * are identical across every chain and get absorbed by shade_fixed; the M→2M
 * slope isolates the target op. Seeds derive from `led.s` (∈[0,1], map- and
 * position-independent) kept strictly positive so domain-guarded fns
 * (sqrt/log/pow) stay on their normal, representative code path rather than an
 * early-out.
 */

/** A single calibration benchmark. */
export interface Benchmark {
  id: string;
  label: string;
  /** effect source compiled to `.fxb` at calibration time. */
  source: string;
  /** the histogram/cost-map feature this bench isolates (see costModel.ts
   * `mathFeature` — math ops are sub-keyed `Family:fn`), or null for overhead. */
  targetOp: string | null;
  /** led_count to run this bench at (per-LED / transmit sweep uses several). */
  ledCount: number;
  /** Calibration tier. `core` = the cost-dominant ops (transcendentals, hashes,
   * vector reductions) that actually move a frame estimate — the fast default;
   * `full` = the complete sweep (adds the cheaper float ALU). The DEFAULT run is
   * the FULL suite (100% coverage); `core` is offered as a quick option. */
  tier: BenchTier;
}

export type BenchTier = "core" | "full";

const S = 32; // statements per isolation chain (held FIXED across the two points).
const CHAIN_LEDS = 128; // fixed LED count for every isolation chain.

/**
 * A branch-free isolation shade(): a vec3 `v` and scalar `a` seeded positive
 * from `led.s`, then `S` copies of `stmt` (a full statement over `v`/`a`),
 * returning `v * a` so neither accumulator is dead. `stmt` must be straight-line
 * (no if/for) so the op count is exact.
 */
function isoShade(stmt: string): string {
  const lines: string[] = [
    "vec3 shade(Led led) {",
    "  vec3 v = vec3(led.s + 0.3, led.s + 0.5, led.s + 0.7);",
    "  float a = led.s * 0.6 + 0.3;",
  ];
  for (let i = 0; i < S; i++) lines.push(`  ${stmt}`);
  lines.push("  return v * a;", "}");
  return lines.join("\n");
}

/** One isolable opcode/feature and how to build its two-point isolation. */
interface OpBench {
  /** histogram/cost feature name (sub-keyed for UnMath/BinMath). */
  op: string;
  /** short id stem for the generated `.fx` files. */
  id: string;
  tier: BenchTier;
  /**
   * NESTABLE ops (preferred): `apply(x)` wraps the accumulator expression in one
   * more application of the op. Both rep points run the SAME number of
   * statements (S); point 2 nests the op TWICE per statement. Because the
   * statement/structural framing (LoadLocal/StoreLocal/PushConst) is IDENTICAL
   * across the two points, the M→2M slope cancels it and isolates the PURE op
   * cost — fixing the pre-existing bias where the fitted cost absorbed its
   * per-statement Load/Store framing (FUG-79 item 5). `acc` is which
   * accumulator it threads (`a` scalar or `v` vec3, for a fixed lane count).
   */
  apply?: (x: string) => string;
  acc?: "a" | "v";
  /**
   * NON-NESTABLE ops (output type ≠ input, e.g. reductions vec3→float, palette
   * float→vec3): fall back to the classic two-point design — S vs 2S copies of
   * `step`. The slope still cancels per-LED fixed overhead, but the fitted cost
   * carries the (cheap, bucketed) per-statement structural framing; documented
   * as a small known bias for these few ops.
   */
  step?: string;
}

/**
 * The isolable float / vector / math / special opcodes. Math ops are sub-keyed
 * by fn. Domain-guarded fns keep their argument in range (sqrt/log/pow via
 * `led.s`-seeded positives) so they measure the normal path, not an early-out.
 * A few benches carry a second FITTED op (e.g. `log` rides an `Add` to stay
 * positive) — separately isolated by its own chain, so the fit stays
 * identifiable.
 */
const OP_BENCHES: OpBench[] = [
  // -- float element-wise ALU (scalar, 1 lane) ------------------------------
  { op: "Add", id: "add", acc: "a", apply: (x) => `(${x} + 0.0001)`, tier: "full" },
  { op: "Sub", id: "sub", acc: "a", apply: (x) => `(${x} - 0.0001)`, tier: "full" },
  { op: "Mul", id: "mul", acc: "a", apply: (x) => `(${x} * 1.0001)`, tier: "full" },
  { op: "Div", id: "div", acc: "a", apply: (x) => `(${x} / 1.0001)`, tier: "core" },
  { op: "Neg", id: "neg", acc: "a", apply: (x) => `(-(${x}))`, tier: "full" }, // pure: no const
  // -- UnMath (per fn) ------------------------------------------------------
  { op: "UnMath:sin", id: "sin", acc: "a", apply: (x) => `sin(${x})`, tier: "core" },
  { op: "UnMath:cos", id: "cos", acc: "a", apply: (x) => `cos(${x})`, tier: "core" },
  { op: "UnMath:tan", id: "tan", acc: "a", apply: (x) => `tan(${x})`, tier: "core" },
  { op: "UnMath:abs", id: "absf", acc: "a", apply: (x) => `abs(${x})`, tier: "full" },
  { op: "UnMath:floor", id: "floorf", acc: "a", apply: (x) => `floor(${x})`, tier: "full" },
  { op: "UnMath:ceil", id: "ceilf", acc: "a", apply: (x) => `ceil(${x})`, tier: "full" },
  { op: "UnMath:fract", id: "fractf", acc: "a", apply: (x) => `fract(${x})`, tier: "full" },
  { op: "UnMath:sign", id: "signf", acc: "a", apply: (x) => `sign(${x})`, tier: "full" },
  { op: "UnMath:sqrt", id: "sqrtf", acc: "a", apply: (x) => `sqrt(${x})`, tier: "core" },
  // exp: tame the argument (·0.01) so it stays ~1 rather than diverging to inf
  // (a soft-float inf path would mis-measure). Each nesting rides one Mul.
  { op: "UnMath:exp", id: "expf", acc: "a", apply: (x) => `exp((${x}) * 0.01)`, tier: "core" },
  // log: +2.0 keeps the argument positive (never the x<=0 early-out). Rides Add.
  { op: "UnMath:log", id: "logf", acc: "a", apply: (x) => `(log(${x}) + 2.0)`, tier: "core" },
  // -- BinMath (per fn) -----------------------------------------------------
  { op: "BinMath:min", id: "minf", acc: "a", apply: (x) => `min(${x}, 0.9)`, tier: "full" },
  { op: "BinMath:max", id: "maxf", acc: "a", apply: (x) => `max(${x}, 0.1)`, tier: "full" },
  { op: "BinMath:pow", id: "powf", acc: "a", apply: (x) => `pow(${x}, 0.5)`, tier: "core" },
  { op: "BinMath:mod", id: "modf", acc: "a", apply: (x) => `mod(${x}, 0.7)`, tier: "core" },
  { op: "BinMath:step", id: "stepf", acc: "a", apply: (x) => `step(0.3, ${x})`, tier: "full" },
  { op: "BinMath:atan2", id: "atan2f", acc: "a", apply: (x) => `atan2(${x}, 0.5)`, tier: "core" },
  // -- vector shaping (fixed 3 lanes; nestable — output type == input) ------
  { op: "Clamp", id: "clamp3", acc: "v", apply: (x) => `clamp(${x}, vec3(0.1,0.1,0.1), vec3(0.9,0.9,0.9))`, tier: "core" },
  { op: "Mix", id: "mix3", acc: "v", apply: (x) => `mix(${x}, vec3(0.2,0.4,0.6), 0.5)`, tier: "core" },
  { op: "Smoothstep", id: "smoothstep3", acc: "v", apply: (x) => `smoothstep(vec3(0.0,0.0,0.0), vec3(1.0,1.0,1.0), ${x})`, tier: "core" },
  { op: "Cross", id: "cross3", acc: "v", apply: (x) => `cross(${x}, vec3(0.2,0.5,0.9))`, tier: "core" },
  { op: "Normalize", id: "normalize3", acc: "v", apply: (x) => `normalize(${x})`, tier: "core" },
  { op: "Hsv2Rgb", id: "hsv2rgb", acc: "v", apply: (x) => `hsv2rgb(${x})`, tier: "core" },
  { op: "Hash1", id: "hash1", acc: "a", apply: (x) => `hash(${x})`, tier: "core" },
  // -- non-nestable (output type ≠ input): classic S / 2S two-point ---------
  { op: "Dot", id: "dot3", step: "a = dot(v, v);", tier: "core" },
  { op: "Length", id: "length3", step: "a = length(v);", tier: "core" },
  { op: "Distance", id: "distance3", step: "a = distance(v, vec3(0.5,0.5,0.5));", tier: "core" },
  { op: "Hash3", id: "hash3", step: "a = hash(v);", tier: "core" },
  { op: "Palette", id: "palette", step: "v = palette0(a);", tier: "core" },
];

/** The opcode features we fit individually — derived from the bench table so
 * they can't drift from the benchmarks. Every entry has ≥1 isolating bench. */
export const FITTED_OPCODES: string[] = OP_BENCHES.map((b) => b.op);

function opBenchmarks(): Benchmark[] {
  const out: Benchmark[] = [];
  for (const b of OP_BENCHES) {
    // Two points. Nestable: SAME S statements, 1 vs 2 op applications (slope
    // cancels the per-statement structural framing → pure op cost). Non-nestable:
    // S vs 2S copies of a fixed statement (classic slope; small structural bias).
    const points: { id: string; source: string; ops: number }[] = b.apply
      ? [1, 2].map((k) => {
          const acc = b.acc ?? "a";
          let expr: string = acc;
          for (let i = 0; i < k; i++) expr = b.apply!(expr);
          return { id: k === 1 ? "M" : "2M", source: isoShade(`${acc} = ${expr};`), ops: k * S };
        })
      : [1, 2].map((mult) => {
          const lines = ["vec3 shade(Led led) {", "  vec3 v = vec3(led.s + 0.3, led.s + 0.5, led.s + 0.7);", "  float a = led.s * 0.6 + 0.3;"];
          for (let i = 0; i < mult * S; i++) lines.push(`  ${b.step!}`);
          lines.push("  return v * a;", "}");
          return { id: mult === 1 ? "M" : "2M", source: lines.join("\n"), ops: mult * S };
        });
    for (const p of points) {
      out.push({
        id: `${b.id}${p.id}`,
        label: `${b.op} ×${p.ops}`,
        source: p.source,
        targetOp: b.op,
        ledCount: CHAIN_LEDS,
        tier: b.tier,
      });
    }
  }
  return out;
}

/** The full benchmark suite: overhead + per-LED sweep + two-point (M, 2M) per
 * isolated op. Ordered overhead-first so the early progress ticks are cheap. */
export const BENCHMARKS: Benchmark[] = [
  // -- fixed overhead --------------------------------------------------------
  {
    id: "empty",
    label: "empty shade",
    source: "vec3 shade(Led led) { return vec3(0.0, 0.0, 0.0); }",
    targetOp: null,
    ledCount: 128,
    tier: "core",
  },
  // -- per-LED / transmit sweep (trivial shader over several led counts) ------
  {
    id: "sweep16",
    label: "transmit @16",
    source: "vec3 shade(Led led) { return vec3(led.pos.x, 0.0, 0.0); }",
    targetOp: null,
    ledCount: 16,
    tier: "core",
  },
  {
    id: "sweep256",
    label: "transmit @256",
    source: "vec3 shade(Led led) { return vec3(led.pos.x, 0.0, 0.0); }",
    targetOp: null,
    ledCount: 256,
    tier: "core",
  },
  // -- per-opcode isolation (two rep points each) ----------------------------
  ...opBenchmarks(),
];

/** The benchmarks for a given tier. `full` (the default) returns the whole
 * suite → 100% opcode coverage; `core` returns only the cost-dominant ops (a
 * faster run) plus every overhead/sweep bench. */
export function benchmarksForTier(tier: BenchTier): Benchmark[] {
  if (tier === "full") return BENCHMARKS;
  return BENCHMARKS.filter((b) => b.tier === "core" || b.targetOp === null);
}

// -- opcode coverage partition (auditable checklist, FUG-79) -----------------

/**
 * Opcodes reachable from user source that we DON'T fit individually — they ride
 * fixed-overhead + the fallback cost. Each carries a documented rationale.
 * These are not silent gaps: the coverage test asserts this list plus
 * {@link FITTED_OPCODES} and {@link EXCLUDED_OPCODES} exactly partitions the
 * user-reachable opcode set.
 */
export const BUCKETED_OPCODES: Record<string, string> = {
  // Structural stack / load / store / control flow. These appear at an
  // essentially FIXED ratio to real work in every program (one seed load, one
  // store per chain step, the loop framing), so they are collinear and not
  // independently identifiable by the fit. Their tiny per-op cost is absorbed
  // into shade_fixed / update_fixed and the cheap-op fallback.
  PushConst: "structural: constant push, collinear; rides shade_fixed/fallback",
  LoadUniform: "structural: uniform load, collinear; rides fallback",
  LoadState: "structural: state load, collinear; rides fallback",
  StoreState: "structural: state store, collinear; rides fallback",
  LoadLocal: "structural: local load (one per chain step); rides shade_fixed",
  StoreLocal: "structural: local store (one per chain step); rides shade_fixed",
  LoadCtx: "structural: context load (led.*/time), collinear; rides shade_fixed",
  Swizzle: "structural: component select / broadcast, collinear; rides fallback",
  Swap: "structural: stack reorder (compiler-inserted), collinear; rides fallback",
  Cmp: "structural: float compare feeding a branch, collinear; rides fallback",
  Logic: "structural: boolean and/or/not, collinear; rides fallback",
  BrFalse: "control flow: conditional branch, collinear with Cmp; rides fallback",
  Jmp: "control flow: unconditional jump, collinear; rides fallback",
  Call: "control flow: user-fn call framing, collinear; rides fallback",
  Ret: "control flow: shade/update return (one per invocation); rides *_fixed",
  RetFn: "control flow: user-fn return, collinear with Call; rides fallback",
  // Integer fast-path ALU — runs on the RISC-V integer unit (no soft-float),
  // individually cheap, and AddI/SubI/CmpI are the `for`-loop counter ops that
  // appear in essentially every effect. Bucketed as cheap-integer; a dedicated
  // int/fixed tier could measure them later (see docs/design/perf-monitoring.md).
  AddI: "cheap integer add (loop counters); rides fallback",
  SubI: "cheap integer subtract; rides fallback",
  MulI: "cheap integer multiply; rides fallback",
  DivI: "integer divide (RISC-V M-ext); rides fallback — see int/fixed follow-up",
  ModI: "integer remainder; rides fallback — see int/fixed follow-up",
  NegI: "cheap integer negate; rides fallback",
  CmpI: "cheap integer compare (loop guards); rides fallback",
  // Type conversions — only ever appear as COLLINEAR round-trip pairs (I2F is
  // undone by F2I to keep an accumulator's type stable across a loop), so a
  // single conversion is not independently identifiable. Cheap; ride fallback.
  I2F: "conversion int→float; collinear round-trip, unidentifiable; rides fallback",
  F2I: "conversion float→int; collinear round-trip, unidentifiable; rides fallback",
  Fix2F: "conversion fixed→float; collinear round-trip; rides fallback",
  F2Fix: "conversion float→fixed; collinear round-trip; rides fallback",
  I2Fix: "conversion int→fixed; collinear round-trip; rides fallback",
  Fix2I: "conversion fixed→int; collinear round-trip; rides fallback",
  // Reduced-precision fixed-point fast path (FUG-10). Integer-domain, advanced,
  // and rarely used; isolating them needs fixed8/fixed16 typed accumulators.
  // Bucketed to seeded defaults pending a dedicated fixed-point tier.
  MulFix: "Q16.16 multiply (FUG-10 fast path); seeded default — fixed-point tier TODO",
  DivFix: "Q16.16 divide (FUG-10); seeded default — fixed-point tier TODO",
  MulFixN: "narrow fixed multiply (FUG-10); seeded default — fixed-point tier TODO",
  DivFixN: "narrow fixed divide (FUG-10); seeded default — fixed-point tier TODO",
  FixRescale: "fixed-format rescale shift (FUG-10); seeded default — fixed-point tier TODO",
  FixToF: "fixed→float boundary (FUG-10); seeded default — fixed-point tier TODO",
  FixFromF: "float→fixed boundary (FUG-10); seeded default — fixed-point tier TODO",
  SinFix: "reduced-precision sin (FUG-10); seeded default — fixed-point tier TODO",
  CosFix: "reduced-precision cos (FUG-10); seeded default — fixed-point tier TODO",
  ExpFix: "reduced-precision exp (FUG-10); seeded default — fixed-point tier TODO",
  // Resource-dependent ops — need a declared array / buffer / texture / topology
  // graph and a bound arena to execute meaningfully. A branch-free isolation
  // chain would measure a clamped no-op, not the real access. These belong to a
  // follow-up DEVICE-RESOURCE bench tier (declare a buffer/texture/array + a
  // stub graph); until then they ride seeded defaults.
  LoadStateIdx: "indexed state load; needs an array — device-resource tier TODO",
  StoreStateIdx: "indexed state store; needs an array — device-resource tier TODO",
  LoadLocalIdx: "indexed local load; needs an array — device-resource tier TODO",
  StoreLocalIdx: "indexed local store; needs an array — device-resource tier TODO",
  LoadBuf: "buffer element load; needs a declared buffer + arena — resource tier TODO",
  StoreBuf: "buffer element store; needs a declared buffer + arena — resource tier TODO",
  SampleTex: "bilinear texture sample; needs a texture + arena — resource tier TODO",
  PaintTex: "texture write; needs a texture + arena — resource tier TODO",
  GraphQuery: "topology query; needs a bound graph — resource tier TODO",
  FloodFrom: "geodesic flood source; needs a bound graph — resource tier TODO",
};

/**
 * Opcodes the VM defines but the compiler NEVER emits from surface source, so
 * they can't appear in a user effect's histogram. Documented for completeness.
 */
export const EXCLUDED_OPCODES: Record<string, string> = {
  Scale: "unreachable: the compiler lowers vec×scalar to Swizzle-broadcast + Mul, never Scale",
  Pop: "unreachable: `_POP` in fx_compiler — the compiler never emits an explicit stack pop",
};

/**
 * The held-out validation program: the FUG-79 "lava lamp" effect — a shade()
 * loop that sums N wave terms, each built from ~6 `hash()` calls, a
 * `normalize(vec3)`, a `dot`, and a `sin`, plus a `smoothstep` + `mix`. It is
 * dominated by Hash1 + Normalize (the exact ops the old five-op calibration
 * never measured, which made the model ~10× low on this effect). It also
 * exercises a bounded `for` with a DATA-DEPENDENT guard (`if (i < n)`), so the
 * reported before/after residual reflects a real, branchy effect — not a
 * straight-line sin chain. Kept OUT of the fit.
 */
export const HELDOUT: Benchmark = {
  id: "lavalamp",
  label: "lava lamp (held-out)",
  ledCount: 200,
  targetOp: null,
  tier: "core",
  source: `uniform float speed : 0.0 .. 2.0 = 0.4;
uniform float waves : 2.0 .. 8.0 = 5.0;
uniform float scale : 1.0 .. 12.0 = 5.0;
uniform float thresh : 0.0 .. 1.0 = 0.45;
uniform float soft : 0.02 .. 0.6 = 0.25;
uniform vec3 hot : color = 1.0, 0.4, 0.05;
uniform vec3 cool : color = 0.7, 0.05, 0.5;
uniform vec3 bg : color = 0.02, 0.0, 0.05;
void update() {}
vec3 shade(Led led) {
  vec3 p = led.pos;
  float f = 0.0;
  int n = int(waves);
  for (int i = 0; i < 8; i = i + 1) {
    if (i < n) {
      float fi = float(i);
      vec3 dir = normalize(vec3(
        hash(fi * 1.3 + 0.7) - 0.5,
        hash(fi * 2.9 + 3.1) - 0.5,
        hash(fi * 5.7 + 4.9) - 0.5));
      float u = dot(p, dir);
      float k = scale * (0.5 + hash(fi * 1.7 + 0.3));
      float rate = 0.3 + hash(fi * 2.3 + 1.1) * 1.2;
      float phase = hash(fi * 4.1 + 2.7) * 6.28;
      float wob = 0.4 * sin(time * speed * 0.37 + fi);
      f = f + sin(u * k + time * speed * (rate + wob) + phase);
    }
  }
  f = 0.5 + 0.5 * (f / waves);
  float m = smoothstep(thresh - soft, thresh + soft, f);
  vec3 lava = mix(cool, hot, clamp(f, 0.0, 1.0));
  return mix(bg, lava, m);
}`,
};

/** All held-out validation programs (kept out of the fit). Currently the lava
 * lamp; a list so more representative shapes can be added. */
export const HELDOUTS: Benchmark[] = [HELDOUT];
