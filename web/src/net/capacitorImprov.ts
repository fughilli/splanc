/**
 * Native (Capacitor) BLE transport for Improv provisioning — the iOS restore
 * path (docs/design/ios-support.md §4.2).
 *
 * WebKit has no Web Bluetooth, so on iOS `improv.ts` can't reach the device's
 * Improv GATT service. iOS's CoreBluetooth can, and Improv is just a GATT
 * service, so this module adapts `@capacitor-community/bluetooth-le` to the
 * SAME `ImprovDevice`/`gatt`/characteristic shape the Web Bluetooth path
 * produces. The pure byte-level codec (`buildWifiSettings`, `parseRpcResult`,
 * `wsUrlFromRedirect`) and the whole `provisionViaBle` state machine are reused
 * verbatim — only the transport underneath the seam changes.
 *
 * The plugin is loaded with a dynamic import so it never enters the PWA bundle;
 * this file is reached only when `isNativePlatform()` is true (see improv.ts).
 * Types are pulled in type-only (erased at build), so importing this module adds
 * no runtime weight until the dynamic import fires.
 */

import type { BleDevice, BleClient as BleClientType } from "@capacitor-community/bluetooth-le";
import { IMPROV_SERVICE, type ImprovDevice } from "./improv";

// The subset of a BLE characteristic the Improv flow drives (matches the shape
// improv.ts consumes on the Web Bluetooth path: startNotifications + a
// `characteristicvaluechanged` listener whose `ev.target.value` is a DataView,
// plus writeValue).
interface NativeCharListener {
  (ev: { target: NativeBleChar }): void;
}

class NativeBleChar {
  value?: DataView;
  private readonly listeners: NativeCharListener[] = [];

  constructor(
    private readonly ble: typeof BleClientType,
    private readonly deviceId: string,
    private readonly service: string,
    private readonly char: string,
  ) {}

  async startNotifications(): Promise<void> {
    await this.ble.startNotifications(this.deviceId, this.service, this.char, (value) => {
      // Mirror the Web Bluetooth event: stash the value, then fire listeners
      // that read it back off `ev.target.value` — provisionViaBle reads exactly
      // that (net/improv.ts).
      this.value = value;
      for (const l of this.listeners) l({ target: this });
    });
  }

  addEventListener(_type: "characteristicvaluechanged", cb: NativeCharListener): void {
    this.listeners.push(cb);
  }

  async writeValue(data: Uint8Array): Promise<void> {
    // Capacitor wants a DataView window over exactly these bytes.
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    await this.ble.write(this.deviceId, this.service, this.char, view);
  }
}

/** Wrap a connected Capacitor device in the `ImprovDevice` gatt seam. One
 * characteristic wrapper per UUID is cached so repeated `getCharacteristic`
 * calls (and their listeners) address the same object, as the DOM API does. */
function toImprovDevice(ble: typeof BleClientType, dev: BleDevice): ImprovDevice {
  const chars = new Map<string, NativeBleChar>();
  const getChar = (uuid: string): NativeBleChar => {
    let c = chars.get(uuid);
    if (!c) {
      c = new NativeBleChar(ble, dev.deviceId, IMPROV_SERVICE, uuid);
      chars.set(uuid, c);
    }
    return c;
  };

  const service = {
    async getCharacteristic(uuid: string): Promise<NativeBleChar> {
      return getChar(uuid);
    },
  };

  return {
    id: dev.deviceId,
    // Only set `name` when present — the seam's `name?: string` is exact-optional.
    ...(dev.name !== undefined ? { name: dev.name } : {}),
    gatt: {
      async connect() {
        // A fresh connect must re-discover: drop any cached char wrappers so
        // their notification subscriptions are re-established (retryGatt in
        // improv.ts disconnects and re-connects between attempts).
        chars.clear();
        await ble.connect(dev.deviceId);
        return {
          async getPrimaryService(_uuid: string) {
            return service;
          },
        };
      },
      disconnect() {
        void ble.disconnect(dev.deviceId).catch(() => undefined);
      },
    },
  };
}

/** One device sighting from a native BLE scan. */
export interface ImprovScanHit {
  deviceId: string;
  /** Advertised name, or "" when this sighting carried none yet. On iOS the name is
   * the scan-response local name (the primary ADV holds only Flags + the Improv
   * service UUID, so it fills the 31-byte PDU and the name MUST go in the scan
   * response) — and CoreBluetooth often delivers the first discovery callback for a
   * peripheral BEFORE its scan response arrives, so `name` is empty on that sighting
   * and populated on a later one. Callers keep the best name seen and supply their own
   * display fallback; they must NOT treat "" as the device's real name. */
  name: string;
  rssi?: number;
}

export interface ImprovScan {
  stop(): Promise<void>;
}

/**
 * Start a native BLE scan filtered to the Improv service, reporting each device
 * sighting (WITH its advertised name) to `onHit`. The caller drives its own
 * picker UI (ui/screens/blePicker.ts) and calls `stop()` when done — this
 * replaces the plugin's built-in chooser so devices show as `splanc-…` rather
 * than "Unknown" on iOS (docs/design/ios-support.md §4.2).
 */
export async function scanImprovNative(onHit: (hit: ImprovScanHit) => void): Promise<ImprovScan> {
  const { BleClient } = await import("@capacitor-community/bluetooth-le");
  await BleClient.initialize();
  // `allowDuplicates: true` is LOAD-BEARING on iOS. The Improv boards advertise the
  // service UUID in the primary ADV and the NAME in the scan response (the 128-bit
  // UUID + flags already fill the 31-byte legacy ADV). With the default
  // `allowDuplicates: false`, CoreBluetooth reports each peripheral exactly ONCE — and
  // that single callback often fires before the scan response is received, so
  // `localName` is empty and the board surfaces WITHOUT its name. On a crowded bench
  // that made our reserved "Led Widget <hex>" board appear nameless most scans, so the
  // name-pinned pick (harness.ts) missed it (~1 in 5 scans it happened to coalesce the
  // name in time — the reported flakiness). Allowing duplicates re-reports each
  // peripheral on later advertising events, which DO carry the merged scan-response
  // name, so the real name arrives within the scan window. (A short HITL/provisioning
  // scan, not a background one — the extra callbacks are cheap and we stop promptly.)
  await BleClient.requestLEScan({ services: [IMPROV_SERVICE], allowDuplicates: true }, (result) => {
    onHit({
      deviceId: result.device.deviceId,
      // localName is the scan-response name; device.name is the cached GAP name after a
      // prior connect. Either may be absent on an early sighting — report "" then, and
      // let the caller keep the best name seen (never overwrite a real name with "").
      name: result.localName || result.device.name || "",
      ...(result.rssi !== undefined ? { rssi: result.rssi } : {}),
    });
  });
  return {
    async stop() {
      try {
        await BleClient.stopLEScan();
      } catch {
        // already stopped / never started — nothing to do
      }
    },
  };
}

/** Adapt a scanned device id to the `ImprovDevice` gatt seam so the shared
 * `provisionViaBle` state machine can drive it unchanged. */
export async function improvDeviceById(deviceId: string, name?: string): Promise<ImprovDevice> {
  const { BleClient } = await import("@capacitor-community/bluetooth-le");
  return toImprovDevice(BleClient, { deviceId, ...(name !== undefined ? { name } : {}) });
}
