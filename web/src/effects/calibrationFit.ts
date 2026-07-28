/**
 * Calibration fit (docs/design/perf-monitoring.md §"Calibration flow" §"Fit").
 * Given (predicted opcode counts, measured cycles) per micro-benchmark, solve
 * the small linear system for per-opcode costs + fixed/per-LED overheads via
 * least squares (normal equations with ridge regularization for stability).
 *
 * Pure math, no DOM — unit-testable and CJS-safe.
 *
 * Model per benchmark b:  measured_b ≈ Σ_feature x[feature] * A[b][feature]
 * where features are opcode names (weighted count) plus the synthetic overhead
 * features update_fixed / shade_fixed / show_fixed / show_per_led. The design
 * DECISION (fewer benchmarks first) means some opcodes share the fallback and
 * aren't fit individually; unfit features fall back to the default table.
 */

export interface BenchSample {
  label: string;
  /** opcode name -> total lane-weighted count executed this benchmark frame. */
  opCounts: Record<string, number>;
  /** how many times update() ran (usually 1). */
  updateRuns: number;
  /** how many shade() calls (= led_count). */
  shadeRuns: number;
  /** led_count for show terms. */
  ledCount: number;
  /** measured frame_cycles (update+shade), mean over the stable window. */
  measuredFrameCycles: number;
  /** measured show_cycles, mean over the stable window. */
  measuredShowCycles: number;
  bytecodeHash: number;
}

/** Synthetic overhead feature names (not opcodes). */
export const FIXED_FEATURES = [
  "@update_fixed",
  "@shade_fixed",
  "@show_fixed",
  "@show_per_led",
] as const;

export interface FitResult {
  /** opcode name -> fitted cycle cost. */
  costs: Record<string, number>;
  fixed: {
    update_fixed: number;
    shade_fixed: number;
    show_fixed: number;
    show_per_led: number;
  };
  /** RMS relative residual over the benchmarks (0..1). */
  residualError: number;
}

/**
 * Build the design matrix. For frame benchmarks the row is opcode counts +
 * update_fixed(=updateRuns) + shade_fixed(=shadeRuns); the target is
 * measuredFrameCycles. For show it's show_fixed(=1) + show_per_led(=ledCount)
 * with target measuredShowCycles. We stack both so one solve yields everything.
 */
function buildSystem(
  samples: BenchSample[],
  features: string[],
): { A: number[][]; y: number[] } {
  const idx: Record<string, number> = {};
  features.forEach((f, i) => (idx[f] = i));
  const A: number[][] = [];
  const y: number[] = [];
  for (const s of samples) {
    // frame row
    const rowF = new Array<number>(features.length).fill(0);
    for (const [op, n] of Object.entries(s.opCounts)) {
      if (op in idx) rowF[idx[op]!] = n;
    }
    if ("@update_fixed" in idx) rowF[idx["@update_fixed"]!] = s.updateRuns;
    if ("@shade_fixed" in idx) rowF[idx["@shade_fixed"]!] = s.shadeRuns;
    A.push(rowF);
    y.push(s.measuredFrameCycles);
    // show row
    const rowS = new Array<number>(features.length).fill(0);
    if ("@show_fixed" in idx) rowS[idx["@show_fixed"]!] = 1;
    if ("@show_per_led" in idx) rowS[idx["@show_per_led"]!] = s.ledCount;
    A.push(rowS);
    y.push(s.measuredShowCycles);
  }
  return { A, y };
}

/**
 * Ridge least squares: solve (AᵀA + λI) x = Aᵀy via Gaussian elimination.
 * λ keeps the system well-posed when a feature is under-determined (the
 * "fewer benchmarks" DECISION leaves some columns near-collinear).
 */
export function fitCosts(
  samples: BenchSample[],
  opcodeFeatures: string[],
  lambda = 1e-3,
): FitResult {
  const features = [...opcodeFeatures, ...FIXED_FEATURES];
  const { A, y } = buildSystem(samples, features);
  const n = features.length;
  // Normal equations
  const ata = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const aty = new Array<number>(n).fill(0);
  for (let r = 0; r < A.length; r++) {
    const row = A[r]!;
    const yr = y[r]!;
    for (let i = 0; i < n; i++) {
      const ri = row[i]!;
      if (ri === 0) continue;
      aty[i]! += ri * yr;
      for (let j = i; j < n; j++) {
        ata[i]![j]! += ri * row[j]!;
      }
    }
  }
  // symmetrize + ridge
  for (let i = 0; i < n; i++) {
    ata[i]![i]! += lambda;
    for (let j = 0; j < i; j++) ata[i]![j] = ata[j]![i]!;
  }
  const x = solveSymmetric(ata, aty);

  const costs: Record<string, number> = {};
  opcodeFeatures.forEach((f, i) => {
    costs[f] = Math.max(0, x[i] ?? 0);
  });
  const base = opcodeFeatures.length;
  const fixed = {
    update_fixed: Math.max(0, x[base] ?? 0),
    shade_fixed: Math.max(0, x[base + 1] ?? 0),
    show_fixed: Math.max(0, x[base + 2] ?? 0),
    show_per_led: Math.max(0, x[base + 3] ?? 0),
  };

  // Residual: predict each target back and take RMS relative error.
  let se = 0;
  let cnt = 0;
  for (let r = 0; r < A.length; r++) {
    let pred = 0;
    const row = A[r]!;
    for (let i = 0; i < n; i++) pred += row[i]! * (x[i] ?? 0);
    const actual = y[r]!;
    if (actual > 0) {
      const rel = (pred - actual) / actual;
      se += rel * rel;
      cnt++;
    }
  }
  const residualError = cnt > 0 ? Math.sqrt(se / cnt) : 0;
  return { costs, fixed, residualError };
}

/** Solve Mx=b for a symmetric matrix via Gaussian elimination w/ partial pivot. */
function solveSymmetric(M: number[][], b: number[]): number[] {
  const n = b.length;
  const a = M.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    // pivot
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(a[r]![col]!) > Math.abs(a[piv]![col]!)) piv = r;
    }
    if (Math.abs(a[piv]![col]!) < 1e-12) continue; // singular column, leave 0
    [a[col], a[piv]] = [a[piv]!, a[col]!];
    const pv = a[col]![col]!;
    for (let j = col; j <= n; j++) a[col]![j]! /= pv;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = a[r]![col]!;
      if (f === 0) continue;
      for (let j = col; j <= n; j++) a[r]![j]! -= f * a[col]![j]!;
    }
  }
  return a.map((row) => row[n]!);
}
