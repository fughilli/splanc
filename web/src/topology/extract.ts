/**
 * Graph-topology extractor (design doc §7.7, Phase F): turns a solved
 * `OutputMap` (an UNORDERED 3D LED point cloud) into a `Topology` — a graph of
 * polyline segments + branch points, plus a per-LED association
 * `(segmentId, footArclength, dPerp)` — so the controller's pulse engine
 * (Phase G) drives effects along the fixture's PHYSICAL shape.
 *
 * This assumes NOTHING about how the LEDs are wired: the strip may be draped
 * over a shape, cut-and-jumpered, branched — the connectivity is recovered
 * purely from geometry (the "skelgraph" flow), not LED index order:
 *
 *  1. neighbours: a k-NN proximity graph, edges capped at a multiple of the
 *     median LED spacing (so separate strips stay separate).
 *  2. reduce: a minimum spanning FOREST of that graph — one tree per spatial
 *     component, recovering each strip's chain and any junctions.
 *  3. topology: nodes of degree ≠ 2 are endpoints (1) / branch points (≥3);
 *     the degree-2 chains between them are the segments. Short leaf spurs
 *     (k-NN noise) are pruned.
 *  4. cleanup + associate: decimate each segment polyline, and project EVERY
 *     LED onto the nearest segment for its (segment, arclength, perp).
 *
 * Pure + unit-tested; no I/O.
 */

import type {
  BranchPoint,
  LedAssociation,
  OutputMap,
  Topology,
  TopologySegment,
  Vec3,
} from "@ledmapper/protocol";

export interface ExtractOptions {
  /** Neighbours considered when building the proximity graph. */
  k?: number;
  /** Cap graph edges at this × the median nearest-neighbour spacing — the key
   * connectivity knob (too small fragments a strip, too large fuses strips). */
  radiusFactor?: number;
  /** Prune leaf spur segments shorter than this × the median spacing (k-NN
   * noise); their LEDs re-associate to the nearest surviving segment. */
  pruneFactor?: number;
  /** Max polyline vertices per segment (firmware footprint; decimated). */
  maxPolyline?: number;
  /** Douglas–Peucker tolerance as a fraction of the median spacing. */
  simplifyFrac?: number;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const dist = (a: Vec3, b: Vec3): number => norm(sub(a, b));

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  return [...xs].sort((a, b) => a - b)[xs.length >> 1]!;
}

/** Perpendicular distance from `p` to the infinite line through a→b (a≠b). */
function perpDist(p: Vec3, a: Vec3, b: Vec3): number {
  const ab = sub(b, a);
  const ap = sub(p, a);
  const t = (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / (ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2);
  return dist(p, [a[0] + t * ab[0], a[1] + t * ab[1], a[2] + t * ab[2]]);
}

/** Douglas–Peucker: KEPT vertex indices (endpoints always), simplified within
 * `tol`, then thinned to at most `maxVerts` by relaxing the tolerance. */
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

/** Union–find for the minimum spanning forest. */
class UnionFind {
  private parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(x: number): number {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]!]!;
      x = this.parent[x]!;
    }
    return x;
  }
  /** Union; returns true if they were in different sets (edge kept in the MST). */
  union(a: number, b: number): boolean {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return false;
    this.parent[ra] = rb;
    return true;
  }
}

/** Extract a graph topology from the solved point cloud (order-independent). */
export function extractTopology(map: OutputMap, opts: ExtractOptions = {}): Topology {
  const k = Math.max(1, opts.k ?? 8);
  const radiusFactor = opts.radiusFactor ?? 2.5;
  const pruneFactor = opts.pruneFactor ?? 3;
  const maxPolyline = Math.max(2, opts.maxPolyline ?? 64);
  const simplifyFrac = opts.simplifyFrac ?? 0.5;

  const leds = map.leds;
  const n = leds.length;
  const empty: Topology = { mapId: map.mapId, branchPoints: [], segments: [], associations: [] };
  if (n < 2) return empty;
  const P = leds.map((l) => l.xyz);

  // 1. median nearest-neighbour spacing → edge-length cap.
  const nnd: number[] = [];
  for (let i = 0; i < n; i++) {
    let best = Infinity;
    for (let j = 0; j < n; j++) if (j !== i) best = Math.min(best, dist(P[i]!, P[j]!));
    nnd.push(best);
  }
  const s = median(nnd) || 1e-6;
  const maxEdge = s * radiusFactor;

  // 2. k-NN proximity edges within the cap (deduped, min→max).
  const edgeMap = new Map<string, { i: number; j: number; d: number }>();
  for (let i = 0; i < n; i++) {
    const ds: { j: number; d: number }[] = [];
    for (let j = 0; j < n; j++) if (j !== i) ds.push({ j, d: dist(P[i]!, P[j]!) });
    ds.sort((a, b) => a.d - b.d);
    for (let t = 0; t < Math.min(k, ds.length); t++) {
      const { j, d } = ds[t]!;
      if (d > maxEdge) break;
      const lo = Math.min(i, j);
      const hi = Math.max(i, j);
      edgeMap.set(`${lo}-${hi}`, { i: lo, j: hi, d });
    }
  }

  // 3. minimum spanning FOREST (Kruskal) — one tree per spatial component.
  const edges = [...edgeMap.values()].sort((a, b) => a.d - b.d);
  const uf = new UnionFind(n);
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (const e of edges) {
    if (uf.union(e.i, e.j)) {
      adj[e.i]!.push(e.j);
      adj[e.j]!.push(e.i);
    }
  }
  const deg = adj.map((a) => a.length);

  // 4. branch points = degree ≥ 3 nodes.
  const branchId = new Map<number, number>();
  const branchPoints: BranchPoint[] = [];
  for (let i = 0; i < n; i++) {
    if (deg[i]! >= 3) {
      branchId.set(i, branchPoints.length);
      branchPoints.push({ id: branchPoints.length, xyz: P[i]! });
    }
  }

  // 5. trace segments: maximal degree-2 chains between anchors (deg ≠ 2).
  const isAnchor = (i: number): boolean => deg[i]! !== 2;
  const seen = new Set<string>();
  const chains: number[][] = [];
  for (let a = 0; a < n; a++) {
    if (deg[a]! === 0 || !isAnchor(a)) continue;
    for (const start of adj[a]!) {
      if (seen.has(`${a}-${start}`)) continue;
      const chain = [a];
      let prev = a;
      let cur = start;
      seen.add(`${a}-${start}`);
      for (;;) {
        chain.push(cur);
        if (isAnchor(cur)) {
          seen.add(`${cur}-${prev}`);
          break;
        }
        const next = adj[cur]!.find((x) => x !== prev)!;
        seen.add(`${cur}-${next}`);
        prev = cur;
        cur = next;
      }
      chains.push(chain);
    }
  }

  // 6. prune short leaf spurs (an endpoint end + total length below the cap).
  const chainLen = (c: number[]): number => {
    let l = 0;
    for (let i = 1; i < c.length; i++) l += dist(P[c[i]!]!, P[c[i - 1]!]!);
    return l;
  };
  let kept = chains.filter((c) => {
    const leaf = deg[c[0]!]! === 1 || deg[c[c.length - 1]!]! === 1;
    return !(leaf && chainLen(c) < pruneFactor * s);
  });
  if (kept.length === 0) kept = chains; // don't prune the whole fixture away

  // 7. build segments (decimated polylines; a/b from the endpoint branch ids).
  const segments: TopologySegment[] = [];
  const segCum: number[][] = [];
  kept.forEach((c, idx) => {
    const path = c.map((i) => P[i]!);
    const poly = simplify(path, s * simplifyFrac, maxPolyline).map((i) => path[i]!);
    const cum = [0];
    for (let i = 1; i < poly.length; i++) cum.push(cum[i - 1]! + dist(poly[i]!, poly[i - 1]!));
    segments.push({
      id: idx,
      a: branchId.get(c[0]!) ?? -1,
      b: branchId.get(c[c.length - 1]!) ?? -1,
      polyline: poly,
      length: cum[cum.length - 1]!,
    });
    segCum.push(cum);
  });

  // 8. associate EVERY LED to the nearest segment (no orphans — isolated LEDs
  //    and pruned-spur LEDs snap to the closest surviving segment).
  const associations: LedAssociation[] = [];
  for (let i = 0; i < n; i++) {
    let best = { seg: -1, s: 0, d: Infinity };
    for (let sg = 0; sg < segments.length; sg++) {
      const { s: arclen, d } = projectToPolyline(P[i]!, segments[sg]!.polyline, segCum[sg]!);
      if (d < best.d) best = { seg: sg, s: arclen, d };
    }
    if (best.seg >= 0) {
      associations.push({ ledId: leds[i]!.id, segmentId: best.seg, footArclength: best.s, dPerp: best.d });
    }
  }

  return { mapId: map.mapId, branchPoints, segments, associations };
}
