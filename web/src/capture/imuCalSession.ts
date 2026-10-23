/**
 * The "Calibrate IMU" flow's logic (docs/design/sensor-core.md §7.3), DOM-free
 * so it is unit-tested. It is a hands-free state machine: there is no
 * "Capture pose" button. A pose is taken automatically when the map registers
 * in the viewfinder and everything has held still for a short window, then the
 * flow prompts for the next one. It always takes exactly three poses, then
 * solves R_fi.
 *
 * Each pose pairs two "up" directions sampled over the SAME window of the
 * phone's monotonic clock (the clock that stamps camera frames and phone IMU
 * samples alike):
 *   - fixture frame: the phone's gravity (camera frame) rotated through the
 *     camera->map pose that PnP recovers against the known LED map, per locked
 *     frame, averaged over the window;
 *   - IMU frame: the fixture IMU's settled up (get_sensors rest_up_imu), read
 *     during the window, from a rest streak that covers the whole window.
 *
 * Gates, each with its own guidance line:
 *   - registration: PnP locked on enough frames, with no gap, across the window;
 *   - steadiness: the camera-derived fixture up and the phone's gravity both
 *     hold still over the window, and the fixture IMU is at rest throughout;
 *   - freshness: the sensor reading arrived during the window and its sample
 *     counter advanced (a live sensor, not a stale snapshot);
 *   - diversity: ≥ MIN_POSE_SEPARATION_DEG from every pose already taken;
 *   - consistency: the angle between two poses must agree in the IMU and the
 *     camera frames (they are the same rigid rotation apart), which catches a
 *     bad lock or a phone-motion axis mix-up before it poisons the solve.
 */

import {
  angleDeg,
  separationFromAccepted,
  solveImuExtrinsic,
  type ExtrinsicSolve,
  type GravityPose,
  type QuatWxyz,
  type V3,
} from "../geom/imuExtrinsic";

/** Phone IMU sample (camera frame, specific force: up at rest). `t` is the
 * phone's monotonic clock, ms — the same domain as a frame's tCaptureMs. */
export interface PhoneImuSample {
  t: number;
  accel: V3 | number[];
}

/** The fixture IMU's view, from get_sensors. */
export interface FixtureImuView {
  status?: string;
  atRest: boolean;
  restUpImu: number[];
  restUpSigmaDeg: number;
  /** Length of the current rest streak, samples. */
  restSamples: number;
  /** Total samples since boot (freshness: must advance between reads). */
  samples?: number;
  sampleRateHz?: number;
}

/** Poses per calibration: always exactly three. */
export const POSES_REQUIRED = 3;
/** A new pose must be at least this far (IMU up) from every earlier one. */
export const MIN_POSE_SEPARATION_DEG = 30;
/** Everything must hold still over this window before a pose is taken, ms. */
export const STEADY_WINDOW_MS = 700;
/** Minimum PnP-locked frames in the window. */
export const MIN_LOCKED_FRAMES = 6;
/** Longest gap between locked frames inside the window, ms. */
export const MAX_LOCK_GAP_MS = 250;
/** A lock or phone sample older than this (vs now) is stale, ms. */
export const MAX_FEED_LAG_MS = 600;
/** Phone samples averaged around each locked frame, ±ms. */
export const PHONE_PAIR_HALF_MS = 60;
/** Spread of the camera-derived fixture up over the window, degrees (1σ). */
export const MAX_FIXTURE_UP_SD_DEG = 3;
/** Spread of the phone's gravity over the window, degrees (1σ). */
export const MAX_PHONE_SD_DEG = 3;
/** Fixture rest streak needed regardless of the window, samples (~0.5 s). */
export const MIN_REST_SAMPLES = 50;
/** Angle-between-poses disagreement (IMU vs camera) that rejects a pose. */
export const MAX_INCONSISTENCY_DEG = 10;
/** PnP pose error assumed in each fixture-frame up, degrees. */
export const PNP_SIGMA_DEG = 0.7;
/** Locks / phone samples kept, ms. */
const HISTORY_MS = 3000;

const norm = (v: readonly number[]): V3 => {
  const n = Math.hypot(v[0]!, v[1]!, v[2]!);
  return [v[0]! / n, v[1]! / n, v[2]! / n];
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

/** Mean direction and its RMS angular spread (degrees). */
function meanDir(dirs: readonly V3[]): { dir: V3; sdDeg: number } {
  const sum: V3 = [0, 0, 0];
  for (const d of dirs) {
    const u = norm(d);
    sum[0] += u[0];
    sum[1] += u[1];
    sum[2] += u[2];
  }
  const dir = norm(sum);
  let ss = 0;
  for (const d of dirs) ss += angleDeg(d, dir) ** 2;
  return { dir, sdDeg: Math.sqrt(ss / Math.max(dirs.length, 1)) };
}

/** What the next pose should look like (shown while waiting for it). */
export function posePrompt(index: number): string {
  switch (index) {
    case 0:
      return "Pose 1 of 3: leave the fixture in its normal position, lit LEDs in view, and hold the phone still.";
    case 1:
      return "Pose 2 of 3: tilt the fixture about 45° to the left (or right) and hold it still.";
    default:
      return "Pose 3 of 3: tilt it about 45° toward or away from you and hold it still.";
  }
}

/** Why the flow is not capturing right now (the UI shows `text`). */
export type WaitReason =
  | "no_sensor"
  | "no_phone_imu"
  | "sensor_stale"
  | "not_registered"
  | "phone_moving"
  | "fixture_moving"
  | "too_close"
  | "inconsistent";

export interface FlowStatus {
  phase: "collecting" | "solved";
  /** Poses taken so far (0..3). */
  taken: number;
  /** The prompt for the next pose (or the result line once solved). */
  prompt: string;
  /** The current blocker, if any. */
  wait: { reason: WaitReason; text: string } | null;
  /** Set on the step that took a pose. */
  captured: GravityPose | null;
  /** Set once the third pose is in. */
  solve: ExtrinsicSolve | null;
  /** Smallest IMU-up angle to the poses already taken (180 with none). */
  separationDeg: number;
}

interface Lock {
  t: number;
  q: number[];
}

interface SensorRead {
  view: FixtureImuView;
  /** Phone-clock receive time of the reply, ms. */
  tRecv: number;
  /** The read's sample counter advanced over the previous read's. */
  live: boolean;
}

export class ImuCalFlow {
  readonly poses: GravityPose[] = [];
  private phone: PhoneImuSample[] = [];
  private locks: Lock[] = [];
  private lastFrameT = -Infinity;
  private sensor: SensorRead | null = null;
  private result: ExtrinsicSolve | null = null;
  /** Poses rejected by the consistency gate (for the UI / logs). */
  rejectedInconsistent = 0;

  /** `prior`: a previous R_fi, only used to break ties in degenerate solves. */
  constructor(private readonly prior?: QuatWxyz) {}

  get done(): boolean {
    return this.result !== null;
  }

  /** Phone IMU samples (any batch size; out of order is fine). */
  pushPhone(samples: readonly PhoneImuSample[]): void {
    if (samples.length === 0) return;
    this.phone.push(...samples);
    this.phone.sort((a, b) => a.t - b.t);
    const last = this.phone[this.phone.length - 1]!.t;
    this.phone = this.phone.filter((s) => s.t >= last - HISTORY_MS);
  }

  /** Every processed camera frame: its capture time and the camera->map
   * rotation [x, y, z, w] when PnP locked on THIS frame, else null. */
  pushFrame(tMs: number, camToMap: readonly number[] | null): void {
    this.lastFrameT = Math.max(this.lastFrameT, tMs);
    if (camToMap !== null && camToMap.length === 4) this.locks.push({ t: tMs, q: [...camToMap] });
    this.locks = this.locks.filter((l) => l.t >= this.lastFrameT - HISTORY_MS);
  }

  /** A get_sensors reply, stamped with the phone-clock time it arrived. */
  pushSensor(view: FixtureImuView, tRecvMs: number): void {
    const prev = this.sensor?.view.samples;
    const cur = view.samples;
    // A reader that doesn't report a counter can't prove liveness: trust it.
    const live = cur === undefined || prev === undefined ? true : cur > prev;
    this.sensor = { view, tRecv: tRecvMs, live };
  }

  /** Throw away the poses (and the result) and start over. */
  restart(): void {
    this.poses.length = 0;
    this.result = null;
    this.rejectedInconsistent = 0;
  }

  /** Evaluate the gates at phone-clock time `nowMs`; takes a pose when they
   * all pass, and solves after the third. */
  step(nowMs: number): FlowStatus {
    const base = (wait: FlowStatus["wait"], sep = 180): FlowStatus => ({
      phase: this.result ? "solved" : "collecting",
      taken: this.poses.length,
      prompt: posePrompt(this.poses.length),
      wait,
      captured: null,
      solve: this.result,
      separationDeg: sep,
    });
    if (this.result) return base(null);

    // -- the fixture's sensor ------------------------------------------------
    const s = this.sensor;
    if (s === null) return base({ reason: "no_sensor", text: "Waiting for the fixture's motion sensor…" });
    if (s.view.status !== undefined && s.view.status !== "SENSOR_STATUS_RUNNING") {
      return base({ reason: "no_sensor", text: "This fixture's motion sensor isn't running." });
    }

    // -- registration over the window ----------------------------------------
    const lastLock = this.locks.length ? this.locks[this.locks.length - 1]!.t : -Infinity;
    const lastPhone = this.phone.length ? this.phone[this.phone.length - 1]!.t : -Infinity;
    if (nowMs - lastLock > MAX_FEED_LAG_MS) {
      return base({ reason: "not_registered", text: "Point the camera at the lit fixture until the map registers." });
    }
    if (nowMs - lastPhone > MAX_FEED_LAG_MS + 1000) {
      return base({ reason: "no_phone_imu", text: "Waiting for the phone's motion sensor…" });
    }
    // The window ends where BOTH feeds have data (phone samples arrive in batches).
    const end = Math.min(lastLock, lastPhone + PHONE_PAIR_HALF_MS);
    const start = end - STEADY_WINDOW_MS;
    const inWin = this.locks.filter((l) => l.t >= start && l.t <= end);
    let covered = inWin.length >= MIN_LOCKED_FRAMES && inWin[0]!.t - start <= MAX_LOCK_GAP_MS;
    for (let i = 1; covered && i < inWin.length; i++) {
      if (inWin[i]!.t - inWin[i - 1]!.t > MAX_LOCK_GAP_MS) covered = false;
    }
    if (!covered) {
      return base({ reason: "not_registered", text: "Registering… keep the lit fixture in view." });
    }

    // -- steadiness: phone gravity, and the camera-derived fixture up ---------
    const phoneWin = this.phone.filter((p) => p.t >= start - PHONE_PAIR_HALF_MS && p.t <= end + PHONE_PAIR_HALF_MS);
    if (phoneWin.length < 5) return base({ reason: "no_phone_imu", text: "Waiting for the phone's motion sensor…" });
    const phone = meanDir(phoneWin.map((p) => p.accel as V3));
    const fixtureUps: V3[] = [];
    for (const l of inWin) {
      const near = phoneWin.filter((p) => Math.abs(p.t - l.t) <= PHONE_PAIR_HALF_MS);
      if (near.length === 0) continue;
      fixtureUps.push(rotateXyzw(l.q, meanDir(near.map((p) => p.accel as V3)).dir));
    }
    if (fixtureUps.length < MIN_LOCKED_FRAMES) {
      return base({ reason: "no_phone_imu", text: "Waiting for the phone's motion sensor…" });
    }
    const fix = meanDir(fixtureUps);
    if (phone.sdDeg > MAX_PHONE_SD_DEG || fix.sdDeg > MAX_FIXTURE_UP_SD_DEG) {
      return base({ reason: "phone_moving", text: "Hold still — keep the phone and the fixture steady." });
    }

    // -- the fixture IMU: fresh, and at rest across the whole window -----------
    const v = s.view;
    if (s.tRecv < start || nowMs - s.tRecv > MAX_FEED_LAG_MS || !s.live) {
      return base({ reason: "sensor_stale", text: "Waiting for a fresh reading from the fixture…" });
    }
    const hz = v.sampleRateHz && v.sampleRateHz > 0 ? v.sampleRateHz : 100;
    const restMs = (v.restSamples / hz) * 1000;
    if (!v.atRest || v.restUpImu.length !== 3 || v.restSamples < MIN_REST_SAMPLES || restMs < STEADY_WINDOW_MS) {
      return base({ reason: "fixture_moving", text: "Hold the fixture still…" });
    }
    const imuUp = norm(v.restUpImu);

    // -- diversity + consistency against the poses already taken --------------
    const sep = separationFromAccepted(imuUp, this.poses);
    if (sep < MIN_POSE_SEPARATION_DEG) {
      const n = this.poses.length;
      return base(
        {
          reason: "too_close",
          text: `Too close to pose ${n} (${Math.round(sep)}° of ${MIN_POSE_SEPARATION_DEG}°) — tilt the fixture further.`,
        },
        sep,
      );
    }
    for (const p of this.poses) {
      const dImu = angleDeg(imuUp, p.imuUp);
      const dCam = angleDeg(fix.dir, p.fixtureUp);
      if (Math.abs(dImu - dCam) > MAX_INCONSISTENCY_DEG) {
        this.rejectedInconsistent++;
        return base(
          {
            reason: "inconsistent",
            text:
              `The camera saw a ${Math.round(dCam)}° turn but the sensor felt ${Math.round(dImu)}° — ` +
              "hold the phone still and keep the whole fixture in view.",
          },
          sep,
        );
      }
    }

    // -- take it ---------------------------------------------------------------
    const sigmaDeg = Math.hypot(
      Math.max(v.restUpSigmaDeg, 0.3),
      fix.sdDeg / Math.sqrt(fixtureUps.length),
      phone.sdDeg / Math.sqrt(phoneWin.length),
      PNP_SIGMA_DEG,
    );
    const pose: GravityPose = { imuUp, fixtureUp: fix.dir, sigmaDeg };
    this.poses.push(pose);
    if (this.poses.length >= POSES_REQUIRED) this.result = solveImuExtrinsic(this.poses, this.prior);
    const out = base(null, sep);
    out.captured = pose;
    return out;
  }
}

/** One-line description of a solve for the result panel. */
export function describeSolve(sol: ExtrinsicSolve): string {
  const yaw = Number.isFinite(sol.predictedYawErrDeg) ? `, heading ±${sol.predictedYawErrDeg.toFixed(1)}°` : "";
  return `Fit ${sol.quality}: residual ${sol.residualDeg.toFixed(1)}°${yaw}, poses ${Math.round(sol.separationDeg)}° apart`;
}
