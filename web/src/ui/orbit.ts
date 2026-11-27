/**
 * Orbit camera for the small 3D canvas painters (RoomView, MeshTopoView): drag to orbit,
 * wheel / pinch to zoom, a tap (press and release without moving) reported separately,
 * and the projection of a point (+Y up) into the canvas. The same conventions as MapView,
 * much smaller.
 */

import type { Vec3 } from "@ledmapper/protocol";

export interface Projected {
  x: number;
  y: number;
  /** Depth (larger = nearer the viewer). */
  d: number;
}

/** A tap moves less than this (CSS px) between press and release. */
const TAP_SLOP = 6;

export class Orbit {
  yaw = 0.6;
  pitch = 0.45;
  zoom = 1;
  private readonly pointers = new Map<number, { x: number; y: number; x0: number; y0: number }>();
  private pinch0 = 0;
  private moved = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onChange: () => void,
    private readonly onTap?: (x: number, y: number) => void,
  ) {
    canvas.style.touchAction = "none";
    canvas.addEventListener("pointerdown", (e) => {
      canvas.setPointerCapture?.(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY });
      if (this.pointers.size === 1) this.moved = false;
      if (this.pointers.size === 2) {
        this.pinch0 = this.pinchDist();
        this.moved = true;
      }
    });
    canvas.addEventListener("pointermove", (e) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      if (Math.hypot(e.clientX - p.x0, e.clientY - p.y0) > TAP_SLOP) this.moved = true;
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
      this.onChange();
    });
    const up = (e: PointerEvent): void => {
      const had = this.pointers.delete(e.pointerId);
      if (had && e.type === "pointerup" && this.pointers.size === 0 && !this.moved && this.onTap) {
        const r = canvas.getBoundingClientRect();
        this.onTap(e.clientX - r.left, e.clientY - r.top);
      }
    };
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);
    canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        this.zoom = Math.max(0.2, Math.min(8, this.zoom * Math.exp(-e.deltaY * 0.001)));
        this.onChange();
      },
      { passive: false },
    );
  }

  private pinchDist(): number {
    const [a, b] = [...this.pointers.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  }

  /** The projection for a `w` x `h` canvas framing a sphere of `radius` around `ctr`. */
  projector(w: number, h: number, ctr: Vec3, radius: number): (p: Vec3) => Projected {
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw), cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const scale = (Math.min(w, h) / (2.4 * radius)) * this.zoom;
    return (p: Vec3): Projected => {
      const x = p[0] - ctr[0], y = p[1] - ctr[1], z = p[2] - ctr[2];
      const x1 = cy * x + sy * z, z1 = -sy * x + cy * z;
      const y2 = cp * y - sp * z1, z2 = sp * y + cp * z1;
      return { x: w / 2 + x1 * scale, y: h / 2 - y2 * scale, d: z2 };
    };
  }
}

/** Size a canvas's backing store to its CSS box at the device pixel ratio; the 2D context
 * with CSS-pixel coordinates, and the box. */
export function fitCanvas(c: HTMLCanvasElement): { g: CanvasRenderingContext2D; w: number; h: number } | null {
  const dpr = typeof devicePixelRatio === "number" ? devicePixelRatio : 1;
  const w = Math.max(1, c.clientWidth), h = Math.max(1, c.clientHeight);
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
  }
  const g = c.getContext("2d");
  if (!g) return null;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  return { g, w, h };
}

/** Bounds of `pts` (empty: null). */
export function bounds(pts: Vec3[]): { min: Vec3; max: Vec3; ctr: Vec3; radius: number } | null {
  if (pts.length === 0) return null;
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of pts)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, p[k]!);
      max[k] = Math.max(max[k]!, p[k]!);
    }
  const ctr: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const radius = Math.max(0.3, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2);
  return { min, max, ctr, radius };
}

/** A 0.5 m floor grid at height `fy` spanning `min`..`max` (plus a margin). */
export function drawFloorGrid(g: CanvasRenderingContext2D, proj: (p: Vec3) => Projected, min: Vec3, max: Vec3, fy: number, color: string): void {
  g.strokeStyle = color;
  g.globalAlpha = 0.25;
  g.lineWidth = 1;
  const step = 0.5;
  const gx0 = Math.floor((min[0] - 0.5) / step) * step, gx1 = Math.ceil((max[0] + 0.5) / step) * step;
  const gz0 = Math.floor((min[2] - 0.5) / step) * step, gz1 = Math.ceil((max[2] + 0.5) / step) * step;
  for (let x = gx0; x <= gx1 + 1e-9; x += step) line(g, proj([x, fy, gz0]), proj([x, fy, gz1]));
  for (let z = gz0; z <= gz1 + 1e-9; z += step) line(g, proj([gx0, fy, z]), proj([gx1, fy, z]));
  g.globalAlpha = 1;
}

/** Room axes at the origin (x red, y green, z blue), `len` m long. */
export function drawAxes(g: CanvasRenderingContext2D, proj: (p: Vec3) => Projected, len = 0.25): void {
  const o = proj([0, 0, 0]);
  for (const [v, col] of [
    [[len, 0, 0], "#e63946"],
    [[0, len, 0], "#2a9d8f"],
    [[0, 0, len], "#457b9d"],
  ] as [Vec3, string][]) {
    g.strokeStyle = col;
    g.lineWidth = 2;
    line(g, o, proj(v));
  }
}

export function line(g: CanvasRenderingContext2D, a: { x: number; y: number }, b: { x: number; y: number }): void {
  g.beginPath();
  g.moveTo(a.x, a.y);
  g.lineTo(b.x, b.y);
  g.stroke();
}
