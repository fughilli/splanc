/**
 * Effects runtime — browser seam (docs/design/effects-runtime.md,
 * effects-compiler.md). Loads the compiler wasm (//fx_compiler:fx_compiler_web,
 * served at /fx-compiler) and the VM wasm (//firmware/fx_vm:fx_vm_web, at
 * /fx-vm), and wraps them:
 *   - compileScript(src) → { ok, bytecode, uniforms, diagnostics }
 *   - FxPreview: runs the EXACT firmware VM over a map's LED positions each
 *     tick → flat RGB, fed to MapView.setLedColors() for an offline preview.
 * Running the same VM as the device means the preview can't drift. Mirrors the
 * pulse-wasm loading pattern in effects/sim.ts.
 */

import { assetUrl } from "../assetBase";

export type FxUiKind =
  | { kind: "slider"; min: number; max: number; step: number }
  | { kind: "color" }
  | { kind: "toggle" }
  | { kind: "dropdown"; options: string[] };

export interface FxUniform {
  name: string;
  slot: number;
  width: number;
  ui: FxUiKind;
  default: number[];
}

export interface FxDiagnostic {
  line: number;
  col: number;
  msg: string;
}

export interface FxCompiled {
  ok: boolean;
  bytecode: Uint8Array;
  uniforms: FxUniform[];
  diagnostics: FxDiagnostic[];
}

interface CompilerResult {
  readonly ok: boolean;
  readonly bytecode: Uint8Array;
  readonly manifest: string;
  readonly diagnostics: string;
}
interface CompilerModule {
  default(wasm: string): Promise<unknown>;
  fx_compile(src: string): CompilerResult;
}
interface FxPreviewWasm {
  set_uniform(slot: number, vals: Float32Array): void;
  set_topology(seg: Int32Array, s: Float32Array, branch: Uint8Array, dist: Float32Array): void;
  set_graph(segLen: Float32Array, segA: Int32Array, segB: Int32Array): void;
  update(time: number, dt: number, frame: number, ledCount: number): void;
  shade_all(positions: Float32Array): Uint8Array;
  free(): void;
}
interface VmModule {
  default(wasm: string): Promise<unknown>;
  FxPreview: new (fxb: Uint8Array) => FxPreviewWasm;
}

let compilerMod: Promise<CompilerModule> | null = null;
let vmMod: Promise<VmModule> | null = null;

function loadCompiler(base = assetUrl("fx-compiler")): Promise<CompilerModule> {
  if (compilerMod === null) {
    compilerMod = (async () => {
      const mod = (await import(/* @vite-ignore */ `${base}/fx_compiler_wasm_pkg.js`)) as CompilerModule;
      await mod.default(`${base}/fx_compiler_wasm_pkg_bg.wasm`);
      return mod;
    })();
  }
  return compilerMod;
}

function loadVm(base = assetUrl("fx-vm")): Promise<VmModule> {
  if (vmMod === null) {
    vmMod = (async () => {
      const mod = (await import(/* @vite-ignore */ `${base}/fx_vm_wasm_pkg.js`)) as VmModule;
      await mod.default(`${base}/fx_vm_wasm_pkg_bg.wasm`);
      return mod;
    })();
  }
  return vmMod;
}

/** Compile GLSL-ish effect source to `.fxb` bytecode + a uniform manifest. */
export async function compileScript(src: string): Promise<FxCompiled> {
  const mod = await loadCompiler();
  const r = mod.fx_compile(src);
  return {
    ok: r.ok,
    bytecode: r.bytecode,
    uniforms: r.ok ? (JSON.parse(r.manifest) as FxUniform[]) : [],
    diagnostics: JSON.parse(r.diagnostics) as FxDiagnostic[],
  };
}

/** Offline preview: the exact device VM run over a map in the browser. */
export class FxPreview {
  private constructor(private readonly inner: FxPreviewWasm) {}

  static async create(bytecode: Uint8Array): Promise<FxPreview> {
    const mod = await loadVm();
    return new FxPreview(new mod.FxPreview(bytecode));
  }

  setUniform(slot: number, vals: number[]): void {
    this.inner.set_uniform(slot, new Float32Array(vals));
  }

  /**
   * Feed per-LED topology (LED order) so `shade()` sees `led.seg`/`led.s`/
   * `led.branch` exactly as the device does. Pass the result of
   * {@link deriveLedTopology}; call again (or with empty arrays) when the map or
   * topology changes.
   */
  setTopology(topo: LedTopology): void {
    this.inner.set_topology(topo.seg, topo.s, topo.branch, topo.dist);
    this.inner.set_graph(topo.segLen, topo.segA, topo.segB);
  }

  /** Advance one frame (runs update()). */
  tick(time: number, dt: number, frame: number, ledCount: number): void {
    this.inner.update(time, dt, frame, ledCount);
  }

  /** Shade every LED. `positions` is flat xyz (3*N); returns flat RGB (3*N). */
  shadeAll(positions: Float32Array): Uint8Array {
    return this.inner.shade_all(positions);
  }

  dispose(): void {
    this.inner.free();
  }
}

/** Per-LED topology in LED order, ready to hand to {@link FxPreview.setTopology}. */
export interface LedTopology {
  seg: Int32Array; // segment index, -1 = no association
  s: Float32Array; // normalized arclength 0..1 along the segment (from endpoint a)
  branch: Uint8Array; // 1 = within BRANCH_DIST of a junction (degree >= 3), else 0
  dist: Float32Array; // geodesic distance from the topology root, normalized 0..1
  // Topology graph (per segment, indexed like `seg`) for the graph-query
  // intrinsics: arclength + the two endpoint node ids (branch points get a
  // stable id; each free end gets its own leaf id).
  segLen: Float32Array;
  segA: Int32Array;
  segB: Int32Array;
}

/** An LED is "at a junction" within this arclength (m) of a degree>=3 endpoint. */
const FX_BRANCH_DIST_M = 0.05;

/**
 * Derive per-LED `led.seg` / `led.s` / `led.branch` from a map + its topology,
 * in LED order. This is the BROWSER MIRROR of the device's cache builder
 * (firmware/player_app/ffi.rs `fx_rebuild_topo`) — keep the two in sync so the
 * preview matches the hardware:
 *   - seg = index of the LED's segment in `topology.segments` (-1 if none)
 *   - s   = footArclength / segment.length, clamped to 0..1
 *   - branch = the LED is within FX_BRANCH_DIST_M of an endpoint whose branch
 *     point is a real junction (>=3 segments meet there)
 * Returns all-default topology (seg=-1) when there is no topology.
 */
export function deriveLedTopology(
  map: { leds: { id: number }[] },
  topology?: {
    branchPoints: { id: number }[];
    segments: { id: number; a: number; b: number; length: number }[];
    associations: { ledId: number; segmentId: number; footArclength: number }[];
  },
): LedTopology {
  const n = map.leds.length;
  const seg = new Int32Array(n).fill(-1);
  const s = new Float32Array(n);
  const branch = new Uint8Array(n);
  const dist = new Float32Array(n);
  if (!topology || topology.segments.length === 0)
    return {
      seg,
      s,
      branch,
      dist,
      segLen: new Float32Array(0),
      segA: new Int32Array(0),
      segB: new Int32Array(0),
    };

  // Branch points with degree >= 3 are true junctions (a pass-through is 2).
  const degree = new Map<number, number>();
  for (const g of topology.segments) {
    if (g.a >= 0) degree.set(g.a, (degree.get(g.a) ?? 0) + 1);
    if (g.b >= 0) degree.set(g.b, (degree.get(g.b) ?? 0) + 1);
  }
  const isJunction = (bpId: number): boolean => bpId >= 0 && (degree.get(bpId) ?? 0) >= 3;

  // Geodesic distance: build the segment graph (branch points + one synthetic
  // leaf per free end), find a far root (double Dijkstra sweep ≈ a diameter
  // endpoint), then each LED's distance is the shorter of "reach endpoint a then
  // walk footArc" vs "reach endpoint b then walk the remainder". Normalized to
  // 0..1, this is a global coordinate that sweeps the whole structure and
  // branches at junctions — what flood/pulse ride on.
  const nodeKey = (g: { id: number; a: number; b: number }, side: 0 | 1): string => {
    const bp = side === 0 ? g.a : g.b;
    return bp >= 0 ? `b${bp}` : `e${g.id}.${side}`;
  };
  const adj = new Map<string, { to: string; w: number }[]>();
  const edge = (u: string, v: string, w: number): void => {
    (adj.get(u) ?? adj.set(u, []).get(u)!).push({ to: v, w });
  };
  for (const g of topology.segments) {
    const u = nodeKey(g, 0);
    const v = nodeKey(g, 1);
    edge(u, v, g.length);
    edge(v, u, g.length);
  }

  // Integer node ids (stable per nodeKey) for the graph-query intrinsics, and
  // the per-segment length + endpoint node ids, indexed like `seg`.
  const nodeId = new Map<string, number>();
  const idOf = (k: string): number => {
    let id = nodeId.get(k);
    if (id === undefined) {
      id = nodeId.size;
      nodeId.set(k, id);
    }
    return id;
  };
  const segLen = new Float32Array(topology.segments.length);
  const segA = new Int32Array(topology.segments.length);
  const segB = new Int32Array(topology.segments.length);
  topology.segments.forEach((g, i) => {
    segLen[i] = g.length;
    segA[i] = idOf(nodeKey(g, 0));
    segB[i] = idOf(nodeKey(g, 1));
  });
  const dijkstra = (src: string): Map<string, number> => {
    const d = new Map<string, number>();
    for (const k of adj.keys()) d.set(k, Infinity);
    d.set(src, 0);
    const seen = new Set<string>();
    for (;;) {
      let u: string | null = null;
      let best = Infinity;
      for (const [k, dk] of d) if (!seen.has(k) && dk < best) ((best = dk), (u = k));
      if (u === null) break;
      seen.add(u);
      for (const e of adj.get(u) ?? []) {
        const nd = d.get(u)! + e.w;
        if (nd < (d.get(e.to) ?? Infinity)) d.set(e.to, nd);
      }
    }
    return d;
  };
  // Root = a deterministic strand end: the first free end in segment order (a
  // real terminal is a free end, endpoint id -1), else the first segment's
  // 'a' endpoint. The firmware picks the root by the identical rule, so the
  // preview's geodesic field matches the device's.
  let root: string | undefined;
  for (const g of topology.segments) {
    if (g.a < 0) {
      root = nodeKey(g, 0);
      break;
    }
    if (g.b < 0) {
      root = nodeKey(g, 1);
      break;
    }
  }
  if (root === undefined && topology.segments.length > 0) root = nodeKey(topology.segments[0]!, 0);
  const D = root !== undefined ? dijkstra(root) : new Map<string, number>();

  const segById = new Map(topology.segments.map((g, i) => [g.id, { i, g }]));
  const assocByLed = new Map(topology.associations.map((a) => [a.ledId, a]));
  const raw = new Float32Array(n);
  let maxGeo = 0;
  for (let i = 0; i < n; i++) {
    const a = assocByLed.get(map.leds[i]!.id);
    if (a === undefined) continue;
    const hit = segById.get(a.segmentId);
    if (hit === undefined) continue;
    seg[i] = hit.i;
    const len = hit.g.length;
    s[i] = len > 1e-6 ? Math.min(1, Math.max(0, a.footArclength / len)) : 0;
    const nearA = a.footArclength <= FX_BRANCH_DIST_M;
    const nearB = len - a.footArclength <= FX_BRANCH_DIST_M;
    branch[i] = (nearA && isJunction(hit.g.a)) || (nearB && isJunction(hit.g.b)) ? 1 : 0;
    const da = D.get(nodeKey(hit.g, 0)) ?? Infinity;
    const db = D.get(nodeKey(hit.g, 1)) ?? Infinity;
    const geo = Math.min(da + a.footArclength, db + (len - a.footArclength));
    raw[i] = Number.isFinite(geo) ? geo : 0;
    if (raw[i]! > maxGeo) maxGeo = raw[i]!;
  }
  if (maxGeo > 1e-6) for (let i = 0; i < n; i++) dist[i] = raw[i]! / maxGeo;
  return { seg, s, branch, dist, segLen, segA, segB };
}
