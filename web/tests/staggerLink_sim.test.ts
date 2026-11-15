/**
 * Hue code v2 phase 2: the link-sim comparison the design asks for before the
 * decoder ships (docs/design/hue-code-v2.md, "Pilot vs white"). The same
 * seeded moving-camera scenes (tests/linkSim.ts: dark room, heavy veil, lit,
 * an ambient ramp that drives the exposure servo) are run three ways — v1
 * "on_off", the staggered green/magenta pilot ("stagger_pilot", the wire
 * value) and a staggered white/green delimiter ("stagger_white", sim-only) —
 * through the production pipeline and negotiation, plus the first draft's
 * green -> magenta pilot ("stagger_gm", a reserved hue; sim-only). Every record is checked
 * against the truth, so hops and false delimiters that get through show up as
 * wrong ids. The table printed here is the one in the design doc.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { SYNC_STAGGER_GM, SYNC_STAGGER_PILOT, SYNC_STAGGER_WHITE } from "../src/code/gray";
import { linkReport, type LinkReport } from "../src/cv/linkReport";
import { BASELINE_POLICY, type LinkPolicy, runLinkSim, standardScenarios } from "./linkSim";

const POLICIES: LinkPolicy[] = [
  { ...BASELINE_POLICY, name: "v1 on_off", symbolRule: "measured" },
  { ...BASELINE_POLICY, name: "stagger pilot", symbolRule: "measured", sync: SYNC_STAGGER_PILOT },
  { ...BASELINE_POLICY, name: "stagger white", symbolRule: "measured", sync: SYNC_STAGGER_WHITE },
  { ...BASELINE_POLICY, name: "stagger green/magenta", symbolRule: "measured", sync: SYNC_STAGGER_GM },
];

const SCENES = ["hold-dark", "orbit-dark", "orbit-lit", "bright-veil", "ambient-ramp"];

interface Row {
  scene: string;
  policy: string;
  r: LinkReport;
  misses: number;
  phaseRejects: number;
  pilots: number;
}

function runAll(): Row[] {
  const rows: Row[] = [];
  for (const name of SCENES) {
    const sc = { ...standardScenarios(120).find((s) => s.name === name)!, durationMs: 30_000, latencyMs: 140, seed: 3 };
    for (const pol of POLICIES) {
      const res = runLinkSim(sc, pol);
      const r = linkReport(res.telemetry, { name: pol.name, coverageOf: res.visibleIds });
      const d = res.telemetry.decode;
      rows.push({ scene: name, policy: pol.name, r, misses: d.delimiterMisses, phaseRejects: d.phaseRejects, pilots: d.pilotCycles });
    }
  }
  return rows;
}

const ms = (x: number | null): string => (x === null ? "never" : `${(x / 1000).toFixed(1)} s`);

test("link sim: staggered pilot vs staggered white vs v1 (records, wrong ids, false delimiters, servo)", () => {
  const rows = runAll();
  console.log("| scene | sync | records | wrong ids | t90 | φ-rejects | delimiter misses | exposure median/max |");
  console.log("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const x of rows) {
    const t90 = x.r.timeToCoverage.find((c) => Math.abs(c.frac - 0.9) < 1e-9)?.tMs ?? null;
    const e = x.r.exposure;
    console.log(
      `| ${x.scene} | ${x.policy} | ${x.r.records} | ${x.r.truth!.wrong} | ${ms(t90)} | ${x.phaseRejects} | ${x.misses} | ` +
        `${e.median?.toFixed(2) ?? "–"}/${e.max?.toFixed(2) ?? "–"} |`,
    );
  }
  for (const scene of SCENES) {
    const [v1, pilot, white, gm] = POLICIES.map((p) => rows.find((x) => x.scene === scene && x.policy === p.name)!);
    // The pilot never lands more wrong ids than v1, and keeps the yield.
    assert.ok(pilot!.r.truth!.wrong <= Math.max(v1!.r.truth!.wrong, 0), `${scene}: pilot wrong ${pilot!.r.truth!.wrong}`);
    assert.ok(pilot!.r.records >= 0.8 * v1!.r.records, `${scene}: pilot records ${pilot!.r.records} vs v1 ${v1!.r.records}`);
    assert.ok(pilot!.r.finalCoverage >= v1!.r.finalCoverage - 0.05, `${scene}: coverage`);
    assert.ok(white !== undefined && gm !== undefined);
  }
});
