/**
 * M6 decode stage: turn each track's per-frame on/off history into an LED id
 * once per completed cycle, and emit `DetectionRecord`s (§7.4).
 *
 * Frame times are mapped onto the pattern clock via the synced server clock
 * (§8.2), then corrected by a **self-clocking alignment** estimated from the
 * data itself (§8.1): the ALL_ON→ALL_OFF sync delimiter is visible as a
 * global brightness spike/dip, so the decoder scans for the intra-cycle shift
 * that best aligns observed global on-counts with the delimiter. This absorbs
 * constant camera→rAF latency and residual clock-sync error, which would
 * otherwise smear every bit window.
 *
 * Per cycle and per track: samples are bucketed into the cycle's frame
 * windows and each window votes on/off by CENTRALITY-WEIGHTED majority: a
 * sample's weight grows with its distance from the window edges (zero inside
 * the guard band), so samples near a bit transition barely count — tolerating
 * rolling shutter and residual misalignment — without starving windows. A
 * hard, wide guard did starve them: at 30 fps against 100 ms bits, the
 * 33 ms-vs-100 ms phase alias left some window empty for multi-cycle
 * stretches, rejecting every track's cycle. The delimiter is verified and the
 * data bits Gray-decode to an id (codewords carry id+1 — see code/gray.ts).
 * Confidence comes from the worst window's weighted margin. One
 * DetectionRecord per (track, cycle), anchored at the track's measured
 * position during the ALL_ON frame.
 */

import type { CodeParams, DetectionRecord } from "@ledmapper/protocol";
import { decodeCycle, FRAME_ALL_OFF, FRAME_ALL_ON } from "../code/gray";
import { cycleIndexAt, cycleMs, frameFractionAt, frameIndexAt } from "../code/timing";
import type { Track, TrackSample } from "./tracker";

export interface DecoderOptions {
  /**
   * Fraction of each bit window with ZERO weight at BOTH edges (transition
   * guard). Above it, sample weight ramps with distance from the edge.
   * Keep below one camera-frame interval / bitPeriod (≈0.33 at 30 fps,
   * 100 ms bits) or windows can end up with no weighted samples.
   */
  windowGuardFrac?: number;
  /** Max data windows with no usable sample before the cycle is discarded. */
  maxMissingWindows?: number;
  /** EMA factor for the alignment-shift estimate. */
  alignBlend?: number;
  /** Alignment search resolution as a fraction of the bit period. */
  alignStepFrac?: number;
  /**
   * Reject decodes whose worst window margin is below this. Marginal cycles
   * (50/50 windows → confidence 0) are exactly what exposure pumping and
   * reflections produce in bulk — feeding them to the solver poisons it.
   */
  minConfidence?: number;
  /**
   * Minimum ON samples (weighted-in, in windows decoded as lit) for a cycle
   * to count. Margin measures agreement, not EVIDENCE: one sample per window
   * decodes with margin 1.0, which is how sparse noise chains stitched by
   * the coasting tracker forge clean codewords. A real LED is lit for
   * ALL_ON plus ≥1 data frame ≈ 6 samples/cycle at 30 fps and 100 ms bits.
   */
  minOnSamples?: number;
}

export interface DecodeStats {
  cyclesCompleted: number;
  recordsEmitted: number;
  /** Distinct LED ids ever decoded. */
  uniqueIds: Set<number>;
  /** Current alignment shift estimate, ms. */
  alignShiftMs: number;
  /** Cycles rejected: bad sync delimiter. */
  rejectedSync: number;
  /** Cycles rejected: too many empty windows. */
  rejectedGaps: number;
  /** Cycles rejected: decoded id out of range. */
  rejectedRange: number;
  /** Cycles rejected: confidence below minConfidence. */
  rejectedLowConf: number;
  /** Cycles rejected: too few ON samples backing the decoded word. */
  rejectedSupport: number;
  /** Records dropped: another track decoded the same id this cycle, brighter. */
  rejectedDuplicate: number;
}

interface GlobalSample {
  tServerMs: number;
  onCount: number;
}

export class Decoder {
  private readonly guard: number;
  private readonly maxMissing: number;
  private readonly alignBlend: number;
  private readonly alignStep: number;
  private readonly minConfidence: number;
  private readonly minOnSamples: number;
  /** gray-hue mode: bits carried by color relative to the white sync frame. */
  private readonly hue: boolean;

  private lastCompletedCycle: number | null = null;
  private globalSamples: GlobalSample[] = [];
  private alignShift = 0;
  private alignInitialized = false;

  readonly stats: DecodeStats = {
    cyclesCompleted: 0,
    recordsEmitted: 0,
    uniqueIds: new Set<number>(),
    alignShiftMs: 0,
    rejectedSync: 0,
    rejectedGaps: 0,
    rejectedRange: 0,
    rejectedLowConf: 0,
    rejectedSupport: 0,
    rejectedDuplicate: 0,
  };

  constructor(
    private readonly params: CodeParams,
    private readonly epochMs: number,
    private readonly toServerTime: (tLocalMs: number) => number,
    opts: DecoderOptions = {},
  ) {
    this.guard = opts.windowGuardFrac ?? 0.15;
    this.maxMissing = opts.maxMissingWindows ?? 0;
    this.alignBlend = opts.alignBlend ?? 0.3;
    this.alignStep = (opts.alignStepFrac ?? 0.1) * params.bitPeriodMs;
    this.minConfidence = opts.minConfidence ?? 0.4;
    this.minOnSamples = opts.minOnSamples ?? 3;
    this.hue = params.encoding === "gray-hue";
  }

  /**
   * Feed one frame's global result (after tracker.step) and decode any cycle
   * that has just completed. Returns the records decoded from that cycle.
   *
   * `chromaSyncCount` (gray-hue mode): how many of this frame's blobs are
   * saturated GREEN — the chroma-domain delimiter signal the self-clocking
   * alignment keys on when there is no global brightness dip to find.
   */
  step(
    tracks: readonly Track[],
    matchedCount: number,
    tLocalMs: number,
    chromaSyncCount = 0,
  ): DetectionRecord[] {
    const tServer = this.toServerTime(tLocalMs);
    this.globalSamples.push({
      tServerMs: tServer,
      onCount: this.hue ? chromaSyncCount : matchedCount,
    });

    const cycle = cycleIndexAt(tServer - this.alignShift, this.epochMs, this.params);
    if (this.lastCompletedCycle === null) {
      // First frame: start collecting from the NEXT cycle boundary; the
      // current cycle is partial.
      this.lastCompletedCycle = cycle;
      return [];
    }
    if (cycle <= this.lastCompletedCycle) return [];

    // Cycle(s) up to `cycle - 1` are complete. Decode the most recent
    // complete one (skipping any missed entirely due to a stall).
    const target = cycle - 1;
    this.lastCompletedCycle = cycle;

    this.updateAlignment();

    // Decode every track, then keep at most ONE record per LED id for this
    // cycle: the physical LED and any reflection of it blink the same code,
    // so same-id collisions are expected in shiny/dark scenes — the direct
    // sighting is (almost always) the brightest. Without this, reflections
    // and exposure-pump artifacts outvote the real LED in the solver.
    const bestById = new Map<number, { rec: DetectionRecord; intensity: number }>();
    let decoded = 0;
    for (const track of tracks) {
      const hit = this.decodeTrackCycle(track, target);
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
    const records: DetectionRecord[] = [...bestById.values()].map((h) => h.rec);
    this.stats.rejectedDuplicate += decoded - records.length;
    this.stats.cyclesCompleted++;
    this.stats.recordsEmitted += records.length;
    this.stats.alignShiftMs = this.alignShift;

    // Keep global samples for ~2 cycles for the alignment estimator.
    const keepAfter = tServer - 2 * cycleMs(this.params);
    let firstKept = 0;
    while (firstKept < this.globalSamples.length && this.globalSamples[firstKept]!.tServerMs < keepAfter) firstKept++;
    if (firstKept > 0) this.globalSamples.splice(0, firstKept);

    return records;
  }

  /** Server-time (aligned) helper for pruning: start of the given cycle. */
  cycleStartServerMs(cycleIndex: number): number {
    return this.epochMs + this.alignShift + cycleIndex * cycleMs(this.params);
  }

  get lastCycle(): number | null {
    return this.lastCompletedCycle;
  }

  // -- internals ----------------------------------------------------------

  /**
   * Self-clocking alignment (§8.1): find the shift that maximizes global
   * on-count in the ALL_ON window minus the ALL_OFF window.
   */
  private updateAlignment(): void {
    const p = this.params;
    const cyc = cycleMs(p);
    // Estimating from less than ~1.5 cycles of data is worse than not
    // estimating: with a fraction of a cycle observed, the score plateau is
    // enormous and its center can land bit-periods away from the truth — an
    // error the EMA then takes several cycles to walk back, rejecting every
    // decode in the meantime. Until then alignShift stays 0.
    const nSamples = this.globalSamples.length;
    if (nSamples < p.cycleFrames) return;
    const span =
      this.globalSamples[nSamples - 1]!.tServerMs - this.globalSamples[0]!.tServerMs;
    if (span < 1.5 * cyc) return;
    const half = cyc / 2;
    const shifts: number[] = [];
    const scores: number[] = [];
    for (let shift = -half; shift < half; shift += this.alignStep) {
      let onSum = 0;
      let onN = 0;
      let offSum = 0;
      let offN = 0;
      for (const s of this.globalSamples) {
        const idx = frameIndexAt(s.tServerMs - shift, this.epochMs, p);
        const frac = frameFractionAt(s.tServerMs - shift, this.epochMs, p);
        if (frac < this.guard || frac > 1 - this.guard) continue;
        if (idx === 0) {
          onSum += s.onCount;
          onN++;
        } else if (idx === 1) {
          offSum += s.onCount;
          offN++;
        }
      }
      shifts.push(shift);
      // gray: the delimiter is bright-then-dark (on-count high in ALL_ON, low
      // in ALL_OFF). gray-hue: the fed signal is the GREEN census, maximal in
      // ALL_OFF and near-zero in ALL_ON — same estimator, flipped sign.
      const contrast = onN === 0 || offN === 0 ? null : onSum / onN - offSum / offN;
      scores.push(contrast === null ? -Infinity : this.hue ? -contrast : contrast);
    }
    const bestScore = Math.max(...scores);
    if (!Number.isFinite(bestScore) || bestScore <= 0) return; // no delimiter signal yet

    // The score is plateau-shaped (sparse samples: many shifts classify every
    // sample identically), so take the CENTER of the best plateau, not its
    // first index — centering maximizes guard margin against jitter. The
    // plateau can wrap around ±cycle/2; unwrap by scanning a doubled array.
    const n = scores.length;
    const isTop = (i: number) => scores[i % n]! >= bestScore - 1e-9;
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
    const centerIdx = bestRunStart + (bestRunLen - 1) / 2;
    let bestShift = -half + centerIdx * this.alignStep;
    if (bestShift >= half) bestShift -= cyc;
    if (!this.alignInitialized) {
      this.alignShift = bestShift;
      this.alignInitialized = true;
    } else {
      // Blend circularly-nearest estimate to avoid ±cycle/2 wraparound jumps.
      let delta = bestShift - this.alignShift;
      if (delta > half) delta -= cyc;
      if (delta < -half) delta += cyc;
      this.alignShift += this.alignBlend * delta;
    }
  }

  private decodeTrackCycle(
    track: Track,
    cycleIndex: number,
  ): { rec: DetectionRecord; intensity: number } | null {
    const p = this.params;

    // Bucket this cycle's samples into frame windows with centrality
    // weighting: weight ramps from 0 at the guard edge to max at the window
    // center, so near-transition samples barely vote but never starve a
    // window that has any mid-window sample.
    const windowOnW: number[] = new Array(p.cycleFrames).fill(0);
    const windowW: number[] = new Array(p.cycleFrames).fill(0);
    const windowOnN: number[] = new Array(p.cycleFrames).fill(0);
    const windowR: number[] = new Array(p.cycleFrames).fill(0);
    const windowG: number[] = new Array(p.cycleFrames).fill(0);
    const windowB: number[] = new Array(p.cycleFrames).fill(0);
    let anchorSample: TrackSample | null = null;
    let anchorDist = Infinity;

    for (const s of track.samples) {
      const tAligned = this.toServerTime(s.tCaptureMs) - this.alignShift;
      if (cycleIndexAt(tAligned, this.epochMs, p) !== cycleIndex) continue;
      const frac = frameFractionAt(tAligned, this.epochMs, p);
      const w = Math.min(frac, 1 - frac) - this.guard;
      if (w <= 0) continue;
      const idx = frameIndexAt(tAligned, this.epochMs, p);
      windowW[idx]! += w;
      if (s.on) {
        windowOnW[idx]! += w;
        windowOnN[idx]!++;
        windowR[idx]! += w * s.r;
        windowG[idx]! += w * s.g;
        windowB[idx]! += w * s.b;
      }
      // Anchor the record at the sample nearest the ALL_ON window center.
      if (idx === FRAME_ALL_ON && s.on) {
        const d = Math.abs(frac - 0.5);
        if (d < anchorDist) {
          anchorDist = d;
          anchorSample = s;
        }
      }
    }

    let missing = 0;
    let minMargin = 1;
    const frames: boolean[] = new Array(p.cycleFrames);
    if (this.hue) {
      // gray-hue: every LED is lit every frame; bits live in COLOR measured
      // RELATIVE to this track's own ALL_ON (white) window. Channel-wise
      // division by the white reference cancels white balance/color
      // correction exactly, and a static-hue blob (lamp, reflection)
      // normalizes to neutral in every window — failing the green sync.
      if (windowOnW[FRAME_ALL_ON] === 0) {
        this.stats.rejectedGaps++;
        return null;
      }
      const refW = windowOnW[FRAME_ALL_ON]!;
      const wr = windowR[FRAME_ALL_ON]! / refW;
      const wg = windowG[FRAME_ALL_ON]! / refW;
      const wb = windowB[FRAME_ALL_ON]! / refW;
      if (Math.min(wr, wg, wb) < 0.02) {
        this.stats.rejectedSync++; // reference too dark/colored to normalize
        return null;
      }
      frames[FRAME_ALL_ON] = true;
      frames[FRAME_ALL_OFF] = false;
      for (let k = 0; k < p.cycleFrames; k++) {
        if (k === FRAME_ALL_ON) continue;
        if (windowOnW[k] === 0) {
          missing++;
          if (k >= 2) frames[k] = false;
          continue;
        }
        const rr = windowR[k]! / windowOnW[k]! / wr;
        const gg = windowG[k]! / windowOnW[k]! / wg;
        const bb = windowB[k]! / windowOnW[k]! / wb;
        const mx = Math.max(rr, gg, bb, 1e-6);
        if (k === FRAME_ALL_OFF) {
          // Chroma sync: the delimiter window must read GREEN.
          const gScore = (gg - (rr + bb) / 2) / mx;
          if (gScore < 0.25) {
            this.stats.rejectedSync++;
            return null;
          }
          minMargin = Math.min(minMargin, gScore);
        } else {
          // Bit axis: red (+) vs blue (−), orthogonal to the sync axis.
          const opp = (rr - (gg + bb) / 2) / mx;
          frames[k] = opp > 0;
          minMargin = Math.min(minMargin, Math.abs(opp));
        }
      }
      if (missing > this.maxMissing) {
        this.stats.rejectedGaps++;
        return null;
      }
    } else {
      for (let k = 0; k < p.cycleFrames; k++) {
        if (windowW[k] === 0) {
          missing++;
          frames[k] = false;
          continue;
        }
        const onFrac = windowOnW[k]! / windowW[k]!;
        frames[k] = onFrac >= 0.5;
        minMargin = Math.min(minMargin, Math.abs(onFrac - 0.5) * 2);
      }
      if (missing > this.maxMissing) {
        this.stats.rejectedGaps++;
        return null;
      }
      if (!frames[0] || frames[1]) {
        this.stats.rejectedSync++;
        return null;
      }
    }
    if (anchorSample === null) return null;

    const ledId = decodeCycle(frames, p);
    if (ledId === null) {
      this.stats.rejectedRange++;
      return null;
    }

    const confidence = Math.max(0, Math.min(1, minMargin));
    if (confidence < this.minConfidence) {
      this.stats.rejectedLowConf++;
      return null;
    }

    // Evidence gate: margin says the windows AGREE, support says how many
    // real sightings back the decode. One-sample windows decode with margin
    // 1.0, which is how noise chains forge codewords. gray: count sightings
    // in the LIT windows (dark windows legitimately have none); gray-hue:
    // every window is lit, count them all.
    let support = 0;
    for (let k = 0; k < p.cycleFrames; k++) {
      if (this.hue || frames[k]) support += windowOnN[k]!;
    }
    if (support < this.minOnSamples) {
      this.stats.rejectedSupport++;
      return null;
    }

    this.stats.uniqueIds.add(ledId);
    // Label the track for live UI feedback (id overlays in the camera view).
    track.ledId = ledId;
    track.ledConfidence = confidence;
    const meta = anchorSample.meta;
    return {
      rec: {
        ledId,
        tCaptureMs: anchorSample.tCaptureMs,
        u: anchorSample.u,
        v: anchorSample.v,
        imgW: meta.imgW,
        imgH: meta.imgH,
        K: meta.K,
        pose: meta.pose,
        confidence,
      },
      intensity: anchorSample.intensity,
    };
  }
}
