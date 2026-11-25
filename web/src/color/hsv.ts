/**
 * Float colour maths for the live colour picker (D-541 PR 2) and the colour
 * MIDI mapping that follows it: HSV <-> RGB with hue in TURNS (0..1, the FX
 * language's `hsv2rgb` convention), float hex parsing/formatting, and the
 * "what the LEDs show" display transform.
 *
 * Every value here is a float in 0..1; nothing quantises to 8 bits except the
 * hex text and the on-screen display bytes, which are views only.
 */

import { DEFAULT_PROFILE, type GammaProfile } from "./correction";

export type Rgb = [number, number, number];
/** Hue in turns (0..1, wraps), saturation 0..1, value 0..1. */
export type Hsv = [number, number, number];

function fract(x: number): number {
  return x - Math.floor(x);
}

export function clamp01(x: number): number {
  return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0;
}

/** HSV -> RGB (all 0..1; hue wraps). The same formula as the VM's `hsv2rgb`
 * and the keypoint blender (firmware/keypoint `hsv_to_rgb`). */
export function hsvToRgb(h: number, s: number, v: number): Rgb {
  s = clamp01(s);
  v = clamp01(v);
  const h6 = fract(Number.isFinite(h) ? h : 0) * 6;
  const sector = Math.floor(h6);
  const f = h6 - sector;
  const p = v * (1 - s);
  const q = v * (1 - s * f);
  const t = v * (1 - s * (1 - f));
  switch (sector) {
    case 0:
      return [v, t, p];
    case 1:
      return [q, v, p];
    case 2:
      return [p, v, t];
    case 3:
      return [p, q, v];
    case 4:
      return [t, p, v];
    default:
      return [v, p, q];
  }
}

/** RGB (0..1) -> HSV. A grey has no hue: it reports `prevHue` (default 0), and
 * black reports `prevSat` too, so a picker dragged through black or the grey
 * axis doesn't snap its hue/saturation back to red. */
export function rgbToHsv(r: number, g: number, b: number, prev?: { h?: number; s?: number }): Hsv {
  r = clamp01(r);
  g = clamp01(g);
  b = clamp01(b);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const s = max <= 0 ? (prev?.s ?? 0) : d / max;
  let h: number;
  if (d <= 0) h = prev?.h ?? 0;
  else if (max === r) h = (g - b) / d / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [fract(h), s, max];
}

/** `#rrggbb` (or `#rrggbbaa` with an alpha) for display/paste. */
export function toHex(rgb: readonly number[], alpha?: number): string {
  const b = (x: number): string =>
    Math.round(clamp01(x) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${b(rgb[0] ?? 0)}${b(rgb[1] ?? 0)}${b(rgb[2] ?? 0)}${alpha === undefined ? "" : b(alpha)}`;
}

/** Parse `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa` (the `#` optional, case and
 * surrounding space ignored) to floats; alpha is undefined when absent. Null
 * for anything else. */
export function parseHex(text: string): { rgb: Rgb; alpha?: number } | null {
  let t = text.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]+$/.test(t)) return null;
  if (t.length === 3 || t.length === 4) t = [...t].map((c) => c + c).join("");
  if (t.length !== 6 && t.length !== 8) return null;
  const at = (i: number): number => parseInt(t.slice(i, i + 2), 16) / 255;
  const rgb: Rgb = [at(0), at(2), at(4)];
  return t.length === 8 ? { rgb, alpha: at(6) } : { rgb };
}

// -- what the LEDs show -------------------------------------------------------
// A colour uniform is the value the effect writes; the device then applies its
// colour correction (src/color/correction.ts == firmware color_correction.h):
// light = value^gamma per channel, times a white balance that only cancels the
// LED channels' unequal brightness. So the light the strip emits for `value`
// is, relative to its own white, value^gamma. A screen emits light for an sRGB
// byte, so the swatch that LOOKS like the LED is srgbEncode(value^gamma).
// (Painting value*255 straight to the screen, as a plain colour input does,
// shows mid-tones much brighter than the strip with the default gamma 2.8.)

/** Linear light (0..1) -> an sRGB-encoded 0..1 value (IEC 61966-2-1). */
export function srgbEncode(linear: number): number {
  const x = clamp01(linear);
  return x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}

/** sRGB-encoded 0..1 -> linear light. */
export function srgbDecode(enc: number): number {
  const x = clamp01(enc);
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

/** How a uniform colour is painted on screen, one channel at a time: channel
 * c (0 R, 1 G, 2 B) at uniform value v (0..1) -> an sRGB byte 0..255. Per
 * channel so the picker can tabulate it for its per-pixel canvases. */
export type ChannelDisplay = (channel: number, v: number) => number;

/** The LED view: the screen byte that shows what the strip emits for value v
 * under `profile`'s per-channel gamma (white balance excluded: it only
 * neutralises the LEDs' unequal channel brightness, which a screen already
 * has). The default is the firmware's WS2812B profile. */
export function ledDisplay(profile: GammaProfile = DEFAULT_PROFILE): ChannelDisplay {
  const gamma = [0, 1, 2].map((c) => {
    const g = profile.gamma[c] ?? 1;
    return g > 0 && Number.isFinite(g) ? g : 1;
  });
  return (c, v) => Math.round(srgbEncode(Math.pow(clamp01(v), gamma[c] ?? 1)) * 255);
}

/** The naive view (value * 255 as an sRGB byte), what a plain colour input
 * and the map preview show. */
export const rawDisplay: ChannelDisplay = (_c, v) => Math.round(clamp01(v) * 255);

/** Display bytes for a whole colour. */
export function displayBytes(rgb: readonly number[], display: ChannelDisplay): Rgb {
  return [display(0, rgb[0] ?? 0), display(1, rgb[1] ?? 0), display(2, rgb[2] ?? 0)];
}

/** `rgb(r g b)` CSS for display bytes. */
export function cssRgb(bytes: readonly number[]): string {
  return `rgb(${bytes[0] ?? 0} ${bytes[1] ?? 0} ${bytes[2] ?? 0})`;
}
