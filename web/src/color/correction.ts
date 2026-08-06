/**
 * Per-channel color correction — the web mirror of the firmware's
 * color_correction.h (firmware/player_app). The device builds 3x256 LUTs from a
 * gamma + relative-luminance profile (gamma curve + white balance to the dimmest
 * channel) and applies them on the strip write path. Reproducing the exact same
 * math here lets the UI preview and the palette simulator match what the LEDs
 * actually do, and lets the plot map a dragged point back to a gamma exponent.
 */

/** A color-correction profile: per-channel gamma and relative luminance
 * (datasheet mcd; only the ratios matter). Channel order is R, G, B. */
export interface GammaProfile {
  gamma: [number, number, number];
  luminance: [number, number, number];
}

export interface Preset {
  id: string;
  label: string;
  profile: GammaProfile;
}

/** Built-in profiles. `ws2812b` mirrors the firmware default (datasheet gamma
 * 2.8; per-channel luminance at the middle of the min..max bins). The others
 * are pure-gamma (equal luminance = no white balance) reference points. */
export const PRESETS: Preset[] = [
  {
    id: "ws2812b",
    label: "WS2812B (datasheet)",
    profile: { gamma: [2.8, 2.8, 2.8], luminance: [625, 1250, 300] },
  },
  {
    id: "gamma22",
    label: "Gamma 2.2 (sRGB-ish)",
    profile: { gamma: [2.2, 2.2, 2.2], luminance: [1, 1, 1] },
  },
  {
    id: "punchy",
    label: "Punchy (gamma 3.0)",
    profile: { gamma: [3, 3, 3], luminance: [1, 1, 1] },
  },
  {
    id: "linear",
    label: "Linear (no correction)",
    profile: { gamma: [1, 1, 1], luminance: [1, 1, 1] },
  },
];

export const DEFAULT_PROFILE: GammaProfile = PRESETS[0]!.profile;

export type ChannelLut = [Uint8Array, Uint8Array, Uint8Array];

export function cloneProfile(p: GammaProfile): GammaProfile {
  return { gamma: [...p.gamma], luminance: [...p.luminance] };
}

/** The per-channel white-balance factor: 1.0 for the dimmest channel, < 1.0 for
 * the brighter ones (scaled toward the dimmest so full white renders neutral). */
export function balanceFactors(p: GammaProfile): [number, number, number] {
  const minLum = Math.min(p.luminance[0], p.luminance[1], p.luminance[2]);
  const f = (lum: number): number => (lum > 0 ? minLum / lum : 1);
  return [f(p.luminance[0]), f(p.luminance[1]), f(p.luminance[2])];
}

/** Build the per-channel forward LUTs (out[c][v] is the corrected 8-bit output).
 * Byte-identical to the firmware build_lut: clamp(ceil((v/255)^gamma * 255 *
 * balance)). */
export function buildLut(p: GammaProfile): ChannelLut {
  const balance = balanceFactors(p);
  const out: ChannelLut = [
    new Uint8Array(256),
    new Uint8Array(256),
    new Uint8Array(256),
  ];
  for (let c = 0; c < 3; c++) {
    const g = p.gamma[c]!;
    const gamma = g > 0 ? g : 1;
    const bal = balance[c]!;
    const dst = out[c]!;
    for (let v = 0; v < 256; v++) {
      let y = Math.ceil(Math.pow(v / 255, gamma) * 255 * bal);
      if (y < 0) y = 0;
      if (y > 255) y = 255;
      dst[v] = y;
    }
  }
  return out;
}

/** Inverse of a forward channel LUT: for each output level, the smallest input
 * that reaches it (the forward curve is monotonic non-decreasing). Used by the
 * reverse palette simulator to show the correction "undone". */
export function inverseLut(fwd: Uint8Array): Uint8Array {
  const inv = new Uint8Array(256);
  let v = 0;
  for (let o = 0; o < 256; o++) {
    while (v < 255 && fwd[v]! < o) v++;
    inv[o] = v;
  }
  return inv;
}

/** Normalized transfer value the device applies for channel `c` at input x in
 * [0,1]: y = x^gamma * balance, in [0,1]. The plot draws this curve. */
export function transfer(p: GammaProfile, c: number, x: number): number {
  const g = p.gamma[c]!;
  const gamma = g > 0 ? g : 1;
  const balance = balanceFactors(p)[c]!;
  const y = Math.pow(Math.min(1, Math.max(0, x)), gamma) * balance;
  return Math.min(1, Math.max(0, y));
}

export const GAMMA_MIN = 0.2;
export const GAMMA_MAX = 6;

/** Solve the gamma exponent so input x maps to output y (both normalized) after
 * the channel's white-balance scaling: y = x^gamma * balance. Used by the plot's
 * drag interaction; clamped to a sane authoring range. */
export function gammaForPoint(x: number, y: number, balance: number): number {
  const eps = 1e-4;
  const xc = Math.min(1 - eps, Math.max(eps, x));
  const yc = Math.min(1, Math.max(eps, y / Math.max(eps, balance)));
  const g = Math.log(yc) / Math.log(xc);
  if (!Number.isFinite(g)) return 1;
  return Math.min(GAMMA_MAX, Math.max(GAMMA_MIN, g));
}

/** Does a profile match one of the presets (so the selector can reflect it)? */
export function matchPreset(p: GammaProfile): string | null {
  const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-3;
  for (const preset of PRESETS) {
    const q = preset.profile;
    if (
      q.gamma.every((g, i) => near(g, p.gamma[i]!)) &&
      q.luminance.every((l, i) => near(l, p.luminance[i]!))
    ) {
      return preset.id;
    }
  }
  return null;
}
