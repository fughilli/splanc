/**
 * Hue code v2 phase 2 decode stage: staggered cycles with a pilot
 * (docs/design/hue-code-v2.md). Selected by `CodeParams.syncPattern`
 * ("stagger_pilot"; the simulation-only "stagger_white" comparator too) — the
 * v1 decoder (./decoder.ts) is untouched and still decodes every "on_off"
 * player.
 *
 * Under the staggered pattern LED `id` runs the v1 cycle rotated by
 * φ(id) = (id·S) mod C, so there is no global sync frame: every track finds
 * its OWN cycle boundary, and decodes happen continuously, on each track's
 * boundary, rather than for everyone at a global cycle end. Per track:
 *
 *   1. Windows. The track's samples are bucketed into ABSOLUTE frame windows
 *      (frame n = floor((t_server − shift − epoch) / bitPeriod)) with v1's
 *      centrality weights (near-transition samples barely vote).
 *   2. Pilot. Every run of L windows is scored as a pilot (the palette pilot:
 *      a fixed run of the active alphabet's own colours, e.g. blue, yellow,
 *      magenta at 4 symbols): per channel lit in some pilot frame and dark in
 *      another, the on/off contrast, invariant to white balance and
 *      per-channel gain (never assumed locked). The kernel prunes the code
 *      book so no id's cycle contains the pilot anywhere but at its sync
 *      position, so the true pilot is the best candidate in its cycle. A cycle
 *      starting at window `a` is decoded once its last data window completes,
 *      if its pilot score clears `minPilotScore` and is the best within ±C/2.
 *   3. Calibration. The pilot measures every channel's on AND off level: a
 *      per-channel (x − off) / (on − off) normalisation that replaces v1's
 *      white reference and also removes the ambient veil, refreshed every
 *      cycle per track. Data windows are then classified against the palette
 *      exactly as v1 does (same margins, same confidence gate).
 *   4. Phase check. The decoded id must satisfy φ(id) + k ≡ a (mod C), where
 *      k is the whole-frame part of the camera → display latency. A hop
 *      stitches symbols from two LEDs and lands its pilot at the wrong phase
 *      for the id it decodes to (≈ 1 in C chance of passing), on top of FEC.
 *
 * Latency alignment. The v1 decoder maximises a global green census; a
 * staggered fixture has a flat census. Every LED changes colour on the same
 * frame grid, though, so the sub-frame shift is found by POOLED WITHIN-WINDOW
 * CONSISTENCY: the shift (mod bitPeriod) that minimises the colour scatter
 * inside each track's windows, pooled over tracks. That finds the latency only
 * modulo bitPeriod; the integer frame part k comes from a histogram of
 * (observed pilot phase − φ(id)) mod C over FEC-valid decodes. Records are only
 * emitted once k has locked (and every one is phase-checked).
 *
 * Records anchor at the track sample nearest the cycle's middle, pose-paired
 * at the latency-corrected exposure time (shift + k·bitPeriod) like v1.
 */

import type { CodeParams, DetectionRecord } from "@ledmapper/protocol";
import {
  dataFrames,
  decodeCycleSymbols,
  staggerPhase,
  SYMBOL_COLORS,
  symbolAt,
  syncCode,
  syncColors,
  type Rgb,
} from "../code/gray";
import { cycleMs } from "../code/timing";
import { ChannelQuality } from "./channelQuality";
import { type CodeDecoder, type DecodeStats, type DecoderOptions, MAX_HELD, newDecodeStats } from "./decoder";
import type { Track, TrackSample } from "./tracker";

export interface StaggerDecoderOptions extends DecoderOptions {
  /** Minimum pilot score (1 = an ideal pilot). */
  minPilotScore?: number;
  /** Phase-lock: votes the leading (phase − φ) bin needs, and its share. */
  kMinVotes?: number;
  kMinShare?: number;
  /** Tracks sampled for the consistency alignment (cost bound). */
  maxAlignTracks?: number;
}

/** EMA factor for the margin statistic (as v1). */
const MARGIN_EMA_BLEND = 0.2;
/** Per-vote decay of the phase histogram (≈ 100 decodes of memory), so k can
 * move if the latency really changes. */
const K_DECAY = 0.99;

interface Windows {
  /** First absolute frame held. */
  lo: number;
  w: Float64Array;
  n: Int32Array;
  r: Float64Array;
  g: Float64Array;
  b: Float64Array;
}

const mod = (x: number, m: number): number => ((x % m) + m) % m;

export class StaggerDecoder implements CodeDecoder {
  private readonly guard: number;
  private readonly maxMissing: number;
  private readonly alignBlend: number;
  private readonly alignStepFrac: number;
  private readonly minConfidence: number;
  private readonly minOnSamples: number;
  private readonly confirmCycles: number;
  private readonly minPilotScore: number;
  private readonly kMinVotes: number;
  private readonly kMinShare: number;
  private readonly maxAlignTracks: number;
  readonly quality: ChannelQuality;
  private readonly C: number;
  private readonly bp: number;
  private readonly half: number;
  private readonly nDataFrames: number;
  /** The sync-position colours (the palette pilot, or a comparator's). */
  private readonly pilot: readonly Rgb[];
  /** Pilot length L (data window d is frame a + L + d). */
  private readonly L: number;
  /** Per channel: pilot frames where it is lit / dark (calibration + score). */
  private readonly lit: number[][];
  private readonly dark: number[][];

  /** Sub-frame shift (ms), continuous (never wrapped, so k stays meaningful). */
  private subShift = 0;
  private alignInitialized = false;
  private firstServerMs: number | null = null;
  private lastE: number | null = null;
  private lastAlignE = -Infinity;
  private readonly kHist: Float64Array;
  private kLocked: number | null = null;
  private readonly phaseCache = new Map<number, number>();
  private readonly lastPilot = new WeakMap<Track, number>();
  private readonly lastMiss = new WeakMap<Track, number>();
  private readonly lastEmitted = new Map<number, number>();

  readonly stats: DecodeStats = newDecodeStats();

  constructor(
    private readonly params: CodeParams,
    private readonly epochMs: number,
    private readonly toServerTime: (tLocalMs: number) => number,
    opts: StaggerDecoderOptions = {},
  ) {
    this.guard = opts.windowGuardFrac ?? 0.15;
    this.maxMissing = opts.maxMissingWindows ?? 0;
    this.alignBlend = opts.alignBlend ?? 0.3;
    this.alignStepFrac = Math.min(0.1, opts.alignStepFrac ?? 0.05);
    this.minConfidence = opts.minConfidence ?? 0.4;
    this.minOnSamples = opts.minOnSamples ?? 3;
    this.confirmCycles = Math.max(1, opts.confirmCycles ?? 2);
    this.quality = opts.quality ?? new ChannelQuality();
    this.minPilotScore = opts.minPilotScore ?? 0.15;
    this.kMinVotes = opts.kMinVotes ?? 4;
    this.kMinShare = opts.kMinShare ?? 0.5;
    this.maxAlignTracks = opts.maxAlignTracks ?? 160;
    this.C = params.cycleFrames;
    this.bp = params.bitPeriodMs;
    this.half = Math.floor(this.C / 2);
    this.nDataFrames = dataFrames(params);
    if (syncCode(params) === 0) throw new RangeError("StaggerDecoder needs a staggered syncPattern");
    this.pilot = syncColors(params);
    this.L = this.pilot.length;
    this.lit = [0, 1, 2].map((c) => this.pilot.flatMap((col, j) => (col[c]! >= 0.5 ? [j] : [])));
    this.dark = [0, 1, 2].map((c) => this.pilot.flatMap((col, j) => (col[c]! < 0.5 ? [j] : [])));
    this.kHist = new Float64Array(this.C);
  }

  /** The total latency estimate (ms) once k has locked: shift + k·bitPeriod. */
  get latencyMs(): number | null {
    if (this.kLocked === null) return null;
    const k = this.kLocked > this.C / 2 ? this.kLocked - this.C : this.kLocked;
    return this.subShift + k * this.bp;
  }

  get lastCycle(): number | null {
    return this.lastE === null ? null : Math.floor(this.lastE / this.C);
  }

  cycleStartServerMs(cycleIndex: number): number {
    return this.epochMs + this.subShift + cycleIndex * cycleMs(this.params);
  }

  /** Samples older than this (server ms) can't reach any pending decode. */
  pruneCutoffServerMs(): number | null {
    if (this.lastE === null) return null;
    return this.epochMs + this.subShift + (this.lastE - this.C - this.half - 2) * this.bp;
  }

  step(tracks: readonly Track[], tLocalMs: number, _chromaSyncCount = 0): DetectionRecord[] {
    const tServer = this.toServerTime(tLocalMs);
    if (this.firstServerMs === null) this.firstServerMs = tServer;
    let E = this.absFrame(tServer - this.subShift) - 1;
    if (this.lastE === null) {
      this.lastE = E;
      return [];
    }
    if (E <= this.lastE) return [];
    if (E - this.lastAlignE >= this.C) {
      this.updateAlignment(tracks, tServer);
      this.lastAlignE = E;
      E = this.absFrame(tServer - this.subShift) - 1;
      if (E <= this.lastE) return [];
    }

    const records: DetectionRecord[] = [];
    // A stall can skip frames; only the last few can still be decoded well.
    for (let e = Math.max(this.lastE + 1, E - 2); e <= E; e++) {
      if (Math.floor(e / this.C) !== Math.floor((e - 1) / this.C)) this.stats.cyclesCompleted++;
      const a = e - this.C + 1;
      const bestById = new Map<number, { rec: DetectionRecord; intensity: number; released: DetectionRecord[] }>();
      let decoded = 0;
      for (const track of tracks) {
        const hit = this.decodeTrackAt(track, a, e);
        if (hit === null) continue;
        decoded++;
        const prev = bestById.get(hit.rec.ledId);
        if (
          prev === undefined ||
          hit.intensity > prev.intensity ||
          (hit.intensity === prev.intensity && hit.rec.confidence > prev.rec.confidence)
        ) {
          bestById.set(hit.rec.ledId, hit);
        }
      }
      let kept = 0;
      for (const [id, h] of bestById) {
        // Reflection dedup per id over one cycle: every sighting of one LED
        // shares its pilot frame.
        if (this.lastEmitted.get(id) === a) continue;
        this.lastEmitted.set(id, a);
        records.push(h.rec, ...h.released);
        kept++;
      }
      this.stats.rejectedDuplicate += decoded - kept;
    }
    this.lastE = E;
    this.stats.recordsEmitted += records.length;
    this.stats.alignShiftMs = this.latencyMs ?? this.subShift;
    this.stats.phaseK = this.kLocked;
    return records;
  }

  // -- internals ----------------------------------------------------------

  private absFrame(tAlignedServer: number): number {
    return Math.floor((tAlignedServer - this.epochMs) / this.bp);
  }

  private phaseOf(id: number): number {
    let p = this.phaseCache.get(id);
    if (p === undefined) {
      p = staggerPhase(id, this.params);
      this.phaseCache.set(id, p);
    }
    return p;
  }

  /** Bucket a track's samples into absolute windows [lo, hi]. */
  private windows(track: Track, lo: number, hi: number): Windows {
    const n = hi - lo + 1;
    const out: Windows = {
      lo,
      w: new Float64Array(n),
      n: new Int32Array(n),
      r: new Float64Array(n),
      g: new Float64Array(n),
      b: new Float64Array(n),
    };
    for (const s of track.samples) {
      if (!s.on) continue;
      const x = (this.toServerTime(s.tCaptureMs) - this.subShift - this.epochMs) / this.bp;
      const f = Math.floor(x);
      if (f < lo || f > hi) continue;
      const frac = x - f;
      const w = Math.min(frac, 1 - frac) - this.guard;
      if (w <= 0) continue;
      const i = f - lo;
      out.w[i]! += w;
      out.n[i]!++;
      out.r[i]! += w * s.r;
      out.g[i]! += w * s.g;
      out.b[i]! += w * s.b;
    }
    return out;
  }

  private mean(win: Windows, f: number): [number, number, number] | null {
    const i = f - win.lo;
    const w = win.w[i];
    if (w === undefined || w === 0) return null;
    return [win.r[i]! / w, win.g[i]! / w, win.b[i]! / w];
  }

  /**
   * How much windows f .. f+L-1 look like the pilot; 1 = ideal, null = a
   * window is empty. Per channel lit in some pilot frame and dark in another:
   * the contrast (min lit − max dark) / (min lit + max dark), which per-channel
   * gain, white balance and colour correction cancel out of; the score is the
   * worst channel's. A veil v at LED level L lowers it to L / (L + 2v).
   */
  private pilotScore(win: Windows, f: number): number | null {
    const cs: [number, number, number][] = [];
    for (let j = 0; j < this.L; j++) {
      const c = this.mean(win, f + j);
      if (c === null) return null;
      cs.push(c);
    }
    let score = Infinity;
    for (let ch = 0; ch < 3; ch++) {
      const lit = this.lit[ch]!;
      const dark = this.dark[ch]!;
      if (lit.length === 0 || dark.length === 0) continue;
      let on = Infinity;
      let off = -Infinity;
      for (const j of lit) on = Math.min(on, cs[j]![ch]!);
      for (const j of dark) off = Math.max(off, cs[j]![ch]!);
      score = Math.min(score, on + off <= 1e-6 ? -1 : (on - off) / (on + off));
    }
    return Number.isFinite(score) ? score : -1;
  }

  /**
   * The per-channel calibration the pilot at `a` measured, as (off, span): a
   * data window reads `(x − off) / span` per channel. The palette pilot lights
   * every channel the palette uses in one of its frames and leaves it dark in
   * another, so it measures each channel's ON level and its OFF level (ambient
   * veil, sensor black, glare) — v1's white frame gave only the gains. A
   * channel the pilot never lights (green under the red/blue alphabet) reads
   * relative to its pilot mean, at the other channels' mean span; one it never
   * darkens (a white comparator frame) has off = 0.
   */
  private calibration(win: Windows, a: number): { off: [number, number, number]; span: [number, number, number] } | null {
    const cs: [number, number, number][] = [];
    for (let j = 0; j < this.L; j++) {
      const c = this.mean(win, a + j);
      if (c === null) return null;
      cs.push(c);
    }
    const mean = (js: number[], ch: number): number => js.reduce((t, j) => t + cs[j]![ch]!, 0) / js.length;
    const off: [number, number, number] = [0, 0, 0];
    const span: [number, number, number] = [NaN, NaN, NaN];
    for (let ch = 0; ch < 3; ch++) {
      const lit = this.lit[ch]!;
      const dark = this.dark[ch]!;
      if (lit.length > 0) {
        off[ch] = dark.length > 0 ? mean(dark, ch) : 0;
        span[ch] = mean(lit, ch) - off[ch]!;
      } else {
        off[ch] = mean(dark, ch);
      }
    }
    const known = span.filter((x) => !Number.isNaN(x));
    const fill = known.length > 0 ? known.reduce((t, x) => t + x, 0) / known.length : 0;
    for (let ch = 0; ch < 3; ch++) if (Number.isNaN(span[ch])) span[ch] = fill;
    return { off, span };
  }

  private decodeTrackAt(
    track: Track,
    a: number,
    e: number,
  ): { rec: DetectionRecord; intensity: number; released: DetectionRecord[] } | null {
    const p = this.params;
    const C = this.C;
    const h = this.half;
    const win = this.windows(track, a - h, e);

    // Pilot: the candidate must clear the floor and be the best pair within
    // ±C/2 (the true pilot recurs every C; data repeats every C too, so a
    // false delimiter is only ever a weaker local candidate).
    const sa = this.pilotScore(win, a);
    if (sa === null || sa < this.minPilotScore) {
      this.noteMiss(track, win, a, e);
      return null;
    }
    for (let x = a - h; x <= a + h; x++) {
      if (x === a || x + this.L - 1 > e) continue;
      const sx = this.pilotScore(win, x);
      if (sx !== null && (sx > sa || (x < a && sx === sa))) {
        this.noteMiss(track, win, a, e);
        return null;
      }
    }
    this.lastPilot.set(track, a);
    this.stats.pilotCycles++;

    const cal = this.calibration(win, a)!;
    const [or, og, ob] = cal.off;
    const [wr, wg, wb] = cal.span;
    if (Math.min(wr, wg, wb) < 0.02) {
      this.stats.rejectedSync++;
      return null;
    }

    const palette = SYMBOL_COLORS[p.symbols]!;
    const minPairDist = p.symbols === 2 ? 2 : 1;
    let missing = 0;
    // Confidence is the calibrated data windows' margins: the pilot score falls
    // with the veil (L / (L + 2v)) that its on/off calibration removes, so it
    // gates the delimiter (minPilotScore) but does not cap the confidence.
    let minMargin = 1;
    const symbols: number[] = new Array(this.nDataFrames).fill(0);
    const seen: ([number, number, number] | null)[] = new Array(this.nDataFrames).fill(null);
    for (let d = 0; d < this.nDataFrames; d++) {
      const c = this.mean(win, a + this.L + d);
      if (c === null) {
        missing++;
        continue;
      }
      const rr = Math.max(0, (c[0] - or) / wr);
      const gg = Math.max(0, (c[1] - og) / wg);
      const bb = Math.max(0, (c[2] - ob) / wb);
      const mx = Math.max(rr, gg, bb, 1e-6);
      const o: [number, number, number] = [rr / mx, gg / mx, bb / mx];
      let best = -Infinity;
      let second = -Infinity;
      let bestSym = 0;
      for (let v = 0; v < palette.length; v++) {
        const t = palette[v]!;
        const sim = 1 - (Math.abs(o[0] - t[0]) + Math.abs(o[1] - t[1]) + Math.abs(o[2] - t[2])) / 3;
        if (sim > best) {
          second = best;
          best = sim;
          bestSym = v;
        } else if (sim > second) {
          second = sim;
        }
      }
      symbols[d] = bestSym;
      seen[d] = o;
      minMargin = Math.min(minMargin, ((best - second) * 3) / minPairDist);
    }
    if (missing > this.maxMissing) {
      this.stats.rejectedGaps++;
      return null;
    }

    // Anchor: the sample nearest the middle of this cycle.
    const tMid = this.epochMs + this.subShift + (a + C / 2) * this.bp;
    let anchor: TrackSample | null = null;
    let anchorDist = Infinity;
    for (const s of track.samples) {
      if (!s.on) continue;
      const d = Math.abs(this.toServerTime(s.tCaptureMs) - tMid);
      if (d < anchorDist) {
        anchorDist = d;
        anchor = s;
      }
    }
    if (anchor === null || anchorDist > (C / 2) * this.bp) return null;

    this.stats.marginEma =
      this.stats.marginEma === null
        ? minMargin
        : this.stats.marginEma + MARGIN_EMA_BLEND * (minMargin - this.stats.marginEma);

    const dec = decodeCycleSymbols(symbols, p);
    if (dec.id === null) {
      if (dec.uncorrectable) this.stats.rejectedFec++;
      else this.stats.rejectedRange++;
      this.quality.noteCycle(false);
      return null;
    }
    const ledId = dec.id;
    if (dec.corrected) this.stats.correctedCycles++;
    const confidence = Math.max(0, Math.min(1, minMargin));
    if (confidence < this.minConfidence) {
      this.stats.rejectedLowConf++;
      this.quality.noteCycle(false);
      return null;
    }
    let support = 0;
    for (let i = a - win.lo; i <= e - win.lo; i++) support += win.n[i]!;
    if (support < this.minOnSamples) {
      this.stats.rejectedSupport++;
      return null;
    }

    // Phase check: observed pilot phase − φ(id) ≡ k (mod C). Every FEC-valid
    // decode votes; once k has locked, a disagreeing decode is a hop (or a
    // false delimiter) and is rejected.
    const dk = mod(a - this.phaseOf(ledId), C);
    if (this.alignInitialized) this.vote(dk); // votes only on the settled frame grid
    if (this.kLocked === null) {
      this.stats.rejectedPhaseUnlocked++;
      return null;
    }
    if (dk !== this.kLocked) {
      this.stats.phaseRejects++;
      this.quality.noteCycle(false);
      return null;
    }
    this.quality.noteCycle(true);

    // Confirmation (as v1): consecutive agreeing decodes of this track.
    if (track.pendingId === ledId) track.pendingCount++;
    else {
      track.pendingId = ledId;
      track.pendingCount = 1;
      track.held.length = 0;
      track.heldDense.length = 0;
    }
    if (track.ledId !== null && track.ledId !== ledId) {
      this.stats.idFlips++;
      track.ledId = null;
    }
    const confirmed = track.pendingCount >= this.confirmCycles;
    if (confirmed) {
      for (let d = 0; d < this.nDataFrames; d++) {
        const o = seen[d];
        if (o != null) this.quality.add(o, symbolAt(ledId, d, p), symbols[d]!, p.symbols);
      }
      this.stats.uniqueIds.add(ledId);
      track.ledId = ledId;
      track.ledConfidence = confidence;
    }

    // Latency-corrected pose pairing (as v1, with shift + k·bitPeriod).
    let meta = anchor.meta;
    const latency = this.latencyMs ?? 0;
    if (this.alignInitialized && latency > 0) {
      const tExposure = anchor.tCaptureMs - latency;
      let best = Infinity;
      for (const s of track.samples) {
        const d = Math.abs(s.tCaptureMs - tExposure);
        if (d < best) {
          best = d;
          meta = s.meta;
        }
      }
      if (best > 40) {
        this.stats.rejectedPoseGap++;
        return null;
      }
    }
    const rec: DetectionRecord = {
      ledId,
      tCaptureMs: anchor.tCaptureMs,
      u: anchor.u,
      v: anchor.v,
      imgW: meta.imgW,
      imgH: meta.imgH,
      K: meta.K,
      pose: meta.pose,
      confidence,
    };
    if (!confirmed) {
      this.stats.rejectedUnconfirmed++;
      if (track.held.length < MAX_HELD) track.held.push(rec);
      return null;
    }
    const released = track.held.splice(0);
    return { rec, intensity: anchor.intensity, released };
  }

  /** Telemetry: a track lit through a whole cycle with no pilot found. */
  private noteMiss(track: Track, win: Windows, a: number, e: number): void {
    const last = this.lastPilot.get(track) ?? -Infinity;
    const lastMiss = this.lastMiss.get(track) ?? -Infinity;
    if (last >= a - this.C || lastMiss > a - this.C) return;
    for (let f = a; f <= e; f++) if (win.w[f - win.lo] === 0) return;
    this.lastMiss.set(track, a);
    this.stats.delimiterMisses++;
  }

  private vote(dk: number): void {
    let total = 0;
    let best = 0;
    for (let i = 0; i < this.C; i++) {
      this.kHist[i]! *= K_DECAY;
      total += this.kHist[i]!;
    }
    this.kHist[dk]! += 1;
    total += 1;
    for (let i = 1; i < this.C; i++) if (this.kHist[i]! > this.kHist[best]!) best = i;
    const top = this.kHist[best]!;
    if (top >= this.kMinVotes && top / total >= this.kMinShare) this.kLocked = best;
  }

  /**
   * Sub-frame alignment by pooled within-window consistency: the shift (mod
   * bitPeriod) that minimises the chromaticity scatter inside each track's
   * frame windows. Every LED changes colour on the same frame grid, whatever
   * its phase, so this works on a staggered fixture where v1's green census is
   * flat.
   */
  private updateAlignment(tracks: readonly Track[], tServer: number): void {
    const cyc = cycleMs(this.params);
    if (this.firstServerMs === null || tServer - this.firstServerMs < 1.5 * cyc) return;
    const bp = this.bp;
    const since = tServer - 2 * cyc;
    // Per-track (time, chromaticity) of on-samples over the last two cycles.
    const series: { t: Float64Array; c: Float64Array }[] = [];
    for (const tr of tracks) {
      if (series.length >= this.maxAlignTracks) break;
      const ts: number[] = [];
      const cs: number[] = [];
      for (const s of tr.samples) {
        if (!s.on) continue;
        const t = this.toServerTime(s.tCaptureMs);
        if (t < since) continue;
        const sum = s.r + s.g + s.b;
        if (sum <= 1e-6) continue;
        ts.push(t - this.epochMs);
        cs.push(s.r / sum, s.g / sum, s.b / sum);
      }
      if (ts.length >= 6) series.push({ t: Float64Array.from(ts), c: Float64Array.from(cs) });
    }
    if (series.length === 0) return;
    const steps = Math.round(1 / this.alignStepFrac);
    const scores: number[] = [];
    for (let k = 0; k < steps; k++) {
      const shift = -bp / 2 + k * this.alignStepFrac * bp;
      let sse = 0;
      for (const { t, c } of series) {
        let cur = NaN;
        let n = 0;
        let s0 = 0;
        let s1 = 0;
        let s2 = 0;
        let q = 0;
        const flush = (): void => {
          if (n > 0) sse += q - (s0 * s0 + s1 * s1 + s2 * s2) / n;
        };
        for (let i = 0; i < t.length; i++) {
          const f = Math.floor((t[i]! - shift) / bp);
          if (f !== cur) {
            flush();
            cur = f;
            n = 0;
            s0 = s1 = s2 = q = 0;
          }
          const x = c[3 * i]!;
          const y = c[3 * i + 1]!;
          const z = c[3 * i + 2]!;
          n++;
          s0 += x;
          s1 += y;
          s2 += z;
          q += x * x + y * y + z * z;
        }
        flush();
      }
      scores.push(-sse);
    }
    const bestScore = Math.max(...scores);
    if (!Number.isFinite(bestScore)) return;
    // Centre of the best plateau, circular over one bit period (as v1).
    const n = scores.length;
    const tol = 1e-9 * Math.max(1, Math.abs(bestScore));
    const isTop = (i: number): boolean => scores[i % n]! >= bestScore - tol;
    let runStart = 0;
    let bestRunStart = 0;
    let bestRunLen = 0;
    let runLen = 0;
    for (let i = 0; i < 2 * n; i++) {
      if (isTop(i)) {
        if (runLen === 0) runStart = i;
        runLen++;
        if (runLen > bestRunLen && runLen <= n) {
          bestRunLen = runLen;
          bestRunStart = runStart;
        }
      } else {
        runLen = 0;
      }
    }
    if (bestRunLen === n) return; // flat: no colour changes seen yet
    const centerIdx = bestRunStart + (bestRunLen - 1) / 2;
    const best = -bp / 2 + (centerIdx % n) * this.alignStepFrac * bp;
    if (!this.alignInitialized) {
      this.subShift = best;
      this.alignInitialized = true;
      return;
    }
    // Circularly nearest (mod bitPeriod) to the current shift: the shift
    // stays continuous, so the locked k keeps its meaning.
    const delta = mod(best - this.subShift + bp / 2, bp) - bp / 2;
    this.subShift += this.alignBlend * delta;
  }
}
