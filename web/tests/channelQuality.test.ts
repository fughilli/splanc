/** Data-aided channel measurement and the alphabet planner (cv/channelQuality.ts). */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { CodeParams } from "@ledmapper/protocol";
import { SYMBOL_COLORS } from "../src/code/gray";
import {
  ChannelQuality,
  hueSat,
  MIN_QUALITY_WINDOWS,
  paletteHues,
  planAlphabet,
  predictAlphabet,
} from "../src/cv/channelQuality";

const PARAMS: CodeParams = {
  ledCount: 1260,
  bits: 16,
  encoding: "hue",
  bitPeriodMs: 140,
  syncPattern: "on_off",
  cycleFrames: 18,
  fec: "secded",
  symbols: 2,
};

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A saturated colour at hue `h` (rad). */
function atHue(h: number, sat = 1): [number, number, number] {
  const deg = (((h * 180) / Math.PI) % 360 + 360) % 360;
  const c = sat;
  const x = c * (1 - Math.abs(((deg / 60) % 2) - 1));
  const m = 1 - c;
  const [r, g, b] =
    deg < 60 ? [c, x, 0] : deg < 120 ? [x, c, 0] : deg < 180 ? [0, c, x] : deg < 240 ? [0, x, c] : deg < 300 ? [x, 0, c] : [c, 0, x];
  return [r + m, g + m, b + m];
}

/** Feed `n` windows of the 2-symbol alphabet with Gaussian hue noise σ (rad). */
function feed(q: ChannelQuality, sigma: number, n: number, seed = 1, bias = 0): void {
  const rand = mulberry32(seed);
  const gauss = (): number => (rand() + rand() + rand() + rand() + rand() + rand() - 3) * Math.SQRT2;
  const hues = paletteHues(2);
  for (let i = 0; i < n; i++) {
    const sent = i % 2;
    q.add(atHue(hues[sent]! + bias + sigma * gauss()), sent, sent, 2);
  }
}

test("hue of the palette colours", () => {
  const deg = (c: readonly [number, number, number]): number => Math.round((hueSat(c).hue * 180) / Math.PI);
  assert.deepEqual(SYMBOL_COLORS[4]!.map((c) => deg(c)), [240, 300, 60, 0]);
  assert.equal(hueSat([0.5, 0.5, 0.5]).sat, 0);
});

test("the estimate recovers the hue noise and bias it was fed", () => {
  const q = new ChannelQuality();
  const sigma = (6 * Math.PI) / 180;
  feed(q, sigma, 600, 3, (4 * Math.PI) / 180);
  const est = q.estimate()!;
  assert.ok(Math.abs(est.sigmaRad - sigma) < 0.25 * sigma, `σ ${est.sigmaRad}`);
  assert.ok(Math.abs(est.biasRad - (4 * Math.PI) / 180) < 0.02, `bias ${est.biasRad}`);
  assert.equal(est.washedFrac, 0);
});

test("washed-out windows are counted, not read as hue", () => {
  const q = new ChannelQuality();
  for (let i = 0; i < 100; i++) q.add([0.9, 0.85, 0.88], 0, 1, 2);
  const est = q.estimate()!;
  assert.equal(est.washedFrac, 1);
  assert.equal(est.misreadFrac, 1);
});

test("predictions: finer alphabets fail more on the same channel, and less on a cleaner one", () => {
  const q = new ChannelQuality();
  feed(q, (8 * Math.PI) / 180, 400);
  const est = q.estimate()!;
  const p = [2, 4, 8, 16].map((s) => predictAlphabet(est, s, PARAMS).pCycle);
  for (let i = 1; i < p.length; i++) assert.ok(p[i]! <= p[i - 1]!, `monotone ${p.join(",")}`);
  const clean = new ChannelQuality();
  feed(clean, (2 * Math.PI) / 180, 400);
  assert.ok(predictAlphabet(clean.estimate()!, 8, PARAMS).pCycle > p[2]!);
});

test("a clean channel upgrades 2 → 4 with no scene-brightness gate (the dark room)", () => {
  const q = new ChannelQuality();
  feed(q, (3 * Math.PI) / 180, 300);
  assert.equal(planAlphabet(2, q.estimate(), PARAMS), 4);
});

test("a noisy channel drops 4 → 2, and a merely fair one stays put", () => {
  const noisy = new ChannelQuality();
  feed(noisy, (25 * Math.PI) / 180, 300);
  assert.equal(planAlphabet(4, noisy.estimate(), { ...PARAMS, symbols: 4 }), 2);
  // 2 symbols on a channel where 4 wouldn't pay: no switch either way.
  assert.equal(planAlphabet(2, noisy.estimate(), PARAMS), null);
});

test("no switch on too little evidence", () => {
  const q = new ChannelQuality();
  feed(q, 0.01, MIN_QUALITY_WINDOWS - 1);
  assert.equal(planAlphabet(2, q.estimate(), PARAMS), null);
});

test("the estimate is alphabet-independent: windows read under 4 symbols predict 2 as well", () => {
  const rand = mulberry32(9);
  const gauss = (): number => (rand() + rand() + rand() + rand() + rand() + rand() - 3) * Math.SQRT2;
  const sigma = (5 * Math.PI) / 180;
  const q4 = new ChannelQuality();
  const hues4 = paletteHues(4);
  for (let i = 0; i < 600; i++) q4.add(atHue(hues4[i % 4]! + sigma * gauss()), i % 4, i % 4, 4);
  const q2 = new ChannelQuality();
  feed(q2, sigma, 600, 9);
  const a = q4.estimate()!.sigmaRad;
  const b = q2.estimate()!.sigmaRad;
  assert.ok(Math.abs(a - b) < 0.2 * b, `${a} vs ${b}`);
});
