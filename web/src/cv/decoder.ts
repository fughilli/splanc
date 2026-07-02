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
 * windows (guard-banded — samples near a bit transition are discarded, which
 * also tolerates rolling shutter), each window votes on/off by majority, the
 * delimiter is verified, and the data bits Gray-decode to an id. Confidence
 * comes from the worst window margin. One DetectionRecord per (track, cycle),
 * anchored at the track's measured position during the ALL_ON frame.
 */

import type { CodeParams, DetectionRecord } from "@ledmapper/protocol";
import { decodeCycle, FRAME_ALL_ON } from "../code/gray";
import { cycleIndexAt, cycleMs, frameFractionAt, frameIndexAt } from "../code/timing";
import type { Track, TrackSample } from "./tracker";

export interface DecoderOptions {
  /** Fraction of each bit window discarded at BOTH edges (transition guard). */
  windowGuardFrac?: number;
  /** Max data windows with no usable sample before the cycle is discarded. */
  maxMissingWindows?: number;
  /** EMA factor for the alignment-shift estimate. */
  alignBlend?: number;
  /** Alignment search resolution as a fraction of the bit period. */
  alignStepFrac?: number;
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
  };

  constructor(
    private readonly params: CodeParams,
    private readonly epochMs: number,
    private readonly toServerTime: (tLocalMs: number) => number,
    opts: DecoderOptions = {},
  ) {
    this.guard = opts.windowGuardFrac ?? 0.25;
    this.maxMissing = opts.maxMissingWindows ?? 0;
    this.alignBlend = opts.alignBlend ?? 0.3;
    this.alignStep = (opts.alignStepFrac ?? 0.1) * params.bitPeriodMs;
  }

  /**
   * Feed one frame's global result (after tracker.step) and decode any cycle
   * that has just completed. Returns the records decoded from that cycle.
   */
  step(tracks: readonly Track[], matchedCount: number, tLocalMs: number): DetectionRecord[] {
    const tServer = this.toServerTime(tLocalMs);
    this.globalSamples.push({ tServerMs: tServer, onCount: matchedCount });

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

    const records: DetectionRecord[] = [];
    for (const track of tracks) {
      const rec = this.decodeTrackCycle(track, target);
      if (rec) records.push(rec);
    }
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
    if (this.globalSamples.length < p.cycleFrames) return;
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
      scores.push(onN === 0 || offN === 0 ? -Infinity : onSum / onN - offSum / offN);
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

  private decodeTrackCycle(track: Track, cycleIndex: number): DetectionRecord | null {
    const p = this.params;

    // Bucket this cycle's samples into frame windows (guard-banded).
    const windowOn: number[] = new Array(p.cycleFrames).fill(0);
    const windowN: number[] = new Array(p.cycleFrames).fill(0);
    let anchorSample: TrackSample | null = null;
    let anchorDist = Infinity;

    for (const s of track.samples) {
      const tAligned = this.toServerTime(s.tCaptureMs) - this.alignShift;
      if (cycleIndexAt(tAligned, this.epochMs, p) !== cycleIndex) continue;
      const frac = frameFractionAt(tAligned, this.epochMs, p);
      if (frac < this.guard || frac > 1 - this.guard) continue;
      const idx = frameIndexAt(tAligned, this.epochMs, p);
      windowN[idx]!++;
      if (s.on) windowOn[idx]!++;
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
    for (let k = 0; k < p.cycleFrames; k++) {
      if (windowN[k] === 0) {
        missing++;
        frames[k] = false;
        continue;
      }
      const onFrac = windowOn[k]! / windowN[k]!;
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
    if (anchorSample === null) return null;

    const ledId = decodeCycle(frames, p);
    if (ledId === null) {
      this.stats.rejectedRange++;
      return null;
    }

    this.stats.uniqueIds.add(ledId);
    const meta = anchorSample.meta;
    return {
      ledId,
      tCaptureMs: anchorSample.tCaptureMs,
      u: anchorSample.u,
      v: anchorSample.v,
      imgW: meta.imgW,
      imgH: meta.imgH,
      K: meta.K,
      pose: meta.pose,
      confidence: Math.max(0, Math.min(1, minMargin)),
    };
  }
}
