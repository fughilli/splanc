/**
 * A synthetic LhTracking for `?mock=1`: two fake base stations and a stylus that
 * wanders through the space in front of them, so the whole page works with no
 * hardware. `setScenario("pivot")` makes the stylus rock round a fixed tip instead
 * (to exercise the pivot calibration), with the tip offset of a real stylus.
 */

import { add, mulMV, quatFromAxisAngle, quatMul, quatToMat, matToQuat, normalize, cross, sub, type Mat3 } from "../frames";
import type { LhPose, LhStation, LhStatus, LhTracking, Quat, Vec3 } from "./types";

export const MOCK_SERIAL = "LHR-MOCK0001";
/** The mock stylus's true tip (stylus frame, m): the real LHR-10F97524's pivot result. */
export const MOCK_TIP: Vec3 = [0.0217, 0.0022, 0.1845];
/** Where the mock world's "lamp" stands (the mock lamp reports this pose). */
export const MOCK_LAMP_POS: Vec3 = [0.25, 0.05, 0.85];

export type MockScenario = "wander" | "pivot" | "still";

export interface MockTracking extends LhTracking {
  setScenario(s: MockScenario): void;
  scenario(): MockScenario;
}

/** World <- station for a station at `pos` looking at `target` (its -Z, the
 * lighthouse's optical axis in libsurvive's convention, towards the target). */
function lookAt(pos: Vec3, target: Vec3): Quat {
  const back = normalize(sub(pos, target)); // station +Z points away from the target
  const right = normalize(cross([0, 0, 1], back));
  const up = cross(back, right);
  const R: Mat3 = [right[0], up[0], back[0], right[1], up[1], back[1], right[2], up[2], back[2]];
  return matToQuat(R);
}

const STATIONS: LhStation[] = [
  { id: 0, pos: [-1.6, -1.4, 2.2], quat: lookAt([-1.6, -1.4, 2.2], [0.2, 0.1, 0.8]) },
  { id: 1, pos: [1.8, -1.2, 2.1], quat: lookAt([1.8, -1.2, 2.1], [0.2, 0.1, 0.8]) },
];

export interface MockOptions {
  /** ms between poses (default 1000/90, ~ a Vive tracker's IMU-fused rate). */
  periodMs?: number;
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (h: unknown) => void;
}

/** The mock stylus pose at time `t` (s) for a scenario: pure, for tests and the mock. */
export function mockStylusPose(t: number, scenario: MockScenario): { pos: Vec3; quat: Quat } {
  if (scenario === "pivot") {
    // Rock round a fixed tip point: tilt up to ~35° about a slowly turning axis.
    const tip: Vec3 = [0.1, -0.2, 0.75];
    const tilt = 0.6 * Math.sin(t * 0.9);
    const az = t * 0.7;
    const down: Quat = quatFromAxisAngle([1, 0, 0], Math.PI); // stylus +Z (tip) points down
    const rock = quatFromAxisAngle([Math.cos(az), Math.sin(az), 0], tilt);
    const q = quatMul(rock, down);
    const R = quatToMat(q);
    // tip = R c + t  =>  t = tip - R c
    const pos = sub(tip, mulMV(R, MOCK_TIP));
    return { pos, quat: q };
  }
  const s = scenario === "still" ? 0 : t;
  // The tip sweeps a slow Lissajous path round the lamp; the stylus points mostly down
  // and forward, turning as it goes.
  const tip: Vec3 = add(MOCK_LAMP_POS, [0.35 * Math.sin(s * 0.31), 0.3 * Math.sin(s * 0.23 + 1), 0.25 * Math.sin(s * 0.17)]);
  const yaw = 0.8 * Math.sin(s * 0.13);
  const pitch = Math.PI * 0.75 + 0.3 * Math.sin(s * 0.19);
  const q = quatMul(quatFromAxisAngle([0, 0, 1], yaw), quatFromAxisAngle([1, 0, 0], pitch));
  const pos = sub(tip, mulMV(quatToMat(q), MOCK_TIP));
  return { pos, quat: q };
}

export function createMockTracking(opts: MockOptions = {}): MockTracking {
  const periodMs = opts.periodMs ?? 1000 / 90;
  const now = opts.now ?? (() => performance.now());
  const setI = opts.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const clearI = opts.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  const poseSubs = new Set<(p: LhPose) => void>();
  const stationSubs = new Set<(s: LhStation[]) => void>();
  const statusSubs = new Set<(s: LhStatus) => void>();
  let timer: unknown = null;
  let scenario: MockScenario = "wander";
  let status: LhStatus = { state: "disconnected" };
  let stations: LhStation[] = [];
  let t0 = 0;
  let calibrated = true;

  const setStatus = (s: LhStatus): void => {
    status = s;
    for (const cb of statusSubs) cb(s);
  };
  const tick = (): void => {
    const t = now();
    const { pos, quat } = mockStylusPose((t - t0) / 1000, scenario);
    // A little tracking noise (0.3 mm), as lhd's poses have.
    const n = (): number => (Math.random() - 0.5) * 6e-4;
    const p: LhPose = { serial: MOCK_SERIAL, t, pos: [pos[0] + n(), pos[1] + n(), pos[2] + n()], quat, ok: true };
    for (const cb of poseSubs) cb(p);
  };

  return {
    async connect() {
      if (timer !== null) return;
      setStatus({ state: "connecting", detail: "mock Watchman" });
      t0 = now();
      stations = STATIONS.map((s) => ({ ...s }));
      for (const cb of stationSubs) cb(stations);
      setStatus({ state: "tracking", detail: `mock stylus ${MOCK_SERIAL}` });
      timer = setI(tick, periodMs);
    },
    async disconnect() {
      if (timer !== null) clearI(timer);
      timer = null;
      setStatus({ state: "disconnected" });
    },
    onPose(cb) {
      poseSubs.add(cb);
      return () => poseSubs.delete(cb);
    },
    onStations(cb) {
      stationSubs.add(cb);
      return () => stationSubs.delete(cb);
    },
    onStatus(cb) {
      statusSubs.add(cb);
      cb(status);
      return () => statusSubs.delete(cb);
    },
    stations: () => stations,
    exportCalibration: () => JSON.stringify({ mock: true, stations: STATIONS }, null, 1),
    importCalibration(json: string) {
      const doc = JSON.parse(json) as { stations?: LhStation[] };
      if (!Array.isArray(doc.stations)) throw new Error("no stations in this calibration");
      stations = doc.stations;
      for (const cb of stationSubs) cb(stations);
    },
    recalibrate() {
      if (!calibrated) return;
      calibrated = false;
      setStatus({ state: "calibrating", detail: "mock: settling stations" });
      setTimeout(() => {
        calibrated = true;
        stations = STATIONS.map((s) => ({ ...s }));
        for (const cb of stationSubs) cb(stations);
        setStatus({ state: timer !== null ? "tracking" : "disconnected", detail: `mock stylus ${MOCK_SERIAL}` });
      }, 1500);
    },
    setScenario(s: MockScenario) {
      scenario = s;
      t0 = now();
    },
    scenario: () => scenario,
  };
}
