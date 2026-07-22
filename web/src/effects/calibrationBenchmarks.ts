/**
 * Micro-benchmark calibration programs (docs/design/perf-monitoring.md
 * §"Micro-benchmarks"). Each isolates one cost so the fit can recover per-opcode
 * cycles + fixed/per-LED overheads:
 *   - per-opcode isolation: a shade() that is a long chain of one op; two rep
 *     counts (M and 2M) so the slope cancels fixed overhead.
 *   - fixed-overhead isolation: an empty shade / empty update.
 *   - per-LED / transmit isolation: a trivial shader swept over led_count.
 *
 * These ship as effect SOURCE; the calibration flow compiles them in-browser
 * (fx/preview.compileScript), profiles the opcode counts with the same abstract
 * interpreter the offline model uses, uploads them to the device, and reads back
 * PerfReport. Kept as data (CJS-safe: pure strings + metadata).
 *
 * Per the "fewer benchmarks first" DECISION we isolate the expensive float ops
 * (Mul, Div, UnMath=sin, BinMath=pow, sqrt via UnMath, Add) and let cheap ops
 * ride the fallback bucket; the residual after the fit tells us if that's enough.
 */

/** An opcode-name whose cost this benchmark targets (for the live "measuring…"
 * ticks and to build the fit's feature set). "" = a fixed/per-LED bench. */
export interface Benchmark {
  id: string;
  label: string;
  /** effect source compiled to `.fxb` at calibration time. */
  source: string;
  /** the opcode this bench isolates (feature name), or null for overhead. */
  targetOp: string | null;
  /** led_count to run this bench at (per-LED / transmit sweep uses several). */
  ledCount: number;
}

/** Build a shade() body repeating `expr` accumulation `reps` times. */
function chainShade(reps: number, step: (i: number) => string): string {
  const lines: string[] = ["  float a = led.pos.x;"];
  for (let i = 0; i < reps; i++) lines.push(`  a = ${step(i)};`);
  return `vec3 shade(Led led) {\n${lines.join("\n")}\n  return vec3(a, a, a);\n}`;
}

const M = 32; // base rep count; the 2M variant doubles it for the slope.

/** The full benchmark suite. Two-point (M, 2M) per isolated op + overhead + sweep. */
export const BENCHMARKS: Benchmark[] = [
  // -- fixed overhead --------------------------------------------------------
  {
    id: "empty",
    label: "empty shade",
    source: "vec3 shade(Led led) { return vec3(0.0, 0.0, 0.0); }",
    targetOp: null,
    ledCount: 128,
  },
  // -- per-LED / transmit sweep (trivial shader over several led counts) ------
  {
    id: "sweep16",
    label: "transmit @16",
    source: "vec3 shade(Led led) { return vec3(led.pos.x, 0.0, 0.0); }",
    targetOp: null,
    ledCount: 16,
  },
  {
    id: "sweep256",
    label: "transmit @256",
    source: "vec3 shade(Led led) { return vec3(led.pos.x, 0.0, 0.0); }",
    targetOp: null,
    ledCount: 256,
  },
  // -- Mul isolation ---------------------------------------------------------
  {
    id: "mulM",
    label: `Mul ×${M}`,
    source: chainShade(M, () => "a * 1.0001"),
    targetOp: "Mul",
    ledCount: 128,
  },
  {
    id: "mul2M",
    label: `Mul ×${2 * M}`,
    source: chainShade(2 * M, () => "a * 1.0001"),
    targetOp: "Mul",
    ledCount: 128,
  },
  // -- Add isolation ---------------------------------------------------------
  {
    id: "addM",
    label: `Add ×${M}`,
    source: chainShade(M, () => "a + 0.0001"),
    targetOp: "Add",
    ledCount: 128,
  },
  {
    id: "add2M",
    label: `Add ×${2 * M}`,
    source: chainShade(2 * M, () => "a + 0.0001"),
    targetOp: "Add",
    ledCount: 128,
  },
  // -- Div isolation ---------------------------------------------------------
  {
    id: "divM",
    label: `Div ×${M}`,
    source: chainShade(M, () => "a / 1.0001"),
    targetOp: "Div",
    ledCount: 128,
  },
  {
    id: "div2M",
    label: `Div ×${2 * M}`,
    source: chainShade(2 * M, () => "a / 1.0001"),
    targetOp: "Div",
    ledCount: 128,
  },
  // -- UnMath (sin) isolation ------------------------------------------------
  {
    id: "sinM",
    label: `sin ×${M}`,
    source: chainShade(M, () => "sin(a)"),
    targetOp: "UnMath",
    ledCount: 128,
  },
  {
    id: "sin2M",
    label: `sin ×${2 * M}`,
    source: chainShade(2 * M, () => "sin(a)"),
    targetOp: "UnMath",
    ledCount: 128,
  },
  // -- BinMath (pow) isolation -----------------------------------------------
  {
    id: "powM",
    label: `pow ×${M}`,
    source: chainShade(M, () => "pow(a, 1.5)"),
    targetOp: "BinMath",
    ledCount: 128,
  },
  {
    id: "pow2M",
    label: `pow ×${2 * M}`,
    source: chainShade(2 * M, () => "pow(a, 1.5)"),
    targetOp: "BinMath",
    ledCount: 128,
  },
];

/** The opcodes we fit individually (the expensive float ops). Everything else
 * rides the default table / fallback bucket, per the DECISION. */
export const FITTED_OPCODES = ["Mul", "Add", "Div", "UnMath", "BinMath"];

/** A held-out benchmark for the before/after accuracy readout (not in the fit). */
export const HELDOUT: Benchmark = {
  id: "heldout",
  label: "mixed (held-out)",
  source: chainShade(M, (i) => (i % 2 === 0 ? "sin(a * 1.3)" : "a * 0.99 + 0.01")),
  targetOp: null,
  ledCount: 200,
};
