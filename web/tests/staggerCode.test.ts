/**
 * Hue code v2 phase 2 (docs/design/hue-code-v2.md) through the phone's wasm
 * binding: the staggered-pilot colour plan is the kernel's golden
 * (firmware/pattern/testdata/golden_stagger16*.json — the same fixtures the
 * Rust tests and the Python ctypes binding check), v1 is untouched, and the
 * test-page ?sync= override parses as documented.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import type { CodeParams } from "@ledmapper/protocol";
import {
  COLOR_BLUE,
  COLOR_GREEN,
  COLOR_MAGENTA,
  COLOR_RED,
  COLOR_WHITE,
  COLOR_YELLOW,
  colorForFrame,
  DATA_FRAME_OFFSET,
  dataFrames,
  expectedBits,
  forcedSyncPattern,
  isStaggered,
  type Rgb,
  staggerPhase,
  staggerStep,
  syncColors,
  SYNC_STAGGER_PILOT,
  SYNC_STAGGER_WHITE,
  withSyncPattern,
} from "../src/code/gray";

const LETTER: Record<string, Rgb> = {
  W: COLOR_WHITE,
  G: COLOR_GREEN,
  R: COLOR_RED,
  B: COLOR_BLUE,
  M: COLOR_MAGENTA,
  Y: COLOR_YELLOW,
};

interface StaggerGolden {
  ledCount: number;
  symbols: 2 | 4;
  bits: number;
  cycleFrames: number;
  syncPattern: string;
  staggerStep: number;
  staggerSteps: number[];
  phases: number[];
  colorPlan: string[];
}

/** The kernel's checked-in fixture: the copy in web/kernel_goldens (bazel
 * data dep), else the source tree. */
function golden(name: string): StaggerGolden {
  const rel = `firmware/pattern/testdata/${name}`;
  const candidates = [
    resolve(__dirname, "../../kernel_goldens", name),
    resolve("web/kernel_goldens", name),
    resolve(__dirname, "../../..", rel),
    resolve(rel),
  ];
  const hit = candidates.find((p) => existsSync(p));
  assert.ok(hit, `golden ${rel} not found (${candidates.join(", ")})`);
  return JSON.parse(readFileSync(hit, "utf8")) as StaggerGolden;
}

function book(ledCount: number, symbols: 2 | 4, syncPattern: string): CodeParams {
  const p: CodeParams = {
    ledCount,
    bits: 0,
    encoding: "hue",
    symbols,
    bitPeriodMs: 100,
    syncPattern: syncPattern as CodeParams["syncPattern"],
    cycleFrames: 0,
    fec: "secded",
  };
  p.bits = expectedBits(p);
  p.cycleFrames = DATA_FRAME_OFFSET + dataFrames(p);
  return p;
}

for (const name of ["golden_stagger16.json", "golden_stagger16_sym4.json"]) {
  test(`the wasm binding renders the kernel's ${name}`, () => {
    const g = golden(name);
    const p = book(g.ledCount, g.symbols, g.syncPattern);
    assert.equal(p.syncPattern, SYNC_STAGGER_PILOT);
    assert.equal(p.cycleFrames, g.cycleFrames);
    assert.equal(p.bits, g.bits);
    assert.equal(staggerStep(p.cycleFrames), g.staggerStep);
    g.staggerSteps.forEach((s, i) => assert.equal(staggerStep(i + 3), s, `S(C=${i + 3})`));
    for (let id = 0; id < g.ledCount; id++) assert.equal(staggerPhase(id, p), g.phases[id]);
    g.colorPlan.forEach((row, f) => {
      [...row].forEach((ch, id) => assert.deepEqual(colorForFrame(id, f, p), LETTER[ch], `frame ${f} LED ${id}`));
    });
  });
}

test("v1 is untouched: on_off has no rotation and the white/green delimiter", () => {
  const v1 = book(16, 2, "on_off");
  assert.equal(isStaggered(v1), false);
  for (let id = 0; id < 16; id++) {
    assert.equal(staggerPhase(id, v1), 0);
    assert.deepEqual(colorForFrame(id, 0, v1), COLOR_WHITE);
    assert.deepEqual(colorForFrame(id, 1, v1), COLOR_GREEN);
  }
  assert.deepEqual(syncColors(v1), [COLOR_WHITE, COLOR_GREEN]);
});

test("the staggered code is v1 rotated per LED, with the pilot in the sync slot", () => {
  for (const symbols of [2, 4] as const) {
    const v1 = book(300, symbols, "on_off");
    const st = withSyncPattern(v1, SYNC_STAGGER_PILOT);
    const sw = withSyncPattern(v1, SYNC_STAGGER_WHITE as CodeParams["syncPattern"]);
    assert.deepEqual(syncColors(st), [COLOR_GREEN, COLOR_MAGENTA]);
    const C = v1.cycleFrames;
    for (let id = 0; id < 300; id += 7) {
      const ph = staggerPhase(id, st);
      assert.equal(ph, (id * staggerStep(C)) % C);
      for (let f = 0; f < C; f++) {
        const j = (f - ph + C) % C;
        const want = j === 0 ? COLOR_GREEN : j === 1 ? COLOR_MAGENTA : colorForFrame(id, j, v1);
        assert.deepEqual(colorForFrame(id, f, st), want, `id ${id} f ${f}`);
        assert.deepEqual(colorForFrame(id, f, sw), colorForFrame(id, j, v1), "stagger_white = v1 rotated");
      }
    }
  }
});

test("?sync= parses to a sync pattern, or null", () => {
  assert.equal(forcedSyncPattern(null), null);
  assert.equal(forcedSyncPattern("stagger_pilot"), SYNC_STAGGER_PILOT);
  assert.equal(forcedSyncPattern("stagger-pilot"), SYNC_STAGGER_PILOT);
  assert.equal(forcedSyncPattern("stagger"), SYNC_STAGGER_PILOT);
  assert.equal(forcedSyncPattern("v1"), "on_off");
  assert.equal(forcedSyncPattern("on_off"), "on_off");
  assert.equal(forcedSyncPattern("bogus"), null);
  const p = book(16, 2, "on_off");
  assert.equal(withSyncPattern(p, null), p);
  assert.equal(withSyncPattern(p, SYNC_STAGGER_PILOT).syncPattern, SYNC_STAGGER_PILOT);
});
