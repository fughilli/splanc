/**
 * The map stored ON the connected device, as the Maps tab sees it.
 *
 * A fresh install (or a second phone) has an empty library, but the fixture
 * still holds the map it was given, and Calibrate IMU needs a local map. This
 * module works out what the device holds and gets it into the library:
 *
 *   - {@link DeviceMapService.probe} asks for ONE small get_stored_map window
 *     (the bundle's first ~192 bytes). The player serializes the bundle header
 *     first (store/src/lib.rs enc_map_src: map_id, units, frame, led_count, then
 *     the LEDs), so {@link parseBundleHeader} reads the map id + LED count from
 *     that prefix, and the reply carries the whole bundle's size. The id is
 *     matched against the library (mapStore.findByMapId): a captured map keeps
 *     its id when pushed, so a map this phone already has is "saved" without
 *     pulling anything.
 *   - Small bundles (<= autoPullMaxBytes) are pulled right away for the full
 *     mapped/interpolated count and a thumbnail; larger ones only on demand.
 *     Pulled bundles are cached for the session by device + id + size + prefix,
 *     so revisiting the Maps tab costs one small request.
 *   - {@link DeviceMapService.save} pulls (or reuses the cached bundle) and
 *     imports it; {@link DeviceMapService.ensureLocal} is the same but returns
 *     the existing local map when there is one (the Calibrate IMU entry points).
 *
 * All device requests go through one queue: the client allows a single pending
 * request per reply type, and a probe racing a pull would both use
 * stored_map_chunk.
 *
 * Pure TS: the client and the library are interfaces, so tests drive it with
 * the fake player (tests/deviceFakes.ts) and an in-memory library.
 */

import type { MappingBundle } from "../net/proto";

/** The parts of LedMapperClient this needs. */
export interface StoredMapSource {
  readonly isConnected: boolean;
  readonly welcome: { mac?: string; deviceName?: string; features?: string[] } | null;
  peekStoredMap(): Promise<{ totalLen: number; hasTopology: boolean; prefix: Uint8Array }>;
  pullStoredMap(onProgress?: (done: number, total: number) => void): Promise<MappingBundle>;
}

/** A library entry, as far as the card cares. */
export interface LocalMapRef {
  id: string;
  name: string;
  thumbnail?: string;
  /** Mapped / interpolated counts of the local copy, when known. */
  mapped?: number;
  interpolated?: number;
}

/** The parts of mapStore this needs. */
export interface DeviceMapLibrary {
  findByMapId(mapId: string): Promise<LocalMapRef | undefined>;
  importBundleObject(bundle: MappingBundle, opts: { source: "pull" }): Promise<string>;
}

/** The header fields readable from a bundle prefix. */
export interface BundleHeader {
  mapId: string;
  createdAt: string;
  units: string;
  frame: string;
  ledCount: number;
}

/** What the card shows about the device's map. */
export interface DeviceMapInfo {
  deviceName: string;
  mac: string;
  mapId: string;
  ledCount: number;
  /** "" when the bundle doesn't carry it (the C6 player's dump doesn't). */
  createdAt: string;
  /** Whole bundle size, bytes. */
  totalLen: number;
  hasTopology: boolean;
  /** Known once the full bundle has been pulled (or from the local copy). */
  mapped?: number;
  interpolated?: number;
}

export type DeviceMapCardState =
  /** No device connected: no card. */
  | { kind: "hidden" }
  /** The device's firmware can't hand its map back. */
  | { kind: "unsupported"; deviceName: string }
  | { kind: "loading"; deviceName: string }
  /** The device holds no map (error `no_map`). */
  | { kind: "none"; deviceName: string }
  /** The library already has this map. */
  | { kind: "saved"; info: DeviceMapInfo; local: LocalMapRef }
  /** Not in the library; `bundle` is set once pulled. */
  | { kind: "unsaved"; info: DeviceMapInfo; bundle?: MappingBundle }
  | { kind: "error"; deviceName: string; message: string };

export const DEFAULT_AUTO_PULL_MAX_BYTES = 16 * 1024;

// -- bundle header (protobuf prefix) ------------------------------------------

/** Read a varint at `pos`; null when the prefix ends inside it. */
function varint(b: Uint8Array, pos: number): [number, number] | null {
  let v = 0;
  let mul = 1;
  for (let i = pos; i < b.length && i < pos + 10; i++) {
    const byte = b[i]!;
    v += (byte & 0x7f) * mul;
    mul *= 128;
    if ((byte & 0x80) === 0) return [v, i + 1];
  }
  return null;
}

/**
 * Parse the OutputMap header from the first bytes of a serialized
 * MappingBundle: field 1 (map) is a length-delimited OutputMap whose fields
 * map_id(1), created_at(2), units(3), frame(4) and led_count(5) come before the
 * LEDs (6). Reads as far as the prefix allows and stops at the first LED, an
 * unknown field, or a truncated field. Null when the prefix isn't a bundle.
 */
export function parseBundleHeader(prefix: Uint8Array): BundleHeader | null {
  const outer = varint(prefix, 0);
  if (!outer || outer[0] !== 0x0a) return null; // field 1, wire type 2
  const len = varint(prefix, outer[1]);
  if (!len) return null;
  const h: BundleHeader = { mapId: "", createdAt: "", units: "", frame: "", ledCount: 0 };
  const end = Math.min(prefix.length, len[1] + len[0]);
  const text = new TextDecoder();
  let pos = len[1];
  while (pos < end) {
    const tag = varint(prefix, pos);
    if (!tag) break;
    const field = Math.floor(tag[0] / 8);
    const wire = tag[0] & 7;
    pos = tag[1];
    if (wire === 2 && field >= 1 && field <= 4) {
      const n = varint(prefix, pos);
      if (!n || n[1] + n[0] > prefix.length) break; // truncated string
      const s = text.decode(prefix.subarray(n[1], n[1] + n[0]));
      if (field === 1) h.mapId = s;
      else if (field === 2) h.createdAt = s;
      else if (field === 3) h.units = s;
      else h.frame = s;
      pos = n[1] + n[0];
    } else if (wire === 0 && field === 5) {
      const n = varint(prefix, pos);
      if (!n) break;
      h.ledCount = n[0];
      pos = n[1];
    } else {
      break; // the LEDs (or anything else): the header is over
    }
  }
  return h;
}

/** Mapped vs interpolated LEDs of a map: mapped = placed by the solve. */
export function ledCounts(map: { ledCount: number; leds: { id: number }[]; unmapped?: number[] }): {
  mapped: number;
  interpolated: number;
} {
  const unmapped = new Set(map.unmapped ?? []);
  let mapped = 0;
  for (const l of map.leds) if (!unmapped.has(l.id)) mapped++;
  const total = Math.max(map.ledCount | 0, mapped);
  return { mapped, interpolated: total - mapped };
}

/** Error code of a device error reply (ServerErrorReply carries `code`). */
function errorCode(e: unknown): string {
  if (e && typeof e === "object" && typeof (e as { code?: unknown }).code === "string") {
    return (e as { code: string }).code;
  }
  return "";
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** FNV-1a of the prefix: part of the cache key, so a device whose map changed
 * under the same id + size (a re-push of an edited map) isn't served stale. */
function fnv(b: Uint8Array): string {
  let h = 0x811c9dc5;
  for (const x of b) h = Math.imul(h ^ x, 0x01000193) >>> 0;
  return h.toString(16);
}

/** Whether a device advertises the stored-map dump. Older firmware without a
 * feature list is given the benefit of the doubt (an `unsupported` reply then
 * settles it). */
export function deviceSupportsStoredMap(w: StoredMapSource["welcome"]): boolean {
  const f = w?.features ?? [];
  return f.length === 0 || f.includes("stored_map");
}

// -- the service ----------------------------------------------------------------

interface Peeked {
  info: DeviceMapInfo;
  key: string;
}

export class DeviceMapService {
  private readonly bundles = new Map<string, MappingBundle>();
  private queue: Promise<unknown> = Promise.resolve();
  private last: { key: string; info: DeviceMapInfo; bundle: MappingBundle } | null = null;

  constructor(
    private readonly lib: DeviceMapLibrary,
    private readonly opts: { autoPullMaxBytes?: number } = {},
  ) {}

  /** Run `fn` after every earlier device request has settled. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async peek(src: StoredMapSource): Promise<Peeked> {
    const p = await this.serial(() => src.peekStoredMap());
    if (p.totalLen <= 0 || p.prefix.length === 0) throw Object.assign(new Error("no stored map"), { code: "no_map" });
    const h = parseBundleHeader(p.prefix);
    if (!h) throw new Error("the device sent an unreadable map");
    const w = src.welcome;
    const mac = w?.mac ?? "";
    const info: DeviceMapInfo = {
      deviceName: w?.deviceName || mac || "this device",
      mac,
      mapId: h.mapId,
      ledCount: h.ledCount,
      createdAt: h.createdAt,
      totalLen: p.totalLen,
      hasTopology: p.hasTopology,
    };
    return { info, key: `${mac}|${h.mapId}|${p.totalLen}|${fnv(p.prefix)}` };
  }

  private async pullKeyed(
    src: StoredMapSource,
    peeked: Peeked,
    onProgress?: (done: number, total: number) => void,
  ): Promise<MappingBundle> {
    let bundle = this.bundles.get(peeked.key);
    if (!bundle) {
      bundle = await this.serial(() => src.pullStoredMap(onProgress));
      this.bundles.set(peeked.key, bundle);
    }
    const counts = bundle.map ? ledCounts(bundle.map) : { mapped: 0, interpolated: 0 };
    peeked.info.mapped = counts.mapped;
    peeked.info.interpolated = counts.interpolated;
    this.last = { key: peeked.key, info: peeked.info, bundle };
    return bundle;
  }

  /** The card state for `src` (null/disconnected = hidden). */
  async probe(src: StoredMapSource | null): Promise<DeviceMapCardState> {
    if (!src || !src.isConnected) return { kind: "hidden" };
    const deviceName = src.welcome?.deviceName || src.welcome?.mac || "this device";
    if (!deviceSupportsStoredMap(src.welcome)) return { kind: "unsupported", deviceName };
    let peeked: Peeked;
    try {
      peeked = await this.peek(src);
    } catch (e) {
      const code = errorCode(e);
      if (code === "no_map") return { kind: "none", deviceName };
      if (code === "unsupported") return { kind: "unsupported", deviceName };
      return { kind: "error", deviceName, message: errorText(e) };
    }
    const { info } = peeked;
    const local = info.mapId ? await this.lib.findByMapId(info.mapId) : undefined;
    if (local) {
      if (local.mapped !== undefined) info.mapped = local.mapped;
      if (local.interpolated !== undefined) info.interpolated = local.interpolated;
      return { kind: "saved", info, local };
    }
    const cached = this.bundles.get(peeked.key);
    const max = this.opts.autoPullMaxBytes ?? DEFAULT_AUTO_PULL_MAX_BYTES;
    if (cached || info.totalLen <= max) {
      try {
        const bundle = await this.pullKeyed(src, peeked);
        return { kind: "unsaved", info, bundle };
      } catch {
        // The summary still stands; Preview / Save retry the pull.
      }
    }
    return { kind: "unsaved", info };
  }

  /** Pull the device's map into memory (cached) — the Preview action. */
  async pull(
    src: StoredMapSource,
    onProgress?: (done: number, total: number) => void,
  ): Promise<{ info: DeviceMapInfo; bundle: MappingBundle }> {
    const peeked = await this.peek(src);
    const bundle = await this.pullKeyed(src, peeked, onProgress);
    return { info: peeked.info, bundle };
  }

  /** Pull (or reuse the cached bundle) and import it; returns the library id
   * (an existing one when the library already holds this map id). */
  async save(src: StoredMapSource, onProgress?: (done: number, total: number) => void): Promise<string> {
    const { bundle } = await this.pull(src, onProgress);
    return this.lib.importBundleObject(bundle, { source: "pull" });
  }

  /** The library id of the device's map, pulling + saving it first when this
   * phone doesn't have it yet (the Calibrate IMU entry points). */
  async ensureLocal(src: StoredMapSource, onProgress?: (done: number, total: number) => void): Promise<string> {
    const peeked = await this.peek(src);
    const local = peeked.info.mapId ? await this.lib.findByMapId(peeked.info.mapId) : undefined;
    if (local) return local.id;
    const bundle = await this.pullKeyed(src, peeked, onProgress);
    return this.lib.importBundleObject(bundle, { source: "pull" });
  }

  /** The most recently pulled device map (the read-only preview's source). */
  lastPulled(): { info: DeviceMapInfo; bundle: MappingBundle } | null {
    return this.last ? { info: this.last.info, bundle: this.last.bundle } : null;
  }

  /** Forget cached bundles (e.g. after pushing a different map to the device). */
  clear(): void {
    this.bundles.clear();
    this.last = null;
  }
}

/** Route of the calibrate flow for a library map. */
export function calibrateRoute(localId: string): string {
  return `/capture?calibrate=${encodeURIComponent(localId)}`;
}

/** Whether a get_sensors reply means the IMU is up (Calibrate IMU is offered). */
export function imuRunning(s: { status?: string } | null | undefined): boolean {
  return s?.status === "SENSOR_STATUS_RUNNING";
}

/** A device that can report its motion sensor (LedMapperClient.getSensors). */
export interface SensorSource {
  readonly welcome: { features?: string[] } | null;
  getSensors(): Promise<{ status?: string }>;
}

/** Whether Calibrate IMU can run against this device: it serves the extrinsic
 * calibration (`imu_extrinsic`) and its sensor is running. Firmware without the
 * feature is never asked (an unknown get_sensors would never be answered). */
export async function deviceImuReady(src: SensorSource | null, timeoutMs = 4000): Promise<boolean> {
  if (!src || !(src.welcome?.features ?? []).includes("imu_extrinsic")) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((r) => {
    timer = setTimeout(() => r(null), timeoutMs);
  });
  try {
    return imuRunning(await Promise.race([src.getSensors(), timeout]));
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Calibrate IMU from the device (Maps card / device detail): make sure the
 * library holds the device's map (pull + save when it doesn't), then return
 * the calibrate route for it. */
export async function deviceCalibrationRoute(
  svc: DeviceMapService,
  src: StoredMapSource,
  onProgress?: (done: number, total: number) => void,
): Promise<string> {
  return calibrateRoute(await svc.ensureLocal(src, onProgress));
}
