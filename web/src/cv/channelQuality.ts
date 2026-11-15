/**
 * Data-aided channel-quality measurement for the hue code, and the symbol-rate
 * choice made from it.
 *
 * The old rule switched the alphabet on two proxies: SCENE brightness (an
 * upgrade needed mean luma ≥ 0.12, which a dark-room capture never reaches,
 * however clean the LED colours are) and the decoder's worst-window margin
 * EMA, which is alphabet-specific and, on dense fixtures, dragged down by
 * tracker hops. Captures that dropped to 2 symbols never came back.
 *
 * Here the channel is measured directly. Once a track's id is CONFIRMED, the
 * symbol every window of that cycle carried is known, so each window's
 * white-normalised colour gives a hue error against what was sent. Pooled
 * over tracks, the errors give:
 *   - a per-target hue bias (the camera's hue response is not ideal), and
 *   - the noise σ around it (robust: MAD), independent of the alphabet in use;
 *   - the fraction of windows too washed out to carry hue at all.
 * From σ the planner predicts, for each alphabet the player supports, the
 * chance a window is rejected (low confidence) or misread, and so the chance
 * a whole cycle decodes under the code's FEC; it picks the alphabet with the
 * best throughput of decoded ids. 2 symbols can be measured as well as 4, so
 * the link climbs back once the channel allows it.
 *
 * The hue model: a palette symbol at hue θ is classified correctly while the
 * observed hue stays within half the gap to each palette neighbour. The
 * decoder's confidence gate rejects a cycle on any window whose margin falls
 * below `minConfidence` — roughly, a hue error past (1 − minConfidence) of
 * the half-gap — and FEC repairs only DECISIVE misreads (past
 * (1 + minConfidence) of it). Gaussian in the residual hue error.
 */

import type { CodeParams } from "@ledmapper/protocol";
import { expectedBits, type Rgb, SYMBOL_COLORS } from "../code/gray";

/** Hue (rad, [0, 2π)) and saturation ([0, 1]) of an RGB triple. */
export function hueSat(rgb: readonly [number, number, number]): { hue: number; sat: number } {
  const [r, g, b] = rgb;
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const c = mx - mn;
  if (mx <= 0 || c <= 0) return { hue: 0, sat: 0 };
  let h: number;
  if (mx === r) h = ((g - b) / c) % 6;
  else if (mx === g) h = (b - r) / c + 2;
  else h = (r - g) / c + 4;
  const hue = ((h * Math.PI) / 3 + 2 * Math.PI) % (2 * Math.PI);
  return { hue, sat: c / mx };
}

/** Signed smallest angle a − b, in (−π, π]. */
function wrap(a: number): number {
  let d = a % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d <= -Math.PI) d += 2 * Math.PI;
  return d;
}

/** Below this saturation a window carries no usable hue (washed out). */
export const WASHED_SAT = 0.2;
/** Windows kept for the estimate (≈ 40 cycles of 2-symbol data). */
const WINDOW_CAP = 800;
/** Sync-valid cycle attempts remembered for the decode yield. */
const CYCLE_CAP = 200;
/** Step down when fewer than this share of at least MIN_YIELD_ATTEMPTS
 * recent sync-valid cycles decoded, measurement or not. */
export const STARVED_YIELD = 0.1;
export const MIN_YIELD_ATTEMPTS = 40;
/** Fewest windows the planner acts on. */
export const MIN_QUALITY_WINDOWS = 120;

export interface ChannelEstimate {
  /** Windows the estimate rests on. */
  windows: number;
  /** Robust hue-noise σ around each target's bias (rad). */
  sigmaRad: number;
  /** RMS of the per-target hue biases seen (rad): the camera's hue error. */
  biasRad: number;
  /** Fraction of windows too washed out to read. */
  washedFrac: number;
  /** Fraction of windows the decoder's classifier actually misread. */
  misreadFrac: number;
}

/** Hue angles of an alphabet's palette, in symbol-value order. */
export function paletteHues(symbols: number): number[] {
  const pal: readonly Rgb[] | undefined = SYMBOL_COLORS[symbols];
  if (pal !== undefined) return pal.map((c) => hueSat(c).hue);
  // Alphabets the player doesn't speak yet (8, 16): evenly spaced hues — the
  // shape a learned-centroid palette would have. Prediction only.
  return Array.from({ length: symbols }, (_, i) => (2 * Math.PI * i) / symbols);
}

export class ChannelQuality {
  private readonly err: number[] = [];
  private readonly target: number[] = [];
  private washed: boolean[] = [];
  private misread: boolean[] = [];
  /** Recent sync-valid cycles: whether each decoded (1) or not (0). */
  private cycles: number[] = [];

  /**
   * One sync-valid cycle attempt and whether it decoded. A channel too poor
   * to decode yields no confirmed windows to measure, so this is what lets
   * the planner step DOWN out of it.
   */
  noteCycle(ok: boolean): void {
    this.cycles.push(ok ? 1 : 0);
    if (this.cycles.length > CYCLE_CAP) this.cycles.splice(0, this.cycles.length - CYCLE_CAP);
  }

  /**
   * One data window of a CONFIRMED decode: its white-normalised colour, the
   * symbol that was sent, and the symbol the classifier read.
   */
  add(rgb: readonly [number, number, number], sent: number, read: number, symbols: number): void {
    const targetHue = paletteHues(symbols)[sent];
    if (targetHue === undefined) return;
    const { hue, sat } = hueSat(rgb);
    this.err.push(sat < WASHED_SAT ? NaN : wrap(hue - targetHue));
    this.target.push(Math.round((targetHue * 180) / Math.PI));
    this.washed.push(sat < WASHED_SAT);
    this.misread.push(sent !== read);
    if (this.err.length > WINDOW_CAP) {
      const drop = this.err.length - WINDOW_CAP;
      this.err.splice(0, drop);
      this.target.splice(0, drop);
      this.washed.splice(0, drop);
      this.misread.splice(0, drop);
    }
  }

  /** Forget everything (a reconfigure changes the palette and the scene). */
  reset(): void {
    this.err.length = 0;
    this.target.length = 0;
    this.washed = [];
    this.misread = [];
    this.cycles = [];
  }

  /** Forget the decode yield (call on an alphabet switch: it was the old
   * alphabet's). The hue history stays — it doesn't depend on the alphabet. */
  resetYield(): void {
    this.cycles = [];
  }

  /** Decoded share of the recent sync-valid cycles, and how many there were. */
  decodeYield(): { attempts: number; frac: number } {
    const n = this.cycles.length;
    return { attempts: n, frac: n > 0 ? this.cycles.reduce((a, b) => a + b, 0) / n : 0 };
  }

  estimate(): ChannelEstimate | null {
    const n = this.err.length;
    if (n === 0) return null;
    const byTarget = new Map<number, number[]>();
    for (let i = 0; i < n; i++) {
      const e = this.err[i]!;
      if (Number.isNaN(e)) continue;
      const k = this.target[i]!;
      (byTarget.get(k) ?? byTarget.set(k, []).get(k)!).push(e);
    }
    const resid: number[] = [];
    let biasSq = 0;
    let biasN = 0;
    for (const es of byTarget.values()) {
      const b = median(es);
      biasSq += b * b * es.length;
      biasN += es.length;
      for (const e of es) resid.push(Math.abs(e - b));
    }
    const sigma = resid.length > 0 ? 1.4826 * median(resid) : Math.PI;
    let washed = 0;
    let misread = 0;
    for (let i = 0; i < n; i++) {
      if (this.washed[i]) washed++;
      if (this.misread[i]) misread++;
    }
    return {
      windows: n,
      sigmaRad: Math.max(sigma, 1e-3),
      biasRad: biasN > 0 ? Math.sqrt(biasSq / biasN) : 0,
      washedFrac: washed / n,
      misreadFrac: misread / n,
    };
  }
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Upper-tail Gaussian probability Q(x) (Abramowitz–Stegun 7.1.26 erfc). */
export function qfunc(x: number): number {
  if (x < 0) return 1 - qfunc(-x);
  const z = x / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y =
    t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return 0.5 * y * Math.exp(-z * z);
}

export interface AlphabetPrediction {
  symbols: number;
  /** Per window: rejected by the confidence gate / decisively misread. */
  pLow: number;
  pErr: number;
  /** Chance a whole cycle decodes (the code's FEC repairing decisive misreads). */
  pCycle: number;
  /** Data frames per cycle (+2 sync). */
  cycleFrames: number;
  /** Decoded cycles per frame: the planner's throughput figure. */
  throughput: number;
}

/** FEC capability (bits corrected) of a code book. */
function fecCorrects(fec: string | undefined): number {
  return fec === "secded" ? 1 : 0;
}

/**
 * Predict how an alphabet would do on the measured channel. The confidence
 * gate rejects a window whose hue error passes (1 − minConfidence) of its
 * half-gap; past (1 + minConfidence) it is misread decisively (FEC territory).
 */
export function predictAlphabet(
  est: ChannelEstimate,
  symbols: number,
  params: CodeParams,
  minConfidence = 0.4,
): AlphabetPrediction {
  const hues = paletteHues(symbols);
  const sorted = [...hues].sort((a, b) => a - b);
  // Half-gap to each neighbour, averaged over the palette's symbols (sides).
  let pLow = 0;
  let pErr = 0;
  const sigma = Math.hypot(est.sigmaRad, symbols > 4 ? est.biasRad : 0);
  const TAU = 2 * Math.PI;
  for (let i = 0; i < sorted.length; i++) {
    const prev = sorted[(i - 1 + sorted.length) % sorted.length]!;
    const next = sorted[(i + 1) % sorted.length]!;
    // Directed arcs to each neighbour (red→blue is 120° one way, 240° the other).
    const back = (sorted[i]! - prev + TAU) % TAU || TAU;
    const fwd = (next - sorted[i]! + TAU) % TAU || TAU;
    for (const gap of [back, fwd]) {
      const h = gap / 2;
      // Known palettes are classified against IDEAL targets, so their
      // per-target bias eats into the half-gap; learned palettes (8, 16)
      // would absorb it (σ above includes it instead).
      const hEff = symbols <= 4 ? Math.max(0, h - est.biasRad) : h;
      pLow += qfunc(((1 - minConfidence) * hEff) / sigma) - qfunc(((1 + minConfidence) * hEff) / sigma);
      pErr += qfunc(((1 + minConfidence) * hEff) / sigma);
    }
  }
  // Each side is its own way to fail: sum per symbol, average over symbols.
  pLow = Math.min(1, pLow / sorted.length + est.washedFrac);
  pErr = Math.min(1 - pLow, pErr / sorted.length);
  const p: CodeParams = { ...params, symbols };
  const bps = Math.log2(symbols);
  const windows = Math.ceil(expectedBits(p) / bps);
  const t = fecCorrects(params.fec);
  // Cycle decodes when no window is gated and at most t are misread (Gray
  // labelling: the dominant misread, an adjacent hue, flips one bit).
  const ok = Math.max(0, 1 - pLow - pErr);
  let pCycle = 0;
  for (let i = 0; i <= Math.min(t, windows); i++) pCycle += binom(windows, i) * pErr ** i * ok ** (windows - i);
  const cycleFrames = 2 + windows;
  return { symbols, pLow, pErr, pCycle, cycleFrames, throughput: pCycle / cycleFrames };
}

function binom(n: number, k: number): number {
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

/** An upgrade must promise this much more throughput (each switch costs a re-anchor). */
export const UPGRADE_GAIN = 1.25;
/** Leave the current alphabet when fewer than this share of its cycles would decode. */
export const DOWNGRADE_P_CYCLE = 0.35;

/**
 * The alphabet to switch to, or null to stay. Measured, not proxied: no scene
 * gates, and the same estimate drives both directions.
 */
export function planAlphabet(
  current: number,
  est: ChannelEstimate | null,
  params: CodeParams,
  available: readonly number[] = [2, 4],
  yieldNow: { attempts: number; frac: number } | null = null,
): number | null {
  // Starved: the current alphabet decodes (almost) nothing, so there is
  // nothing to measure — step down one alphabet on the yield alone.
  const lower = available.filter((s) => s < current);
  if (
    yieldNow !== null &&
    lower.length > 0 &&
    yieldNow.attempts >= MIN_YIELD_ATTEMPTS &&
    yieldNow.frac < STARVED_YIELD
  ) {
    return Math.max(...lower);
  }
  if (est === null || est.windows < MIN_QUALITY_WINDOWS) return null;
  const preds = available.map((s) => predictAlphabet(est, s, params));
  const cur = preds.find((p) => p.symbols === current);
  if (cur === undefined) return null;
  const best = preds.reduce((a, b) => (b.throughput > a.throughput ? b : a));
  if (best.symbols === current) return null;
  if (best.symbols > current) return best.throughput >= UPGRADE_GAIN * cur.throughput ? best.symbols : null;
  // Down: only once the current alphabet is actually failing.
  return cur.pCycle < DOWNGRADE_P_CYCLE ? best.symbols : null;
}

/** For the HUD: per-alphabet predicted cycle success, e.g. "2:98% 4:91% 8:40%". */
export function formatPrediction(est: ChannelEstimate | null, params: CodeParams, alphabets = [2, 4, 8, 16]): string {
  if (est === null || est.windows < MIN_QUALITY_WINDOWS) return "chan –";
  const deg = (r: number): string => ((r * 180) / Math.PI).toFixed(1);
  const parts = alphabets.map((s) => `${s}:${Math.round(100 * predictAlphabet(est, s, params).pCycle)}%`);
  return `chan σ${deg(est.sigmaRad)}° bias${deg(est.biasRad)}° · ${parts.join(" ")}`;
}

/** First backoff after an alphabet failed; doubles per repeat, up to the cap. */
export const UPGRADE_BACKOFF_MS = 10_000;
export const UPGRADE_BACKOFF_MAX_MS = 80_000;
/** Holding an alphabet this long without falling back clears its backoff. */
const BACKOFF_FORGIVE_MS = 30_000;

/**
 * planAlphabet with memory: an alphabet that had to be abandoned (starved, or
 * predicted to fail) is not retried until a backoff expires, doubling on each
 * repeat. The hue model can be optimistic about an alphabet it hasn't seen
 * (a veiled scene desaturates more than the noise σ shows); this turns that
 * into one probe per backoff instead of an oscillation.
 */
export class AlphabetPlanner {
  private readonly blockedUntil = new Map<number, number>();
  private readonly backoff = new Map<number, number>();
  private current: number | null = null;
  private since = 0;

  constructor(private readonly available: readonly number[] = [2, 4]) {}

  plan(
    current: number,
    est: ChannelEstimate | null,
    params: CodeParams,
    yieldNow: { attempts: number; frac: number } | null,
    tMs: number,
  ): number | null {
    if (current !== this.current) {
      this.current = current;
      this.since = tMs;
    }
    if (tMs - this.since >= BACKOFF_FORGIVE_MS) this.backoff.delete(current);
    const allowed = this.available.filter((s) => s <= current || (this.blockedUntil.get(s) ?? -Infinity) <= tMs);
    const want = planAlphabet(current, est, params, allowed, yieldNow);
    if (want !== null && want < current) {
      // Leaving `current` for a lower alphabet: it failed here; back it off.
      const b = Math.min(UPGRADE_BACKOFF_MAX_MS, (this.backoff.get(current) ?? UPGRADE_BACKOFF_MS / 2) * 2);
      this.backoff.set(current, b);
      this.blockedUntil.set(current, tMs + b);
    }
    return want;
  }
}

/** What a capture bundle records of the channel (see captureBundle.ts). */
export interface ChannelSnapshot {
  estimate: ChannelEstimate | null;
  decodeYield: { attempts: number; frac: number };
  /** Predicted cycle success per alphabet size, under the run's code. */
  predictedCycle: Record<string, number>;
}

export function channelSnapshot(q: ChannelQuality, params: CodeParams): ChannelSnapshot {
  const est = q.estimate();
  const predictedCycle: Record<string, number> = {};
  if (est !== null) for (const s of [2, 4, 8, 16]) predictedCycle[String(s)] = predictAlphabet(est, s, params).pCycle;
  return { estimate: est, decodeYield: q.decodeYield(), predictedCycle };
}
