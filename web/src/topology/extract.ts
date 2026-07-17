/**
 * Graph-topology extractor (design doc §7.7, Phase F): turns a solved
 * `OutputMap` (per-LED 3D positions) into a `Topology` — a graph of polyline
 * segments plus a per-LED association `(segmentId, footArclength, dPerp)` — so
 * the controller's pulse engine (Phase G) can drive effects along the fixture's
 * PHYSICAL shape (arclength), not LED index.
 *
 * v1 uses the WIRE PATH: the LEDs are wired in id order, so the strip's shape
 * is the polyline through them in that order. It splits into separate segments
 * where consecutive LEDs jump far apart (a break between strips / a re-routed
 * run), decimates each run's path to a bounded polyline (Douglas–Peucker), and
 * projects every LED onto that polyline for its association. Junction detection
 * (real branch points where segments meet) is v2 — segments are free-ended
 * here, which is exactly right for a single strip or a set of disjoint strips.
 *
 * Pure + unit-tested; no I/O.
 */

import type { LedAssociation, OutputMap, Topology, TopologySegment, Vec3 } from "@ledmapper/protocol";

export interface ExtractOptions {
  /** Start a new segment when the gap between consecutive (by id) LEDs exceeds
   * this × the median LED spacing — a break between strips or a re-route. */
  gapSplitFactor?: number;
  /** Max polyline vertices per segment (firmware footprint; the wire path is
   * decimated to fit). */
  maxPolyline?: number;
  /** Douglas–Peucker tolerance as a fraction of the median LED spacing: how far
   * the decimated polyline may stray from the wire path. */
  simplifyFrac?: number;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const dist = (a: Vec3, b: Vec3): number => norm(sub(a, b));

/** Perpendicular distance from `p` to the infinite line through a→b (a≠b). */
function perpDist(p: Vec3, a: Vec3, b: Vec3): number {
  const ab = sub(b, a);
  const ap = sub(p, a);
  const t = (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / (ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2);
  const foot: Vec3 = [a[0] + t * ab[0], a[1] + t * ab[1], a[2] + t * ab[2]];
  return dist(p, foot);
}

/** Douglas–Peucker on a 3D polyline: returns the KEPT vertex indices (endpoints
 * always kept), simplified to within `tol`, then thinned to at most `maxVerts`
 * by relaxing the tolerance if needed. */
function simplify(points: Vec3[], tol: number, maxVerts: number): number[] {
  const n = points.length;
  if (n <= 2) return points.map((_, i) => i);
  const run = (t: number): number[] => {
    const keep = new Uint8Array(n);
    keep[0] = 1;
    keep[n - 1] = 1;
    const stack: [number, number][] = [[0, n - 1]];
    while (stack.length) {
      const [lo, hi] = stack.pop()!;
      let far = -1;
      let farD = t;
      for (let i = lo + 1; i < hi; i++) {
        const d = perpDist(points[i]!, points[lo]!, points[hi]!);
        if (d > farD) {
          farD = d;
          far = i;
        }
      }
      if (far !== -1) {
        keep[far] = 1;
        stack.push([lo, far], [far, hi]);
      }
    }
    const idx: number[] = [];
    for (let i = 0; i < n; i++) if (keep[i]) idx.push(i);
    return idx;
  };
  let t = tol;
  let idx = run(t);
  // Relax the tolerance until it fits the vertex cap (geometric backoff).
  while (idx.length > maxVerts) {
    t *= 1.6;
    idx = run(t);
  }
  return idx;
}

/** Project `q` onto polyline `poly` (cumulative arclengths `cum`): the foot's
 * arclength from the start, and its perpendicular distance. */
function projectToPolyline(q: Vec3, poly: Vec3[], cum: number[]): { s: number; d: number } {
  let best = { s: 0, d: Infinity };
  for (let i = 0; i + 1 < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[i + 1]!;
    const ab = sub(b, a);
    const len2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
    const ap = sub(q, a);
    const t = len2 > 0 ? Math.min(1, Math.max(0, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / len2)) : 0;
    const foot: Vec3 = [a[0] + t * ab[0], a[1] + t * ab[1], a[2] + t * ab[2]];
    const d = dist(q, foot);
    if (d < best.d) best = { s: cum[i]! + t * Math.sqrt(len2), d };
  }
  return best;
}

/** Extract a graph topology from a solved map. Returns a Topology keyed to the
 * map (empty segments/associations when there are fewer than 2 mapped LEDs). */
export function extractTopology(map: OutputMap, opts: ExtractOptions = {}): Topology {
  const gapSplitFactor = opts.gapSplitFactor ?? 4;
  const maxPolyline = Math.max(2, opts.maxPolyline ?? 64);
  const simplifyFrac = opts.simplifyFrac ?? 0.5;

  const leds = [...map.leds].sort((a, b) => a.id - b.id);
  const empty: Topology = { mapId: map.mapId, branchPoints: [], segments: [], associations: [] };
  if (leds.length < 2) return empty;

  // Median consecutive spacing sets the gap-split threshold and the DP tolerance.
  const gaps = leds.slice(1).map((l, i) => dist(l.xyz, leds[i]!.xyz));
  const median = [...gaps].sort((a, b) => a - b)[gaps.length >> 1]!;
  const splitAt = median * gapSplitFactor;

  // Runs of consecutive LEDs, broken at large gaps.
  const runs: (typeof leds)[] = [];
  let run: typeof leds = [leds[0]!];
  for (let i = 1; i < leds.length; i++) {
    if (gaps[i - 1]! > splitAt) {
      runs.push(run);
      run = [];
    }
    run.push(leds[i]!);
  }
  runs.push(run);

  const segments: TopologySegment[] = [];
  const associations: LedAssociation[] = [];
  let segId = 0;
  for (const r of runs) {
    if (r.length < 2) continue; // a lone LED can't define a segment
    const path = r.map((l) => l.xyz);
    const keep = simplify(path, median * simplifyFrac, maxPolyline);
    const poly = keep.map((i) => path[i]!);
    const cum = [0];
    for (let i = 1; i < poly.length; i++) cum.push(cum[i - 1]! + dist(poly[i]!, poly[i - 1]!));
    const length = cum[cum.length - 1]!;
    segments.push({ id: segId, a: -1, b: -1, polyline: poly, length });
    for (const l of r) {
      const { s, d } = projectToPolyline(l.xyz, poly, cum);
      associations.push({ ledId: l.id, segmentId: segId, footArclength: s, dPerp: d });
    }
    segId++;
  }
  return { mapId: map.mapId, branchPoints: [], segments, associations };
}
