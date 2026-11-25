/**
 * Diffuse-capture servo (cv/exposure.ts DiffuseServo, D-178): unit behaviour,
 * plus a closed-loop before/after on the REAL rope frames.
 *
 * The before/after: the 24 stride-3 frames of web/tests/testdata/diffuse_rope
 * form a grid of LED brightness (10/30/60/100%) x camera exposure (x = 0.15 ..
 * 0.65, ~1 EV per 0.1). Each cell runs the production detector (the CPU
 * reference), giving that operating point's yield (lit LEDs found / lit LEDs)
 * and the signals each servo reads. A servo is then run in closed loop for 30
 * two-second ticks from 16 starting points: 4 rooms (where -4 EV of biased auto
 * exposure lands: x = 0.25 / 0.45 / 0.55 / 0.65) x 4 starting brightnesses. Its
 * state snaps to the nearest cell each tick. A brightness change outside a
 * stride-phase boundary restarts the decoder: that tick yields nothing. The
 * score is the mean yield over the run.
 *
 *  - before: planLedBrightness (two-tick confirmation) + the AE-bias -> manual
 *    pin fallback (which also halves the frame rate: counted as half yield);
 *  - after: DiffuseServo (exposure-bias fine lever every tick; brightness
 *    settled first, then held to phase boundaries).
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { inflateSync } from "node:zlib";
import { sceneStatsFromLuma } from "../src/cv/detect";
import { adaptiveDiffuseReduce } from "../src/cv/diffuseDetect";
import {
  AE_BIAS_MAX,
  AE_BIAS_MIN,
  AE_BIAS_STEP,
  blobPopulation,
  type BlobPopulation,
  CORE_CLIP_HIGH,
  DiffuseServo,
  DIFFUSE_SETTLE_MS,
  HELD_ALONE_TICKS,
  planDiffuseServo,
  planLedBrightness,
  type SpotSignals,
  spotSignals,
  SPOT_SNR_LOW,
} from "../src/cv/exposure";
import { blobCrowding, type BlobCrowding, initialLightServo, planLightServo } from "../src/cv/lightServo";
import type { Blob } from "../src/cv/types";
import { emptyScore, ropeBlobs, scoreFrame, type RopeTruth } from "./diffuseRopeScore";

const blob = (o: Partial<Blob>): Blob => ({ u: 0, v: 0, intensity: 0.1, area: 20, r: 0.1, g: 0.05, b: 0.02, peak: 0.1, ...o });
const sig = (snr: number, coreClip = 0): SpotSignals => ({ snr, coreClip, clipChannel: coreClip > 0 ? 2 : -1, blobs: 20 });
const lever = (value: number) => ({ value, lo: AE_BIAS_MIN, hi: AE_BIAS_MAX, step: AE_BIAS_STEP });

test("spotSignals: SNR is the median peak over the noise floor", () => {
  const blobs = [0.02, 0.04, 0.06, 0.08, 0.1].map((p) => blob({ peak: p }));
  assert.equal(spotSignals(blobs, 0.01)!.snr, 6);
  // No floor (native iOS reducer): the 10th-percentile peak stands in.
  assert.equal(spotSignals(blobs, null)!.snr, 3);
  assert.equal(spotSignals([], 0.01), null);
});

test("spotSignals: clipping is per channel, so one clipping channel is not averaged away", () => {
  // 3 blue blobs, all clipped; 7 red ones, none. The median blob is unclipped.
  const blobs = [
    ...Array.from({ length: 3 }, () => blob({ r: 0.1, g: 0.1, b: 1, peak: 1 })),
    ...Array.from({ length: 7 }, () => blob({ r: 0.5, g: 0.05, b: 0.05, peak: 0.5 })),
  ];
  const s = spotSignals(blobs, 0.02)!;
  assert.equal(s.coreClip, 1);
  assert.equal(s.clipChannel, 2);
  assert.equal(blobPopulation(blobs).satFrac, 0); // what the old servo read
  // A clipped magenta core clips both of its channels.
  const mag = Array.from({ length: 4 }, () => blob({ r: 1, g: 0.1, b: 0.95, peak: 1 }));
  const m = spotSignals(mag, 0.02)!;
  assert.equal(m.coreClip, 1);
  assert.ok(m.clipChannel === 0 || m.clipChannel === 2);
});

test("planDiffuseServo: clipping moves exposure first, brightness only at the exposure floor", () => {
  assert.deepEqual(planDiffuseServo(1, lever(-4), sig(20, 0.5), false), { exposure: -4 - AE_BIAS_STEP });
  assert.deepEqual(planDiffuseServo(1, lever(AE_BIAS_MIN), sig(20, 0.5), false), { brightness: 0.6 });
  // No exposure control at all (iOS web): brightness does it.
  assert.deepEqual(planDiffuseServo(1, null, sig(20, 0.5), false), { brightness: 0.6 });
});

test("planDiffuseServo: marginal spots raise brightness first, exposure once brightness is maxed", () => {
  assert.deepEqual(planDiffuseServo(0.3, lever(-4), sig(SPOT_SNR_LOW - 1), false), { brightness: 0.3 * 1.6 });
  assert.deepEqual(planDiffuseServo(1, lever(-4), sig(SPOT_SNR_LOW - 1), false), { exposure: -4 + AE_BIAS_STEP });
  // Settling steps exposure twice as far.
  assert.deepEqual(planDiffuseServo(1, lever(-4), sig(SPOT_SNR_LOW - 1), true), { exposure: -4 + 2 * AE_BIAS_STEP });
  // In band: hold.
  assert.deepEqual(planDiffuseServo(0.6, lever(-4), sig(15, 0.02), false), {});
  // Marginal but a channel already near clipping: don't push.
  assert.deepEqual(planDiffuseServo(0.3, lever(-4), sig(SPOT_SNR_LOW - 1, 0.1), false), {});
});

test("DiffuseServo: brightness moves while settling, then waits for a phase boundary", () => {
  const sv = new DiffuseServo();
  assert.deepEqual(sv.tick(0, 0.3, lever(-4), sig(3)), { brightness: 0.3 * 1.6 });
  assert.ok(sv.settling);
  // In band for two ticks: settled.
  assert.deepEqual(sv.tick(2000, 0.48, lever(-4), sig(12)), {});
  assert.deepEqual(sv.tick(4000, 0.48, lever(-4), sig(12)), {});
  assert.ok(!sv.settling);
  // Now marginal again: nothing applied mid-phase...
  assert.deepEqual(sv.tick(6000, 0.48, lever(-4), sig(3)), {});
  assert.equal(sv.atPhaseBoundary(), null); // one tick isn't confirmation
  assert.deepEqual(sv.tick(8000, 0.48, lever(-4), sig(3)), {});
  assert.deepEqual(sv.tick(10000, 0.48, lever(-4), sig(3)), {});
  // ...it rides the next phase switch.
  assert.ok(Math.abs(sv.atPhaseBoundary()! - 0.48 * 1.6) < 1e-9);
  assert.equal(sv.atPhaseBoundary(), null);
  // Exposure still moves every tick after settling.
  assert.deepEqual(sv.tick(12000, 1, lever(-4), sig(20, CORE_CLIP_HIGH + 0.1)), { exposure: -4 - AE_BIAS_STEP });
});

test("DiffuseServo: without phase boundaries a held change applies only once it persists", () => {
  const sv = new DiffuseServo();
  sv.tick(0, 1, lever(-4), sig(12));
  sv.tick(2000, 1, lever(-4), sig(12)); // settled
  let t = 4000;
  for (let i = 1; i < HELD_ALONE_TICKS; i++, t += 2000) {
    sv.tick(t, 1, lever(AE_BIAS_MIN), sig(20, 0.5));
    assert.equal(sv.takeHeld(HELD_ALONE_TICKS), null);
  }
  sv.tick(t, 1, lever(AE_BIAS_MIN), sig(20, 0.5));
  assert.equal(sv.takeHeld(HELD_ALONE_TICKS), 0.6);
  // A gap in the signal restarts the count.
  sv.tick(t + 2000, 0.6, lever(AE_BIAS_MIN), sig(20, 0.5));
  sv.tick(t + 4000, 0.6, lever(AE_BIAS_MIN), sig(12));
  assert.equal(sv.takeHeld(1), null);
});

test("DiffuseServo: the settle stage ends by DIFFUSE_SETTLE_MS even if never in band", () => {
  const sv = new DiffuseServo();
  let t = 0;
  for (; t < DIFFUSE_SETTLE_MS; t += 2000) sv.tick(t, 1, lever(-1), sig(2));
  sv.tick(t, 1, lever(-1), sig(2));
  assert.ok(!sv.settling);
});

// --- closed loop on the real frames -----------------------------------------

const REL = "tests/testdata/diffuse_rope";
const DIR = [resolve(__dirname, "..", REL), resolve(__dirname, "../..", REL), resolve("web", REL), resolve(REL)].find((p) =>
  existsSync(resolve(p, "truth.json")),
)!;
const B = [0.1, 0.3, 0.6, 1.0];
const X = [0.15, 0.25, 0.35, 0.45, 0.55, 0.65];
interface Cell {
  yield: number;
  spots: SpotSignals;
  pop: BlobPopulation;
  blobs: number;
  clipFrac: number;
  crowding: BlobCrowding | null;
}

function loadCells(): Map<string, Cell> {
  const truth = JSON.parse(readFileSync(resolve(DIR, "truth.json"), "utf8")) as RopeTruth;
  const W = truth.crop.w / 2;
  const H = truth.crop.h / 2;
  const cells = new Map<string, Cell>();
  for (const f of truth.frames) {
    if (f.kind !== "stride3") continue;
    const u8 = inflateSync(readFileSync(resolve(DIR, f.file)));
    const rgb = new Float32Array(u8.length);
    const luma = new Uint8Array(W * H * 4);
    for (let i = 0; i < u8.length; i++) rgb[i] = u8[i]! / 255;
    for (let i = 0; i < W * H; i++) luma[i * 4 + 3] = Math.max(u8[i * 3]!, u8[i * 3 + 1]!, u8[i * 3 + 2]!);
    const r = adaptiveDiffuseReduce(rgb, W, H);
    const blobs = ropeBlobs(truth, r.detect);
    const s = emptyScore();
    scoreFrame(truth, f, blobs, s);
    const lit = f.lit.filter(([i]) => truth.centers[i] !== null).length;
    cells.set(`${f.brightness}|${f.exposure}`, {
      yield: s.hits / lit,
      spots: spotSignals(blobs, r.noise.floor) ?? { snr: 0, coreClip: 0, clipChannel: -1, blobs: 0 },
      pop: blobPopulation(blobs),
      blobs: blobs.length,
      clipFrac: sceneStatsFromLuma(luma, W * H).clipFrac,
      crowding: blobCrowding(blobs),
    });
  }
  return cells;
}

const nearest = (v: number, g: number[], log: boolean): number =>
  g.reduce((a, b) => {
    const d = (x: number) => Math.abs(log ? Math.log(x) - Math.log(v) : x - v);
    return d(b) < d(a) ? b : a;
  });

const TICKS = 30;
const PHASE_EVERY = 2; // a stride-phase dwell is ~3-4 s: every other 2-s tick
interface Run {
  yield: number;
  restarts: number;
  b: number;
  x: number;
}

type Policy = "planLedBrightness" | "lightServo" | "diffuseServo";
function simulate(cells: Map<string, Cell>, b0: number, xAe: number, policy: Policy): Run {
  const after = policy === "diffuseServo";
  const at = (b: number, x: number) => cells.get(`${nearest(b, B, true)}|${nearest(x, X, false)}`)!;
  let b = b0;
  let bias = -4;
  let pinnedX: number | null = null;
  let clipTicks = 0;
  let pend: number | null = null;
  let restarts = 0;
  let y = 0;
  const servo = new DiffuseServo();
  let light = initialLightServo({ exposureSupported: false, exposure: 0.25, brightness: b0 });
  const xNow = () => pinnedX ?? xAe + bias / 10;
  for (let t = 0; t < TICKS; t++) {
    const c = at(b, xNow());
    let restarted = false;
    if (after) {
      const st = servo.tick(t * 2000, b, { value: bias, lo: AE_BIAS_MIN, hi: AE_BIAS_MAX, step: AE_BIAS_STEP }, c.spots);
      if (st.exposure !== undefined) bias = st.exposure;
      if (st.brightness !== undefined) {
        b = st.brightness;
        restarted = true;
        restarts++;
      }
      if (!servo.settling && t % PHASE_EVERY === PHASE_EVERY - 1) b = servo.atPhaseBoundary() ?? b;
    } else {
      if (pinnedX === null) {
        clipTicks = c.pop.satFrac >= 0.25 ? clipTicks + 1 : 0;
        if (clipTicks >= 2) pinnedX = 0.35;
      }
      let want: number | null;
      if (policy === "lightServo") {
        // main's diffuse default since #504: the light servo, brightness-only
        // (diffuse negotiates its own exposure).
        const step = planLightServo(
          light,
          { blobCount: c.blobs, ledCount: 250, ...c.pop, clipFrac: c.clipFrac, crowding: c.crowding },
          b,
        );
        light = step.state;
        want = step.brightness;
      } else {
        want = planLedBrightness(b, {
          blobCount: c.blobs,
          ledCount: 250,
          splitFrac: c.pop.splitFrac,
          grayFrac: c.pop.grayFrac,
          medianIntensity: c.pop.medianIntensity,
          clipFrac: c.clipFrac,
        });
      }
      if (want !== null && want === pend) {
        b = want;
        pend = null;
        restarted = true;
        restarts++;
      } else pend = want;
    }
    // A manual pin drops Chrome to 30 fps: half the frames per bit window.
    if (!restarted) y += c.yield * (pinnedX !== null ? 0.5 : 1);
  }
  return { yield: y / TICKS, restarts, b, x: xNow() };
}

test("closed loop on the rope frames: the diffuse servo decodes more and restarts the decoder less", () => {
  const cells = loadCells();
  assert.equal(cells.size, 24);
  const rooms: [string, number][] = [
    ["bright", 0.65],
    ["lit", 0.85],
    ["dim", 0.95],
    ["dark", 1.05],
  ];
  const tot = { planLedBrightness: 0, lightServo: 0, diffuseServo: 0 };
  const restarts = { planLedBrightness: 0, lightServo: 0, diffuseServo: 0 };
  let worst = Infinity;
  for (const [room, xAe] of rooms) {
    for (const b0 of [1, 0.6, 0.3, 0.1]) {
      const r = {
        planLedBrightness: simulate(cells, b0, xAe, "planLedBrightness"),
        lightServo: simulate(cells, b0, xAe, "lightServo"),
        diffuseServo: simulate(cells, b0, xAe, "diffuseServo"),
      };
      for (const k of Object.keys(r) as Policy[]) {
        tot[k] += r[k].yield / 16;
        restarts[k] += r[k].restarts;
      }
      worst = Math.min(worst, r.diffuseServo.yield - Math.max(r.planLedBrightness.yield, r.lightServo.yield));
      const f = (x: Run) => `${x.yield.toFixed(3)} (${x.restarts}r, ${Math.round(x.b * 100)}% x${x.x.toFixed(2)})`;
      console.log(
        `${room.padEnd(6)} from ${String(Math.round(b0 * 100)).padStart(3)}%: planLedBrightness ${f(r.planLedBrightness)} | ` +
          `lightServo ${f(r.lightServo)} | diffuseServo ${f(r.diffuseServo)}`,
      );
    }
  }
  console.log(
    `mean yield: planLedBrightness ${tot.planLedBrightness.toFixed(3)}, lightServo ${tot.lightServo.toFixed(3)}, ` +
      `diffuseServo ${tot.diffuseServo.toFixed(3)}; decoder restarts ${restarts.planLedBrightness} / ${restarts.lightServo} / ${restarts.diffuseServo}`,
  );
  const best = Math.max(tot.planLedBrightness, tot.lightServo);
  assert.ok(tot.diffuseServo >= best + 0.05, `mean yield ${tot.diffuseServo} vs ${best}`);
  assert.ok(restarts.diffuseServo <= Math.max(restarts.planLedBrightness, restarts.lightServo) / 2, "restarts");
  assert.ok(worst >= -0.03, `worst start loses ${worst}`);
});
