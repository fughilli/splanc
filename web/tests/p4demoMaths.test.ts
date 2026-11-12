/**
 * P4 demo page: frame maths, the stylus pivot fit (against synthetic rocking with a
 * known tip), the stylus tip file, the demo's OSC for each mode, and the mock.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  apply,
  axisWorld,
  fromColumnMajor,
  matToQuat,
  mulMM,
  poseFromPQ,
  quatFromAxisAngle,
  quatMul,
  quatToMat,
  rotAngle,
  sub,
  norm,
  toColumnMajor,
  transpose,
  type Pose,
} from "../src/p4demo/frames";
import { pivot, pivotProblem, pivotRobust } from "../src/p4demo/pivot";
import { parseStylusTip, StylusTipStore } from "../src/p4demo/stylusTip";
import {
  ALL_ADDRESSES,
  followStylus,
  hexToRgb,
  initialState,
  oscFor,
  rgbToHex,
  stationMessages,
  syncStreamer,
  LOOK_OUTLINE,
  LOOK_SHAPE,
} from "../src/p4demo/demo";
import { decode, message } from "../src/p4demo/osc";
import { parseLhPose } from "../src/p4demo/lamp";
import { createMockTracking, mockStylusPose, MOCK_TIP } from "../src/p4demo/lh/mock";
import type { Quat, Vec3 } from "../src/p4demo/lh/types";

const close = (a: number, b: number, tol: number, what = ""): void =>
  assert.ok(Math.abs(a - b) <= tol, `${what} ${a} vs ${b} (tol ${tol})`);
const closeV = (a: number[], b: number[], tol: number, what = ""): void =>
  a.forEach((x, i) => close(x, b[i]!, tol, `${what}[${i}]`));

// A small deterministic PRNG (tests must not flake).
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
function gauss(r: () => number): number {
  return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
}

// ------------------------------------------------------------------ frames

test("quaternion <-> matrix round trip, w >= 0, and agreement with frames.py's formula", () => {
  const r = rng(1);
  for (let k = 0; k < 50; k++) {
    let q: Quat = [gauss(r), gauss(r), gauss(r), gauss(r)];
    const n = Math.hypot(...q);
    q = q.map((x) => x / n) as Quat;
    if (q[0] < 0) q = q.map((x) => -x) as Quat;
    const R = quatToMat(q);
    const RtR = mulMM(transpose(R), R);
    closeV(RtR, [1, 0, 0, 0, 1, 0, 0, 0, 1], 1e-12, "orthonormal");
    closeV(matToQuat(R), q, 1e-9, "round trip");
  }
  // 90° about +X takes +Y to +Z (frames.Y_UP_TO_Z_UP).
  const R = quatToMat(quatFromAxisAngle([1, 0, 0], Math.PI / 2));
  closeV(apply({ R, t: [0, 0, 0] }, [0, 1, 0]), [0, 0, 1], 1e-12);
});

test("quatMul composes rotations like matrix products", () => {
  const a = quatFromAxisAngle([0, 0, 1], 0.7);
  const b = quatFromAxisAngle([1, 1, 0], -1.1);
  closeV(quatToMat(quatMul(a, b)), mulMM(quatToMat(a), quatToMat(b)), 1e-12);
  close(rotAngle(quatToMat(b)), 1.1, 1e-12);
});

test("column-major mat4 (the /lh/mount wire order) round trip with scale", () => {
  const P = poseFromPQ([0.1, -0.2, 0.3], quatFromAxisAngle([0.3, 1, -0.2], 0.9));
  const m = toColumnMajor(P, 1.03);
  assert.deepEqual(m.slice(12), [0.1, -0.2, 0.3, 1]);
  const back = fromColumnMajor(m);
  close(back.s, 1.03, 1e-12);
  closeV(back.pose.R, P.R, 1e-12);
});

test("stylus tip and axis in the world (flashlight.py: axis = c_S / |c_S|)", () => {
  const P = poseFromPQ([1, 2, 3], quatFromAxisAngle([1, 0, 0], Math.PI)); // +Z_S -> -Z_W
  const tip = apply(P, [0, 0, 0.2]);
  closeV(tip, [1, 2, 2.8], 1e-12);
  closeV(axisWorld(P, [0, 0, 0.2]), [0, 0, -1], 1e-12);
  closeV(axisWorld(P, null), [0, 0, -1], 1e-12, "no tip: +Z_S");
});

// ------------------------------------------------------------------ pivot

/** Poses of a stylus with tip `c` rocking round world point `q`, with noise. */
function rocking(c: Vec3, q: Vec3, n: number, tiltDeg: number, noiseM: number, seed: number): Pose[] {
  const r = rng(seed);
  const out: Pose[] = [];
  for (let k = 0; k < n; k++) {
    const az = r() * 2 * Math.PI;
    const tilt = ((r() * 2 - 1) * tiltDeg * Math.PI) / 180;
    const quat = quatMul(quatFromAxisAngle([Math.cos(az), Math.sin(az), 0], tilt), quatFromAxisAngle([0, 1, 0], Math.PI * 0.9));
    const R = quatToMat(quat);
    const Rc = apply({ R, t: [0, 0, 0] }, c);
    const t: Vec3 = [q[0] - Rc[0] + noiseM * gauss(r), q[1] - Rc[1] + noiseM * gauss(r), q[2] - Rc[2] + noiseM * gauss(r)];
    out.push({ R, t });
  }
  return out;
}

test("pivot: exact data recovers the tip and the pivot point", () => {
  const c: Vec3 = [0.0217, 0.0022, 0.1845];
  const q: Vec3 = [-0.229, 0.156, -0.023];
  const res = pivot(rocking(c, q, 200, 30, 0, 7))!;
  closeV(res.c, c, 1e-9, "c");
  closeV(res.q, q, 1e-9, "q");
  close(res.rms, 0, 1e-9);
  assert.ok(res.spreadDeg > 25 && res.spreadDeg <= 31, `spread ${res.spreadDeg}`);
  assert.equal(pivotProblem(res, 200), null);
});

test("pivotRobust: 1 mm noise plus 20% slips/jumps, tip within 2 mm", () => {
  const c: Vec3 = [0.0217, 0.0022, 0.1845];
  const q: Vec3 = [0.3, -0.1, 0.8];
  const poses = rocking(c, q, 800, 30, 0.001, 11);
  const r = rng(99);
  for (let k = 0; k < poses.length; k++) {
    if (r() < 0.2) poses[k]!.t = [poses[k]!.t[0] + 0.03 * gauss(r), poses[k]!.t[1] + 0.03 * gauss(r), poses[k]!.t[2] + 0.03 * gauss(r)];
  }
  const plain = pivot(poses)!;
  const res = pivotRobust(poses)!;
  const err = norm(sub(res.c, c));
  assert.ok(err < 0.002, `robust tip error ${(err * 1e3).toFixed(2)} mm`);
  assert.ok(norm(sub(plain.c, c)) > err, "the robust fit beats plain least squares here");
  const kept = res.inliers.filter(Boolean).length;
  assert.ok(kept > 0.7 * poses.length && kept < 0.9 * poses.length, `kept ${kept}`);
  assert.equal(pivotProblem(res, poses.length), null);
});

test("pivotProblem: too little rocking / too few samples / tip moving", () => {
  const c: Vec3 = [0, 0, 0.18];
  const still = pivotRobust(rocking(c, [0, 0, 1], 200, 5, 0.0002, 3))!;
  assert.match(pivotProblem(still, 200)!, /rocked only/);
  const few = pivotRobust(rocking(c, [0, 0, 1], 30, 30, 0.0002, 4))!;
  assert.match(pivotProblem(few, 30)!, /only \d+ samples/);
  const sloppy = pivot(rocking(c, [0, 0, 1], 200, 30, 0.02, 5))!;
  assert.match(pivotProblem(sloppy, 200)!, /tip moved/);
  assert.equal(pivot([]), null);
});

test("pivot on the mock stylus's own rocking finds the mock tip", () => {
  const poses: Pose[] = [];
  for (let t = 0; t < 20; t += 0.05) {
    const p = mockStylusPose(t, "pivot");
    poses.push(poseFromPQ(p.pos, p.quat));
  }
  const res = pivotRobust(poses)!;
  closeV(res.c, MOCK_TIP, 1e-6, "mock tip");
  assert.equal(pivotProblem(res, poses.length), null);
});

// ------------------------------------------------------------------ stylus tip file

test("stylus tip: imports the desktop demo's mounts/stylus-<serial>.json", () => {
  const file = JSON.stringify({
    stylus: "LHR-10F97524",
    c_S: [0.021702769630512417, 0.002244040188464802, 0.18451359608383916],
    pivot: { rms_mm: 5.55, spread_deg: 38.2, n: 886, kept: 860, q_W: [-0.2, 0.15, -0.02] },
    saved: "2026-10-30T19:06:58",
  });
  const t = parseStylusTip(file);
  assert.equal(t.stylus, "LHR-10F97524");
  close(t.c_S[2], 0.1845, 1e-4);
  const mem = new Map<string, string>();
  const store = new StylusTipStore({
    getItem: (k) => mem.get(k) ?? null,
    setItem: (k, v) => void mem.set(k, v),
    removeItem: (k) => void mem.delete(k),
  });
  store.put(t);
  assert.deepEqual(store.get("LHR-10F97524")!.c_S, t.c_S);
  assert.equal(store.get("LHR-OTHER"), null);
  assert.deepEqual(parseStylusTip(store.exportJson("LHR-10F97524")!), t);
  store.forget("LHR-10F97524");
  assert.equal(store.get("LHR-10F97524"), null);
});

test("stylus tip: rejects files that aren't one", () => {
  assert.throws(() => parseStylusTip("{"), /not JSON/);
  assert.throws(() => parseStylusTip(JSON.stringify({ stylus: "x", c_S: [1, 2] })), /c_S/);
  assert.throws(() => parseStylusTip(JSON.stringify({ stylus: "x", c_S: [0, 0, 0] })), /not a stylus tip/);
  assert.throws(() => parseStylusTip(JSON.stringify({ c_S: [0, 0, 0.18] })), /serial/);
  assert.equal(parseStylusTip(JSON.stringify({ c_S: [0, 0, 0.18] }), "LHR-1").stylus, "LHR-1");
});

// ------------------------------------------------------------------ the demo's OSC

test("plane mode: /pick -1, /shape 0, /plane through the tip perpendicular to the stylus", () => {
  const s = initialState();
  assert.equal(s.mode, "plane", "the page starts LIVE");
  const P = poseFromPQ([0.2, 0.1, 1.0], quatFromAxisAngle([1, 0, 0], Math.PI)); // pointing down
  followStylus(s, P, [0, 0, 0.18]);
  const osc = oscFor(s);
  assert.deepEqual(osc.get("/pick")!.values, [LOOK_SHAPE]);
  assert.deepEqual(osc.get("/shape")!.values, [0]);
  const [nx, ny, nz, d] = osc.get("/plane")!.values;
  closeV([nx!, ny!, nz!], [0, 0, -1], 1e-12);
  close(d!, -0.82, 1e-12, "n . tip"); // tip at z = 1.0 - 0.18
  assert.equal(osc.get("/plane")!.keepalive, undefined, "the shape keeps the fast keep-alive");
  assert.equal(osc.get("/width")!.keepalive, 1, "settings: 1 s");
  assert.ok(!osc.has("/sphere"));
});

test("sphere mode: /shape 1, /sphere centred on the tip with the radius", () => {
  const s = initialState();
  s.mode = "sphere";
  s.radius = 0.12;
  followStylus(s, poseFromPQ([0, 0, 1], [1, 0, 0, 0]), [0, 0, 0.18]);
  const osc = oscFor(s);
  assert.deepEqual(osc.get("/shape")!.values, [1]);
  closeV(osc.get("/sphere")!.values, [0, 0, 1.18, 0.12], 1e-12);
  assert.ok(!osc.has("/plane"));
});

test("hold: follow off keeps the shape where it was", () => {
  const s = initialState();
  followStylus(s, poseFromPQ([0, 0, 1], [1, 0, 0, 0]), null);
  const before = oscFor(s).get("/plane")!.values;
  s.follow = false;
  assert.equal(followStylus(s, poseFromPQ([1, 1, 2], quatFromAxisAngle([0, 1, 0], 1)), null), false);
  assert.deepEqual(oscFor(s).get("/plane")!.values, before);
});

test("outline and spots modes; syncStreamer clears what a mode doesn't use", () => {
  const s = initialState();
  const held = new Map<string, number[]>();
  const st = {
    set: (a: string, v: number[]) => void held.set(a, v),
    clear: (...as: string[]) => as.forEach((a) => held.delete(a)),
    has: (a: string) => held.has(a),
  };
  syncStreamer(st, s);
  assert.ok(held.has("/plane") && held.has("/glow"));
  s.mode = "outline";
  syncStreamer(st, s);
  assert.deepEqual([...held.keys()], ["/pick"]);
  assert.deepEqual(held.get("/pick"), [LOOK_OUTLINE]);
  s.mode = "spots";
  s.spots[1]!.pos = [0.1, 0.2, 0.3];
  syncStreamer(st, s);
  assert.ok(!held.has("/pick"));
  assert.deepEqual(held.get("/spot1"), [0.1, 0.2, 0.3]);
  assert.deepEqual(held.get("/color1"), [0, 1, 0]);
  assert.deepEqual(held.get("/color0"), [0, 0, 0], "an unplaced spot is off (black)");
  for (const a of held.keys()) assert.ok(ALL_ADDRESSES.includes(a), a);
});

test("/lh/station: one ,iffffff f datagram per station (never a bundle)", () => {
  const msgs = stationMessages([
    { id: 0, pos: [1, 2, 3], quat: [1, 0, 0, 0] },
    { id: 1, pos: [-1, 0, 2], quat: [0, 1, 0, 0] },
  ]);
  assert.equal(msgs.length, 2);
  for (const m of msgs) assert.notEqual(new TextDecoder().decode(m.subarray(0, 7)), "#bundle");
  const [d] = decode(msgs[1]!);
  assert.equal(d!.address, "/lh/station");
  assert.deepEqual(d!.args, [1, -1, 0, 2, 0, 1, 0, 0]);
});

test("/lh/pose parse, colour helpers", () => {
  const [m] = decode(message("/lh/pose", 1, 0.1, 0.2, 0.9, 1, 0, 0, 0));
  const p = parseLhPose(m!, 5)!;
  assert.equal(p.ok, true);
  closeV(p.pos, [0.1, 0.2, 0.9], 1e-6);
  assert.equal(parseLhPose({ address: "/lh/pose", args: [1, 2, 3] }, 0), null);
  assert.equal(rgbToHex([1, 0.4, 0.1]), "#ff661a");
  closeV(hexToRgb("#ff661a"), [1, 0.4, 0.1], 0.003);
});

test("mock tracking: connects, reports 2 stations and stylus poses", async () => {
  let tick: (() => void) | null = null;
  let now = 0;
  const m = createMockTracking({
    now: () => now,
    setInterval: (fn) => {
      tick = fn;
      return 1;
    },
    clearInterval: () => {
      tick = null;
    },
  });
  const states: string[] = [];
  m.onStatus((s) => states.push(s.state));
  const poses: Vec3[] = [];
  m.onPose((p) => poses.push(p.pos));
  await m.connect();
  assert.equal(m.stations().length, 2);
  assert.equal(states[states.length - 1], "tracking");
  for (let i = 0; i < 10; i++) {
    now += 11;
    tick!();
  }
  assert.equal(poses.length, 10);
  await m.disconnect();
  assert.equal(tick, null);
  assert.equal(states[states.length - 1], "disconnected");
});
