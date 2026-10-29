/**
 * Native (Capacitor / CoreBluetooth) BLE player transport — SEAM for the iOS
 * agent (branch halloween/ios-ble; see .claude/halloween/play.md "SEAM").
 *
 * WebKit has no Web Bluetooth, so on iOS the Halloween play mode reaches the
 * fixture through this module instead of `requestBleDevice`. The contract:
 * scan (no chooser on iOS), pick the fixture, and hand back a SocketFactory whose
 * sockets speak the same length-prefixed GATT player stream as `BleSocket`
 * (net/bleTransport.ts), so `LedMapperClient` runs unchanged.
 *
 * This file is a STUB until the iOS agent's implementation lands; it is only
 * reached when `isNativeBle()` is true (net/halloweenConnect.ts).
 */

import type { SocketFactory } from "./client";

export interface NativePlayerLink {
  /** Stable-ish per-device id (the CoreBluetooth identifier) — keyed as `ble:<id>`. */
  id: string;
  /** Advertised name, e.g. "SpookySplanc1". */
  name: string;
  /** Each call opens a fresh GATT player socket (the client's reconnects call it again). */
  socketFactory: SocketFactory;
}

export interface NativePlayerQuery {
  /** Exact advertised name; when set, only that device is accepted. */
  name?: string;
  /** Otherwise the strongest-RSSI device whose name starts with this. */
  namePrefix: string;
  /** Scan window before giving up (ms). */
  scanMs?: number;
}

/** Scan for a player and return a link to it. Rejects with a human-readable
 * Error on timeout / nothing found / Bluetooth off. */
export async function connectNativePlayer(q: NativePlayerQuery): Promise<NativePlayerLink> {
  // TODO(halloween/ios-ble): CoreBluetooth scan via @capacitor-community/bluetooth-le,
  // pick `q.name` or the strongest `q.namePrefix*`, connect, and build a SocketLike
  // over the player service (PLAYER_SERVICE_UUID in bleTransport.ts).
  void q;
  throw new Error("Bluetooth in the iPhone app isn't wired up yet");
}
