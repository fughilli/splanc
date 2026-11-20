/**
 * Exposure-first light servo: ONE controller for camera exposure and LED
 * brightness (replaces running `planExposureServo` OR `planLedBrightness`).
 *
 * Why (owner report 2026-11-16, 1000-LED virtual wall): on camera
 * auto-exposure the LED-brightness servo alone ratchets to its 5% floor. Each
 * halving is undone by the AE raising gain, the blobs read clipped/gray
 * again, and the servo halves again (the 2026-07-16 note in cv/exposure.ts
 * recorded the same physics for the removed satFrac gate). We own the
 * exposure on cameras that offer a manual lock, so that is the lever:
 *
 *   over-exposed (bloom / gray / flood / merged)  → shorten EXPOSURE first;
 *     only once exposure sits on its floor and the signal persists → dim LEDs;
 *   under-exposed / SNR headroom                  → raise BRIGHTNESS first
 *     (back toward 1), only then lengthen EXPOSURE.
 *
 * The aim is LEDs at full brightness (best PWM resolution for the hue
 * palette) with exposure doing the work.
 *
 * ## Exposure floor (never black the frame)
 * The camera's shortest exposure is no floor at all: it blacks the LEDs out,
 * and anything under one PWM period fragments each LED into rolling-shutter
 * bands. So the floor is MEASURED. Every shortening step is verified on the
 * next tick against the tick before it; the step "broke detection" when
 *  - the median blob intensity fell under EXPOSURE_FLOOR_INTENSITY (the
 *    detector's SNR margin is going — dim blobs are the first to drop out),
 *  - the blob count fell below EXPOSURE_FLOOR_COUNT_FRAC of the pre-step
 *    count (LEDs fell under the threshold — the starve signal, measured as a
 *    CHANGE across the step so a partly-framed wall doesn't trip it), or
 *    blobs vanished entirely,
 *  - or the count jumped into over-detection (> EXPOSURE_FLOOD_FRAC × ledCount)
 *    at low clipping: PWM / rolling-shutter banding.
 * Then the exposure goes straight back to the last value where detection
 * worked and the floor is pinned there: the servo never shortens below the
 * exposure at which detection last worked. The pinned floor relaxes by half a
 * step every FLOOR_RELAX_TICKS (~30 s) so a changed scene (closer, lights
 * off) can be re-probed; a re-probe that fails costs one tick.
 *
 * ## No brightness ratchet
 * A brightness step down must EARN the next one. Each down step remembers the
 * gate that fired and its severity; after the step lands (the caller reports
 * the applied brightness) and one clean tick has been measured, the severity
 * must have dropped by DIM_MIN_RESPONSE or the gate must have cleared.
 * Otherwise the dim did nothing (the AE re-gained it) — brightness steps back
 * up and dimming is locked out for DIM_LOCK_TICKS. Brightness can therefore
 * never walk to its floor on AE gain alone.
 *
 * ## Partial framing is not merging
 * "Starved but bright" (few, bright blobs) used to read as neighbours merging
 * into shared blobs. A wall partly out of view looks exactly the same by
 * count. It now also needs the blobs to actually TOUCH: `blobCrowding`
 * measures each blob's nearest-neighbour gap against the two blob radii, and
 * the merge gate needs MERGE_TOUCH_FRAC of blobs touching. Unmeasured → skip.
 *
 * Pure state-in/state-out; capture.ts owns the timers and the wire.
 */

import type { Blob } from "./types";
import {
  BLOOM_GRAY_FRAC,
  BLOOM_SPLIT_FRAC,
  DIM_INTENSITY,
  EXPOSURE_DIM_INTENSITY,
  EXPOSURE_DOWN_STEP,
  EXPOSURE_FLOOD_FRAC,
  EXPOSURE_SAT_FRAC,
  EXPOSURE_UP_STEP,
  LED_BRIGHTNESS_DOWN,
  LED_BRIGHTNESS_MAX,
  LED_BRIGHTNESS_MIN,
  LED_BRIGHTNESS_UP,
  LED_FLOOD_FRAC,
  STARVE_BRIGHT_INTENSITY,
  STARVE_FRAC,
  WASHOUT_CLIP_FRAC,
} from "./exposure";

/** Median blob intensity under which a shortening step is judged to have
 * eaten the detector's SNR margin (floor rule 1). Below EXPOSURE_DIM_INTENSITY
 * (the lengthen trigger) so a healthy-but-dim operating point isn't a floor. */
export const EXPOSURE_FLOOR_INTENSITY = 0.3;
/** Blob-count retention a shortening step must keep (floor rule 2). */
export const EXPOSURE_FLOOR_COUNT_FRAC = 0.7;
/** Ticks (~2 s each) before a pinned exposure floor relaxes half a step. */
export const FLOOR_RELAX_TICKS = 15;
/** A brightness step down must cut its gate's severity by this fraction. */
export const DIM_MIN_RESPONSE = 0.2;
/** Ticks dimming stays locked out after a dim that didn't respond. */
export const DIM_LOCK_TICKS = 15;
/** Ticks brightness holds after a dim that DID respond, before creeping back
 * up (keeps the up/down pair from oscillating at the floor). */
export const DIM_HOLD_TICKS = 5;
/** Nearest-neighbour gap (centre distance over the sum of the two blob
 * radii) under which two blobs count as touching. */
export const TOUCH_RATIO = 1.5;
/** Fraction of blobs that must touch a neighbour for "starved but bright" to
 * read as merging rather than partial framing. */
export const MERGE_TOUCH_FRAC = 0.25;

/** Blob-geometry summary for the merge gate. */
export interface BlobCrowding {
  /** Fraction of blobs whose nearest neighbour is within TOUCH_RATIO. */
  touchFrac: number;
  /** Median nearest-neighbour ratio (centre distance / (r_i + r_j)), capped at 4. */
  medianGapRatio: number;
}

const RATIO_CAP = 4;

/**
 * Nearest-neighbour crowding of one frame's blobs: a uniform grid hash keeps it
 * ~O(n) (a 1000-LED wall per frame). Blobs further apart than RATIO_CAP radii
 * sums are never compared, so the median caps at RATIO_CAP.
 */
export function blobCrowding(blobs: readonly Blob[]): BlobCrowding | null {
  const n = blobs.length;
  if (n < 2) return null;
  const r = new Float64Array(n);
  for (let i = 0; i < n; i++) r[i] = Math.sqrt(Math.max(1, blobs[i]!.area) / Math.PI);
  const sortedR = Array.from(r).sort((a, b) => a - b);
  const rMed = sortedR[n >> 1]!;
  const rHi = sortedR[Math.min(n - 1, Math.floor(n * 0.9))]!;
  const cell = Math.max(1, 2 * RATIO_CAP * rMed);
  const grid = new Map<number, number[]>();
  const keyOf = (cx: number, cy: number): number => cx * 1_000_003 + cy;
  for (let i = 0; i < n; i++) {
    const k = keyOf(Math.floor(blobs[i]!.u / cell), Math.floor(blobs[i]!.v / cell));
    const list = grid.get(k);
    if (list) list.push(i);
    else grid.set(k, [i]);
  }
  const ratios: number[] = [];
  let touching = 0;
  for (let i = 0; i < n; i++) {
    const bi = blobs[i]!;
    const reach = RATIO_CAP * (r[i]! + rHi);
    const ring = Math.min(3, Math.ceil(reach / cell));
    const cx = Math.floor(bi.u / cell);
    const cy = Math.floor(bi.v / cell);
    let best = RATIO_CAP;
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dy = -ring; dy <= ring; dy++) {
        const list = grid.get(keyOf(cx + dx, cy + dy));
        if (!list) continue;
        for (const j of list) {
          if (j === i) continue;
          const bj = blobs[j]!;
          const ratio = Math.hypot(bi.u - bj.u, bi.v - bj.v) / (r[i]! + r[j]!);
          if (ratio < best) best = ratio;
        }
      }
    }
    ratios.push(best);
    if (best < TOUCH_RATIO) touching++;
  }
  ratios.sort((a, b) => a - b);
  return { touchFrac: touching / n, medianGapRatio: ratios[n >> 1]! };
}

/** Rolling median of `blobCrowding` over recent frames (the exposure monitor's
 * 2 s window; capture.ts feeds it on the measure-pass frames). */
export class CrowdingWindow {
  private samples: { tMs: number; c: BlobCrowding }[] = [];
  constructor(private readonly windowMs = 2000) {}
  push(tMs: number, c: BlobCrowding | null): void {
    if (c !== null) this.samples.push({ tMs, c });
    const cutoff = tMs - this.windowMs;
    while (this.samples.length > 0 && this.samples[0]!.tMs < cutoff) this.samples.shift();
  }
  value(): BlobCrowding | null {
    if (this.samples.length === 0) return null;
    const med = (xs: number[]): number => xs.sort((a, b) => a - b)[xs.length >> 1]!;
    return {
      touchFrac: med(this.samples.map((s) => s.c.touchFrac)),
      medianGapRatio: med(this.samples.map((s) => s.c.medianGapRatio)),
    };
  }
}

/** Everything the controller reads each tick (medians over the report window). */
export interface LightSignals {
  blobCount: number;
  ledCount: number;
  splitFrac: number;
  grayFrac: number;
  satFrac: number;
  medianIntensity: number;
  /** Scene clip fraction (measure pass). */
  clipFrac: number;
  /** Blob crowding; null = not measured (the merge gate then never fires). */
  crowding: BlobCrowding | null;
}

/** Which over-exposure gate fired; severity is the number a dim must reduce. */
export type OverGate = "washout" | "split" | "gray" | "sat" | "flood" | "merge";

export interface LightServoState {
  /** "exposure-first": the camera takes a manual exposure lock (we servo it).
   * "brightness-only": it doesn't (auto-exposure, a pinned `?exposure=` value):
   * exposure is treated as permanently at its floor. */
  mode: "exposure-first" | "brightness-only";
  /** Exposure target in [0,1] (planExposure's geometric range). */
  exposure: number;
  /** Measured floor (see module doc). 0 = the camera's shortest. */
  exposureFloor: number;
  /** Exposure of the last tick where detection was healthy. */
  lastGoodExposure: number | null;
  /** A shortening step awaiting its verification tick. */
  expProbe: { from: number; blobCount: number } | null;
  floorAgeTicks: number;
  /** LED brightness last applied (the caller passes the real one each tick). */
  brightness: number;
  /** Pre-dim brightness + the gate/severity that justified a requested dim. */
  dimAsk: { from: number; gate: OverGate; severity: number } | null;
  /** A dim that landed and awaits its response check. `wait` = clean ticks left. */
  dimProbe: { from: number; gate: OverGate; severity: number; wait: number } | null;
  /** Brightness to restore after a dim that didn't respond; re-proposed every
   * tick until it lands (the caller's two-tick confirm needs a stable ask). */
  restoreTo: number | null;
  dimLockTicks: number;
  /** Consecutive no-response dims: each doubles the lockout (cap 8×). */
  dimFailures: number;
  upHoldTicks: number;
  /** When true (`?brightness=` pinned, manual mode), never propose brightness. */
  brightnessLocked: boolean;
  lastReason: string;
}

export function initialLightServo(opts: {
  exposureSupported: boolean;
  exposure: number;
  brightness: number;
  brightnessLocked?: boolean;
}): LightServoState {
  return {
    mode: opts.exposureSupported ? "exposure-first" : "brightness-only",
    exposure: opts.exposure,
    exposureFloor: 0,
    lastGoodExposure: null,
    expProbe: null,
    floorAgeTicks: 0,
    brightness: opts.brightness,
    dimAsk: null,
    dimProbe: null,
    restoreTo: null,
    dimLockTicks: 0,
    dimFailures: 0,
    upHoldTicks: 0,
    brightnessLocked: opts.brightnessLocked ?? false,
    lastReason: "start",
  };
}

export interface LightServoStep {
  state: LightServoState;
  /** New exposure target to apply now (no pattern-clock restamp), or null. */
  exposure: number | null;
  /** Brightness to renegotiate to (caller applies its two-tick confirm), or null. */
  brightness: number | null;
  /** Why (the gate that fired, or "hold"); for the HUD and the trace. */
  reason: string;
}

/**
 * The strongest over-exposure gate firing now, with its severity.
 * `exposureLocked` = the camera exposure is ours (manual lock): only then is
 * blob clipping (satFrac) a real over-exposure signal — under auto-exposure
 * the AE pins the LEDs clipped at ANY brightness (the 2026-07-16 note in
 * cv/exposure.ts), so the sat gate is off; and over-detection without
 * clipping is banding (too SHORT), not bloom.
 */
export function overGate(m: LightSignals, exposureLocked = true): { gate: OverGate; severity: number } | null {
  if (m.blobCount === 0) return m.clipFrac > WASHOUT_CLIP_FRAC ? { gate: "washout", severity: m.clipFrac } : null;
  if (m.splitFrac > BLOOM_SPLIT_FRAC) return { gate: "split", severity: m.splitFrac };
  if (m.grayFrac > BLOOM_GRAY_FRAC) return { gate: "gray", severity: m.grayFrac };
  if (exposureLocked && m.satFrac > EXPOSURE_SAT_FRAC) return { gate: "sat", severity: m.satFrac };
  if (m.blobCount > m.ledCount * LED_FLOOD_FRAC && (!exposureLocked || m.satFrac > EXPOSURE_SAT_FRAC / 2)) {
    // Over-detection WITH clipping: bloom halos splitting off. (Without
    // clipping it is banding — an UNDER-exposure symptom, see below.)
    return { gate: "flood", severity: m.blobCount / m.ledCount };
  }
  if (
    m.blobCount < m.ledCount * STARVE_FRAC &&
    m.medianIntensity >= STARVE_BRIGHT_INTENSITY &&
    m.crowding !== null &&
    m.crowding.touchFrac >= MERGE_TOUCH_FRAC
  ) {
    return { gate: "merge", severity: m.crowding.touchFrac };
  }
  return null;
}

/** Severity of `gate` under the current signals (0 when it no longer fires). */
function severityOf(gate: OverGate, m: LightSignals, exposureLocked: boolean): number {
  const g = overGate(m, exposureLocked);
  if (g === null) return 0;
  if (g.gate === gate) return g.severity;
  // A different gate took over: the original one is judged on its own number.
  switch (gate) {
    case "washout":
      return m.blobCount === 0 ? m.clipFrac : 0;
    case "split":
      return m.splitFrac;
    case "gray":
      return m.grayFrac;
    case "sat":
      return m.satFrac;
    case "flood":
      return m.blobCount / m.ledCount;
    case "merge":
      return m.crowding?.touchFrac ?? 0;
  }
}

const BANDING = (m: LightSignals): boolean =>
  m.blobCount > m.ledCount * EXPOSURE_FLOOD_FRAC && m.satFrac <= EXPOSURE_SAT_FRAC / 2;

const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-3;

/**
 * One ~2 s tick. `appliedBrightness` is what the device is actually running
 * (params.brightness) — the controller detects a landed dim from it, since the
 * caller confirms and applies brightness asynchronously.
 */
export function planLightServo(prev: LightServoState, m: LightSignals, appliedBrightness: number): LightServoStep {
  const s: LightServoState = { ...prev };
  const out = (reason: string, exposure: number | null = null, brightness: number | null = null): LightServoStep => {
    s.lastReason = reason;
    return { state: s, exposure, brightness, reason };
  };
  s.dimLockTicks = Math.max(0, s.dimLockTicks - 1);
  s.upHoldTicks = Math.max(0, s.upHoldTicks - 1);

  // -- brightness bookkeeping: did a requested dim land? ---------------------
  if (s.dimAsk !== null && appliedBrightness < s.dimAsk.from - 1e-3) {
    s.dimProbe = { ...s.dimAsk, wait: 1 }; // one tick to flush mixed frames
    s.dimAsk = null;
  } else if (s.dimAsk !== null && !near(appliedBrightness, s.brightness)) {
    s.dimAsk = null; // something else moved brightness (manual): drop the ask
  }
  s.brightness = appliedBrightness;
  if (s.restoreTo !== null && appliedBrightness >= s.restoreTo - 1e-3) s.restoreTo = null;
  const expActive = s.mode === "exposure-first";

  // -- verify a landed dim (no ratchet) --------------------------------------
  if (s.dimProbe !== null) {
    if (s.dimProbe.wait > 0) {
      s.dimProbe = { ...s.dimProbe, wait: s.dimProbe.wait - 1 };
      return out(`verify dim (${s.dimProbe.gate})`);
    }
    const p = s.dimProbe;
    s.dimProbe = null;
    const after = severityOf(p.gate, m, expActive);
    if (after > p.severity * (1 - DIM_MIN_RESPONSE)) {
      // The dim did nothing measurable (auto-exposure re-gained it, or the
      // gate isn't brightness-driven): undo it and stop dimming for a while,
      // longer each time it happens again.
      s.dimFailures++;
      s.dimLockTicks = DIM_LOCK_TICKS * Math.pow(2, Math.min(3, s.dimFailures - 1));
      s.restoreTo = p.from;
      return out(`dim no-response (${p.gate} ${p.severity.toFixed(2)}→${after.toFixed(2)}): restore`, null, p.from);
    }
    s.dimFailures = 0;
    s.upHoldTicks = DIM_HOLD_TICKS;
  }
  if (s.restoreTo !== null) return out(`restore LED ${Math.round(s.restoreTo * 100)}%`, null, s.restoreTo);

  // -- verify a shortening step (the measured exposure floor) ----------------
  if (expActive && s.expProbe !== null) {
    const p = s.expProbe;
    s.expProbe = null;
    const why =
      m.blobCount === 0 && p.blobCount > 0
        ? "blobs lost"
        : m.blobCount > 0 && m.medianIntensity < EXPOSURE_FLOOR_INTENSITY
          ? `medI ${m.medianIntensity.toFixed(2)}`
          : m.blobCount < p.blobCount * EXPOSURE_FLOOR_COUNT_FRAC
            ? `count ${p.blobCount}→${m.blobCount}`
            : BANDING(m) && p.blobCount <= m.ledCount * EXPOSURE_FLOOD_FRAC
              ? "banding"
              : null;
    if (why !== null) {
      s.exposureFloor = p.from;
      s.floorAgeTicks = 0;
      s.exposure = p.from;
      return out(`floor: ${why} → back to ${p.from.toFixed(2)}`, p.from);
    }
  }
  if (expActive) {
    const healthy =
      m.blobCount > 0 && m.medianIntensity >= EXPOSURE_FLOOR_INTENSITY && !BANDING(m);
    if (healthy) s.lastGoodExposure = s.exposure;
    if (s.exposureFloor > 0 && ++s.floorAgeTicks >= FLOOR_RELAX_TICKS) {
      s.exposureFloor = Math.max(0, s.exposureFloor - EXPOSURE_DOWN_STEP / 2);
      s.floorAgeTicks = 0;
    }
  }
  // Never shorten past one step below where detection last worked.
  const floor = expActive
    ? Math.max(s.exposureFloor, s.lastGoodExposure !== null ? s.lastGoodExposure - EXPOSURE_DOWN_STEP : 0, 0)
    : Infinity;

  // -- over-exposure: exposure first, then brightness ------------------------
  const over = overGate(m, expActive);
  if (over !== null) {
    if (expActive && s.exposure > floor + 1e-3) {
      const next = Math.max(floor, s.exposure - EXPOSURE_DOWN_STEP);
      s.expProbe = { from: s.exposure, blobCount: m.blobCount };
      s.exposure = next;
      return out(`${over.gate} ${over.severity.toFixed(2)}: shorten exposure`, next);
    }
    if (s.brightnessLocked) return out(`${over.gate}: exposure at floor, brightness pinned`);
    if (s.dimLockTicks > 0) return out(`${over.gate}: dim locked (no response) ${s.dimLockTicks}`);
    const down = Math.max(LED_BRIGHTNESS_MIN, s.brightness * LED_BRIGHTNESS_DOWN);
    if (near(down, s.brightness)) return out(`${over.gate}: brightness at floor`);
    s.dimAsk = { from: s.brightness, gate: over.gate, severity: over.severity };
    const why = expActive ? "exposure at floor" : "exposure not ours";
    return out(`${over.gate} ${over.severity.toFixed(2)}: ${why} → dim LEDs`, null, down);
  }
  s.dimAsk = null;

  // -- banding: exposure too SHORT for the PWM — lengthen, and pin the floor -
  if (expActive && BANDING(m)) {
    const next = Math.min(1, s.exposure + EXPOSURE_UP_STEP);
    // The banding exposure itself is below the floor: pin it at the step up.
    s.exposureFloor = Math.max(s.exposureFloor, next);
    s.floorAgeTicks = 0;
    if (!near(next, s.exposure)) {
      s.exposure = next;
      return out("banding: lengthen exposure", next);
    }
  }

  // -- recovery / headroom: brightness back toward 1 first, then exposure ----
  const dark = m.blobCount === 0; // (washout would have fired above)
  const starvedDim = m.blobCount < m.ledCount * STARVE_FRAC && m.medianIntensity < DIM_INTENSITY;
  const headroom =
    m.medianIntensity < DIM_INTENSITY && m.splitFrac === 0 && m.grayFrac < BLOOM_GRAY_FRAC / 2 && !BANDING(m);
  if (dark || starvedDim || headroom) {
    if (!s.brightnessLocked && s.brightness < LED_BRIGHTNESS_MAX - 1e-3 && s.upHoldTicks === 0) {
      const up = Math.min(LED_BRIGHTNESS_MAX, s.brightness * LED_BRIGHTNESS_UP);
      return out(dark ? "no blobs: brighten" : `medI ${m.medianIntensity.toFixed(2)}: brighten`, null, up);
    }
    if (expActive && (dark || m.medianIntensity < EXPOSURE_DIM_INTENSITY) && s.exposure < 1 - 1e-3) {
      const next = Math.min(1, s.exposure + EXPOSURE_UP_STEP);
      s.exposure = next;
      return out(dark ? "no blobs: lengthen exposure" : `medI ${m.medianIntensity.toFixed(2)}: lengthen exposure`, next);
    }
  }
  return out("hold");
}

/** Short HUD line: exposure (and floor), brightness, last reason. */
export function formatLightServo(s: LightServoState): string {
  const exp =
    s.mode === "exposure-first"
      ? `exp ${s.exposure.toFixed(2)} (floor ${s.exposureFloor.toFixed(2)})`
      : "exp auto/pinned";
  return `${exp} · LED ${Math.round(s.brightness * 100)}% · ${s.lastReason}`;
}
