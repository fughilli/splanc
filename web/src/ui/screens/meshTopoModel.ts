/**
 * The mesh map (#/mesh/topology) from the connected fixture's `get_mesh{topology}`: the
 * fixtures as nodes at their room positions, the radio links between them, each fixture's
 * health, and a force-directed place for fixtures with no room pose. Pure (no DOM),
 * unit-tested in web/tests/meshTopology.test.ts.
 */

import type { Vec3 } from "@ledmapper/protocol";
import { meshPeers, meshPoseState, type MeshMemberInfo, type MeshNeighbourInfo, type MeshStateInfo } from "../../net/mesh";
import { nodeLabel } from "./meshModel";

export type TopoHealth = "ok" | "warn" | "bad";
export type TopoPlacement = "room" | "layout";

export interface TopoNode {
  node: number;
  name: string;
  /** The fixture this phone is connected to (the gateway). */
  self: boolean;
  /** Its room pose's position (m, room frame, +Y up), or null when it has none. */
  roomPos: Vec3 | null;
  room: string;
  /** What the mesh knows of its pose. */
  pose: "set" | "none" | "unknown";
  /** Where the map draws it: its room position, or the layout's. */
  pos: Vec3;
  placed: TopoPlacement;
  /** Hops from the connected fixture (0 = it; 1 = a direct neighbour). */
  hops: number;
  sync: number;
  fps: number | null;
  lastError: number;
  lastErrorOp: number;
  seenMsAgo: number | null;
  heapFree: number | null;
  uptimeS: number | null;
  /** Its firmware sends no topology (older firmware, or nothing heard yet). */
  noTopology: boolean;
  health: TopoHealth;
  /** "Time synced · 80 fps". */
  healthText: string;
  neighbours: MeshNeighbourInfo[];
}

export interface TopoLink {
  /** a < b (node ids). */
  a: number;
  b: number;
  /** As a hears b, and b hears a (dBm; null when that side did not report it). */
  rssiAB: number | null;
  rssiBA: number | null;
  /** The weaker direction (what limits the link), or null. */
  rssi: number | null;
  /** Unicast delivery, the worse direction (percent), or null. */
  txOkPct: number | null;
  /** The deeper end's hops from the connected fixture. */
  hops: number;
}

export interface TopoModel {
  nodes: TopoNode[];
  links: TopoLink[];
  /** Some fixture has a room pose (the map is in room coordinates). */
  anyPosed: boolean;
  /** Fixtures whose firmware sent no topology at all. */
  noTopology: number;
}

/** RSSI bands: ≥ −60 dBm strong, ≥ −75 fair, below that weak. */
export type SignalBand = "strong" | "fair" | "weak" | "unknown";

export function signalBand(rssi: number | null | undefined): SignalBand {
  if (rssi === null || rssi === undefined || rssi === 0) return "unknown";
  if (rssi >= -60) return "strong";
  if (rssi >= -75) return "fair";
  return "weak";
}

export const SIGNAL_TEXT: Record<SignalBand, string> = { strong: "Strong", fair: "Fair", weak: "Weak", unknown: "Not measured" };

/** Colours (legible on light and dark): links by signal, and by hops. */
export const SIGNAL_COLORS: Record<SignalBand, string> = { strong: "#2fb36d", fair: "#e0a100", weak: "#e5484d", unknown: "#8a8f98" };
export const HOP_COLORS = ["#8a8f98", "#3b82f6", "#a855f7", "#f97316"];

export function hopColor(hops: number): string {
  return HOP_COLORS[Math.max(0, Math.min(HOP_COLORS.length - 1, hops))]!;
}

export function hopText(hops: number): string {
  if (hops <= 0) return "Connected to this phone";
  if (hops === 1) return "Direct neighbour";
  return `${hops} hops away`;
}

/** Since a member was last heard, it counts as quiet after this long. */
const QUIET_MS = 15_000;

function health(m: MeshMemberInfo, self: boolean): { health: TopoHealth; text: string } {
  const parts: string[] = [];
  let hl: TopoHealth = "ok";
  const sync = m.sync ?? 0;
  if (sync >= 2) parts.push("Time synced");
  else {
    parts.push(sync === 1 ? "Syncing time" : "Not synced yet");
    hl = "warn";
  }
  if (m.fps) parts.push(`${m.fps} fps`);
  else if (!self && m.firmware !== undefined) {
    parts.push("not rendering");
    hl = "warn";
  }
  if (!self && (m.seenMsAgo ?? 0) > QUIET_MS) {
    parts.push(`not heard for ${Math.round((m.seenMsAgo ?? 0) / 1000)} s`);
    hl = "warn";
  }
  if (m.lastError) {
    parts.push(`last change failed (code ${m.lastError})`);
    hl = "bad";
  }
  return { health: hl, text: parts.join(" · ") };
}

function vec3(v: number[] | undefined): Vec3 | null {
  if (!v || v.length !== 3 || !v.every((x) => Number.isFinite(x))) return null;
  return [v[0]!, v[1]!, v[2]!];
}

/** The map's model from the connected fixture's state `s`; `name` names a node (the app's
 * records), `selfName` the connected fixture. */
export function meshTopoModel(s: MeshStateInfo | null, name: (node: number) => string | undefined, selfName: string): TopoModel {
  if (!s || !s.on || !s.member) return { nodes: [], links: [], anyPosed: false, noTopology: 0 };
  const selfNode = s.node ?? 0;
  const selfInfo: MeshMemberInfo = {
    node: selfNode,
    sync: s.sync ?? 0,
    ...(s.pose ? { pose: s.pose } : {}),
    ...(s.poseState !== undefined ? { poseState: s.poseState } : {}),
    neighbours: s.neighbours ?? [],
  };
  const members = [selfInfo, ...meshPeers(s)];
  const hasSelfTopo = meshPoseState(s.poseState) !== "MESH_POSE_UNKNOWN" || s.pose !== undefined || (s.neighbours?.length ?? 0) > 0;
  const nodes: TopoNode[] = members.map((m, i) => {
    const self = i === 0;
    const ps = meshPoseState(m.poseState);
    const roomPos = ps === "MESH_POSE_SET" ? vec3(m.pose?.translation) : null;
    const { health: hl, text } = health(m, self);
    return {
      node: m.node,
      name: self ? selfName : name(m.node) || nodeLabel(m.node),
      self,
      roomPos,
      room: roomPos ? m.pose?.room ?? "" : "",
      pose: roomPos ? "set" : ps === "MESH_POSE_NONE" ? "none" : "unknown",
      pos: roomPos ?? [0, 0, 0],
      placed: roomPos ? "room" : "layout",
      hops: self ? 0 : m.hops ?? 0,
      sync: m.sync ?? 0,
      fps: m.fps ?? null,
      lastError: m.lastError ?? 0,
      lastErrorOp: m.lastErrorOp ?? 0,
      seenMsAgo: self ? null : m.seenMsAgo ?? 0,
      heapFree: m.heapFree ?? null,
      uptimeS: m.uptimeS ?? null,
      noTopology: self ? !hasSelfTopo : m.topologyMsAgo === undefined,
      health: hl,
      healthText: text,
      neighbours: m.neighbours ?? [],
    };
  });
  const known = new Set(nodes.map((n) => n.node));

  // Links: every reported neighbour pair between known fixtures, both directions merged.
  const byKey = new Map<string, TopoLink>();
  const note = (from: number, to: number, rssi: number | undefined, tx: number | undefined): void => {
    if (from === to || !known.has(from) || !known.has(to)) return;
    const a = Math.min(from, to), b = Math.max(from, to);
    const k = `${a}-${b}`;
    let l = byKey.get(k);
    if (!l) {
      l = { a, b, rssiAB: null, rssiBA: null, rssi: null, txOkPct: null, hops: 0 };
      byKey.set(k, l);
    }
    const r = rssi === undefined || rssi === 0 ? null : rssi;
    if (from === a) l.rssiAB = r ?? l.rssiAB;
    else l.rssiBA = r ?? l.rssiBA;
    if (tx !== undefined) l.txOkPct = l.txOkPct === null ? tx : Math.min(l.txOkPct, tx);
  };
  for (const n of nodes) for (const nb of n.neighbours) note(n.node, nb.node, nb.rssi, nb.txOkPct);
  // Older firmware reports no neighbours: the gateway's own RSSI from a member still is a link.
  for (const m of meshPeers(s)) {
    if (!m.rssi) continue;
    note(selfNode, m.node, undefined, undefined);
    backfill(byKey, selfNode, m.node, m.rssi);
  }

  // Hops: what members said, else breadth-first over the links from the connected fixture.
  const adj = new Map<number, number[]>();
  for (const l of byKey.values()) {
    adj.set(l.a, [...(adj.get(l.a) ?? []), l.b]);
    adj.set(l.b, [...(adj.get(l.b) ?? []), l.a]);
  }
  const bfs = new Map<number, number>([[selfNode, 0]]);
  const q = [selfNode];
  while (q.length) {
    const x = q.shift()!;
    for (const y of adj.get(x) ?? []) {
      if (bfs.has(y)) continue;
      bfs.set(y, bfs.get(x)! + 1);
      q.push(y);
    }
  }
  for (const n of nodes) if (!n.self && n.hops === 0) n.hops = bfs.get(n.node) ?? 0;
  const hopsOf = new Map(nodes.map((n) => [n.node, n.hops]));
  const links = [...byKey.values()].map((l) => {
    const rs = [l.rssiAB, l.rssiBA].filter((x): x is number => x !== null);
    return { ...l, rssi: rs.length ? Math.min(...rs) : null, hops: Math.max(hopsOf.get(l.a) ?? 0, hopsOf.get(l.b) ?? 0) };
  });
  links.sort((x, y) => x.a - y.a || x.b - y.b);
  layoutTopology(nodes, links);
  return { nodes, links, anyPosed: nodes.some((n) => n.placed === "room"), noTopology: nodes.filter((n) => n.noTopology).length };
}

function backfill(byKey: Map<string, TopoLink>, self: number, member: number, rssi: number): void {
  const a = Math.min(self, member), b = Math.max(self, member);
  const l = byKey.get(`${a}-${b}`);
  if (!l) return;
  // The gateway's reading is "self hears member".
  if (self === a && l.rssiAB === null) l.rssiAB = rssi;
  if (self === b && l.rssiBA === null) l.rssiBA = rssi;
}

/** A link's rest length for the layout (m): stronger signal, closer. */
export function restLength(rssi: number | null): number {
  if (rssi === null) return 2.5;
  return Math.max(0.8, Math.min(4, 1 + (-rssi - 40) / 12));
}

/** Small deterministic PRNG (the layout is the same on every refresh). */
function rng(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 4294967296;
  };
}

/**
 * Place the fixtures without a room pose: a force-directed (stress) layout on the floor plane
 * of the posed ones, each pair kept at its distance over the links (a link's rest length
 * from its signal), with posed fixtures fixed. With nobody posed, the connected fixture is the origin.
 * Deterministic for the same input. Mutates `nodes[i].pos`.
 */
export function layoutTopology(nodes: TopoNode[], links: TopoLink[], iterations = 120): void {
  const free = nodes.filter((n) => n.placed === "layout");
  if (free.length === 0) return;
  const posed = nodes.filter((n) => n.placed === "room");
  const floorY = posed.length ? posed.reduce((s, n) => s + n.pos[1], 0) / posed.length : 0;
  const index = new Map(nodes.map((n, i) => [n.node, i]));
  const fixed = nodes.map((n) => n.placed === "room");
  if (!posed.length) {
    const self = nodes.find((n) => n.self) ?? nodes[0]!;
    self.pos = [0, 0, 0];
    fixed[index.get(self.node)!] = true;
  }
  // Start: near the centroid of placed neighbours, else on a circle around the centroid.
  const c: Vec3 = [0, floorY, 0];
  const anchors = nodes.filter((_, i) => fixed[i]);
  for (const n of anchors) {
    c[0] += n.pos[0] / anchors.length;
    c[2] += n.pos[2] / anchors.length;
  }
  const rand = rng(0x5eed ^ nodes.reduce((h, n) => (h * 31 + n.node) >>> 0, 7));
  let k = 0;
  for (const n of nodes) {
    const i = index.get(n.node)!;
    if (fixed[i]) continue;
    const nb = links.filter((l) => l.a === n.node || l.b === n.node).map((l) => (l.a === n.node ? l.b : l.a)).map((x) => index.get(x)!).filter((j) => fixed[j]);
    const a = (k++ / Math.max(1, free.length)) * 2 * Math.PI + rand() * 0.3;
    if (nb.length) {
      const m: Vec3 = [0, floorY, 0];
      for (const j of nb) {
        m[0] += nodes[j]!.pos[0] / nb.length;
        m[2] += nodes[j]!.pos[2] / nb.length;
      }
      n.pos = [m[0] + Math.cos(a) * 1.5, floorY, m[2] + Math.sin(a) * 1.5];
    } else {
      n.pos = [c[0] + Math.cos(a) * 2.5, floorY, c[2] + Math.sin(a) * 2.5];
    }
  }
  // Target distances: the shortest path over the links (rest lengths), so a fixture two hops
  // out sits beyond its relay; fixtures with no path between them, a little beyond the rest.
  const N = nodes.length;
  const D: number[][] = nodes.map((_, i) => nodes.map((__, j) => (i === j ? 0 : Infinity)));
  for (const l of links) {
    const i = index.get(l.a)!, j = index.get(l.b)!;
    const r = restLength(l.rssi);
    D[i]![j] = Math.min(D[i]![j]!, r);
    D[j]![i] = Math.min(D[j]![i]!, r);
  }
  for (let k2 = 0; k2 < N; k2++)
    for (let i = 0; i < N; i++)
      for (let j = 0; j < N; j++) {
        const v = D[i]![k2]! + D[k2]![j]!;
        if (v < D[i]![j]!) D[i]![j] = v;
      }
  let far = 0;
  for (const row of D) for (const v of row) if (Number.isFinite(v)) far = Math.max(far, v);
  far = Math.max(2.5, far) * 1.2;
  for (const row of D) for (let j = 0; j < N; j++) if (!Number.isFinite(row[j]!)) row[j] = far;
  // Stress majorization, one free node at a time (posed nodes stay where they are).
  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < N; i++) {
      if (fixed[i]) continue;
      const p = nodes[i]!.pos;
      let sx = 0, sz = 0, sw = 0;
      for (let j = 0; j < N; j++) {
        if (j === i) continue;
        const q = nodes[j]!.pos;
        const dij = Math.max(0.5, D[i]![j]!);
        const w = 1 / (dij * dij);
        let dx = p[0] - q[0], dz = p[2] - q[2];
        let d = Math.hypot(dx, dz);
        if (d < 1e-6) {
          // Coincident: push apart in a fixed, node-dependent direction.
          const a = ((nodes[i]!.node * 2654435761) >>> 0) / 4294967296 * 2 * Math.PI;
          dx = Math.cos(a);
          dz = Math.sin(a);
          d = 1;
        }
        sx += w * (q[0] + (dij * dx) / d);
        sz += w * (q[2] + (dij * dz) / d);
        sw += w;
      }
      if (sw > 0) nodes[i]!.pos = [sx / sw, floorY, sz / sw];
    }
  }
}

/** The details a node's sheet lists, as label/value rows. */
export function nodeDetails(n: TopoNode, m: TopoModel, name: (node: number) => string): [string, string][] {
  const rows: [string, string][] = [];
  rows.push(["Health", n.healthText || "No report yet"]);
  rows.push(["Route", hopText(n.hops)]);
  if (n.pose === "set" && n.roomPos) {
    const [x, y, z] = n.roomPos.map((v) => v.toFixed(2));
    rows.push(["Room position", `${n.room ? n.room + " · " : ""}x ${x} m, y ${y} m, z ${z} m`]);
  } else {
    rows.push(["Room position", n.noTopology ? "Not reported (update its firmware)" : n.pose === "none" ? "Not placed: localize the room to place it" : "Not reported yet"]);
  }
  if (n.fps !== null) rows.push(["Frame rate", `${n.fps} fps`]);
  if (n.lastError) rows.push(["Last error", `code ${n.lastError}${n.lastErrorOp ? ` (change ${n.lastErrorOp})` : ""}`]);
  if (n.seenMsAgo !== null) rows.push(["Last heard", n.seenMsAgo < 1500 ? "just now" : `${Math.round(n.seenMsAgo / 1000)} s ago`]);
  if (n.uptimeS !== null) rows.push(["Up for", uptime(n.uptimeS)]);
  if (n.heapFree !== null) rows.push(["Free memory", `${Math.round(n.heapFree / 1024)} KB`]);
  rows.push(["Mesh node", n.node.toString(16).toUpperCase().padStart(4, "0")]);
  for (const l of m.links.filter((l) => l.a === n.node || l.b === n.node)) {
    const other = l.a === n.node ? l.b : l.a;
    const hears = l.a === n.node ? l.rssiAB : l.rssiBA;
    const sig = hears !== null ? `${hears} dBm` : l.rssi !== null ? `${l.rssi} dBm` : "signal not measured";
    rows.push([`Link to ${name(other)}`, `${SIGNAL_TEXT[signalBand(hears ?? l.rssi)]} · ${sig}${l.txOkPct !== null ? ` · ${l.txOkPct}% delivered` : ""}`]);
  }
  return rows;
}

function uptime(s: number): string {
  if (s < 90) return `${s} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  if (s < 172800) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} days`;
}
