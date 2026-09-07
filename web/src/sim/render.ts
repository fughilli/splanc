/**
 * Image-space diffuse-capture simulator (design: diffuse_capture plan §"Stage A").
 *
 * The existing simulators (shared/simulator, tools/sim_studio) short-circuit to
 * DetectionRecords and never render pixels, so they can't exercise the real blob
 * detector. This one renders an actual camera frame — Gaussian LED spots splatted
 * by the production pinhole projection, then a screen-space BLOOM that reproduces
 * both diffuser symptoms (neighbor color bleed AND the DC lift that flattens the
 * luma derivative) — then reduces it to the exact RGBA layout detect.ts's shader
 * produces, so the real {@link reducedToBlobs} → CvPipeline runs on it unchanged.
 *
 * Pure TS (no WebGL): the reduce mirrors the fragment shader on the CPU, which is
 * also where the diffuse-mode `localContrast` prefilter lives so Stage A can
 * hill-climb the same math the shader will ship.
 */

import type { CodeParams, Intrinsics, Pose, Vec3 } from "@ledmapper/protocol";
import type { Rgb } from "../code/gray";
import { colorForFrame } from "../code/gray";
import { strideLit, type StrideParams } from "../code/stride";
import { frameIndexAt } from "../code/timing";

/** An RGB image plane, interleaved, values in [0, ∞) before clip. */
export interface Image {
  data: Float32Array; // length w*h*3
  w: number;
  h: number;
}

export interface RenderOptions {
  imgW: number;
  imgH: number;
  /** LED output scale (the phone-servoed capture brightness), [0, 1]. */
  brightness?: number;
  /**
   * Focused-spot size as a WORLD radius (m); projected size scales with `fx/depth`
   * so nearer LEDs are larger, clamped to `spotSigmaMinPx`. This is the LED image
   * BEFORE the diffuser.
   */
  spotSigmaWorld?: number;
  spotSigmaMinPx?: number;
  /**
   * The diffuser, modeled as an energy-conserving convolution (a normalized
   * Gaussian PSF, σ in full-res px): it SPREADS each spot — lowering its peak and
   * flattening its edges (the "lower luma derivative" symptom) — and bleeds
   * adjacent spots' color together. `0` ⇒ no diffuser (sharp spots).
   */
  diffuseSigmaPx?: number;
  /** Fraction of light passing through the diffuser vs. staying sharp, [0, 1].
   * `1` (default) = a full diffuser; lower keeps a residual direct core. */
  diffuseMix?: number;
  /** Per-pixel additive sensor noise σ (post-bloom, pre-clip), [0, 1] scale. */
  noise?: number;
  /** Uniform ambient floor added everywhere (a lit room), [0, 1]. */
  ambient?: number;
  /**
   * Striding: light only this phase's subset (see code/stride.ts). Omit ⇒ every
   * LED lit every frame (the legacy all-at-once behavior = the diffuse baseline).
   */
  stride?: StrideParams | undefined;
  phase?: number | undefined;
  /** Deterministic noise source (0..1); required when `noise`/jitter is set. */
  rng?: (() => number) | undefined;
}

export interface LocalContrast {
  /** Background-blur σ (detection-res px) subtracted to high-pass the bloom. */
  sigma: number;
  /** Fraction of the blurred background subtracted (1 ≈ full DC removal). */
  gain: number;
}

export interface ReduceOptions {
  /** Integer downsample factor (mirrors DetectorGL.downscale). */
  downscale?: number;
  /** Max-channel luminance threshold in [0, 1] (mirrors the shader). */
  threshold?: number;
  /** Diffuse-mode high-pass prefilter before threshold; omit ⇒ off (legacy). */
  localContrast?: LocalContrast | undefined;
}

/** Reduced detect buffer in detect.ts's RGBA layout: rgb·mask, alpha = mask·lum. */
export interface ReducedBuffer {
  detect: Uint8Array;
  w: number;
  h: number;
  /** Downsample factor used (full-res px per detect px). */
  ds: number;
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

// --- projection + splat -----------------------------------------------------

// Local pinhole (mirrors geom/pinhole.ts project) — kept here so sim/ has no cv/
// dependency and the projection stays inlined in the per-LED splat loop.
function worldToCam(pose: Pose, xw: Vec3): [number, number, number] {
  const [x, y, z, w] = pose.q;
  const n = x * x + y * y + z * z + w * w || 1;
  const s = 2 / n;
  const xx = x * x * s, yy = y * y * s, zz = z * z * s;
  const xy = x * y * s, xz = x * z * s, yz = y * z * s;
  const wx = w * x * s, wy = w * y * s, wz = w * z * s;
  const dx = xw[0] - pose.p[0], dy = xw[1] - pose.p[1], dz = xw[2] - pose.p[2];
  // R^T (X - p): R is camera-to-world, so transpose maps world→camera.
  return [
    (1 - (yy + zz)) * dx + (xy + wz) * dy + (xz - wy) * dz,
    (xy - wz) * dx + (1 - (xx + zz)) * dy + (yz + wx) * dz,
    (xz + wy) * dx + (yz - wx) * dy + (1 - (xx + yy)) * dz,
  ];
}

/**
 * Render one camera frame of the fixture at server time `tMs` under `params`,
 * returning the bloomed RGB image (values may exceed 1 before the reduce clips).
 */
export function renderFrame(
  leds: readonly Vec3[],
  pose: Pose,
  k: Intrinsics,
  params: CodeParams,
  epochMs: number,
  tMs: number,
  opts: RenderOptions,
): Image {
  const { imgW, imgH } = opts;
  const brightness = opts.brightness ?? 1;
  const spotSigmaWorld = opts.spotSigmaWorld ?? 0.004;
  const spotSigmaMinPx = opts.spotSigmaMinPx ?? 0.7;
  const ambient = opts.ambient ?? 0;
  const [fx, fy, cx, cy] = k;
  const img: Image = { data: new Float32Array(imgW * imgH * 3).fill(ambient), w: imgW, h: imgH };
  const frameIdx = frameIndexAt(tMs, epochMs, params);

  for (let id = 0; id < leds.length; id++) {
    if (opts.stride && !strideLit(id, opts.phase ?? 0, opts.stride)) continue;
    const xc = worldToCam(pose, leds[id]!);
    const depth = -xc[2];
    if (depth <= 1e-6) continue; // behind the camera
    const u = cx + (fx * xc[0]) / depth;
    const v = cy - (fy * xc[1]) / depth;
    const sigma = Math.max(spotSigmaMinPx, (spotSigmaWorld * fx) / depth);
    const rad = Math.ceil(3 * sigma);
    if (u + rad < 0 || u - rad >= imgW || v + rad < 0 || v - rad >= imgH) continue;
    const color: Rgb = colorForFrame(id, frameIdx, params);
    // Peak amplitude scaled so the integrated energy is ~brightness-independent
    // of spot size (a bigger projected spot spreads the same light).
    const amp = brightness;
    const inv2s2 = 1 / (2 * sigma * sigma);
    const x0 = Math.max(0, Math.floor(u - rad));
    const x1 = Math.min(imgW - 1, Math.ceil(u + rad));
    const y0 = Math.max(0, Math.floor(v - rad));
    const y1 = Math.min(imgH - 1, Math.ceil(v + rad));
    for (let py = y0; py <= y1; py++) {
      const dy = py + 0.5 - v;
      for (let px = x0; px <= x1; px++) {
        const dx = px + 0.5 - u;
        const g = amp * Math.exp(-(dx * dx + dy * dy) * inv2s2);
        const o = (py * imgW + px) * 3;
        img.data[o]! += g * color[0];
        img.data[o + 1]! += g * color[1];
        img.data[o + 2]! += g * color[2];
      }
    }
  }

  // The diffuser: an energy-conserving convolution. A normalized Gaussian blur
  // spreads each spot (peak drops, edges soften) and bleeds neighbors — unlike
  // additive bloom, it does NOT inflate an isolated spot's peak, so a strided
  // (isolated) spot genuinely reads dimmer and softer, which is the regime the
  // detector's local-contrast prefilter has to rescue.
  const diffuseSigma = opts.diffuseSigmaPx ?? 0;
  if (diffuseSigma > 0) {
    const mix = opts.diffuseMix ?? 1;
    const blur = gaussianBlur(img.data, imgW, imgH, 3, diffuseSigma);
    for (let i = 0; i < img.data.length; i++) img.data[i]! = (1 - mix) * img.data[i]! + mix * blur[i]!;
  }

  // Sensor noise (post-optics, pre-clip).
  if (opts.noise && opts.noise > 0) {
    const rng = opts.rng ?? Math.random;
    const n = opts.noise;
    for (let i = 0; i < img.data.length; i++) {
      // Approx-Gaussian from 4 uniforms.
      img.data[i]! += (rng() + rng() + rng() + rng() - 2) * 0.5 * n;
    }
  }
  return img;
}

// --- separable Gaussian blur ------------------------------------------------

/** Separable Gaussian blur of an interleaved `channels`-plane image. */
export function gaussianBlur(
  data: Float32Array,
  w: number,
  h: number,
  channels: number,
  sigma: number,
): Float32Array {
  const rad = Math.max(1, Math.ceil(3 * sigma));
  const kernel = new Float32Array(2 * rad + 1);
  let ksum = 0;
  const inv2s2 = 1 / (2 * sigma * sigma);
  for (let i = -rad; i <= rad; i++) {
    const v = Math.exp(-i * i * inv2s2);
    kernel[i + rad] = v;
    ksum += v;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i]! /= ksum;

  const tmp = new Float32Array(data.length);
  const out = new Float32Array(data.length);
  // Horizontal.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < channels; c++) {
        let acc = 0;
        for (let i = -rad; i <= rad; i++) {
          const sx = Math.min(w - 1, Math.max(0, x + i));
          acc += kernel[i + rad]! * data[(y * w + sx) * channels + c]!;
        }
        tmp[(y * w + x) * channels + c] = acc;
      }
    }
  }
  // Vertical.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < channels; c++) {
        let acc = 0;
        for (let i = -rad; i <= rad; i++) {
          const sy = Math.min(h - 1, Math.max(0, y + i));
          acc += kernel[i + rad]! * tmp[(sy * w + x) * channels + c]!;
        }
        out[(y * w + x) * channels + c] = acc;
      }
    }
  }
  return out;
}

// --- reduce (mirror of detect.ts's fragment shader) -------------------------

/**
 * Downsample + optional local-contrast high-pass + max-channel soft-threshold to
 * the detect buffer detect.ts's shader produces. `localContrast` is the diffuse-mode
 * prefilter: subtract a blurred background (a top-hat / DoG high-pass) so the bloom's
 * DC lift is removed and the peak luma derivative — and the bleed-corrupted hue — are
 * restored before the threshold and the per-blob chroma read.
 */
export function reduceToDetect(img: Image, opts: ReduceOptions = {}): ReducedBuffer {
  const ds = Math.max(1, Math.round(opts.downscale ?? 2));
  const threshold = opts.threshold ?? 0.6;
  const rw = Math.max(1, Math.round(img.w / ds));
  const rh = Math.max(1, Math.round(img.h / ds));
  // Box downsample to reduced RGB.
  const red = new Float32Array(rw * rh * 3);
  for (let ry = 0; ry < rh; ry++) {
    for (let rx = 0; rx < rw; rx++) {
      let r = 0, g = 0, b = 0, n = 0;
      const sx0 = rx * ds, sy0 = ry * ds;
      for (let yy = 0; yy < ds; yy++) {
        const sy = sy0 + yy;
        if (sy >= img.h) break;
        for (let xx = 0; xx < ds; xx++) {
          const sx = sx0 + xx;
          if (sx >= img.w) break;
          const o = (sy * img.w + sx) * 3;
          r += img.data[o]!; g += img.data[o + 1]!; b += img.data[o + 2]!; n++;
        }
      }
      const o = (ry * rw + rx) * 3;
      red[o] = r / n; red[o + 1] = g / n; red[o + 2] = b / n;
    }
  }

  // Diffuse-mode high-pass: subtract a blurred background per channel (removes the
  // low-frequency bloom lift + neighbor color bleed; clamped at 0).
  if (opts.localContrast && opts.localContrast.gain > 0) {
    const bg = gaussianBlur(red, rw, rh, 3, opts.localContrast.sigma);
    const gain = opts.localContrast.gain;
    for (let i = 0; i < red.length; i++) red[i] = Math.max(0, red[i]! - gain * bg[i]!);
  }

  const detect = new Uint8Array(rw * rh * 4);
  for (let i = 0; i < rw * rh; i++) {
    const r = clamp01(red[i * 3]!), g = clamp01(red[i * 3 + 1]!), b = clamp01(red[i * 3 + 2]!);
    const lum = Math.max(r, g, b);
    const m = lum >= threshold ? 1 : 0;
    detect[i * 4] = (r * m * 255) | 0;
    detect[i * 4 + 1] = (g * m * 255) | 0;
    detect[i * 4 + 2] = (b * m * 255) | 0;
    detect[i * 4 + 3] = (m * lum * 255) | 0;
  }
  return { detect, w: rw, h: rh, ds };
}
