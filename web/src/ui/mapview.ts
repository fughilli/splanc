/**
 * M8 — result preview: a dependency-free 3D scatter of the reconstructed map
 * on a 2D canvas (depth-sorted painter's algorithm, colored by confidence).
 * A preview, not a CAD viewer — Sim Studio is the real inspection tool.
 *
 * Interactive (CAD-style, no inertia, mirroring Sim Studio's conventions):
 * one pointer drags to orbit, two-finger drag pans, pinch or wheel zooms,
 * mouse pan via shift/middle/right drag. Auto-orbits slowly until the first
 * interaction. Works both as the post-solve result browser and as the live
 * in-capture inset (`update()` swaps maps without resetting the camera).
 */

import type { OutputMap, Topology, Vec3 } from "@ledmapper/protocol";
import { applySimilarity, fitSimilarity, type Similarity } from "../geom/fit";

export interface TruthPoint {
  id: number;
  xyz: Vec3;
}

export class MapView {
  private raf = 0;
  private yaw = 0;
  private pitch = 0.35;
  private zoom = 1;
  private panX = 0;
  private panY = 0;
  private autoOrbit = true;
  private ac: AbortController | null = null;
  private readonly pointers = new Map<number, { x: number; y: number }>();

  // Ground-truth overlay: truth points are aligned to the solve via a
  // similarity fit (truth is only meaningful up to scale/rotation/translation)
  // and rendered with per-point delta vectors + magnitudes.
  private truth: TruthPoint[] | null = null;
  private fit: Similarity | null = null;
  private fitForMap: OutputMap | null = null;

  // Solved camera trajectory (visual-inertial solves) — same frame as the
  // LEDs; rendered as a polyline when toggled on.
  private trajectory: Vec3[] | null = null;
  showTrajectory = false;

  // Extracted topology overlay: the segment polylines drawn over the LEDs, for
  // live preview while tuning the extraction (topology/extract.ts).
  private topology: Topology | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private map: OutputMap,
  ) {}

  /** Swap in a newer map (live preview) without resetting the camera. */
  update(map: OutputMap): void {
    this.map = map;
  }

  /** Set (or clear) the ground-truth layout to compare against. */
  setTruth(points: TruthPoint[] | null): void {
    this.truth = points;
    this.fitForMap = null;
  }

  /** Set (or clear) the solved camera path (drawn when showTrajectory). */
  setTrajectory(path: Vec3[] | null): void {
    this.trajectory = path && path.length >= 2 ? path : null;
  }

  /** Set (or clear) the extracted topology to overlay (segment polylines). */
  setTopology(topology: Topology | null): void {
    this.topology = topology;
  }

  get hasTrajectory(): boolean {
    return this.trajectory !== null;
  }

  /** Re-fit the truth→solve similarity when the map instance changed. */
  private ensureFit(): void {
    if (this.truth === null || this.fitForMap === this.map) return;
    const byId = new Map(this.map.leds.map((l) => [l.id, l.xyz]));
    const src: Vec3[] = [];
    const dst: Vec3[] = [];
    for (const t of this.truth) {
      const s = byId.get(t.id);
      if (s !== undefined) {
        src.push(t.xyz);
        dst.push(s);
      }
    }
    this.fit = src.length >= 3 ? fitSimilarity(src, dst) : null;
    this.fitForMap = this.map;
  }

  start(): void {
    this.stop();
    this.attach();
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      if (this.autoOrbit) this.yaw += 0.005;
      this.draw();
    };
    loop();
  }

  stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.ac?.abort();
    this.ac = null;
    this.pointers.clear();
  }

  // -- input ------------------------------------------------------------

  private attach(): void {
    this.ac = new AbortController();
    const opts = { signal: this.ac.signal };
    const c = this.canvas;
    c.style.touchAction = "none"; // keep pinch/drag out of the browser's hands

    c.addEventListener(
      "pointerdown",
      (e) => {
        c.setPointerCapture(e.pointerId);
        this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        this.autoOrbit = false;
        e.preventDefault();
      },
      opts,
    );

    c.addEventListener(
      "pointermove",
      (e) => {
        const prev = this.pointers.get(e.pointerId);
        if (!prev) return;
        const cur = { x: e.clientX, y: e.clientY };
        // Pointer deltas are CSS px; pan/zoom work in canvas px.
        const s = c.clientWidth > 0 ? c.width / c.clientWidth : 1;

        if (this.pointers.size === 1) {
          const dx = cur.x - prev.x;
          const dy = cur.y - prev.y;
          const mousePan = e.pointerType === "mouse" && ((e.buttons & 6) !== 0 || e.shiftKey);
          if (mousePan) {
            this.panX += dx * s;
            this.panY += dy * s;
          } else {
            this.yaw += dx * 0.008;
            this.pitch = clamp(this.pitch + dy * 0.008, -1.55, 1.55);
          }
        } else if (this.pointers.size === 2) {
          const [a, b] = [...this.pointers.entries()].map(([id, p]) => ({
            prev: p,
            cur: id === e.pointerId ? cur : p,
          }));
          // Centroid delta → pan; distance ratio → zoom (both anchored on
          // this event's pointer only, so each move applies once).
          this.panX += ((a!.cur.x + b!.cur.x - a!.prev.x - b!.prev.x) / 2) * s;
          this.panY += ((a!.cur.y + b!.cur.y - a!.prev.y - b!.prev.y) / 2) * s;
          const dPrev = Math.hypot(a!.prev.x - b!.prev.x, a!.prev.y - b!.prev.y);
          const dCur = Math.hypot(a!.cur.x - b!.cur.x, a!.cur.y - b!.cur.y);
          if (dPrev > 1e-3) this.zoom = clamp(this.zoom * (dCur / dPrev), 0.05, 40);
        }
        this.pointers.set(e.pointerId, cur);
        e.preventDefault();
      },
      opts,
    );

    const drop = (e: PointerEvent) => this.pointers.delete(e.pointerId);
    c.addEventListener("pointerup", drop, opts);
    c.addEventListener("pointercancel", drop, opts);

    c.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        this.autoOrbit = false;
        this.zoom = clamp(this.zoom * Math.exp(-e.deltaY * 0.0015), 0.05, 40);
      },
      { signal: this.ac.signal, passive: false },
    );
    // Right-drag pans; keep the context menu off the viewport.
    c.addEventListener("contextmenu", (e) => e.preventDefault(), opts);
  }

  // -- rendering ----------------------------------------------------------

  private draw(): void {
    const ctx = this.canvas.getContext("2d")!;
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.fillStyle = "#111";
    ctx.fillRect(0, 0, w, h);
    const leds = this.map.leds;
    if (leds.length === 0) {
      ctx.fillStyle = "#888";
      ctx.font = "14px system-ui";
      ctx.fillText("no LEDs solved", 16, 24);
      return;
    }

    // Center + scale to fit (the camera path, when shown, is part of the
    // scene bounds — it extends meters beyond the fixture).
    const boundPts: Vec3[] = leds.map((l) => l.xyz);
    if (this.showTrajectory && this.trajectory !== null) boundPts.push(...this.trajectory);
    let cx = 0, cy = 0, cz = 0;
    for (const p of boundPts) {
      cx += p[0];
      cy += p[1];
      cz += p[2];
    }
    cx /= boundPts.length;
    cy /= boundPts.length;
    cz /= boundPts.length;
    let maxR = 1e-6;
    for (const p of boundPts) {
      const r = Math.hypot(p[0] - cx, p[1] - cy, p[2] - cz);
      if (r > maxR) maxR = r;
    }
    const scale = ((Math.min(w, h) * 0.42) / maxR) * this.zoom;

    const sinA = Math.sin(this.yaw);
    const cosA = Math.cos(this.yaw);
    const sinP = Math.sin(this.pitch);
    const cosP = Math.cos(this.pitch);
    // Orbit about the +Y (up) axis, then pitch about the view's x axis.
    const proj = (p: Vec3): { sx: number; sy: number; depth: number } => {
      const x = p[0] - cx;
      const y = p[1] - cy;
      const z = p[2] - cz;
      const rx = x * cosA + z * sinA;
      const rz = -x * sinA + z * cosA;
      const ty = y * cosP - rz * sinP;
      const tz = y * sinP + rz * cosP;
      return {
        sx: w / 2 + rx * scale + this.panX,
        sy: h / 2 - ty * scale + this.panY,
        depth: tz,
      };
    };

    // -- camera trajectory (under everything else: it is context, not data) --
    if (this.showTrajectory && this.trajectory !== null) {
      ctx.beginPath();
      for (let i = 0; i < this.trajectory.length; i++) {
        const s = proj(this.trajectory[i]!);
        if (i === 0) ctx.moveTo(s.sx, s.sy);
        else ctx.lineTo(s.sx, s.sy);
      }
      ctx.strokeStyle = "rgb(80 200 255 / 0.55)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      // Walk direction: hollow ring at the start, filled dot at the end.
      const first = proj(this.trajectory[0]!);
      const last = proj(this.trajectory[this.trajectory.length - 1]!);
      ctx.beginPath();
      ctx.arc(first.sx, first.sy, 4, 0, Math.PI * 2);
      ctx.strokeStyle = "rgb(80 200 255 / 0.8)";
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(last.sx, last.sy, 4, 0, Math.PI * 2);
      ctx.fillStyle = "rgb(80 200 255 / 0.9)";
      ctx.fill();
    }

    const pts = leds.map((l) => ({ ...proj(l.xyz), led: l }));
    pts.sort((a, b) => a.depth - b.depth);

    // -- ground truth: aligned points, delta vectors, magnitudes -----------
    this.ensureFit();
    let deltaSummary = "";
    if (this.truth !== null && this.fit !== null) {
      const byId = new Map(this.map.leds.map((l) => [l.id, l.xyz]));
      interface Pair {
        ts: { sx: number; sy: number };
        ss: { sx: number; sy: number } | null;
        distM: number;
      }
      const pairs: Pair[] = [];
      const dists: number[] = [];
      ctx.lineWidth = 1;
      for (const t of this.truth) {
        const tw = applySimilarity(this.fit, t.xyz);
        const ts = proj(tw);
        const solved = byId.get(t.id);
        if (solved === undefined) {
          // Unsolved LED: dim hollow marker shows what's missing.
          ctx.beginPath();
          ctx.arc(ts.sx, ts.sy, 4, 0, Math.PI * 2);
          ctx.strokeStyle = "rgb(255 255 255 / 0.25)";
          ctx.stroke();
          continue;
        }
        const distM = Math.hypot(tw[0] - solved[0], tw[1] - solved[1], tw[2] - solved[2]);
        pairs.push({ ts, ss: proj(solved), distM });
        dists.push(distM);
      }

      // Delta vectors truth → solved, then truth markers on top.
      ctx.strokeStyle = "rgb(255 160 40 / 0.9)";
      for (const p of pairs) {
        if (!p.ss) continue;
        ctx.beginPath();
        ctx.moveTo(p.ts.sx, p.ts.sy);
        ctx.lineTo(p.ss.sx, p.ss.sy);
        ctx.stroke();
      }
      ctx.strokeStyle = "rgb(255 255 255 / 0.85)";
      for (const p of pairs) {
        ctx.beginPath();
        ctx.arc(p.ts.sx, p.ts.sy, 4, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Magnitude labels: all of them for small fixtures, the worst ones
      // for big fixtures (labels would otherwise shingle).
      const labeled =
        pairs.length <= 16 ? pairs : [...pairs].sort((a, b) => b.distM - a.distM).slice(0, 8);
      ctx.font = "11px system-ui";
      ctx.fillStyle = "rgb(255 200 120 / 0.95)";
      for (const p of labeled) {
        if (!p.ss) continue;
        const mm = p.distM * 1000;
        const label = mm >= 100 ? `${(mm / 10).toFixed(0)}cm` : `${mm.toFixed(mm < 10 ? 1 : 0)}mm`;
        ctx.fillText(label, (p.ts.sx + p.ss.sx) / 2 + 5, (p.ts.sy + p.ss.sy) / 2 - 4);
      }

      if (dists.length > 0) {
        const rms = Math.sqrt(dists.reduce((a, d) => a + d * d, 0) / dists.length) * 1000;
        const max = Math.max(...dists) * 1000;
        deltaSummary = ` · Δtruth rms ${rms.toFixed(1)}mm max ${max.toFixed(1)}mm (${dists.length} pts)`;
      }
    } else if (this.truth !== null) {
      deltaSummary = " · Δtruth: needs ≥3 solved ids";
    }

    for (const p of pts) {
      const c = p.led.confidence;
      const r = 2.5 + 2 * c;
      ctx.beginPath();
      ctx.arc(p.sx, p.sy, r, 0, Math.PI * 2);
      // Confidence: green (high) -> amber -> red (low).
      const hue = Math.round(c * 120);
      ctx.fillStyle = `hsl(${hue} 90% 50%)`;
      ctx.fill();
    }

    // -- topology overlay: the extracted skeleton polylines over the LEDs -----
    if (this.topology !== null) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = "rgb(80 220 255 / 0.9)";
      for (const seg of this.topology.segments) {
        if (seg.polyline.length < 2) continue;
        ctx.beginPath();
        for (let i = 0; i < seg.polyline.length; i++) {
          const s = proj(seg.polyline[i]!);
          if (i === 0) ctx.moveTo(s.sx, s.sy);
          else ctx.lineTo(s.sx, s.sy);
        }
        ctx.stroke();
        // Small ring at each polyline vertex (the decimated waypoints).
        ctx.fillStyle = "rgb(80 220 255 / 0.9)";
        for (const v of seg.polyline) {
          const s = proj(v);
          ctx.beginPath();
          ctx.arc(s.sx, s.sy, 2.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      // Junctions (branch points) as distinct magenta rings.
      ctx.strokeStyle = "rgb(255 90 220 / 0.95)";
      ctx.lineWidth = 2;
      for (const bp of this.topology.branchPoints) {
        const s = proj(bp.xyz);
        ctx.beginPath();
        ctx.arc(s.sx, s.sy, 6, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    ctx.fillStyle = "#aaa";
    ctx.font = "12px system-ui";
    const s = this.map.stats;
    ctx.fillText(
      `${leds.length}/${this.map.ledCount} solved · rms ${s.rmsReprojPxGlobal.toFixed(2)} px · ` +
        `median parallax ${s.medianParallaxDeg.toFixed(1)}°${deltaSummary}`,
      12,
      h - 12,
    );
    ctx.fillStyle = "#666";
    ctx.fillText("drag orbit · 2-finger pan · pinch/scroll zoom", 12, 18);
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
