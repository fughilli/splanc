/**
 * Per-channel capture (capture/channelCapture.ts): a dense LED curtain on CH0
 * + a diffused, strided LED rope on CH1, mapped in one capture session.
 *
 *  - profile storage + back-compat (deviceStore.captureChannels);
 *  - the stage plan / code schedule per channel (what the device lights);
 *  - the per-channel gap fill never interpolates across the channel boundary;
 *  - an image-space simulation end to end: a 20x15 curtain + a 120-LED rope at
 *    stride 4 rendered through the REAL detector reduce + CvPipeline decode,
 *    triangulated from the known camera path, then gap-filled per channel.
 */

import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, String(v));
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
  clear(): void {
    this.m.clear();
  }
}
const mem = new MemStorage();
(globalThis as { localStorage?: unknown }).localStorage = mem;

import type { CodeParams, DetectionRecord, LedEntry, OutputMap, Pose, Vec3 } from "@ledmapper/protocol";
import { deviceStore, DEFAULT_CAPTURE_STRIDE, sanitizeChannelCapture } from "../src/store/deviceStore";
import {
  channelSpans,
  fillChannelGaps,
  planChannelCapture,
  shouldAdvanceStage,
  stageCoverage,
  stageLit,
  REGULAR_STAGE_MAX_MS,
  REGULAR_STAGE_MIN_MS,
  type CaptureStage,
  type ChannelCapturePlan,
} from "../src/capture/channelCapture";
import { phaseCount, strideLit } from "../src/code/stride";
import { expectedBits } from "../src/code/gray";
import { reducedToBlobs, type ReduceToBlobsOptions } from "../src/cv/detect";
import { CvPipeline } from "../src/cv/pipeline";
import { lookAtQuat, project } from "../src/geom/pinhole";
import { reduceToDetect, renderFrame } from "../src/sim/render";

beforeEach(() => mem.clear());

// --- profile storage ---------------------------------------------------------

test("a device without per-channel settings plans nothing (today's capture)", () => {
  const d = deviceStore.upsert("wss://curtain.local/ws", "Curtain");
  assert.equal(deviceStore.getChannelCaptures(d.id), undefined);
  assert.equal(planChannelCapture([300, 120], deviceStore.getChannelCaptures(d.id)), null);
  // The per-device stride is untouched by the new field.
  deviceStore.setCaptureStride(d.id, 5);
  assert.equal(deviceStore.getCaptureStride(d.id), 5);
  assert.equal(deviceStore.getChannelCaptures(d.id), undefined);
});

test("per-channel profiles persist, clamp, and clear back to the default", () => {
  const d = deviceStore.upsert("ble:SpookySplanc1", "SpookySplanc1");
  deviceStore.setChannelCapture(d.id, 1, { mode: "strided", stride: 99 });
  assert.deepEqual(deviceStore.getChannelCaptures(d.id), [null, { mode: "strided", stride: 16 }]);
  deviceStore.setChannelCapture(d.id, 0, { mode: "regular", stride: 1 });
  assert.deepEqual(deviceStore.getChannelCaptures(d.id), [
    { mode: "regular", stride: 1 },
    { mode: "strided", stride: 16 },
  ]);
  // Survives a raw read-back (normalize must keep the field).
  const raw = JSON.parse(mem.getItem("ledmapper.devices")!) as { captureChannels?: unknown }[];
  assert.equal(Array.isArray(raw[0]!.captureChannels), true);
  deviceStore.setChannelCapture(d.id, 1, undefined);
  deviceStore.setChannelCapture(d.id, 0, undefined);
  assert.equal(deviceStore.getChannelCaptures(d.id), undefined, "clearing the last one drops the field");
  // Out-of-range channels are ignored.
  deviceStore.setChannelCapture(d.id, -1, { mode: "regular", stride: 1 });
  deviceStore.setChannelCapture(d.id, 99, { mode: "regular", stride: 1 });
  assert.equal(deviceStore.getChannelCaptures(d.id), undefined);
});

test("malformed stored channel entries read as unset", () => {
  mem.setItem(
    "ledmapper.devices",
    JSON.stringify([
      {
        id: "x",
        wssUrl: "wss://x/ws",
        label: "x",
        bleMac: "",
        named: false,
        lastSeen: "",
        captureChannels: [{ mode: "bogus" }, { mode: "strided", stride: "3" }, 7],
      },
    ]),
  );
  assert.deepEqual(deviceStore.getChannelCaptures("x"), [null, { mode: "strided", stride: 3 }]);
  assert.equal(sanitizeChannelCapture({ mode: "strided" })?.stride, DEFAULT_CAPTURE_STRIDE);
  assert.equal(sanitizeChannelCapture(null), null);
});

test("settings made over LAN follow the fixture to its BLE record (MAC merge)", () => {
  const lan = deviceStore.upsert("wss://192.168.1.9/ws", "Spooky");
  deviceStore.applyWelcome(lan.id, { mac: "aa:bb" });
  deviceStore.setChannelCapture(lan.id, 1, { mode: "strided", stride: 4 });
  deviceStore.setCaptureStride(lan.id, 6);
  const ble = deviceStore.upsert("ble:SpookySplanc1", "SpookySplanc1");
  deviceStore.applyWelcome(ble.id, { mac: "aa:bb" });
  assert.deepEqual(deviceStore.getChannelCaptures(ble.id), [null, { mode: "strided", stride: 4 }]);
  assert.equal(deviceStore.getCaptureStride(ble.id), 6);
});

// --- plan / code schedule ----------------------------------------------------

const CURTAIN = 300; // 20 x 15
const ROPE = 120;
const HALLOWEEN = [
  { mode: "regular" as const, stride: 1 },
  { mode: "strided" as const, stride: 4 },
];

test("curtain regular + rope strided: a dense CH0 stage, then a strided whole-fixture stage", () => {
  const plan = planChannelCapture([CURTAIN, ROPE], HALLOWEEN)!;
  assert.equal(plan.total, CURTAIN + ROPE);
  assert.deepEqual(plan.spans, [
    { channel: 0, start: 0, count: CURTAIN },
    { channel: 1, start: CURTAIN, count: ROPE },
  ]);
  assert.deepEqual(plan.stages, [
    { kind: "regular", ledCount: CURTAIN, strideSpacing: 0, channels: [0] },
    { kind: "strided", ledCount: CURTAIN + ROPE, strideSpacing: 4, channels: [1] },
  ]);
});

test("plan edge cases", () => {
  assert.equal(planChannelCapture([CURTAIN, ROPE], [null, null]), null, "all unset = today");
  assert.equal(planChannelCapture([0, 0], HALLOWEEN), null, "no LEDs configured");
  assert.equal(planChannelCapture(null, HALLOWEEN), null);
  // All regular: one dense stage over everything.
  assert.deepEqual(planChannelCapture([10, 20], [{ mode: "regular", stride: 1 }])!.stages, [
    { kind: "regular", ledCount: 30, strideSpacing: 0, channels: [0, 1] },
  ]);
  // Strided first: the device can't code CH1 densely while CH0 stays dark, so
  // everything is strided (slower for CH1, never wrong).
  assert.deepEqual(
    planChannelCapture([ROPE, CURTAIN], [{ mode: "strided", stride: 3 }, { mode: "regular", stride: 1 }])!.stages,
    [{ kind: "strided", ledCount: ROPE + CURTAIN, strideSpacing: 3, channels: [0, 1] }],
  );
  // An empty CH0 is skipped; two strided channels take the larger stride.
  assert.deepEqual(
    planChannelCapture(
      [0, 50, 40],
      [null, { mode: "strided", stride: 3 }, { mode: "strided", stride: 5 }],
    )!.stages,
    [{ kind: "strided", ledCount: 90, strideSpacing: 5, channels: [1, 2] }],
  );
  assert.deepEqual(channelSpans([3, 0, 2]), [
    { channel: 0, start: 0, count: 3 },
    { channel: 1, start: 3, count: 0 },
    { channel: 2, start: 3, count: 2 },
  ]);
});

test("code schedule: stage 1 lights all of CH0 and none of CH1; stage 2 covers CH1 at >= stride spacing", () => {
  const plan = planChannelCapture([CURTAIN, ROPE], HALLOWEEN)!;
  const [s1, s2] = plan.stages as [CaptureStage, CaptureStage];
  const A = 3;
  for (let i = 0; i < plan.total; i++) assert.equal(stageLit(i, s1, 0, A), i < CURTAIN, `stage1 led ${i}`);
  const covered = new Set<number>();
  const stride = { spacing: s2.strideSpacing, anchorDensity: A };
  for (let ph = 0; ph < phaseCount(stride); ph++) {
    const lit: number[] = [];
    for (let i = 0; i < plan.total; i++) {
      // Mirror of the firmware mask: same answer as strideLit on the global index.
      assert.equal(stageLit(i, s2, ph, A), strideLit(i, ph, stride));
      if (stageLit(i, s2, ph, A)) lit.push(i);
    }
    const rope = lit.filter((i) => i >= CURTAIN);
    for (let k = 1; k < rope.length; k++) assert.ok(rope[k]! - rope[k - 1]! >= s2.strideSpacing);
    for (const i of rope) covered.add(i);
  }
  assert.equal(covered.size, ROPE, "the stride phases cover every rope LED");
});

test("stage hand-over: coverage after the minimum sweep, or the hard cap", () => {
  assert.equal(shouldAdvanceStage({ elapsedMs: 5_000, coverage: 1, isLast: false }), false);
  assert.equal(shouldAdvanceStage({ elapsedMs: REGULAR_STAGE_MIN_MS, coverage: 0.9, isLast: false }), true);
  assert.equal(shouldAdvanceStage({ elapsedMs: REGULAR_STAGE_MIN_MS, coverage: 0.5, isLast: false }), false);
  assert.equal(shouldAdvanceStage({ elapsedMs: REGULAR_STAGE_MAX_MS, coverage: 0, isLast: false }), true);
  assert.equal(shouldAdvanceStage({ elapsedMs: 1e9, coverage: 1, isLast: true }), false);
  const plan = planChannelCapture([4, 4], HALLOWEEN)!;
  assert.equal(stageCoverage(plan.stages[0]!, plan.spans, new Set([0, 1, 5, 6])), 0.5);
});

// --- per-channel gap fill ----------------------------------------------------

function led(id: number, xyz: Vec3, inferred = false): LedEntry {
  return inferred
    ? { id, xyz, confidence: 0, nViews: 0, rmsReprojPx: 0, parallaxDeg: 0 }
    : { id, xyz, confidence: 0.9, nViews: 5, rmsReprojPx: 0.5, parallaxDeg: 10 };
}
function mapOf(ledCount: number, leds: LedEntry[]): OutputMap {
  const ids = new Set(leds.map((l) => l.id));
  const unmapped: number[] = [];
  for (let i = 0; i < ledCount; i++) if (!ids.has(i)) unmapped.push(i);
  return {
    mapId: "m",
    createdAt: "",
    units: "meters",
    frame: "gravity_leveled",
    ledCount,
    leds,
    unmapped,
    stats: { rmsReprojPxGlobal: 0, medianParallaxDeg: 0 },
  };
}

test("gap fill stays inside each channel (clamps at a channel's ends, never bridges)", () => {
  // CH0 = [0,10) along x at y=0; CH1 = [10,30) along x at y=1 (far away).
  const spans = channelSpans([10, 20]);
  const leds: LedEntry[] = [];
  for (let i = 0; i < 10; i++) if (i !== 5) leds.push(led(i, [i, 0, 0]));
  for (let i = 12; i < 30; i += 4) leds.push(led(i, [i, 1, 0])); // rope: every 4th from 12
  // A strip-prior placement that bridged the boundary (between 9 and 12).
  leds.push(led(10, [10, 0.33, 0], true), led(11, [11, 0.66, 0], true));
  const out = fillChannelGaps(mapOf(30, leds), spans);
  const at = new Map(out.leds.map((l) => [l.id, l]));
  assert.equal(out.leds.length, 30);
  assert.deepEqual(out.unmapped, []);
  assert.deepEqual(at.get(5)!.xyz, [5, 0, 0], "CH0 interior gap: lerp 4..6");
  // CH1 head (10, 11) clamps to the first measured rope LED, NOT toward CH0.
  assert.deepEqual(at.get(10)!.xyz, [12, 1, 0]);
  assert.deepEqual(at.get(11)!.xyz, [12, 1, 0]);
  for (const id of [10, 11, 13, 14, 15, 29]) assert.equal(at.get(id)!.nViews, 0, `${id} is a placement`);
  assert.deepEqual(at.get(14)!.xyz, [14, 1, 0], "rope interior: by index between 12 and 16");
  assert.deepEqual(at.get(29)!.xyz, [28, 1, 0], "rope tail clamps to its last measured LED");
  for (let i = 10; i < 30; i++) assert.equal(at.get(i)!.xyz[1], 1, `rope LED ${i} never pulled toward CH0`);
  // Measured LEDs are untouched.
  assert.deepEqual(at.get(9), led(9, [9, 0, 0]));
});

test("a channel with nothing measured stays unmapped; LEDs outside the spans are left alone", () => {
  const leds = [led(0, [0, 0, 0]), led(2, [2, 0, 0]), led(7, [7, 0, 0], true)];
  const out = fillChannelGaps(mapOf(8, leds), channelSpans([3, 3]));
  assert.deepEqual(
    out.leds.map((l) => l.id),
    [0, 1, 2, 7],
  );
  assert.deepEqual(out.unmapped, [3, 4, 5, 6]);
});

// --- simulation: curtain 20x15 + rope 120 @ stride 4 -----------------------------

const IMG_W = 480;
const IMG_H = 270;
const FX = 420;
const K: [number, number, number, number] = [FX, FX, IMG_W / 2, IMG_H / 2];
const EPOCH = 10_000;
const OFFSET = 500;
const FPS_DT = 1000 / 30;
const R = 2.0;
const DET: ReduceToBlobsOptions = { minArea: 2, maxArea: 4000, maxBlobs: 2048, maxAspect: 3 };

/** Curtain: 20 columns x 15 rows, 6 cm pitch, serpentine by column, z = 0. */
function curtain(): Vec3[] {
  const out: Vec3[] = [];
  for (let c = 0; c < 20; c++) {
    for (let r = 0; r < 15; r++) {
      const row = c % 2 === 0 ? r : 14 - r;
      out.push([(c - 9.5) * 0.06, 0.45 - row * 0.06, 0]);
    }
  }
  return out;
}
/** Rope: 120 LEDs snaking low in front of the curtain (~1.6 cm pitch, z = 0.2). */
function rope(): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i < ROPE; i++) {
    const x = -0.55 + (1.1 * i) / (ROPE - 1);
    out.push([x, -0.55 + 0.12 * Math.sin(x * 12), 0.2]);
  }
  return out;
}
function arcPose(frac: number): Pose {
  const theta = (-25 + 50 * frac) * (Math.PI / 180);
  const eye: Vec3 = [R * Math.sin(theta), 0.1 + 0.3 * Math.sin(frac * Math.PI), R * Math.cos(theta)];
  return { p: eye, q: lookAtQuat(eye, [0, -0.1, 0]) };
}
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function qRotate(q: readonly number[], v: Vec3): Vec3 {
  const [x, y, z, w] = q as [number, number, number, number];
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}
/** Least-squares point closest to every record's camera ray (known poses). */
function triangulate(recs: DetectionRecord[]): Vec3 | null {
  const A = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const b = [0, 0, 0];
  for (const r of recs) {
    const [fx, fy, cx, cy] = r.K;
    let d = qRotate(r.pose!.q, [(r.u - cx) / fx, -(r.v - cy) / fy, -1]);
    const n = Math.hypot(...d);
    d = [d[0] / n, d[1] / n, d[2] / n];
    const c = r.pose!.p;
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        const m = (i === j ? 1 : 0) - d[i]! * d[j]!;
        A[i * 3 + j]! += m;
        b[i]! += m * c[j]!;
      }
    }
  }
  const [a, bb, c, d, e, f, g, h, k] = A as [number, number, number, number, number, number, number, number, number];
  const det = a * (e * k - f * h) - bb * (d * k - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-9) return null;
  const inv = [
    (e * k - f * h) / det, (c * h - bb * k) / det, (bb * f - c * e) / det,
    (f * g - d * k) / det, (a * k - c * g) / det, (c * d - a * f) / det,
    (d * h - e * g) / det, (bb * g - a * h) / det, (a * e - bb * d) / det,
  ];
  return [0, 1, 2].map((i) => inv[i * 3]! * b[0]! + inv[i * 3 + 1]! * b[1]! + inv[i * 3 + 2]! * b[2]!) as Vec3;
}

/** The code book the device derives for the whole fixture (codeSpace = total). */
function codeParams(total: number): CodeParams {
  const p: CodeParams = {
    ledCount: total,
    bits: 0,
    encoding: "hue",
    symbols: 4,
    bitPeriodMs: 100,
    syncPattern: "on_off",
    cycleFrames: 0,
    fec: "secded",
  };
  p.bits = expectedBits(p);
  p.cycleFrames = 2 + Math.ceil(p.bits / 2);
  return p;
}

function simulate(plan: ChannelCapturePlan): { records: DetectionRecord[]; truth: Vec3[]; stageIds: Set<number>[] } {
  const truth = [...curtain(), ...rope()];
  const params = codeParams(plan.total);
  const rng = mulberry32(11);
  const A = 3;
  const records: DetectionRecord[] = [];
  const stageIds: Set<number>[] = [];
  const cycles = 4;
  const nFrames = Math.floor((cycles * params.cycleFrames * params.bitPeriodMs) / FPS_DT);
  // Epochs: the regular stage, then each coverage phase of the strided stage
  // (bridges add fusion overlap only — stride.test.ts — not new ids).
  const runs: { stage: CaptureStage; phase: number }[] = [];
  for (const st of plan.stages) {
    const phases = st.strideSpacing > 1 ? st.strideSpacing : 1;
    for (let ph = 0; ph < phases; ph++) runs.push({ stage: st, phase: ph });
  }
  let frameNo = 0;
  const totalFrames = runs.length * nFrames;
  for (const run of runs) {
    const si = plan.stages.indexOf(run.stage);
    const ids = (stageIds[si] ??= new Set<number>());
    const pipeline = new CvPipeline(params, EPOCH, (t) => t + OFFSET);
    pipeline.onDetections((r) => {
      records.push(...r);
      for (const x of r) ids.add(x.ledId);
    });
    const lit = (id: number) => stageLit(id, run.stage, run.phase, A);
    for (let f = 0; f < nFrames; f++, frameNo++) {
      const tLocal = f * FPS_DT;
      const pose = arcPose(frameNo / totalFrames);
      const base = { imgW: IMG_W, imgH: IMG_H, rng, phase: run.phase };
      // Curtain: sharp fairy lights. Rope: through a diffuser (bloom ~ its pitch).
      const imgC = renderFrame(truth.slice(0, CURTAIN), pose, K, params, EPOCH, tLocal + OFFSET, {
        ...base,
        spotSigmaWorld: 0.004,
        spotSigmaMinPx: 1.4,
        lit,
      });
      const imgR = renderFrame(truth, pose, K, params, EPOCH, tLocal + OFFSET, {
        ...base,
        spotSigmaWorld: 0.004,
        spotSigmaMinPx: 1.4,
        diffuseSigmaPx: 2.0,
        lit: (id) => id >= CURTAIN && lit(id),
      });
      for (let i = 0; i < imgC.data.length; i++) imgC.data[i]! += imgR.data[i]!;
      const reduced =
        run.stage.kind === "strided"
          ? reduceToDetect(imgC, { downscale: 1, threshold: 0.18, localContrast: { sigma: 8, gain: 1 } })
          : reduceToDetect(imgC, { downscale: 1, threshold: 0.6 });
      const blobs = reducedToBlobs(reduced.detect, reduced.w, reduced.h, reduced.ds, IMG_H, false, DET);
      pipeline.step(blobs, { tCaptureMs: tLocal, pose, K, imgW: IMG_W, imgH: IMG_H });
    }
  }
  return { records, truth, stageIds };
}

test("sim end to end: curtain (regular) + rope (stride 4) decode, triangulate, fill per channel", () => {
  const plan = planChannelCapture([CURTAIN, ROPE], HALLOWEEN)!;
  const { records, truth, stageIds } = simulate(plan);

  // Stage 1 lit only the curtain: every id it decoded is a curtain id.
  const s1 = stageIds[0]!;
  assert.ok([...s1].every((id) => id < CURTAIN), "stage 1 decoded only CH0 ids");
  const curtainYield = [...s1].length / CURTAIN;
  const ropeIds = new Set(records.map((r) => r.ledId).filter((id) => id >= CURTAIN));
  const ropeYield = ropeIds.size / ROPE;

  // Wrong-id decodes (a record far from its claimed LED's projection).
  let bad = 0;
  for (const r of records) {
    const pr = project(r.pose!, r.K, truth[r.ledId]!);
    if (Math.hypot(pr.u - r.u, pr.v - r.v) > 4) bad++;
  }

  // "Solve" with the known camera path (stand-in for the VIO solver, which this
  // pure-TS suite can't run): triangulate each decoded LED, drop ones seen < 3x.
  const byId = new Map<number, DetectionRecord[]>();
  for (const r of records) (byId.get(r.ledId) ?? byId.set(r.ledId, []).get(r.ledId)!).push(r);
  const leds: LedEntry[] = [];
  for (const [id, rs] of byId) {
    if (rs.length < 3) continue;
    const p = triangulate(rs);
    if (p) leds.push({ id, xyz: p, confidence: 0.8, nViews: rs.length, rmsReprojPx: 0.5, parallaxDeg: 5 });
  }
  leds.sort((a, b) => a.id - b.id);
  const filled = fillChannelGaps(mapOf(plan.total, leds), plan.spans);
  const err = (lo: number, hi: number, onlyPlaced: boolean) => {
    const e: number[] = [];
    for (const l of filled.leds) {
      if (l.id < lo || l.id >= hi || (onlyPlaced && l.nViews !== 0)) continue;
      const t = truth[l.id]!;
      e.push(Math.hypot(l.xyz[0] - t[0], l.xyz[1] - t[1], l.xyz[2] - t[2]));
    }
    e.sort((a, b) => a - b);
    return { n: e.length, median: e[e.length >> 1] ?? 0, max: e[e.length - 1] ?? 0 };
  };
  const cErr = err(0, CURTAIN, false);
  const rErr = err(CURTAIN, plan.total, false);
  const rPlaced = err(CURTAIN, plan.total, true);
  console.log(
    `[channel-sim] records=${records.length} bad=${bad} curtain yield ${(curtainYield * 100).toFixed(0)}% ` +
      `rope yield ${(ropeYield * 100).toFixed(0)}% · placed ${filled.leds.filter((l) => l.nViews === 0).length} · ` +
      `curtain err med ${(cErr.median * 1000).toFixed(1)} mm · rope err med ${(rErr.median * 1000).toFixed(1)} mm ` +
      `(placed-only med ${(rPlaced.median * 1000).toFixed(1)} max ${(rPlaced.max * 1000).toFixed(1)} mm)`,
  );

  assert.ok(curtainYield >= 0.9, `curtain decoded in the regular stage: ${curtainYield}`);
  assert.ok(ropeYield >= 0.6, `rope decoded across the stride phases: ${ropeYield}`);
  assert.ok(bad / records.length < 0.02, `wrong-id decodes ${bad}/${records.length}`);
  assert.equal(filled.unmapped.length, 0, "every LED placed (measured or filled within its channel)");
  assert.ok(cErr.median < 0.01, `curtain median error ${cErr.median}`);
  assert.ok(rErr.median < 0.015, `rope median error ${rErr.median}`);
  // The rope's filled LEDs sit on the rope (it is 0.2 m in front of the
  // curtain): a cross-boundary fill would drag the first ones toward z = 0.
  for (const l of filled.leds) {
    if (l.id >= CURTAIN) assert.ok(Math.abs(l.xyz[2] - 0.2) < 0.05, `rope LED ${l.id} z=${l.xyz[2]}`);
  }
});
