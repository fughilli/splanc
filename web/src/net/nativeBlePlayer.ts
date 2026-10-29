/**
 * Native (Capacitor) BLE player socket + connect-by-name, the iOS path to a
 * fixture over Bluetooth (Halloween installs; also the device sheet's "Connect
 * over Bluetooth (offline)" inside the app).
 *
 * WebKit has no Web Bluetooth, so on iOS `bleTransport.ts`'s `requestBleDevice`
 * can't reach the device's player GATT service. CoreBluetooth can, through
 * `@capacitor-community/bluetooth-le` — the same plugin `capacitorImprov.ts`
 * already uses for Improv provisioning.
 *
 * Nothing about the transport is forked: this module adapts the plugin to the
 * Web-Bluetooth-shaped `BleDevice` seam that `bleTransport.ts`'s `BleSocket`
 * already drives, so the SAME `BleSocket` (bleFrame.ts length-prefix framing,
 * 180 B write chunks, serialized writes, notify reassembly, disconnect → close)
 * runs unchanged on the native radio, and `BLE_UPLOAD_CHUNK_BYTES` keeps the
 * 1 KB upload windows. Only the device-discovery step is native: a short scan
 * that picks the fixture by exact name or by strongest RSSI — no chooser.
 *
 * The plugin is loaded with a dynamic import, so it never enters the PWA bundle;
 * every function here takes the plugin as an optional argument so tests can
 * drive a fake (tests/nativeBlePlayer.test.ts).
 */

import { BleSocket, PLAYER_SERVICE_UUID, type BleDevice } from "./bleTransport";
import type { SocketFactory } from "./client";
import { IMPROV_SERVICE } from "./improv";

/** The subset of `BleClient` (bluetooth-le) this module drives. Structural, so a
 * test fake needn't import the plugin. */
export interface NativeBlePlugin {
  initialize(options?: unknown): Promise<void>;
  requestLEScan(
    options: { services?: string[]; allowDuplicates?: boolean },
    callback: (result: {
      device: { deviceId: string; name?: string };
      localName?: string;
      rssi?: number;
    }) => void,
  ): Promise<void>;
  stopLEScan(): Promise<void>;
  getConnectedDevices(services: string[]): Promise<{ deviceId: string; name?: string }[]>;
  connect(deviceId: string, onDisconnect?: (deviceId: string) => void, options?: unknown): Promise<void>;
  disconnect(deviceId: string): Promise<void>;
  write(deviceId: string, service: string, characteristic: string, value: DataView): Promise<void>;
  startNotifications(
    deviceId: string,
    service: string,
    characteristic: string,
    callback: (value: DataView) => void,
  ): Promise<void>;
}

/** Load + initialize the real plugin (native wrapper only). `initialize` is
 * idempotent and is what raises the iOS Bluetooth permission prompt. */
export async function loadNativeBle(): Promise<NativeBlePlugin> {
  const { BleClient } = await import("@capacitor-community/bluetooth-le");
  await BleClient.initialize();
  return BleClient as unknown as NativeBlePlugin;
}

// --- The Web-Bluetooth-shaped adapter ---------------------------------------

type CharListener = (ev: { target: unknown }) => void;

/** One characteristic of a connected peripheral, mirroring the DOM
 * BluetoothRemoteGATTCharacteristic surface `BleSocket` touches. */
class NativeChar {
  value?: DataView;
  private readonly listeners: CharListener[] = [];

  constructor(
    private readonly ble: NativeBlePlugin,
    private readonly deviceId: string,
    private readonly service: string,
    private readonly uuid: string,
  ) {}

  async startNotifications(): Promise<void> {
    await this.ble.startNotifications(this.deviceId, this.service, this.uuid, (value) => {
      // Mirror the DOM event: stash the value, then fire listeners that read it
      // back off `ev.target.value` (exactly what BleSocket does).
      this.value = value;
      for (const l of this.listeners) l({ target: this });
    });
  }

  addEventListener(_type: string, cb: CharListener): void {
    this.listeners.push(cb);
  }

  async writeValueWithResponse(data: BufferSource): Promise<void> {
    // The plugin wants a DataView over exactly these bytes. BleSocket hands us a
    // fresh copy per chunk, so the view's backing buffer is the chunk itself.
    const view = ArrayBuffer.isView(data)
      ? new DataView(data.buffer, data.byteOffset, data.byteLength)
      : new DataView(data);
    // `write` is a write-WITH-response: CoreBluetooth paces it (one in flight per
    // characteristic; BleSocket serializes), so the device's RX never overruns.
    await this.ble.write(this.deviceId, this.service, this.uuid, view);
  }

  writeValue(data: BufferSource): Promise<void> {
    return this.writeValueWithResponse(data);
  }
}

/**
 * Adapt a scanned/known peripheral to the `BleDevice` seam `BleSocket` drives.
 *
 * - `gatt.connect()` → plugin `connect` (which on iOS also discovers services +
 *   characteristics before resolving), registering the plugin's disconnect
 *   callback so a dropped link fires `gattserverdisconnected` → `BleSocket`
 *   closes → `LedMapperClient` backs off and reconnects with a fresh socket.
 * - Characteristic wrappers are rebuilt per connect, so a reconnect re-subscribes
 *   notifications instead of reusing a dead subscription.
 */
export function nativeBleDevice(ble: NativeBlePlugin, deviceId: string, name?: string): BleDevice {
  const disconnectListeners: (() => void)[] = [];
  return {
    id: deviceId,
    ...(name ? { name } : {}),
    addEventListener(type: string, cb: () => void): void {
      if (type === "gattserverdisconnected") disconnectListeners.push(cb);
    },
    gatt: {
      async connect() {
        const chars = new Map<string, NativeChar>();
        await ble.connect(deviceId, () => {
          for (const l of disconnectListeners.slice()) l();
        });
        return {
          async getPrimaryService(service: string) {
            return {
              async getCharacteristic(uuid: string) {
                const key = `${service}|${uuid}`;
                let c = chars.get(key);
                if (!c) {
                  c = new NativeChar(ble, deviceId, service, uuid);
                  chars.set(key, c);
                }
                return c;
              },
            };
          },
        };
      },
      disconnect() {
        void ble.disconnect(deviceId).catch(() => undefined);
      },
    },
  };
}

/** A `SocketFactory` over the native radio: each call (incl. the client's
 * reconnects) opens a fresh GATT player socket — the shared `BleSocket`. */
export function nativeBleSocketFactory(ble: NativeBlePlugin, deviceId: string, name?: string): SocketFactory {
  const device = nativeBleDevice(ble, deviceId, name);
  return (_url: string) => new BleSocket(device);
}

// --- Connect-by-name (no chooser) -------------------------------------------

/** What `connectNativePlayer` returns (seam with net/halloweenConnect.ts). */
export interface NativePlayerLink {
  /** CoreBluetooth peripheral identifier (stable per phone) → url `ble:<id>`. */
  id: string;
  /** Advertised name, e.g. "SpookySplanc1". */
  name: string;
  /** Each call opens a fresh GATT player socket, like `bleSocketFactory`. */
  socketFactory: SocketFactory;
}

export interface NativePlayerScanOptions {
  /** Exact advertised name, e.g. "SpookySplanc1". Wins over `namePrefix`. */
  name?: string;
  /** Name prefix to match when no exact name is given, e.g. "SpookySplanc". */
  namePrefix: string;
  /** How long to listen before picking the strongest by RSSI (prefix mode). */
  scanMs?: number;
  /** Give up after this long with nothing matching. */
  maxScanMs?: number;
}

/** One candidate seen during the scan. */
export interface PlayerSighting {
  deviceId: string;
  name: string;
  /** Mean RSSI over this scan's sightings (dBm); undefined when unreported. */
  rssi?: number;
  /** Already connected to this phone (the scan can't see it — CoreBluetooth
   * reports connected peripherals only via getConnectedDevices). */
  connected?: boolean;
}

export const DEFAULT_SCAN_MS = 2500;
export const DEFAULT_MAX_SCAN_MS = 8000;

/** Does `name` match the options (exact name, else prefix)? */
export function nameMatches(name: string, opts: Pick<NativePlayerScanOptions, "name" | "namePrefix">): boolean {
  if (!name) return false;
  return opts.name ? name === opts.name : name.startsWith(opts.namePrefix);
}

/** Pick the target among the sightings. Exact-name mode returns that device;
 * prefix mode prefers a fixture this phone is already connected to (it is near
 * by definition), else the strongest mean RSSI. Null when nothing matches. */
export function pickPlayer(
  sightings: Iterable<PlayerSighting>,
  opts: Pick<NativePlayerScanOptions, "name" | "namePrefix">,
): PlayerSighting | null {
  let best: PlayerSighting | null = null;
  const score = (s: PlayerSighting): number => (s.connected ? Infinity : (s.rssi ?? -1000));
  for (const s of sightings) {
    if (!nameMatches(s.name, opts)) continue;
    if (!best || score(s) > score(best)) best = s;
  }
  return best;
}

/** Scan for players and pick one (see `pickPlayer`). Exact-name mode returns as
 * soon as that name is seen; prefix mode listens `scanMs`, then picks the
 * strongest, extending up to `maxScanMs` until anything matches. Rejects with a
 * human-readable Error when nothing matches in time. */
export async function scanForPlayer(ble: NativeBlePlugin, opts: NativePlayerScanOptions): Promise<PlayerSighting> {
  const scanMs = opts.scanMs ?? DEFAULT_SCAN_MS;
  const maxScanMs = Math.max(opts.maxScanMs ?? DEFAULT_MAX_SCAN_MS, scanMs);
  const seen = new Map<string, PlayerSighting & { rssiSum: number; rssiN: number }>();

  // A fixture this phone is already connected to (e.g. the app's previous
  // session) never shows up in a scan on iOS; ask CoreBluetooth for those.
  for (const svc of [PLAYER_SERVICE_UUID, IMPROV_SERVICE]) {
    try {
      for (const d of await ble.getConnectedDevices([svc])) {
        if (d.name && !seen.has(d.deviceId)) {
          seen.set(d.deviceId, { deviceId: d.deviceId, name: d.name, connected: true, rssiSum: 0, rssiN: 0 });
        }
      }
    } catch {
      // not supported / not initialized yet — the scan below still covers it
    }
  }
  const early = opts.name ? pickPlayer(seen.values(), opts) : null;
  if (early) return strip(early);

  return new Promise<PlayerSighting>((resolve, reject) => {
    let done = false;
    // Elapsed scan time, counted from our own timer steps (not the wall clock).
    let elapsed = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (out: PlayerSighting | Error): void => {
      if (done) return;
      done = true;
      if (timer !== undefined) clearTimeout(timer);
      void ble.stopLEScan().catch(() => undefined);
      if (out instanceof Error) reject(out);
      else resolve(strip(out));
    };
    const check = (): void => {
      const pick = pickPlayer(seen.values(), opts);
      if (pick) return finish(pick);
      const left = maxScanMs - elapsed;
      if (left <= 0) {
        const what = opts.name ? `"${opts.name}"` : `a ${opts.namePrefix} fixture`;
        return finish(new Error(`Couldn't find ${what} nearby. Move closer and make sure Bluetooth is on.`));
      }
      const step = Math.min(500, left);
      elapsed += step;
      timer = setTimeout(check, step);
    };

    // `allowDuplicates: true` is load-bearing on iOS: the name rides in the scan
    // RESPONSE, and the first callback for a peripheral often precedes it (no
    // name). Duplicates re-report it with the name, and give us RSSI samples to
    // average. Filtered on the Improv service, which every splanc board puts in
    // its primary advertisement (the player service is not advertised).
    ble
      .requestLEScan({ services: [IMPROV_SERVICE], allowDuplicates: true }, (r) => {
        if (done) return;
        // localName is the live scan-response name; device.name is CoreBluetooth's
        // cached GAP name, which can be stale after a rename — prefer localName.
        const name = r.localName || r.device.name || "";
        const id = r.device.deviceId;
        const prev = seen.get(id);
        const s = prev ?? { deviceId: id, name, rssiSum: 0, rssiN: 0 };
        if (name) s.name = name;
        if (typeof r.rssi === "number" && r.rssi < 0) {
          s.rssiSum += r.rssi;
          s.rssiN += 1;
          s.rssi = s.rssiSum / s.rssiN;
        }
        if (!prev) seen.set(id, s);
        // Exact name: no need to wait out the window.
        if (opts.name && nameMatches(s.name, opts)) finish(s);
      })
      .then(
        () => {
          if (!done && timer === undefined) {
            elapsed = scanMs;
            timer = setTimeout(check, scanMs);
          }
        },
        (e: unknown) => finish(new Error(`Bluetooth scan failed: ${e instanceof Error ? e.message : String(e)}`)),
      );
  });
}

function strip(s: PlayerSighting): PlayerSighting {
  return {
    deviceId: s.deviceId,
    name: s.name,
    ...(s.rssi !== undefined ? { rssi: s.rssi } : {}),
    ...(s.connected ? { connected: true } : {}),
  };
}

/**
 * Scan for players and return a link to the chosen one — exact `name` if given,
 * else the strongest-RSSI device whose name starts with `namePrefix`. No chooser.
 * Doesn't open the GATT link itself: the returned `socketFactory` does, when
 * handed to `appState.connect` (and again on each reconnect).
 */
export async function connectNativePlayer(
  opts: NativePlayerScanOptions,
  ble?: NativeBlePlugin,
): Promise<NativePlayerLink> {
  const plugin = ble ?? (await loadNativeBle());
  const pick = await scanForPlayer(plugin, opts);
  return {
    id: pick.deviceId,
    name: pick.name,
    socketFactory: nativeBleSocketFactory(plugin, pick.deviceId, pick.name),
  };
}
