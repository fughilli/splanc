/**
 * The mesh map's 3D view: fixtures as nodes at their room positions (fixtures with no room
 * pose where the force-directed layout puts them, drawn hollow), a Splanc bridge in the mesh
 * as a rounded square with a radio mark (never a fixture's dot), the radio links between
 * them coloured by signal or by hops, a floor grid and the room axes like the room preview
 * (RoomView, ui/orbit.ts), each node coloured by its health. Drag to orbit, pinch / wheel
 * to zoom, tap a node to select it.
 */

import type { Vec3 } from "@ledmapper/protocol";
import { Orbit, bounds, drawAxes, drawFloorGrid, fitCanvas, type Projected } from "./orbit";
import { SIGNAL_COLORS, hopColor, signalBand, type TopoModel, type TopoNode } from "./screens/meshTopoModel";

export type LinkColouring = "signal" | "hops";

const HEALTH_COLORS = { ok: "#2fb36d", warn: "#e0a100", bad: "#e5484d" } as const;
/** Tap radius around a node (CSS px). */
const HIT_PX = 22;

export class MeshTopoView {
  readonly canvas: HTMLCanvasElement;
  private model: TopoModel = { nodes: [], links: [], anyPosed: false, noTopology: 0, bridges: 0 };
  private colouring: LinkColouring = "signal";
  private selected: number | null = null;
  private readonly orbit: Orbit;
  private raf = 0;
  private ro: ResizeObserver | null = null;
  private placedAt = new Map<number, Projected>();

  constructor(private readonly onSelect: (node: number | null) => void, cls = "mesh-topo-view") {
    this.canvas = document.createElement("canvas");
    this.canvas.className = cls;
    this.canvas.setAttribute("role", "img");
    this.orbit = new Orbit(this.canvas, () => this.kick(), (x, y) => this.tap(x, y));
    if (typeof ResizeObserver !== "undefined") {
      this.ro = new ResizeObserver(() => this.kick());
      this.ro.observe(this.canvas);
    }
  }

  update(m: TopoModel): void {
    this.model = m;
    const n = m.nodes.length - m.bridges;
    const b = m.bridges ? ` and ${m.bridges} bridge${m.bridges === 1 ? "" : "s"}` : "";
    this.canvas.setAttribute("aria-label", `Mesh map: ${n} fixture${n === 1 ? "" : "s"}${b}, ${m.links.length} radio link${m.links.length === 1 ? "" : "s"}`);
    this.kick();
  }

  setColouring(c: LinkColouring): void {
    this.colouring = c;
    this.kick();
  }

  select(node: number | null): void {
    this.selected = node;
    this.kick();
  }

  /** Where node `node` was last drawn (CSS px in the canvas), for tests and the harness. */
  screenPos(node: number): { x: number; y: number } | null {
    const p = this.placedAt.get(node);
    return p ? { x: p.x, y: p.y } : null;
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.ro?.disconnect();
  }

  private tap(x: number, y: number): void {
    let best: number | null = null;
    let bd = HIT_PX;
    for (const [node, p] of this.placedAt) {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bd) {
        bd = d;
        best = node;
      }
    }
    this.onSelect(best);
  }

  private kick(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.draw();
    });
  }

  private draw(): void {
    const fit = fitCanvas(this.canvas);
    if (!fit) return;
    const { g, w, h } = fit;
    const css = getComputedStyle(this.canvas);
    const fg = css.getPropertyValue("--text-dim").trim() || "#8a8f98";
    const text = css.getPropertyValue("--text").trim() || "#e8e8e8";
    const bg = css.getPropertyValue("--surface").trim() || "#15171a";
    this.placedAt.clear();
    const nodes = this.model.nodes;
    const b = bounds(nodes.map((n) => n.pos));
    if (!b) {
      g.fillStyle = fg;
      g.font = "13px system-ui, sans-serif";
      g.textAlign = "center";
      g.fillText("No fixtures in this mesh yet", w / 2, h / 2);
      return;
    }
    const { min, max } = b;
    // Frame the nodes and their labels to fill the canvas (the projection is linear in
    // 1 / radius about the centre: measure once, then rescale).
    const r0 = Math.max(0.5, b.radius);
    const p0 = this.orbit.projector(w, h, b.ctr, r0);
    let fx = 0, fy = 0;
    const floorY = Math.min(...nodes.map((n) => n.pos[1])) - 0.05;
    for (const n of nodes) {
      // The node (its label above it) and its drop line's foot on the floor.
      for (const [q, mx, my] of [
        [p0(n.pos), 70, 36],
        [p0([n.pos[0], floorY, n.pos[2]] as Vec3), 12, 12],
      ] as [ReturnType<typeof p0>, number, number][]) {
        fx = Math.max(fx, Math.abs(q.x - w / 2) / Math.max(1, w / 2 - mx));
        fy = Math.max(fy, Math.abs(q.y - h / 2) / Math.max(1, h / 2 - my));
      }
    }
    const fit0 = Math.max(fx, fy);
    const radius = fit0 > 0 ? r0 * fit0 : r0;
    const proj = this.orbit.projector(w, h, b.ctr, radius);
    const floor = floorY;
    drawFloorGrid(g, proj, min, max, floor, fg);
    if (this.model.anyPosed) drawAxes(g, proj);

    // Drop lines from posed nodes to the floor (depth cue).
    g.strokeStyle = fg;
    g.globalAlpha = 0.35;
    g.lineWidth = 1;
    g.setLineDash([2, 3]);
    for (const n of nodes) {
      if (n.placed !== "room" || n.pos[1] - floor < 0.1) continue;
      const a = proj(n.pos), f = proj([n.pos[0], floor, n.pos[2]] as Vec3);
      g.beginPath();
      g.moveTo(a.x, a.y);
      g.lineTo(f.x, f.y);
      g.stroke();
    }
    g.setLineDash([]);
    g.globalAlpha = 1;

    // Links.
    const at = new Map(nodes.map((n) => [n.node, n]));
    const sel = this.selected;
    for (const l of this.model.links) {
      const A = at.get(l.a), B = at.get(l.b);
      if (!A || !B) continue;
      const pa = proj(A.pos), pb = proj(B.pos);
      const col = this.colouring === "signal" ? SIGNAL_COLORS[signalBand(l.rssi)] : hopColor(l.hops);
      const onSel = sel !== null && (l.a === sel || l.b === sel);
      g.strokeStyle = col;
      g.globalAlpha = sel === null || onSel ? 0.95 : 0.3;
      g.lineWidth = onSel ? 4 : 2.5;
      if (l.rssi === null) g.setLineDash([5, 4]);
      g.beginPath();
      g.moveTo(pa.x, pa.y);
      g.lineTo(pb.x, pb.y);
      g.stroke();
      g.setLineDash([]);
    }
    g.globalAlpha = 1;

    // Nodes, far to near.
    const order = nodes.map((n) => ({ n, p: proj(n.pos) })).sort((x, y) => x.p.d - y.p.d);
    g.font = "600 12px system-ui, sans-serif";
    g.textAlign = "center";
    for (const { n, p } of order) {
      this.placedAt.set(n.node, p);
      drawNode(g, n, p, n.node === sel, bg, text);
    }
    // Where each node is on screen (CSS px): what an end-to-end test taps.
    this.canvas.dataset["nodes"] = JSON.stringify(Object.fromEntries([...this.placedAt].map(([k, p]) => [k, [Math.round(p.x), Math.round(p.y)]])));
  }
}

function drawNode(g: CanvasRenderingContext2D, n: TopoNode, p: Projected, selected: boolean, bg: string, text: string): void {
  if (n.kind === "bridge") {
    drawBridge(g, n, p, selected, bg, text);
    return;
  }
  const r = n.self ? 11 : 9;
  const col = HEALTH_COLORS[n.health];
  if (selected) {
    g.strokeStyle = text;
    g.lineWidth = 2;
    g.beginPath();
    g.arc(p.x, p.y, r + 6, 0, 2 * Math.PI);
    g.stroke();
  }
  g.beginPath();
  g.arc(p.x, p.y, r, 0, 2 * Math.PI);
  if (n.placed === "room") {
    g.fillStyle = col;
    g.fill();
    g.strokeStyle = bg;
    g.lineWidth = 2;
    g.stroke();
  } else {
    // No room pose: hollow, dashed (placed by the layout from its links).
    g.fillStyle = bg;
    g.fill();
    g.strokeStyle = col;
    g.lineWidth = 3;
    g.setLineDash([4, 3]);
    g.stroke();
    g.setLineDash([]);
  }
  if (n.self) {
    g.fillStyle = n.placed === "room" ? bg : col;
    g.beginPath();
    g.arc(p.x, p.y, 3.5, 0, 2 * Math.PI);
    g.fill();
  }
  drawLabel(g, n.name, p, r, bg, text);
}

function drawLabel(g: CanvasRenderingContext2D, name: string, p: Projected, r: number, bg: string, text: string): void {
  const label = name.length > 22 ? name.slice(0, 21) + "…" : name;
  g.lineWidth = 3;
  g.strokeStyle = bg;
  g.strokeText(label, p.x, p.y - r - 7);
  g.fillStyle = text;
  g.fillText(label, p.x, p.y - r - 7);
}

/** A bridge: a rounded square in its health colour with a radio mark (a mast and two
 * waves), so it reads as infrastructure, not a light. Solid even without a room position:
 * a bridge is never localized, so "hollow" (not placed yet) would mislead. */
function drawBridge(g: CanvasRenderingContext2D, n: TopoNode, p: Projected, selected: boolean, bg: string, text: string): void {
  const r = 11;
  const col = HEALTH_COLORS[n.health];
  if (selected) {
    g.strokeStyle = text;
    g.lineWidth = 2;
    roundRect(g, p.x - r - 6, p.y - r - 6, 2 * (r + 6), 2 * (r + 6), 8);
    g.stroke();
  }
  roundRect(g, p.x - r, p.y - r, 2 * r, 2 * r, 5);
  g.fillStyle = col;
  g.fill();
  g.strokeStyle = bg;
  g.lineWidth = 2;
  g.stroke();
  // The radio mark, in the background colour: a mast with a dot, two arcs either side.
  g.strokeStyle = bg;
  g.fillStyle = bg;
  g.lineWidth = 1.75;
  g.lineCap = "round";
  g.beginPath();
  g.moveTo(p.x, p.y - 1);
  g.lineTo(p.x, p.y + 6);
  g.stroke();
  g.beginPath();
  g.arc(p.x, p.y - 2.5, 1.8, 0, 2 * Math.PI);
  g.fill();
  for (const rad of [4.5, 7.5]) {
    g.beginPath();
    g.arc(p.x, p.y - 2.5, rad, -Math.PI * 0.8, -Math.PI * 0.2);
    g.stroke();
  }
  g.lineCap = "butt";
  drawLabel(g, n.name, p, r, bg, text);
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
