/**
 * Adaptive diffuse-spot detector — the reference implementation.
 *
 * A diffuser (rope, tube, frosted cover) spreads each LED into a soft spot
 * ~15-30 px across. The legacy diffuse prefilter (detect.ts `localContrast`: a
 * 5x5 top-hat at ±8 detection px + a FIXED threshold of 0.18) fails on it in two
 * ways, measured on a 250-LED rope against exact single-LED centres
 * (web/tests/testdata/diffuse_rope): its background window is about the size of
 * a spot, so it subtracts the spot from itself, and its fixed threshold sits
 * above every spot at short exposure (0-15% recall at exposure <= 0.35) while
 * fragmenting bright frames on the diffuser's weave texture (~10 extra blobs per
 * frame). This detector instead:
 *
 *   1. smooths at the SPOT scale (a separable gaussian) and subtracts a ~4x
 *      wider background (3-pass box ≈ gaussian, computed at quarter resolution
 *      and upsampled bilinearly), per colour channel;
 *   2. keeps a pixel when its max-channel response clears BOTH
 *        - a per-frame NOISE FLOOR, median + kSigma x 1.4826 x MAD of the signed
 *          response over a decimated sample of the frame (so the threshold
 *          follows exposure, sensor gain and ambient texture), and
 *        - peakFrac x the LOCAL PEAK (a square max filter), which cuts touching
 *          neighbours apart at their saddle;
 *   3. writes the detect buffer the shared CCL stage expects (detect.ts
 *      reducedToBlobs): alpha = the RAW reduced max-channel luminance (so blob
 *      intensity / peak / satFrac keep the meaning the brightness and exposure
 *      servos were built on), rgb = the SPOT-scale smoothed colour rescaled to
 *      that luminance. Not the background-subtracted colour: subtracting
 *      the background (which carries the neighbours' code colours) and clamping
 *      per channel skews two-channel hues — magenta read right 48% of the time
 *      vs 71% for the smoothed colour, which sank 4-symbol decoding.
 *
 * The WebGL path (detect.ts) and the iOS native reducer (FrameReducer.swift) are
 * ports of THIS file and must stay numerically equivalent: same box radii, same
 * clamp-to-edge borders, same quarter-res background and bilinear upsample, same
 * decimated stats sample, same noise-floor formula ({@link noiseFloor}, which the
 * GL path calls directly). The one deliberate difference: the GL path applies the
 * PREVIOUS frame's noise floor (reading the statistic back mid-frame would add a
 * second GPU sync per frame); the floor moves at scene speed, not frame speed.
 */

/** Tuned on the 2026-11-18 rope sweep (web/tests/testdata/diffuse_rope). Radii
 * are in DETECTION pixels (after the 2x reduce). */
export interface AdaptiveDiffuseParams {
  /** Gaussian sigma of the spot-scale blur (one separable pass, radius
   * ceil(3 sigma)); 2.45 matches the 3-pass radius-2 box it was tuned with. */
  spotSigma: number;
  /** The background blur runs at 1/bgScale of detection resolution (it is
   * low-frequency, and blurring it there is what keeps the GPU pass cheap):
   * a bgScale x bgScale box downsample, 3 box passes of radius bgBoxRadius, then
   * a bilinear upsample. */
  bgScale: number;
  /** Box radius of the background blur, in DOWNSAMPLED px (3 passes). */
  bgBoxRadius: number;
  /** Half-width of the square local-peak window. */
  peakRadius: number;
  /** Noise floor = median + kSigma x robust sigma of the response. */
  kSigma: number;
  /** A pixel must reach this fraction of its local peak. */
  peakFrac: number;
  /** The noise statistics sample every statStride-th pixel in x and y. */
  statStride: number;
}

export const DEFAULT_ADAPTIVE_DIFFUSE: AdaptiveDiffuseParams = {
  spotSigma: 2.45,
  bgScale: 4,
  bgBoxRadius: 3,
  peakRadius: 10,
  kSigma: 20,
  peakFrac: 0.6,
  statStride: 4,
};

/** Robust sigma never collapses below this (an all-black frame has MAD 0, and a
 * zero floor would pass every speck of sensor noise). In [0,1] luma units —
 * ~0.03 DN: far below real sensor noise after the blurs, so it only guards the
 * degenerate frame (a floor of 1/1024 measurably cost half the short-exposure
 * recall on the rope sweep). */
export const NOISE_SIGMA_MIN = 1e-4;

export interface NoiseFloor {
  median: number;
  sigma: number;
  floor: number;
}

/** The k-th smallest element of `a` (reorders `a`; Hoare quickselect, O(n)) —
 * exactly what sorting and indexing `[k]` would give, without the sort. */
export function selectKth(a: Float32Array, k: number): number {
  let lo = 0;
  let hi = a.length - 1;
  while (lo < hi) {
    const pivot = a[(lo + hi) >> 1]!;
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (a[i]! < pivot) i++;
      while (a[j]! > pivot) j--;
      if (i <= j) {
        const t = a[i]!;
        a[i] = a[j]!;
        a[j] = t;
        i++;
        j--;
      }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else return a[k]!;
  }
  return a[k]!;
}

/**
 * The per-frame noise floor from a sample of the SIGNED spot response
 * (max over channels of spot - background). Reorders `sample` in place.
 */
export function noiseFloor(sample: Float32Array, kSigma: number): NoiseFloor {
  const n = sample.length;
  if (n === 0) return { median: 0, sigma: NOISE_SIGMA_MIN, floor: kSigma * NOISE_SIGMA_MIN };
  const median = selectKth(sample, n >> 1);
  for (let i = 0; i < n; i++) sample[i] = Math.abs(sample[i]! - median);
  const sigma = Math.max(NOISE_SIGMA_MIN, 1.4826 * selectKth(sample, n >> 1));
  return { median, sigma, floor: median + kSigma * sigma };
}

/** One horizontal box pass, clamp-to-edge (the GL path samples with texelFetch
 * at clamped coordinates — the same border). */
function boxH(src: Float32Array, dst: Float32Array, w: number, h: number, r: number): void {
  const n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let s = 0;
    for (let i = -r; i <= r; i++) s += src[row + Math.min(w - 1, Math.max(0, i))]!;
    for (let x = 0; x < w; x++) {
      dst[row + x] = s / n;
      s += src[row + Math.min(w - 1, x + r + 1)]! - src[row + Math.max(0, x - r)]!;
    }
  }
}

function boxV(src: Float32Array, dst: Float32Array, w: number, h: number, r: number): void {
  const n = 2 * r + 1;
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let i = -r; i <= r; i++) s += src[Math.min(h - 1, Math.max(0, i)) * w + x]!;
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = s / n;
      s += src[Math.min(h - 1, y + r + 1) * w + x]! - src[Math.max(0, y - r) * w + x]!;
    }
  }
}

/** Three H+V box passes (≈ gaussian). Returns a new plane. */
export function box3(plane: Float32Array, w: number, h: number, r: number): Float32Array {
  let a = Float32Array.from(plane);
  let b = new Float32Array(plane.length);
  for (let pass = 0; pass < 3; pass++) {
    boxH(a, b, w, h, r);
    boxV(b, a, w, h, r);
  }
  return a;
}

/** Box-downsample a plane by `k` (output ceil(w/k) x ceil(h/k); each output
 * texel averages its k x k source block, source coordinates clamped). */
export function downsamplePlane(plane: Float32Array, w: number, h: number, k: number): { q: Float32Array; qw: number; qh: number } {
  const qw = Math.ceil(w / k);
  const qh = Math.ceil(h / k);
  const q = new Float32Array(qw * qh);
  for (let qy = 0; qy < qh; qy++) {
    for (let qx = 0; qx < qw; qx++) {
      let s = 0;
      for (let j = 0; j < k; j++) {
        const y = Math.min(h - 1, qy * k + j);
        for (let i = 0; i < k; i++) s += plane[y * w + Math.min(w - 1, qx * k + i)]!;
      }
      q[qy * qw + qx] = s / (k * k);
    }
  }
  return { q, qw, qh };
}

/** Bilinear sample of a qw x qh plane at the centre of full-size texel (x, y) of a
 * w x h grid — GL's LINEAR filter with clamp-to-edge (texel centres at +0.5). */
export function upsampleAt(q: Float32Array, qw: number, qh: number, w: number, h: number, x: number, y: number): number {
  const fx = Math.min(qw - 1, Math.max(0, ((x + 0.5) * qw) / w - 0.5));
  const fy = Math.min(qh - 1, Math.max(0, ((y + 0.5) * qh) / h - 0.5));
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const x1 = Math.min(qw - 1, x0 + 1), y1 = Math.min(qh - 1, y0 + 1);
  const ax = fx - x0, ay = fy - y0;
  const a = q[y0 * qw + x0]!, b = q[y0 * qw + x1]!, c = q[y1 * qw + x0]!, d = q[y1 * qw + x1]!;
  return (a * (1 - ax) + b * ax) * (1 - ay) + (c * (1 - ax) + d * ax) * ay;
}

/** Normalised discrete gaussian taps for `sigma`, radius ceil(3 sigma): w[0..r]
 * (symmetric). The GL and Swift ports use these exact weights. */
export function gaussTaps(sigma: number): Float32Array {
  const r = Math.ceil(3 * sigma);
  const w = new Float32Array(r + 1);
  let sum = 0;
  for (let i = 0; i <= r; i++) {
    w[i] = Math.exp(-(i * i) / (2 * sigma * sigma));
    sum += i === 0 ? w[i]! : 2 * w[i]!;
  }
  for (let i = 0; i <= r; i++) w[i] = w[i]! / sum;
  return w;
}

/** Separable gaussian (H then V), clamp-to-edge. Returns a new plane. */
export function gaussBlur(plane: Float32Array, w: number, h: number, taps: Float32Array): Float32Array {
  const r = taps.length - 1;
  const t = new Float32Array(plane.length);
  const o = new Float32Array(plane.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) s += taps[Math.abs(i)]! * plane[y * w + Math.min(w - 1, Math.max(0, x + i))]!;
      t[y * w + x] = s;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let s = 0;
      for (let i = -r; i <= r; i++) s += taps[Math.abs(i)]! * t[Math.min(h - 1, Math.max(0, y + i)) * w + x]!;
      o[y * w + x] = s;
    }
  }
  return o;
}

/** Square max filter (separable: H then V), clamp-to-edge. */
export function maxFilter(plane: Float32Array, w: number, h: number, r: number): Float32Array {
  const t = new Float32Array(plane.length);
  const o = new Float32Array(plane.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = -Infinity;
      for (let i = Math.max(0, x - r), e = Math.min(w - 1, x + r); i <= e; i++) {
        const v = plane[y * w + i]!;
        if (v > m) m = v;
      }
      t[y * w + x] = m;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let m = -Infinity;
      for (let i = Math.max(0, y - r), e = Math.min(h - 1, y + r); i <= e; i++) {
        const v = t[i * w + x]!;
        if (v > m) m = v;
      }
      o[y * w + x] = m;
    }
  }
  return o;
}

/** The decimated statistics sample: the signed response at (sx*stride, sy*stride). */
export function statSample(resp: Float32Array, w: number, h: number, stride: number): Float32Array {
  const sw = Math.ceil(w / stride);
  const sh = Math.ceil(h / stride);
  const out = new Float32Array(sw * sh);
  for (let sy = 0; sy < sh; sy++) for (let sx = 0; sx < sw; sx++) out[sy * sw + sx] = resp[sy * stride * w + sx * stride]!;
  return out;
}

export interface AdaptiveDiffuseResult {
  /** RGBA8 detect buffer for reducedToBlobs (row 0 = the input's row 0). */
  detect: Uint8Array;
  noise: NoiseFloor;
}

/**
 * Run the adaptive diffuse detector over an already-reduced RGB image (detection
 * resolution, interleaved RGB in [0,1], `w`x`h`).
 */
export function adaptiveDiffuseReduce(
  rgb: Float32Array,
  w: number,
  h: number,
  p: AdaptiveDiffuseParams = DEFAULT_ADAPTIVE_DIFFUSE,
): AdaptiveDiffuseResult {
  const n = w * h;
  const plane = new Float32Array(n);
  const spot: Float32Array[] = [];
  const resp = new Float32Array(n).fill(-Infinity);
  const raw = new Float32Array(n);
  for (let i = 0; i < n; i++) raw[i] = Math.max(rgb[i * 3]!, rgb[i * 3 + 1]!, rgb[i * 3 + 2]!);
  const taps = gaussTaps(p.spotSigma);
  for (let c = 0; c < 3; c++) {
    for (let i = 0; i < n; i++) plane[i] = rgb[i * 3 + c]!;
    const s = gaussBlur(plane, w, h, taps);
    const { q, qw, qh } = downsamplePlane(plane, w, h, p.bgScale);
    const bgq = box3(q, qw, qh, p.bgBoxRadius);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        // Signed max-channel response: spot - background.
        const d = s[i]! - upsampleAt(bgq, qw, qh, w, h, x, y);
        if (d > resp[i]!) resp[i] = d;
      }
    }
    spot.push(s);
  }
  const noise = noiseFloor(statSample(resp, w, h, p.statStride), p.kSigma);
  const clamped = new Float32Array(n);
  for (let i = 0; i < n; i++) clamped[i] = Math.max(0, resp[i]!);
  const peak = maxFilter(clamped, w, h, p.peakRadius);
  const detect = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const r = clamped[i]!;
    if (!(r >= noise.floor && r >= p.peakFrac * peak[i]!)) continue;
    const sr = Math.max(0, spot[0]![i]!), sg = Math.max(0, spot[1]![i]!), sb = Math.max(0, spot[2]![i]!);
    encodePixel(detect, i, sr, sg, sb, Math.max(sr, sg, sb), raw[i]!);
  }
  return { detect, noise };
}

/**
 * The output encoding (shared with the GL final pass): alpha = raw luminance
 * (never 0 for a kept pixel, since CCL reads 0 as background), rgb = the colour
 * (dr, dg, db) scaled so its max channel (`cmax`) equals that luminance.
 */
export function encodePixel(out: Uint8Array, i: number, dr: number, dg: number, db: number, cmax: number, rawLum: number): void {
  const lum = Math.min(1, Math.max(1 / 255, rawLum));
  const k = cmax > 0 ? lum / cmax : 0;
  out[i * 4] = Math.round(Math.min(1, dr * k) * 255);
  out[i * 4 + 1] = Math.round(Math.min(1, dg * k) * 255);
  out[i * 4 + 2] = Math.round(Math.min(1, db * k) * 255);
  out[i * 4 + 3] = Math.max(1, Math.round(lum * 255));
}

/** Box-reduce full-resolution interleaved RGB8 (rows top-down) by `ds` — the GL
 * path's LINEAR-filtered sample at ds = 2, and the iOS reducer's box filter. */
export function boxReduceRgb8(src: Uint8Array | Uint8ClampedArray, W: number, H: number, ds: number, channels = 3): { rgb: Float32Array; w: number; h: number } {
  const w = Math.floor(W / ds);
  const h = Math.floor(H / ds);
  const rgb = new Float32Array(w * h * 3);
  const norm = 1 / (255 * ds * ds);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0;
      for (let yy = 0; yy < ds; yy++) {
        for (let xx = 0; xx < ds; xx++) {
          const o = ((y * ds + yy) * W + x * ds + xx) * channels;
          r += src[o]!; g += src[o + 1]!; b += src[o + 2]!;
        }
      }
      const o = (y * w + x) * 3;
      rgb[o] = r * norm; rgb[o + 1] = g * norm; rgb[o + 2] = b * norm;
    }
  }
  return { rgb, w, h };
}

/**
 * The params for a detector running at `downscale` (radii are tuned at 2, in
 * detection px): scales the blur, peak and stats radii so they span the same
 * IMAGE distance. A stored capture profile can carry any downscale.
 */
export function adaptiveParamsForDownscale(p: AdaptiveDiffuseParams, downscale: number): AdaptiveDiffuseParams {
  if (downscale === 2) return p;
  const k = 2 / Math.max(1, downscale);
  const r = (v: number): number => Math.max(1, Math.round(v * k));
  // The background keeps its radius and scales its decimation instead, so it
  // still spans the same image distance.
  return { ...p, spotSigma: p.spotSigma * k, bgScale: r(p.bgScale), peakRadius: r(p.peakRadius), statStride: r(p.statStride) };
}
