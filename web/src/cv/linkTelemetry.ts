/**
 * Mapping optical-link telemetry (#448): what the capture's camera ⇄ LED link
 * negotiated and how much it delivered, recorded over the whole run so a
 * tuning change (exposure servo, symbol alphabet, signaling rate) can be
 * measured against a baseline — on a real phone capture (it rides in the
 * capture bundle, solver/captureBundle.ts v2) and in the moving-camera link
 * simulation (tests/linkSim.ts) alike. tools: `bazel run //web:link_bench`.
 *
 * Recorded:
 *  - `config`     every negotiated code configuration (start + each §7.1
 *                 configure): symbol alphabet (2/4), bit period, cycle length,
 *                 LED brightness — with the camera frames/bit it implied.
 *  - `exposure`   one sample per exposure tick (~2 s): the selected camera
 *                 exposure target, LED brightness, detector threshold and the
 *                 scene/cadence measurements the servos read, plus the
 *                 decoder's margin EMA (the chroma SNR the alphabet switch keys on).
 *  - `frames`     camera frame timing: interval histogram + quantiles, clipped
 *                 frames, and every frame-gap DROPOUT (gap ≥ 3 nominal intervals).
 *  - `timeline`   ~1 s samples of cumulative decode state: distinct ids,
 *                 records, completed cycles, every rejection class, SEC-DED
 *                 corrections and track id flips.
 *  - `firstSeen`  the capture time each LED id was first decoded — exact
 *                 time-to-coverage for any target fraction.
 *  - `ids`        decoded-ID correctness: ground-truth-free signals always
 *                 (track id flips, out-of-range words, FEC rejects) and, when a
 *                 truth oracle is attached (simulation, a surveyed HITL
 *                 fixture), exact correct / incorrect record counts.
 *
 * The decode pipeline is REBUILT on every renegotiation (fresh Decoder stats),
 * so decoder counters are folded across pipelines via `attachDecoder`.
 * Pure apart from the caller's timestamps; cheap enough for the frame loop
 * (O(1) per frame, O(records) per decode).
 */

import type { CodeParams, DetectionRecord } from "@ledmapper/protocol";
import type { DecodeStats } from "./decoder";

export const LINK_TELEMETRY_VERSION = 1;

/** Decoder counters the telemetry accumulates across pipeline rebuilds. */
export const DECODE_COUNTERS = [
  "cyclesCompleted",
  "recordsEmitted",
  "rejectedSync",
  "rejectedGaps",
  "rejectedRange",
  "rejectedFec",
  "correctedCycles",
  "rejectedLowConf",
  "rejectedSupport",
  "rejectedPoseGap",
  "rejectedDuplicate",
  "rejectedUnconfirmed",
  "idFlips",
] as const;
export type DecodeCounter = (typeof DECODE_COUNTERS)[number];
export type DecodeCounters = Record<DecodeCounter, number>;
/** What the telemetry reads from a decode pipeline (missing counters = 0). */
export type DecodeStatsLike = Partial<Pick<DecodeStats, DecodeCounter | "marginEma">>;

export interface LinkConfigEvent {
  /** ms since capture start. */
  tMs: number;
  reason: "start" | "reconfigure";
  symbols: number;
  bitPeriodMs: number;
  cycleFrames: number;
  ledCount: number;
  brightness: number | null;
  /** bitPeriodMs / measured frame interval at the switch (null = unknown):
   * the web/README timing constraint wants ≥ 3. */
  framesPerBit: number | null;
}

export interface LinkExposureSample {
  tMs: number;
  /** Camera exposure target in [0,1] (null = auto exposure / unknown). */
  exposure: number | null;
  brightness: number | null;
  threshold: number | null;
  frameIntervalMs: number | null;
  meanLuma: number | null;
  clipFrac: number | null;
  blobCount: number | null;
  marginEma: number | null;
}

export interface LinkTimelineSample {
  tMs: number;
  frames: number;
  /** Distinct LED ids decoded so far. */
  ids: number;
  /** Records emitted so far (whatever went to the solver). */
  records: number;
  symbols: number;
  bitPeriodMs: number;
  marginEma: number | null;
  /** Cumulative decoder counters. */
  decode: DecodeCounters;
  /** Truth-checked wrong records so far (null without an oracle). */
  wrong: number | null;
}

export interface LinkFrameGap {
  tMs: number;
  gapMs: number;
}

export interface LinkFrameTiming {
  count: number;
  clipped: number;
  /** Interval histogram: counts[i] covers [i·binMs, (i+1)·binMs); the last
   * bin is open-ended. */
  hist: { binMs: number; counts: number[] };
  p50Ms: number | null;
  p90Ms: number | null;
  p99Ms: number | null;
  maxMs: number | null;
  /** Frame-gap dropouts (≥ DROPOUT_FRAMES nominal intervals), capped. */
  gaps: LinkFrameGap[];
  gapCount: number;
  /** Total time lost in dropouts (sum of gap - nominal interval). */
  gapLostMs: number;
}

export interface LinkIdChecks {
  /** Accepted decodes that changed an already-labeled track's id. */
  idFlips: number;
  /** Words that decoded outside [0, ledCount) — a wrong word caught. */
  rangeRejects: number;
  fecCorrected: number;
  fecRejected: number;
  /** Exact checks against a truth oracle (null when none was attached). */
  truth: { checked: number; correct: number; wrong: number; wrongIds: number[] } | null;
}

export interface LinkTelemetrySnapshot {
  version: typeof LINK_TELEMETRY_VERSION;
  /** Where it came from: a capture run, the simulator, … */
  source: "capture" | "sim" | string;
  ledCount: number;
  durationMs: number;
  config: LinkConfigEvent[];
  exposure: LinkExposureSample[];
  frames: LinkFrameTiming;
  timeline: LinkTimelineSample[];
  /** [ledId, ms since start] of each id's first decode, in decode order. */
  firstSeen: [number, number][];
  decode: DecodeCounters;
  ids: LinkIdChecks;
}

/** A frame gap this many nominal intervals long counts as a dropout. */
export const DROPOUT_FRAMES = 3;
export const TIMELINE_PERIOD_MS = 1000;
const HIST_BIN_MS = 5;
const HIST_BINS = 100; // 0..500 ms, last bin open
const MAX_GAPS = 256;
const MAX_EXPOSURE = 2000;
const MAX_TIMELINE = 3600;
const MAX_CONFIG = 512;
const MAX_WRONG_IDS = 256;

export function zeroCounters(): DecodeCounters {
  const z = {} as DecodeCounters;
  for (const k of DECODE_COUNTERS) z[k] = 0;
  return z;
}

export interface LinkTelemetryOptions {
  source?: string;
  /** Truth oracle: the LED id a record REALLY came from (null = can't tell).
   * Attached by the simulator / a surveyed HITL fixture. */
  truth?: (rec: DetectionRecord) => number | null;
}

export class LinkTelemetry {
  private readonly source: string;
  private readonly truthFn: ((rec: DetectionRecord) => number | null) | null;
  private ledCount = 0;
  private readonly configs: LinkConfigEvent[] = [];
  private readonly exposures: LinkExposureSample[] = [];
  private readonly timeline: LinkTimelineSample[] = [];
  private readonly first = new Map<number, number>();
  private readonly firstOrder: [number, number][] = [];
  private records = 0;
  private retired = zeroCounters();
  private current: (() => DecodeStatsLike) | null = null;

  private frameCount = 0;
  private clipped = 0;
  private lastFrameMs: number | null = null;
  private readonly hist: number[] = new Array(HIST_BINS).fill(0);
  private maxInterval: number | null = null;
  /** Running nominal interval (EMA of non-gap intervals). */
  private nominalMs: number | null = null;
  private readonly gaps: LinkFrameGap[] = [];
  private gapCount = 0;
  private gapLost = 0;
  private lastSampleMs = -Infinity;
  private lastTMs = 0;

  private truthChecked = 0;
  private truthWrong = 0;
  private readonly wrongIds = new Set<number>();

  /** `t0Ms`: the capture-start instant (same clock as every later tMs). */
  constructor(
    private readonly t0Ms: number,
    opts: LinkTelemetryOptions = {},
  ) {
    this.source = opts.source ?? "capture";
    this.truthFn = opts.truth ?? null;
  }

  private rel(tMs: number): number {
    return tMs - this.t0Ms;
  }

  /** A newly negotiated code configuration (start or §7.1 configure). */
  config(tMs: number, p: CodeParams, reason: LinkConfigEvent["reason"], frameIntervalMs: number | null = null): void {
    this.ledCount = Math.max(this.ledCount, p.ledCount);
    const interval = frameIntervalMs ?? this.nominalMs;
    if (this.configs.length >= MAX_CONFIG) return;
    this.configs.push({
      tMs: this.rel(tMs),
      reason,
      symbols: p.symbols,
      bitPeriodMs: p.bitPeriodMs,
      cycleFrames: p.cycleFrames,
      ledCount: p.ledCount,
      brightness: p.brightness ?? null,
      framesPerBit: interval !== null && interval > 0 ? p.bitPeriodMs / interval : null,
    });
  }

  /** The decode pipeline's live stats (the object, or a getter for it).
   * Call again whenever the pipeline is rebuilt: the previous pipeline's
   * final counters are folded in. */
  attachDecoder(stats: DecodeStatsLike | (() => DecodeStatsLike)): void {
    if (this.current !== null) {
      const prev = this.current();
      for (const k of DECODE_COUNTERS) this.retired[k] += prev[k] ?? 0;
    }
    this.current = typeof stats === "function" ? stats : () => stats;
  }

  /** Cumulative decoder counters over every pipeline this run. */
  decodeCounters(): DecodeCounters {
    const out = { ...this.retired };
    if (this.current !== null) {
      const cur = this.current();
      for (const k of DECODE_COUNTERS) out[k] += cur[k] ?? 0;
    }
    return out;
  }

  /** One camera frame arrived (`clipped`: the source truncated it). Also
   * takes the ~1 s timeline sample. */
  frame(tMs: number, clipped = false): void {
    this.frameCount++;
    if (clipped) this.clipped++;
    this.lastTMs = Math.max(this.lastTMs, this.rel(tMs));
    if (this.lastFrameMs !== null) {
      const dt = tMs - this.lastFrameMs;
      if (dt >= 0) {
        this.hist[Math.min(HIST_BINS - 1, Math.floor(dt / HIST_BIN_MS))]!++;
        this.maxInterval = this.maxInterval === null ? dt : Math.max(this.maxInterval, dt);
        const nominal = this.nominalMs;
        if (nominal !== null && dt >= DROPOUT_FRAMES * nominal) {
          this.gapCount++;
          this.gapLost += dt - nominal;
          if (this.gaps.length < MAX_GAPS) this.gaps.push({ tMs: this.rel(this.lastFrameMs), gapMs: dt });
        } else {
          this.nominalMs = nominal === null ? dt : nominal + 0.1 * (dt - nominal);
        }
      }
    }
    this.lastFrameMs = tMs;
    if (tMs - this.lastSampleMs >= TIMELINE_PERIOD_MS) {
      this.lastSampleMs = tMs;
      this.sample(tMs);
    }
  }

  /** Records the decode stage emitted (whatever went to the solver). */
  recordsEmitted(recs: readonly DetectionRecord[], tMs?: number): void {
    for (const r of recs) {
      this.records++;
      const t = this.rel(tMs ?? r.tCaptureMs);
      if (!this.first.has(r.ledId)) {
        this.first.set(r.ledId, t);
        this.firstOrder.push([r.ledId, t]);
      }
      if (this.truthFn !== null) {
        const truth = this.truthFn(r);
        if (truth !== null) {
          this.truthChecked++;
          if (truth !== r.ledId) {
            this.truthWrong++;
            if (this.wrongIds.size < MAX_WRONG_IDS) this.wrongIds.add(r.ledId);
          }
        }
      }
    }
  }

  /** One exposure-tick sample (the capture page's ~2 s servo cadence). */
  exposure(tMs: number, s: Omit<LinkExposureSample, "tMs">): void {
    if (this.exposures.length >= MAX_EXPOSURE) return;
    this.exposures.push({ tMs: this.rel(tMs), ...s });
  }

  private activeConfig(): LinkConfigEvent | null {
    return this.configs[this.configs.length - 1] ?? null;
  }

  private sample(tMs: number): void {
    if (this.timeline.length >= MAX_TIMELINE) return;
    const cfg = this.activeConfig();
    this.timeline.push({
      tMs: this.rel(tMs),
      frames: this.frameCount,
      ids: this.first.size,
      records: this.records,
      symbols: cfg?.symbols ?? 0,
      bitPeriodMs: cfg?.bitPeriodMs ?? 0,
      marginEma: this.current?.().marginEma ?? null,
      decode: this.decodeCounters(),
      wrong: this.truthFn !== null ? this.truthWrong : null,
    });
  }

  private quantile(q: number): number | null {
    let total = 0;
    for (const c of this.hist) total += c;
    if (total === 0) return null;
    const rank = Math.max(1, Math.ceil(q * total));
    let acc = 0;
    for (let i = 0; i < this.hist.length; i++) {
      acc += this.hist[i]!;
      if (acc >= rank) return (i + 0.5) * HIST_BIN_MS;
    }
    return null;
  }

  /** The bundle payload. `tEndMs` closes the timeline with a final sample. */
  snapshot(tEndMs?: number): LinkTelemetrySnapshot {
    if (tEndMs !== undefined) {
      this.lastTMs = Math.max(this.lastTMs, this.rel(tEndMs));
      const last = this.timeline[this.timeline.length - 1];
      if (last === undefined || last.tMs < this.rel(tEndMs)) this.sample(tEndMs);
    }
    const decode = this.decodeCounters();
    return {
      version: LINK_TELEMETRY_VERSION,
      source: this.source,
      ledCount: this.ledCount,
      durationMs: this.lastTMs,
      config: [...this.configs],
      exposure: [...this.exposures],
      frames: {
        count: this.frameCount,
        clipped: this.clipped,
        hist: { binMs: HIST_BIN_MS, counts: [...this.hist] },
        p50Ms: this.quantile(0.5),
        p90Ms: this.quantile(0.9),
        p99Ms: this.quantile(0.99),
        maxMs: this.maxInterval,
        gaps: [...this.gaps],
        gapCount: this.gapCount,
        gapLostMs: this.gapLost,
      },
      timeline: [...this.timeline],
      firstSeen: [...this.firstOrder],
      decode,
      ids: {
        idFlips: decode.idFlips,
        rangeRejects: decode.rejectedRange,
        fecCorrected: decode.correctedCycles,
        fecRejected: decode.rejectedFec,
        truth:
          this.truthFn !== null
            ? {
                checked: this.truthChecked,
                correct: this.truthChecked - this.truthWrong,
                wrong: this.truthWrong,
                wrongIds: [...this.wrongIds].sort((a, b) => a - b),
              }
            : null,
      },
    };
  }
}
