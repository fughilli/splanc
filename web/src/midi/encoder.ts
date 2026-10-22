/**
 * Endless-encoder support for MIDI controls: decoding the relative CC
 * encodings controllers send, guessing which one a control uses from a few
 * learned values, and turning ticks into list steps.
 *
 * A knob in ABSOLUTE mode sends its position (0..127), so it stops at the
 * ends. An endless encoder in a RELATIVE mode sends how far it moved since the
 * last message, so a list can be scrolled indefinitely. The common encodings:
 *
 *   - `binOffset` ("ENC 3FH/41H", "Binary offset"): 64 = no move, 65 = +1,
 *     63 = −1; 64±n = ±n. The Midi Fighter Twister's relative mode.
 *   - `twos` ("7FH/01H", "Two's complement"): 1..63 = +n, 127..65 = −(128−n).
 *   - `signMag` ("Signed bit"): bit 6 is the sign, the low 6 bits the size:
 *     1..63 = +n, 65..127 = −(n−64).
 *
 * Bigger values mean a faster turn (controller-side acceleration); they are
 * passed through as bigger steps. Pure and DOM-free so it unit-tests under
 * Node.
 */

/** How a CC control encodes its value. `absolute` is the default. */
export type EncoderMode = "absolute" | "binOffset" | "twos" | "signMag";

export const ENCODER_MODES: readonly { id: EncoderMode; label: string; short: string }[] = [
  { id: "absolute", label: "Absolute (0–127)", short: "Absolute" },
  { id: "binOffset", label: "Relative — binary offset (3F/41)", short: "Rel 3F/41" },
  { id: "twos", label: "Relative — two's complement (7F/01)", short: "Rel 7F/01" },
  { id: "signMag", label: "Relative — signed bit (41/01)", short: "Rel signed" },
];

export function isEncoderMode(s: unknown): s is EncoderMode {
  return s === "absolute" || s === "binOffset" || s === "twos" || s === "signMag";
}

export function isRelative(mode: EncoderMode | undefined): boolean {
  return mode !== undefined && mode !== "absolute";
}

/**
 * Signed tick delta of one relative CC value (raw 0..127). `absolute` has no
 * per-message delta, so it returns 0 (use {@link EncoderTracker} for that).
 */
export function decodeRelative(raw: number, mode: EncoderMode): number {
  const v = raw & 0x7f;
  switch (mode) {
    case "binOffset":
      return v - 64;
    case "twos":
      return v < 64 ? v : v - 128;
    case "signMag": {
      const mag = v & 0x3f;
      return v & 0x40 ? -mag : mag;
    }
    default:
      return 0;
  }
}

/**
 * Per-control delta tracker. Relative modes decode each message on its own;
 * an absolute knob's delta is the change since its previous value (the first
 * message only primes it), so an absolute knob can still browse a list, just
 * not past its end stops.
 */
export class EncoderTracker {
  private readonly last = new Map<string, number>();

  delta(key: string, raw: number, mode: EncoderMode | undefined): number {
    const m = mode ?? "absolute";
    if (m !== "absolute") return decodeRelative(raw, m);
    const prev = this.last.get(key);
    this.last.set(key, raw);
    return prev === undefined ? 0 : raw - prev;
  }

  reset(key?: string): void {
    if (key === undefined) this.last.clear();
    else this.last.delete(key);
  }
}

/**
 * Ticks → list steps. `ticksPerStep` > 1 slows a fine-grained encoder down
 * (the remainder carries over, so nothing is lost); acceleration survives
 * because a big delta still makes a proportionally big step.
 */
export class StepAccumulator {
  private acc = 0;

  constructor(private ticksPerStep = 1) {}

  setTicksPerStep(n: number): void {
    this.ticksPerStep = Math.max(1, Math.round(n));
    this.acc = 0;
  }

  /** Feed a tick delta; returns the whole steps to move now. */
  push(delta: number): number {
    if (this.ticksPerStep <= 1) return delta;
    // A reversal drops the leftover from the other direction (feels snappier).
    if (delta !== 0 && Math.sign(delta) !== Math.sign(this.acc)) this.acc = 0;
    this.acc += delta;
    const steps = Math.trunc(this.acc / this.ticksPerStep) || 0; // no -0
    this.acc -= steps * this.ticksPerStep;
    return steps;
  }
}

export interface ModeGuess {
  mode: EncoderMode;
  /** `high` = the values only fit this mode; `low` = a best guess. */
  confidence: "high" | "low";
  /** One short human-readable reason, for the learn UI. */
  reason: string;
}

/** Largest per-message step a relative encoder plausibly sends (with
 * acceleration). Twister velocity mode tops out around ±17 per message. */
const MAX_REL_STEP = 24;

/**
 * Guess a control's encoding from raw values captured during MIDI learn
 * (the user turns the knob a few clicks). Relative encoders repeat a handful
 * of values near their "zero" (65,65,63,63… or 1,1,127,127…); absolute knobs
 * walk through consecutive positions. Returns null when there is too little
 * to go on (fewer than 3 values).
 */
export function detectEncoderMode(raws: readonly number[]): ModeGuess | null {
  if (raws.length < 3) return null;
  const vals = raws.map((r) => r & 0x7f);
  const distinct = new Set(vals);
  const repeats = vals.length - distinct.size;

  const within = (lo: number, hi: number) => (v: number) => v >= lo && v <= hi;
  const near64 = within(64 - MAX_REL_STEP, 64 + MAX_REL_STEP);
  const lowPos = within(1, MAX_REL_STEP);
  const twosNeg = within(128 - MAX_REL_STEP, 127);
  const signNeg = within(65, 64 + MAX_REL_STEP);

  // Relative streams never carry a "no move" value, and they repeat.
  const fitsBin = vals.every((v) => near64(v) && v !== 64);
  const fitsTwos = vals.every((v) => lowPos(v) || twosNeg(v));
  const fitsSign = vals.every((v) => lowPos(v) || signNeg(v));

  // Absolute knobs step through neighbouring positions without repeating.
  let smallSteps = 0;
  for (let i = 1; i < vals.length; i++) {
    const d = Math.abs(vals[i]! - vals[i - 1]!);
    if (d > 0 && d <= 6) smallSteps++;
  }
  const looksAbsolute =
    distinct.size >= Math.max(3, vals.length * 0.6) && smallSteps >= (vals.length - 1) * 0.6;

  const relativeEvidence = repeats >= Math.max(1, Math.floor(vals.length / 3));

  if (fitsBin && (relativeEvidence || !looksAbsolute)) {
    const both = vals.some((v) => v < 64) && vals.some((v) => v > 64);
    return {
      mode: "binOffset",
      confidence: relativeEvidence || both ? "high" : "low",
      reason: "values sit just above/below 64 (63/65) — binary offset",
    };
  }
  if (fitsTwos && fitsSign && (relativeEvidence || !looksAbsolute)) {
    // Only small positive values (1,2,…): both fit; two's complement is the
    // more common setting.
    return {
      mode: "twos",
      confidence: "low",
      reason: "small positive values only — two's complement or signed bit; turn both ways to tell",
    };
  }
  if (fitsTwos && (relativeEvidence || !looksAbsolute)) {
    return {
      mode: "twos",
      confidence: relativeEvidence ? "high" : "low",
      reason: "values near 1 and 127 — two's complement",
    };
  }
  if (fitsSign && (relativeEvidence || !looksAbsolute)) {
    return {
      mode: "signMag",
      confidence: relativeEvidence ? "high" : "low",
      reason: "values near 1 and 65 — signed bit",
    };
  }
  return {
    mode: "absolute",
    confidence: looksAbsolute ? "high" : "low",
    reason: looksAbsolute
      ? "values walk through positions — absolute knob (stops at the ends)"
      : "no relative pattern — treating as absolute",
  };
}
