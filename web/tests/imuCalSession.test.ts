/** The hands-free Calibrate-IMU flow (sensor-core.md §7.3): auto-capture on
 * registration, the steadiness / freshness / diversity / consistency gates,
 * always three poses, and the auto-solve recovering R_fi end to end. */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ImuCalFlow,
  MIN_POSE_SEPARATION_DEG,
  POSES_REQUIRED,
  posePrompt,
  rotateXyzw,
  type FixtureImuView,
  type FlowStatus,
} from "../src/capture/imuCalSession";
import { angleDeg, axisAngle, quatMul, rotate, type QuatWxyz, type V3 } from "../src/geom/imuExtrinsic";

const conj = (q: QuatWxyz): QuatWxyz => [q[0], -q[1], -q[2], -q[3]];
const toXyzw = (q: QuatWxyz): number[] => [q[1], q[2], q[3], q[0]];
const D = Math.PI / 180;
function errDeg(a: QuatWxyz, b: QuatWxyz): number {
  const d = quatMul(conj(a), b);
  return (2 * Math.atan2(Math.hypot(d[1], d[2], d[3]), Math.abs(d[0])) * 180) / Math.PI;
}

/** World (room) up = map up when the fixture stands as mapped; tipped by T
 * (fixture->room), room up in the fixture frame is T^-1 * Y. */
function scene(rfi: QuatWxyz, tip: QuatWxyz, camToRoom: QuatWxyz) {
  const upFixture = rotate(conj(tip), [0, 1, 0]);
  const imuUp = rotate(conj(rfi), upFixture);
  const camToMap = quatMul(conj(tip), camToRoom);
  const phoneUpCam = rotate(conj(camToRoom), [0, 1, 0]);
  return { imuUp, camToMap, phoneUpCam };
}

/** A simulated session: the phone clock, a 30 fps camera, 60 Hz phone IMU and
 * a ~7 Hz get_sensors reader, all fed into one flow the way capture.ts does. */
class Sim {
  t = 1000;
  samples = 0;
  restSamples = 0;
  lastPushed = 0;
  statuses: FlowStatus[] = [];
  constructor(readonly flow = new ImuCalFlow()) {}

  /** Run `ms` of a pose. `locked` = PnP locks; `still` = the fixture IMU at rest;
   * `shake` = phone gravity wobble (deg); `sensorLive` = the reader's counter
   * advances; `noise` = extra per-frame fixture-up jitter (deg). */
  run(
    ms: number,
    s: ReturnType<typeof scene>,
    o: { locked?: boolean; still?: boolean; shake?: number; sensorLive?: boolean; noise?: number; sensor?: boolean } = {},
  ): FlowStatus[] {
    const { locked = true, still = true, shake = 0, sensorLive = true, noise = 0, sensor = true } = o;
    const out: FlowStatus[] = [];
    const end = this.t + ms;
    // A frozen counter repeats the last value the reader saw.
    if (!sensorLive) this.samples = this.lastPushed;
    let phoneBatch: { t: number; accel: V3 }[] = [];
    for (; this.t < end; this.t += 1000 / 60) {
      const k = Math.round(this.t / (1000 / 60));
      const wob = shake ? axisAngle([1, 0.3, 0], Math.sin(k * 0.9) * shake * D) : ([1, 0, 0, 0] as QuatWxyz);
      phoneBatch.push({ t: this.t, accel: rotate(wob, s.phoneUpCam).map((c) => c * 9.81) as V3 });
      if (k % 12 === 0) {
        this.flow.pushPhone(phoneBatch); // the 200 ms IMU tick
        phoneBatch = [];
      }
      if (k % 2 === 0) {
        const jitter = noise ? axisAngle([0, 0, 1], Math.sin(k * 1.7) * noise * D) : ([1, 0, 0, 0] as QuatWxyz);
        this.flow.pushFrame(this.t, locked ? toXyzw(quatMul(s.camToMap, jitter)) : null);
      }
      if (still) this.restSamples += 1.67;
      else this.restSamples = 0;
      if (sensorLive) this.samples += 1.67;
      if (sensor && k % 9 === 0) {
        const v: FixtureImuView = {
          status: "SENSOR_STATUS_RUNNING",
          atRest: still && this.restSamples >= 50,
          restUpImu: [...s.imuUp],
          restUpSigmaDeg: 0.2,
          restSamples: Math.floor(this.restSamples),
          samples: Math.floor(this.samples),
          sampleRateHz: 100,
        };
        this.flow.pushSensor(v, this.t);
        this.lastPushed = Math.floor(this.samples);
      }
      if (k % 6 === 0) {
        const st = this.flow.step(this.t);
        out.push(st);
        this.statuses.push(st);
      }
    }
    return out;
  }
}

const captures = (sts: FlowStatus[]) => sts.filter((s) => s.captured !== null).length;
const lastWait = (sts: FlowStatus[]) => sts[sts.length - 1]!.wait?.reason ?? null;

const RFI = axisAngle([0.3, -1, 0.5], 2.0);
const CAM = quatMul(axisAngle([1, 0, 0], -0.25), axisAngle([0, 1, 0], 0.4));
const POSE_TIPS: QuatWxyz[] = [
  [1, 0, 0, 0],
  axisAngle([0, 0, 1], 45 * D), // tilted to the side
  axisAngle([1, 0, 0], 45 * D), // toward / away
];

test("rotateXyzw matches the wxyz rotation", () => {
  const q = axisAngle([1, 2, 3], 0.9);
  const v: V3 = [0.3, -0.4, 0.8];
  assert.ok(angleDeg(rotateXyzw(toXyzw(q), v), rotate(q, v)) < 1e-9);
});

test("a pose is captured automatically once registered and steady — no button", () => {
  const sim = new Sim();
  const s0 = scene(RFI, POSE_TIPS[0]!, CAM);
  // Not registered: nothing happens, and the guidance says why.
  let sts = sim.run(1500, s0, { locked: false });
  assert.equal(captures(sts), 0);
  assert.equal(lastWait(sts), "not_registered");
  // Registered and still: one pose within ~1 s, then it asks for the next.
  sts = sim.run(1500, s0);
  assert.equal(captures(sts), 1, "exactly one auto-capture");
  const st = sts[sts.length - 1]!;
  assert.equal(st.taken, 1);
  assert.equal(st.prompt, posePrompt(1));
  assert.equal(st.wait?.reason, "too_close", "same pose again is refused with guidance");
  assert.match(st.wait!.text, /tilt the fixture further/);
});

test("steadiness gate: a moving fixture or a shaky phone holds the capture", () => {
  const s0 = scene(RFI, POSE_TIPS[0]!, CAM);
  let sim = new Sim();
  let sts = sim.run(2500, s0, { still: false });
  assert.equal(captures(sts), 0);
  assert.equal(lastWait(sts), "fixture_moving");
  assert.match(sts[sts.length - 1]!.wait!.text, /Hold the fixture still/);

  sim = new Sim();
  sts = sim.run(2500, s0, { shake: 8 });
  assert.equal(captures(sts), 0);
  assert.equal(lastWait(sts), "phone_moving");

  // A registration that wobbles (bad PnP, phone gravity not matching) holds too.
  sim = new Sim();
  sts = sim.run(2500, s0, { noise: 9 });
  assert.equal(captures(sts), 0);
  assert.equal(lastWait(sts), "phone_moving");

  // A fixture that only just stopped isn't taken until its rest streak covers
  // the whole window.
  sim = new Sim();
  sim.run(1000, s0, { still: false });
  sts = sim.run(400, s0);
  assert.equal(captures(sts), 0, "rest streak shorter than the window");
  sts = sim.run(1200, s0);
  assert.equal(captures(sts), 1);
});

test("freshness gate: a stale or frozen sensor reading never pairs with a lock", () => {
  const s0 = scene(RFI, POSE_TIPS[0]!, CAM);
  const sim = new Sim();
  // Readings stop arriving (reader wedged): no capture on an old reading.
  sim.run(300, s0);
  let sts = sim.run(2500, s0, { sensor: false });
  assert.equal(captures(sts), 0);
  assert.equal(lastWait(sts), "sensor_stale");
  // Readings arrive but the sample counter is frozen (a stuck snapshot).
  sts = sim.run(2500, s0, { sensorLive: false });
  assert.equal(captures(sts), 0);
  assert.equal(lastWait(sts), "sensor_stale");
  sts = sim.run(1500, s0);
  assert.equal(captures(sts), 1);
});

test("diversity gate: near-duplicates are refused, a real tilt is taken", () => {
  const sim = new Sim();
  sim.run(1500, scene(RFI, POSE_TIPS[0]!, CAM));
  assert.equal(sim.flow.poses.length, 1);
  // 15° is not enough.
  const near = scene(RFI, axisAngle([0, 0, 1], 15 * D), CAM);
  let sts = sim.run(2000, near);
  assert.equal(captures(sts), 0);
  const w = sts[sts.length - 1]!;
  assert.equal(w.wait?.reason, "too_close");
  assert.ok(Math.abs(w.separationDeg - 15) < 1, `${w.separationDeg}`);
  assert.match(w.wait!.text, new RegExp(`of ${MIN_POSE_SEPARATION_DEG}°`));
  // 45° is.
  sts = sim.run(1500, scene(RFI, POSE_TIPS[1]!, CAM));
  assert.equal(captures(sts), 1);
  // The third must differ from BOTH earlier poses: back to pose 1 is refused.
  sts = sim.run(2000, scene(RFI, [1, 0, 0, 0], CAM));
  assert.equal(captures(sts), 0);
  assert.equal(lastWait(sts), "too_close");
});

test("consistency gate: camera and IMU must agree on how far the fixture turned", () => {
  const sim = new Sim();
  sim.run(1500, scene(RFI, POSE_TIPS[0]!, CAM));
  // The IMU tips 45° but the camera-derived up says ~0° (e.g. the phone's
  // motion axes mis-mapped): refused, with guidance, not silently taken.
  const truth = scene(RFI, POSE_TIPS[1]!, CAM);
  const lie = scene(RFI, POSE_TIPS[0]!, CAM);
  const sts = sim.run(2000, { ...lie, imuUp: truth.imuUp });
  assert.equal(captures(sts), 0);
  assert.equal(lastWait(sts), "inconsistent");
  assert.ok(sim.flow.rejectedInconsistent > 0);
});

test("always three poses, then it solves on its own and recovers R_fi", () => {
  const sim = new Sim();
  const cams = [CAM, quatMul(axisAngle([0, 1, 0], -0.5), CAM), quatMul(axisAngle([1, 0, 0], 0.2), CAM)];
  for (let i = 0; i < POSES_REQUIRED; i++) {
    const sts = sim.run(1800, scene(RFI, POSE_TIPS[i]!, cams[i]!), { shake: 0.4 });
    assert.equal(captures(sts), 1, `pose ${i + 1}`);
    // Moving between poses (fixture lifted, registration lost).
    sim.run(600, scene(RFI, POSE_TIPS[i]!, cams[i]!), { still: false, locked: false });
  }
  const st = sim.flow.step(sim.t);
  assert.equal(st.phase, "solved");
  assert.equal(st.taken, 3);
  assert.ok(st.solve !== null);
  assert.ok(st.solve.yawResolved);
  assert.equal(st.solve.quality, "good");
  assert.ok(errDeg(st.solve.q, RFI) < 1, `R_fi error ${errDeg(st.solve.q, RFI)}°`);
  // Done: no more captures however long it runs.
  assert.equal(captures(sim.run(2000, scene(RFI, axisAngle([1, 1, 0], 1.2), CAM))), 0);
  assert.equal(sim.flow.poses.length, 3);
  // Retake starts over with nothing carried in.
  sim.flow.restart();
  assert.equal(sim.flow.poses.length, 0);
  assert.equal(sim.flow.done, false);
  // ...and the fixture still sitting steady in view is pose 1 of the retake.
  const st2 = sim.flow.step(sim.t);
  assert.equal(st2.phase, "collecting");
  assert.equal(st2.taken, 1);
});

test("a sensor that isn't running says so", () => {
  const flow = new ImuCalFlow();
  flow.pushSensor({ status: "SENSOR_STATUS_ABSENT", atRest: false, restUpImu: [], restUpSigmaDeg: 0, restSamples: 0 }, 0);
  assert.equal(flow.step(10).wait?.reason, "no_sensor");
});
