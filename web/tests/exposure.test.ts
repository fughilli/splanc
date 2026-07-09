/**
 * Exposure monitoring + capture auto-negotiation (cv/exposure.ts): the
 * varying-light logic — scene stats → encoding, camera cadence → signaling
 * rate, blob count → detector-threshold servo, and the mid-capture
 * renegotiation/hysteresis rules.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { sceneStatsFromLuma } from "../src/cv/detect";
import {
  adjustThreshold,
  BIT_PERIOD_MAX_MS,
  BIT_PERIOD_MIN_MS,
  DARK_SCENE_MEAN_LUMA,
  ENCODING_SWITCH_DARK,
  ENCODING_SWITCH_LIT,
  ExposureMonitor,
  planEncodingSwitch,
  planReconfigure,
  recommendConfig,
  THRESHOLD_BASE,
  THRESHOLD_MAX,
} from "../src/cv/exposure";

// -- recommendConfig: the pre-capture negotiation ---------------------------

test("dark scene -> gray encoding (the dark-room failure mode of gray-hue)", () => {
  const cfg = recommendConfig({ frameIntervalMs: 33.3, meanLuma: 0.03 });
  assert.equal(cfg.encoding, "gray");
});

test("lit scene -> gray-hue encoding", () => {
  const cfg = recommendConfig({ frameIntervalMs: 33.3, meanLuma: 0.3 });
  assert.equal(cfg.encoding, "gray-hue");
});

test("30 fps camera -> 100 ms bits (the design-doc default operating point)", () => {
  const cfg = recommendConfig({ frameIntervalMs: 33.3, meanLuma: 0.3 });
  assert.equal(cfg.bitPeriodMs, 100);
});

test("15 fps camera (low light doubles exposure) -> 200 ms bits", () => {
  const cfg = recommendConfig({ frameIntervalMs: 66.7, meanLuma: 0.03 });
  assert.equal(cfg.bitPeriodMs, 210); // ceil(3 * 66.7 / 10) * 10
});

test("bit period clamps to sane bounds", () => {
  assert.equal(recommendConfig({ frameIntervalMs: 5, meanLuma: 0.3 }).bitPeriodMs, BIT_PERIOD_MIN_MS);
  assert.equal(
    recommendConfig({ frameIntervalMs: 500, meanLuma: 0.3 }).bitPeriodMs,
    BIT_PERIOD_MAX_MS,
  );
});

// -- planReconfigure: mid-capture rate renegotiation -------------------------

test("fps drop below the decodable band triggers a slower code", () => {
  // 100 ms bits at 15 fps = 1.5 frames/bit — starved windows.
  const next = planReconfigure(100, 66.7);
  assert.equal(next, 210);
});

test("fps within band keeps the current rate (hysteresis)", () => {
  // 100 ms bits at 30 fps = 3 frames/bit: fine, no change.
  assert.equal(planReconfigure(100, 33.3), null);
  // 2.7 frames/bit: below ideal but above the renegotiation floor.
  assert.equal(planReconfigure(90, 33.3), null);
});

test("a much faster camera reclaims cycle time only past 2x", () => {
  // 400 ms bits at 30 fps = 12 frames/bit -> ideal is 100 ms; 400 >= 2*100.
  assert.equal(planReconfigure(400, 33.3), 100);
  // 180 ms at 30 fps: ideal 100, but 180 < 200 — not worth the re-anchor.
  assert.equal(planReconfigure(180, 33.3), null);
});

// -- planEncodingSwitch: hysteresis on the carrier ---------------------------

test("encoding switches only outside the hysteresis band", () => {
  const mid = (ENCODING_SWITCH_DARK + ENCODING_SWITCH_LIT) / 2;
  assert.equal(planEncodingSwitch("gray-hue", ENCODING_SWITCH_DARK - 0.01), "gray");
  assert.equal(planEncodingSwitch("gray-hue", mid), null);
  assert.equal(planEncodingSwitch("gray", ENCODING_SWITCH_LIT + 0.01), "gray-hue");
  assert.equal(planEncodingSwitch("gray", mid), null);
  // The band brackets the cold-start threshold, so a scene right at the
  // recommendConfig boundary can't flap after the first choice.
  assert.ok(ENCODING_SWITCH_DARK < DARK_SCENE_MEAN_LUMA);
  assert.ok(ENCODING_SWITCH_LIT > DARK_SCENE_MEAN_LUMA);
});

// -- adjustThreshold: the blob-count servo -----------------------------------

test("detector flood raises the threshold, bounded", () => {
  // The 2026-07-05 bright-room trace: ~210 blobs/frame at threshold 0.6.
  let th = THRESHOLD_BASE;
  th = adjustThreshold(th, 210, 32);
  assert.ok(th > THRESHOLD_BASE);
  for (let i = 0; i < 20; i++) th = adjustThreshold(th, 500, 32);
  assert.equal(th, THRESHOLD_MAX);
});

test("starved detector walks back toward base, never below", () => {
  let th = 0.8;
  th = adjustThreshold(th, 3, 32);
  assert.ok(th < 0.8);
  for (let i = 0; i < 20; i++) th = adjustThreshold(th, 3, 32);
  assert.equal(th, THRESHOLD_BASE);
});

test("healthy blob count holds the operating point", () => {
  assert.equal(adjustThreshold(0.7, 40, 32), 0.7);
});

// -- ExposureMonitor ----------------------------------------------------------

function feed(mon: ExposureMonitor, opts: { frames: number; intervalMs: number; blobs?: number; luma?: number }): number {
  let t = 1000;
  for (let i = 0; i < opts.frames; i++) {
    t += opts.intervalMs;
    mon.push({
      tMs: t,
      blobCount: opts.blobs ?? 30,
      scene:
        i % 6 === 0
          ? { meanLuma: opts.luma ?? 0.2, p95Luma: (opts.luma ?? 0.2) * 2, clipFrac: 0.001 }
          : undefined,
    });
  }
  return t;
}

test("monitor measures cadence and scene medians from a sparse measure pass", () => {
  const mon = new ExposureMonitor();
  const tEnd = feed(mon, { frames: 40, intervalMs: 33.3, blobs: 31, luma: 0.05 });
  const snap = mon.snapshot();
  assert.ok(snap !== null);
  assert.ok(Math.abs(snap.frameIntervalMs - 33.3) < 0.5);
  assert.equal(snap.blobCount, 31);
  assert.ok(Math.abs(snap.scene.meanLuma - 0.05) < 1e-9);

  const report = mon.report(tEnd, 0.6, 0.7);
  assert.ok(report !== null);
  assert.equal(report.detectorThreshold, 0.6);
  assert.equal(report.ambientIntensity, 0.7);
  assert.equal(report.iso, null); // web client cannot read the real 3A
  assert.equal(report.exposureTimeMs, null);
});

test("monitor is null until it has cadence AND at least one scene measure", () => {
  const mon = new ExposureMonitor();
  assert.equal(mon.snapshot(), null);
  mon.push({ tMs: 1, blobCount: 5 });
  mon.push({ tMs: 34, blobCount: 5 });
  mon.push({ tMs: 67, blobCount: 5 });
  mon.push({ tMs: 100, blobCount: 5 });
  mon.push({ tMs: 133, blobCount: 5 });
  assert.equal(mon.snapshot(), null); // frames, but no scene stats yet
  mon.push({ tMs: 166, blobCount: 5, scene: { meanLuma: 0.1, p95Luma: 0.2, clipFrac: 0 } });
  assert.ok(mon.snapshot() !== null);
});

test("monitor window slides: an fps drop is visible within the window", () => {
  const mon = new ExposureMonitor(2000);
  feed(mon, { frames: 60, intervalMs: 33.3 });
  // Light drops: camera runs at 15 fps from here on.
  let t = 1000 + 60 * 33.3;
  for (let i = 0; i < 40; i++) {
    t += 66.7;
    mon.push({ tMs: t, blobCount: 30, scene: { meanLuma: 0.02, p95Luma: 0.05, clipFrac: 0 } });
  }
  const snap = mon.snapshot()!;
  assert.ok(snap.frameIntervalMs > 60, `expected slow cadence, got ${snap.frameIntervalMs}`);
});

test("median cadence shrugs off a single stalled frame", () => {
  const mon = new ExposureMonitor();
  feed(mon, { frames: 30, intervalMs: 33.3 });
  mon.push({ tMs: 1000 + 30 * 33.3 + 400, blobCount: 30 }); // one GC stall
  const snap = mon.snapshot()!;
  assert.ok(snap.frameIntervalMs < 40);
});

// -- sceneStatsFromLuma: the measure-pass math --------------------------------

test("scene stats: mean, p95 and clip fraction from the alpha channel", () => {
  const pixels = 1000;
  const rgba = new Uint8Array(pixels * 4);
  // 900 dark pixels (20), 80 mid (128), 20 clipped (255).
  for (let i = 0; i < pixels; i++) rgba[i * 4 + 3] = i < 900 ? 20 : i < 980 ? 128 : 255;
  const s = sceneStatsFromLuma(rgba, pixels);
  assert.ok(Math.abs(s.meanLuma - (900 * 20 + 80 * 128 + 20 * 255) / 1000 / 255) < 1e-9);
  assert.equal(s.p95Luma, 128 / 255);
  assert.equal(s.clipFrac, 0.02);
});
