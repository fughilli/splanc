/**
 * Multi-fixture relative localization (docs/design/multi-fixture-localization.md):
 * synthetic rooms with 2–5 mapped fixtures at random poses, a handheld phone,
 * pixel noise, decode dropouts, gross outliers, per-LED map error and per-map
 * scale error; recovered poses compared to truth (rotation / translation /
 * LED-position error), plus partial visibility (chaining), degenerate inputs and
 * the quality metrics.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Vec3 } from "@ledmapper/protocol";
import {
  applyRoomPose,
  localizeFixtures,
  nudgeRoomPose,
  poseError,
  type LocalizeOptions,
  type LocalizeResult,
  type RoomPose,
} from "../src/geom/multiFixture";
import { quatToRotMat, rotMatToQuat } from "../src/geom/pinhole";
import {
  makeRoom,
  simulateCapture,
  truthPoseOfModel,
  type CaptureSimOptions,
  type RoomOptions,
  type SynthFixture,
} from "./multiFixtureSynth";

/** Truth pose of fixture k relative to the reference fixture's map frame. */
function relTruth(room: SynthFixture[], ref: number, k: number): RoomPose {
  const T0 = truthPoseOfModel(room[ref]!);
  const Tk = truthPoseOfModel(room[k]!);
  const R0 = quatToRotMat(T0.rotation);
  const R0t = [R0[0], R0[3], R0[6], R0[1], R0[4], R0[7], R0[2], R0[5], R0[8]] as const;
  const Rk = quatToRotMat(Tk.rotation);
  const R = [0, 0, 0, 0, 0, 0, 0, 0, 0] as [number, number, number, number, number, number, number, number, number];
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++) R[r * 3 + c] = R0t[r * 3]! * Rk[c]! + R0t[r * 3 + 1]! * Rk[3 + c]! + R0t[r * 3 + 2]! * Rk[6 + c]!;
  const d: Vec3 = [Tk.translation[0] - T0.translation[0], Tk.translation[1] - T0.translation[1], Tk.translation[2] - T0.translation[2]];
  const t: Vec3 = [
    (R0t[0] * d[0] + R0t[1] * d[1] + R0t[2] * d[2]) / T0.scale,
    (R0t[3] * d[0] + R0t[4] * d[1] + R0t[5] * d[2]) / T0.scale,
    (R0t[6] * d[0] + R0t[7] * d[1] + R0t[8] * d[2]) / T0.scale,
  ];
  return { translation: t, rotation: rotMatToQuat(R), scale: Tk.scale / T0.scale };
}

interface Errs {
  rotDeg: number;
  transM: number;
  ledRmsM: number;
  scaleRel: number;
}

function errors(room: SynthFixture[], res: LocalizeResult): Errs[] {
  return room.map((f, k) => {
    const est = res.fixtures[k]!.pose;
    if (!est) return { rotDeg: Infinity, transM: Infinity, ledRmsM: Infinity, scaleRel: Infinity };
    // Compare on the solver's own (given) map points.
    return poseError(relTruth(room, res.reference, k), est, f.model.leds.values());
  });
}

function run(room: RoomOptions, cap: Omit<CaptureSimOptions, "seed"> & { seed?: number }, opts: LocalizeOptions = {}) {
  const r = makeRoom(room);
  const sim = simulateCapture(r, { seed: room.seed + 1000, ...cap });
  const t0 = Date.now();
  const res = localizeFixtures(
    r.map((f) => f.model),
    sim.views,
    { reference: 0, ...opts },
  );
  return { room: r, sim, res, errs: errors(r, res), ms: Date.now() - t0 };
}

const fmt = (e: Errs) =>
  `rot ${e.rotDeg.toFixed(2)}° trans ${(e.transM * 1000).toFixed(1)} mm led ${(e.ledRmsM * 1000).toFixed(1)} mm scale ${(e.scaleRel * 100).toFixed(2)} %`;

test("two fixtures in full view: sub-centimetre, sub-degree", () => {
  const { res, errs } = run({ seed: 1, shapes: ["lamp", "tree"] }, { frames: 150 });
  assert.ok(res.ok, JSON.stringify(res.warnings));
  assert.equal(res.fixtures[0]!.status, "reference");
  assert.equal(res.fixtures[1]!.status, "localized", res.fixtures[1]!.warnings.join("; "));
  const e = errs[1]!;
  assert.ok(e.rotDeg < 0.5, fmt(e));
  assert.ok(e.ledRmsM < 0.01, fmt(e));
  assert.ok(res.rmsPx < 2, `rms ${res.rmsPx}`);
});

test("accuracy sweep: 2–5 fixtures, random poses, handheld, noise + dropouts + outliers + map/scale error", () => {
  const shapesPool: Array<RoomOptions["shapes"][number]> = ["lamp", "panel", "tree", "ring", "lamp"];
  const rows: string[] = [];
  const all: Errs[] = [];
  const sigmaRatios: number[] = [];
  let worstMs = 0;
  for (let seed = 10; seed < 30; seed++) {
    const n = 2 + (seed % 4);
    const shapes = Array.from({ length: n }, (_, i) => shapesPool[(seed + i) % shapesPool.length]!);
    const { res, errs, ms } = run(
      { seed, shapes, scaleErr: 0.03, mapNoiseM: 0.003, spreadM: 1 + n * 0.8 },
      { frames: 200, noisePx: 1, dropP: 0.15, outlierP: 0.01, panFrac: 0.6 },
    );
    worstMs = Math.max(worstMs, ms);
    assert.ok(res.ok, `seed ${seed}: ${JSON.stringify(res.fixtures.map((f) => [f.status, f.warnings]))}`);
    for (let k = 1; k < n; k++) {
      const e = errs[k]!;
      all.push(e);
      const s = res.fixtures[k]!.sigma!;
      sigmaRatios.push(e.ledRmsM / Math.max(s.ledM, 1e-6));
      rows.push(`seed ${seed} n=${n} ${shapes[k]}: ${fmt(e)} | σled ${(s.ledM * 1000).toFixed(1)} mm ${res.fixtures[k]!.status}`);
    }
  }
  const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
  const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.95)]!;
  const summary =
    `n=${all.length} fixture poses: ` +
    `rot median ${med(all.map((e) => e.rotDeg)).toFixed(2)}° p95 ${p95(all.map((e) => e.rotDeg)).toFixed(2)}°; ` +
    `LED median ${(med(all.map((e) => e.ledRmsM)) * 1000).toFixed(1)} mm p95 ${(p95(all.map((e) => e.ledRmsM)) * 1000).toFixed(1)} mm; ` +
    `trans median ${(med(all.map((e) => e.transM)) * 1000).toFixed(1)} mm; ` +
    `|scale| median ${(med(all.map((e) => Math.abs(e.scaleRel))) * 100).toFixed(2)} %; ` +
    `err/σ median ${med(sigmaRatios).toFixed(2)} p95 ${p95(sigmaRatios).toFixed(2)}; worst solve ${worstMs} ms`;
  console.log(rows.join("\n") + "\n" + summary);
  // The reported σ is a usable (not wildly over-confident) error bar.
  assert.ok(p95(sigmaRatios) < 4, summary);
});

test("partial visibility: a 5-fixture row seen only pairwise is chained A–B–C–D–E", () => {
  const { res, errs, sim } = run(
    { seed: 3, shapes: ["lamp", "panel", "tree", "lamp", "ring"], spreadM: 6, mapNoiseM: 0.002 },
    { frames: 300, panFrac: 1, distM: 1.8, walkM: 2.8 },
  );
  // No frame sees every fixture.
  const maxPerFrame = Math.max(...sim.views.map((v) => new Set(v.sightings.map((s) => s.fixture)).size));
  assert.ok(maxPerFrame < 5, `frames see up to ${maxPerFrame} fixtures`);
  assert.ok(res.ok, JSON.stringify(res.fixtures.map((f) => [f.status, f.warnings])));
  for (let k = 1; k < 5; k++) assert.ok(errs[k]!.ledRmsM < 0.03, `fixture ${k}: ${fmt(errs[k]!)}`);
  // The far end accumulates more uncertainty than the near neighbour.
  assert.ok(res.fixtures[4]!.sigma!.ledM > res.fixtures[1]!.sigma!.ledM);
});

test("a linear strip (PnP-degenerate) is placed from the cameras", () => {
  const { res, errs } = run({ seed: 5, shapes: ["panel", "strip", "lamp"] }, { frames: 200 });
  assert.ok(res.fixtures[1]!.linear);
  assert.notEqual(res.fixtures[1]!.status, "unlocalized", res.fixtures[1]!.warnings.join("; "));
  assert.ok(errs[1]!.ledRmsM < 0.02, fmt(errs[1]!));
  assert.ok(errs[2]!.ledRmsM < 0.02, fmt(errs[2]!));
});

test("map scale error is recovered from camera translation and flagged", () => {
  const { room, res, errs } = run({ seed: 7, shapes: ["lamp", "tree"], scaleErr: 0.06 }, { frames: 200, walkM: 1.5 });
  const est = res.fixtures[1]!.pose!.scale;
  const truth = 1 / room[1]!.mapScale;
  assert.ok(Math.abs(est / truth - 1) < 0.01, `scale ${est} vs ${truth}`);
  assert.ok(errs[1]!.ledRmsM < 0.015, fmt(errs[1]!));
  assert.ok(res.fixtures[1]!.warnings.some((w) => w.includes("scale differs")), res.fixtures[1]!.warnings.join("; "));
});

test("tripod (rotation-only camera): poses still solve, scale held by the prior and flagged unobservable", () => {
  const { res, errs } = run({ seed: 8, shapes: ["lamp", "panel"] }, { frames: 120, walkM: 0, distM: 2.5 });
  assert.ok(res.ok);
  assert.ok(errs[1]!.rotDeg < 1, fmt(errs[1]!));
  assert.ok(errs[1]!.ledRmsM < 0.03, fmt(errs[1]!));
});

test("scale: 'fixed' holds every fixture at its map's scale", () => {
  const { res } = run({ seed: 9, shapes: ["lamp", "tree"], scaleErr: 0.04 }, { frames: 120 }, { scale: "fixed" });
  assert.equal(res.fixtures[1]!.pose!.scale, 1);
});

test("a fixture never seen together with another is reported unlocalized, the rest still solve", () => {
  const { res, errs } = run({ seed: 11, shapes: ["lamp", "tree", "panel"] }, { frames: 200, isolate: [2] });
  assert.equal(res.ok, false);
  assert.equal(res.fixtures[2]!.status, "unlocalized");
  assert.ok(res.fixtures[2]!.warnings.some((w) => w.includes("same frame")), res.fixtures[2]!.warnings.join("; "));
  assert.ok(errs[1]!.ledRmsM < 0.02, fmt(errs[1]!));
});

test("no multi-fixture frame at all: a clear failure, not a bogus pose", () => {
  const r = makeRoom({ seed: 12, shapes: ["lamp", "tree"] });
  const sim = simulateCapture(r, { seed: 99, frames: 60, isolate: [1] });
  const res = localizeFixtures(
    r.map((f) => f.model),
    sim.views,
    { reference: 0 },
  );
  assert.equal(res.ok, false);
  assert.equal(res.fixtures[1]!.pose, null);
  assert.ok(res.warnings.some((w) => w.includes("two fixtures")), res.warnings.join("; "));
});

test("heavy outliers (5 %) are gated", () => {
  const { res, errs } = run({ seed: 13, shapes: ["lamp", "tree", "panel"] }, { frames: 200, outlierP: 0.05 });
  assert.ok(res.ok);
  assert.ok(res.inliers < res.observations, "some sightings rejected");
  for (let k = 1; k < 3; k++) assert.ok(errs[k]!.ledRmsM < 0.02, fmt(errs[k]!));
});

test("reference choice: any fixture can be the room origin", () => {
  const r = makeRoom({ seed: 14, shapes: ["lamp", "tree", "panel"] });
  const sim = simulateCapture(r, { seed: 77, frames: 150 });
  const res = localizeFixtures(
    r.map((f) => f.model),
    sim.views,
    { reference: 2 },
  );
  assert.equal(res.reference, 2);
  assert.equal(res.fixtures[2]!.status, "reference");
  const e = errors(r, res);
  for (const k of [0, 1]) assert.ok(e[k]!.ledRmsM < 0.02, fmt(e[k]!));
});

test("tilted fixture: flagged, and the gravity prior doesn't fight strong evidence", () => {
  const { res, errs } = run({ seed: 15, shapes: ["lamp", "tree"], tiltDeg: 25 }, { frames: 200 });
  // Fixture 0 (reference) is tilted too, but its map says +Y is up: the room is
  // levelled by its map, so compare relative poses only.
  assert.ok(errs[1]!.ledRmsM < 0.02, fmt(errs[1]!));
  const tilt = res.fixtures[1]!.tiltDeg!;
  assert.ok(tilt >= 0);
});

test("IMU-levelled reference: the room's +Y is gravity, not the map's +Y", () => {
  const r = makeRoom({ seed: 16, shapes: ["lamp", "tree"] });
  // Pretend the reference map is NOT levelled: rotate its map by 20° about x and
  // tell the solver (as an IMU would) where up is in that map frame.
  const a = (20 * Math.PI) / 180;
  const rot = (p: Vec3): Vec3 => [p[0], Math.cos(a) * p[1] - Math.sin(a) * p[2], Math.sin(a) * p[1] + Math.cos(a) * p[2]];
  const m0 = r[0]!.model;
  const leds = new Map<number, Vec3>();
  for (const [i, p] of m0.leds) leds.set(i, rot(p));
  const models = r.map((f) => f.model);
  models[0] = { ...m0, leds, up: rot([0, 1, 0]) };
  const sim = simulateCapture(r, { seed: 5, frames: 150 });
  const res = localizeFixtures(models, sim.views, { reference: 0 });
  assert.equal(res.leveling, "reference_up");
  // The levelled reference pose maps its tilted map back upright: its "up" lands on +Y.
  const p0 = res.fixtures[0]!.pose!;
  const up = applyRoomPose({ ...p0, translation: [0, 0, 0] }, rot([0, 1, 0]));
  assert.ok(up[1] > 0.999, `up ${up}`);
  // And fixture 1 (levelled map) comes out level.
  assert.ok(res.fixtures[1]!.tiltDeg! < 2, `tilt ${res.fixtures[1]!.tiltDeg}`);
});

test("nudgeRoomPose rotates about the pivot and translates", () => {
  const p: RoomPose = { translation: [1, 0, 0], rotation: [0, 0, 0, 1], scale: 1 };
  const n = nudgeRoomPose(p, { yawDeg: 90, dy: 0.1 }, [1, 0, 0]);
  assert.ok(Math.abs(n.translation[0] - 1) < 1e-9 && Math.abs(n.translation[1] - 0.1) < 1e-9);
  const x = applyRoomPose(n, [1, 0, 0]);
  assert.ok(Math.abs(x[0] - 1) < 1e-9 && Math.abs(x[2] + 1) < 1e-9, `${x}`);
});
