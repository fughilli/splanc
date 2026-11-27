/**
 * The mat3 / mat4 uniform gizmo (D-541 PR 10): a canvas with translate arrows,
 * rotate rings and a uniform-scale ring around the transform's pivot, over a
 * small 3D (or, for a `: transform2d` mat3, flat 2D) scene showing the
 * transformed unit cube / square and its local axes.
 *
 * What a matrix means (D-556): a mat4 is a full 3D transform; a plain mat3 a
 * 3D rotation / linear transform (Rotate and Scale only, pivot at the origin);
 * a mat3 `: transform2d` a 2D affine (Move x/y, Rotate about z, Scale).
 *
 * - Drags stream floats through `onInput` on every move; `onCommit` fires once
 *   when the gesture (a drag, a typed field, a key nudge) ends.
 * - A drag LEFT-multiplies a delta onto the matrix as it was when the drag
 *   started (geom/trs.ts `applyDelta`), so shear, non-uniform scale or a
 *   projective row survive a move / turn / scale.
 * - Drag on empty canvas orbits the 3D view (the value does not change).
 * - Move / Rotate / Scale are separate, spaced buttons (never on-canvas chips).
 *
 * The scene painter (`drawMatScene`, `matProjector`) has no widget state, so
 * the Watch pane's mat4 view (D-541 PR 12) reuses it with `mode: null` (no
 * handles) and a `trail` of past pivots.
 *
 * `MatSwatch` wraps the gizmo for the uniform panel: a button showing the TRS
 * summary that opens the gizmo in a full-height Sheet on phones and a popover
 * on desktop.
 */

import type { Vec3 } from "@ledmapper/protocol";
import { mul4, projectPoint } from "../../geom/mat4";
import {
  aboutPivot,
  applyDelta,
  axisAngle,
  compose,
  decompose,
  pivotOf,
  toMat4,
  translation,
  trsSummary,
  uniformScale,
  type MatKind,
  type V3,
} from "../../geom/trs";
import { drawAxes, fitCanvas, line, type Projected } from "../orbit";
import { Sheet } from "./index";
import { prefersSheet } from "./vectorPicker";

export type GizmoMode = "move" | "rotate" | "scale";
/** Translate along x/y/z, free in the view plane (`tv`); rotate about x/y/z;
 * uniform scale. */
export type HandleId = "tx" | "ty" | "tz" | "tv" | "rx" | "ry" | "rz" | "s";

export interface MatCamera {
  yaw: number;
  pitch: number;
  /** World radius the view frames. */
  radius: number;
}

export interface MatPalette {
  bg: string;
  grid: string;
  axis: string;
  text: string;
  accent: string;
  x: string;
  y: string;
  z: string;
}

export interface MatScene {
  kind: MatKind;
  /** The uniform's matrix (its own layout: 9 or 16 floats, column-major). */
  m: readonly number[];
  cam: MatCamera;
  /** Whose handles to draw; null = none (a read-only view such as Watch). */
  mode: GizmoMode | null;
  /** The handle under the pointer / being dragged (drawn bold). */
  hot?: HandleId | null;
  /** Past pivots, oldest first (Watch draws the path the transform took). */
  trail?: readonly V3[];
  /** A thumbnail: no grid, no labels, no handles. */
  mini?: boolean;
  palette: MatPalette;
}

/** Screen geometry of one handle, for hit tests (CSS px). */
export interface HandleGeom {
  id: HandleId;
  /** A polyline (closed for a ring) or, with one point, a disc of radius `r`. */
  pts: { x: number; y: number }[];
  closed: boolean;
  r?: number;
}

export interface SceneLayout {
  proj: (p: readonly number[]) => Projected;
  pivot: Projected;
  /** World length of the handle arms. */
  arm: number;
  handles: HandleGeom[];
}

const AXES: [V3, "x" | "y" | "z"][] = [
  [[1, 0, 0], "x"],
  [[0, 1, 0], "y"],
  [[0, 0, 1], "z"],
];

function add3(a: readonly number[], b: readonly number[], k = 1): V3 {
  return [a[0]! + b[0]! * k, a[1]! + b[1]! * k, a[2]! + b[2]! * k];
}

/** The camera's world right / up unit vectors (the orbit of ui/orbit.ts). */
export function viewBasis(cam: MatCamera): { right: V3; up: V3; toward: V3 } {
  const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw), cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
  return { right: [cy, 0, sy], up: [sp * sy, cp, -sp * cy], toward: [-cp * sy, sp, cp * cy] };
}

/**
 * World -> canvas for a `w`×`h` canvas: a perspective orbit view (+Y up, the
 * same yaw / pitch convention as ui/orbit.ts) through geom/mat4's
 * `projectPoint`, or a flat top-down view of the xy plane for a 2D affine.
 */
export function matProjector(kind: MatKind, cam: MatCamera, w: number, h: number): (p: readonly number[]) => Projected {
  const R = Math.max(1e-6, cam.radius);
  if (kind === "affine2d") {
    const k = Math.min(w, h) / (2.3 * R);
    return (p) => ({ x: w / 2 + p[0]! * k, y: h / 2 - p[1]! * k, d: p[2] ?? 0 });
  }
  const { right, up, toward } = viewBasis(cam);
  const dist = R * 3.2;
  const V = [
    right[0], up[0], toward[0], 0,
    right[1], up[1], toward[1], 0,
    right[2], up[2], toward[2], 0,
    0, 0, -dist, 1,
  ];
  const f = 2.55; // ~43° vertical field of view: the radius fills ~80%.
  const aspect = w / Math.max(1, h);
  const near = R * 0.05, far = R * 10;
  const P = new Array<number>(16).fill(0);
  // Fit the shorter side.
  P[0] = aspect >= 1 ? f / aspect : f;
  P[5] = aspect >= 1 ? f : f * aspect;
  P[10] = -(far + near) / (far - near);
  P[11] = -1;
  P[14] = (-2 * far * near) / (far - near);
  const mvp = mul4(P, V);
  return (p) => {
    const q = projectPoint(mvp, p[0]!, p[1]!, p[2] ?? 0);
    if (!q) return { x: w / 2, y: h / 2, d: -Infinity };
    return { x: w / 2 + (q.x * w) / 2, y: h / 2 - (q.y * h) / 2, d: -q.z };
  };
}

/** A view radius that frames the transform (its pivot plus the unit cube it
 * moves) and the world origin. */
export function frameRadius(kind: MatKind, m: readonly number[]): number {
  const m4 = toMat4(kind, m);
  const piv = pivotOf(kind, m);
  let ext = 0;
  for (let c = 0; c < 3; c++) ext = Math.max(ext, Math.hypot(m4[c * 4]!, m4[c * 4 + 1]!, m4[c * 4 + 2]!));
  const r = Math.hypot(...piv) + Math.max(0.6, ext * 0.9);
  return Math.max(1.2, Math.min(1e4, r * 1.1));
}

/** Map a point through a mat4 (column-major), with the w divide. */
function xform(m4: readonly number[], p: readonly number[]): V3 {
  const [x, y, z] = [p[0]!, p[1]!, p[2] ?? 0];
  const w = m4[3]! * x + m4[7]! * y + m4[11]! * z + m4[15]!;
  const iw = Math.abs(w) > 1e-9 ? 1 / w : 1;
  return [
    (m4[0]! * x + m4[4]! * y + m4[8]! * z + m4[12]!) * iw,
    (m4[1]! * x + m4[5]! * y + m4[9]! * z + m4[13]!) * iw,
    (m4[2]! * x + m4[6]! * y + m4[10]! * z + m4[14]!) * iw,
  ];
}

/** The handles a mode offers for a matrix kind. */
export function handlesFor(kind: MatKind, mode: GizmoMode): HandleId[] {
  if (mode === "scale") return ["s"];
  if (mode === "rotate") return kind === "affine2d" ? ["rz"] : ["rx", "ry", "rz"];
  if (kind === "mat3") return [];
  return kind === "affine2d" ? ["tv", "tx", "ty"] : ["tv", "tx", "ty", "tz"];
}

/** The modes a matrix kind has (a mat3 is linear: no Move). */
export function modesFor(kind: MatKind): GizmoMode[] {
  return kind === "mat3" ? ["rotate", "scale"] : ["move", "rotate", "scale"];
}

/** A ring of `n` world points of radius `r` about `axis` through `c`. */
function ring(c: V3, axis: V3, r: number, n = 64): V3[] {
  const a = Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  // u = normalize(a × axis), v = axis × u
  let u: V3 = [a[1]! * axis[2] - a[2]! * axis[1], a[2]! * axis[0] - a[0]! * axis[2], a[0]! * axis[1] - a[1]! * axis[0]];
  const ul = Math.hypot(...u) || 1;
  u = u.map((x) => x / ul) as V3;
  const v: V3 = [axis[1] * u[2] - axis[2] * u[1], axis[2] * u[0] - axis[0] * u[2], axis[0] * u[1] - axis[1] * u[0]];
  return Array.from({ length: n }, (_, k) => {
    const t = (k / n) * Math.PI * 2;
    return add3(add3(c, u, r * Math.cos(t)), v, r * Math.sin(t));
  });
}

/** Lay out the scene: the projector, the pivot on screen, and every handle of
 * `mode` (none when `mode` is null). Pure: the widget and tests share it. */
export function layoutScene(scene: Omit<MatScene, "palette">, w: number, h: number): SceneLayout {
  const proj = matProjector(scene.kind, scene.cam, w, h);
  const piv = pivotOf(scene.kind, scene.m);
  const P0 = proj(piv);
  const arm = scene.cam.radius * 0.5;
  const handles: HandleGeom[] = [];
  if (scene.mode && !scene.mini) {
    const flat = scene.kind === "affine2d";
    const { right } = viewBasis(scene.cam);
    for (const id of handlesFor(scene.kind, scene.mode)) {
      if (id === "tv") {
        handles.push({ id, pts: [{ x: P0.x, y: P0.y }], closed: false, r: 13 });
      } else if (id === "tx" || id === "ty" || id === "tz") {
        const ax = AXES[id === "tx" ? 0 : id === "ty" ? 1 : 2]![0];
        const tip = proj(add3(piv, ax, arm));
        // Start the hit segment off the centre disc so the two don't overlap.
        const k = 0.25;
        handles.push({ id, pts: [{ x: P0.x + (tip.x - P0.x) * k, y: P0.y + (tip.y - P0.y) * k }, tip], closed: false });
      } else if (id === "s") {
        const e = proj(add3(piv, flat ? [1, 0, 0] : right, arm * 1.2));
        const rpx = Math.hypot(e.x - P0.x, e.y - P0.y);
        const pts = Array.from({ length: 64 }, (_, k) => {
          const t = (k / 64) * Math.PI * 2;
          return { x: P0.x + rpx * Math.cos(t), y: P0.y + rpx * Math.sin(t) };
        });
        handles.push({ id, pts, closed: true });
      } else {
        const ax = AXES[id === "rx" ? 0 : id === "ry" ? 1 : 2]![0];
        handles.push({ id, pts: ring(piv, ax, arm * 0.85).map((p) => proj(p)), closed: true });
      }
    }
  }
  return { proj, pivot: P0, arm, handles };
}

function distToSeg(px: number, py: number, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / l2)) : 0;
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}

/** The handle nearest (x, y) within `tol` CSS px; a centre disc wins over
 * the lines around it. Null when none is close. */
export function hitHandle(handles: readonly HandleGeom[], x: number, y: number, tol: number): HandleId | null {
  let best: HandleId | null = null;
  let bestD = tol;
  for (const h of handles) {
    if (h.pts.length === 1) {
      const p = h.pts[0]!;
      if (Math.hypot(x - p.x, y - p.y) <= (h.r ?? 10) + tol * 0.25) return h.id;
      continue;
    }
    const n = h.pts.length;
    for (let k = 0; k < (h.closed ? n : n - 1); k++) {
      const d = distToSeg(x, y, h.pts[k]!, h.pts[(k + 1) % n]!);
      if (d < bestD) {
        bestD = d;
        best = h.id;
      }
    }
  }
  return best;
}

function arrowHead(g: CanvasRenderingContext2D, a: { x: number; y: number }, b: { x: number; y: number }, size: number): void {
  const ang = Math.atan2(b.y - a.y, b.x - a.x);
  g.beginPath();
  g.moveTo(b.x, b.y);
  g.lineTo(b.x - size * Math.cos(ang - 0.42), b.y - size * Math.sin(ang - 0.42));
  g.lineTo(b.x - size * Math.cos(ang + 0.42), b.y - size * Math.sin(ang + 0.42));
  g.closePath();
  g.fill();
}

/** A step of about a quarter of `r`, rounded to 1 / 2 / 5 × 10^k. */
function niceStep(r: number): number {
  const raw = r / 4;
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
}

/** Paint the scene into a CSS-px context of `w`×`h` and return its layout. */
export function drawMatScene(g: CanvasRenderingContext2D, w: number, h: number, scene: MatScene): SceneLayout {
  const L = layoutScene(scene, w, h);
  const { proj } = L;
  const pal = scene.palette;
  const flat = scene.kind === "affine2d";
  const R = scene.cam.radius;
  const m4 = toMat4(scene.kind, scene.m);

  g.fillStyle = pal.bg;
  g.fillRect(0, 0, w, h);

  // Ground grid (the xz floor in 3D, the xy plane flat) through the origin.
  if (!scene.mini) {
    const st = niceStep(R);
    const n = Math.ceil((R * 1.2) / st);
    g.strokeStyle = pal.grid;
    g.lineWidth = 1;
    for (let k = -n; k <= n; k++) {
      const u = k * st, e = n * st;
      if (flat) {
        line(g, proj([u, -e, 0]), proj([u, e, 0]));
        line(g, proj([-e, u, 0]), proj([e, u, 0]));
      } else {
        line(g, proj([u, 0, -e]), proj([u, 0, e]));
        line(g, proj([-e, 0, u]), proj([e, 0, u]));
      }
    }
    // World axes at the origin (dim, the room views' painter).
    g.globalAlpha = 0.55;
    if (flat) {
      g.lineWidth = 1.5;
      g.strokeStyle = pal.x;
      line(g, proj([0, 0, 0]), proj([R * 0.4, 0, 0]));
      g.strokeStyle = pal.y;
      line(g, proj([0, 0, 0]), proj([0, R * 0.4, 0]));
    } else drawAxes(g, proj as (p: Vec3) => Projected, R * 0.4);
    g.globalAlpha = 1;
  }

  // The trail (Watch): where the pivot has been, fading out.
  const trail = scene.trail ?? [];
  if (trail.length > 1) {
    g.strokeStyle = pal.accent;
    g.lineWidth = 1.5;
    for (let k = 1; k < trail.length; k++) {
      g.globalAlpha = 0.15 + (0.6 * k) / trail.length;
      line(g, proj(trail[k - 1]!), proj(trail[k]!));
    }
    g.globalAlpha = 1;
  }

  // The transformed unit cube (square) and its local axes.
  const lw = scene.mini ? 1.25 : 2;
  if (flat) {
    const sq = [
      [-0.5, -0.5, 0],
      [0.5, -0.5, 0],
      [0.5, 0.5, 0],
      [-0.5, 0.5, 0],
    ].map((p) => proj(xform(m4, p)));
    g.fillStyle = pal.accent;
    g.globalAlpha = 0.18;
    g.beginPath();
    sq.forEach((p, k) => (k ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
    g.closePath();
    g.fill();
    g.globalAlpha = 1;
    g.strokeStyle = pal.accent;
    g.lineWidth = lw;
    g.stroke();
  } else {
    const c = [-0.5, 0.5];
    const v: Projected[] = [];
    for (const x of c) for (const y of c) for (const z of c) v.push(proj(xform(m4, [x, y, z])));
    const edges: [number, number][] = [
      [0, 1], [2, 3], [4, 5], [6, 7],
      [0, 2], [1, 3], [4, 6], [5, 7],
      [0, 4], [1, 5], [2, 6], [3, 7],
    ];
    const dMid = proj(xform(m4, [0, 0, 0])).d;
    g.strokeStyle = pal.accent;
    g.lineWidth = lw;
    for (const [a, b] of edges) {
      g.globalAlpha = (v[a]!.d + v[b]!.d) / 2 >= dMid ? 0.95 : 0.4;
      line(g, v[a]!, v[b]!);
    }
    g.globalAlpha = 1;
  }
  const o = proj(xform(m4, [0, 0, 0]));
  for (const [ax, name] of flat ? AXES.slice(0, 2) : AXES) {
    const tip = proj(xform(m4, ax.map((x) => x * 0.75)));
    g.strokeStyle = g.fillStyle = pal[name];
    g.lineWidth = lw;
    line(g, o, tip);
    if (!scene.mini) arrowHead(g, o, tip, 7);
  }
  if (scene.mini || !scene.mode) return L;

  // -- handles --------------------------------------------------------------
  const piv = pivotOf(scene.kind, scene.m);
  const P0 = L.pivot;
  for (const hnd of L.handles) {
    const hot = scene.hot === hnd.id;
    const col =
      hnd.id === "tv" || hnd.id === "s"
        ? pal.text
        : pal[hnd.id.endsWith("x") ? "x" : hnd.id.endsWith("y") ? "y" : "z"];
    g.strokeStyle = g.fillStyle = col;
    g.lineWidth = hot ? 4.5 : 3;
    if (hnd.id === "tv") {
      g.globalAlpha = hot ? 0.9 : 0.6;
      g.beginPath();
      g.arc(P0.x, P0.y, hnd.r ?? 10, 0, Math.PI * 2);
      g.lineWidth = 2;
      g.stroke();
      g.globalAlpha = 1;
    } else if (hnd.id === "tx" || hnd.id === "ty" || hnd.id === "tz") {
      const tip = hnd.pts[1]!;
      line(g, hnd.pts[0]!, tip);
      arrowHead(g, P0, tip, hot ? 15 : 12);
    } else if (hnd.id === "s") {
      g.globalAlpha = hot ? 1 : 0.8;
      g.beginPath();
      hnd.pts.forEach((p, k) => (k ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
      g.closePath();
      g.lineWidth = hot ? 3.5 : 2;
      g.stroke();
      for (const k of [0, 16, 32, 48]) {
        const p = hnd.pts[k]!;
        g.fillRect(p.x - 6, p.y - 6, 12, 12);
      }
      g.globalAlpha = 1;
    } else {
      // A ring: the far half faint so the near half reads as in front.
      const ax = AXES[hnd.id === "rx" ? 0 : hnd.id === "ry" ? 1 : 2]![0];
      const world = ring(piv, ax, L.arm * 0.85);
      const n = world.length;
      for (let k = 0; k < n; k++) {
        const a = hnd.pts[k]!, b = hnd.pts[(k + 1) % n]!;
        const front = flat || (proj(world[k]!).d + proj(world[(k + 1) % n]!).d) / 2 >= P0.d;
        g.globalAlpha = front ? 1 : 0.3;
        line(g, a, b);
      }
      g.globalAlpha = 1;
    }
  }
  return L;
}

// -- the widget ----------------------------------------------------------------

export interface MatGizmoOpts {
  /** 9 or 16 floats, column-major. */
  value: readonly number[];
  kind: MatKind;
  /** Per-component range (the uniform's), applied to every result. */
  ranges?: readonly { min: number; max: number }[];
  /** Canvas CSS size when layout reports none. Default 300. */
  size?: number;
  onInput: (value: number[]) => void;
  onCommit?: (value: number[]) => void;
}

export interface MatGizmoHandle {
  el: HTMLElement;
  set: (value: readonly number[]) => void;
  value: () => number[];
  mode: () => GizmoMode;
  setMode: (m: GizmoMode) => void;
  redraw: () => void;
}

function palette(el: Element): MatPalette {
  const cs = typeof getComputedStyle === "function" ? getComputedStyle(el) : null;
  const v = (name: string, dflt: string): string => cs?.getPropertyValue(name).trim() || dflt;
  return {
    bg: v("--surface-2", "#1f1f26"),
    grid: v("--border", "#2a2a33"),
    axis: v("--text-dim", "#9a9aa2"),
    text: v("--text", "#e8e8ea"),
    accent: v("--accent", "#5b7cfa"),
    x: "#f2555a",
    y: "#37c871",
    z: "#5b9cfa",
  };
}

function fmt(v: number, dp = 3): string {
  if (!Number.isFinite(v)) return "0";
  const r = Math.round(v * 10 ** dp) / 10 ** dp;
  return String(Object.is(r, -0) ? 0 : r);
}

const MODE_LABEL: Record<GizmoMode, string> = { move: "Move", rotate: "Rotate", scale: "Scale" };

export function MatGizmo(opts: MatGizmoOpts): MatGizmoHandle {
  installMatStyles();
  const kind = opts.kind;
  const flat = kind === "affine2d";
  const width = kind === "mat4" ? 16 : 9;
  const clean = (v: readonly number[]): number[] =>
    Array.from({ length: width }, (_, k) => {
      const x = v[k];
      const d = k % (kind === "mat4" ? 5 : 4) === 0 ? 1 : 0;
      const n = x !== undefined && Number.isFinite(x) ? x : d;
      const r = opts.ranges?.[k];
      return r ? Math.max(r.min, Math.min(r.max, n)) : n;
    });
  let cur = clean(opts.value);
  const modes = modesFor(kind);
  let mode: GizmoMode = modes[0]!;
  const cam: MatCamera = { yaw: 0.6, pitch: 0.42, radius: frameRadius(kind, cur) };

  const el = document.createElement("div");
  el.className = "matg";

  // Move / Rotate / Scale: separate buttons, 8 px apart (owner rule).
  const modeRow = document.createElement("div");
  modeRow.className = "matg-modes";
  modeRow.setAttribute("role", "group");
  modeRow.setAttribute("aria-label", "Gizmo mode");
  const modeBtns = new Map<GizmoMode, HTMLButtonElement>();
  for (const md of modes) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "matg-mode";
    b.textContent = MODE_LABEL[md];
    b.addEventListener("click", () => setMode(md));
    modeBtns.set(md, b);
    modeRow.appendChild(b);
  }

  const canvas = document.createElement("canvas");
  canvas.className = "matg-canvas";
  canvas.tabIndex = 0;
  canvas.setAttribute("role", "application");
  canvas.setAttribute(
    "aria-label",
    flat
      ? "2D transform gizmo: drag the arrows to move, the ring to rotate, the outer ring to scale. Arrow keys nudge."
      : "Transform gizmo: drag a handle to move, rotate or scale; drag elsewhere to orbit the view. Arrow keys nudge.",
  );

  const readout = document.createElement("div");
  readout.className = "matg-readout";
  const hint = document.createElement("div");
  hint.className = "matg-hint";

  // -- numeric TRS fields ---------------------------------------------------------
  interface FieldDef {
    group: GizmoMode;
    label: string;
    get: () => number;
    put: (n: number) => number[];
  }
  const dec = () => decompose(kind, cur);
  const putT = (i: number) => (n: number) => {
    const d = dec();
    d.t[i] = n;
    return compose(kind, d, cur);
  };
  const putR = (i: number) => (n: number) => {
    const d = dec();
    d.r[i] = n;
    return compose(kind, d, cur);
  };
  const putS = (n: number): number[] => {
    const d = dec();
    const sg = d.s.map((x) => (x < 0 ? -1 : 1));
    d.s = [n * sg[0]!, n * sg[1]!, n * sg[2]!];
    return compose(kind, d, cur);
  };
  const defs: FieldDef[] = [];
  if (kind !== "mat3") {
    (flat ? ["x", "y"] : ["x", "y", "z"]).forEach((a, i) =>
      defs.push({ group: "move", label: `move ${a}`, get: () => dec().t[i]!, put: putT(i) }),
    );
  }
  if (flat) defs.push({ group: "rotate", label: "angle °", get: () => dec().r[2], put: putR(2) });
  else ["x", "y", "z"].forEach((a, i) => defs.push({ group: "rotate", label: `rot ${a} °`, get: () => dec().r[i]!, put: putR(i) }));
  defs.push({ group: "scale", label: "scale", get: () => Math.abs(dec().s[0]), put: putS });

  const fields = document.createElement("div");
  fields.className = "matg-fields";
  const inputs: HTMLInputElement[] = [];
  for (const d of defs) {
    const f = document.createElement("label");
    f.className = `matg-field matg-field--${d.group}`;
    const t = document.createElement("span");
    t.textContent = d.label;
    const inp = document.createElement("input");
    inp.type = "number";
    inp.step = "any";
    inp.inputMode = "decimal";
    const commit = (): void => {
      if (inp.value === fmt(d.get())) return;
      const n = parseFloat(inp.value);
      if (Number.isFinite(n)) changed(d.put(n));
      syncFields();
      opts.onCommit?.(cur.slice());
    };
    inp.addEventListener("change", commit);
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commit();
        inp.blur();
      }
    });
    f.append(t, inp);
    fields.appendChild(f);
    inputs.push(inp);
  }

  el.append(modeRow, canvas, readout, fields, hint);

  function syncFields(): void {
    const d = dec();
    defs.forEach((def, i) => {
      const inp = inputs[i]!;
      if (typeof document !== "undefined" && document.activeElement === inp) return;
      inp.value = fmt(def.get());
    });
    readout.textContent = trsSummary(kind, cur);
    hint.textContent = d.exact
      ? ""
      : "This matrix also has shear or perspective. Dragging keeps it; typing a field above replaces it with plain move / rotate / scale.";
    hint.hidden = d.exact;
  }

  function setMode(m: GizmoMode): void {
    if (!modes.includes(m)) return;
    mode = m;
    modeBtns.forEach((b, k) => b.setAttribute("aria-pressed", String(k === mode)));
    fields.dataset["mode"] = mode;
    draw();
  }

  // -- drawing ---------------------------------------------------------------------
  let hot: HandleId | null = null;
  let layout: SceneLayout | null = null;
  let size = { w: opts.size ?? 300, h: opts.size ?? 300 };
  function draw(): void {
    const fit = fitCanvas(canvas);
    if (!fit) return;
    const w = canvas.clientWidth ? fit.w : (opts.size ?? 300);
    const h = canvas.clientHeight ? fit.h : (opts.size ?? 300);
    size = { w, h };
    layout = drawMatScene(fit.g, w, h, { kind, m: cur, cam, mode, hot, palette: palette(el) });
  }
  function currentLayout(): SceneLayout {
    const w = canvas.clientWidth || size.w;
    const h = canvas.clientHeight || size.h;
    if (!layout || w !== size.w || h !== size.h) {
      size = { w, h };
      layout = layoutScene({ kind, m: cur, cam, mode, hot }, w, h);
    }
    return layout;
  }

  function changed(next: readonly number[]): void {
    cur = clean(next);
    draw();
    syncFields();
    opts.onInput(cur.slice());
  }

  /** Re-frame the view after a gesture if the transform left the frame or
   * shrank well inside it (never mid-drag: the view must hold still). */
  function refit(): void {
    const want = frameRadius(kind, cur);
    if (want > cam.radius * 0.98 || want < cam.radius * 0.4) {
      cam.radius = want;
      layout = null;
      draw();
    }
  }

  // -- pointer -------------------------------------------------------------------
  interface Drag {
    id: HandleId | "orbit";
    x0: number;
    y0: number;
    lx: number;
    ly: number;
    m0: number[];
    piv: V3;
    lay: SceneLayout;
    /** Rotation: accumulated screen angle, or the tangent (px per radian). */
    acc: number;
    lastAng: number;
    sign: number;
    tangent: { x: number; y: number } | null;
  }
  let drag: Drag | null = null;
  const local = (e: PointerEvent): { x: number; y: number } => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const tolOf = (e: PointerEvent): number => (e.pointerType === "touch" || e.pointerType === "pen" ? 22 : 12);

  function axisOf(id: HandleId): V3 {
    return AXES[id.endsWith("x") ? 0 : id.endsWith("y") ? 1 : 2]![0];
  }

  function startDrag(id: HandleId | "orbit", x: number, y: number): void {
    const lay = currentLayout();
    const piv = pivotOf(kind, cur);
    const d: Drag = { id, x0: x, y0: y, lx: x, ly: y, m0: cur.slice(), piv, lay, acc: 0, lastAng: 0, sign: 1, tangent: null };
    if (id === "rx" || id === "ry" || id === "rz") {
      const ax = axisOf(id);
      const P0 = lay.pivot;
      const facing = flat ? 1 : (() => {
        const { toward } = viewBasis(cam);
        return ax[0] * toward[0] + ax[1] * toward[1] + ax[2] * toward[2];
      })();
      if (Math.abs(facing) > 0.35) {
        d.sign = facing > 0 ? 1 : -1;
        d.lastAng = Math.atan2(-(y - P0.y), x - P0.x);
      } else {
        // Seen edge-on: drag along the ring's screen tangent at the grab point.
        const world = ring(piv, ax, lay.arm * 0.85);
        let best = 0, bd = Infinity;
        world.forEach((p, k) => {
          const q = lay.proj(p);
          const dd = Math.hypot(q.x - x, q.y - y);
          if (dd < bd) {
            bd = dd;
            best = k;
          }
        });
        const g = world[best]!;
        const rv = [g[0] - piv[0], g[1] - piv[1], g[2] - piv[2]];
        const tw: V3 = [ax[1] * rv[2]! - ax[2] * rv[1]!, ax[2] * rv[0]! - ax[0] * rv[2]!, ax[0] * rv[1]! - ax[1] * rv[0]!];
        const a = lay.proj(g), b = lay.proj(add3(g, tw, 0.01));
        d.tangent = { x: (b.x - a.x) / 0.01, y: (b.y - a.y) / 0.01 };
      }
    }
    drag = d;
  }

  function dragTo(x: number, y: number): void {
    const d = drag;
    if (!d) return;
    const dx = x - d.x0, dy = y - d.y0;
    if (d.id === "orbit") {
      cam.yaw += (x - d.lx) * 0.01;
      cam.pitch = Math.max(-1.45, Math.min(1.45, cam.pitch + (y - d.ly) * 0.01));
      d.lx = x;
      d.ly = y;
      layout = null;
      draw();
      return;
    }
    d.lx = x;
    d.ly = y;
    const P0 = d.lay.pivot;
    let D: number[];
    if (d.id === "tx" || d.id === "ty" || d.id === "tz") {
      const ax = axisOf(d.id);
      const tip = d.lay.proj(add3(d.piv, ax, d.lay.arm));
      const ux = tip.x - P0.x, uy = tip.y - P0.y;
      const l2 = ux * ux + uy * uy;
      const t = l2 > 1 ? ((dx * ux + dy * uy) / l2) * d.lay.arm : 0;
      D = translation(ax.map((c) => c * t));
    } else if (d.id === "tv") {
      const { right, up } = flat ? { right: [1, 0, 0] as V3, up: [0, 1, 0] as V3 } : viewBasis(cam);
      const e = d.lay.proj(add3(d.piv, right, d.lay.arm));
      const px = Math.hypot(e.x - P0.x, e.y - P0.y);
      const wpp = px > 1 ? d.lay.arm / px : 0;
      D = translation(add3(right.map((c) => c * dx * wpp), up, -dy * wpp));
    } else if (d.id === "s") {
      const r0 = Math.hypot(d.x0 - P0.x, d.y0 - P0.y);
      const r1 = Math.hypot(x - P0.x, y - P0.y);
      const f = r0 > 1 ? Math.max(0.02, Math.min(50, r1 / r0)) : 1;
      D = aboutPivot(uniformScale(f), d.piv);
    } else {
      let th: number;
      if (d.tangent) {
        const t2 = d.tangent.x ** 2 + d.tangent.y ** 2;
        th = t2 > 1e-6 ? (dx * d.tangent.x + dy * d.tangent.y) / t2 : 0;
      } else {
        const a = Math.atan2(-(y - P0.y), x - P0.x);
        let da = a - d.lastAng;
        if (da > Math.PI) da -= 2 * Math.PI;
        if (da < -Math.PI) da += 2 * Math.PI;
        d.acc += da;
        d.lastAng = a;
        th = d.acc * d.sign;
      }
      D = aboutPivot(axisAngle(axisOf(d.id), th), d.piv);
    }
    changed(applyDelta(kind, d.m0, D));
  }

  canvas.addEventListener("pointerdown", (e) => {
    const p = local(e);
    const id = hitHandle(currentLayout().handles, p.x, p.y, tolOf(e));
    if (!id && flat) return; // the flat view has no orbit
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointer */
    }
    e.preventDefault();
    hot = id;
    startDrag(id ?? "orbit", p.x, p.y);
    draw();
  });
  canvas.addEventListener("pointermove", (e) => {
    const p = local(e);
    if (drag) {
      dragTo(p.x, p.y);
      return;
    }
    if (e.pointerType === "mouse") {
      const h = hitHandle(currentLayout().handles, p.x, p.y, tolOf(e));
      if (h !== hot) {
        hot = h;
        canvas.style.cursor = h ? "pointer" : flat ? "default" : "grab";
        draw();
      }
    }
  });
  const endDrag = (): void => {
    const d = drag;
    if (!d) return;
    drag = null;
    hot = null;
    if (d.id !== "orbit") {
      refit();
      opts.onCommit?.(cur.slice());
    }
    layout = null;
    draw();
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);

  canvas.addEventListener("keydown", (e) => {
    const k = e.key;
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(k)) return;
    e.preventDefault();
    const big = e.shiftKey ? 10 : 1;
    const sgn = k === "ArrowRight" || k === "ArrowUp" ? 1 : -1;
    const horiz = k === "ArrowLeft" || k === "ArrowRight";
    const piv = pivotOf(kind, cur);
    let D: number[];
    if (mode === "move") {
      const step = cam.radius * 0.01 * big * sgn;
      D = translation(horiz ? [step, 0, 0] : [0, step, 0]);
    } else if (mode === "rotate") {
      // Flat: about z. 3D: left / right about y, up / down about x.
      const ax: V3 = flat ? [0, 0, 1] : horiz ? [0, 1, 0] : [1, 0, 0];
      D = aboutPivot(axisAngle(ax, (Math.PI / 180) * big * sgn), piv);
    } else {
      D = aboutPivot(uniformScale(1 + 0.01 * big * sgn), piv);
    }
    changed(applyDelta(kind, cur, D));
    opts.onCommit?.(cur.slice());
  });

  setMode(mode);
  syncFields();
  return {
    el,
    value: () => cur.slice(),
    mode: () => mode,
    setMode,
    redraw: () => {
      layout = null;
      draw();
    },
    set(v) {
      cur = clean(v);
      // An external driver can carry it out of frame: follow it (not mid-drag).
      if (!drag) refit();
      layout = null;
      draw();
      syncFields();
    },
  };
}

// -- MatSwatch: button + full Sheet (phone) / popover (desktop) -----------------

export interface MatSwatchOpts extends Omit<MatGizmoOpts, "size"> {
  /** Sheet / popover title (the uniform's name). */
  title: string;
}

export interface MatSwatchHandle {
  el: HTMLButtonElement;
  set: (value: readonly number[]) => void;
  value: () => number[];
  open: () => void;
  close: () => void;
  /** The open gizmo (tests / the panel), else null. */
  gizmo: () => MatGizmoHandle | null;
}

export function MatSwatch(opts: MatSwatchOpts): MatSwatchHandle {
  installMatStyles();
  let cur = opts.value.slice();
  const el = document.createElement("button");
  el.type = "button";
  el.className = "k-mswatch";
  el.title = `${opts.title}: tap to move, rotate or scale`;
  el.setAttribute("aria-haspopup", "dialog");
  const thumb = document.createElement("canvas");
  thumb.className = "k-mswatch-thumb";
  thumb.setAttribute("aria-hidden", "true");
  const text = document.createElement("span");
  text.className = "k-mswatch-text";
  el.append(thumb, text);
  const paint = (): void => {
    text.textContent = trsSummary(opts.kind, cur);
    const fit = fitCanvas(thumb);
    if (fit) {
      drawMatScene(fit.g, fit.w, fit.h, {
        kind: opts.kind,
        m: cur,
        cam: { yaw: 0.6, pitch: 0.42, radius: frameRadius(opts.kind, cur) },
        mode: null,
        mini: true,
        palette: palette(el),
      });
    }
  };
  paint();
  // The thumbnail has no size until the button is laid out: paint it again
  // once it has (a few frames at most; no observer to leak per re-render).
  const later = (tries: number): void => {
    if (typeof requestAnimationFrame !== "function") return;
    requestAnimationFrame(() => {
      if (thumb.clientWidth > 0) paint();
      else if (tries > 0) later(tries - 1);
    });
  };
  later(30);

  let gizmo: MatGizmoHandle | null = null;
  let closeFn: (() => void) | null = null;
  const gizmoOpts = (size: number): MatGizmoOpts => ({
    value: cur,
    kind: opts.kind,
    ...(opts.ranges ? { ranges: opts.ranges } : {}),
    size,
    onInput: (v) => {
      cur = v;
      paint();
      opts.onInput(v);
    },
    ...(opts.onCommit ? { onCommit: opts.onCommit } : {}),
  });

  function openSheet(): void {
    const sheet = Sheet(opts.title, {
      onClose: () => {
        gizmo = null;
        closeFn = null;
      },
    });
    // Its own full-height step on a phone (owner rule: multi-step flows get a sheet).
    sheet.body.parentElement?.classList.add("k-sheet--full");
    sheet.body.classList.add("matg-sheet");
    gizmo = MatGizmo(gizmoOpts(340));
    sheet.body.appendChild(gizmo.el);
    closeFn = sheet.close;
    requestAnimationFrame(() => gizmo?.redraw());
  }

  function openPopover(): void {
    const pop = document.createElement("div");
    pop.className = "k-mpop";
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", opts.title);
    const head = document.createElement("div");
    head.className = "k-mpop-head";
    head.textContent = opts.title;
    gizmo = MatGizmo(gizmoOpts(320));
    pop.append(head, gizmo.el);
    document.body.appendChild(pop);
    const place = (): void => {
      const r = el.getBoundingClientRect();
      const vw = typeof innerWidth === "number" ? innerWidth : 1280;
      const vh = typeof innerHeight === "number" ? innerHeight : 800;
      const pw = pop.offsetWidth || 360;
      const ph = pop.offsetHeight || 620;
      const left = Math.max(16, Math.min(vw - pw - 16, r.left));
      const below = r.bottom + 8;
      const top = below + ph + 16 <= vh ? below : Math.max(16, Math.min(vh - ph - 16, r.top - ph - 8));
      pop.style.left = `${Math.round(left)}px`;
      pop.style.top = `${Math.round(top)}px`;
    };
    place();
    const onDown = (e: Event): void => {
      const t = e.target as Node | null;
      if (t && (pop.contains(t) || el.contains(t))) return;
      close();
    };
    const onKey = (e: Event): void => {
      if ((e as KeyboardEvent).key === "Escape") {
        close();
        el.focus();
      }
    };
    const onResize = (): void => place();
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onResize, true);
    closeFn = () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onResize, true);
      pop.remove();
      gizmo = null;
      closeFn = null;
    };
    requestAnimationFrame(() => {
      gizmo?.redraw();
      place();
    });
  }

  function open(): void {
    if (gizmo !== null) return;
    if (prefersSheet()) openSheet();
    else openPopover();
  }
  function close(): void {
    closeFn?.();
  }
  el.addEventListener("click", (e) => {
    e.preventDefault();
    if (gizmo !== null) close();
    else open();
  });

  return {
    el,
    open,
    close,
    gizmo: () => gizmo,
    value: () => cur.slice(),
    set(v) {
      cur = v.slice();
      paint();
      gizmo?.set(cur);
    },
  };
}

// -- styles ---------------------------------------------------------------------

let stylesInstalled = false;
function installMatStyles(): void {
  if (stylesInstalled || typeof document === "undefined") return;
  stylesInstalled = true;
  const s = document.createElement("style");
  s.textContent = MAT_CSS;
  document.head.appendChild(s);
}

const MAT_CSS = `
.matg { display: flex; flex-direction: column; gap: var(--sp-3); width: 100%; }
.matg-modes { display: flex; gap: var(--sp-2); }
.matg-mode {
  flex: 1 1 0; min-height: 2.5rem; padding: 0 var(--sp-3);
  border: 1px solid var(--border); border-radius: var(--r-ctrl);
  background: var(--surface-2); color: var(--text); font: inherit; cursor: pointer;
}
.matg-mode[aria-pressed="true"] { background: var(--accent-quiet); border-color: var(--accent); }
.matg-mode:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.matg-canvas {
  display: block; width: 100%; aspect-ratio: 1 / 1; max-height: 52vh;
  margin: 0 auto; touch-action: none; cursor: grab; border-radius: var(--r-ctrl);
}
.matg-canvas:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; }
.matg-readout {
  font-size: var(--f-caption); color: var(--text-dim); text-align: center;
  font-variant-numeric: tabular-nums;
}
.matg-hint { font-size: var(--f-caption); color: var(--text-dim); }
.matg-fields { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--sp-2); }
.matg-field { display: flex; flex-direction: column; gap: var(--sp-1); min-width: 0; }
.matg-field span { font-size: var(--f-caption); color: var(--text-dim); }
.matg-field input { width: 100%; min-width: 0; box-sizing: border-box; }
/* The fields of the active mode are shown; the others stay one tap away. */
.matg-fields[data-mode="move"] .matg-field:not(.matg-field--move),
.matg-fields[data-mode="rotate"] .matg-field:not(.matg-field--rotate),
.matg-fields[data-mode="scale"] .matg-field:not(.matg-field--scale) { display: none; }
.matg-sheet .matg { max-width: 420px; margin: 0 auto; padding-bottom: var(--sp-2); }
@media (max-width: 640px) {
  .k-sheet.k-sheet--full { top: 0; max-height: none; border-radius: 0; border-top: 0; }
  .matg-canvas { max-height: none; }
}

.k-mswatch {
  display: flex; align-items: center; gap: var(--sp-2); width: 100%; min-width: 0;
  height: 1.75rem; padding: 0 var(--sp-2) 0 2px; box-sizing: border-box;
  border: 1px solid var(--border); border-radius: var(--r-ctrl);
  background: var(--surface-2); color: var(--text); font: inherit; cursor: pointer;
}
.k-mswatch:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.k-mswatch-thumb { flex: none; width: 1.5rem; height: 1.5rem; border-radius: 4px; }
.k-mswatch-text {
  flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  text-align: left; font-size: var(--f-caption); font-variant-numeric: tabular-nums;
}
@media (max-width: 640px), (pointer: coarse) {
  .k-mswatch { height: 2.75rem; }
  .k-mswatch-thumb { width: 2.25rem; height: 2.25rem; }
}
.k-mpop {
  position: fixed; z-index: 1000; width: 360px; box-sizing: border-box;
  padding: var(--sp-4); background: var(--surface); color: var(--text);
  border: 1px solid var(--border); border-radius: var(--r-card, 12px);
  box-shadow: 0 12px 40px rgb(0 0 0 / 0.45);
  display: flex; flex-direction: column; gap: var(--sp-3);
}
.k-mpop-head { font-weight: 600; font-size: var(--f-body, 0.95rem); }
`;
