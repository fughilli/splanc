/**
 * The guided "Calibrate IMU" flow's logic (docs/design/sensor-core.md §7.3),
 * DOM-free so it is unit-tested: collects still poses that pair the fixture
 * IMU's settled up (from get_sensors) with up in the fixture/map frame (the
 * phone's gravity rotated through the camera pose that PnP recovers against
 * the known LED map), gates each capture on stillness + separation + a PnP
 * lock, and solves R_fi once two non-parallel poses exist.
 */

import {
  MIN_SEPARATION_DEG,
  angleDeg,
  separationFromAccepted,
  solveImuExtrinsic,
  type ExtrinsicSolve,
  type GravityPose,
  type QuatWxyz,
  type V3,
} from "../geom/imuExtrinsic";

/** Phone IMU sample (camera frame, specific force: up at rest). */
export interface PhoneImuSample {
  t: number;
  accel: V3;
}

/** The fixture IMU's view, from get_sensors. */
export interface FixtureImuView {
  atRest: boolean;
  restUpImu: number[];
  restUpSigmaDeg: number;
  restSamples: number;
}

/** What the UI shows and whether "Capture pose" is enabled. */
export interface Readiness {
  canCapture: boolean;
  /** Human-readable blockers, in priority order (empty when ready). */
  blockers: string[];
  /** Smallest angle between the fixture's current up and the accepted poses'. */
  separationDeg: number;
  /** The pose that would be captured now. */
  candidate: GravityPose | null;
}

/** Minimum fixture rest streak (samples, ~0.5 s at 100 Hz). */
export const MIN_REST_SAMPLES = 50;
/** The phone must hold this still while a pose is taken, degrees (1 sigma). */
export const MAX_PHONE_SD_DEG = 3;
/** PnP pose error assumed in each fixture-frame up, degrees. */
export const PNP_SIGMA_DEG = 0.7;
/** Window of phone samples averaged for its up, ms. */
export const PHONE_WINDOW_MS = 1200;

const norm = (v: V3): V3 => {
  const n = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / n, v[1] / n, v[2] / n];
};

/** Rotate v by a camera->map quaternion given as [x, y, z, w] (pinhole.ts). */
export function rotateXyzw(q: readonly number[], v: V3): V3 {
  const [x, y, z, w] = [q[0]!, q[1]!, q[2]!, q[3]!];
  const t: V3 = [2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0])];
  return [
    v[0] + w * t[0] + (y * t[2] - z * t[1]),
    v[1] + w * t[1] + (z * t[0] - x * t[2]),
    v[2] + w * t[2] + (x * t[1] - y * t[0]),
  ];
}

export class ImuCalSession {
  readonly poses: GravityPose[];
  private phone: PhoneImuSample[] = [];

  /** `initial`: poses already known (pose 1 from the mapping itself). */
  constructor(initial: GravityPose[] = []) {
    this.poses = [...initial];
  }

  pushPhone(samples: readonly PhoneImuSample[]): void {
    this.phone.push(...samples);
    const last = this.phone.length ? this.phone[this.phone.length - 1]!.t : 0;
    this.phone = this.phone.filter((s) => s.t >= last - PHONE_WINDOW_MS);
  }

  /** The phone's averaged up in the camera frame and its spread (deg). */
  phoneUp(): { dir: V3; sdDeg: number } | null {
    if (this.phone.length < 10) return null;
    const sum: V3 = [0, 0, 0];
    for (const s of this.phone) {
      const u = norm(s.accel);
      sum[0] += u[0];
      sum[1] += u[1];
      sum[2] += u[2];
    }
    const dir = norm(sum);
    let ss = 0;
    for (const s of this.phone) ss += angleDeg(s.accel, dir) ** 2;
    return { dir, sdDeg: Math.sqrt(ss / this.phone.length) };
  }

  /** Can a pose be captured right now? `camToMap`: the PnP-locked camera->map
   * rotation [x, y, z, w], or null when not registered. */
  readiness(sensor: FixtureImuView, camToMap: readonly number[] | null): Readiness {
    const blockers: string[] = [];
    if (!sensor.atRest || sensor.restSamples < MIN_REST_SAMPLES || sensor.restUpImu.length !== 3) {
      blockers.push("Hold the fixture still");
    }
    const imuUp = (sensor.restUpImu.length === 3 ? sensor.restUpImu : [0, 0, 1]) as V3;
    const sep = separationFromAccepted(imuUp, this.poses);
    if (this.poses.length > 0 && sep < MIN_SEPARATION_DEG) {
      blockers.push(`Tip it further (${Math.round(sep)}° of ${MIN_SEPARATION_DEG}°)`);
    }
    if (camToMap === null) blockers.push("Point the camera at the lit fixture");
    const phone = this.phoneUp();
    if (phone === null || phone.sdDeg > MAX_PHONE_SD_DEG) blockers.push("Hold the phone steady");
    let candidate: GravityPose | null = null;
    if (camToMap !== null && phone !== null && sensor.restUpImu.length === 3) {
      const sigma = Math.hypot(Math.max(sensor.restUpSigmaDeg, 0.3), phone.sdDeg / Math.sqrt(10), PNP_SIGMA_DEG);
      candidate = { imuUp, fixtureUp: rotateXyzw(camToMap, phone.dir), sigmaDeg: sigma };
    }
    return { canCapture: blockers.length === 0 && candidate !== null, blockers, separationDeg: sep, candidate };
  }

  /** Accept the current candidate (call only when `readiness().canCapture`). */
  capture(r: Readiness): void {
    if (r.canCapture && r.candidate) this.poses.push(r.candidate);
  }

  drop(index: number): void {
    this.poses.splice(index, 1);
  }

  /** Solve with what's accepted (null until there is at least one pose). */
  solve(prior?: QuatWxyz): ExtrinsicSolve | null {
    return this.poses.length ? solveImuExtrinsic(this.poses, prior) : null;
  }
}
