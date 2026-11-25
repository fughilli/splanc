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
import type { Blob } from "./types";
import { select } from "./select";

/** Scene luminance statistics from one unthresholded downsampled frame. */
export interface SceneStats {
  meanLuma: number;
  p95Luma: number;
  /** Fraction of pixels at/above ~0.98 — clipped highlights. */
  clipFrac: number;
}

/** Per-frame blob-population signals for the LED brightness servo — what the
 * detector can see about wash-out without any ground truth. */
export interface BlobPopulation {
  /** Fraction of blobs that came out of an oversized bloom component
   * (Blob.split) — halos are merging; unambiguously "too bright". */
  splitFrac: number;
  /** Fraction of blobs whose mean color is near-gray. NOTE: ALL_ON white
   * frames legitimately read 1.0, so consume this as a MEDIAN over a window
   * spanning a cycle (data frames dominate) — never a single frame. */
  grayFrac: number;
  /** Median blob mean-luminance, [0, 1]. */
  medianIntensity: number;
  /** Median blob saturated-pixel fraction (Blob.satFrac): how blown out the
   * typical blob is. High even when the hue survives (a clipped BLUE LED is
   * saturated on its max channel but still vivid) — the "bright enough to
   * bloom-and-scatter, not enough to wash the hue" regime the gray/split
   * signals miss. Reducing brightness lowers it (closed loop). */
  satFrac: number;
}

/** Chroma fraction below which a blob's hue is considered washed out. */
export const GRAY_CHROMA_FRAC = 0.25;

/** Summarize one frame's blobs for the servo. */
export function blobPopulation(blobs: readonly Blob[]): BlobPopulation {
  // Per frame on every blob (thousands on a big wall): order statistics in
  // shared scratch instead of two allocating sorts.
  let split = 0;
  let gray = 0;
  const n = blobs.length;
  if (popI.length < n) {
    popI = new Float64Array(Math.max(n, 2 * popI.length));
    popS = new Float64Array(popI.length);
  }
  for (let i = 0; i < n; i++) {
    const b = blobs[i]!;
    if (b.split === true) split++;
    const mx = Math.max(b.r ?? 0, b.g ?? 0, b.b ?? 0);
    const mn = Math.min(b.r ?? 0, b.g ?? 0, b.b ?? 0);
    if (mx === 0 || (mx - mn) / mx < GRAY_CHROMA_FRAC) gray++;
    popI[i] = b.intensity;
    popS[i] = b.satFrac ?? 0;
  }
  return {
    splitFrac: n > 0 ? split / n : 0,
    grayFrac: n > 0 ? gray / n : 0,
    medianIntensity: n > 0 ? select(popI, n, n >> 1) : 0,
    satFrac: n > 0 ? select(popS, n, n >> 1) : 0,
  };
}
let popI = new Float64Array(256);
let popS = new Float64Array(256);

export interface FrameSample {
  tMs: number;
  blobCount: number;
  /** Present on frames where the (cheaper, subsampled) measure pass ran. */
  scene?: SceneStats | undefined;
  /** Blob-population summary for the LED brightness servo. */
  blobs?: BlobPopulation | undefined;
  /** Spot SNR / core-clipping signals for the diffuse servo (spotSignals). */
  spots?: SpotSignals | undefined;
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

/** Window-period bounds: the floor keeps the cycle robust to timing jitter
 * (and inside what a strip's refresh can render: a 250-LED WS2812 strip
 * repaints in ~8 ms); the ceiling keeps a 64-LED SEC-DED cycle (14 frames at
 * 2 symbols, 8 at 4) under ~6 s so decodes (and live solves) still converge in
 * a handheld walk. The floor was 60 ms while capture ran at 3 frames/bit only;
 * BitRatePlanner now earns shorter windows (2 frames/bit at 60 fps = 35 ms)
 * from measured decode yield. */
export const BIT_PERIOD_MIN_MS = 30;
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

/** Round up to the 5 ms grid the wall/driver render cleanly (fine enough that
 * 2, 2.5 and 3 frames/bit at 60 fps are distinct rates: 35/45/50 ms). */
function roundBitPeriod(ms: number): number {
  const stepped = Math.ceil(ms / 5 - 1e-9) * 5;
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
export function planReconfigure(
  currentBitPeriodMs: number,
  frameIntervalMs: number,
  targetFramesPerBit: number = MIN_FRAMES_PER_BIT,
): number | null {
  const framesPerBit = currentBitPeriodMs / frameIntervalMs;
  const ideal = roundBitPeriod(targetFramesPerBit * frameIntervalMs);
  // Too few frames per window for the target (the camera slowed, or the
  // planner stepped back up): lengthen. Hysteresis of half a frame/bit.
  if (framesPerBit < targetFramesPerBit - (MIN_FRAMES_PER_BIT - RENEG_FRAMES_PER_BIT)) return ideal;
  // Below the default target the planner asked for speed: follow it exactly.
  if (targetFramesPerBit < MIN_FRAMES_PER_BIT && currentBitPeriodMs > ideal) return ideal;
  // At the default target, only shorten on a big gap (frame-interval jitter
  // must not flap the rate).
  if (currentBitPeriodMs >= 2 * ideal) return ideal;
  return null;
}

/** Frames-per-bit ladder the rate planner walks (fastest last). */
export const FRAMES_PER_BIT_LADDER = [MIN_FRAMES_PER_BIT, 2.5, 2] as const;
/** Step to a faster rung after this many sync-valid cycles at the current one
 * decoding at least RATE_UP_YIELD of the time (and a minimum dwell). */
export const RATE_UP_ATTEMPTS = 40;
export const RATE_UP_YIELD = 0.5;
export const RATE_MIN_DWELL_MS = 8_000;
/** Step back to a slower rung when the yield at this rung falls below this
 * over at least RATE_DOWN_ATTEMPTS cycles; the abandoned rung is then barred
 * for RATE_BACKOFF_MS, doubling on each repeat failure (cap RATE_BACKOFF_MAX_MS). */
export const RATE_DOWN_YIELD = 0.2;
export const RATE_DOWN_ATTEMPTS = 25;
export const RATE_BACKOFF_MS = 30_000;
export const RATE_BACKOFF_MAX_MS = 240_000;

/**
 * Bit-rate negotiation: how many camera frames each code window spans. Shorter
 * windows mean faster cycles (more decodes per second) until the decoder runs
 * out of evidence per window — so the rate is EARNED from measured decode
 * yield, exactly like the symbol alphabet (AlphabetPlanner): step faster while
 * the current rung decodes well, step back (and bar the rung for a while) when
 * it starves. `yieldNow` must cover only the current rung (the caller resets
 * the yield on every rate or alphabet change).
 */
export class BitRatePlanner {
  private rung = 0;
  private since = -Infinity;
  private readonly blockedUntil = new Map<number, number>();
  private readonly backoff = new Map<number, number>();

  constructor(private readonly ladder: readonly number[] = FRAMES_PER_BIT_LADDER) {}

  /** The frames/bit the capture should run at now. */
  get framesPerBit(): number {
    return this.ladder[this.rung]!;
  }

  /** Re-anchor the dwell (call when the code was reconfigured for any reason). */
  noteReconfigured(tMs: number): void {
    this.since = tMs;
  }

  /** Update the rung from the current rung's decode yield; returns the frames/bit. */
  plan(yieldNow: { attempts: number; frac: number } | null, tMs: number): number {
    if (this.since === -Infinity) this.since = tMs;
    if (yieldNow === null) return this.framesPerBit;
    if (this.rung > 0 && yieldNow.attempts >= RATE_DOWN_ATTEMPTS && yieldNow.frac < RATE_DOWN_YIELD) {
      const failed = this.rung;
      const b = Math.min(RATE_BACKOFF_MAX_MS, (this.backoff.get(failed) ?? RATE_BACKOFF_MS / 2) * 2);
      this.backoff.set(failed, b);
      this.blockedUntil.set(failed, tMs + b);
      this.rung--;
      this.since = tMs;
      return this.framesPerBit;
    }
    const next = this.rung + 1;
    if (
      next < this.ladder.length &&
      tMs - this.since >= RATE_MIN_DWELL_MS &&
      yieldNow.attempts >= RATE_UP_ATTEMPTS &&
      yieldNow.frac >= RATE_UP_YIELD &&
      (this.blockedUntil.get(next) ?? -Infinity) <= tMs
    ) {
      this.rung = next;
      this.since = tMs;
    }
    return this.framesPerBit;
  }
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
  /** Margin band override — for the link benchmark's candidate tunings
   * (tests/tools/linkBench.ts); production uses the defaults. */
  band: { downgrade: number; upgrade: number; upgradeMinLuma?: number } = {
    downgrade: SYMBOL_DOWNGRADE_MARGIN,
    upgrade: SYMBOL_UPGRADE_MARGIN,
  },
): 2 | 4 | null {
  if (marginEma === null) return null;
  if (current === 4 && marginEma < band.downgrade) return 2;
  if (
    current === 2 &&
    marginEma >= band.upgrade &&
    m.meanLuma >= (band.upgradeMinLuma ?? HUE4_MIN_MEAN_LUMA) &&
    m.clipFrac <= HUE4_MAX_CLIP_FRAC
  ) {
    return 4;
  }
  return null;
}

/** LED output brightness bounds. The floor keeps enough PWM resolution on an
 * 8-bit strip for the hue palette to survive quantization (0.05 ≈ 13/255). */
export const LED_BRIGHTNESS_MIN = 0.05;
export const LED_BRIGHTNESS_MAX = 1.0;
/** Multiplicative servo steps: DOWN escapes fast (wash-out is a cliff — the
 * 2026-07-13 bloom study lost ALL detections within ~2× above the good
 * band), UP creeps (the only cost of slightly-too-dim is detection range). */
export const LED_BRIGHTNESS_UP = 1.2;
export const LED_BRIGHTNESS_DOWN = 0.5;
/** Bloom gates: any split blobs beyond noise, or a majority-gray population,
 * means halos are merging / hue is washing — step down. */
export const BLOOM_SPLIT_FRAC = 0.1;
export const BLOOM_GRAY_FRAC = 0.4;
/** Over-detection gate: blob count this far above the LED count means each LED
 * is fragmenting into several detections (bloom halos splitting off, or PWM /
 * rolling-shutter banding) — the dominant failure mode in the field traces
 * (120 blobs for 64 LEDs, with split=0 so the split gate never fired). Lower
 * brightness shrinks the bloom that drives most of it (indoors, detection
 * accuracy rises as brightness falls), so this steps DOWN. Above ledCount, not
 * ledCount/2, so the STARVE band (pairwise-merged neighbors ≈ ledCount/2) can't
 * be mistaken for a flood. */
export const LED_FLOOD_FRAC = 1.4;
// NOTE (2026-07-16): a satFrac (blob-clipping) down-gate was tried and
// REMOVED. In a dark room the camera's auto-exposure raises gain until the
// frame meters mid-gray; with only the LEDs in view that pins them clipped
// (satFrac ~1.0) INDEPENDENT of brightness — halving brightness just doubles
// the gain. So dimming can't lower satFrac, and the gate chased brightness to
// the 5% floor uselessly (worse: dim LEDs at max sensor gain). satFrac stays
// in the trace/HUD as a diagnostic, but LED brightness is not the lever for
// bloom in the dark — camera exposure / ambient light / a matte surface are.
/** Scene clip fraction that reads "the frame is flooded with clipped light"
 * — disambiguates ZERO blobs (washed-out glare got dropped as oversized)
 * from "strip is too dim to detect". */
export const WASHOUT_CLIP_FRAC = 0.03;
/** Blob count below this fraction of ledCount reads as starved. Above 1/2
 * because pairwise-merged neighbors land EXACTLY at ledCount/2 (the G=24
 * sim run settled there); below 1 because captures rarely frame the whole
 * strip, so a modest shortfall is normal. */
export const STARVE_FRAC = 0.7;
/** Median blob intensity above which a STARVED detector means merged blobs
 * (bright but too few), not dim ones. */
export const STARVE_BRIGHT_INTENSITY = 0.85;
/** Median blob intensity below which a healthy population still has SNR
 * headroom worth claiming. */
export const DIM_INTENSITY = 0.7;

export interface LedBrightnessSignals {
  blobCount: number;
  ledCount: number;
  /** Median per-frame BlobPopulation over the report window. */
  splitFrac: number;
  grayFrac: number;
  medianIntensity: number;
  /** Scene clip fraction from the measure pass (SceneStats.clipFrac). */
  clipFrac: number;
}

/**
 * LED brightness servo: returns the brightness to renegotiate to, or null to
 * hold. Detection probability over brightness is an inverted U — too dim and
 * blobs fall under the detector threshold, too bright and blooming merges
 * halos and washes hue to white — and the optimum moves with scene gain
 * (auto-exposure in a dim room = high ISO = wash-out at a fraction of the
 * brightness a lit room wants; measured 2026-07-13: the workable band at
 * 12× the gain sits ~6× lower). So this servos on the phone's MEASURED
 * wash-out signals, not scene luminance:
 *
 *  - no blobs at all: clipFrac says which side of the U we're on (a washed
 *    scene floods the frame with clipped light; a dim strip doesn't);
 *  - split/gray blobs: halos merging, hue washing — down;
 *  - starved but BRIGHT blobs: neighbors merged into few blobs — down;
 *    starved and dim — up;
 *  - healthy but dim: claim SNR headroom — up, until a bloom gate answers.
 *
 * One step per report tick, like adjustThreshold; the caller applies the
 * same two-consecutive-ticks confirmation as the other renegotiations (a
 * configure re-stamps the pattern clock for everyone).
 */
export function planLedBrightness(current: number, m: LedBrightnessSignals): number | null {
  const up = Math.min(LED_BRIGHTNESS_MAX, current * LED_BRIGHTNESS_UP);
  const down = Math.max(LED_BRIGHTNESS_MIN, current * LED_BRIGHTNESS_DOWN);
  const step = (next: number): number | null => (Math.abs(next - current) < 1e-3 ? null : next);
  if (m.blobCount === 0) {
    return step(m.clipFrac > WASHOUT_CLIP_FRAC ? down : up);
  }
  if (m.splitFrac > BLOOM_SPLIT_FRAC || m.grayFrac > BLOOM_GRAY_FRAC) return step(down);
  // Over-detection: each LED fragmenting into several blobs (bloom / banding).
  // Dimming shrinks the bloom that drives it — the biggest lever indoors.
  if (m.blobCount > m.ledCount * LED_FLOOD_FRAC) return step(down);
  if (m.blobCount < m.ledCount * STARVE_FRAC) {
    // Bright-but-few = neighbors merged into shared blobs; dim-and-few = the
    // strip is fading under the detector threshold. In between, the deficit
    // is probably framing (not every LED in view) — don't chase it.
    if (m.medianIntensity >= STARVE_BRIGHT_INTENSITY) return step(down);
    if (m.medianIntensity < DIM_INTENSITY) return step(up);
    return null;
  }
  if (m.medianIntensity < DIM_INTENSITY && m.splitFrac === 0 && m.grayFrac < GRAY_CHROMA_FRAC) {
    return step(up);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Diffuse-capture servo (D-178)
//
// The LED-brightness rules above (DIM_INTENSITY, STARVE_FRAC, LED_FLOOD_FRAC)
// read absolute blob intensity and the blob count against ledCount. Both assume
// an UNSTRIDED, bright scene: in diffuse capture only every stride-th LED is lit
// (blobCount ~ ledCount/stride, permanently "starved"), and the biased-dark auto
// exposure keeps spot intensity far below 0.7 at ANY good operating point (the
// 2026-11-18 rope sweep detects best at median blob intensity 0.06-0.26). So in
// diffuse mode those rules always read "too dim" and walk the brightness up,
// restarting the decoder at every step. The diffuse servo instead steers on what
// the adaptive detector actually needs:
//
//  - spot SNR: each blob's peak over the detector's noise floor (the per-frame
//    median + kSigma x MAD threshold, so the ratio is the spot's margin above the
//    cut). Low = spots sinking into the diffuser texture / sensor noise.
//  - per-channel core clipping: of the blobs that use a channel, the fraction
//    whose core saturates in it. One clipping channel shifts every two-channel
//    hue (magenta, yellow) toward the other, and it is a single channel that
//    clips first (on the rope sweep, blue-dominant spots at long exposure) —
//    a median over all blobs would hide it.
//
// Two levers, two rates:
//  - exposure (AE bias in EV, or the manual exposure target where the camera
//    has no bias): FINE, cheap — no reconfigure, so it moves each tick;
//  - LED brightness: COARSE, and every change restarts the decoder. It settles
//    at the start of the capture (before anything is decoded) and is then HELD,
//    changing only at a stride-phase boundary (a restart that happens anyway),
//    and only when exposure alone has run out of range.
// ---------------------------------------------------------------------------

/** Spot SNR (median blob peak / noise floor) below which spots are marginal. On
 * the rope sweep the cells that lose LEDs (10% brightness at every exposure, 30%
 * at short exposure) sit at a median of 2.5-6; the good band reads 8-28. */
export const SPOT_SNR_LOW = 8;
/** Per-channel core-clip fraction above which exposure/brightness steps down;
 * below CORE_CLIP_OK the servo may step up. */
export const CORE_CLIP_HIGH = 0.15;
export const CORE_CLIP_OK = 0.05;
/** A blob's core counts as clipped at this peak (the CCL saturation cut, ~0.98). */
const CORE_SAT = 250 / 255;
/** A channel is "used" by a blob at this fraction of its dominant channel, and
 * clipped with it at CLIP_SHARE (the colour is scaled so its max is the core). */
const CH_USED = 0.5;
const CH_CLIP_SHARE = 0.9;
/** Channels with fewer blobs than this don't vote on clipping (noise). */
const CH_MIN_BLOBS = 3;

/** One frame's spot signals. */
export interface SpotSignals {
  /** Median of blob peak / noise floor. */
  snr: number;
  /** Max over R, G, B of the fraction of that channel's blobs whose core clips. */
  coreClip: number;
  /** Which channel that was (0 r, 1 g, 2 b), or -1 when nothing clips. */
  clipChannel: number;
  blobs: number;
}

/**
 * Spot signals of one frame's blobs. `floor` is the adaptive detector's noise
 * floor (NoiseFloor.floor); where it isn't known (the native iOS reducer keeps
 * its floor), the 10th-percentile blob peak stands in — every blob cleared the
 * floor, so its weakest survivors sit just above it.
 */
export function spotSignals(blobs: readonly Blob[], floor: number | null): SpotSignals | null {
  const n = blobs.length;
  if (n === 0) return null;
  if (spotPeaks.length < n) spotPeaks = new Float64Array(Math.max(n, 2 * spotPeaks.length));
  for (let i = 0; i < n; i++) spotPeaks[i] = blobs[i]!.peak ?? blobs[i]!.intensity;
  const f = floor !== null && floor > 0 ? floor : Math.max(1 / 255, select(spotPeaks, n, Math.floor(0.1 * n)));
  const used = [0, 0, 0];
  const clipped = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const b = blobs[i]!;
    const c = [b.r ?? 0, b.g ?? 0, b.b ?? 0];
    const mx = Math.max(c[0]!, c[1]!, c[2]!);
    if (mx <= 0) continue;
    const core = (b.peak ?? 0) >= CORE_SAT;
    for (let k = 0; k < 3; k++) {
      if (c[k]! < CH_USED * mx) continue;
      used[k]!++;
      if (core && c[k]! >= CH_CLIP_SHARE * mx) clipped[k]!++;
    }
  }
  let coreClip = 0;
  let clipChannel = -1;
  for (let k = 0; k < 3; k++) {
    if (used[k]! < CH_MIN_BLOBS) continue;
    const fr = clipped[k]! / used[k]!;
    if (fr > coreClip) {
      coreClip = fr;
      clipChannel = k;
    }
  }
  return { snr: select(spotPeaks, n, n >> 1) / f, coreClip, clipChannel, blobs: n };
}
let spotPeaks = new Float64Array(256);

/** Exposure-bias bounds and step for the diffuse servo (EV). The capture starts
 * at DIFFUSE_AE_BIAS_START (capture.ts); a third of a stop is the finest step
 * most cameras quantise exposureCompensation to. */
export const AE_BIAS_MIN = -6;
export const AE_BIAS_MAX = -1;
export const AE_BIAS_STEP = 1 / 3;
/** The same step on the manual [0,1] exposure target (planExposure's geometric
 * map spans ~10 stops: 0.1 ≈ 1 EV). */
export const EXPOSURE_FINE_STEP = 1 / 30;

export type ServoMove = "down" | "up" | null;

/** Which way the spot signals want the light to move (null = in band). */
export function spotMove(s: SpotSignals): ServoMove {
  if (s.coreClip > CORE_CLIP_HIGH) return "down";
  if (s.snr < SPOT_SNR_LOW && s.coreClip <= CORE_CLIP_OK) return "up";
  return null;
}

/** Exposure steps per tick while settling (two thirds of a stop: the start of
 * the capture should get into band in a few ticks) and after (a third). */
export const SETTLE_EXPOSURE_STEPS = 2;

/** LED brightness steps of the diffuse servo (coarse: the fine part is exposure). */
export const DIFFUSE_BRIGHT_UP = 1.6;
export const DIFFUSE_BRIGHT_DOWN = 0.6;
/** The settle stage at the start of a diffuse capture lasts at most this long
 * (and ends early once the signals sit in band for SETTLE_IN_BAND_TICKS). */
export const DIFFUSE_SETTLE_MS = 8_000;
export const SETTLE_IN_BAND_TICKS = 2;
/** Without phase boundaries, a held brightness change applies alone once it
 * has been wanted this many consecutive ticks (~10 s). */
export const HELD_ALONE_TICKS = 5;

/** The exposure lever as the servo sees it: a value with bounds and a step —
 * the AE bias in EV (AE_BIAS_*), or the manual [0,1] target
 * (EXPOSURE_FINE_STEP) where the camera has no bias. null = no exposure control
 * (iOS web capture): brightness does everything. */
export interface ExposureLever {
  value: number;
  lo: number;
  hi: number;
  step: number;
}

export interface DiffuseServoStep {
  /** New exposure value (apply now: no reconfigure). */
  exposure?: number;
  /** New LED brightness (settling: apply now; else at the next phase boundary). */
  brightness?: number;
}

/**
 * One diffuse-servo decision. Each direction has a lever it prefers:
 *
 *  - DOWN (a channel's cores clip): exposure first — it fixes clipping at any
 *    brightness, costs nothing, and steps finely. Brightness steps down only once
 *    exposure is at its floor.
 *  - UP (spots marginal): brightness first. On the rope sweep the noise floor
 *    rises with exposure (it is mostly the diffuser's own lit texture), so
 *    lengthening exposure barely moves SNR — 10% brightness loses most LEDs at
 *    EVERY exposure — while brightness raises the spots over that floor.
 *    Exposure steps up only once brightness is at its maximum (where SNR is
 *    read-noise limited, at short exposure, exposure is the lever that works).
 *
 * At most one lever moves per tick, so the effect of each step is measured
 * before the next.
 */
export function planDiffuseServo(
  brightness: number,
  exposure: ExposureLever | null,
  s: SpotSignals,
  settling: boolean,
): DiffuseServoStep {
  const m = spotMove(s);
  if (m === null) return {};
  const step = (exposure?.step ?? 0) * (settling ? SETTLE_EXPOSURE_STEPS : 1);
  const expTo = (dir: 1 | -1): number | null => {
    if (exposure === null) return null;
    const v = Math.min(exposure.hi, Math.max(exposure.lo, exposure.value + dir * step));
    return Math.abs(v - exposure.value) < 1e-6 ? null : v;
  };
  if (m === "down") {
    const e = expTo(-1);
    if (e !== null) return { exposure: e };
    const b = Math.max(LED_BRIGHTNESS_MIN, brightness * DIFFUSE_BRIGHT_DOWN);
    return Math.abs(b - brightness) < 1e-3 ? {} : { brightness: b };
  }
  const b = Math.min(LED_BRIGHTNESS_MAX, brightness * DIFFUSE_BRIGHT_UP);
  if (Math.abs(b - brightness) >= 1e-3) return { brightness: b };
  const e = expTo(1);
  return e !== null ? { exposure: e } : {};
}

/**
 * Settle-then-hold timing for the diffuse servo: brightness moves freely while
 * the capture settles (its start, before anything is decoded), then is HELD —
 * a post-settle brightness proposal waits for the next stride-phase boundary,
 * which restarts the decoder anyway, and must have been wanted on consecutive
 * ticks. Exposure (the fine lever) applies every tick throughout. Pure; the
 * capture loop feeds it one tick at a time.
 */
export class DiffuseServo {
  private startMs: number | null = null;
  private inBand = 0;
  private settled = false;
  private pending: { value: number; up: boolean; ticks: number } | null = null;

  get settling(): boolean {
    return !this.settled;
  }

  /**
   * One tick. `exposure` is applied by the caller now; `brightness` only when
   * present in the result (settle stage). Post-settle proposals are kept for
   * {@link atPhaseBoundary}.
   */
  tick(tMs: number, brightness: number, exposure: ExposureLever | null, s: SpotSignals): DiffuseServoStep {
    this.startMs ??= tMs;
    if (!this.settled) {
      this.inBand = spotMove(s) === null ? this.inBand + 1 : 0;
      if (this.inBand >= SETTLE_IN_BAND_TICKS || tMs - this.startMs >= DIFFUSE_SETTLE_MS) this.settled = true;
      else return planDiffuseServo(brightness, exposure, s, true);
    }
    const st = planDiffuseServo(brightness, exposure, s, false);
    if (st.brightness === undefined) {
      this.pending = null;
      return st;
    }
    const up = st.brightness > brightness;
    this.pending = this.pending !== null && this.pending.up === up ? { value: st.brightness, up, ticks: this.pending.ticks + 1 } : { value: st.brightness, up, ticks: 1 };
    return {};
  }

  /** At a stride-phase boundary: the brightness to bundle into that reconfigure
   * (a proposal wanted over >= 2 consecutive ticks), or null. */
  atPhaseBoundary(): number | null {
    const p = this.pending;
    this.pending = null;
    return p !== null && p.ticks >= 2 ? p.value : null;
  }

  /** Where no phase boundary is coming (a single phase, or a stride that never
   * rotates): the held proposal once it has been wanted for `minTicks`
   * consecutive ticks, else null (and it keeps waiting). */
  takeHeld(minTicks: number): number | null {
    const p = this.pending;
    if (p === null || p.ticks < minTicks) return null;
    this.pending = null;
    return p.value;
  }
}

/** Camera-exposure servo target step, in the [0,1] exposureTime range
 * (planExposure lerps this over the camera's exposureTime capability). DOWN
 * (shorten) escapes bloom a hair faster than UP creeps. */
export const EXPOSURE_UP_STEP = 0.1;
export const EXPOSURE_DOWN_STEP = 0.12;
/** Where the exposure servo starts within [shortest, bitPeriodMs/2]. Biased
 * SHORT: banding (too short) is recoverable — the servo lengthens toward the
 * sweet spot — but too long integrates across a hue transition and hard-fails
 * the decode, so start well under the Nyquist cap and creep up. */
export const EXPOSURE_SERVO_START = 0.25;
/** Blob clipping / washed-hue fractions that read "exposure too long" (bloom). */
export const EXPOSURE_SAT_FRAC = 0.4;
export const EXPOSURE_GRAY_FRAC = 0.5;
/** Over-detection above this × ledCount, at LOW saturation, reads as PWM /
 * rolling-shutter banding fragmenting each LED — lengthen the exposure so it
 * integrates several PWM cycles and the bands average out. */
export const EXPOSURE_FLOOD_FRAC = 1.4;
/** Median blob intensity below which the frame is too dark — lengthen. */
export const EXPOSURE_DIM_INTENSITY = 0.5;

export interface ExposureServoSignals {
  blobCount: number;
  ledCount: number;
  /** Median blob clipping (Blob.satFrac) and washed-hue fraction, and median
   * blob intensity — from the same BlobPopulation the brightness servo reads. */
  satFrac: number;
  grayFrac: number;
  medianIntensity: number;
}

/**
 * Camera-exposure servo: returns the next exposure target in [0,1] (0 = the
 * shortest exposureTime the camera offers, 1 = the longest), or null to hold.
 *
 * Unlike LED brightness, exposure fixes BOTH sides of the field problem: too
 * SHORT and the rolling shutter samples the LEDs' ~kHz PWM mid-cycle, so each
 * LED breaks into a stack of on/off horizontal bands the detector fragments
 * (over-detection); too LONG and the LEDs bloom and wash to white (clipping).
 * The good exposure integrates enough PWM cycles to kill the banding without
 * blooming — so servo toward it:
 *
 *  - clipping / washed hue: exposure is too long → shorten;
 *  - over-detection at LOW saturation: banding → lengthen (integrate the PWM);
 *  - too dim: lengthen.
 *
 * Because the camera exposure is LOCKED (we own it), satFrac is a real bloom
 * signal here — unlike the LED-brightness servo, where auto-exposure re-clips
 * the LEDs at any brightness. Applied directly per tick (no pattern-clock
 * restamp, unlike a configure), so it needs no two-tick confirmation.
 */
export function planExposureServo(current: number, m: ExposureServoSignals): number | null {
  const up = Math.min(1, current + EXPOSURE_UP_STEP);
  const down = Math.max(0, current - EXPOSURE_DOWN_STEP);
  const step = (next: number): number | null => (Math.abs(next - current) < 1e-3 ? null : next);
  const bloom = m.satFrac > EXPOSURE_SAT_FRAC || m.grayFrac > EXPOSURE_GRAY_FRAC;
  if (m.blobCount === 0) {
    return step(bloom ? down : up); // washed → shorten; dark → lengthen
  }
  if (bloom) return step(down);
  if (m.blobCount > m.ledCount * EXPOSURE_FLOOD_FRAC) return step(up); // banding → integrate
  if (m.medianIntensity < EXPOSURE_DIM_INTENSITY) return step(up);
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

  /** Forget every sample (a re-probe after the detector changed). */
  reset(): void {
    this.samples = [];
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

  /** Median blob-population signals over the window's frames. Per-frame
   * medians make grayFrac robust to the cycle's ALL_ON white frames (a
   * minority of any window spanning a cycle). Null until frames carry them. */
  blobPopulation(): BlobPopulation | null {
    const pops = this.samples.filter((s) => s.blobs !== undefined).map((s) => s.blobs!);
    if (pops.length === 0) return null;
    return {
      splitFrac: median(pops.map((p) => p.splitFrac)),
      grayFrac: median(pops.map((p) => p.grayFrac)),
      medianIntensity: median(pops.map((p) => p.medianIntensity)),
      satFrac: median(pops.map((p) => p.satFrac)),
    };
  }

  /** Median diffuse spot signals over the window (null until frames carry them).
   * The clip channel is the one that clipped most often. */
  spotSignals(): SpotSignals | null {
    const sp = this.samples.filter((s) => s.spots !== undefined).map((s) => s.spots!);
    if (sp.length === 0) return null;
    const votes = [0, 0, 0];
    for (const s of sp) if (s.clipChannel >= 0) votes[s.clipChannel]!++;
    const top = Math.max(...votes);
    return {
      snr: median(sp.map((s) => s.snr)),
      coreClip: median(sp.map((s) => s.coreClip)),
      clipChannel: top > 0 ? votes.indexOf(top) : -1,
      blobs: median(sp.map((s) => s.blobs)),
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
