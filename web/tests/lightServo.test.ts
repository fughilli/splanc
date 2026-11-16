/**
 * Exposure-first light servo (cv/lightServo.ts): exposure moves before LED
 * brightness, the measured exposure floor holds, brightness never ratchets on
 * a signal that doesn't respond, recovery runs in reverse order, partial
 * framing doesn't dim, and cameras without a manual exposure lock fall back to
 * brightness-only. Plus a closed-loop plant sim (dark room, auto-exposure-like
 * gain) comparing the legacy planLedBrightness against the new controller.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { LED_BRIGHTNESS_MIN, planLedBrightness } from "../src/cv/exposure";
import {
  blobCrowding,
  DIM_LOCK_TICKS,
  EXPOSURE_FLOOR_INTENSITY,
  formatLightServo,
  initialLightServo,
  type LightServoState,
  type LightSignals,
  planLightServo,
} from "../src/cv/lightServo";
import type { Blob } from "../src/cv/types";

const HEALTHY: LightSignals = {
  blobCount: 900,
  ledCount: 1000,
  splitFrac: 0,
  grayFrac: 0.05,
  satFrac: 0.1,
  medianIntensity: 0.8,
  clipFrac: 0.001,
  crowding: { touchFrac: 0.02, medianGapRatio: 3 },
};
const GRAY: LightSignals = { ...HEALTHY, grayFrac: 0.7, satFrac: 0.9, medianIntensity: 0.95 };

function exposureFirst(exposure = 0.5, brightness = 1): LightServoState {
  return initialLightServo({ exposureSupported: true, exposure, brightness });
}

test("over-exposure shortens EXPOSURE first; brightness untouched while above the floor", () => {
  const r = planLightServo(exposureFirst(0.5), GRAY, 1);
  assert.ok(r.exposure !== null && r.exposure < 0.5);
  assert.equal(r.brightness, null);
  assert.match(r.reason, /gray.*shorten exposure/);
});

test("brightness steps down only once exposure sits on its floor", () => {
  // Walk exposure down with detection healthy-enough until a step breaks it.
  let s = exposureFirst(0.3);
  const seen: string[] = [];
  let bright: number | null = null;
  for (let i = 0; i < 12 && bright === null; i++) {
    // The plant: below 0.15 the blobs fade under the floor intensity.
    const m = s.exposure < 0.15 ? { ...GRAY, medianIntensity: 0.2 } : GRAY;
    const r = planLightServo(s, m, 1);
    s = r.state;
    seen.push(r.reason);
    bright = r.brightness;
  }
  assert.ok(bright !== null && bright < 1, `expected a dim eventually: ${seen.join(" | ")}`);
  const firstDim = seen.findIndex((x) => /dim LEDs/.test(x));
  const firstShorten = seen.findIndex((x) => /shorten exposure/.test(x));
  assert.ok(firstShorten >= 0 && firstShorten < firstDim, seen.join(" | "));
  assert.ok(seen.some((x) => /^floor:/.test(x)), "the floor was measured, not assumed");
});

test("the measured floor holds: a step that dims blobs under the floor reverts and is never retried below it", () => {
  let s = exposureFirst(0.3);
  let r = planLightServo(s, GRAY, 1); // shorten 0.30 -> 0.18
  assert.ok(Math.abs(r.exposure! - 0.18) < 1e-9);
  s = r.state;
  // That step starved the detector: intensity under the floor threshold.
  r = planLightServo(s, { ...GRAY, medianIntensity: EXPOSURE_FLOOR_INTENSITY - 0.05 }, 1);
  assert.equal(r.exposure, 0.3);
  assert.match(r.reason, /^floor: medI/);
  s = r.state;
  assert.equal(s.exposureFloor, 0.3);
  // Bloom persists: exposure must NOT go under the floor again — brightness goes.
  for (let i = 0; i < 4; i++) {
    r = planLightServo(s, GRAY, s.brightness);
    s = r.state;
    assert.ok(s.exposure >= 0.3 - 1e-9);
  }
});

test("floor: a blob-count collapse across the step pins it too (starve), so does banding", () => {
  let s = exposureFirst(0.4);
  let r = planLightServo(s, GRAY, 1);
  s = r.state;
  r = planLightServo(s, { ...GRAY, blobCount: 300 }, 1);
  assert.match(r.reason, /^floor: count 900→300/);
  assert.equal(r.state.exposureFloor, 0.4);

  s = exposureFirst(0.4);
  s = planLightServo(s, GRAY, 1).state;
  r = planLightServo(s, { ...HEALTHY, blobCount: 2600, satFrac: 0.05 }, 1);
  assert.match(r.reason, /^floor: banding/);
});

test("no ratchet: a dim that doesn't reduce its signal is undone and dimming locks out", () => {
  // Brightness-only (auto-exposure): gray stays at 0.7 whatever we do.
  let s = initialLightServo({ exposureSupported: false, exposure: 0.25, brightness: 1 });
  let applied = 1;
  let pending: number | null = null;
  const log: string[] = [];
  const brightnessSeen: number[] = [];
  for (let tick = 0; tick < 60; tick++) {
    const r = planLightServo(s, GRAY, applied);
    s = r.state;
    log.push(r.reason);
    // The capture page's two-tick confirmation (configure lands by next tick).
    if (r.brightness !== null && r.brightness === pending) {
      applied = r.brightness;
      pending = null;
    } else pending = r.brightness;
    brightnessSeen.push(applied);
  }
  assert.ok(Math.min(...brightnessSeen) >= 0.5, `ratcheted: ${brightnessSeen.join(",")}`);
  assert.equal(applied, 1, "restored to full brightness");
  assert.ok(log.some((x) => /no-response/.test(x)), log.join(" | "));
  // Lockout escalates: at most a couple of dim attempts in 2 minutes.
  const attempts = log.filter((x) => /dim LEDs/.test(x)).length;
  assert.ok(attempts <= 6, `too many dim attempts (${attempts}) with DIM_LOCK_TICKS=${DIM_LOCK_TICKS}`);
});

test("a dim that DOES reduce the signal is kept", () => {
  let s = initialLightServo({ exposureSupported: false, exposure: 0.25, brightness: 1 });
  let r = planLightServo(s, GRAY, 1);
  assert.equal(r.brightness, 0.5);
  s = r.state;
  s = planLightServo(s, GRAY, 1).state; // confirm tick (caller applies 0.5)
  s = planLightServo(s, { ...GRAY, grayFrac: 0.3 }, 0.5).state; // landed: wait a tick
  r = planLightServo(s, { ...HEALTHY, grayFrac: 0.2 }, 0.5);
  assert.notEqual(r.brightness, 1, "no restore");
  assert.doesNotMatch(r.reason, /no-response/);
});

test("recovery runs in reverse: brightness back toward 1 first, then exposure", () => {
  let s = exposureFirst(0.2, 0.25);
  const dim: LightSignals = { ...HEALTHY, medianIntensity: 0.3, satFrac: 0, grayFrac: 0 };
  let applied = 0.25;
  let pending: number | null = null;
  const order: string[] = [];
  for (let i = 0; i < 40; i++) {
    const r = planLightServo(s, dim, applied);
    s = r.state;
    if (r.exposure !== null) order.push(`E${r.exposure.toFixed(2)}`);
    if (r.brightness !== null && r.brightness === pending) {
      applied = r.brightness;
      order.push(`B${applied.toFixed(2)}`);
      pending = null;
    } else pending = r.brightness;
  }
  const firstE = order.findIndex((x) => x.startsWith("E"));
  const lastB = order.map((x) => x.startsWith("B")).lastIndexOf(true);
  assert.ok(lastB >= 0 && firstE > lastB, order.join(" "));
  assert.equal(applied, 1);
  assert.ok(s.exposure > 0.2);
});

test("partial framing (few bright blobs, NOT touching) doesn't dim; touching blobs do", () => {
  const partial: LightSignals = {
    ...HEALTHY,
    blobCount: 400,
    medianIntensity: 0.9,
    satFrac: 0.2,
    crowding: { touchFrac: 0.03, medianGapRatio: 3.2 },
  };
  const s = initialLightServo({ exposureSupported: false, exposure: 0.25, brightness: 1 });
  assert.equal(planLightServo(s, partial, 1).brightness, null);
  assert.equal(planLightServo(s, { ...partial, crowding: null }, 1).brightness, null);
  // The legacy servo dims this exact picture.
  assert.equal(
    planLedBrightness(1, { blobCount: 400, ledCount: 1000, splitFrac: 0, grayFrac: 0.05, medianIntensity: 0.9, clipFrac: 0 }),
    0.5,
  );
  const merged = { ...partial, crowding: { touchFrac: 0.6, medianGapRatio: 1.1 } };
  assert.match(planLightServo(s, merged, 1).reason, /^merge/);
});

test("unsupported camera falls back to brightness-only (exposure never commanded)", () => {
  let s = initialLightServo({ exposureSupported: false, exposure: 0.25, brightness: 1 });
  assert.equal(s.mode, "brightness-only");
  for (const m of [GRAY, HEALTHY, { ...HEALTHY, medianIntensity: 0.2, blobCount: 0 }]) {
    const r = planLightServo(s, m, 1);
    assert.equal(r.exposure, null);
    s = r.state;
  }
  assert.match(formatLightServo(s), /exp auto/);
  // Under AE the sat gate is off (it was removed 2026-07-16 for ratcheting).
  const sat: LightSignals = { ...HEALTHY, satFrac: 1 };
  const fresh = initialLightServo({ exposureSupported: false, exposure: 0.25, brightness: 1 });
  assert.equal(planLightServo(fresh, sat, 1).brightness, null);
});

test("pinned brightness: exposure still servos, brightness is never proposed", () => {
  let s = initialLightServo({ exposureSupported: true, exposure: 0.0, brightness: 0.4, brightnessLocked: true });
  const r = planLightServo(s, GRAY, 0.4);
  assert.equal(r.brightness, null);
  s = r.state;
  assert.match(r.reason, /brightness pinned/);
});

test("blobCrowding: a spaced grid is untouched, a packed one touches", () => {
  const grid = (pitch: number): Blob[] => {
    const out: Blob[] = [];
    for (let x = 0; x < 30; x++) for (let y = 0; y < 30; y++) out.push({ u: x * pitch, v: y * pitch, intensity: 1, area: Math.PI * 16 });
    return out;
  };
  const spaced = blobCrowding(grid(40))!; // r=4, gap ratio 40/8 = 5 -> capped 4
  assert.equal(spaced.touchFrac, 0);
  assert.equal(spaced.medianGapRatio, 4);
  const packed = blobCrowding(grid(10))!; // 10/8 = 1.25 < 1.5
  assert.equal(packed.touchFrac, 1);
  assert.ok(Math.abs(packed.medianGapRatio - 1.25) < 1e-9);
  assert.equal(blobCrowding([]), null);
});

// -- closed-loop plant sim -------------------------------------------------
//
// A deliberately simple photometric plant for a 1000-LED wall in a DARK room
// (only the LEDs light the frame):
//   LED level L = brightness × exposureMs × gain × K, per LED × u ∈ [0.6, 1.4]
//   auto-exposure: gain raised (≤ GAIN_MAX) until the frame meters mid-gray,
//     which with only the LEDs in view pins them clipped at any brightness;
//   manual lock: gain = 1 (ISO pinned to its minimum), exposure is ours.
// Signals: detected when L·u > 0.15; clipped above 1; hue washed (gray) above
// 1.6; split halos above 3; neighbours merge (touching, count halves) above
// 2.5; exposure under one PWM period bands each LED into ~3 fragments.

interface PlantOut {
  signals: LightSignals;
  L: number;
}
const N = 1000;
const K = 2; // level per ms at gain 1, full brightness
const GAIN_MAX = 16;
const AE_EXPOSURE_MS = 16;
const PWM_MS = 0.15;
const FILL = 0.02; // fraction of the frame the LEDs cover
const expMs = (t: number): number => 0.02 * Math.pow(16 / 0.02, t); // planExposure's geometric map

function plant(brightness: number, exposure: number | "auto", framing = 1): PlantOut {
  let e: number;
  let gain: number;
  if (exposure === "auto") {
    // AE meters the frame to mid-gray (0.18) with exposure × gain, up to the
    // longest exposure at max gain.
    const want = 0.18 / Math.max(1e-6, brightness * K * FILL);
    const product = Math.min(AE_EXPOSURE_MS * GAIN_MAX, Math.max(0.02, want));
    e = Math.min(AE_EXPOSURE_MS, product);
    gain = product / e;
  } else {
    e = expMs(exposure);
    gain = 1;
  }
  const L = brightness * e * gain * K;
  const inView = Math.round(N * framing);
  let det = 0;
  let gray = 0;
  let sat = 0;
  for (let i = 0; i < inView; i++) {
    const l = L * (0.6 + (0.8 * i) / Math.max(1, inView - 1));
    if (l <= 0.15) continue;
    det++;
    if (l > 1.6) gray++;
    if (l > 1) sat++;
  }
  const merged = L > 2.5;
  const banded = e < PWM_MS && L > 0.15;
  const blobCount = Math.round(det * (merged ? 0.5 : 1) * (banded ? 3 : 1));
  return {
    L,
    signals: {
      blobCount,
      ledCount: N,
      splitFrac: L > 3 ? 0.15 : 0,
      grayFrac: det > 0 ? gray / det : 0,
      satFrac: det > 0 ? Math.min(1, Math.max(0, (L - 0.9) / 0.6)) : 0,
      medianIntensity: det > 0 ? Math.min(1, L) : 0,
      clipFrac: (FILL * sat) / Math.max(1, inView),
      crowding: { touchFrac: merged ? 0.6 : 0.03, medianGapRatio: merged ? 1.1 : 3 },
    },
  };
}

interface SimTrace {
  brightness: number[];
  exposure: number[];
  L: number[];
  reasons: string[];
}

/** Run the capture page's 2 s tick loop (two-tick confirm; a confirmed
 * configure lands before the next tick) for `ticks` ticks. */
function runSim(
  policy: "legacy" | "new",
  camera: "auto" | "manual",
  ticks = 90,
  framing = 1,
): SimTrace {
  let applied = 1;
  let pending: number | null = null;
  let s = initialLightServo({ exposureSupported: camera === "manual", exposure: 0.25, brightness: 1 });
  const tr: SimTrace = { brightness: [], exposure: [], L: [], reasons: [] };
  for (let t = 0; t < ticks; t++) {
    const exp = camera === "manual" ? s.exposure : "auto";
    const p = plant(applied, exp, framing);
    let want: number | null;
    if (policy === "legacy") {
      want = planLedBrightness(applied, p.signals);
      tr.reasons.push(want === null ? "hold" : `→${want}`);
    } else {
      const r = planLightServo(s, p.signals, applied);
      s = r.state;
      want = r.brightness;
      tr.reasons.push(r.reason);
    }
    if (want !== null && want === pending) {
      applied = want;
      pending = null;
    } else pending = want;
    tr.brightness.push(applied);
    tr.exposure.push(camera === "manual" ? s.exposure : Number.NaN);
    tr.L.push(p.L);
  }
  return tr;
}

const summary = (name: string, tr: SimTrace): string => {
  const tail = tr.brightness.slice(-30);
  const fmt = (x: number): string => x.toFixed(2);
  return (
    `${name}: final LED ${fmt(tr.brightness.at(-1)!)} · min LED ${fmt(Math.min(...tr.brightness))}` +
    ` · mean LED (last 60 s) ${fmt(tail.reduce((a, b) => a + b, 0) / tail.length)}` +
    (Number.isNaN(tr.exposure.at(-1)!) ? "" : ` · exp ${fmt(tr.exposure.at(-1)!)}`) +
    ` · L ${fmt(tr.L.at(-1)!)}`
  );
};

test("plant sim, dark room + auto-exposure: legacy ratchets to the 5% floor, the new controller doesn't", () => {
  const legacy = runSim("legacy", "auto");
  const fresh = runSim("new", "auto");
  console.log(summary("legacy  / AE    ", legacy));
  console.log(summary("new     / AE    ", fresh));
  assert.equal(legacy.brightness.at(-1), LED_BRIGHTNESS_MIN, "the bug the owner saw on the wall");
  assert.ok(Math.min(...fresh.brightness) >= 0.5, `new ratcheted: ${fresh.brightness.join(",")}`);
  assert.equal(fresh.brightness.at(-1), 1);
});

test("plant sim, manual exposure: exposure does the work, LEDs stay at full brightness, frame never blacks out", () => {
  const tr = runSim("new", "manual");
  console.log(summary("new     / manual", tr));
  const settled = tr.L.slice(-30);
  // Detection healthy after settling: lit, not washed (gray above 1.6).
  assert.ok(Math.min(...settled) > 0.3 && Math.max(...settled) < 1.6, `L ${settled.map((x) => x.toFixed(2)).join(",")}`);
  assert.equal(tr.brightness.at(-1), 1);
  assert.ok(Math.min(...tr.brightness) === 1, "no dims needed: exposure fixed it");
  // Never below the PWM banding period after the floor is learned.
  for (let i = 10; i < tr.exposure.length; i++) assert.ok(expMs(tr.exposure[i]!) >= PWM_MS * 0.99);
});

test("plant sim, partial framing (60% of the wall in view): no dimming", () => {
  const tr = runSim("new", "manual", 60, 0.6);
  assert.equal(Math.min(...tr.brightness), 1);
});
