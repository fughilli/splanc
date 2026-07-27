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
  /** Re-add spanning-tree edges the MST dropped when they close a real LOOP:
   * a dropped edge ≤ this × the median spacing whose endpoints are still far
   * apart in the graph becomes a chord, so a ring in the fixture stays a ring
   * (the flood effect can then swirl around it). 0 disables (pure forest). */
  loopFactor?: number;
  /** Merge two branch points joined by a segment shorter than this × the median
   * spacing into a single junction — collapses a knot of near-coincident branch
   * points the extractor over-splits one physical junction into (e.g. at a
   * self-crossing, where coincident LEDs spawn a cluster of degree-3 nodes). A
   * longer parallel arc between the same pair survives as a (real) loop. 0
   * disables. */
  mergeFactor?: number;
  /** Max polyline vertices per segment (firmware footprint; decimated). */
  maxPolyline?: number;
  /** Douglas–Peucker tolerance as a fraction of the median spacing. */
  simplifyFrac?: number;
  /** Emit a {@link TopologyDebug} report (coincident LEDs + graph edges) for the
   * diagnostic overlay. Off by default (extra O(n·k) bookkeeping). */
  debug?: boolean;
  /** Flag LED pairs closer than this × the median spacing as (near-)coincident
   * — likely solve degeneracies that create a zero-length graph shortcut. */
  coincidentFactor?: number;
}

/** Diagnostic view of the raw graph the topology was extracted from, to reveal
 * degeneracies (a solve that collapsed distant LEDs onto one point makes a
 * zero-length shortcut → a false geodesic "bridge"; a stray loop-chord fuses two
 * strands). Positions are the solved LED coordinates so the overlay can draw
 * directly. Present only when `ExtractOptions.debug` is set. */
export interface TopologyDebug {
  /** (Near-)coincident LED pairs (≤ coincidentFactor × spacing apart) — the most
   * likely cause of an unexpected bridge; each collapses distant graph regions. */
  coincident: { a: Vec3; b: Vec3; dist: number }[];
  /** The kept graph edges (MST + loop-chords); `chord` marks a re-added
   * loop-closing edge (a candidate false bridge). */
  edges: { a: Vec3; b: Vec3; d: number; chord: boolean }[];
  /** Median nearest-neighbour spacing (the length scale for every factor). */
  spacing: number;
  /** Per-stage snapshots of the pipeline (k-NN → MST → chords → prune → segments
   * → merge → dissolve), for the "stage" scrubber that inspects each step's
   * output. In pipeline order; the last is the final topology. */
  stages: TopologyStage[];
}

/** A single pipeline stage's drawable state, for the stage scrubber. Early stages
 * carry graph `nodes` + `edges`; later stages carry `segments` + `branchPoints`.
 * Any field may be empty for a stage that doesn't produce it. */
export interface TopologyStage {
  name: string;
  nodes: Vec3[];
  edges: { a: Vec3; b: Vec3 }[];
  segments: { polyline: Vec3[] }[];
  branchPoints: Vec3[];
}

/** Cooperative-scheduling hooks: the extractor yields to the event loop during
 * its O(n²) phases, so the UI stays responsive on large maps and a long solve
 * can be cancelled (`signal`) and shown a progress bar (`onProgress`, 0..1). */
export interface ExtractHooks {
  signal?: AbortSignal;
  onProgress?: (frac: number) => void;
}

const yieldToEventLoop = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

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
  let idx = run(tol);
  if (idx.length > maxVerts) {
    // Relax the tolerance until the vertex budget fits. Seed a positive value
    // (a fraction of the polyline extent) when tol is 0 — otherwise `t *= 1.6`
    // stays 0 and this never terminates — and cap iterations as a backstop.
    let t = tol > 0 ? tol : polylineExtent(points) * 1e-3 || 1e-6;
    for (let guard = 0; idx.length > maxVerts && guard < 64; guard++) {
      t *= 1.6;
      idx = run(t);
    }
  }
  return idx;
}

/** Largest coordinate span of a polyline's bounding box (used to seed a
 * positive simplify tolerance when the caller asks for 0). */
function polylineExtent(points: Vec3[]): number {
  let lo = [Infinity, Infinity, Infinity];
  let hi = [-Infinity, -Infinity, -Infinity];
  for (const p of points) {
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k]!, p[k]!);
      hi[k] = Math.max(hi[k]!, p[k]!);
    }
  }
  return Math.max(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!);
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

/** A loop chord must close a cycle of at least this many edges (smaller ones
 * are k-NN noise / redundant near-parallel edges, not real fixture loops). */
const MIN_LOOP_HOPS = 4;
/** Safety cap on re-added loop chords (real fixtures have very few loops). */
const MAX_LOOPS = 64;

/** BFS: is `dst` reachable from `src` in `adj` within `maxHops` edges? Used to
 * reject loop chords whose endpoints are already close in the graph. */
function reachableWithin(adj: number[][], src: number, dst: number, maxHops: number): boolean {
  if (src === dst) return true;
  const seen = new Set<number>([src]);
  let frontier = [src];
  for (let hop = 0; hop < maxHops && frontier.length; hop++) {
    const next: number[] = [];
    for (const u of frontier) {
      for (const v of adj[u]!) {
        if (v === dst) return true;
        if (!seen.has(v)) {
          seen.add(v);
          next.push(v);
        }
      }
    }
    frontier = next;
  }
  return false;
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

/** Extract a graph topology from the solved point cloud (order-independent).
 * Async + cooperatively scheduled: the two O(n²) phases yield to the event loop
 * (keeping the UI live on big maps) and honour `hooks.signal` / `hooks.onProgress`.
 * Rejects with an AbortError if the signal fires. */
export async function extractTopology(
  map: OutputMap,
  opts: ExtractOptions = {},
  hooks: ExtractHooks = {},
): Promise<Topology & { debug?: TopologyDebug }> {
  const k = Math.max(1, opts.k ?? 8);
  const radiusFactor = opts.radiusFactor ?? 2.5;
  const pruneFactor = opts.pruneFactor ?? 3;
  const loopFactor = opts.loopFactor ?? 2;
  const mergeFactor = opts.mergeFactor ?? 1.5;
  const maxPolyline = Math.max(2, opts.maxPolyline ?? 64);
  const simplifyFrac = opts.simplifyFrac ?? 0.5;
  const { signal, onProgress } = hooks;
  // Yield every N rows of the O(n²) phases so input/paint get a turn and abort
  // is responsive; below that many LEDs the whole solve stays within one task.
  const YIELD_ROWS = 64;
  const breathe = async (i: number, frac: number): Promise<void> => {
    if (i > 0 && i % YIELD_ROWS === 0) {
      if (signal?.aborted) throw new DOMException("topology extraction aborted", "AbortError");
      onProgress?.(frac);
      await yieldToEventLoop();
    }
  };

  const leds = map.leds;
  const n = leds.length;
  const empty: Topology = { mapId: map.mapId, branchPoints: [], segments: [], associations: [] };
  if (n < 2) return empty;
  const P = leds.map((l) => l.xyz);

  // 1. median nearest-neighbour spacing → edge-length cap.
  const nnd: number[] = [];
  for (let i = 0; i < n; i++) {
    await breathe(i, (i / n) * 0.5);
    let best = Infinity;
    for (let j = 0; j < n; j++) if (j !== i) best = Math.min(best, dist(P[i]!, P[j]!));
    nnd.push(best);
  }
  const s = median(nnd) || 1e-6;
  const maxEdge = s * radiusFactor;

  // Diagnostic collection (only when opts.debug): (near-)coincident pairs and,
  // below, the kept graph edges with a loop-chord flag.
  const wantDebug = opts.debug ?? false;
  const coincEps = (opts.coincidentFactor ?? 0.2) * s;
  const coincSeen = new Set<string>();
  const coincident: TopologyDebug["coincident"] = [];
  const dbgEdges: TopologyDebug["edges"] = [];

  // Per-stage snapshots for the "stage" scrubber (only when debug is on).
  const stages: TopologyStage[] = [];
  const snapNodes = (): Vec3[] => (wantDebug ? NP.map((p) => [p[0], p[1], p[2]]) : []);
  const adjToEdges = (a: number[][]): { a: Vec3; b: Vec3 }[] => {
    const out: { a: Vec3; b: Vec3 }[] = [];
    for (let i = 0; i < a.length; i++) for (const j of a[i]!) if (i < j) out.push({ a: NP[i]!, b: NP[j]! });
    return out;
  };
  const snapSegs = (segs: TopologySegment[]): { polyline: Vec3[] }[] =>
    segs.map((sg) => ({ polyline: sg.polyline.map((p) => [p[0], p[1], p[2]] as Vec3) }));
  const pushStage = (
    name: string,
    parts: Partial<Omit<TopologyStage, "name">>,
  ): void => {
    if (!wantDebug) return;
    stages.push({
      name,
      nodes: parts.nodes ?? [],
      edges: parts.edges ?? [],
      segments: parts.segments ?? [],
      branchPoints: parts.branchPoints ?? [],
    });
  };

  // 1b. collapse (near-)coincident LEDs into single graph NODES. Two LEDs solved
  //     onto (nearly) the same point are one vertex of the fixture — decisively so
  //     at a SELF-CROSSING, where the strand passes through a point twice: keeping
  //     the pair separate leaves two degree-3 stubs joined by a zero-length edge
  //     the MST cross-wires, whereas merging them makes ONE node the two strands
  //     pass through — a clean degree-4 junction. All graph phases below run on
  //     these nodes; every original LED still associates to a segment (§8).
  const cuf = new UnionFind(n);
  for (let i = 0; i < n; i++) {
    await breathe(i, 0.5);
    for (let j = i + 1; j < n; j++) {
      const d = dist(P[i]!, P[j]!);
      if (d <= coincEps) {
        cuf.union(i, j);
        if (wantDebug) {
          const key = `${i}-${j}`;
          if (!coincSeen.has(key)) {
            coincSeen.add(key);
            coincident.push({ a: P[i]!, b: P[j]!, dist: d });
          }
        }
      }
    }
  }
  const nodeOfRoot = new Map<number, number>();
  const NP: Vec3[] = []; // graph-node positions (cluster centroids)
  const nodeSum: Vec3[] = [];
  const nodeCnt: number[] = [];
  for (let i = 0; i < n; i++) {
    const r = cuf.find(i);
    let node = nodeOfRoot.get(r);
    if (node === undefined) {
      node = NP.length;
      nodeOfRoot.set(r, node);
      NP.push([0, 0, 0]);
      nodeSum.push([0, 0, 0]);
      nodeCnt.push(0);
    }
    nodeSum[node]![0] += P[i]![0];
    nodeSum[node]![1] += P[i]![1];
    nodeSum[node]![2] += P[i]![2];
    nodeCnt[node]!++;
  }
  const nNodes = NP.length;
  for (let node = 0; node < nNodes; node++) {
    const c = nodeCnt[node]!;
    NP[node] = [nodeSum[node]![0] / c, nodeSum[node]![1] / c, nodeSum[node]![2] / c];
  }

  // 2. k-NN proximity edges within the cap (deduped, min→max) over the NODES.
  const edgeMap = new Map<string, { i: number; j: number; d: number }>();
  for (let i = 0; i < nNodes; i++) {
    await breathe(i, 0.5 + (i / nNodes) * 0.5);
    const ds: { j: number; d: number }[] = [];
    for (let j = 0; j < nNodes; j++) if (j !== i) ds.push({ j, d: dist(NP[i]!, NP[j]!) });
    ds.sort((a, b) => a.d - b.d);
    for (let t = 0; t < Math.min(k, ds.length); t++) {
      const { j, d } = ds[t]!;
      if (d > maxEdge) break;
      const lo = Math.min(i, j);
      const hi = Math.max(i, j);
      edgeMap.set(`${lo}-${hi}`, { i: lo, j: hi, d });
    }
  }
  onProgress?.(1);
  pushStage("k-NN graph", {
    nodes: snapNodes(),
    edges: wantDebug ? [...edgeMap.values()].map((e) => ({ a: NP[e.i]!, b: NP[e.j]! })) : [],
  });

  // 3. minimum spanning FOREST (Kruskal) — one tree per spatial component.
  const edges = [...edgeMap.values()].sort((a, b) => a.d - b.d);
  const uf = new UnionFind(nNodes);
  const adj: number[][] = Array.from({ length: nNodes }, () => []);
  const dropped: { i: number; j: number; d: number }[] = [];
  for (const e of edges) {
    if (uf.union(e.i, e.j)) {
      adj[e.i]!.push(e.j);
      adj[e.j]!.push(e.i);
      if (wantDebug) dbgEdges.push({ a: NP[e.i]!, b: NP[e.j]!, d: e.d, chord: false });
    } else {
      dropped.push(e); // stays length-ascending (edges is sorted)
    }
  }
  pushStage("MST forest", { nodes: snapNodes(), edges: adjToEdges(adj) });

  // 3b. re-add loop-closing chords: a short dropped edge closes a genuine cycle
  //     (a ring in the fixture) ONLY when it joins two STRAND ENDS (the seam the
  //     MST broke). When the MST spans a cycle it removes one edge, leaving its
  //     two endpoints at degree 1 — those are the ends to rejoin. Requiring both
  //     endpoints to be degree-1 rejects the false "mid-loop" bridges that arise
  //     where a strand folds and two INTERIOR (degree-2) points pass near each
  //     other — the spurious geodesic shortcuts that made flood pulses jump. The
  //     `> MIN_LOOP_HOPS` guard keeps a real ring (ends far along the strand)
  //     from being "closed" over a tiny fold. Endpoints become anchors so the
  //     loop traces as segments.
  const forced = new Set<number>();
  if (loopFactor > 0) {
    const maxLoopEdge = s * loopFactor;
    for (const e of dropped) {
      if (forced.size / 2 >= MAX_LOOPS) break;
      if (e.d > maxLoopEdge) break; // ascending → the rest are longer too
      // Only join two current strand ends (degree 1) — not mid-strand interiors.
      if (adj[e.i]!.length !== 1 || adj[e.j]!.length !== 1) continue;
      if (!reachableWithin(adj, e.i, e.j, MIN_LOOP_HOPS - 1)) {
        adj[e.i]!.push(e.j);
        adj[e.j]!.push(e.i);
        forced.add(e.i);
        forced.add(e.j);
        if (wantDebug) dbgEdges.push({ a: NP[e.i]!, b: NP[e.j]!, d: e.d, chord: true });
      }
    }
  }

  pushStage("loop chords", { nodes: snapNodes(), edges: adjToEdges(adj) });
  const deg = adj.map((a) => a.length);

  // 4. first trace: maximal degree-2 chains between anchors (deg ≠ 2, or a
  //    loop-chord endpoint). This trace only feeds the spur prune (step 5); the
  //    SURVIVING graph is re-derived + re-traced in step 6 so a junction left
  //    behind by a pruned spur collapses instead of splitting a strand.
  const isAnchor = (i: number): boolean => deg[i]! !== 2 || forced.has(i);
  const seen = new Set<string>();
  const chains: number[][] = [];
  for (let a = 0; a < nNodes; a++) {
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
    for (let i = 1; i < c.length; i++) l += dist(NP[c[i]!]!, NP[c[i - 1]!]!);
    return l;
  };
  let kept = chains.filter((c) => {
    const leaf = deg[c[0]!]! === 1 || deg[c[c.length - 1]!]! === 1;
    return !(leaf && chainLen(c) < pruneFactor * s);
  });
  if (kept.length === 0) kept = chains; // don't prune the whole fixture away

  // 6. RE-DERIVE the graph from the kept chains and re-trace. Pruning a spur
  //    leaves the junction it hung off as an effective degree-2 pass-through;
  //    re-tracing over the pruned graph collapses those into the through-segment
  //    (no spurious mid-strand junctions) and drops branch points the prune
  //    orphaned. Branch points are then the surviving deg≥3 nodes plus loop-chord
  //    endpoints that still carry ≥2 edges (they anchor a ring's segments).
  const adj2: number[][] = Array.from({ length: nNodes }, () => []);
  const linked = new Set<string>();
  for (const c of kept) {
    for (let i = 1; i < c.length; i++) {
      const u = c[i - 1]!;
      const v = c[i]!;
      const key = u < v ? `${u}-${v}` : `${v}-${u}`;
      if (linked.has(key)) continue;
      linked.add(key);
      adj2[u]!.push(v);
      adj2[v]!.push(u);
    }
  }
  const deg2 = adj2.map((a) => a.length);
  pushStage("prune + retrace", { nodes: snapNodes(), edges: adjToEdges(adj2) });
  const isAnchor2 = (i: number): boolean => deg2[i]! !== 0 && (deg2[i]! !== 2 || forced.has(i));

  const branchId = new Map<number, number>();
  const branchPoints: BranchPoint[] = [];
  for (let i = 0; i < nNodes; i++) {
    if (deg2[i]! >= 3 || (forced.has(i) && deg2[i]! >= 2)) {
      branchId.set(i, branchPoints.length);
      branchPoints.push({ id: branchPoints.length, xyz: NP[i]! });
    }
  }

  const seen2 = new Set<string>();
  const traced: number[][] = [];
  for (let a = 0; a < nNodes; a++) {
    if (!isAnchor2(a)) continue;
    for (const start of adj2[a]!) {
      if (seen2.has(`${a}-${start}`)) continue;
      const chain = [a];
      let prev = a;
      let cur = start;
      seen2.add(`${a}-${start}`);
      for (;;) {
        chain.push(cur);
        if (isAnchor2(cur)) {
          seen2.add(`${cur}-${prev}`);
          break;
        }
        const next = adj2[cur]!.find((x) => x !== prev);
        if (next === undefined) break; // dangling end (shouldn't happen)
        seen2.add(`${cur}-${next}`);
        prev = cur;
        cur = next;
      }
      traced.push(chain);
    }
  }
  // A pure ring with no anchor at all (loop-closing disabled) leaves no deg≠2
  // node — fall back to the kept chains so it still traces as a segment.
  const outChains = traced.length > 0 ? traced : kept;

  // 7. build segments (decimated polylines; a/b from the endpoint branch ids).
  const segments: TopologySegment[] = [];
  const segCum: number[][] = [];
  outChains.forEach((c, idx) => {
    const path = c.map((i) => NP[i]!);
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
  pushStage("segments (raw)", { segments: snapSegs(segments), branchPoints: branchPoints.map((b) => b.xyz) });

  // 7b. merge junction clusters. Where one physical junction is over-split into
  //     several branch points a hair apart (e.g. at a self-crossing, where
  //     coincident LEDs spawn a knot of degree-3 nodes), walk each
  //     junction-to-junction segment: if it is shorter than the merge radius,
  //     contract it — the two branch points fuse into one node at their centroid,
  //     the short connector is dropped, and LEDs re-associate below. A LONGER
  //     parallel arc between the same pair (a double edge) survives the remap as
  //     a self-loop, so real loops are preserved. `mergeFactor` 0 disables.
  let bpsOut = branchPoints;
  let segsOut = segments;
  if (mergeFactor > 0 && branchPoints.length > 1) {
    const mergeRadius = s * mergeFactor;
    // Count segments between each branch-point pair: a pair joined by MORE than
    // one segment is a real loop (a short chord + a long arc), not an over-split
    // junction — contracting its short chord would destroy the cycle, so skip it.
    const pairKey = (a: number, b: number): string => (a < b ? `${a}-${b}` : `${b}-${a}`);
    const pairCount = new Map<string, number>();
    for (const sg of segments) {
      if (sg.a >= 0 && sg.b >= 0 && sg.a !== sg.b) {
        const key = pairKey(sg.a, sg.b);
        pairCount.set(key, (pairCount.get(key) ?? 0) + 1);
      }
    }
    const bpUf = new UnionFind(branchPoints.length);
    let anyMerged = false;
    for (const sg of segments) {
      if (sg.a >= 0 && sg.b >= 0 && sg.a !== sg.b && sg.length < mergeRadius) {
        if (pairCount.get(pairKey(sg.a, sg.b)) !== 1) continue; // parallel arc → loop, keep it
        if (bpUf.union(sg.a, sg.b)) anyMerged = true;
      }
    }
    if (anyMerged) {
      // Compact each cluster root → a new id, positioned at its members' centroid.
      const rootMembers = new Map<number, number[]>();
      for (let i = 0; i < branchPoints.length; i++) {
        const r = bpUf.find(i);
        let arr = rootMembers.get(r);
        if (!arr) rootMembers.set(r, (arr = []));
        arr.push(i);
      }
      const newId = new Map<number, number>(); // old branch id → merged id
      const merged: BranchPoint[] = [];
      for (const members of rootMembers.values()) {
        const id = merged.length;
        let cx = 0;
        let cy = 0;
        let cz = 0;
        for (const m of members) {
          const p = branchPoints[m]!.xyz;
          cx += p[0];
          cy += p[1];
          cz += p[2];
          newId.set(m, id);
        }
        const c = members.length;
        merged.push({ id, xyz: [cx / c, cy / c, cz / c] });
      }
      const remap = (bp: number): number => (bp >= 0 ? newId.get(bp)! : -1);
      const rebuilt: TopologySegment[] = [];
      const rebuiltCum: number[][] = [];
      segments.forEach((sg, i) => {
        const a = remap(sg.a);
        const b = remap(sg.b);
        // Drop only the contracted short connectors (both ends now one node AND
        // the segment was short); keep long self-loops (genuine lobes/rings).
        if (a === b && a >= 0 && sg.length < mergeRadius) return;
        rebuilt.push({ ...sg, id: rebuilt.length, a, b });
        rebuiltCum.push(segCum[i]!);
      });
      bpsOut = merged;
      segsOut = rebuilt;
      segCum.length = 0;
      segCum.push(...rebuiltCum);
    }
  }
  pushStage("merge junctions", { segments: snapSegs(segsOut), branchPoints: bpsOut.map((b) => b.xyz) });

  // 7c. dissolve degree-2 junctions — the invariant that there is NEVER a
  //     degree-2 branch point in the output. A branch point where exactly two
  //     DISTINCT segments meet is a pass-through, not a junction: splice the two
  //     segments into one (oriented so they join at the point) and drop the
  //     point. Iterating collapses whole chains of them. A lone self-loop (both
  //     ends of ONE segment at the point) is left with its single anchor — a
  //     ring genuinely has no junction, so it reduces to one closed segment.
  segsOut = segsOut.slice();
  for (;;) {
    const inc = new Map<number, number[]>(); // branch id → incident segment indices
    segsOut.forEach((sg, si) => {
      if (sg.a >= 0) {
        let arr = inc.get(sg.a);
        if (!arr) inc.set(sg.a, (arr = []));
        arr.push(si);
      }
      if (sg.b >= 0) {
        let arr = inc.get(sg.b);
        if (!arr) inc.set(sg.b, (arr = []));
        arr.push(si);
      }
    });
    let bp = -1;
    let s1 = -1;
    let s2 = -1;
    for (const [id, segs] of inc) {
      if (segs.length === 2 && segs[0] !== segs[1]) {
        bp = id;
        s1 = segs[0]!;
        s2 = segs[1]!;
        break;
      }
    }
    if (bp < 0) break;
    const A = segsOut[s1]!;
    const B = segsOut[s2]!;
    // Orient so the shared point `bp` is at A's END and B's START, then splice.
    const poly1 = A.a === bp ? [...A.polyline].reverse() : A.polyline;
    const newA = A.a === bp ? A.b : A.a;
    const poly2 = B.a === bp ? B.polyline : [...B.polyline].reverse();
    const newB = B.a === bp ? B.b : B.a;
    const mergedPoly = poly1.concat(poly2.slice(1));
    let len = 0;
    for (let i = 1; i < mergedPoly.length; i++) len += dist(mergedPoly[i]!, mergedPoly[i - 1]!);
    segsOut[s1] = { id: A.id, a: newA, b: newB, polyline: mergedPoly, length: len };
    segsOut.splice(s2, 1);
  }
  // Compact branch points to those still referenced; renumber ids + segment ids.
  const usedBp = new Set<number>();
  for (const sg of segsOut) {
    if (sg.a >= 0) usedBp.add(sg.a);
    if (sg.b >= 0) usedBp.add(sg.b);
  }
  const bpRemap = new Map<number, number>();
  const compactBps: BranchPoint[] = [];
  for (const b of bpsOut) {
    if (usedBp.has(b.id)) {
      const nid = compactBps.length;
      bpRemap.set(b.id, nid);
      compactBps.push({ id: nid, xyz: b.xyz });
    }
  }
  bpsOut = compactBps;
  segsOut = segsOut.map((sg, i) => ({
    ...sg,
    id: i,
    a: sg.a >= 0 ? bpRemap.get(sg.a)! : -1,
    b: sg.b >= 0 ? bpRemap.get(sg.b)! : -1,
  }));
  // Recompute cumulative arclengths for the final segments (used by §8).
  segCum.length = 0;
  for (const sg of segsOut) {
    const cum = [0];
    for (let i = 1; i < sg.polyline.length; i++) cum.push(cum[i - 1]! + dist(sg.polyline[i]!, sg.polyline[i - 1]!));
    segCum.push(cum);
  }
  pushStage("dissolve (final)", { segments: snapSegs(segsOut), branchPoints: bpsOut.map((b) => b.xyz) });

  // 8. associate EVERY LED to the nearest segment (no orphans — isolated LEDs
  //    and pruned-spur LEDs snap to the closest surviving segment).
  const associations: LedAssociation[] = [];
  for (let i = 0; i < n; i++) {
    let best = { seg: -1, s: 0, d: Infinity };
    for (let sg = 0; sg < segsOut.length; sg++) {
      const { s: arclen, d } = projectToPolyline(P[i]!, segsOut[sg]!.polyline, segCum[sg]!);
      if (d < best.d) best = { seg: sg, s: arclen, d };
    }
    if (best.seg >= 0) {
      associations.push({ ledId: leds[i]!.id, segmentId: best.seg, footArclength: best.s, dPerp: best.d });
    }
  }

  return {
    mapId: map.mapId,
    branchPoints: bpsOut,
    segments: segsOut,
    associations,
    ...(wantDebug ? { debug: { coincident, edges: dbgEdges, spacing: s, stages } } : {}),
  };
}
