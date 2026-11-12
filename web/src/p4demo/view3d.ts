/**
 * The P4 demo's 3D view: a dependency-free perspective line/point renderer on a 2D
 * canvas (like ui/mapview.ts — the web app carries no three.js). World is lhd's, +Z up.
 *
 * One finger drags to orbit, two fingers pinch to zoom (wheel on desktop), a double
 * tap re-centres on the lamp and stylus. Draws the floor grid, the base stations,
 * the stylus and its tip, the lamp's tracker (from /lh/pose), the plane or sphere,
 * and the hot spots.
 */

import type { LhStation, Vec3 } from "./lh/types";
import { add, cross, dot, mulMV, normalize, quatToMat, scale, sub, type Pose } from "./frames";
import { rgbToHex, type Mode, type Spot } from "./demo";

export interface Scene {
  stations: LhStation[];
  stylus: Pose | null;
  stylusOk: boolean;
  tip: Vec3 | null;
  hasTipCal: boolean;
  lamp: { pose: Pose; ok: boolean; fresh: boolean } | null;
  mode: Mode;
  plane: { n: Vec3; d: number };
  sphere: { c: Vec3; r: number };
  glow: Vec3;
  spots: Spot[];
  spotRadius: number;
  pivotPoint: Vec3 | null;
}

interface Cam {
  yaw: number;
  pitch: number;
  dist: number;
  target: Vec3;
}

export class View3D {
  private ctx: CanvasRenderingContext2D;
  private cam: Cam = { yaw: -0.9, pitch: 0.45, dist: 3.2, target: [0.2, 0, 0.8] };
  private userMoved = false;
  private scene: Scene | null = null;
  private raf = 0;
  private dirty = true;
  private w = 1;
  private h = 1;
  private dpr = 1;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
    this.attachInput();
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(canvas);
    this.resize();
    const loop = (): void => {
      if (this.dirty) this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
  }

  update(scene: Scene): void {
    this.scene = scene;
    if (!this.userMoved) this.autoTarget();
    this.dirty = true;
  }

  recentre(): void {
    this.userMoved = false;
    this.autoTarget();
    this.dirty = true;
  }

  private autoTarget(): void {
    const s = this.scene;
    if (!s) return;
    const pts: Vec3[] = [];
    if (s.lamp) pts.push(s.lamp.pose.t);
    if (s.tip) pts.push(s.tip);
    if (pts.length === 0) return;
    const c = scale(pts.reduce(add, [0, 0, 0] as Vec3), 1 / pts.length);
    // Ease towards it so the view doesn't jitter with the stylus.
    this.cam.target = add(this.cam.target, scale(sub(c, this.cam.target), 0.05));
  }

  private resize(): void {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = Math.max(1, r.width);
    this.h = Math.max(1, r.height);
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.dirty = true;
  }

  // ------------------------------------------------------------------ camera
  private eye(): Vec3 {
    const { yaw, pitch, dist, target } = this.cam;
    return add(target, [dist * Math.cos(pitch) * Math.cos(yaw), dist * Math.cos(pitch) * Math.sin(yaw), dist * Math.sin(pitch)]);
  }

  /** World point -> [x, y, depth] in CSS px, or null behind the camera. */
  private project(p: Vec3, basis: { e: Vec3; f: Vec3; r: Vec3; u: Vec3; fl: number }): [number, number, number] | null {
    const d = sub(p, basis.e);
    const z = dot(d, basis.f);
    if (z < 0.05) return null;
    return [this.w / 2 + (basis.fl * dot(d, basis.r)) / z, this.h / 2 - (basis.fl * dot(d, basis.u)) / z, z];
  }

  private basis(): { e: Vec3; f: Vec3; r: Vec3; u: Vec3; fl: number } {
    const e = this.eye();
    const f = normalize(sub(this.cam.target, e));
    const r = normalize(cross(f, [0, 0, 1]));
    const u = cross(r, f);
    const fl = (0.5 * Math.min(this.w, this.h * 1.2)) / Math.tan((50 * Math.PI) / 360);
    return { e, f, r, u, fl };
  }

  // ------------------------------------------------------------------ input
  private attachInput(): void {
    const c = this.canvas;
    const pts = new Map<number, { x: number; y: number }>();
    let pinch0 = 0;
    let dist0 = this.cam.dist;
    let lastTap = 0;
    c.style.touchAction = "none";
    c.addEventListener("pointerdown", (e) => {
      c.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch0 = Math.hypot(a!.x - b!.x, a!.y - b!.y);
        dist0 = this.cam.dist;
      }
      const now = performance.now();
      if (pts.size === 1 && now - lastTap < 300) this.recentre();
      lastTap = now;
    });
    c.addEventListener("pointermove", (e) => {
      const prev = pts.get(e.pointerId);
      if (!prev) return;
      const cur = { x: e.clientX, y: e.clientY };
      pts.set(e.pointerId, cur);
      if (pts.size === 1) {
        this.cam.yaw -= (cur.x - prev.x) * 0.008;
        this.cam.pitch = Math.min(1.5, Math.max(-0.2, this.cam.pitch + (cur.y - prev.y) * 0.008));
      } else if (pts.size === 2 && pinch0 > 0) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a!.x - b!.x, a!.y - b!.y);
        this.cam.dist = Math.min(12, Math.max(0.3, (dist0 * pinch0) / Math.max(d, 1)));
      }
      this.userMoved = true;
      this.dirty = true;
    });
    const up = (e: PointerEvent): void => {
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch0 = 0;
    };
    c.addEventListener("pointerup", up);
    c.addEventListener("pointercancel", up);
    c.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        this.cam.dist = Math.min(12, Math.max(0.3, this.cam.dist * Math.exp(e.deltaY * 0.001)));
        this.dirty = true;
      },
      { passive: false },
    );
  }

  // ------------------------------------------------------------------ drawing
  private draw(): void {
    this.dirty = false;
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const css = getComputedStyle(this.canvas);
    ctx.fillStyle = css.getPropertyValue("--p4-view-bg").trim() || "#0b0b0f";
    ctx.fillRect(0, 0, this.w, this.h);
    const B = this.basis();
    const P = (p: Vec3): [number, number, number] | null => this.project(p, B);
    const line = (a: Vec3, b: Vec3, color: string, width = 1): void => {
      const pa = P(a),
        pb = P(b);
      if (!pa || !pb) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(pa[0], pa[1]);
      ctx.lineTo(pb[0], pb[1]);
      ctx.stroke();
    };
    const poly = (ps: Vec3[], stroke: string, fill?: string, width = 1): void => {
      const q = ps.map(P);
      if (q.some((x) => !x)) return;
      ctx.beginPath();
      q.forEach((x, i) => (i ? ctx.lineTo(x![0], x![1]) : ctx.moveTo(x![0], x![1])));
      ctx.closePath();
      if (fill) {
        ctx.fillStyle = fill;
        ctx.fill();
      }
      ctx.strokeStyle = stroke;
      ctx.lineWidth = width;
      ctx.stroke();
    };
    const dotAt = (p: Vec3, r: number, color: string, label?: string): void => {
      const q = P(p);
      if (!q) return;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(q[0], q[1], r, 0, Math.PI * 2);
      ctx.fill();
      if (label) {
        ctx.font = "11px system-ui, sans-serif";
        ctx.fillStyle = "#c8c8d0";
        ctx.fillText(label, q[0] + r + 3, q[1] - r - 2);
      }
    };
    const circle = (c: Vec3, a: Vec3, b: Vec3, r: number, color: string, width = 1): void => {
      const ps: Vec3[] = [];
      for (let i = 0; i < 48; i++) {
        const t = (i / 48) * Math.PI * 2;
        ps.push(add(c, add(scale(a, r * Math.cos(t)), scale(b, r * Math.sin(t)))));
      }
      poly(ps, color, undefined, width);
    };
    const axes = (pose: Pose, len: number, alpha = 1): void => {
      const R = pose.R;
      const cols: Vec3[] = [
        [R[0], R[3], R[6]],
        [R[1], R[4], R[7]],
        [R[2], R[5], R[8]],
      ];
      const colors = [`rgba(242,85,90,${alpha})`, `rgba(55,200,113,${alpha})`, `rgba(91,124,250,${alpha})`];
      cols.forEach((c, i) => line(pose.t, add(pose.t, scale(c, len)), colors[i]!, 2));
    };

    // Floor grid (z = 0), 4 m, 0.5 m pitch, round the target.
    const gx = Math.round(this.cam.target[0] * 2) / 2,
      gy = Math.round(this.cam.target[1] * 2) / 2;
    for (let i = -4; i <= 4; i++) {
      const c = i === 0 ? "rgba(255,255,255,0.16)" : "rgba(255,255,255,0.07)";
      line([gx + i * 0.5, gy - 2, 0], [gx + i * 0.5, gy + 2, 0], c);
      line([gx - 2, gy + i * 0.5, 0], [gx + 2, gy + i * 0.5, 0], c);
    }
    axes({ R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] }, 0.25, 0.7);

    const s = this.scene;
    if (!s) return;

    // Base stations: a small frustum along each one's -Z.
    for (const st of s.stations) {
      const R = quatToMat(st.quat);
      const o = st.pos;
      const fwd = mulMV(R, [0, 0, -1]);
      const rr = mulMV(R, [1, 0, 0]);
      const uu = mulMV(R, [0, 1, 0]);
      const far = add(o, scale(fwd, 0.35));
      const corners = [
        [1, 1],
        [-1, 1],
        [-1, -1],
        [1, -1],
      ].map(([a, b]) => add(far, add(scale(rr, 0.2 * a!), scale(uu, 0.15 * b!))));
      for (const c of corners) line(o, c, "rgba(160,170,255,0.5)");
      poly(corners, "rgba(160,170,255,0.5)");
      line(o, [o[0], o[1], 0], "rgba(160,170,255,0.15)");
      dotAt(o, 4, "#a0aaff", `LH ${st.id}`);
    }

    // The shape.
    const glow = rgbToHex(s.glow);
    if (s.mode === "plane") {
      const n = normalize(s.plane.n);
      // Centre the drawn square where the plane meets the line from the lamp (or the
      // tip) along the normal.
      const ref = s.lamp?.pose.t ?? s.tip ?? this.cam.target;
      const c = sub(ref, scale(n, dot(n, ref) - s.plane.d));
      const a = normalize(Math.abs(n[2]) < 0.9 ? cross(n, [0, 0, 1]) : cross(n, [1, 0, 0]));
      const b = cross(n, a);
      const h = 0.35;
      poly(
        [add(c, add(scale(a, h), scale(b, h))), add(c, add(scale(a, -h), scale(b, h))), add(c, add(scale(a, -h), scale(b, -h))), add(c, add(scale(a, h), scale(b, -h)))],
        glow,
        `${glow}33`,
        1.5,
      );
      line(c, add(c, scale(n, 0.1)), glow, 2);
    } else if (s.mode === "sphere") {
      const c = s.sphere.c;
      circle(c, [1, 0, 0], [0, 1, 0], s.sphere.r, glow, 1.5);
      circle(c, [1, 0, 0], [0, 0, 1], s.sphere.r, glow, 1.5);
      circle(c, [0, 1, 0], [0, 0, 1], s.sphere.r, glow, 1.5);
    } else if (s.mode === "spots") {
      s.spots.forEach((sp, i) => {
        if (!sp.pos) return;
        const col = rgbToHex(sp.color);
        circle(sp.pos, [1, 0, 0], [0, 1, 0], s.spotRadius, col, 1.5);
        circle(sp.pos, [1, 0, 0], [0, 0, 1], s.spotRadius, col, 1);
        line(sp.pos, [sp.pos[0], sp.pos[1], 0], `${col}55`);
        dotAt(sp.pos, 5, col, `spot ${i + 1}`);
      });
    }

    // The lamp's tracker (/lh/pose): axes and a small body, dimmed when stale/lost.
    if (s.lamp) {
      const alpha = s.lamp.fresh ? 1 : 0.35;
      axes(s.lamp.pose, 0.12, alpha);
      const col = !s.lamp.fresh ? "#666" : s.lamp.ok ? "#37c871" : "#e3b341";
      dotAt(s.lamp.pose.t, 7, col, s.lamp.ok ? "lamp" : "lamp (not tracking)");
      line(s.lamp.pose.t, [s.lamp.pose.t[0], s.lamp.pose.t[1], 0], "rgba(55,200,113,0.25)");
    }

    // The stylus: tracker origin -> tip, and the tip ball.
    if (s.stylus) {
      const col = s.stylusOk ? "#5ab0ff" : "#555";
      axes(s.stylus, 0.05, s.stylusOk ? 0.8 : 0.3);
      if (s.tip) {
        line(s.stylus.t, s.tip, col, 3);
        dotAt(s.tip, s.hasTipCal ? 5 : 4, s.hasTipCal ? col : "#e3b341", s.hasTipCal ? undefined : "tip (uncalibrated)");
      }
    }
    if (s.pivotPoint) dotAt(s.pivotPoint, 6, "#ff8a3c", "pivot");
  }
}
