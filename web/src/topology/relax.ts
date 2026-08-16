/**
 * Tubiform point-cloud relaxation (skelgraph-style contraction), the preprocess
 * that lets {@link extractTopology} recover a clean centreline from a TUBE.
 *
 * The graph extractor assumes a THIN cloud: LEDs strung out along a 1-D curve,
 * so a k-NN/MST graph over the points IS the fixture's skeleton. A tubiform
 * cloud breaks that — LEDs are spread over a tube's surface (or volume) whose
 * diameter is ≳ the LED spacing, so the proximity graph is a 2-D mesh wrapping
 * the tube and the spanning tree wanders around the surface instead of running
 * down the axis (false branches, split segments).
 *
 * The fix is to contract the cloud onto its medial axis BEFORE building the
 * graph. Each iteration moves every point toward its neighbourhood centroid,
 * but with two twists that make it safe and endpoint-correct:
 *
 *  - ANISOTROPIC: only the component of the move PERPENDICULAR to the local tube
 *    axis is applied (the axis is the dominant PCA direction of the
 *    neighbourhood). Axial position is therefore preserved, so the tube keeps
 *    its length and — crucially — its ENDPOINTS don't retract inward the way a
 *    naïve mean-shift / Laplacian smoothing collapses them (the reference
 *    implementation's endpoint caveat).
 *  - LINEARITY-WEIGHTED: the move is scaled by how NON-linear the neighbourhood
 *    is (`λ1/λ0`, ~1 for a fat cross-section, ~0 for an already-thin curve). A
 *    strip or a ring is thus left essentially untouched, and the contraction
 *    self-terminates as the tube thins toward its centreline.
 *
 * Pure + unit-tested; no I/O. `extractTopology` runs this on the graph-node
 * positions when `relaxIterations > 0`, then associates the ORIGINAL LEDs to the
 * resulting segments so `dPerp` still reflects the true tube radius.
 */

import type { Vec3 } from "@ledmapper/protocol";

export interface RelaxOptions {
  /** Contraction passes. 0 = disabled (the cloud is returned unchanged). */
  iterations: number;
  /** Neighbourhood radius (absolute, same units as the points). A point pulls
   * toward the centroid of the points within this radius; it should span a good
   * fraction of the tube's cross-section (a few × the LED spacing). */
  radius: number;
  /** Fraction of the perpendicular pull applied per pass (0..1). Smaller is more
   * stable but needs more iterations; ~0.5 collapses a tube in a handful. */
  rate: number;
  /** The cloud's length scale (median LED spacing). It sets the target
   * centreline thickness the contraction stops at (~a tenth of this) and, with
   * it, how a THIN curve is told apart from a fat tube — see {@link relaxOnce}. */
  spacing: number;
}

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Eigen-decomposition of a symmetric 3×3 matrix via cyclic Jacobi rotations.
 * Returns the three (eigenvalue, unit eigenvector) pairs sorted by DESCENDING
 * eigenvalue. `m` is the upper triangle laid out as [xx, yy, zz, xy, xz, yz]. */
function symEig3(m: [number, number, number, number, number, number]): {
  values: [number, number, number];
  vectors: [Vec3, Vec3, Vec3];
} {
  // Work on a full 3×3 array; V accumulates the eigenvectors (columns).
  const a = [
    [m[0], m[3], m[4]],
    [m[3], m[1], m[5]],
    [m[4], m[5], m[2]],
  ];
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let sweep = 0; sweep < 24; sweep++) {
    const off = Math.abs(a[0]![1]!) + Math.abs(a[0]![2]!) + Math.abs(a[1]![2]!);
    if (off < 1e-18) break;
    // Rotate away each off-diagonal (p,q) in turn.
    for (const [p, q] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ] as const) {
      const apq = a[p]![q]!;
      if (Math.abs(apq) < 1e-20) continue;
      const app = a[p]![p]!;
      const aqq = a[q]![q]!;
      const phi = 0.5 * Math.atan2(2 * apq, aqq - app);
      const c = Math.cos(phi);
      const s = Math.sin(phi);
      // Apply the Jacobi rotation A ← Jᵀ A J and V ← V J.
      for (let i = 0; i < 3; i++) {
        const aip = a[i]![p]!;
        const aiq = a[i]![q]!;
        a[i]![p] = c * aip - s * aiq;
        a[i]![q] = s * aip + c * aiq;
      }
      for (let i = 0; i < 3; i++) {
        const api = a[p]![i]!;
        const aqi = a[q]![i]!;
        a[p]![i] = c * api - s * aqi;
        a[q]![i] = s * api + c * aqi;
      }
      for (let i = 0; i < 3; i++) {
        const vip = v[i]![p]!;
        const viq = v[i]![q]!;
        v[i]![p] = c * vip - s * viq;
        v[i]![q] = s * vip + c * viq;
      }
    }
  }
  const pairs: { val: number; vec: Vec3 }[] = [0, 1, 2].map((k) => ({
    val: a[k]![k]!,
    vec: [v[0]![k]!, v[1]![k]!, v[2]![k]!],
  }));
  pairs.sort((x, y) => y.val - x.val);
  return {
    values: [pairs[0]!.val, pairs[1]!.val, pairs[2]!.val],
    vectors: [pairs[0]!.vec, pairs[1]!.vec, pairs[2]!.vec],
  };
}

/** One contraction pass: returns freshly-moved positions (does not mutate).
 *
 * The move is gated on the SMALLEST covariance eigenvalue `λ2` — the
 * neighbourhood's out-of-plane thickness. That is the one signal that separates
 * a fat tube from a merely CURVED thin line: a planar curve (a ring, an arc)
 * has `λ2 ≈ 0` no matter how sharply it bends, so it is left alone, whereas a
 * tube's surface/volume is genuinely 3-D (`λ2 > 0`). The gate ramps from 0 to 1
 * as the out-of-plane RMS thickness `√λ2` rises from ~0.08 to ~0.2 × spacing, so
 * the contraction runs at full strength on a fat tube and self-terminates once
 * the cross-section has collapsed to roughly a tenth of the LED spacing (tight
 * enough that the extractor then merges each ring into one centreline node). */
function relaxOnce(pts: Vec3[], radius: number, rate: number, spacing: number): Vec3[] {
  const n = pts.length;
  const floor = 0.08 * spacing; // stop contracting near this cross-section RMS
  const band = 0.12 * spacing; // ramp width above the floor
  const r2 = radius * radius;
  const out: Vec3[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const p = pts[i]!;
    // Gather the neighbourhood (including self) and its centroid.
    let cx = 0;
    let cy = 0;
    let cz = 0;
    let cnt = 0;
    const nbr: number[] = [];
    for (let j = 0; j < n; j++) {
      const q = pts[j]!;
      const dx = q[0] - p[0];
      const dy = q[1] - p[1];
      const dz = q[2] - p[2];
      if (dx * dx + dy * dy + dz * dz <= r2) {
        cx += q[0];
        cy += q[1];
        cz += q[2];
        cnt++;
        nbr.push(j);
      }
    }
    if (cnt < 3) {
      out[i] = [p[0], p[1], p[2]];
      continue;
    }
    const c: Vec3 = [cx / cnt, cy / cnt, cz / cnt];
    // Covariance (upper triangle) of the neighbourhood about its centroid.
    let xx = 0;
    let yy = 0;
    let zz = 0;
    let xy = 0;
    let xz = 0;
    let yz = 0;
    for (const j of nbr) {
      const q = pts[j]!;
      const dx = q[0] - c[0];
      const dy = q[1] - c[1];
      const dz = q[2] - c[2];
      xx += dx * dx;
      yy += dy * dy;
      zz += dz * dz;
      xy += dx * dy;
      xz += dx * dz;
      yz += dy * dz;
    }
    const { values, vectors } = symEig3([xx, yy, zz, xy, xz, yz]);
    // Divide by count so the eigenvalues are variances (length²), comparable to
    // the spacing-based floor regardless of neighbourhood size.
    const l2 = Math.max(0, values[2] / cnt); // smallest eigenvalue = out-of-plane var
    const rmsOut = Math.sqrt(l2);
    // Gate: 0 for a thin/planar neighbourhood (leave strips + rings alone), 1 for
    // a fat tube; ramps down again as the cross-section thins to the floor.
    const weight = Math.min(1, Math.max(0, (rmsOut - floor) / band));
    if (weight <= 0) {
      out[i] = [p[0], p[1], p[2]];
      continue;
    }
    const axis = vectors[0]; // dominant PCA direction = local tube axis
    // Pull toward the centroid, but drop the component along the axis so the
    // point slides only ACROSS the tube (length + endpoints preserved).
    const d: Vec3 = [c[0] - p[0], c[1] - p[1], c[2] - p[2]];
    const along = dot(d, axis);
    const perp: Vec3 = [d[0] - along * axis[0], d[1] - along * axis[1], d[2] - along * axis[2]];
    const g = rate * weight;
    out[i] = [p[0] + g * perp[0], p[1] + g * perp[1], p[2] + g * perp[2]];
  }
  return out;
}

/** Contract a (possibly tubiform) point cloud onto its centreline. Returns a new
 * array of positions; the input is not mutated. A thin cloud (strip, ring) is
 * left essentially unchanged. See the module header for the algorithm. */
export function relaxTubiform(points: Vec3[], opts: RelaxOptions): Vec3[] {
  const iterations = Math.max(0, Math.floor(opts.iterations));
  if (iterations === 0 || points.length < 3 || opts.radius <= 0 || opts.rate <= 0) {
    return points.map((p) => [p[0], p[1], p[2]] as Vec3);
  }
  const spacing = opts.spacing > 0 ? opts.spacing : opts.radius / 3 || 1;
  let cur = points.map((p) => [p[0], p[1], p[2]] as Vec3);
  for (let it = 0; it < iterations; it++) {
    cur = relaxOnce(cur, opts.radius, opts.rate, spacing);
  }
  return cur;
}
