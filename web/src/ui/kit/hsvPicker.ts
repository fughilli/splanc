/**
 * Live HSV colour picker (D-541 PR 2): a hue ring around a saturation/value
 * square on one canvas, an alpha slider for vec4 colours, and numeric H/S/V,
 * R/G/B and hex fields. Output is float (no 8-bit step anywhere on the value
 * path) and streams on every pointer move: `onInput` fires during a drag,
 * `onCommit` once when the gesture ends.
 *
 * `ColorSwatch` wraps it for forms: a swatch button that opens the picker in a
 * bottom Sheet on phones and in an inline popover on desktop.
 *
 * The canvases and swatches are painted through a {@link ChannelDisplay}, by
 * default the active device's LED view (src/color/hsv.ts), so the colour on
 * screen is the colour the strip emits, not value*255.
 */

import { Sheet } from "./index";
import {
  clamp01,
  cssRgb,
  displayBytes,
  hsvToRgb,
  parseHex,
  rgbToHsv,
  toHex,
  type ChannelDisplay,
  type Hsv,
  type Rgb,
} from "../../color/hsv";
import { activeLedDisplay } from "../../color/activeProfile";

export interface HsvPickerOpts {
  /** RGB or RGBA floats 0..1. */
  value: readonly number[];
  /** Show the alpha slider/field (a vec4 colour). */
  alpha?: boolean;
  /** How colours are painted; default: the active device's LED view. */
  display?: ChannelDisplay;
  /** Canvas CSS size (px) when the layout reports none. Default 240. */
  size?: number;
  /** Every live change (pointer move, field edit). Full width: 3 or 4 floats. */
  onInput: (value: number[]) => void;
  /** Once at the end of a gesture / field edit. */
  onCommit?: (value: number[]) => void;
}

export interface HsvPickerHandle {
  el: HTMLElement;
  /** Move the picker from outside (MIDI, the agent, hydration) without firing. */
  set: (value: readonly number[]) => void;
  value: () => number[];
  /** Redraw at the current layout size (after the picker became visible). */
  redraw: () => void;
}

const LUT_N = 1024;
const TAU = Math.PI * 2;

/** Hue (turns) of a point relative to the centre: red at the top, clockwise. */
export function hueAt(dx: number, dy: number): number {
  const a = Math.atan2(dx, -dy) / TAU;
  return a - Math.floor(a);
}

/** Ring / square geometry for an N-pixel canvas (device pixels). */
export function wheelGeometry(n: number): { c: number; ro: number; ri: number; half: number } {
  const c = n / 2;
  const ro = c - Math.max(1, n * 0.005);
  const ri = ro - n * 0.11;
  const half = (ri - n * 0.04) / Math.SQRT2;
  return { c, ro, ri, half };
}

function fmt(v: number, dp = 4): string {
  if (!Number.isFinite(v)) return "0";
  const k = 10 ** dp;
  return String(Math.round(v * k) / k);
}

export function HsvPicker(opts: HsvPickerOpts): HsvPickerHandle {
  installHsvStyles();
  const display = opts.display ?? activeLedDisplay();
  const lut = [0, 1, 2].map((c) => {
    const t = new Uint8Array(LUT_N + 1);
    for (let i = 0; i <= LUT_N; i++) t[i] = display(c, i / LUT_N);
    return t;
  }) as [Uint8Array, Uint8Array, Uint8Array];
  const px = (c: 0 | 1 | 2, v: number): number => lut[c][Math.round(clamp01(v) * LUT_N)] ?? 0;

  let rgb: Rgb = [clamp01(opts.value[0] ?? 0), clamp01(opts.value[1] ?? 0), clamp01(opts.value[2] ?? 0)];
  let hsv: Hsv = rgbToHsv(rgb[0], rgb[1], rgb[2]);
  let alpha = clamp01(opts.value[3] ?? 1);
  const hasAlpha = opts.alpha === true;
  const value = (): number[] => (hasAlpha ? [...rgb, alpha] : [...rgb]);

  const el = document.createElement("div");
  el.className = "hsvp";

  // -- wheel canvas -----------------------------------------------------------
  const canvas = document.createElement("canvas");
  canvas.className = "hsvp-canvas";
  canvas.tabIndex = 0;
  canvas.setAttribute("role", "slider");
  canvas.setAttribute("aria-label", "Colour: hue ring and saturation/value square. Arrow keys: left/right hue, up/down value.");

  let n = 0; // canvas size in device pixels
  let ring: ImageData | null = null; // the hue ring, cached per size
  let frame: ImageData | null = null; // ring + SV square for the current hue
  let frameHue = Number.NaN;

  function ensureSize(): CanvasRenderingContext2D | null {
    const css = canvas.clientWidth || opts.size || 240;
    const dpr = Math.min(2, (typeof devicePixelRatio === "number" && devicePixelRatio) || 1);
    const want = Math.max(64, Math.round(css * dpr));
    if (want !== n) {
      n = want;
      canvas.width = n;
      canvas.height = n;
      ring = null;
      frame = null;
    }
    return canvas.getContext("2d");
  }

  function buildRing(ctx: CanvasRenderingContext2D): ImageData {
    const img = ctx.createImageData(n, n);
    const { c, ro, ri } = wheelGeometry(n);
    const d = img.data;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const dx = x + 0.5 - c;
        const dy = y + 0.5 - c;
        const r = Math.sqrt(dx * dx + dy * dy);
        const cover = Math.min(r - ri, ro - r) + 0.5; // 1-px anti-aliased edges
        if (cover <= 0) continue;
        const [cr, cg, cb] = hsvToRgb(hueAt(dx, dy), 1, 1);
        const o = (y * n + x) * 4;
        d[o] = px(0, cr);
        d[o + 1] = px(1, cg);
        d[o + 2] = px(2, cb);
        d[o + 3] = Math.round(Math.min(1, cover) * 255);
      }
    }
    return img;
  }

  function buildFrame(ctx: CanvasRenderingContext2D): ImageData {
    if (ring === null) ring = buildRing(ctx);
    const img = ctx.createImageData(n, n);
    img.data.set(ring.data);
    const { c, half } = wheelGeometry(n);
    const x0 = Math.ceil(c - half);
    const x1 = Math.floor(c + half);
    const span = Math.max(1, x1 - x0);
    const d = img.data;
    for (let y = x0; y <= x1; y++) {
      const v = 1 - (y - x0) / span;
      for (let x = x0; x <= x1; x++) {
        const [cr, cg, cb] = hsvToRgb(hsv[0], (x - x0) / span, v);
        const o = (y * n + x) * 4;
        d[o] = px(0, cr);
        d[o + 1] = px(1, cg);
        d[o + 2] = px(2, cb);
        d[o + 3] = 255;
      }
    }
    frameHue = hsv[0];
    return img;
  }

  function marker(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, fill: string): void {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.lineWidth = Math.max(1.5, n * 0.008);
    ctx.strokeStyle = "#fff";
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, r + ctx.lineWidth, 0, TAU);
    ctx.lineWidth = Math.max(1, n * 0.004);
    ctx.strokeStyle = "rgb(0 0 0 / 0.6)";
    ctx.stroke();
  }

  function draw(): void {
    const ctx = ensureSize();
    if (!ctx) return;
    if (frame === null || frameHue !== hsv[0]) frame = buildFrame(ctx);
    ctx.putImageData(frame, 0, 0);
    const { c, ro, ri, half } = wheelGeometry(n);
    const a = hsv[0] * TAU;
    const rm = (ro + ri) / 2;
    const hueCss = cssRgb(displayBytes(hsvToRgb(hsv[0], 1, 1), display));
    marker(ctx, c + rm * Math.sin(a), c - rm * Math.cos(a), (ro - ri) * 0.36, hueCss);
    const sx = c - half + hsv[1] * 2 * half;
    const sy = c - half + (1 - hsv[2]) * 2 * half;
    marker(ctx, sx, sy, n * 0.035, cssRgb(displayBytes(rgb, display)));
  }

  // -- pointer: ring = hue, square = saturation/value -------------------------
  let drag: "ring" | "square" | null = null;
  function local(e: PointerEvent): { dx: number; dy: number } {
    const r = canvas.getBoundingClientRect();
    const w = r.width || n || 1;
    const h = r.height || n || 1;
    return { dx: ((e.clientX - r.left) / w) * n - n / 2, dy: ((e.clientY - r.top) / h) * n - n / 2 };
  }
  function applyPointer(e: PointerEvent): void {
    const { dx, dy } = local(e);
    if (drag === "ring") {
      hsv = [hueAt(dx, dy), hsv[1], hsv[2]];
    } else if (drag === "square") {
      const { half } = wheelGeometry(n);
      hsv = [hsv[0], clamp01((dx + half) / (2 * half)), clamp01(1 - (dy + half) / (2 * half))];
    }
    rgb = hsvToRgb(hsv[0], hsv[1], hsv[2]);
    changed();
  }
  canvas.addEventListener("pointerdown", (e) => {
    ensureSize();
    const { dx, dy } = local(e);
    const { ri, ro } = wheelGeometry(n);
    const r = Math.sqrt(dx * dx + dy * dy);
    if (r > ro + n * 0.02) return; // outside the wheel
    drag = r >= ri - n * 0.02 ? "ring" : "square";
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointer */
    }
    e.preventDefault();
    applyPointer(e);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (drag !== null) applyPointer(e);
  });
  const endDrag = (): void => {
    if (drag === null) return;
    drag = null;
    opts.onCommit?.(value());
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  canvas.addEventListener("keydown", (e) => {
    const big = e.shiftKey ? 10 : 1;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      const dh = ((e.key === "ArrowRight" ? 1 : -1) * big) / 360;
      hsv = [hsv[0] + dh - Math.floor(hsv[0] + dh), hsv[1], hsv[2]];
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      hsv = [hsv[0], hsv[1], clamp01(hsv[2] + ((e.key === "ArrowUp" ? 1 : -1) * big) / 100)];
    } else return;
    e.preventDefault();
    rgb = hsvToRgb(hsv[0], hsv[1], hsv[2]);
    changed();
    opts.onCommit?.(value());
  });

  // -- preview strip ----------------------------------------------------------
  const preview = document.createElement("div");
  preview.className = "hsvp-preview";
  const previewFill = document.createElement("span");
  previewFill.className = "hsvp-preview-fill";
  const previewNote = document.createElement("span");
  previewNote.className = "hsvp-preview-note";
  previewNote.textContent = "As the LEDs show it";
  preview.append(previewFill, previewNote);

  // -- numeric fields ---------------------------------------------------------
  interface NumField {
    input: HTMLInputElement;
    get: () => number;
    put: (v: number) => void;
    dp: number;
  }
  const fields: NumField[] = [];
  const fieldGrid = document.createElement("div");
  fieldGrid.className = "hsvp-fields";
  function numField(label: string, max: number, dp: number, get: () => number, put: (v: number) => void): void {
    const wrap = document.createElement("label");
    wrap.className = "hsvp-field";
    const name = document.createElement("span");
    name.textContent = label;
    const input = document.createElement("input");
    input.type = "number";
    input.min = "0";
    input.max = String(max);
    input.step = "any";
    input.inputMode = "decimal";
    input.value = fmt(get(), dp);
    input.addEventListener("change", () => {
      // An unedited field (the rounded label) keeps the exact live value.
      if (input.value === fmt(get(), dp)) return;
      const typed = parseFloat(input.value);
      if (!Number.isFinite(typed)) {
        input.value = fmt(get(), dp);
        return;
      }
      put(Math.min(max, Math.max(0, typed)));
      changed();
      opts.onCommit?.(value());
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        input.blur();
      }
    });
    wrap.append(name, input);
    fieldGrid.appendChild(wrap);
    fields.push({ input, get, put, dp });
  }
  const setHsv = (i: 0 | 1 | 2, v: number): void => {
    const next: Hsv = [hsv[0], hsv[1], hsv[2]];
    next[i] = v;
    hsv = next;
    rgb = hsvToRgb(hsv[0], hsv[1], hsv[2]);
  };
  const setRgb = (i: 0 | 1 | 2, v: number): void => {
    const next: Rgb = [rgb[0], rgb[1], rgb[2]];
    next[i] = v;
    rgb = next;
    hsv = rgbToHsv(rgb[0], rgb[1], rgb[2], { h: hsv[0], s: hsv[1] });
  };
  numField("H°", 360, 2, () => hsv[0] * 360, (v) => setHsv(0, (v % 360) / 360));
  numField("S", 1, 4, () => hsv[1], (v) => setHsv(1, v));
  numField("V", 1, 4, () => hsv[2], (v) => setHsv(2, v));
  numField("R", 1, 4, () => rgb[0], (v) => setRgb(0, v));
  numField("G", 1, 4, () => rgb[1], (v) => setRgb(1, v));
  numField("B", 1, 4, () => rgb[2], (v) => setRgb(2, v));

  // -- alpha + hex ------------------------------------------------------------
  const extra = document.createElement("div");
  extra.className = "hsvp-extra";
  let alphaRange: HTMLInputElement | null = null;
  if (hasAlpha) {
    const wrap = document.createElement("label");
    wrap.className = "hsvp-alpha";
    const name = document.createElement("span");
    name.textContent = "Alpha";
    alphaRange = document.createElement("input");
    alphaRange.type = "range";
    alphaRange.min = "0";
    alphaRange.max = "1";
    alphaRange.step = "any";
    alphaRange.value = String(alpha);
    const ar = alphaRange;
    ar.addEventListener("input", () => {
      alpha = clamp01(parseFloat(ar.value));
      changed();
    });
    ar.addEventListener("change", () => opts.onCommit?.(value()));
    wrap.append(name, alphaRange);
    extra.appendChild(wrap);
    numField("A", 1, 4, () => alpha, (v) => (alpha = v));
  }
  const hexWrap = document.createElement("label");
  hexWrap.className = "hsvp-hex";
  const hexName = document.createElement("span");
  hexName.textContent = "Hex";
  const hex = document.createElement("input");
  hex.type = "text";
  hex.spellcheck = false;
  hex.autocomplete = "off";
  hex.className = "hsvp-hex-input";
  hex.title = "Paste #rgb, #rrggbb or #rrggbbaa";
  const hexText = (): string => toHex(rgb, hasAlpha ? alpha : undefined);
  hex.value = hexText();
  hex.addEventListener("change", () => {
    // The hex is 8-bit text: it only replaces the colour when it was edited.
    if (hex.value.trim().toLowerCase() === hexText()) return;
    const p = parseHex(hex.value);
    if (p === null) {
      hex.value = hexText();
      return;
    }
    rgb = p.rgb;
    hsv = rgbToHsv(rgb[0], rgb[1], rgb[2], { h: hsv[0], s: hsv[1] });
    if (hasAlpha && p.alpha !== undefined) alpha = p.alpha;
    changed();
    opts.onCommit?.(value());
  });
  hex.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      hex.blur();
    }
  });
  hexWrap.append(hexName, hex);
  extra.appendChild(hexWrap);

  el.append(canvas, preview, fieldGrid, extra);

  // -- sync -------------------------------------------------------------------
  function refresh(): void {
    const focused = typeof document !== "undefined" ? document.activeElement : null;
    previewFill.style.background = cssRgb(displayBytes(rgb, display));
    previewFill.style.opacity = hasAlpha ? String(alpha) : "1";
    for (const f of fields) {
      if (f.input === focused) continue;
      f.input.value = fmt(f.get(), f.dp);
    }
    if (hex !== focused) hex.value = hexText();
    if (alphaRange && alphaRange !== focused) alphaRange.value = String(alpha);
    draw();
  }
  function changed(): void {
    refresh();
    opts.onInput(value());
  }

  refresh();
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(() => draw()).observe(canvas);
  }

  return {
    el,
    value,
    redraw: draw,
    set(v) {
      rgb = [clamp01(v[0] ?? 0), clamp01(v[1] ?? 0), clamp01(v[2] ?? 0)];
      hsv = rgbToHsv(rgb[0], rgb[1], rgb[2], { h: hsv[0], s: hsv[1] });
      if (v[3] !== undefined) alpha = clamp01(v[3]);
      if (drag === null) refresh();
    },
  };
}

// -- ColorSwatch: swatch + Sheet (phone) / popover (desktop) -----------------

export interface ColorSwatchOpts {
  value: readonly number[];
  alpha?: boolean;
  /** Sheet / popover title (the uniform's name). */
  title: string;
  display?: ChannelDisplay;
  onInput: (value: number[]) => void;
  onCommit?: (value: number[]) => void;
}

export interface ColorSwatchHandle {
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

export function ColorSwatch(opts: ColorSwatchOpts): ColorSwatchHandle {
  installHsvStyles();
  let cur = opts.value.slice();
  const hasAlpha = opts.alpha === true;
  const display = (): ChannelDisplay => opts.display ?? activeLedDisplay();
  let shownDisplay = display();

  const el = document.createElement("button");
  el.type = "button";
  el.className = "k-cswatch";
  el.title = `${opts.title}: tap to pick a colour`;
  el.setAttribute("aria-haspopup", "dialog");
  const fill = document.createElement("span");
  fill.className = "k-cswatch-fill";
  el.appendChild(fill);
  const paint = (): void => {
    fill.style.background = cssRgb(displayBytes(cur, shownDisplay));
    fill.style.opacity = hasAlpha ? String(clamp01(cur[3] ?? 1)) : "1";
  };
  paint();

  let picker: HsvPickerHandle | null = null;
  let closeFn: (() => void) | null = null;

  const pickerOpts = (): HsvPickerOpts => ({
    value: cur,
    alpha: hasAlpha,
    display: shownDisplay,
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
    sheet.body.classList.add("hsvp-sheet");
    picker = HsvPicker({ ...pickerOpts(), size: 300 });
    sheet.body.appendChild(picker.el);
    closeFn = sheet.close;
    requestAnimationFrame(() => picker?.redraw());
  }

  function openPopover(): void {
    const pop = document.createElement("div");
    pop.className = "k-cpop";
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", opts.title);
    const head = document.createElement("div");
    head.className = "k-cpop-head";
    head.textContent = opts.title;
    picker = HsvPicker({ ...pickerOpts(), size: 240 });
    pop.append(head, picker.el);
    document.body.appendChild(pop);
    const place = (): void => {
      const r = el.getBoundingClientRect();
      const vw = typeof innerWidth === "number" ? innerWidth : 1280;
      const vh = typeof innerHeight === "number" ? innerHeight : 800;
      const pw = pop.offsetWidth || 280;
      const ph = pop.offsetHeight || 460;
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
    shownDisplay = display();
    paint();
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
function installHsvStyles(): void {
  if (stylesInstalled || typeof document === "undefined") return;
  stylesInstalled = true;
  const s = document.createElement("style");
  s.textContent = HSV_CSS;
  document.head.appendChild(s);
}

const CHECKER =
  "repeating-conic-gradient(rgb(255 255 255 / 0.16) 0% 25%, rgb(0 0 0 / 0.2) 0% 50%) 50% / 12px 12px";

const HSV_CSS = `
.hsvp { display: flex; flex-direction: column; gap: var(--sp-3); width: 100%; }
.hsvp-canvas {
  display: block; width: 100%; max-width: 300px; aspect-ratio: 1 / 1;
  margin: 0 auto; touch-action: none; cursor: crosshair; border-radius: 50%;
}
.hsvp-canvas:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; }
.hsvp-preview {
  position: relative; display: flex; align-items: center; justify-content: flex-end;
  height: 2.5rem; border: 1px solid var(--border); border-radius: var(--r-ctrl);
  background: ${CHECKER}; overflow: hidden;
}
.hsvp-preview-fill { position: absolute; inset: 0; }
.hsvp-preview-note {
  position: relative; margin-right: var(--sp-2); padding: 2px var(--sp-2);
  font-size: var(--f-caption); border-radius: var(--r-ctrl);
  background: rgb(0 0 0 / 0.55); color: #fff;
}
.hsvp-fields { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--sp-2); }
.hsvp-field, .hsvp-hex, .hsvp-alpha { display: flex; flex-direction: column; gap: var(--sp-1); min-width: 0; }
.hsvp-field span, .hsvp-hex span, .hsvp-alpha span { font-size: var(--f-caption); color: var(--text-dim); }
.hsvp-field input, .hsvp-hex input { width: 100%; min-width: 0; box-sizing: border-box; }
.hsvp-extra { display: flex; flex-direction: column; gap: var(--sp-3); }
.hsvp-alpha input[type="range"] { width: 100%; margin: 0; }
.hsvp-hex-input { font-family: var(--font-mono, ui-monospace, monospace); }
.hsvp-sheet .hsvp { max-width: 360px; margin: 0 auto; padding-bottom: var(--sp-2); }

.k-cswatch {
  position: relative; display: block; width: 100%; height: 1.5rem; padding: 0;
  border: 1px solid var(--border); border-radius: var(--r-ctrl); overflow: hidden;
  background: ${CHECKER}; cursor: pointer;
}
.k-cswatch:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.k-cswatch-fill { position: absolute; inset: 0; }
@media (max-width: 640px), (pointer: coarse) {
  .k-cswatch { height: 2.75rem; }
}
.k-cpop {
  position: fixed; z-index: 1000; width: 280px; box-sizing: border-box;
  padding: var(--sp-4); background: var(--surface); color: var(--text);
  border: 1px solid var(--border); border-radius: var(--r-card, 12px);
  box-shadow: 0 12px 40px rgb(0 0 0 / 0.45);
  display: flex; flex-direction: column; gap: var(--sp-3);
}
.k-cpop-head { font-weight: 600; font-size: var(--f-body, 0.95rem); }
`;
