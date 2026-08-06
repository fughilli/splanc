/**
 * Export the calibration micro-programs ({@link BENCHMARKS}, {@link HELDOUT}) as
 * `.fx` source files for the HITL benchmark harness (pi/hitl/harness/fx_bench.py
 * `--benchmarks-dir`). The in-browser calibration and the on-hardware HITL run
 * MUST measure the SAME programs, so both derive from this one source of truth;
 * the harness compiles these with fx_compile and runs them on the real C6.
 *
 * Fit programs export as `<id>.fx`; the held-out validation program exports as
 * `<id>.heldout.fx` (the harness's discover_benchmarks() treats `*.heldout.fx`
 * as the validation set the fit never sees). Pure + CJS-safe: a committed
 * generator writes the files, and the drift test pins the output.
 */

import { BENCHMARKS, HELDOUTS, type Benchmark } from "./calibrationBenchmarks";

export interface BenchmarkFile {
  /** File name within the benchmarks dir (`*.heldout.fx` = validation set). */
  filename: string;
  /** `.fx` source compiled by fx_compile on the rig. */
  source: string;
  /** Whether this is a held-out validation program (not used to fit). */
  heldout: boolean;
}

function header(b: Benchmark, heldout: boolean): string {
  return (
    `// Auto-generated from web/src/effects/calibrationBenchmarks.ts — do not edit by hand.\n` +
    `// FUG-11 calibration micro-program: ${b.label}` +
    `${b.targetOp ? ` (isolates ${b.targetOp})` : " (overhead/sweep)"}` +
    `${heldout ? " [HELD-OUT validation]" : ""}.\n` +
    `// Intended LED count: ${b.ledCount}.\n`
  );
}

/** The full set of benchmark files to write out (fit programs + the held-out). */
export function benchmarkFxFiles(): BenchmarkFile[] {
  const files: BenchmarkFile[] = BENCHMARKS.map((b) => ({
    filename: `${b.id}.fx`,
    source: `${header(b, false)}${b.source}\n`,
    heldout: false,
  }));
  for (const h of HELDOUTS) {
    files.push({
      filename: `${h.id}.heldout.fx`,
      source: `${header(h, true)}${h.source}\n`,
      heldout: true,
    });
  }
  return files;
}
