/**
 * P4 demo page: the flashlight mode (a port of the desktop demo's flashlight.py) and
 * grabbing the demo's objects with the stylus button.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { initialState, oscFor, syncStreamer, effectFor, EFFECT_IDS } from "../src/p4demo/demo";
import { quatFromAxisAngle, quatToMat, mulMV, type Pose } from "../src/p4demo/frames";
import {
  beamColor,
  beamFromStylus,
  DECAY_OFF,
  decaySent,
  hsvToRgb,
  initialBeam,
  nextRollMode,
  ROLL_MODES,
  SEQ_WRAP,
  STALE_S,
  twistAbout,
  WIDTH_MAX,
  type RollMode,
} from "../src/p4demo/flashlight";
import { beginGrab, ClickOrHold, GRAB_REACH, HOLD_MS, moveGrab, reachable } from "../src/p4demo/grab";
import { createMockTracking, MOCK_SERIAL } from "../src/p4demo/lh/mock";
import type { Vec3 } from "../src/p4demo/lh/types";

const near = (a: number, b: number, eps = 1e-9): void => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
const nearV = (a: readonly number[], b: readonly number[], eps = 1e-9): void => a.forEach((x, i) => near(x, b[i]!, eps));
const poseOf = (axis: Vec3, angle: number, t: Vec3): Pose => ({ R: quatToMat(quatFromAxisAngle(axis, angle)), t });
const TIP: Vec3 = [0, 0, 0.18];

// ------------------------------------------------------------------ flashlight

test("flashlight: the beam leaves the tip along the stylus axis", () => {
  const b = initialBeam();
  const P = poseOf([1, 0, 0], Math.PI / 2, [1, 2, 3]); // stylus +Z -> world -Y
  beamFromStylus(b, null, P, TIP);
  nearV(b.origin, [1, 2 - 0.18, 3]);
  nearV(b.dir, [0, -1, 0]);
  assert.equal(b.ok, true);
  assert.equal(b.seq, 1);
});

test("flashlight: without a tip calibration the beam leaves the tracker along its +Z", () => {
  const b = initialBeam();
  beamFromStylus(b, null, poseOf([0, 0, 1], 0.3, [0.5, 0, 1]), null);
  nearV(b.origin, [0.5, 0, 1]);
  nearV(b.dir, [0, 0, 1]);
});

test("flashlight: only the roll about the stylus axis adjusts; pointing changes nothing", () => {
  const b = initialBeam();
  b.roll = "color";
  const hue0 = b.hue;
  let prev = beamFromStylus(b, null, poseOf([0, 0, 1], 0, [0, 0, 1]), TIP);
  // A quarter turn about the axis: a quarter of the hue wheel.
  prev = beamFromStylus(b, prev, poseOf([0, 0, 1], Math.PI / 2, [0, 0, 1]), TIP);
  near(b.hue, hue0 + 0.25);
  // Tilting (about an axis perpendicular to the stylus) and moving: no change.
  const tilted: Pose = { R: quatToMat(quatFromAxisAngle([0, 0, 1], Math.PI / 2)), t: [0.3, 0.1, 1.2] };
  prev = beamFromStylus(b, prev, tilted, TIP);
  const swing = quatToMat(quatFromAxisAngle(mulMV(tilted.R, [1, 0, 0]), 0.5));
  const R2 = quatToMat(quatFromAxisAngle([0, 0, 1], Math.PI / 2));
  const swung: Pose = {
    R: [0, 1, 2].flatMap((i) => [0, 1, 2].map((j) => swing[i * 3]! * R2[j]! + swing[i * 3 + 1]! * R2[3 + j]! + swing[i * 3 + 2]! * R2[6 + j]!)) as Pose["R"],
    t: [0, 0, 1],
  };
  beamFromStylus(b, prev, swung, TIP);
  near(b.hue, hue0 + 0.25, 1e-6);
});

test("flashlight: each roll mode's setting, its limits, and no roll across a gap", () => {
  const turn = (mode: RollMode, angle: number, start?: (b: ReturnType<typeof initialBeam>) => void) => {
    const b = initialBeam();
    b.roll = mode;
    start?.(b);
    const prev = beamFromStylus(b, null, poseOf([0, 0, 1], 0, [0, 0, 1]), TIP);
    beamFromStylus(b, prev, poseOf([0, 0, 1], angle, [0, 0, 1]), TIP);
    return b;
  };
  near(turn("saturation", -Math.PI).sat, 0.5); // half a turn back: half the range
  near(turn("width", Math.PI).width, initialBeam().width * Math.sqrt(3)); // x3 per turn
  near(turn("width", Math.PI, (b) => (b.width = WIDTH_MAX)).width, WIDTH_MAX);
  near(turn("persistence", Math.PI).decay, DECAY_OFF * Math.sqrt(3));
  near(turn("persistence", -Math.PI).decay, DECAY_OFF); // the short end
  const fixed = turn("fixed", 1);
  assert.deepEqual([fixed.hue, fixed.sat, fixed.width, fixed.decay], [initialBeam().hue, 1, initialBeam().width, DECAY_OFF]);
  // After a gap (prevR null) the new pose is only a baseline.
  const b = initialBeam();
  beamFromStylus(b, null, poseOf([0, 0, 1], 0, [0, 0, 1]), TIP);
  beamFromStylus(b, null, poseOf([0, 0, 1], 2, [0, 0, 1]), TIP);
  near(b.hue, initialBeam().hue);
});

test("flashlight: twist angle, the heartbeat's wrap, colour and the trail's off end", () => {
  near(twistAbout(quatToMat(quatFromAxisAngle([0, 0, 1], -1.2)), [0, 0, 1]), -1.2);
  near(twistAbout(quatToMat(quatFromAxisAngle([1, 0, 0], 0.7)), [0, 0, 1]), 0);
  const b = initialBeam();
  b.seq = SEQ_WRAP;
  beamFromStylus(b, null, poseOf([0, 0, 1], 0, [0, 0, 0]), TIP);
  assert.equal(b.seq, 1); // never the effect's initial 0
  nearV(hsvToRgb(0, 1, 1), [1, 0, 0]);
  nearV(hsvToRgb(1 / 3, 1, 1), [0, 1, 0]);
  nearV(hsvToRgb(0.5, 0, 1), [1, 1, 1]);
  assert.equal(decaySent(b), 0);
  b.decay = 2;
  assert.equal(decaySent(b), 2);
  let m: RollMode = "color";
  const seen: RollMode[] = [];
  for (let i = 0; i < ROLL_MODES.length; i++) seen.push((m = nextRollMode(m)));
  assert.deepEqual(seen, ["saturation", "width", "persistence", "fixed", "color"]);
});

test("flashlight mode: its own effect, and exactly flashlight_pose's OSC addresses", () => {
  const s = initialState();
  s.mode = "flashlight";
  assert.equal(effectFor(s.mode), "flashlight");
  assert.equal(EFFECT_IDS.flashlight, "p4demo-flashlight");
  beamFromStylus(s.beam, null, poseOf([1, 0, 0], Math.PI, [0, 0, 1]), TIP);
  const osc = oscFor(s);
  assert.deepEqual([...osc.keys()].sort(), ["/color", "/decay", "/dir", "/origin", "/stale_after", "/stylus_ok", "/stylus_seq", "/width"]);
  nearV(osc.get("/origin")!.values, [0, 0, 1 - 0.18]);
  nearV(osc.get("/dir")!.values, [0, 0, -1]);
  assert.deepEqual(osc.get("/stylus_ok")!.values, [1]);
  assert.deepEqual(osc.get("/stylus_seq")!.values, [1]);
  assert.deepEqual(osc.get("/stale_after")!.values, [STALE_S]);
  assert.deepEqual(osc.get("/color")!.values, beamColor(s.beam));
  near(osc.get("/width")!.values[0]!, s.beam.width);
  s.beam.ok = false; // stale stylus: the beam is told off
  assert.deepEqual(oscFor(s).get("/stylus_ok")!.values, [0]);

  // Leaving the mode clears the beam's addresses from the streamer.
  const held = new Map<string, number[]>();
  const st = { set: (a: string, v: number[]) => void held.set(a, v), clear: (...a: string[]) => a.forEach((x) => held.delete(x)), has: (a: string) => held.has(a) };
  syncStreamer(st, s);
  s.mode = "plane";
  syncStreamer(st, s);
  for (const a of ["/origin", "/dir", "/color", "/decay", "/stylus_ok", "/stylus_seq", "/stale_after"]) assert.ok(!held.has(a), a);
  assert.ok(held.has("/plane") && held.has("/width"));
});

// ------------------------------------------------------------------ grab

test("grab: what the tip can reach in each mode", () => {
  const s = initialState();
  s.plane = { n: [0, 0, 1], d: 1 };
  assert.deepEqual(reachable(s, [5, 5, 1 + GRAB_REACH / 2])?.target, { kind: "plane" });
  assert.equal(reachable(s, [0, 0, 1 + GRAB_REACH * 2]), null);
  s.mode = "sphere";
  s.sphere = { c: [0, 0, 1], r: 0.2 };
  s.radius = 0.2;
  assert.deepEqual(reachable(s, [0, 0, 1])?.target, { kind: "sphere" }); // inside
  assert.deepEqual(reachable(s, [0.2 + GRAB_REACH / 2, 0, 1])?.target, { kind: "sphere" });
  assert.equal(reachable(s, [0.2 + GRAB_REACH * 2, 0, 1]), null);
  s.mode = "spots";
  assert.equal(reachable(s, [0, 0, 1]), null); // none placed
  s.spots[1]!.pos = [0, 0, 1];
  s.spots[2]!.pos = [0.05, 0, 1];
  assert.deepEqual(reachable(s, [0.04, 0, 1])?.target, { kind: "spot", index: 2 }); // the nearest
  s.mode = "outline";
  assert.equal(reachable(s, [0, 0, 1]), null);
});

test("grab: a carried plane moves and turns rigidly with the stylus", () => {
  const s = initialState();
  s.follow = false;
  s.plane = { n: [0, 0, 1], d: 1 };
  const P0 = poseOf([0, 0, 1], 0, [0.2, 0.1, 1.05]);
  const g = beginGrab(s, P0, [0.2, 0.1, 1.05]);
  assert.ok(g && g.target.kind === "plane");
  moveGrab(s, g, P0);
  nearV(s.plane.n, [0, 0, 1]);
  near(s.plane.d, 1); // unchanged while the stylus hasn't moved
  moveGrab(s, g, { R: P0.R, t: [0.2, 0.1, 1.35] }); // up 30 cm
  near(s.plane.d, 1.3);
  // Turn the stylus 90 degrees about X where it is: the normal turns with it, and the
  // plane keeps passing through the carried anchor point.
  const P1 = poseOf([1, 0, 0], Math.PI / 2, P0.t);
  moveGrab(s, g, P1);
  nearV(s.plane.n, [0, -1, 0]);
  const anchor: Vec3 = [0.2, 0.1 + 0.05, 1.05]; // (0, 0, -0.05) in the stylus frame, turned
  near(s.plane.n[0] * anchor[0] + s.plane.n[1] * anchor[1] + s.plane.n[2] * anchor[2], s.plane.d);
});

test("grab: a sphere and a spot keep their offset from the stylus; out of reach grabs nothing", () => {
  const s = initialState();
  s.mode = "sphere";
  s.radius = 0.1;
  s.sphere = { c: [0, 0, 1], r: 0.1 };
  const P0 = poseOf([0, 0, 1], 0, [0.15, 0, 1]);
  assert.equal(beginGrab(s, P0, [1, 1, 1]), null);
  const g = beginGrab(s, P0, [0.15, 0, 1])!;
  moveGrab(s, g, poseOf([0, 0, 1], Math.PI, [1, 1, 1])); // half a turn about Z, elsewhere
  nearV(s.sphere.c, [1.15, 1, 1]);
  assert.equal(s.sphere.r, 0.1);

  s.mode = "spots";
  s.spots[3]!.pos = [0.5, 0.5, 0.5];
  const gs = beginGrab(s, P0, [0.5, 0.5, 0.52])!;
  assert.deepEqual(gs.target, { kind: "spot", index: 3 });
  moveGrab(s, gs, { R: P0.R, t: [0.15, 0, 2] });
  nearV(s.spots[3]!.pos!, [0.5, 0.5, 1.5]);
});

test("the button: click to take and click to drop, or hold and let go", () => {
  const b = new ClickOrHold();
  // A short click takes; letting go keeps it; the next press drops.
  assert.equal(b.down(0, false), "take");
  assert.equal(b.up(100, true), null);
  assert.equal(b.down(2000, true), "drop");
  assert.equal(b.up(2100, false), null);
  // Hold and carry: letting go after HOLD_MS drops.
  assert.equal(b.down(3000, false), "take");
  assert.equal(b.up(3000 + HOLD_MS, true), "drop");
  // A press that found nothing to take does nothing on release.
  assert.equal(b.down(5000, false), "take");
  assert.equal(b.up(6000, false), null);
  // A long press that drops doesn't drop twice.
  assert.equal(b.down(7000, true), "drop");
  assert.equal(b.up(8000, false), null);
});

test("mock tracking reports the stylus's button changes once each", () => {
  const m = createMockTracking();
  const seen: [string, number][] = [];
  const off = m.onButtons((serial, mask) => seen.push([serial, mask]));
  m.setButtons(8);
  m.setButtons(8);
  m.setButtons(0);
  off();
  m.setButtons(1);
  assert.deepEqual(seen, [
    [MOCK_SERIAL, 8],
    [MOCK_SERIAL, 0],
  ]);
});
