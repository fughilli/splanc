/**
 * Mapping-link telemetry (#448): the recorder (cv/linkTelemetry.ts), the
 * throughput report + correctness-first comparison (cv/linkReport.ts), the
 * capture-bundle v2 field and its v1 compatibility (solver/captureBundle.ts),
 * and the moving-camera simulator behind `//web:link_bench` (linkSim.ts).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { DetectionRecord } from "@ledmapper/protocol";
import type { DecodeStats } from "../src/cv/decoder";
import { compareReports, linkReport, type LinkReport } from "../src/cv/linkReport";
import { LinkTelemetry, type LinkTelemetrySnapshot } from "../src/cv/linkTelemetry";
import {
  BUNDLE_FORMAT,
  BUNDLE_VERSION,
  buildBundle,
  bundleLink,
  InterimLog,
  isCaptureBundle,
  type CaptureParamsSnapshot,
} from "../src/solver/captureBundle";
import { decideFinal } from "../src/solver/degeneracy";
import { BASELINE_POLICY, codeParams, runLinkSim, standardScenarios } from "./linkSim";

function stats(over: Partial<DecodeStats> = {}): DecodeStats {
  return {
    cyclesCompleted: 0,
    recordsEmitted: 0,
    uniqueIds: new Set<number>(),
    alignShiftMs: 0,
    rejectedSync: 0,
    rejectedGaps: 0,
    rejectedRange: 0,
    rejectedFec: 0,
    correctedCycles: 0,
    rejectedLowConf: 0,
    rejectedSupport: 0,
    rejectedPoseGap: 0,
    rejectedDuplicate: 0,
    rejectedUnconfirmed: 0,
    idFlips: 0,
    marginEma: null,
    ...over,
  };
}

function rec(ledId: number, tCaptureMs: number, u = 0): DetectionRecord {
  return { ledId, tCaptureMs, u, v: 0, imgW: 1, imgH: 1, K: [1, 1, 0, 0], pose: null, confidence: 1 };
}

test("telemetry records config, frame timing + dropouts, coverage and folds decoder stats across pipelines", () => {
  const t0 = 1000;
  const tel = new LinkTelemetry(t0);
  tel.config(t0, codeParams(60, 4, 100), "start", 33.3);
  const s1 = stats({ cyclesCompleted: 5, idFlips: 1, rejectedRange: 2 });
  tel.attachDecoder(s1);
  // 30 fps frames, with one 200 ms hole (a dropout ≥ 3 nominal intervals).
  let t = t0;
  for (let i = 0; i < 40; i++) {
    t += i === 20 ? 200 : 33.3;
    tel.frame(t);
  }
  tel.recordsEmitted([rec(3, t0 + 500), rec(4, t0 + 600), rec(3, t0 + 700)]);
  // Renegotiation: a fresh pipeline (fresh stats) — the old counters persist.
  tel.config(t, codeParams(60, 2, 120), "reconfigure", 33.3);
  const s2 = stats({ cyclesCompleted: 2, correctedCycles: 1 });
  tel.attachDecoder(s2);
  s2.cyclesCompleted = 3; // live object keeps counting
  tel.exposure(t, {
    exposure: 0.4,
    brightness: 0.8,
    threshold: 0.6,
    frameIntervalMs: 33.3,
    meanLuma: 0.2,
    clipFrac: 0,
    blobCount: 50,
    marginEma: 0.8,
  });
  const snap = tel.snapshot(t + 10);

  assert.equal(snap.version, 1);
  assert.equal(snap.ledCount, 60);
  assert.deepEqual(
    snap.config.map((c) => [c.reason, c.symbols, c.bitPeriodMs, c.cycleFrames]),
    [
      ["start", 4, 100, codeParams(60, 4, 100).cycleFrames],
      ["reconfigure", 2, 120, codeParams(60, 2, 120).cycleFrames],
    ],
  );
  assert.ok(Math.abs(snap.config[0]!.framesPerBit! - 100 / 33.3) < 1e-9);
  assert.equal(snap.frames.count, 40);
  assert.equal(snap.frames.gapCount, 1);
  assert.equal(snap.frames.gaps[0]!.gapMs, 200);
  assert.ok(snap.frames.p50Ms! > 30 && snap.frames.p50Ms! < 36, `p50 ${snap.frames.p50Ms}`);
  assert.deepEqual(snap.firstSeen, [
    [3, 500],
    [4, 600],
  ]);
  assert.equal(snap.decode.cyclesCompleted, 8);
  assert.equal(snap.ids.idFlips, 1);
  assert.equal(snap.ids.rangeRejects, 2);
  assert.equal(snap.ids.fecCorrected, 1);
  assert.equal(snap.ids.truth, null, "no oracle, no truth block");
  assert.equal(snap.exposure[0]!.exposure, 0.4);
  assert.ok(snap.timeline.length >= 2, "≥1 s of frames → timeline samples");
  assert.deepEqual(JSON.parse(JSON.stringify(snap)), snap, "bundle-serializable");
});

test("a truth oracle counts correct and incorrect decoded ids exactly", () => {
  const tel = new LinkTelemetry(0, { truth: (r) => (r.u === 99 ? 7 : r.ledId) });
  tel.recordsEmitted([rec(1, 10), rec(2, 20, 99), rec(2, 30, 99), rec(3, 40)]);
  const truth = tel.snapshot(50).ids.truth!;
  assert.deepEqual(truth, { checked: 4, correct: 2, wrong: 2, wrongIds: [2] });
});

function snapWith(firstSeen: [number, number][], over: Partial<LinkTelemetrySnapshot> = {}): LinkTelemetrySnapshot {
  const tel = new LinkTelemetry(0);
  tel.config(0, codeParams(10, 4, 100), "start", 33);
  const s = tel.snapshot(10_000);
  return { ...s, firstSeen, ...over };
}

test("report: time to coverage from first decodes, decode stalls from the timeline", () => {
  const r = linkReport(
    snapWith(
      Array.from({ length: 10 }, (_, i) => [i, (i + 1) * 1000] as [number, number]),
      {
        timeline: [
          { tMs: 0, frames: 0, records: 0 },
          { tMs: 1000, frames: 30, records: 5 },
          { tMs: 2000, frames: 60, records: 5 },
          { tMs: 3000, frames: 90, records: 5 },
          { tMs: 4000, frames: 120, records: 5 },
          { tMs: 5000, frames: 150, records: 9 },
        ].map((x) => ({ ...x, ids: 0, symbols: 4, bitPeriodMs: 100, marginEma: null, decode: snapWith([]).decode, wrong: null })),
      },
    ),
    { coverageOf: 10 },
  );
  assert.deepEqual(
    r.timeToCoverage.map((x) => [x.frac, x.tMs]),
    [
      [0.5, 5000],
      [0.8, 8000],
      [0.9, 9000],
      [0.95, 10000],
    ],
  );
  assert.equal(r.finalCoverage, 1);
  assert.deepEqual(r.decodeDropouts, { count: 1, longestMs: 3000, totalMs: 3000 });
  assert.deepEqual(r.symbolShare, { "4": 1 });
  assert.equal(linkReport(snapWith([[0, 100]]), { coverageOf: 10 }).timeToCoverage[0]!.tMs, null);
});

function report(over: Partial<LinkReport>): LinkReport {
  const base = linkReport(snapWith([[0, 1]]), { coverageOf: 1 });
  return {
    ...base,
    timeToCoverage: [{ frac: 0.9, tMs: 10_000 }],
    truth: { checked: 1000, wrong: 1, wrongRate: 0.001, wrongIds: 1 },
    minFramesPerBit: 3,
    ...over,
  };
}

test("comparison is correctness-first: a faster run with more wrong ids, or under 3 frames/bit, is unsafe", () => {
  const base = report({});
  assert.equal(compareReports(base, report({ timeToCoverage: [{ frac: 0.9, tMs: 7000 }] })).verdict, "better");
  assert.equal(compareReports(base, report({ timeToCoverage: [{ frac: 0.9, tMs: 13_000 }] })).verdict, "worse");
  assert.equal(compareReports(base, report({ timeToCoverage: [{ frac: 0.9, tMs: 10_200 }] })).verdict, "same");
  const fasterButWrong = report({
    timeToCoverage: [{ frac: 0.9, tMs: 5000 }],
    truth: { checked: 1000, wrong: 5, wrongRate: 0.005, wrongIds: 3 },
  });
  assert.equal(compareReports(base, fasterButWrong).verdict, "unsafe");
  const tooFast = report({ timeToCoverage: [{ frac: 0.9, tMs: 5000 }], minFramesPerBit: 2 });
  const cmp = compareReports(base, tooFast);
  assert.equal(cmp.verdict, "unsafe");
  assert.ok(cmp.reasons.some((r) => r.includes("frames/bit")), cmp.reasons.join("; "));
  // Ground-truth-free guard: track id flips jumping.
  assert.equal(compareReports(base, report({ truth: null, idFlipsPerKDecodes: 9 })).verdict, "unsafe");
});

test("capture bundle v2 carries the link telemetry; v1 bundles still read (no link)", () => {
  assert.equal(BUNDLE_VERSION, 2);
  const link = snapWith([[0, 5]]);
  const b = buildBundle({
    id: "b",
    createdAt: "2026-11-09T00:00:00.000Z",
    decision: decideFinal({ map: null, assessment: null, error: "x" }, null),
    app: { version: null, gitCommit: "c", gitDirty: false },
    solver: { version: null, wasmSha256: null },
    device: { userAgent: "t", platform: null, language: null, hardwareConcurrency: null, deviceMemoryGb: null, screen: null },
    capture: { ledCount: 10 } as CaptureParamsSnapshot,
    problem: null,
    interims: new InterimLog(),
    final: { map: null, diag: null, error: "x", assessment: null, timing: null },
    supplement: null,
    frames: [],
    link,
  });
  assert.equal(b.version, 2);
  assert.deepEqual(bundleLink(b), link);
  const round = JSON.parse(JSON.stringify(b)) as unknown;
  assert.ok(isCaptureBundle(round));
  // A v1 bundle (written before the field existed) still parses; no telemetry.
  const v1 = JSON.parse(JSON.stringify({ ...b, version: 1, link: undefined })) as unknown;
  assert.ok(isCaptureBundle(v1));
  assert.equal(bundleLink(v1 as never), null);
  assert.equal(isCaptureBundle({ ...b, version: 3 }), false, "future versions are refused, not misread");
  assert.equal(isCaptureBundle({ format: "other", version: 2 }), false);
  assert.equal(b.format, BUNDLE_FORMAT);
});

const scenario = (name: string) => {
  const s = standardScenarios(60).find((x) => x.name === name)!;
  return { ...s, durationMs: 8000, seed: 1 };
};

test("sim: held camera in a lit room decodes every visible LED with zero wrong ids (4 symbols negotiated)", () => {
  const res = runLinkSim(scenario("hold-lit"), BASELINE_POLICY);
  const r = linkReport(res.telemetry, { coverageOf: res.visibleIds });
  assert.ok(res.visibleIds > 10);
  assert.equal(r.finalCoverage, 1);
  assert.equal(r.truth!.wrong, 0);
  assert.deepEqual(r.symbolShare, { "4": 1 });
  assert.ok(r.minFramesPerBit! >= 3 - 1e-6, "baseline respects the frames/bit constraint");
  // Deterministic for a seed: the benchmark compares like with like.
  const again = linkReport(runLinkSim(scenario("hold-lit"), BASELINE_POLICY).telemetry, { coverageOf: res.visibleIds });
  assert.deepEqual(again, r);
});

test("sim: signalling faster than 3 frames/bit is flagged unsafe even when it looks faster", () => {
  const sc = scenario("hold-lit");
  const base = runLinkSim(sc, BASELINE_POLICY);
  const fast = runLinkSim(sc, { ...BASELINE_POLICY, name: "bit-60", bitPeriodMs: 60 });
  const cmp = compareReports(
    linkReport(base.telemetry, { coverageOf: base.visibleIds }),
    linkReport(fast.telemetry, { coverageOf: base.visibleIds }),
  );
  assert.equal(cmp.verdict, "unsafe", cmp.reasons.join("; "));
});

test("sim: the conservative 2-symbol fallback rescues a washed-out scene where forced 4 symbols fails", () => {
  const sc = { ...scenario("bright-veil"), durationMs: 30_000 };
  const base = runLinkSim(sc, BASELINE_POLICY);
  const forced4 = runLinkSim(sc, { ...BASELINE_POLICY, name: "sym4", symbols: 4 });
  const rb = linkReport(base.telemetry, { coverageOf: base.visibleIds });
  const r4 = linkReport(forced4.telemetry, { coverageOf: base.visibleIds });
  assert.ok(rb.finalCoverage >= 0.9, `baseline coverage ${rb.finalCoverage}`);
  assert.ok((rb.symbolShare["2"] ?? 0) > 0.5, "baseline fell back to 2 symbols");
  assert.ok(r4.finalCoverage < rb.finalCoverage - 0.5, `forced-4 coverage ${r4.finalCoverage}`);
});
