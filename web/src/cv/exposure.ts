/**
 * Exposure monitoring + capture auto-negotiation (varying-light robustness).
 *
 * The web client cannot read the camera's real 3A/ISP state — WebXR raw
 * camera access exposes only the texture, no ISO/shutter metadata — so this
 * module derives software proxies and negotiates the capture configuration
 * from them:
 *
 *  - **Scene luminance** (mean/p95/clip fraction) from an unthresholded,
 *    downsampled readback ({@link DetectorGL.measure}). Auto-exposure targets
 *    mid-gray; a scene it can't lift above ~dark despite max gain IS a dark
 *    room, which is what the encoding choice keys on.
 *  - **Frame cadence** as the shutter-speed proxy: in low light the camera
 *    lengthens exposure and the delivered frame interval rises (30 → 15 fps
 *    is a doubling of integration time). The SIGNALING RATE is negotiated
 *    against this so each bit window always spans enough camera frames to
 *    vote — a fixed 100 ms bit period is undecodable at 10 fps.
 *
 * Both feed three consumers:
 *  1. `recommendConfig` — the pre-capture negotiation (start_mapping options).
 *  2. `planReconfigure` — mid-capture renegotiation (§7.1 configure) when the
 *     measured cadence drifts so far the current rate starves bit windows.
 *  3. `adjustThreshold` — a detector-threshold servo on the measured blob
 *     count (the flood/starve signal), replacing the fixed 0.6 operating
 *     point that failed in bright rooms (~200 clutter blobs/frame, 2026-07-05).
 *
 * Everything here is pure state-in/state-out and unit-tested; the capture page
 * owns the timers and the wire messages.
 */

import type { ExposureStats } from "@ledmapper/protocol";

/** Scene luminance statistics from one unthresholded downsampled frame. */
export interface SceneStats {
  meanLuma: number;
  p95Luma: number;
  /** Fraction of pixels at/above ~0.98 — clipped highlights. */
  clipFrac: number;
}

export interface FrameSample {
  tMs: number;
  blobCount: number;
  /** Present on frames where the (cheaper, subsampled) measure pass ran. */
  scene?: SceneStats | undefined;
}

/**
 * Symbol-alphabet thresholds. The 4-ary alphabet needs finer hue
 * discrimination (adjacent palette colors are 60° apart instead of 180°),
 * so it is chosen only when the measured chroma conditions support it:
 * a reasonably lit scene (auto-exposure reached its mid-gray target) with
 * few clipped highlights (clipping saturates channels and collapses hue —
 * the same physics that killed the green sync at gScore ~0.13 in the
 * 2026-07-07 dark-room trace). Everything else gets the robust 2-ary
 * red/blue alphabet.
 */
export const HUE4_MIN_MEAN_LUMA = 0.12;
export const HUE4_MAX_CLIP_FRAC = 0.05;

/** Minimum camera frames a bit window must span for centrality-weighted
 * window voting to have evidence (≥3 keeps ≥1 mid-window sample under the
 * 33 ms-vs-bit-period phase alias; see decoder.ts windowGuardFrac). */
export const MIN_FRAMES_PER_BIT = 3.0;

/** Renegotiate only below this many frames/bit — between this and
 * MIN_FRAMES_PER_BIT the decoder still works; hysteresis, not a cliff. */
export const RENEG_FRAMES_PER_BIT = 2.5;

/** Window-period bounds: floor keeps the cycle robust to timing jitter even
 * on high-fps cameras; ceiling keeps a 64-LED SEC-DED cycle (14 frames at
 * 2 symbols, 8 at 4) under ~6 s so decodes (and live solves) still converge
 * in a handheld walk. */
export const BIT_PERIOD_MIN_MS = 60;
export const BIT_PERIOD_MAX_MS = 400;

/** Detector-threshold servo bounds (base = the §5 dark-room operating point). */
export const THRESHOLD_BASE = 0.6;
export const THRESHOLD_MAX = 0.9;
/** Blob-count band the servo aims for: flood ceiling and starve floor. */
export const BLOB_FLOOD = 150;

export interface NegotiatedConfig {
  symbols: 2 | 4;
  bitPeriodMs: number;
}

/** Round up to the 10 ms grid the wall/driver render cleanly. */
function roundBitPeriod(ms: number): number {
  const stepped = Math.ceil(ms / 10) * 10;
  return Math.min(BIT_PERIOD_MAX_MS, Math.max(BIT_PERIOD_MIN_MS, stepped));
}

/** Pre-capture negotiation: pick the symbol alphabet and signaling rate for
 * the measured scene. Sent as start_mapping options — the server needs no
 * flags. 4 symbols when the chroma SNR looks good (shortens the cycle by
 * ~40%); the mid-capture margin telemetry corrects an optimistic pick. */
export function recommendConfig(m: {
  frameIntervalMs: number;
  meanLuma: number;
  clipFrac: number;
}): NegotiatedConfig {
  const goodChroma = m.meanLuma >= HUE4_MIN_MEAN_LUMA && m.clipFrac <= HUE4_MAX_CLIP_FRAC;
  return {
    symbols: goodChroma ? 4 : 2,
    bitPeriodMs: roundBitPeriod(MIN_FRAMES_PER_BIT * m.frameIntervalMs),
  };
}

/**
 * Mid-capture renegotiation check: returns the new bit period to `configure`,
 * or null to keep the current one. Only fires when the current rate has
 * actually decayed below the decodable band (frames/bit < RENEG threshold) or
 * recovered so much that the code is pointlessly slow (>2× what's needed —
 * halving the cycle time is worth the one-cycle re-anchor cost).
 */
export function planReconfigure(currentBitPeriodMs: number, frameIntervalMs: number): number | null {
  const framesPerBit = currentBitPeriodMs / frameIntervalMs;
  if (framesPerBit < RENEG_FRAMES_PER_BIT) {
    return roundBitPeriod(MIN_FRAMES_PER_BIT * frameIntervalMs);
  }
  const ideal = roundBitPeriod(MIN_FRAMES_PER_BIT * frameIntervalMs);
  if (currentBitPeriodMs >= 2 * ideal) return ideal;
  return null;
}

/**
 * Margin thresholds for the mid-capture symbol-alphabet switch, read against
 * the decoder's margin EMA (its measured chroma SNR — see
 * DecodeStats.marginEma; a perfect symbol read scores 1.0 in either
 * alphabet). The band is wide because every switch costs a cycle re-anchor
 * on all parties: downgrade only when 4-ary decoding is demonstrably
 * struggling, upgrade only when 2-ary margins are so comfortable that the
 * halved 4-ary separation still clears the confidence gate.
 */
export const SYMBOL_DOWNGRADE_MARGIN = 0.35;
export const SYMBOL_UPGRADE_MARGIN = 0.7;

/**
 * Mid-capture symbol-alphabet check: returns the alphabet to switch to, or
 * null to keep the current one. Unlike the pre-capture pick (scene stats
 * only), this reads the decoder's MEASURED margins — the ground truth for
 * whether the current alphabet is separable in this scene — plus the scene
 * stats as the upgrade gate. `marginEma` is null before the first decoded
 * cycle; nothing switches on no evidence.
 */
export function planSymbolSwitch(
  current: 2 | 4,
  m: { meanLuma: number; clipFrac: number },
  marginEma: number | null,
): 2 | 4 | null {
  if (marginEma === null) return null;
  if (current === 4 && marginEma < SYMBOL_DOWNGRADE_MARGIN) return 2;
  if (
    current === 2 &&
    marginEma >= SYMBOL_UPGRADE_MARGIN &&
    m.meanLuma >= HUE4_MIN_MEAN_LUMA &&
    m.clipFrac <= HUE4_MAX_CLIP_FRAC
  ) {
    return 4;
  }
  return null;
}

/**
 * Detector-threshold servo: one step per report tick, driven by the measured
 * blob count. A flooded detector (bright room slicing scene luminance —
 * ~210 blobs/frame in the 2026-07-05 trace) raises the threshold; a starved
 * one (fewer blobs than LEDs plausibly in view) walks back toward base.
 * Steps are small and bounded so a pathological frame can't slam the
 * operating point.
 */
export function adjustThreshold(current: number, medianBlobCount: number, ledCount: number): number {
  const floodCeil = Math.max(BLOB_FLOOD, 3 * ledCount);
  if (medianBlobCount > floodCeil) return Math.min(THRESHOLD_MAX, current + 0.05);
  if (medianBlobCount < ledCount / 2 && current > THRESHOLD_BASE) {
    return Math.max(THRESHOLD_BASE, current - 0.05);
  }
  return current;
}

/**
 * Rolling window over recent frames: medians are robust to the odd stalled
 * frame (GC pause, thermal hiccup) that a mean would smear into a phantom
 * fps drop.
 */
export class ExposureMonitor {
  private samples: FrameSample[] = [];

  constructor(private readonly windowMs = 2000) {}

  push(s: FrameSample): void {
    this.samples.push(s);
    const cutoff = s.tMs - this.windowMs;
    let first = 0;
    while (first < this.samples.length && this.samples[first]!.tMs < cutoff) first++;
    if (first > 0) this.samples.splice(0, first);
  }

  get sampleCount(): number {
    return this.samples.length;
  }

  /** Median camera frame interval (ms) — the shutter-speed proxy. */
  frameIntervalMs(): number | null {
    if (this.samples.length < 4) return null;
    const deltas: number[] = [];
    for (let i = 1; i < this.samples.length; i++) {
      deltas.push(this.samples[i]!.tMs - this.samples[i - 1]!.tMs);
    }
    return median(deltas);
  }

  medianBlobCount(): number | null {
    if (this.samples.length === 0) return null;
    return median(this.samples.map((s) => s.blobCount));
  }

  /** Median scene stats over the frames that carried a measure pass. */
  scene(): SceneStats | null {
    const scenes = this.samples.filter((s) => s.scene !== undefined).map((s) => s.scene!);
    if (scenes.length === 0) return null;
    return {
      meanLuma: median(scenes.map((s) => s.meanLuma)),
      p95Luma: median(scenes.map((s) => s.p95Luma)),
      clipFrac: median(scenes.map((s) => s.clipFrac)),
    };
  }

  /** Everything measured, for negotiation. Null until the window has enough
   * frames AND at least one measure pass. */
  snapshot(): { frameIntervalMs: number; blobCount: number; scene: SceneStats } | null {
    const interval = this.frameIntervalMs();
    const blobs = this.medianBlobCount();
    const scene = this.scene();
    if (interval === null || blobs === null || scene === null) return null;
    return { frameIntervalMs: interval, blobCount: blobs, scene };
  }

  /** Build the §7.1 exposure_report payload, or null before enough data. */
  report(tMs: number, detectorThreshold: number, ambientIntensity: number | null = null): ExposureStats | null {
    const snap = this.snapshot();
    if (snap === null) return null;
    return {
      tCaptureMs: tMs,
      frameIntervalMs: snap.frameIntervalMs,
      meanLuma: snap.scene.meanLuma,
      p95Luma: snap.scene.p95Luma,
      clipFrac: snap.scene.clipFrac,
      blobCount: Math.round(snap.blobCount),
      detectorThreshold,
      // Reserved for platforms that expose the real 3A state (native apps);
      // the WebXR path can only estimate.
      iso: null,
      exposureTimeMs: null,
      ambientIntensity,
    };
  }
}

function median(xs: readonly number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
