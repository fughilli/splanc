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
  codeBookFor,
  codedIndex,
  colorForFrame,
  dataFrames,
  decodeCycleSymbols,
  forcedSyncPattern,
  requestedSyncPattern,
  FEATURE_STAGGER_PILOT,
  isStaggered,
  type Rgb,
  staggerPhase,
  staggerStep,
  SYMBOL_COLORS,
  symbolAt,
  syncColors,
  syncFrames,
  SYNC_STAGGER_GM,
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
  pilotColors: string;
  codedIndex: number[];
  staggerStep: number;
  staggerSteps: number[];
  phasesWide: number[];
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
  const b = codeBookFor(ledCount, symbols, "secded", syncPattern);
  p.bits = b.bits;
  p.cycleFrames = b.cycleFrames;
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
    for (let id = 0; id < g.ledCount; id++) {
      assert.equal(staggerPhase(id, p), g.phases[id]);
      assert.equal(codedIndex(id, p), g.codedIndex[id]);
    }
    // The non-linear phase map over many id blocks (hue code v2, "Non-linear
    // pilot phase"): the decoder's φ check reads it through this binding.
    g.phasesWide.forEach((ph, id) => assert.equal(staggerPhase(id, p), ph, `phasesWide[${id}]`));
    assert.deepEqual(syncColors(p), [...g.pilotColors].map((ch) => LETTER[ch]));
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

test("the palette pilot uses only the alphabet's colours; ids decode back through the pruned book", () => {
  for (const symbols of [2, 4] as const) {
    const st = book(300, symbols, SYNC_STAGGER_PILOT);
    const L = syncFrames(st);
    assert.equal(L, symbols === 2 ? 5 : 3);
    assert.ok(st.bits >= book(300, symbols, "on_off").bits, "a pruned book is at least as wide");
    for (const c of syncColors(st)) assert.ok(SYMBOL_COLORS[symbols]!.includes(c), "pilot colours are data colours");
    const C = st.cycleFrames;
    assert.equal(C, L + dataFrames(st));
    for (let id = 0; id < 300; id += 7) {
      const ph = staggerPhase(id, st);
      // In a block of C ids, the golden-ratio step; across blocks, the keyed offset.
      if (id % C !== 0) assert.equal(ph, (staggerPhase(id - 1, st) + staggerStep(C)) % C);
      const own: Rgb[] = [];
      for (let j = 0; j < C; j++) {
        const got = colorForFrame(id, (j + ph) % C, st);
        own.push(got);
        const want: Rgb = j < L ? syncColors(st)[j]! : SYMBOL_COLORS[symbols]![symbolAt(id, j - L, st)]!;
        assert.deepEqual(got, want, `id ${id} local ${j}`);
      }
      // The pilot occurs once in the LED's cycle: at its sync position.
      const pilot = syncColors(st);
      const hits = own.filter((_, o) => pilot.every((c, j) => own[(o + j) % C] === c)).length;
      assert.equal(hits, 1, `id ${id}`);
      const syms = Array.from({ length: dataFrames(st) }, (_, d) => symbolAt(id, d, st));
      assert.equal(decodeCycleSymbols(syms, st).id, id);
    }
  }
});

test("the comparators are v1 rotated over the v1 book", () => {
  for (const symbols of [2, 4] as const) {
    const v1 = book(300, symbols, "on_off");
    for (const [sync, p0, p1] of [
      [SYNC_STAGGER_WHITE, COLOR_WHITE, COLOR_GREEN],
      [SYNC_STAGGER_GM, COLOR_GREEN, COLOR_MAGENTA],
    ] as const) {
      const sw = withSyncPattern(v1, sync as CodeParams["syncPattern"]);
      assert.equal(sw.cycleFrames, v1.cycleFrames);
      const C = v1.cycleFrames;
      for (let id = 0; id < 300; id += 11) {
        const ph = staggerPhase(id, sw);
        for (let f = 0; f < C; f++) {
          const j = (f - ph + C) % C;
          const want = j === 0 ? p0 : j === 1 ? p1 : colorForFrame(id, j, v1);
          assert.deepEqual(colorForFrame(id, f, sw), want, `${sync} id ${id} f ${f}`);
        }
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

test("capture requests the staggered pilot by default from players that advertise it", () => {
  assert.equal(FEATURE_STAGGER_PILOT, "hue_stagger_pilot");
  assert.equal(requestedSyncPattern(null, ["effects", "hue_stagger_pilot"]), SYNC_STAGGER_PILOT);
  // Older firmware: no request, so it runs (and reports) v1.
  assert.equal(requestedSyncPattern(null, ["effects"]), null);
  assert.equal(requestedSyncPattern(null, undefined), null);
  // ?sync= debug override wins either way.
  assert.equal(requestedSyncPattern("on_off", ["hue_stagger_pilot"]), "on_off");
  assert.equal(requestedSyncPattern(SYNC_STAGGER_PILOT as never, []), SYNC_STAGGER_PILOT);
});
