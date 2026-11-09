/**
 * Mapping-link throughput report (#448): turn one run's LinkTelemetry
 * (cv/linkTelemetry.ts — from a capture bundle or the moving-camera
 * simulator) into the comparison metrics — time to a decode coverage,
 * decoded-ID error rate, dropouts, the negotiated configuration — and
 * compare a candidate against a baseline with a correctness-first verdict:
 * a change that gets faster by decoding more WRONG ids is never "better".
 *
 * Used by `bazel run //web:link_bench` (tests/tools/linkBench.ts). Pure.
 */

import type { LinkTelemetrySnapshot } from "./linkTelemetry";
import { MIN_FRAMES_PER_BIT } from "./exposure";

export const DEFAULT_COVERAGE_TARGETS = [0.5, 0.8, 0.9, 0.95] as const;
/** Records-per-frame stalls at least this long count as decode dropouts. */
export const DECODE_DROPOUT_MS = 2000;

export interface LinkReport {
  name: string;
  source: string;
  ledCount: number;
  /** Coverage denominator (ledCount, or the ids known visible). */
  coverageOf: number;
  durationMs: number;
  finalIds: number;
  finalCoverage: number;
  /** ms from start to each coverage fraction (null = never reached). */
  timeToCoverage: { frac: number; tMs: number | null }[];
  records: number;
  /** Exact, from a truth oracle (null on uninstrumented real captures). */
  truth: { checked: number; wrong: number; wrongRate: number; wrongIds: number } | null;
  /** Ground-truth-free error signals, per 1000 accepted (track, cycle)
   * decodes. */
  idFlipsPerKDecodes: number;
  rangeRejectsPerKDecodes: number;
  fecCorrectedPerKDecodes: number;
  cycles: number;
  frames: { count: number; p50Ms: number | null; p90Ms: number | null; gapCount: number; gapLostMs: number };
  /** Spans ≥ DECODE_DROPOUT_MS where frames arrived but no record decoded. */
  decodeDropouts: { count: number; longestMs: number; totalMs: number };
  /** Share of the run spent in each alphabet, e.g. { "2": 0.3, "4": 0.7 }. */
  symbolShare: Record<string, number>;
  configChanges: number;
  bitPeriodsMs: number[];
  /** Lowest camera frames per bit window any configuration implied
   * (web/README timing constraint: ≥ 3). */
  minFramesPerBit: number | null;
  exposure: { min: number | null; median: number | null; max: number | null };
}

export function linkReport(
  t: LinkTelemetrySnapshot,
  opts: { name?: string; coverageOf?: number; targets?: readonly number[] } = {},
): LinkReport {
  const coverageOf = Math.max(1, opts.coverageOf ?? t.ledCount);
  const targets = opts.targets ?? DEFAULT_COVERAGE_TARGETS;
  const firstTimes = t.firstSeen.map(([, ms]) => ms).sort((a, b) => a - b);
  const timeToCoverage = targets.map((frac) => {
    const need = Math.ceil(frac * coverageOf);
    return { frac, tMs: need >= 1 && need <= firstTimes.length ? firstTimes[need - 1]! : null };
  });
  const cycles = t.decode.cyclesCompleted;
  // Per accepted decode (+ the ones FEC/range rejected, which were decodes too).
  const decodes = t.decode.recordsEmitted + t.decode.rejectedDuplicate + t.decode.rejectedRange + t.decode.rejectedFec;
  const perK = (n: number): number => (decodes > 0 ? (1000 * n) / decodes : 0);
  const truth = t.ids.truth;

  // Decode dropouts: consecutive timeline samples with frames but no new records.
  let dropCount = 0;
  let longest = 0;
  let total = 0;
  let runStart: number | null = null;
  const tl = t.timeline;
  const closeRun = (endMs: number): void => {
    if (runStart === null) return;
    const len = endMs - runStart;
    if (len >= DECODE_DROPOUT_MS) {
      dropCount++;
      total += len;
      longest = Math.max(longest, len);
    }
    runStart = null;
  };
  // Only count stalls after the first decode (the warm-up is time-to-coverage's job).
  const firstDecodeMs = firstTimes[0] ?? Infinity;
  for (let i = 1; i < tl.length; i++) {
    const a = tl[i - 1]!;
    const b = tl[i]!;
    const stalled = b.frames > a.frames && b.records === a.records && a.tMs >= firstDecodeMs;
    if (stalled) {
      if (runStart === null) runStart = a.tMs;
    } else {
      closeRun(a.tMs);
    }
  }
  if (tl.length > 0) closeRun(tl[tl.length - 1]!.tMs);

  // Time share per alphabet from the config events.
  const share: Record<string, number> = {};
  const dur = Math.max(1, t.durationMs);
  for (let i = 0; i < t.config.length; i++) {
    const c = t.config[i]!;
    const end = t.config[i + 1]?.tMs ?? t.durationMs;
    const len = Math.max(0, end - Math.max(0, c.tMs));
    share[String(c.symbols)] = (share[String(c.symbols)] ?? 0) + len / dur;
  }
  const fpb = t.config.map((c) => c.framesPerBit).filter((x): x is number => x !== null);
  const exps = t.exposure.map((e) => e.exposure).filter((x): x is number => x !== null).sort((a, b) => a - b);

  return {
    name: opts.name ?? t.source,
    source: t.source,
    ledCount: t.ledCount,
    coverageOf,
    durationMs: t.durationMs,
    finalIds: t.firstSeen.length,
    finalCoverage: t.firstSeen.length / coverageOf,
    timeToCoverage,
    records: tl[tl.length - 1]?.records ?? 0,
    truth:
      truth === null
        ? null
        : {
            checked: truth.checked,
            wrong: truth.wrong,
            wrongRate: truth.checked > 0 ? truth.wrong / truth.checked : 0,
            wrongIds: truth.wrongIds.length,
          },
    idFlipsPerKDecodes: perK(t.ids.idFlips),
    rangeRejectsPerKDecodes: perK(t.ids.rangeRejects),
    fecCorrectedPerKDecodes: perK(t.ids.fecCorrected),
    cycles,
    frames: {
      count: t.frames.count,
      p50Ms: t.frames.p50Ms,
      p90Ms: t.frames.p90Ms,
      gapCount: t.frames.gapCount,
      gapLostMs: t.frames.gapLostMs,
    },
    decodeDropouts: { count: dropCount, longestMs: longest, totalMs: total },
    symbolShare: share,
    configChanges: Math.max(0, t.config.length - 1),
    bitPeriodsMs: [...new Set(t.config.map((c) => c.bitPeriodMs))],
    minFramesPerBit: fpb.length > 0 ? Math.min(...fpb) : null,
    exposure: {
      min: exps[0] ?? null,
      median: exps.length > 0 ? exps[exps.length >> 1]! : null,
      max: exps[exps.length - 1] ?? null,
    },
  };
}

export type Verdict = "better" | "same" | "worse" | "unsafe";

export interface Comparison {
  verdict: Verdict;
  reasons: string[];
}

/** Wrong-ID rate increase (absolute) that counts as a correctness regression. */
export const WRONG_RATE_TOLERANCE = 0.001;
/** frames/bit is computed from a MEASURED frame interval, so a negotiation
 * that targeted exactly MIN_FRAMES_PER_BIT reads a hair under it on jitter. */
export const FRAME_JITTER_TOLERANCE = 0.03;
/** Relative time-to-coverage change that counts as a real speed difference. */
export const SPEED_TOLERANCE = 0.05;

/**
 * Correctness-first comparison of a candidate run against a baseline run of
 * the SAME scenario. `unsafe` (any correctness regression, or a config that
 * violates the frames-per-bit constraint) dominates any speed win.
 */
export function compareReports(base: LinkReport, cand: LinkReport, targetFrac = 0.9): Comparison {
  const reasons: string[] = [];
  let unsafe = false;
  if (base.truth !== null && cand.truth !== null) {
    if (cand.truth.wrongRate > base.truth.wrongRate + WRONG_RATE_TOLERANCE) {
      unsafe = true;
      reasons.push(
        `wrong-id rate ${pct(base.truth.wrongRate)} → ${pct(cand.truth.wrongRate)} (correctness regression)`,
      );
    }
  }
  // Ground-truth-free guard: id flips per cycle rising sharply.
  if (cand.idFlipsPerKDecodes > Math.max(2, 1.5 * base.idFlipsPerKDecodes)) {
    unsafe = true;
    reasons.push(`id flips/kdecode ${base.idFlipsPerKDecodes.toFixed(1)} → ${cand.idFlipsPerKDecodes.toFixed(1)}`);
  }
  if (cand.minFramesPerBit !== null && cand.minFramesPerBit < MIN_FRAMES_PER_BIT * (1 - FRAME_JITTER_TOLERANCE)) {
    unsafe = true;
    reasons.push(`frames/bit ${cand.minFramesPerBit.toFixed(2)} < ${MIN_FRAMES_PER_BIT} (camera-frame timing constraint)`);
  }
  if (cand.finalCoverage + 1e-9 < base.finalCoverage - 0.02) {
    reasons.push(`final coverage ${pct(base.finalCoverage)} → ${pct(cand.finalCoverage)}`);
  }
  const bt = base.timeToCoverage.find((x) => Math.abs(x.frac - targetFrac) < 1e-9)?.tMs ?? null;
  const ct = cand.timeToCoverage.find((x) => Math.abs(x.frac - targetFrac) < 1e-9)?.tMs ?? null;
  let speed: Verdict = "same";
  if (bt === null && ct !== null) speed = "better";
  else if (bt !== null && ct === null) speed = "worse";
  else if (bt !== null && ct !== null) {
    if (ct < bt * (1 - SPEED_TOLERANCE)) speed = "better";
    else if (ct > bt * (1 + SPEED_TOLERANCE)) speed = "worse";
  }
  reasons.push(`t${Math.round(targetFrac * 100)} ${fmtMs(bt)} → ${fmtMs(ct)}`);
  if (unsafe) return { verdict: "unsafe", reasons };
  if (cand.finalCoverage + 1e-9 < base.finalCoverage - 0.02 && speed !== "better") return { verdict: "worse", reasons };
  return { verdict: speed, reasons };
}

function pct(x: number): string {
  return `${(100 * x).toFixed(2)}%`;
}

function fmtMs(ms: number | null): string {
  return ms === null ? "never" : `${(ms / 1000).toFixed(1)}s`;
}

/** One human-readable block per report. */
export function formatReport(r: LinkReport): string {
  const ttc = r.timeToCoverage.map((x) => `t${Math.round(x.frac * 100)}=${fmtMs(x.tMs)}`).join(" ");
  const sym = Object.entries(r.symbolShare)
    .map(([k, v]) => `${k}sym ${Math.round(v * 100)}%`)
    .join(", ");
  const truth =
    r.truth === null
      ? "ids: no truth oracle"
      : `ids: ${r.truth.wrong}/${r.truth.checked} records wrong (${pct(r.truth.wrongRate)}), ${r.truth.wrongIds} distinct wrong ids`;
  return [
    `${r.name} [${r.source}] ${r.finalIds}/${r.coverageOf} ids (${pct(r.finalCoverage)}) in ${fmtMs(r.durationMs)}`,
    `  coverage: ${ttc}`,
    `  ${truth}; flips ${r.idFlipsPerKDecodes.toFixed(1)}/kdec, range-rejects ${r.rangeRejectsPerKDecodes.toFixed(1)}/kdec, fec-fixed ${r.fecCorrectedPerKDecodes.toFixed(1)}/kdec`,
    `  link: ${sym || "-"}; bit ${r.bitPeriodsMs.join("/")} ms; ${r.configChanges} reconfigures; min frames/bit ${r.minFramesPerBit?.toFixed(2) ?? "?"}` +
      `; exposure ${r.exposure.median === null ? "auto" : `${r.exposure.min!.toFixed(2)}..${r.exposure.max!.toFixed(2)} (med ${r.exposure.median.toFixed(2)})`}`,
    `  frames: ${r.frames.count} (p50 ${r.frames.p50Ms ?? "?"} ms, p90 ${r.frames.p90Ms ?? "?"} ms), ${r.frames.gapCount} frame dropouts (${fmtMs(r.frames.gapLostMs)} lost); ` +
      `${r.decodeDropouts.count} decode stalls ≥${DECODE_DROPOUT_MS / 1000}s (longest ${fmtMs(r.decodeDropouts.longestMs)})`,
  ].join("\n");
}
