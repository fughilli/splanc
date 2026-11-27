/**
 * Vector and direction pickers (D-541 PR 4) for `uniform vec2/vec3 x : vector`
 * and `: direction`:
 *
 * - **2D vector**: an XY pad over the declared per-axis ranges, with an
 *   angle / length readout.
 * - **3D vector**: the same pad for x/y plus a z slider (owner spec).
 * - **2D direction**: an angle dial (the point stays on the unit circle).
 * - **3D direction**: a sphere you aim at (the point stays on the unit sphere),
 *   with an Orbit mode that turns the view so the back half is reachable.
 *
 * Every control also has numeric fields. Output is float (no grid unless the
 * uniform declares a `step`). `onInput` fires on every pointer move so the value
 * streams live; `onCommit` fires once when the gesture (or a field edit) ends.
 *
 * `VectorSwatch` wraps a picker for forms: a button showing the vector that
 * opens the picker in a bottom Sheet on phones and an inline popover on desktop.
 */

import { Sheet } from "./index";

export type VectorMode = "vector" | "direction";

export interface Range {
  min: number;
  max: number;
}

export interface VectorPickerOpts {
  /** 2 or 3 floats. */
  value: readonly number[];
  dims: 2 | 3;
  mode: VectorMode;
  /** Per-component range (vector mode); ignored for a direction (-1..1). */
  ranges?: readonly Range[];
  /** The uniform's step grid (0 = continuous). */
  step?: number;
  /** Canvas CSS size (px) when the layout reports none. Default 240. */
  size?: number;
  onInput: (value: number[]) => void;
  onCommit?: (value: number[]) => void;
}

export interface VectorPickerHandle {
  el: HTMLElement;
  /** Move the picker from outside (MIDI, the agent, hydration) without firing. */
  set: (value: readonly number[]) => void;
  value: () => number[];
  /** Redraw at the current layout size (after the picker became visible). */
  redraw: () => void;
}

const TAU = Math.PI * 2;
const DEG = 180 / Math.PI;

// -- pure geometry (unit-tested) ---------------------------------------------

/** Clamp into a range (either order). */
export function clampTo(v: number, r: Range): number {
  const lo = Math.min(r.min, r.max);
  const hi = Math.max(r.min, r.max);
  return Math.min(hi, Math.max(lo, v));
}

/** Snap to a `step` grid anchored at the range min (0 = no snap), then clamp. */
export function snapTo(v: number, r: Range, step: number): number {
  const s = step > 0 && Number.isFinite(r.min) ? r.min + Math.round((v - r.min) / step) * step : v;
  return clampTo(s, r);
}

/** Pad fraction (0..1 across, 0..1 DOWN the canvas) → x/y in their ranges. */
export function padToValue(fx: number, fy: number, rx: Range, ry: Range): [number, number] {
  const cx = Math.min(1, Math.max(0, fx));
  const cy = Math.min(1, Math.max(0, fy));
  return [rx.min + cx * (rx.max - rx.min), ry.max - cy * (ry.max - ry.min)];
}

/** x/y → pad fraction (0..1 across, 0..1 down); the inverse of {@link padToValue}. */
export function valueToPad(x: number, y: number, rx: Range, ry: Range): [number, number] {
  const sx = rx.max - rx.min || 1;
  const sy = ry.max - ry.min || 1;
  return [(clampTo(x, rx) - rx.min) / sx, (ry.max - clampTo(y, ry)) / sy];
}

/** Angle (degrees, counter-clockwise from +x, in (-180, 180]) and length of a 2D vector. */
export function polar(x: number, y: number): { deg: number; len: number } {
  return { deg: Math.atan2(y, x) * DEG, len: Math.hypot(x, y) };
}

/** `v` at unit length; a (near-)zero vector becomes `fallback`. */
export function normalize(v: readonly number[], fallback: readonly number[]): number[] {
  const len = Math.hypot(...v);
  return len > 1e-9 ? v.map((x) => x / len) : fallback.slice();
}

/** The view rotation of the 3D sphere: yaw about +y, then pitch about +x
 * (radians). World → view; +z of the view points at the viewer, +y up. */
export function toView(p: readonly number[], yaw: number, pitch: number): [number, number, number] {
  const [x, y, z] = [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0];
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const x1 = cy * x + sy * z;
  const z1 = -sy * x + cy * z;
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  return [x1, cp * y - sp * z1, sp * y + cp * z1];
}

/** View → world; the inverse of {@link toView}. */
export function fromView(v: readonly number[], yaw: number, pitch: number): [number, number, number] {
  const [x1, y2, z2] = [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0];
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const y = cp * y2 + sp * z2;
  const z1 = -sp * y2 + cp * z2;
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  return [cy * x1 - sy * z1, y, sy * x1 + cy * z1];
}

/** A point on the drawn sphere (view x/y, unit-disk coordinates, +y up) → the
 * world direction under it on the FRONT hemisphere; outside the disk it slides
 * to the rim. */
export function aimAt(vx: number, vy: number, yaw: number, pitch: number): [number, number, number] {
  let x = vx;
  let y = vy;
  const r2 = x * x + y * y;
  if (r2 > 1) {
    const r = Math.sqrt(r2);
    x /= r;
    y /= r;
  }
  const z = Math.sqrt(Math.max(0, 1 - x * x - y * y));
  const w = fromView([x, y, z], yaw, pitch);
  return normalize(w, [0, 1, 0]) as [number, number, number];
}

/** Azimuth (degrees about +y, 0 = +z, 90 = +x) and elevation (degrees above
 * the x-z plane) of a 3D direction. */
export function azEl(v: readonly number[]): { az: number; el: number } {
  const [x, y, z] = normalize([v[0] ?? 0, v[1] ?? 0, v[2] ?? 0], [0, 1, 0]) as [number, number, number];
  return { az: Math.atan2(x, z) * DEG, el: Math.asin(Math.max(-1, Math.min(1, y))) * DEG };
}

/** The unit vector at azimuth / elevation (degrees); the inverse of {@link azEl}. */
export function fromAzEl(az: number, el: number): [number, number, number] {
  const a = az / DEG;
  const e = el / DEG;
  return [Math.cos(e) * Math.sin(a), Math.sin(e), Math.cos(e) * Math.cos(a)];
}

/** Compact number label (up to `dp` decimals, trailing zeros trimmed). */
export function fmtNum(v: number, dp = 3): string {
  if (!Number.isFinite(v)) return "0";
  const k = 10 ** dp;
  const r = Math.round(v * k) / k;
  return String(Object.is(r, -0) ? 0 : r);
}

/** The short readout a form shows beside the control: angle + length for a
 * free 2D vector, the angle for a 2D direction, azimuth / elevation for a 3D
 * direction, and the length for a 3D vector. */
export function vectorSummary(value: readonly number[], dims: 2 | 3, mode: VectorMode): string {
  const x = value[0] ?? 0;
  const y = value[1] ?? 0;
  if (dims === 2) {
    const p = polar(x, y);
    return mode === "direction" ? `${fmtNum(p.deg, 1)}°` : `${fmtNum(p.deg, 1)}° · ${fmtNum(p.len, 2)}`;
  }
  if (mode === "direction") {
    const a = azEl(value);
    return `az ${fmtNum(a.az, 0)}° el ${fmtNum(a.el, 0)}°`;
  }
  // The button already shows the components: give the length here.
  return `len ${fmtNum(Math.hypot(x, y, value[2] ?? 0), 2)}`;
}

// -- the picker ---------------------------------------------------------------

interface Palette {
  bg: string;
  grid: string;
  axis: string;
  text: string;
  accent: string;
  x: string;
  y: string;
  z: string;
}

function palette(el: Element): Palette {
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

export function VectorPicker(opts: VectorPickerOpts): VectorPickerHandle {
  installVectorStyles();
  const dims = opts.dims;
  const dir = opts.mode === "direction";
  const step = dir ? 0 : Math.max(0, opts.step ?? 0);
  const unit: Range = { min: -1, max: 1 };
  const ranges: Range[] = [0, 1, 2].map((i) => (dir ? unit : (opts.ranges?.[i] ?? unit)));
  const fallback = dims === 2 ? [0, 1] : [0, 1, 0];

  const clean = (v: readonly number[]): number[] => {
    const out = Array.from({ length: dims }, (_, i) => {
      const x = v[i];
      return x !== undefined && Number.isFinite(x) ? x : (fallback[i] ?? 0);
    });
    return dir ? normalize(out, fallback) : out.map((x, i) => snapTo(x, ranges[i]!, step));
  };
  let cur = clean(opts.value);
  // The sphere's view (radians): a three-quarter view so all three axes show.
  let yaw = -0.6;
  let pitch = 0.35;

  const el = document.createElement("div");
  el.className = "vecp";

  const canvas = document.createElement("canvas");
  canvas.className = `vecp-canvas${dir ? " vecp-canvas--round" : ""}`;
  canvas.tabIndex = 0;
  canvas.setAttribute("role", "slider");
  canvas.setAttribute(
    "aria-label",
    dir
      ? dims === 2
        ? "Direction dial. Arrow keys turn it."
        : "Direction sphere: drag to aim (Orbit turns the view). Arrow keys turn it."
      : "Vector pad: drag to set x and y. Arrow keys nudge.",
  );
  el.appendChild(canvas);

  // -- 3D direction: Aim / Orbit modes (separate, spaced buttons) -------------
  let orbit = false;
  const modeBtns: HTMLButtonElement[] = [];
  if (dir && dims === 3) {
    const modes = document.createElement("div");
    modes.className = "vecp-modes";
    modes.setAttribute("role", "group");
    modes.setAttribute("aria-label", "Drag mode");
    for (const [label, isOrbit] of [
      ["Aim", false],
      ["Orbit view", true],
    ] as const) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "vecp-mode";
      b.textContent = label;
      b.addEventListener("click", () => {
        orbit = isOrbit;
        syncModes();
      });
      modeBtns.push(b);
      modes.appendChild(b);
    }
    el.appendChild(modes);
  }
  function syncModes(): void {
    modeBtns.forEach((b, i) => b.setAttribute("aria-pressed", String((i === 1) === orbit)));
    canvas.style.cursor = orbit ? "grab" : "crosshair";
  }
  syncModes();

  // -- 3D vector: the z slider (owner spec: pad + z) ---------------------------
  let zSlider: HTMLInputElement | null = null;
  if (!dir && dims === 3) {
    const row = document.createElement("label");
    row.className = "vecp-z";
    const t = document.createElement("span");
    t.textContent = "z";
    zSlider = document.createElement("input");
    zSlider.type = "range";
    zSlider.min = String(ranges[2]!.min);
    zSlider.max = String(ranges[2]!.max);
    zSlider.step = step > 0 ? String(step) : "any";
    zSlider.addEventListener("input", () => {
      const next = cur.slice();
      next[2] = parseFloat(zSlider!.value);
      changed(next);
    });
    zSlider.addEventListener("change", () => opts.onCommit?.(cur.slice()));
    row.append(t, zSlider);
    el.appendChild(row);
  }

  const readout = document.createElement("div");
  readout.className = "vecp-readout";
  el.appendChild(readout);

  // -- numeric fields -----------------------------------------------------------
  // A direction is edited as angles (they can't leave the sphere); a vector by
  // its components.
  const fields = document.createElement("div");
  fields.className = "vecp-fields";
  interface FieldDef {
    label: string;
    get: () => number;
    put: (n: number) => number[];
    dp: number;
  }
  const defs: FieldDef[] = dir
    ? dims === 2
      ? [
          {
            label: "angle °",
            dp: 2,
            get: () => polar(cur[0] ?? 0, cur[1] ?? 0).deg,
            put: (d) => [Math.cos(d / DEG), Math.sin(d / DEG)],
          },
        ]
      : [
          { label: "azimuth °", dp: 2, get: () => azEl(cur).az, put: (a) => fromAzEl(a, azEl(cur).el) },
          { label: "elevation °", dp: 2, get: () => azEl(cur).el, put: (e) => fromAzEl(azEl(cur).az, Math.max(-90, Math.min(90, e))) },
        ]
    : Array.from({ length: dims }, (_, i) => ({
        label: "xyz"[i]!,
        dp: 4,
        get: () => cur[i] ?? 0,
        put: (n: number) => {
          const next = cur.slice();
          next[i] = n;
          return next;
        },
      }));
  const inputs: HTMLInputElement[] = [];
  for (const d of defs) {
    const f = document.createElement("label");
    f.className = "vecp-field";
    const t = document.createElement("span");
    t.textContent = d.label;
    const inp = document.createElement("input");
    inp.type = "number";
    inp.step = "any";
    inp.inputMode = "decimal";
    const commit = (): void => {
      // An unedited field keeps the exact live value rather than its label.
      if (inp.value === fmtNum(d.get(), d.dp)) return;
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
  fields.style.gridTemplateColumns = `repeat(${Math.max(2, defs.length)}, minmax(0, 1fr))`;
  el.appendChild(fields);

  function syncFields(): void {
    defs.forEach((d, i) => {
      const inp = inputs[i]!;
      if (typeof document !== "undefined" && document.activeElement === inp) return;
      inp.value = fmtNum(d.get(), d.dp);
    });
    if (zSlider) zSlider.value = String(cur[2] ?? 0);
    readout.textContent = readoutText();
  }

  function readoutText(): string {
    const x = cur[0] ?? 0;
    const y = cur[1] ?? 0;
    if (dims === 2) {
      const p = polar(x, y);
      return dir ? `angle ${fmtNum(p.deg, 1)}°` : `angle ${fmtNum(p.deg, 1)}° · length ${fmtNum(p.len, 3)}`;
    }
    if (dir) {
      const a = azEl(cur);
      return `x ${fmtNum(x, 3)} · y ${fmtNum(y, 3)} · z ${fmtNum(cur[2] ?? 0, 3)}  (az ${fmtNum(a.az, 1)}°, el ${fmtNum(a.el, 1)}°)`;
    }
    return `length ${fmtNum(Math.hypot(x, y, cur[2] ?? 0), 3)}`;
  }

  // -- drawing ------------------------------------------------------------------
  let n = 0;
  function ensureSize(): CanvasRenderingContext2D | null {
    const css = canvas.clientWidth || opts.size || 240;
    const dpr = Math.min(2, (typeof devicePixelRatio === "number" && devicePixelRatio) || 1);
    const want = Math.max(64, Math.round(css * dpr));
    if (want !== n) {
      n = want;
      canvas.width = n;
      canvas.height = n;
    }
    return canvas.getContext("2d");
  }

  function arrow(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, color: string, w: number): void {
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    const a = Math.atan2(y1 - y0, x1 - x0);
    const len = Math.hypot(x1 - x0, y1 - y0);
    const h = Math.min(len * 0.5, w * 4.5);
    if (h < 1) return;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x1 - h * Math.cos(a - 0.45), y1 - h * Math.sin(a - 0.45));
    ctx.lineTo(x1 - h * Math.cos(a + 0.45), y1 - h * Math.sin(a + 0.45));
    ctx.closePath();
    ctx.fill();
  }

  function knob(ctx: CanvasRenderingContext2D, x: number, y: number, fill: string, hollow = false): void {
    const r = n * 0.035;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fillStyle = hollow ? "transparent" : fill;
    if (!hollow) ctx.fill();
    ctx.lineWidth = Math.max(1.5, n * 0.008);
    ctx.strokeStyle = hollow ? fill : "#fff";
    ctx.stroke();
  }

  function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string): void {
    ctx.fillStyle = color;
    ctx.font = `${Math.round(n * 0.05)}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, x, y);
  }

  function drawPad(ctx: CanvasRenderingContext2D, p: Palette): void {
    const pad = n * 0.06;
    const w = n - 2 * pad;
    const rx = ranges[0]!;
    const ry = ranges[1]!;
    ctx.fillStyle = p.bg;
    ctx.fillRect(pad, pad, w, w);
    ctx.strokeStyle = p.grid;
    ctx.lineWidth = Math.max(1, n * 0.003);
    for (let k = 0; k <= 4; k++) {
      const t = pad + (w * k) / 4;
      ctx.beginPath();
      ctx.moveTo(t, pad);
      ctx.lineTo(t, pad + w);
      ctx.moveTo(pad, t);
      ctx.lineTo(pad + w, t);
      ctx.stroke();
    }
    // Axes through zero where zero is in range; the arrow starts there.
    const [ox, oy] = valueToPad(clampTo(0, rx), clampTo(0, ry), rx, ry);
    const X0 = pad + ox * w;
    const Y0 = pad + oy * w;
    ctx.strokeStyle = p.axis;
    ctx.lineWidth = Math.max(1, n * 0.005);
    ctx.beginPath();
    ctx.moveTo(pad, Y0);
    ctx.lineTo(pad + w, Y0);
    ctx.moveTo(X0, pad);
    ctx.lineTo(X0, pad + w);
    ctx.stroke();
    label(ctx, "x", pad + w - n * 0.03, Y0 - n * 0.035, p.x);
    label(ctx, "y", X0 + n * 0.035, pad + n * 0.03, p.y);
    const [fx, fy] = valueToPad(cur[0] ?? 0, cur[1] ?? 0, rx, ry);
    const X = pad + fx * w;
    const Y = pad + fy * w;
    arrow(ctx, X0, Y0, X, Y, p.accent, Math.max(2, n * 0.012));
    knob(ctx, X, Y, p.accent);
  }

  function drawDial(ctx: CanvasRenderingContext2D, p: Palette): void {
    const c = n / 2;
    const R = n * 0.42;
    ctx.fillStyle = p.bg;
    ctx.beginPath();
    ctx.arc(c, c, R, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = p.grid;
    ctx.lineWidth = Math.max(1, n * 0.004);
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * TAU;
      const r0 = k % 3 === 0 ? R * 0.82 : R * 0.9;
      ctx.beginPath();
      ctx.moveTo(c + r0 * Math.cos(a), c - r0 * Math.sin(a));
      ctx.lineTo(c + R * Math.cos(a), c - R * Math.sin(a));
      ctx.stroke();
    }
    ctx.strokeStyle = p.axis;
    ctx.beginPath();
    ctx.arc(c, c, R, 0, TAU);
    ctx.stroke();
    label(ctx, "x", c + R + n * 0.04, c, p.x);
    label(ctx, "y", c, c - R - n * 0.04, p.y);
    const X = c + R * (cur[0] ?? 0);
    const Y = c - R * (cur[1] ?? 0);
    arrow(ctx, c, c, X, Y, p.accent, Math.max(2, n * 0.012));
    knob(ctx, X, Y, p.accent);
  }

  function drawSphere(ctx: CanvasRenderingContext2D, p: Palette): void {
    const c = n / 2;
    const R = n * 0.4;
    const S = (v: readonly number[]): [number, number, number] => {
      const q = toView(v, yaw, pitch);
      return [c + q[0] * R, c - q[1] * R, q[2]];
    };
    const g = ctx.createRadialGradient(c - R * 0.3, c - R * 0.35, R * 0.1, c, c, R);
    g.addColorStop(0, p.grid);
    g.addColorStop(1, p.bg);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(c, c, R, 0, TAU);
    ctx.fill();
    // Latitude / longitude lines: back halves faint, front halves solid.
    const lw = Math.max(1, n * 0.003);
    const curve = (pt: (t: number) => number[]): void => {
      const N = 72;
      for (let k = 0; k < N; k++) {
        const a = S(pt((k / N) * TAU));
        const b = S(pt(((k + 1) / N) * TAU));
        const front = a[2] + b[2] > 0;
        ctx.globalAlpha = front ? 0.9 : 0.25;
        ctx.strokeStyle = p.axis;
        ctx.lineWidth = front ? lw * 1.4 : lw;
        ctx.beginPath();
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    };
    for (const lat of [-60, -30, 0, 30, 60]) {
      const e = lat / DEG;
      curve((t) => [Math.cos(e) * Math.sin(t), Math.sin(e), Math.cos(e) * Math.cos(t)]);
    }
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI;
      curve((t) => [Math.cos(t) * Math.sin(a), Math.sin(t), Math.cos(t) * Math.cos(a)]);
    }
    ctx.strokeStyle = p.axis;
    ctx.lineWidth = lw * 1.5;
    ctx.beginPath();
    ctx.arc(c, c, R, 0, TAU);
    ctx.stroke();
    // World axes, labelled at their tips.
    const axes: [number[], string, string][] = [
      [[1, 0, 0], "x", p.x],
      [[0, 1, 0], "y", p.y],
      [[0, 0, 1], "z", p.z],
    ];
    for (const [v, name, col] of axes) {
      const [X, Y, Z] = S(v.map((x) => x * 1.12));
      ctx.globalAlpha = Z >= 0 ? 1 : 0.45;
      ctx.strokeStyle = col;
      ctx.lineWidth = lw * 1.5;
      ctx.beginPath();
      ctx.moveTo(c, c);
      ctx.lineTo(X, Y);
      ctx.stroke();
      label(ctx, name, X + (X - c) * 0.08, Y + (Y - c) * 0.08, col);
      ctx.globalAlpha = 1;
    }
    const [X, Y, Z] = S(cur);
    ctx.globalAlpha = Z >= 0 ? 1 : 0.6;
    arrow(ctx, c, c, X, Y, p.accent, Math.max(2, n * 0.012));
    ctx.globalAlpha = 1;
    // Behind the sphere: a hollow knob.
    knob(ctx, X, Y, p.accent, Z < 0);
  }

  function draw(): void {
    const ctx = ensureSize();
    if (!ctx) return;
    ctx.clearRect(0, 0, n, n);
    const p = palette(el);
    if (!dir) drawPad(ctx, p);
    else if (dims === 2) drawDial(ctx, p);
    else drawSphere(ctx, p);
  }

  function changed(next: readonly number[]): void {
    cur = clean(next);
    draw();
    syncFields();
    opts.onInput(cur.slice());
  }

  // -- pointer ------------------------------------------------------------------
  let drag = false;
  let last: { x: number; y: number } | null = null;
  function local(e: PointerEvent): { fx: number; fy: number } {
    const r = canvas.getBoundingClientRect();
    return { fx: (e.clientX - r.left) / (r.width || 1), fy: (e.clientY - r.top) / (r.height || 1) };
  }
  function applyPointer(e: PointerEvent): void {
    const { fx, fy } = local(e);
    if (!dir) {
      const pad = 0.06;
      const [x, y] = padToValue((fx - pad) / (1 - 2 * pad), (fy - pad) / (1 - 2 * pad), ranges[0]!, ranges[1]!);
      const next = cur.slice();
      next[0] = x;
      next[1] = y;
      changed(next);
    } else if (dims === 2) {
      const dx = fx - 0.5;
      const dy = 0.5 - fy;
      if (Math.hypot(dx, dy) > 1e-3) changed([dx, dy]);
    } else if (orbit) {
      if (last) {
        yaw += ((e.clientX - last.x) / (canvas.clientWidth || 240)) * Math.PI;
        pitch = Math.max(-1.5, Math.min(1.5, pitch + ((e.clientY - last.y) / (canvas.clientWidth || 240)) * Math.PI));
        draw();
      }
      last = { x: e.clientX, y: e.clientY };
    } else {
      changed(aimAt((fx - 0.5) / 0.4, (0.5 - fy) / 0.4, yaw, pitch));
    }
  }
  canvas.addEventListener("pointerdown", (e) => {
    ensureSize();
    drag = true;
    last = { x: e.clientX, y: e.clientY };
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointer */
    }
    e.preventDefault();
    if (!(dir && dims === 3 && orbit)) applyPointer(e);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (drag) applyPointer(e);
  });
  const endDrag = (): void => {
    if (!drag) return;
    drag = false;
    last = null;
    if (!(dir && dims === 3 && orbit)) opts.onCommit?.(cur.slice());
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  canvas.addEventListener("keydown", (e) => {
    const big = e.shiftKey ? 10 : 1;
    const k = e.key;
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(k)) return;
    e.preventDefault();
    const sgn = k === "ArrowRight" || k === "ArrowUp" ? 1 : -1;
    if (!dir) {
      const i = k === "ArrowLeft" || k === "ArrowRight" ? 0 : 1;
      const r = ranges[i]!;
      const d = step > 0 ? step * big : ((r.max - r.min) / 100) * big;
      const next = cur.slice();
      next[i] = (next[i] ?? 0) + sgn * d;
      changed(next);
    } else if (dims === 2) {
      const a = polar(cur[0] ?? 0, cur[1] ?? 1).deg + sgn * big;
      changed([Math.cos(a / DEG), Math.sin(a / DEG)]);
    } else {
      const { az, el: elv } = azEl(cur);
      changed(
        k === "ArrowLeft" || k === "ArrowRight"
          ? fromAzEl(az + sgn * big, elv)
          : fromAzEl(az, Math.max(-90, Math.min(90, elv + sgn * big))),
      );
    }
    opts.onCommit?.(cur.slice());
  });

  syncFields();
  draw();
  return {
    el,
    value: () => cur.slice(),
    redraw: draw,
    set(v) {
      cur = clean(v);
      draw();
      syncFields();
    },
  };
}

// -- VectorSwatch: button + Sheet (phone) / popover (desktop) ------------------

export interface VectorSwatchOpts extends Omit<VectorPickerOpts, "size"> {
  /** Sheet / popover title (the uniform's name). */
  title: string;
}

export interface VectorSwatchHandle {
  el: HTMLButtonElement;
  /** Move from outside (MIDI / agent / hydration); the open picker follows. */
  set: (value: readonly number[]) => void;
  value: () => number[];
  open: () => void;
  close: () => void;
}

/** Phones (narrow or touch-first) get the picker in a bottom Sheet. */
export function prefersSheet(): boolean {
  if (typeof matchMedia !== "function") return false;
  return matchMedia("(max-width: 640px)").matches || matchMedia("(pointer: coarse)").matches;
}

/** The screen angle (radians, clockwise from +x as CSS rotates) a button's
 * arrow glyph points along for this value; null when it has no 2D direction. */
export function glyphAngle(value: readonly number[]): number | null {
  const x = value[0] ?? 0;
  const y = value[1] ?? 0;
  return Math.hypot(x, y) > 1e-6 ? -Math.atan2(y, x) : null;
}

export function VectorSwatch(opts: VectorSwatchOpts): VectorSwatchHandle {
  installVectorStyles();
  let cur = opts.value.slice();
  const el = document.createElement("button");
  el.type = "button";
  el.className = "k-vswatch";
  el.title = `${opts.title}: tap to edit`;
  el.setAttribute("aria-haspopup", "dialog");
  const glyph = document.createElement("span");
  glyph.className = "k-vswatch-glyph";
  glyph.setAttribute("aria-hidden", "true");
  glyph.textContent = "➜";
  const text = document.createElement("span");
  text.className = "k-vswatch-text";
  el.append(glyph, text);
  const paint = (): void => {
    const a = glyphAngle(cur);
    glyph.style.transform = a === null ? "" : `rotate(${a}rad)`;
    glyph.style.opacity = a === null ? "0.35" : "1";
    text.textContent = cur.map((x) => fmtNum(x, 2)).join(", ");
  };
  paint();

  let picker: VectorPickerHandle | null = null;
  let closeFn: (() => void) | null = null;
  const pickerOpts = (size: number): VectorPickerOpts => ({
    value: cur,
    dims: opts.dims,
    mode: opts.mode,
    ...(opts.ranges ? { ranges: opts.ranges } : {}),
    ...(opts.step !== undefined ? { step: opts.step } : {}),
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
        picker = null;
        closeFn = null;
      },
    });
    sheet.body.classList.add("vecp-sheet");
    picker = VectorPicker(pickerOpts(300));
    sheet.body.appendChild(picker.el);
    closeFn = sheet.close;
    requestAnimationFrame(() => picker?.redraw());
  }

  function openPopover(): void {
    const pop = document.createElement("div");
    pop.className = "k-vpop";
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", opts.title);
    const head = document.createElement("div");
    head.className = "k-vpop-head";
    head.textContent = opts.title;
    picker = VectorPicker(pickerOpts(248));
    pop.append(head, picker.el);
    document.body.appendChild(pop);
    const place = (): void => {
      const r = el.getBoundingClientRect();
      const vw = typeof innerWidth === "number" ? innerWidth : 1280;
      const vh = typeof innerHeight === "number" ? innerHeight : 800;
      const pw = pop.offsetWidth || 296;
      const ph = pop.offsetHeight || 440;
      const left = Math.max(16, Math.min(vw - pw - 16, r.left));
      const below = r.bottom + 8;
      const top = below + ph + 16 <= vh ? below : Math.max(16, r.top - ph - 8);
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
      picker = null;
      closeFn = null;
    };
    requestAnimationFrame(() => {
      picker?.redraw();
      place();
    });
  }

  function open(): void {
    if (picker !== null) return;
    if (prefersSheet()) openSheet();
    else openPopover();
  }
  function close(): void {
    closeFn?.();
  }
  el.addEventListener("click", (e) => {
    e.preventDefault();
    if (picker !== null) close();
    else open();
  });

  return {
    el,
    open,
    close,
    value: () => cur.slice(),
    set(v) {
      cur = v.slice();
      paint();
      picker?.set(cur);
    },
  };
}

// -- styles -------------------------------------------------------------------

let stylesInstalled = false;
function installVectorStyles(): void {
  if (stylesInstalled || typeof document === "undefined") return;
  stylesInstalled = true;
  const s = document.createElement("style");
  s.textContent = VECTOR_CSS;
  document.head.appendChild(s);
}

const VECTOR_CSS = `
.vecp { display: flex; flex-direction: column; gap: var(--sp-3); width: 100%; }
.vecp-canvas {
  display: block; width: 100%; max-width: 300px; aspect-ratio: 1 / 1;
  margin: 0 auto; touch-action: none; cursor: crosshair; border-radius: var(--r-ctrl);
}
.vecp-canvas--round { border-radius: 50%; }
.vecp-canvas:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; }
.vecp-modes { display: flex; gap: var(--sp-2); justify-content: center; }
.vecp-mode {
  flex: 1 1 0; min-height: 2.25rem; padding: 0 var(--sp-3);
  border: 1px solid var(--border); border-radius: var(--r-ctrl);
  background: var(--surface-2); color: var(--text); font: inherit; cursor: pointer;
}
.vecp-mode[aria-pressed="true"] { background: var(--accent-quiet); border-color: var(--accent); }
.vecp-mode:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.vecp-z { display: flex; align-items: center; gap: var(--sp-3); }
.vecp-z span { font-size: var(--f-caption); color: var(--text-dim); min-width: 1rem; }
.vecp-z input { flex: 1 1 auto; margin: 0; min-width: 0; }
.vecp-readout {
  font-size: var(--f-caption); color: var(--text-dim); text-align: center;
  font-variant-numeric: tabular-nums;
}
.vecp-fields { display: grid; gap: var(--sp-2); }
.vecp-field { display: flex; flex-direction: column; gap: var(--sp-1); min-width: 0; }
.vecp-field span { font-size: var(--f-caption); color: var(--text-dim); }
.vecp-field input { width: 100%; min-width: 0; box-sizing: border-box; }
.vecp-sheet .vecp { max-width: 360px; margin: 0 auto; padding-bottom: var(--sp-2); }

.k-vswatch {
  display: flex; align-items: center; gap: var(--sp-2); width: 100%; min-width: 0;
  height: 1.75rem; padding: 0 var(--sp-2); box-sizing: border-box;
  border: 1px solid var(--border); border-radius: var(--r-ctrl);
  background: var(--surface-2); color: var(--text); font: inherit; cursor: pointer;
}
.k-vswatch:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.k-vswatch-glyph { display: inline-block; color: var(--accent); line-height: 1; flex: none; }
.k-vswatch-text {
  flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  text-align: left; font-size: var(--f-caption); font-variant-numeric: tabular-nums;
}
@media (max-width: 640px), (pointer: coarse) {
  .k-vswatch { height: 2.75rem; }
}
.k-vpop {
  position: fixed; z-index: 1000; width: 296px; box-sizing: border-box;
  padding: var(--sp-4); background: var(--surface); color: var(--text);
  border: 1px solid var(--border); border-radius: var(--r-card, 12px);
  box-shadow: 0 12px 40px rgb(0 0 0 / 0.45);
  display: flex; flex-direction: column; gap: var(--sp-3);
}
.k-vpop-head { font-weight: 600; font-size: var(--f-body, 0.95rem); }
`;
