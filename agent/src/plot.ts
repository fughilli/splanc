/**
 * The 3D fixture plot behind plot_fixture: a fixture's (or a room's) LED map drawn
 * from four views in one PNG — front (from +z), side (from +x), top (from +y) and
 * an isometric view — with +y up, axis gizmos, the bounding box, the wiring order
 * as a faint polyline, LED index hints, a scale bar and a legend. Mapped LEDs are
 * filled discs, interpolated (unmapped) ones hollow rings.
 *
 * Pure TypeScript: a tiny RGBA rasteriser (anti-aliased discs, alpha lines, the
 * 5x7 font in font.ts) and png.ts's encoder (node:zlib), so it runs headless on
 * the Pi bridge with no native modules. Deterministic: the same scene renders the
 * same bytes.
 */

import { ADVANCE, GLYPH_H, GLYPH_W, glyph, textWidth } from "./font";
import { encodePng } from "./png";

export type RGB = [number, number, number];
export type Vec3 = [number, number, number];

export interface PlotPoint {
  /** Position, metres, +y up (the map / room frame). */
  xyz: Vec3;
  color: RGB;
  /** False: the solve didn't place it (interpolated position) — drawn hollow. */
  mapped: boolean;
  /** Output index within its fixture (the label). */
  index: number;
  /** Which fixture (index into `fixtures`). */
  fixture: number;
  /** Consecutive points of one chain are joined by the wiring polyline. */
  chain: number;
}

export interface PlotOptions {
  /** Image width in px (the four panels are size/2 each); 256..1024, default 768. */
  size?: number;
  /** Draw LED index hints (default true). */
  labels?: boolean;
  title: string;
  subtitle?: string;
  legend?: { color: RGB; label: string }[];
  /** Fixture names, drawn at each fixture's top in the panels (several fixtures). */
  fixtures?: string[];
  /** Colours may be black (an effect frame): outline every LED so it stays visible. */
  outline?: boolean;
}

export interface PlotView {
  name: string;
  /** Screen-right and screen-up directions in the scene frame. */
  right: Vec3;
  up: Vec3;
}

/** The four views, right-handed, +y up. "toward" = the side the camera looks from. */
export const VIEWS: readonly (PlotView & { title: string; toward: Vec3 })[] = [
  { name: "front", title: "FRONT (FROM +Z)", right: [1, 0, 0], up: [0, 1, 0], toward: [0, 0, 1] },
  { name: "side", title: "SIDE (FROM +X)", right: [0, 0, -1], up: [0, 1, 0], toward: [1, 0, 0] },
  { name: "top", title: "TOP (FROM +Y)", right: [1, 0, 0], up: [0, 0, -1], toward: [0, 1, 0] },
  {
    name: "iso",
    title: "ISO (FROM +X+Y+Z)",
    right: [Math.SQRT1_2, 0, -Math.SQRT1_2],
    up: [-1 / Math.sqrt(6), 2 / Math.sqrt(6), -1 / Math.sqrt(6)],
    toward: [1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3)],
  },
];

const BG: RGB = [18, 19, 24];
const PANEL_BG: RGB = [24, 26, 33];
const FG: RGB = [225, 228, 235];
const DIM: RGB = [120, 126, 140];
const AXIS: Record<"x" | "y" | "z", RGB> = { x: [235, 87, 87], y: [93, 202, 109], z: [86, 145, 240] };

/** An RGBA raster with alpha-blended primitives. */
export class Raster {
  readonly px: Uint8Array;
  constructor(
    readonly width: number,
    readonly height: number,
    bg: RGB = BG,
  ) {
    this.px = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) this.px.set([bg[0], bg[1], bg[2], 255], i * 4);
  }

  blend(x: number, y: number, c: RGB, a: number): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height || a <= 0) return;
    const o = (y * this.width + x) * 4;
    const k = Math.min(1, a);
    for (let i = 0; i < 3; i++) this.px[o + i] = Math.round(this.px[o + i]! + (c[i]! - this.px[o + i]!) * k);
  }

  rect(x: number, y: number, w: number, h: number, c: RGB, a = 1): void {
    for (let yy = Math.max(0, y); yy < Math.min(this.height, y + h); yy++)
      for (let xx = Math.max(0, x); xx < Math.min(this.width, x + w); xx++) this.blend(xx, yy, c, a);
  }

  /** A 1-px line (DDA, alpha). Dashed when `dash` > 0 (on/off run length). */
  line(x0: number, y0: number, x1: number, y1: number, c: RGB, a = 1, dash = 0): void {
    const n = Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)));
    for (let i = 0; i <= n; i++) {
      if (dash > 0 && Math.floor(i / dash) % 2 === 1) continue;
      const t = n === 0 ? 0 : i / n;
      this.blend(Math.round(x0 + (x1 - x0) * t), Math.round(y0 + (y1 - y0) * t), c, a);
    }
  }

  /** Anti-aliased filled disc. */
  disc(cx: number, cy: number, r: number, c: RGB, a = 1): void {
    for (let y = Math.floor(cy - r - 1); y <= Math.ceil(cy + r + 1); y++)
      for (let x = Math.floor(cx - r - 1); x <= Math.ceil(cx + r + 1); x++) {
        const d = Math.hypot(x - cx, y - cy);
        const cov = Math.min(1, Math.max(0, r + 0.5 - d));
        if (cov > 0) this.blend(x, y, c, cov * a);
      }
  }

  /** Anti-aliased ring of width `w`. */
  ring(cx: number, cy: number, r: number, w: number, c: RGB, a = 1): void {
    for (let y = Math.floor(cy - r - 1); y <= Math.ceil(cy + r + 1); y++)
      for (let x = Math.floor(cx - r - 1); x <= Math.ceil(cx + r + 1); x++) {
        const d = Math.hypot(x - cx, y - cy);
        const cov = Math.min(1, Math.max(0, r + 0.5 - d)) * Math.min(1, Math.max(0, d - (r - w) + 0.5));
        if (cov > 0) this.blend(x, y, c, cov * a);
      }
  }

  /** Text at (x, y) = top-left, 5x7 glyphs scaled by `scale`; returns the width. */
  text(x: number, y: number, s: string, c: RGB, scale = 1, a = 1): number {
    let cx = Math.round(x);
    const top = Math.round(y);
    for (const ch of s) {
      const rows = glyph(ch);
      for (let r = 0; r < GLYPH_H; r++)
        for (let col = 0; col < GLYPH_W; col++) {
          if (!((rows[r]! >> (GLYPH_W - 1 - col)) & 1)) continue;
          for (let dy = 0; dy < scale; dy++)
            for (let dx = 0; dx < scale; dx++) this.blend(cx + col * scale + dx, top + r * scale + dy, c, a);
        }
      cx += ADVANCE * scale;
    }
    return textWidth(s, scale);
  }

  /** Text with a dark halo (readable over LEDs and lines). */
  label(x: number, y: number, s: string, c: RGB, scale = 1): void {
    for (const [dx, dy] of [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ] as const)
      this.text(x + dx, y + dy, s, BG, scale, 0.85);
    this.text(x, y, s, c, scale);
  }

  png(): Buffer {
    return encodePng(this.width, this.height, this.px);
  }
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** A "nice" scale-bar length (m) near `target`. */
function niceLength(target: number): number {
  const steps = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50];
  let best = steps[0]!;
  for (const s of steps) if (s <= target) best = s;
  return best;
}

function lengthLabel(m: number): string {
  if (m >= 1) return `${m} M`;
  if (m >= 0.01) return `${Math.round(m * 100)} CM`;
  return `${Math.round(m * 1000)} MM`;
}

/** Index-hint step: label every k-th LED so a fixture gets at most ~`max` labels. */
export function labelStep(n: number, max = 14): number {
  for (const k of [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000]) if (n / k <= max) return k;
  return Math.ceil(n / max);
}

export interface PlotResult {
  png: Buffer;
  width: number;
  height: number;
  /** Shared panel scale, px per metre. */
  px_per_m: number;
}

/** Render the four-view plot. */
export function plotScene(points: PlotPoint[], opts: PlotOptions): PlotResult {
  const width = Math.max(256, Math.min(1024, Math.round(opts.size ?? 768)));
  const panel = Math.floor(width / 2);
  const headerH = opts.subtitle ? 40 : 26;
  const legendH = opts.legend?.length ? 16 : 0;
  const height = headerH + panel * 2 + legendH;
  const img = new Raster(width, height);

  // Header.
  img.text(8, 6, clip(opts.title, Math.floor((width - 16) / (ADVANCE * 2))), FG, 2);
  if (opts.subtitle) img.text(8, 26, clip(opts.subtitle, Math.floor((width - 16) / ADVANCE)), DIM, 1);

  // The scene box (shared by every view), and one scale for all panels so the
  // orthographic views compare 1:1.
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of points)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, p.xyz[k]!);
      max[k] = Math.max(max[k]!, p.xyz[k]!);
    }
  if (points.length === 0) {
    min.fill(-0.5);
    max.fill(0.5);
  }
  const corners: Vec3[] = [];
  for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) corners.push([x, y, z]);
  const pad = 26;
  const titleH = 14;
  const avail = panel - 2 * pad;
  let scale = Infinity;
  for (const v of VIEWS) {
    const xs = corners.map((c) => dot(c, v.right));
    const ys = corners.map((c) => dot(c, v.up));
    const ex = Math.max(...xs) - Math.min(...xs);
    const ey = Math.max(...ys) - Math.min(...ys);
    scale = Math.min(scale, avail / Math.max(ex, 1e-6), (avail - titleH) / Math.max(ey, 1e-6));
  }
  if (!Number.isFinite(scale)) scale = avail;
  const n = points.length;
  const r = Math.max(1.6, Math.min(6, (avail / Math.sqrt(Math.max(n, 1))) * 0.18));
  const showLabels = opts.labels ?? true;
  const perFixture = new Map<number, number>();
  for (const p of points) perFixture.set(p.fixture, Math.max(perFixture.get(p.fixture) ?? 0, p.index + 1));

  VIEWS.forEach((v, vi) => {
    const ox = (vi % 2) * panel;
    const oy = headerH + Math.floor(vi / 2) * panel;
    img.rect(ox + 2, oy + 2, panel - 4, panel - 4, PANEL_BG);
    img.text(ox + 8, oy + 8, v.title, FG);
    // Centre the scene box in the panel.
    const xs = corners.map((c) => dot(c, v.right));
    const ys = corners.map((c) => dot(c, v.up));
    const cx = (Math.max(...xs) + Math.min(...xs)) / 2;
    const cy = (Math.max(...ys) + Math.min(...ys)) / 2;
    const mx = ox + panel / 2;
    const my = oy + titleH + (panel - titleH) / 2;
    const proj = (p: Vec3): [number, number] => [mx + (dot(p, v.right) - cx) * scale, my - (dot(p, v.up) - cy) * scale];

    // Bounding box wireframe.
    for (let a = 0; a < 8; a++)
      for (let b = a + 1; b < 8; b++) {
        const diff = (a ^ b) & 7;
        if (diff !== 1 && diff !== 2 && diff !== 4) continue;
        const [x0, y0] = proj(corners[a]!);
        const [x1, y1] = proj(corners[b]!);
        img.line(x0, y0, x1, y1, DIM, 0.35, 3);
      }

    // Wiring order: consecutive LEDs of a chain.
    for (let i = 1; i < n; i++) {
      const p = points[i - 1]!;
      const q = points[i]!;
      if (p.chain !== q.chain) continue;
      const [x0, y0] = proj(p.xyz);
      const [x1, y1] = proj(q.xyz);
      img.line(x0, y0, x1, y1, DIM, 0.4);
    }

    // LEDs, far to near, with a mild depth cue.
    const depth = points.map((p) => dot(p.xyz, v.toward));
    const dMin = Math.min(...depth);
    const dSpan = Math.max(1e-9, Math.max(...depth) - dMin);
    const order = points.map((_, i) => i).sort((a, b) => depth[a]! - depth[b]! || a - b);
    for (const i of order) {
      const p = points[i]!;
      const [x, y] = proj(p.xyz);
      const near = 0.65 + 0.35 * ((depth[i]! - dMin) / dSpan);
      const c: RGB = [p.color[0] * near, p.color[1] * near, p.color[2] * near];
      if (p.mapped) {
        img.disc(x, y, r, c);
        if (opts.outline) img.ring(x, y, r + 1, 1, DIM, 0.7);
      } else {
        img.ring(x, y, r + 0.5, Math.max(1, r * 0.45), opts.outline ? DIM : c);
      }
    }

    // Labels never overlap: each takes the first free spot around its anchor, or
    // is dropped (LEDs stacked in this view — another view shows them apart).
    const taken: [number, number, number, number][] = [];
    const place = (cands: [number, number][], text: string, c: RGB): boolean => {
      const w = textWidth(text) + 2;
      for (const [x, y] of cands) {
        const box: [number, number, number, number] = [x - 1, y - 1, x + w, y + GLYPH_H + 1];
        if (box[0] < ox + 3 || box[2] > ox + panel - 3 || box[1] < oy + titleH + 2 || box[3] > oy + panel - 3) continue;
        if (taken.some((t) => box[0] < t[2] && t[0] < box[2] && box[1] < t[3] && t[1] < box[3])) continue;
        taken.push(box);
        img.label(x, y, text, c);
        return true;
      }
      return false;
    };

    // Fixture names (several fixtures): above each fixture's top-most LED.
    if (opts.fixtures && opts.fixtures.length > 1) {
      opts.fixtures.forEach((name, f) => {
        const mine = points.filter((p) => p.fixture === f);
        if (mine.length === 0) return;
        const pr = mine.map((p) => proj(p.xyz));
        const top = Math.min(...pr.map((q) => q[1]));
        const left = Math.min(...pr.map((q) => q[0]));
        const bottom = Math.max(...pr.map((q) => q[1]));
        const t = clip(name, 18);
        place(
          [
            [left, top - r - 12],
            [left, bottom + r + 4],
            [left - textWidth(t) - r - 4, top],
          ],
          t,
          [255, 214, 102],
        );
      });
    }

    // Index hints: the first and last LED of each fixture first, then every k-th.
    if (showLabels) {
      const want = points.filter((p) => {
        const count = perFixture.get(p.fixture) ?? 1;
        return p.index % labelStep(count) === 0 || p.index === count - 1;
      });
      const ends = (p: PlotPoint) => p.index === 0 || p.index === (perFixture.get(p.fixture) ?? 1) - 1;
      for (const p of [...want.filter(ends), ...want.filter((q) => !ends(q))]) {
        const [x, y] = proj(p.xyz);
        const t = String(p.index);
        const tw = textWidth(t);
        place(
          [
            [x + r + 2, y - r - 7],
            [x + r + 2, y + r],
            [x - r - 2 - tw, y - r - 7],
            [x - r - 2 - tw, y + r],
          ],
          t,
          FG,
        );
      }
    }

    // Axis gizmo (bottom-left).
    const gx = ox + 22;
    const gy = oy + panel - 22;
    for (const [axis, dir] of [
      ["x", [1, 0, 0]],
      ["z", [0, 0, 1]],
      ["y", [0, 1, 0]],
    ] as const) {
      const sx = dot(dir as Vec3, v.right);
      const sy = dot(dir as Vec3, v.up);
      const len = 16;
      if (Math.hypot(sx, sy) < 0.2) {
        // Pointing at (or away from) the camera: a dot / cross at the origin.
        const toward = dot(dir as Vec3, v.toward) > 0;
        img.ring(gx, gy, 3, 1, AXIS[axis]);
        if (toward) img.disc(gx, gy, 1, AXIS[axis]);
        // Below-left of the origin, clear of the in-plane axis labels.
        img.text(gx - 14, gy + 6, `${toward ? "+" : "-"}${axis.toUpperCase()}`, AXIS[axis]);
        continue;
      }
      const ex = gx + sx * len;
      const ey = gy - sy * len;
      img.line(gx, gy, ex, ey, AXIS[axis]);
      img.line(gx + 1, gy, ex + 1, ey, AXIS[axis], 0.6);
      const lbl = axis === "y" ? "+Y UP" : `+${axis.toUpperCase()}`;
      img.text(ex + (sx >= 0 ? 3 : -textWidth(lbl) - 3), ey - (sy > 0.3 ? 9 : 3), lbl, AXIS[axis]);
    }

    // Scale bar (bottom-right).
    const bar = niceLength(avail / 4 / scale);
    const bl = bar * scale;
    const bx1 = ox + panel - 12;
    const by = oy + panel - 14;
    img.line(bx1 - bl, by, bx1, by, FG);
    img.line(bx1 - bl, by - 3, bx1 - bl, by + 1, FG);
    img.line(bx1, by - 3, bx1, by + 1, FG);
    const bt = lengthLabel(bar);
    img.text(bx1 - bl / 2 - textWidth(bt) / 2, by - 11, bt, FG);
  });

  // Legend.
  if (opts.legend?.length) {
    let x = 8;
    const y = headerH + panel * 2 + 4;
    for (const e of opts.legend) {
      if (x > width - 40) break;
      img.disc(x + 4, y + 3.5, 3.5, e.color);
      x += 12;
      x += img.text(x, y, clip(e.label, 24), FG) + 12;
    }
  }
  return { png: img.png(), width, height, px_per_m: +scale.toFixed(2) };
}

function clip(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1))}*`;
}

// -- colours -------------------------------------------------------------------------

export function hsv(h: number, s: number, v: number): RGB {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  const [r, g, b] = [
    [v, t, p],
    [q, v, p],
    [p, v, t],
    [p, q, v],
    [t, p, v],
    [v, p, q],
  ][((i % 6) + 6) % 6]!;
  return [Math.round(r! * 255), Math.round(g! * 255), Math.round(b! * 255)];
}

/** Rainbow by position along 0..1 (red -> violet). */
export const ramp = (t: number): RGB => hsv(0.8 * Math.min(1, Math.max(0, t)), 0.85, 1);

/** Red (0) -> yellow -> green (1). */
export const confidenceColor = (c: number): RGB => hsv((Math.min(1, Math.max(0, c)) * 1) / 3, 0.85, 1);

const PALETTE: RGB[] = [
  [76, 159, 255],
  [255, 145, 64],
  [94, 214, 120],
  [235, 92, 120],
  [180, 130, 255],
  [255, 214, 90],
  [64, 214, 214],
  [214, 120, 214],
  [160, 200, 90],
  [255, 170, 170],
];

/** A categorical colour for id `k` (k < 0: grey = "none"). */
export function category(k: number): RGB {
  if (k < 0) return [140, 140, 150];
  return PALETTE[k % PALETTE.length]!;
}
