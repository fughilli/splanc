/**
 * Room preview for multi-fixture localization: every fixture's LEDs placed by
 * its room pose, one colour per fixture, a floor grid at the lowest LED, world
 * axes (+Y up), the solved camera path, and a highlighted selection for manual
 * nudging. Dependency-free 2D canvas painter (depth-sorted), drag to orbit,
 * wheel / pinch to zoom — the same conventions as MapView, much smaller.
 */

import type { Pose, Vec3 } from "@ledmapper/protocol";
import { applyRoomPose, type RoomPose } from "../geom/multiFixture";

export interface RoomViewFixture {
  name: string;
  /** Map-frame LED positions. */
  leds: Vec3[];
  pose: RoomPose | null;
  /** Dim when unplaced / weak. */
  status?: "reference" | "localized" | "weak" | "unlocalized" | "manual";
}

/** Distinct, legible on dark and light backgrounds. */
export const FIXTURE_COLORS = ["#4cc9f0", "#f72585", "#b5e48c", "#ffb703", "#9d4edd", "#fb8500", "#06d6a0", "#ef476f"];

export class RoomView {
  readonly canvas: HTMLCanvasElement;
  private fixtures: RoomViewFixture[] = [];
  private cameras: Pose[] = [];
  private selected = -1;
  private yaw = 0.6;
  private pitch = 0.45;
  private zoom = 1;
  private raf = 0;
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private pinch0 = 0;
  private ro: ResizeObserver | null = null;

  constructor(cls = "room-view") {
    this.canvas = document.createElement("canvas");
    this.canvas.className = cls;
    this.canvas.style.touchAction = "none";
    this.canvas.addEventListener("pointerdown", (e) => {
      this.canvas.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 2) this.pinch0 = this.pinchDist();
    });
    this.canvas.addEventListener("pointermove", (e) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      if (this.pointers.size === 1) {
        this.yaw += (e.clientX - p.x) * 0.01;
        this.pitch = Math.max(-1.4, Math.min(1.4, this.pitch + (e.clientY - p.y) * 0.01));
      }
      p.x = e.clientX;
      p.y = e.clientY;
      if (this.pointers.size === 2) {
        const d = this.pinchDist();
        if (this.pinch0 > 0) this.zoom = Math.max(0.2, Math.min(8, (this.zoom * d) / this.pinch0));
        this.pinch0 = d;
      }
      this.kick();
    });
    const up = (e: PointerEvent) => this.pointers.delete(e.pointerId);
    this.canvas.addEventListener("pointerup", up);
    this.canvas.addEventListener("pointercancel", up);
    this.canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        this.zoom = Math.max(0.2, Math.min(8, this.zoom * Math.exp(-e.deltaY * 0.001)));
        this.kick();
      },
      { passive: false },
    );
    if (typeof ResizeObserver !== "undefined") {
      this.ro = new ResizeObserver(() => this.kick());
      this.ro.observe(this.canvas);
    }
  }

  private pinchDist(): number {
    const [a, b] = [...this.pointers.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  }

  update(fixtures: RoomViewFixture[], cameras: Pose[] = this.cameras): void {
    this.fixtures = fixtures;
    this.cameras = cameras;
    this.kick();
  }

  select(i: number): void {
    this.selected = i;
    this.kick();
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.ro?.disconnect();
  }

  private kick(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.draw();
    });
  }

  private draw(): void {
    const c = this.canvas;
    const dpr = typeof devicePixelRatio === "number" ? devicePixelRatio : 1;
    const w = Math.max(1, c.clientWidth), h = Math.max(1, c.clientHeight);
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    const g = c.getContext("2d");
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const css = getComputedStyle(c);
    const fg = css.getPropertyValue("--text-dim").trim() || "#8a8f98";

    // World points (placed fixtures only) → bounds → view.
    const placed = this.fixtures.map((f) => (f.pose ? f.leds.map((p) => applyRoomPose(f.pose!, p)) : []));
    const all = placed.flat();
    if (all.length === 0) {
      g.fillStyle = fg;
      g.font = "13px system-ui, sans-serif";
      g.textAlign = "center";
      g.fillText("No fixtures placed yet", w / 2, h / 2);
      return;
    }
    const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const p of all)
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k]!, p[k]!);
        max[k] = Math.max(max[k]!, p[k]!);
      }
    const ctr: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    const radius = Math.max(0.3, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2);
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw), cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const scale = (Math.min(w, h) / (2.4 * radius)) * this.zoom;
    const proj = (p: Vec3): { x: number; y: number; d: number } => {
      const x = p[0] - ctr[0], y = p[1] - ctr[1], z = p[2] - ctr[2];
      const x1 = cy * x + sy * z, z1 = -sy * x + cy * z;
      const y2 = cp * y - sp * z1, z2 = sp * y + cp * z1;
      return { x: w / 2 + x1 * scale, y: h / 2 - y2 * scale, d: z2 };
    };

    // Floor grid (0.5 m) at the lowest LED.
    g.strokeStyle = fg;
    g.globalAlpha = 0.25;
    g.lineWidth = 1;
    const step = 0.5;
    const gx0 = Math.floor((min[0] - 0.5) / step) * step, gx1 = Math.ceil((max[0] + 0.5) / step) * step;
    const gz0 = Math.floor((min[2] - 0.5) / step) * step, gz1 = Math.ceil((max[2] + 0.5) / step) * step;
    const fy = min[1];
    for (let x = gx0; x <= gx1 + 1e-9; x += step) line(g, proj([x, fy, gz0]), proj([x, fy, gz1]));
    for (let z = gz0; z <= gz1 + 1e-9; z += step) line(g, proj([gx0, fy, z]), proj([gx1, fy, z]));
    g.globalAlpha = 1;

    // Axes at the room origin (the reference fixture's frame).
    const o = proj([0, 0, 0]);
    for (const [v, col] of [
      [[0.25, 0, 0], "#e63946"],
      [[0, 0.25, 0], "#2a9d8f"],
      [[0, 0, 0.25], "#457b9d"],
    ] as [Vec3, string][]) {
      g.strokeStyle = col;
      g.lineWidth = 2;
      line(g, o, proj(v));
    }

    // Camera path.
    g.fillStyle = fg;
    g.globalAlpha = 0.5;
    for (const cam of this.cameras) {
      const q = proj(cam.p);
      g.fillRect(q.x - 1, q.y - 1, 2, 2);
    }
    g.globalAlpha = 1;

    // LEDs, depth-sorted.
    const dots: { x: number; y: number; d: number; c: string; r: number; a: number }[] = [];
    placed.forEach((pts, i) => {
      const f = this.fixtures[i]!;
      const col = FIXTURE_COLORS[i % FIXTURE_COLORS.length]!;
      const sel = i === this.selected;
      const a = f.status === "weak" ? 0.55 : 1;
      for (const p of pts) {
        const q = proj(p);
        dots.push({ ...q, c: col, r: sel ? 3.2 : 2.2, a });
      }
    });
    dots.sort((a, b) => a.d - b.d);
    for (const d of dots) {
      g.globalAlpha = d.a;
      g.fillStyle = d.c;
      g.beginPath();
      g.arc(d.x, d.y, d.r, 0, 2 * Math.PI);
      g.fill();
    }
    g.globalAlpha = 1;

    // Labels at each fixture's centroid.
    g.font = "12px system-ui, sans-serif";
    g.textAlign = "center";
    placed.forEach((pts, i) => {
      if (pts.length === 0) return;
      const m: Vec3 = [0, 0, 0];
      for (const p of pts) for (let k = 0; k < 3; k++) m[k] = m[k]! + p[k]! / pts.length;
      const q = proj([m[0], m[1] + 0.12 + radius * 0.04, m[2]]);
      const f = this.fixtures[i]!;
      g.fillStyle = FIXTURE_COLORS[i % FIXTURE_COLORS.length]!;
      g.fillText(f.status === "reference" ? `${f.name} (origin)` : f.name, q.x, q.y);
    });
  }
}

function line(g: CanvasRenderingContext2D, a: { x: number; y: number }, b: { x: number; y: number }): void {
  g.beginPath();
  g.moveTo(a.x, a.y);
  g.lineTo(b.x, b.y);
  g.stroke();
}
