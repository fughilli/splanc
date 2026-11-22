/**
 * Station calibration in lhd's on-disk format (~/.config/lighthouse/calibration.json,
 * @lighthouse daemon/src/store.rs), so a calibration moves between lhd and the page:
 *
 *   {"version":1,"stations":[{"id":…,"mode":…,"pose":[x,y,z,qw,qx,qy,qz],
 *     "cov":[36 numbers],"cal":[[phase,tilt,curve,gibphase,gibmag],[…]],
 *     "rms":…,"up_error":…}]}
 *
 * `pose` is world <- station (m, +Z up), quaternion w first. `cal` may be missing
 * (the station's OOTX broadcast supplies it then).
 */

import type { LhStation, Quat, Vec3 } from "./types";

export interface LhdStation {
  id: number;
  mode: number | null;
  pose: number[];
  cov: number[];
  cal?: number[][];
  rms?: number | null;
  up_error?: number | null;
}

export interface LhdCalibration {
  version: 1;
  stations: LhdStation[];
}

export const STORAGE_KEY = "splanc.lh.calibration";

function finite(xs: unknown, n: number, what: string): number[] {
  if (!Array.isArray(xs) || xs.length !== n || !xs.every((x) => typeof x === "number" && Number.isFinite(x))) {
    throw new Error(`calibration: ${what} needs ${n} numbers`);
  }
  return xs as number[];
}

/** Parses and checks lhd's calibration JSON; throws with what's wrong. */
export function parseCalibration(json: string): LhdCalibration {
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch (e) {
    throw new Error(`calibration: not JSON (${e instanceof Error ? e.message : String(e)})`);
  }
  const stations = (v as { stations?: unknown })?.stations;
  if (!Array.isArray(stations)) throw new Error("calibration: no stations array");
  return {
    version: 1,
    stations: stations.map((s: Record<string, unknown>, i) => {
      if (typeof s?.id !== "number") throw new Error(`calibration: station ${i} has no id`);
      const pose = finite(s.pose, 7, `station ${s.id} pose`);
      const cov = finite(s.cov, 36, `station ${s.id} cov`);
      let cal: number[][] | undefined;
      if (s.cal !== undefined && s.cal !== null) {
        if (!Array.isArray(s.cal) || s.cal.length !== 2) throw new Error(`calibration: station ${s.id} cal needs 2 axes`);
        cal = s.cal.map((a, k) => finite(a, 5, `station ${s.id} cal axis ${k}`));
      }
      return {
        id: s.id,
        mode: typeof s.mode === "number" ? s.mode : null,
        pose,
        cov,
        ...(cal ? { cal } : {}),
        rms: typeof s.rms === "number" ? s.rms : null,
        up_error: typeof s.up_error === "number" ? s.up_error : null,
      };
    }),
  };
}

/** lhd writes it pretty-printed (serde_json::to_string_pretty: two spaces). */
export function formatCalibration(c: LhdCalibration): string {
  return JSON.stringify({ version: 1, stations: c.stations }, null, 2);
}

/** The wasm's "calibrated" event (core.rs: stations with pose/cov/cal flat). */
export function fromCalibratedEvent(stations: unknown): LhdCalibration {
  const list = Array.isArray(stations) ? stations : [];
  return {
    version: 1,
    stations: list.map((s: Record<string, unknown>) => {
      const cal = Array.isArray(s.cal) && s.cal.length === 10 ? (s.cal as number[]) : null;
      return {
        id: s.id as number,
        mode: typeof s.mode === "number" ? s.mode : null,
        pose: s.pose as number[],
        cov: s.cov as number[],
        ...(cal ? { cal: [cal.slice(0, 5), cal.slice(5)] } : {}),
        rms: typeof s.rms === "number" ? s.rms : null,
        up_error: typeof s.up_error === "number" ? s.up_error : null,
      };
    }),
  };
}

export function stationsOf(c: LhdCalibration | null): LhStation[] {
  return (c?.stations ?? []).map((s) => ({
    id: s.id,
    pos: [s.pose[0], s.pose[1], s.pose[2]] as Vec3,
    quat: [s.pose[3], s.pose[4], s.pose[5], s.pose[6]] as Quat,
  }));
}

/** The subset of Web Storage used (localStorage, or a test double). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** localStorage, if this context has one that works (private mode, blocked site data). */
export function defaultStorage(): StorageLike | null {
  try {
    const s = (globalThis as { localStorage?: StorageLike }).localStorage;
    return s ?? null;
  } catch {
    return null;
  }
}

export function loadStored(storage: StorageLike | null): LhdCalibration | null {
  if (!storage) return null;
  try {
    const text = storage.getItem(STORAGE_KEY);
    return text ? parseCalibration(text) : null;
  } catch {
    return null;
  }
}

export function saveStored(storage: StorageLike | null, c: LhdCalibration | null): void {
  if (!storage) return;
  try {
    if (c && c.stations.length > 0) storage.setItem(STORAGE_KEY, formatCalibration(c));
    else storage.removeItem(STORAGE_KEY);
  } catch {
    // Quota / blocked storage: the calibration just isn't remembered.
  }
}
