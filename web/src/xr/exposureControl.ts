/**
 * Camera exposure control for the getUserMedia capture path.
 *
 * Auto-exposure defeats LED-brightness control in the dark: with only the
 * LEDs in view, AE raises the sensor gain until they clip regardless of how
 * dim the strip is driven (measured 2026-07-16 — the LED-brightness servo
 * dove to its 5% floor with the blobs still fully clipped). The lever that
 * DOES work is locking the camera exposure DOWN so the sensor stops blowing
 * the LEDs out — effectively spot-metering the bright points against a dark
 * frame, which is exactly what LED mapping wants (only the LEDs visible).
 *
 * These are the MediaStream Image-Capture extensions (`exposureMode`,
 * `exposureTime`, `exposureCompensation`, `iso`); support is device- and
 * browser-dependent. `planExposure` picks the strongest available control
 * from a track's capabilities and returns null when the camera exposes none
 * (auto then stays). The constraint-picking is pure + unit-tested; only the
 * capture source calls `applyConstraints`.
 */

export interface Range {
  min: number;
  max: number;
  step?: number;
}

/** The Image-Capture capability subset we use (not in the standard DOM lib). */
export interface ExposureCapabilities {
  exposureMode?: string[];
  exposureTime?: Range;
  exposureCompensation?: Range;
  iso?: Range;
}

export interface ExposurePlan {
  /** Pass to `MediaStreamTrack.applyConstraints`. */
  constraints: MediaTrackConstraints;
  /** Human-readable summary of what was set (for the HUD/log). */
  description: string;
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/** MediaStream Image-Capture `exposureTime` is in 100-microsecond units (W3C
 * spec): 1 unit = 0.1 ms. Used to enforce the Nyquist cap in real time. */
export const EXPOSURE_UNIT_MS = 0.1;

/**
 * Choose exposure constraints for `target01` (0 = minimum exposure = darkest,
 * the least-bloom end; 1 = maximum). The manual lock walks the range
 * GEOMETRICALLY — equal target travel is equal stops — so the short end stays
 * controllable instead of collapsing into the last percent of the slider.
 * Prefers a hard MANUAL exposure lock
 * (also pinning ISO to its minimum to hold the gain down) when the camera
 * supports it; falls back to an exposure-COMPENSATION bias (a hint the auto
 * loop honors, weaker but widely supported); null when neither exists.
 *
 * `maxExposureMs` caps the LONGEST manual exposure `target01=1` maps to: the
 * exposure must stay under it so it doesn't integrate across a pattern-frame
 * hue transition and blur the code (Nyquist — the caller passes bitPeriodMs/2).
 * The [min, max] range is squeezed to [min, min(camMax, cap)], so the whole
 * target range respects it. It does NOT apply to the compensation fallback
 * (an EV bias, not an absolute time).
 */
export function planExposure(
  caps: ExposureCapabilities,
  target01: number,
  maxExposureMs?: number,
): ExposurePlan | null {
  const t = clamp01(target01);
  const lerp = (r: Range): number => r.min + t * (r.max - r.min);

  if (caps.exposureMode?.includes("manual") && caps.exposureTime) {
    let hi = caps.exposureTime.max;
    if (maxExposureMs !== undefined) {
      // Never below the camera's own minimum — if even that exceeds the cap,
      // the shortest exposure is the best we can do (and we say so).
      hi = Math.max(caps.exposureTime.min, Math.min(hi, maxExposureMs / EXPOSURE_UNIT_MS));
    }
    // GEOMETRIC, not linear. Exposure is perceived in stops (doublings), so a
    // linear ramp spends nearly all its travel in the blown-out top end: on a
    // 0.02–250 ms range, everything from "well exposed" to "black" is squeezed
    // into the bottom ~1% of the slider, which is the complaint from the field.
    // Interpolating the log makes equal travel = equal stops, so the dim end —
    // where LED mapping actually lives — gets its fair share of the control.
    // A zero floor or an inverted range has no log to walk, so those degenerate
    // cases keep the linear ramp.
    const lo = caps.exposureTime.min;
    const exposureTime = lo > 0 && hi > lo ? lo * Math.pow(hi / lo, t) : lo + t * (hi - lo);
    const advanced: Record<string, unknown> = { exposureMode: "manual", exposureTime };
    if (caps.iso) advanced["iso"] = caps.iso.min; // hold gain at its lowest
    return {
      constraints: { advanced: [advanced] } as MediaTrackConstraints,
      description:
        `manual exposureTime ${exposureTime.toFixed(0)} (${(exposureTime * EXPOSURE_UNIT_MS).toFixed(1)}ms)` +
        (caps.iso ? `, iso ${caps.iso.min}` : ""),
    };
  }

  if (caps.exposureCompensation) {
    const exposureCompensation = lerp(caps.exposureCompensation);
    return {
      constraints: {
        advanced: [{ exposureCompensation }],
      } as unknown as MediaTrackConstraints,
      description: `exposureCompensation ${exposureCompensation.toFixed(2)} EV`,
    };
  }

  return null;
}
