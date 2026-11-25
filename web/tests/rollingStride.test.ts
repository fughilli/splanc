/**
 * Rolling stride (docs/design/rolling-stride.md) on the phone side:
 *
 *   - the wasm binding renders the kernel's golden (firmware/pattern/testdata/
 *     golden_stride_rolling.json) frame for frame, so the phone and the lamp
 *     agree on which LEDs are lit at every pattern-clock frame;
 *   - the request/echo helpers (feature-gated, `?stride=` override, the
 *     reply's strideMode is what counts);
 *   - the link simulator (tests/linkSim.ts) through the PRODUCTION decoder:
 *     rolling keeps decoding through the whole capture with no stride
 *     reconfigures, where the phased schedule's global steps leave dead
 *     seconds; and D = 4 out-yields D = 3. The table printed here is the one
 *     in the design doc.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import type { CodeParams } from "@ledmapper/protocol";
import { codeBookFor, SYNC_STAGGER_PILOT } from "../src/code/gray";
import {
  FEATURE_STRIDE_ROLLING,
  forcedStrideMode,
  isRollingStride,
  requestedStrideMode,
  ROLLING_DWELL_CYCLES,
  rollingDwell,
  rollingGeometry,
  rollingPeriodFrames,
  strideLitRolling,
} from "../src/code/stride";
import { stageLitRolling } from "../src/capture/channelCapture";
import { linkReport } from "../src/cv/linkReport";
import { BASELINE_POLICY, type LinkPolicy, runLinkSim, standardScenarios } from "./linkSim";

interface RollingCase {
  ledCount: number;
  spacing: number;
  anchorDensity: number;
  dwellCycles: number;
  codeOffset: number;
  codeSpace: number;
  symbols: 2 | 4;
  syncPattern: string;
  bits: number;
  cycleFrames: number;
  periodFrames: number;
  frames: string[];
}

function golden(): { cases: RollingCase[] } {
  const name = "golden_stride_rolling.json";
  const rel = `firmware/pattern/testdata/${name}`;
  const candidates = [
    resolve(__dirname, "../../kernel_goldens", name),
    resolve("web/kernel_goldens", name),
    resolve(__dirname, "../../..", rel),
    resolve(rel),
  ];
  const hit = candidates.find((p) => existsSync(p));
  assert.ok(hit, `golden ${rel} not found (${candidates.join(", ")})`);
  return JSON.parse(readFileSync(hit, "utf8")) as { cases: RollingCase[] };
}

function params(c: { codeSpace: number; symbols: 2 | 4; syncPattern: string }, extra: Partial<CodeParams> = {}): CodeParams {
  const b = codeBookFor(c.codeSpace, c.symbols, "secded", c.syncPattern);
  return {
    ledCount: c.codeSpace,
    bits: b.bits,
    encoding: "hue",
    symbols: c.symbols,
    bitPeriodMs: 40,
    syncPattern: c.syncPattern as CodeParams["syncPattern"],
    cycleFrames: b.cycleFrames,
    fec: "secded",
    ...extra,
  };
}

test("the wasm binding renders the kernel's rolling-stride golden", () => {
  const g = golden();
  assert.ok(g.cases.length >= 3);
  for (const c of g.cases) {
    const p = params(c, {
      strideSpacing: c.spacing,
      anchorDensity: c.anchorDensity,
      strideMode: "rolling",
      dwellCycles: c.dwellCycles,
      ...(c.codeOffset > 0 ? { codeOffset: c.codeOffset } : {}),
    });
    assert.equal(p.cycleFrames, c.cycleFrames);
    assert.equal(p.bits, c.bits);
    const geom = rollingGeometry(p, c.ledCount)!;
    assert.ok(geom !== null);
    assert.equal(rollingPeriodFrames(p, geom), c.periodFrames);
    c.frames.forEach((row, seq) => {
      let got = "";
      for (let x = 0; x < c.ledCount; x++) got += strideLitRolling(x, seq, p, geom) ? "#" : ".";
      assert.equal(got, row, `S=${c.spacing} D=${c.dwellCycles} frame ${seq}`);
    });
  }
});

test("rolling is requested only from players that advertise it, and only the reply counts", () => {
  assert.equal(FEATURE_STRIDE_ROLLING, "stride_rolling");
  assert.deepEqual(requestedStrideMode(null, ["effects", "stride_rolling"]), {
    strideMode: "rolling",
    dwellCycles: ROLLING_DWELL_CYCLES,
  });
  assert.equal(requestedStrideMode(null, ["effects"]), null, "older firmware: nothing asked, phased runs");
  assert.equal(requestedStrideMode(null, undefined), null);
  assert.deepEqual(requestedStrideMode("phased", ["stride_rolling"]), { strideMode: "phased" });
  assert.equal(forcedStrideMode("phased"), "phased");
  assert.equal(forcedStrideMode("rolling"), "rolling");
  assert.equal(forcedStrideMode("bogus"), null);
  assert.equal(forcedStrideMode(null), null);
  const base = params({ codeSpace: 60, symbols: 4, syncPattern: SYNC_STAGGER_PILOT });
  assert.equal(isRollingStride(base), false);
  assert.equal(isRollingStride({ ...base, strideSpacing: 3 }), false, "a phased reply (no strideMode)");
  assert.equal(isRollingStride({ ...base, strideSpacing: 3, strideMode: "rolling" }), true);
  assert.equal(isRollingStride({ ...base, strideSpacing: 1, strideMode: "rolling" }), false, "striding off");
  assert.equal(rollingDwell(0), 3);
  assert.equal(rollingDwell(4), 4);
});

test("a rolling per-channel stage masks like the kernel, then by the stage's LED count", () => {
  const p = params(
    { codeSpace: 60, symbols: 4, syncPattern: SYNC_STAGGER_PILOT },
    { strideSpacing: 3, anchorDensity: 3, strideMode: "rolling", dwellCycles: 4 },
  );
  const stage = { kind: "strided" as const, ledCount: 50, strideSpacing: 3, channels: [1] };
  for (let seq = 0; seq < 300; seq += 7) {
    for (let id = 0; id < 60; id++) {
      const want = id < 50 && strideLitRolling(id, seq, p, { spacing: 3, anchorDensity: 3, dwellCycles: 4, ledCount: 50 });
      assert.equal(stageLitRolling(id, stage, seq, p, 3, 4), want, `id ${id} seq ${seq}`);
    }
  }
});

// --- link sim: phased vs rolling through the production decoder ------------

const STRIDE = 3;
const POLICIES: LinkPolicy[] = [
  {
    ...BASELINE_POLICY,
    name: "phased",
    symbolRule: "measured",
    sync: SYNC_STAGGER_PILOT,
    stride: { mode: "phased", spacing: STRIDE, anchorDensity: 3 },
  },
  {
    ...BASELINE_POLICY,
    name: "rolling D=3",
    symbolRule: "measured",
    sync: SYNC_STAGGER_PILOT,
    stride: { mode: "rolling", spacing: STRIDE, anchorDensity: 3, dwellCycles: 3 },
  },
  {
    ...BASELINE_POLICY,
    name: "rolling D=4",
    symbolRule: "measured",
    sync: SYNC_STAGGER_PILOT,
    stride: { mode: "rolling", spacing: STRIDE, anchorDensity: 3, dwellCycles: 4 },
  },
];
const SCENES = ["hold-lit", "orbit-lit", "orbit-dark"];
const WARMUP_S = 5;

test("link sim: rolling stride decodes at every moment, phased leaves dead seconds", () => {
  const ms = (x: number | null): string => (x === null ? "never" : `${(x / 1000).toFixed(1)} s`);
  console.log(
    "| scene | schedule | records | wrong ids | t90 | min records/s | dead seconds | stride configures | coverage |",
  );
  console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  const rows: { scene: string; pol: string; records: number; minRps: number; dead: number; cov: number; conf: number }[] = [];
  for (const name of SCENES) {
    const sc = { ...standardScenarios(120).find((s) => s.name === name)!, durationMs: 45_000, latencyMs: 140, seed: 3 };
    for (const pol of POLICIES) {
      const res = runLinkSim(sc, pol);
      const r = linkReport(res.telemetry, { name: pol.name, coverageOf: res.visibleIds });
      const steady = res.recordsPerS.slice(WARMUP_S, -1);
      const minRps = Math.min(...steady);
      const dead = steady.filter((x) => x === 0).length;
      const t90 = r.timeToCoverage.find((c) => Math.abs(c.frac - 0.9) < 1e-9)?.tMs ?? null;
      console.log(
        `| ${name} | ${pol.name} | ${r.records} | ${r.truth!.wrong} | ${ms(t90)} | ${minRps} | ${dead} | ` +
          `${res.strideConfigures} | ${(100 * r.finalCoverage).toFixed(1)}% |`,
      );
      rows.push({ scene: name, pol: pol.name, records: r.records, minRps, dead, cov: r.finalCoverage, conf: res.strideConfigures });
      assert.ok(r.truth!.wrong <= Math.max(2, 0.01 * r.records), `${name} ${pol.name}: wrong ids ${r.truth!.wrong}`);
    }
  }
  for (const name of SCENES) {
    const get = (p: string) => rows.find((x) => x.scene === name && x.pol === p)!;
    const [phased, d3, d4] = [get("phased"), get("rolling D=3"), get("rolling D=4")];
    // Rolling never reconfigures to stride; phased does, every few seconds.
    assert.equal(d4.conf, 0);
    assert.equal(d3.conf, 0);
    assert.ok(phased.conf > 0);
    // Rolling D = 4 decodes in every steady second of a lit scene (the dark
    // orbit loses a few to the occluded side at low frame rate), far fewer dead
    // seconds than the phased steps anywhere, more records, at least the coverage.
    if (name.endsWith("-lit")) {
      assert.equal(d4.dead, 0, `${name}: rolling D=4 had ${d4.dead} seconds without a record`);
      assert.ok(d4.minRps > 0);
    }
    assert.ok(3 * d4.dead <= phased.dead, `${name}: dead seconds rolling ${d4.dead} vs phased ${phased.dead}`);
    assert.ok(d4.records >= phased.records, `${name}: records rolling ${d4.records} vs phased ${phased.records}`);
    assert.ok(d4.cov >= phased.cov - 0.05, `${name}: rolling coverage ${d4.cov} vs phased ${phased.cov}`);
    // D = 4 out-yields D = 3 (three whole own cycles per dwell, not two).
    assert.ok(d4.records >= d3.records, `${name}: D=4 ${d4.records} vs D=3 ${d3.records} records`);
  }
});
