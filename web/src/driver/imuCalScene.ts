/**
 * Synthetic Calibrate-IMU scene for the app-driver (phone-in-the-loop HITL /
 * Playwright smoke), behind `?driver=` only.
 *
 * One known fixture, one known IMU mount R_fi, and a "user" who tilts the
 * fixture to the next pose whenever the calibration screen shows a pose was
 * taken (the hands-free flow's only cue). The same tilt drives both halves of
 * the calibration so they agree, as a real rigid fixture would:
 *   - the synthetic camera renders the LEDs rotated about their centroid
 *     (DriverFixtureScene.fixtureRotAt), so the real detector + decoder + PnP
 *     register the stored map at the tilted pose;
 *   - a fake fixture IMU answers get_sensors with up = R_fi⁻¹ · T⁻¹ · Y, at rest
 *     only after the tilt has stopped (rest_samples counting at 100 Hz), and
 *     stores set_sensor_mount like the firmware (applied at its next poll, read
 *     back with whole-second timestamps).
 * It is installed onto the live client instance (like the ?demo= seam), so the
 * real screen, flow and write-back code run unmodified.
 */

import { axisAngle, quatMul, rotate, type QuatWxyz, type V3 } from "../geom/imuExtrinsic";
import type { DriverFixtureScene } from "./guard";

const D = Math.PI / 180;
const TILT_MS = 1200;

/** A non-planar 6×5 fixture (0.1 m pitch, alternate LEDs 6 cm proud). */
export function sceneLeds(): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 6; c++) out.push([(c - 2.5) * 0.1, (2 - r) * 0.1, ((r + c) % 2) * 0.06]);
  }
  return out;
}

export interface SceneOptions {
  /** IMU -> fixture rotation, [w, x, y, z]. */
  rfi?: QuatWxyz;
  /** Fixture tilts per pose (fixture -> room), [w, x, y, z]. */
  tips?: QuatWxyz[];
}

export class ImuCalScene implements DriverFixtureScene {
  readonly leds = sceneLeds();
  readonly rfi: QuatWxyz;
  readonly tips: QuatWxyz[];
  /** Pose the fixture is in / moving to, and when that move began. */
  private pose = 0;
  private moveStart = -Infinity;
  private samples = 0;
  private lastPoll = performance.now();
  private restSince = performance.now();
  /** The device's stored mount (what get_sensors reads back). */
  mount = {
    mountQuat: [1, 0, 0, 0] as number[],
    mountExtrinsic: false,
    mountYawResolved: false,
    mountPoses: 1,
    mountCalibratedAtMs: 0,
    calibrationSeq: 0,
  };
  writes = 0;
  /** Fail this many set_sensor_mount calls as a dropped link would (before the
   * device took them): the disconnect-mid-write journey. */
  failWrites = 0;
  private posted: { q: number[]; poses: number; yaw: boolean; at: number } | null = null;

  constructor(o: SceneOptions = {}) {
    this.rfi = o.rfi ?? axisAngle([0.3, -1, 0.5], 2.0);
    this.tips = o.tips ?? [[1, 0, 0, 0], axisAngle([0, 0, 1], 45 * D), axisAngle([1, 0, 0], -40 * D)];
  }

  /** The "user" moves to pose `k` (from the current one), starting now. */
  tiltTo(k: number): void {
    if (k <= this.pose || k >= this.tips.length) return;
    this.pose = k;
    this.moveStart = performance.now();
  }

  /** Fixture -> room at `tMs`, [w, x, y, z] (slerp-free: a lerp of the angle
   * about the relative axis is exact for these single-axis tips). */
  private tipAt(tMs: number): QuatWxyz {
    const to = this.tips[this.pose]!;
    const from = this.tips[Math.max(0, this.pose - 1)]!;
    const u = Math.min(1, Math.max(0, (tMs - this.moveStart) / TILT_MS));
    if (u >= 1 || this.pose === 0) return to;
    // relative rotation from -> to, scaled by u
    const rel = quatMul(to, [from[0], -from[1], -from[2], -from[3]]);
    const ang = 2 * Math.acos(Math.min(1, Math.abs(rel[0])));
    const s = Math.sin(ang / 2) || 1;
    const sign = rel[0] < 0 ? -1 : 1;
    const axis: V3 = [(sign * rel[1]) / s, (sign * rel[2]) / s, (sign * rel[3]) / s];
    return ang < 1e-9 ? to : quatMul(axisAngle(axis, ang * u), from);
  }

  fixtureRotAt(tMs: number): [number, number, number, number] {
    const q = this.tipAt(tMs);
    return [q[1], q[2], q[3], q[0]];
  }

  /** get_sensors, as the firmware would answer it now. */
  sensorState(): Record<string, unknown> {
    const now = performance.now();
    this.samples += Math.max(0, Math.round((now - this.lastPoll) / 10));
    this.lastPoll = now;
    const moving = now - this.moveStart < TILT_MS;
    if (moving) this.restSince = now;
    // Rest needs 0.5 s of stillness first (RestDetector settle = 50 samples).
    const restSamples = Math.max(0, Math.floor((now - this.restSince) / 10) - 50);
    if (this.posted) {
      const p = this.posted;
      this.posted = null;
      this.mount = {
        mountQuat: p.q,
        mountExtrinsic: true,
        mountYawResolved: p.yaw,
        mountPoses: p.poses,
        mountCalibratedAtMs: p.at,
        calibrationSeq: this.mount.calibrationSeq + 1,
      };
    }
    const tip = this.tipAt(now);
    const upFixture = rotate([tip[0], -tip[1], -tip[2], -tip[3]], [0, 1, 0]);
    const imuUp = rotate([this.rfi[0], -this.rfi[1], -this.rfi[2], -this.rfi[3]], upFixture);
    return {
      type: "sensor_state",
      status: "SENSOR_STATUS_RUNNING",
      part: "MPU-6050",
      atRest: restSamples > 0,
      restUpImu: restSamples > 0 ? imuUp : [],
      restUpSigmaDeg: 0.2,
      restSamples,
      samples: this.samples,
      sampleRateHz: 100,
      ...this.mount,
    };
  }

  /** set_sensor_mount: posted, applied at the "sensor task's" next poll. */
  setMount(quat: number[], meta: { poses: number; yawResolved: boolean; atMs?: number }): Record<string, unknown> {
    if (this.failWrites > 0) {
      this.failWrites--;
      throw new Error("socket closed");
    }
    this.writes++;
    const before = this.sensorState();
    this.posted = {
      q: quat.map((v) => Math.fround(v)),
      poses: meta.poses,
      yaw: meta.yawResolved,
      at: Math.floor((meta.atMs ?? 0) / 1000) * 1000,
    };
    return before;
  }

  /** Angle between the stored mount and the true R_fi, degrees. */
  mountErrorDeg(): number {
    const q = this.mount.mountQuat;
    if (q.length !== 4) return Infinity;
    const d = quatMul([q[0]!, -q[1]!, -q[2]!, -q[3]!], this.rfi);
    return (2 * Math.atan2(Math.hypot(d[1], d[2], d[3]), Math.abs(d[0]))) / D;
  }
}
