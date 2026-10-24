/**
 * Getting a solved IMU calibration ONTO the fixture, durably
 * (docs/design/sensor-core.md §7.3).
 *
 * The app keeps the solve as PENDING, keyed by the device's identity (its
 * welcome MAC), from the moment it is solved until the device has confirmed it:
 * a get_sensors read-back whose mount matches the solve. set_sensor_mount's own
 * reply is the state BEFORE the sensor task applies it, so it proves nothing;
 * the read-back does. The firmware persists the record to NVS (an atomic
 * nvs_set_blob + nvs_commit) in the same sensor-task iteration that applies it,
 * so a matching read-back means it survives a reboot.
 *
 * If the device drops before that (out of range, reboot, app backgrounded),
 * the pending entry stays, and every (re)connection to that device pushes it
 * again ({@link pushPendingImuCal}) until it is confirmed. A write that
 * reached the device but whose reply was lost is caught by the read-back
 * first: nothing is re-sent then.
 *
 * Pure TS: the client and the storage are interfaces (unit-tested).
 */

import { angleDeg, rotate, type QuatWxyz } from "../geom/imuExtrinsic";

/** A solved calibration waiting for (or confirmed by) the device. */
export interface PendingImuCal {
  /** Device identity (welcome MAC, upper-case). */
  deviceKey: string;
  /** The map the extrinsic is relative to (its mapId). */
  mapId: string;
  /** R_fi, [w, x, y, z]. */
  q: QuatWxyz;
  residualDeg: number;
  poses: number;
  yawResolved: boolean;
  /** When it was solved, unix ms (the device stores whole seconds). */
  atMs: number;
}

/** The mount fields of a sensor_state read-back. */
export interface MountReadback {
  status?: string;
  mountQuat: number[];
  mountExtrinsic: boolean;
  mountYawResolved: boolean;
  mountPoses: number;
  mountCalibratedAtMs: number;
  calibrationSeq?: number;
}

/** The parts of LedMapperClient the write-back needs. */
export interface MountClient {
  readonly isConnected: boolean;
  setSensorMount(
    quat: number[],
    meta: { residualDeg: number; poses: number; yawResolved: boolean; atMs?: number },
  ): Promise<MountReadback>;
  getSensors(): Promise<MountReadback>;
}

/** Minimal Storage (localStorage in the app, a Map in tests). */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Read-back mount within this of the solve counts as stored, degrees. */
export const MOUNT_MATCH_DEG = 0.5;

/** Normalized device key from a welcome MAC ("" when there is none). */
export function deviceKeyOf(mac: string | undefined | null): string {
  return (mac ?? "").trim().toUpperCase();
}

/** Angle between two rotations given as [w, x, y, z] (sign-insensitive), deg. */
export function quatAngleDeg(a: readonly number[], b: readonly number[]): number {
  if (a.length !== 4 || b.length !== 4) return Infinity;
  // Compare where each sends two basis vectors: robust to q / -q and to
  // unnormalized f32 round-trips.
  const qa = a as QuatWxyz;
  const qb = b as QuatWxyz;
  return Math.max(angleDeg(rotate(qa, [1, 0, 0]), rotate(qb, [1, 0, 0])), angleDeg(rotate(qa, [0, 1, 0]), rotate(qb, [0, 1, 0])));
}

/** Does the device's read-back hold exactly this calibration? */
export function mountMatches(s: MountReadback, cal: PendingImuCal): boolean {
  if (!s.mountExtrinsic || s.mountYawResolved !== cal.yawResolved) return false;
  if (s.mountPoses !== Math.min(cal.poses, 255)) return false;
  const atS = Math.floor(cal.atMs / 1000) * 1000;
  if (s.mountCalibratedAtMs !== 0 && s.mountCalibratedAtMs !== atS) return false;
  return quatAngleDeg(s.mountQuat, cal.q) <= MOUNT_MATCH_DEG;
}

/** Pending calibrations, one per device, persisted (localStorage). */
export class PendingImuCalStore {
  static readonly KEY = "ledmapper.imuCalPending";

  constructor(private readonly storage: KeyValueStorage | null) {}

  private read(): Record<string, PendingImuCal> {
    try {
      const raw = this.storage?.getItem(PendingImuCalStore.KEY);
      const v = raw ? (JSON.parse(raw) as unknown) : null;
      return v && typeof v === "object" ? (v as Record<string, PendingImuCal>) : {};
    } catch {
      return {};
    }
  }

  private write(all: Record<string, PendingImuCal>): void {
    try {
      if (Object.keys(all).length === 0) this.storage?.removeItem(PendingImuCalStore.KEY);
      else this.storage?.setItem(PendingImuCalStore.KEY, JSON.stringify(all));
    } catch {
      /* storage blocked: the in-flight write still runs */
    }
  }

  get(deviceKey: string): PendingImuCal | null {
    return this.read()[deviceKey] ?? null;
  }

  /** Record (or replace) the device's pending calibration. */
  put(cal: PendingImuCal): void {
    if (!cal.deviceKey) return;
    const all = this.read();
    all[cal.deviceKey] = cal;
    this.write(all);
  }

  /** Drop the device's pending entry — only if it is still `atMs`'s (a newer
   * calibration solved meanwhile stays pending). */
  clear(deviceKey: string, atMs?: number): void {
    const all = this.read();
    const cur = all[deviceKey];
    if (!cur || (atMs !== undefined && cur.atMs !== atMs)) return;
    delete all[deviceKey];
    this.write(all);
  }

  all(): PendingImuCal[] {
    return Object.values(this.read());
  }
}

export type WriteOutcome =
  /** The read-back matches: stored on the device. */
  | { kind: "confirmed"; wrote: boolean }
  /** The device answered but never reported this mount (refused, or its
   * sensor task isn't applying calibrations). */
  | { kind: "mismatch"; detail: string }
  /** The link failed (disconnected / timed out): try again on reconnect. */
  | { kind: "failed"; detail: string };

export interface WriteOptions {
  /** How long to poll the read-back after the write, ms. */
  verifyTimeoutMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Write `cal` and confirm it by read-back. Reads first, so a calibration the
 * device already holds (an earlier write whose reply was lost) is confirmed
 * without re-sending it.
 */
export async function writeAndVerify(c: MountClient, cal: PendingImuCal, opts: WriteOptions = {}): Promise<WriteOutcome> {
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const verifyMs = opts.verifyTimeoutMs ?? 4000;
  const pollMs = opts.pollMs ?? 150;
  if (!c.isConnected) return { kind: "failed", detail: "not connected" };
  try {
    if (mountMatches(await c.getSensors(), cal)) return { kind: "confirmed", wrote: false };
    await c.setSensorMount([...cal.q], {
      residualDeg: cal.residualDeg,
      poses: cal.poses,
      yawResolved: cal.yawResolved,
      atMs: cal.atMs,
    });
    const deadline = now() + verifyMs;
    let last: MountReadback | null = null;
    for (;;) {
      await sleep(pollMs);
      last = await c.getSensors();
      if (mountMatches(last, cal)) return { kind: "confirmed", wrote: true };
      if (now() >= deadline) break;
    }
    return {
      kind: "mismatch",
      detail: `device reports mount ${JSON.stringify(last?.mountQuat ?? [])} (yaw ${last?.mountYawResolved ? "resolved" : "unresolved"})`,
    };
  } catch (e) {
    // A server error reply (e.g. bad_mount) is the device refusing it; anything
    // else (not connected, timeout, socket closed) is the link.
    if (typeof (e as { code?: unknown }).code === "string") return { kind: "mismatch", detail: errText(e) };
    return { kind: "failed", detail: errText(e) };
  }
}

/** Optional: the map id the device holds now (null = unknown). A pending
 * calibration for a different map is stale and is dropped, not pushed. */
export type DeviceMapIdProbe = () => Promise<string | null>;

export type PushResult =
  | { kind: "none" }
  | { kind: "stale"; mapId: string; deviceMapId: string }
  | ({ cal: PendingImuCal } & WriteOutcome);

/**
 * On (re)connection: push the device's pending calibration, if any, and clear
 * it once confirmed. Anything short of a matching read-back keeps it pending
 * (one write per connection until the device holds it).
 */
export async function pushPendingImuCal(
  c: MountClient,
  store: PendingImuCalStore,
  deviceKey: string,
  opts: WriteOptions & { deviceMapId?: DeviceMapIdProbe } = {},
): Promise<PushResult> {
  const cal = store.get(deviceKey);
  if (!cal) return { kind: "none" };
  if (opts.deviceMapId) {
    const id = await opts.deviceMapId().catch(() => null);
    if (id !== null && id !== "" && cal.mapId !== "" && id !== cal.mapId) {
      store.clear(deviceKey, cal.atMs);
      return { kind: "stale", mapId: cal.mapId, deviceMapId: id };
    }
  }
  const out = await writeAndVerify(c, cal, opts);
  if (out.kind === "confirmed") store.clear(deviceKey, cal.atMs);
  return { cal, ...out };
}

/** The app's store (localStorage; a no-op store where it is unavailable). */
export const imuCalPending = new PendingImuCalStore(
  (() => {
    try {
      return typeof localStorage !== "undefined" ? localStorage : null;
    } catch {
      return null;
    }
  })(),
);
