/**
 * Capture guidance for jerky motion on dense fixtures.
 *
 * Mapping NEEDS motion: the visual-inertial solver takes metric scale from
 * the accelerometer, so a capture wants plenty of smooth translation. What
 * breaks the tracker is not motion but motion it can't predict: a shake or a
 * snap of the wrist moves the image by more than an LED pitch between frames,
 * and on a dense fixture (radiolarian panels: LEDs ~13 px apart) tracks then
 * land on the LED next door.
 *
 * So the signal is the tracker's UNPREDICTED image motion — the global shift
 * it had to apply on top of every track's own prediction — in LED pitches
 * per frame. A big smooth sway is predicted and scores like holding still
 * (dense-fixture sim: 0.27 pitch/frame for a 25 cm sway vs 0.28 steady);
 * shaking scores 2+, where tracking collapses. The guide smooths over about
 * a second, needs it sustained, and has hysteresis, so a single jolt never
 * nags — and it never asks the user to move less, only more smoothly.
 */

import type { TrackerFrameStats } from "./tracker";

export interface MotionGuideOptions {
  /** Warn above this smoothed unpredicted motion (LED pitches per frame). */
  onPitches?: number;
  /** Clear below this (hysteresis). */
  offPitches?: number;
  /** Smoothing time constant (ms). */
  tauMs?: number;
  /** The level must hold this long before the warning shows (ms). */
  holdMs?: number;
}

export const JERKY_MOTION_HINT = "Too jerky to track these LEDs — keep moving, but smoothly.";

export class MotionGuide {
  private readonly on: number;
  private readonly off: number;
  private readonly tau: number;
  private readonly hold: number;
  private level: number | null = null;
  private lastT: number | null = null;
  private aboveSince: number | null = null;
  /** Whether the jerky-motion hint should show. */
  jerky = false;

  constructor(opts: MotionGuideOptions = {}) {
    this.on = opts.onPitches ?? 1.4;
    this.off = opts.offPitches ?? 1.0;
    this.tau = opts.tauMs ?? 1000;
    this.hold = opts.holdMs ?? 1000;
  }

  /** Smoothed unpredicted motion, LED pitches per frame (null until measured). */
  get pitchesPerFrame(): number | null {
    return this.level;
  }

  /** Feed one tracker step. Returns whether the hint should show. */
  update(st: TrackerFrameStats, tMs: number): boolean {
    // Needs a measured spacing and enough established tracks to mean anything.
    if (st.spacingPx === null || st.spacingPx <= 0 || st.live < 8) return this.jerky;
    const x = st.shiftPx / st.spacingPx;
    const dt = this.lastT === null ? 0 : Math.max(0, tMs - this.lastT);
    this.lastT = tMs;
    this.level = this.level === null ? x : this.level + (1 - Math.exp(-dt / this.tau)) * (x - this.level);
    if (this.jerky) {
      if (this.level < this.off) {
        this.jerky = false;
        this.aboveSince = null;
      }
    } else if (this.level > this.on) {
      this.aboveSince ??= tMs;
      if (tMs - this.aboveSince >= this.hold) this.jerky = true;
    } else {
      this.aboveSince = null;
    }
    return this.jerky;
  }
}
