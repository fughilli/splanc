/**
 * Room preview for multi-fixture localization: every fixture's LEDs placed by
 * its room pose, one colour per fixture, a floor grid at the lowest LED, world
 * axes (+Y up), the solved camera path, and a highlighted selection for manual
 * nudging. Dependency-free 2D canvas painter (depth-sorted), drag to orbit,
 * wheel / pinch to zoom (ui/orbit.ts, shared with the mesh map's MeshTopoView).
 */

import type { Pose, Vec3 } from "@ledmapper/protocol";
import { applyRoomPose, type RoomPose } from "../geom/multiFixture";
import { Orbit, bounds, drawAxes, drawFloorGrid, fitCanvas } from "./orbit";

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
  private readonly orbit: Orbit;
  private raf = 0;
  private ro: ResizeObserver | null = null;

  constructor(cls = "room-view") {
    this.canvas = document.createElement("canvas");
    this.canvas.className = cls;
    this.orbit = new Orbit(this.canvas, () => this.kick());
    if (typeof ResizeObserver !== "undefined") {
      this.ro = new ResizeObserver(() => this.kick());
      this.ro.observe(this.canvas);
    }
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
    const fit = fitCanvas(c);
    if (!fit) return;
    const { g, w, h } = fit;
    const css = getComputedStyle(c);
    const fg = css.getPropertyValue("--text-dim").trim() || "#8a8f98";

    // World points (placed fixtures only) → bounds → view.
    const placed = this.fixtures.map((f) => (f.pose ? f.leds.map((p) => applyRoomPose(f.pose!, p)) : []));
    const all = placed.flat();
    const b = bounds(all);
    if (!b) {
      g.fillStyle = fg;
      g.font = "13px system-ui, sans-serif";
      g.textAlign = "center";
      g.fillText("No fixtures placed yet", w / 2, h / 2);
      return;
    }
    const { min, max, radius } = b;
    const proj = this.orbit.projector(w, h, b.ctr, radius);

    // Floor grid (0.5 m) at the lowest LED; axes at the room origin (the reference
    // fixture's frame).
    drawFloorGrid(g, proj, min, max, min[1], fg);
    drawAxes(g, proj);

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
