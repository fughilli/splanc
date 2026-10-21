/**
 * Capture profile + the post-mapping IMU step (docs/design/sensor-core.md §7).
 *
 * A successful map capture records the parameters that worked (diffuse, LED
 * stride, anchor density, code timing, LED brightness, detector settings) ON
 * THE DEVICE next to the map (set_capture_profile; the device drops it when a
 * new map is uploaded). A later capture of the same fixture — a supplemental
 * scan, or the camera re-localisation of the IMU calibration — loads it instead
 * of re-asking or re-probing. Fixtures mapped before this existed have none and
 * keep today's sources (global diffuse pref, per-device stride, the probe).
 *
 * Pure functions here; capture.ts wires them in.
 */

import { solveImuExtrinsic, type QuatWxyz, type V3 } from "../geom/imuExtrinsic";

/** Wire shape of proto CaptureProfile (camelCase proto3 JSON). */
export interface CaptureProfileFlat {
  mapId: string;
  diffuse: boolean;
  strideSpacing: number;
  anchorDensity: number;
  symbols: number;
  bitPeriodMs: number;
  brightness: number;
  detectThreshold: number;
  downscale: number;
  lcGain: number;
  capturedAtMs: number;
}

/** The capture knobs a profile can pin. */
export interface CaptureKnobs {
  diffuse: boolean;
  strideSpacing: number;
  anchorDensity: number;
  threshold: number;
  downscale: number;
  lcGain?: number;
}

/** What a run should use, given its default knobs and the stored profile. */
export interface ProfiledRun {
  knobs: CaptureKnobs;
  /** Code timing to request instead of probing (both set, or neither). */
  symbols?: 2 | 4;
  bitPeriodMs?: number;
  /** LED brightness to start from (the servo still adjusts). */
  brightness?: number;
  /** True when the profile supplies the timing: skip "Measuring light…". */
  skipProbe: boolean;
  /** The profile that was applied (null = defaults; e.g. a pre-profile map). */
  applied: CaptureProfileFlat | null;
}

/** The stored profile if it belongs to `mapId` (else null: the device's map
 * changed since, or none was ever stored). */
export function profileForMap(p: CaptureProfileFlat | null | undefined, mapId: string): CaptureProfileFlat | null {
  if (!p || !p.mapId || p.mapId !== mapId) return null;
  return p;
}

export function applyProfile(defaults: CaptureKnobs, p: CaptureProfileFlat | null): ProfiledRun {
  if (p === null) return { knobs: defaults, skipProbe: false, applied: null };
  const knobs: CaptureKnobs = {
    diffuse: p.diffuse,
    strideSpacing: p.strideSpacing >= 1 ? Math.floor(p.strideSpacing) : defaults.strideSpacing,
    anchorDensity: p.anchorDensity >= 3 ? Math.floor(p.anchorDensity) : defaults.anchorDensity,
    threshold: p.detectThreshold > 0 ? p.detectThreshold : defaults.threshold,
    downscale: p.downscale >= 1 ? p.downscale : defaults.downscale,
    ...(p.lcGain > 0 ? { lcGain: p.lcGain } : defaults.lcGain !== undefined ? { lcGain: defaults.lcGain } : {}),
  };
  const timing = (p.symbols === 2 || p.symbols === 4) && p.bitPeriodMs > 0;
  return {
    knobs,
    ...(timing ? { symbols: p.symbols as 2 | 4, bitPeriodMs: p.bitPeriodMs } : {}),
    ...(p.brightness > 0 && p.brightness <= 1 ? { brightness: p.brightness } : {}),
    skipProbe: timing,
    applied: p,
  };
}

/** The profile a successful capture of `mapId` leaves behind. */
export function buildProfile(
  mapId: string,
  knobs: CaptureKnobs,
  timing: { symbols?: number; bitPeriodMs: number; brightness?: number },
  nowMs: number,
): CaptureProfileFlat {
  return {
    mapId,
    diffuse: knobs.diffuse,
    strideSpacing: knobs.strideSpacing,
    anchorDensity: knobs.anchorDensity,
    symbols: timing.symbols ?? 0,
    bitPeriodMs: timing.bitPeriodMs,
    brightness: timing.brightness ?? 0,
    detectThreshold: knobs.threshold,
    downscale: knobs.downscale,
    lcGain: knobs.lcGain ?? 0,
    capturedAtMs: nowMs,
  };
}

/** The per-map IMU calibration record kept in the app's map library. */
export interface ImuCalibrationRecord {
  /** R_fi, IMU -> map, [w, x, y, z]. */
  q: QuatWxyz;
  poses: { imuUp: V3; fixtureUp: V3; sigmaDeg: number }[];
  yawResolved: boolean;
  residualDeg: number;
  atMs: number;
}

/**
 * Pose 1 of the extrinsic calibration, for free at the end of mapping: the map
 * is gravity-levelled (+Y up) and the fixture hasn't moved, so the IMU's
 * settled up pairs with +Y. Gives the tilt (2 of 3 DOF); yaw keeps the prior
 * (the device's current mount) and stays flagged unresolved until a second,
 * re-oriented pose (the "Calibrate IMU" flow). Null when the IMU isn't settled.
 */
export function postMappingPose(
  sensor: { status: string; restUpImu: number[]; restUpSigmaDeg: number; restSamples: number; mountQuat: number[] },
  nowMs: number,
): ImuCalibrationRecord | null {
  if (sensor.status !== "SENSOR_STATUS_RUNNING" || sensor.restSamples < 20 || sensor.restUpImu.length !== 3) return null;
  const imuUp = sensor.restUpImu as V3;
  const pose = { imuUp, fixtureUp: [0, 1, 0] as V3, sigmaDeg: Math.max(sensor.restUpSigmaDeg, 0.5) };
  const prior = sensor.mountQuat.length === 4 ? (sensor.mountQuat as QuatWxyz) : undefined;
  const s = solveImuExtrinsic([pose], prior);
  return { q: s.q, poses: [pose], yawResolved: false, residualDeg: s.residualDeg, atMs: nowMs };
}
