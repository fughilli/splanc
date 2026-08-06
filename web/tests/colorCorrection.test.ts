/**
 * Color-correction curve math (src/color/correction.ts) + the set_color_correction
 * wire round-trip. The LUT math must match the firmware (color_correction.h) so
 * the PWA preview reflects the device; these assertions mirror the firmware host
 * test (color_correction_test.cc).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PRESETS,
  buildLut,
  inverseLut,
  balanceFactors,
  gammaForPoint,
  matchPreset,
  transfer,
  type GammaProfile,
} from "../src/color/correction";
import { decodeClient, encodeClient } from "../src/net/proto";

const ws2812b = PRESETS.find((p) => p.id === "ws2812b")!.profile;

test("LUTs are monotonic and pinned at zero", () => {
  const lut = buildLut(ws2812b);
  for (const ch of lut) {
    assert.equal(ch[0], 0, "input 0 -> 0");
    for (let v = 1; v < 256; v++) {
      assert.ok(ch[v]! >= ch[v - 1]!, `monotonic at ${v}`);
    }
  }
});

test("white balance matches the firmware (blue dimmest -> full; green dimmed most)", () => {
  const [fR, fG, fB] = buildLut(ws2812b);
  // Blue is the dimmest (300 mcd) -> balance 1.0 -> reaches full 255.
  assert.equal(fB[255], 255);
  // Red (625) and green (1250) are scaled down toward blue; green the most.
  assert.ok(fR[255]! < 255);
  assert.ok(fG[255]! < 255);
  assert.ok(fG[255]! < fR[255]!);
  // Exact firmware values (ceil of the scaled endpoint).
  assert.equal(fR[255], 123); // ceil(255 * 300/625)
  assert.equal(fG[255], 62); // ceil(255 * 300/1250)
});

test("gamma darkens the midtones (the washout fix)", () => {
  const [, , fB] = buildLut(ws2812b);
  assert.ok(fB[128]! < 128); // balance-neutral channel, gamma 2.8
});

test("linear profile is an identity ramp at the endpoints", () => {
  const linear = PRESETS.find((p) => p.id === "linear")!.profile;
  for (const ch of buildLut(linear)) {
    assert.equal(ch[0], 0);
    assert.equal(ch[255], 255);
  }
});

test("inverseLut is monotonic and spans the input range", () => {
  const [, , fB] = buildLut(ws2812b);
  const inv = inverseLut(fB); // balance-neutral channel
  assert.equal(inv[0], 0);
  assert.equal(inv[255], 255);
  for (let o = 1; o < 256; o++) assert.ok(inv[o]! >= inv[o - 1]!);
});

test("gammaForPoint recovers the gamma of a point on the curve", () => {
  // A point exactly on a gamma-2.5 curve (balance 1) should recover ~2.5.
  const x = 0.5;
  const y = Math.pow(x, 2.5);
  const g = gammaForPoint(x, y, 1);
  assert.ok(Math.abs(g - 2.5) < 1e-3, `recovered ${g}`);
});

test("transfer honors white balance at full input", () => {
  balanceFactors(ws2812b).forEach((gain, c) => {
    assert.ok(Math.abs(transfer(ws2812b, c, 1) - gain) < 1e-6);
  });
});

test("matchPreset identifies a built-in and rejects a tweak", () => {
  assert.equal(matchPreset(ws2812b), "ws2812b");
  const tweaked: GammaProfile = { gamma: [2.9, 2.8, 2.8], luminance: [625, 1250, 300] };
  assert.equal(matchPreset(tweaked), null);
});

test("set_color_correction round-trips through the wire (explicit params)", () => {
  const msg = {
    type: "set_color_correction",
    gammaR: 2.2,
    gammaG: 2.8,
    gammaB: 2.8,
    lumR: 1,
    lumG: 1,
    lumB: 1,
  } as unknown as Parameters<typeof encodeClient>[0];
  const back = decodeClient(encodeClient(msg)) as unknown as {
    type: string;
    gammaR: number;
    gammaG: number;
    lumB: number;
  };
  assert.equal(back.type, "set_color_correction");
  assert.ok(Math.abs(back.gammaR - 2.2) < 1e-4);
  assert.ok(Math.abs(back.gammaG - 2.8) < 1e-4);
  assert.equal(back.lumB, 1);
});

test("set_color_correction round-trips a named profile", () => {
  const msg = {
    type: "set_color_correction",
    profile: "ws2812b",
  } as unknown as Parameters<typeof encodeClient>[0];
  const back = decodeClient(encodeClient(msg)) as unknown as { type: string; profile: string };
  assert.equal(back.type, "set_color_correction");
  assert.equal(back.profile, "ws2812b");
});
