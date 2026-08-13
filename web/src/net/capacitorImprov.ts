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
  /** Advertised name. On iOS this is the scan-response local name — the piece
   * the plugin's built-in `requestDevice` picker can't show (it labels devices
   * "Unknown"), which is why we scan ourselves. Falls back to a generic label. */
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
  await BleClient.requestLEScan({ services: [IMPROV_SERVICE] }, (result) => {
    onHit({
      deviceId: result.device.deviceId,
      // localName is the advertisement/scan-response name; device.name matches it
      // on first sighting (iOS), then becomes the cached GAP name after connect.
      name: result.localName || result.device.name || "Splanc device",
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
