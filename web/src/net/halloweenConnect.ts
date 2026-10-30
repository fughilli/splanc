/**
 * Connect to a Halloween fixture (`SpookySplanc1`, `SpookySplanc2`, …) over
 * Bluetooth for play mode — the ONE entry point the play screen calls
 * (.claude/halloween/CONTRACT.md "Seams").
 *
 *  - Web (Android Chrome): Web Bluetooth `requestDevice`, filtered to the exact
 *    name when the QR link carried one (`#/play?f=SpookySplanc1`), else every
 *    `SpookySplanc*`. The chooser MUST be the first await after the click (user
 *    gesture), so call this synchronously from the click handler.
 *  - Native (Capacitor iOS): `connectNativePlayer` (net/nativeBlePlayer.ts, the
 *    iOS agent's seam) scans and picks the strongest — no chooser, no gesture.
 *
 * Either way the link is handed to `appState.connect` with the same options
 * `connectOverBle` uses, so the rest of the app (pill, device sheet, effects,
 * Acid Mode) sees an ordinary connected device. A BLE device cannot be
 * reconnected after a page reload (the GATT object is gone), so play mode keeps
 * a big Reconnect button that calls this again.
 */

import { appState } from "../ui/app/state";
import { deviceStore } from "../store/deviceStore";
import { isNativePlatform } from "./native";
import { bleAvailable, bleDeviceUrl, bleSocketFactory, BLE_UPLOAD_CHUNK_BYTES, requestBleDevice } from "./bleTransport";

export const HALLOWEEN_NAME_PREFIX = "SpookySplanc";

export interface HalloweenConnectOptions {
  /** Exact advertised name, e.g. "SpookySplanc1" (from the QR link's `f=`). */
  name?: string;
}

export interface HalloweenConnection {
  /** deviceStore key (`ble:<id>`). */
  url: string;
  /** Display name (the advertised name). */
  label: string;
}

/** True where Bluetooth goes through the native wrapper instead of Web Bluetooth. */
export function isNativeBle(): boolean {
  return isNativePlatform();
}

/** True when this browser/app can reach a fixture at all. */
export function halloweenBleAvailable(): boolean {
  return isNativeBle() || bleAvailable();
}

/** A fixture name from the `f=` query, or undefined when absent/unsafe. Only
 * printable names are accepted (it goes straight into a BLE filter). */
export function parseFixtureName(raw: string | null | undefined): string | undefined {
  const s = (raw ?? "").trim();
  if (!s || s.length > 29 || !/^[\w .-]+$/.test(s)) return undefined;
  return s;
}

const CONNECT_OPTS = {
  // GATT link is reliable once open; give the initial discovery a few tries.
  coldRetryLimit: 6,
  // Shard uploads so each GATT frame fits the device's BLE reassembly buffer.
  uploadChunkBytes: BLE_UPLOAD_CHUNK_BYTES,
};

/**
 * Pick + connect a fixture. Resolves once the connect is STARTED (the app pill
 * then tracks it like any other device); rejects when the user cancels the
 * chooser (DOMException NotFoundError) or no fixture is found.
 */
export async function connectHalloweenFixture(opts: HalloweenConnectOptions = {}): Promise<HalloweenConnection> {
  if (isNativeBle()) {
    const { connectNativePlayer } = await import("./nativeBlePlayer");
    const link = await connectNativePlayer({
      ...(opts.name ? { name: opts.name } : {}),
      namePrefix: HALLOWEEN_NAME_PREFIX,
    });
    const url = `ble:${link.id}`;
    appState.connect(url, link.name, { socketFactory: link.socketFactory, ...CONNECT_OPTS });
    deviceStore.setBleId(url, link.id);
    return { url, label: link.name };
  }
  // FIRST await: the chooser needs the click's user gesture.
  const device = await requestBleDevice(opts.name ? { name: opts.name } : { namePrefix: HALLOWEEN_NAME_PREFIX });
  const label = device.name || opts.name || "Spooky Splanc";
  const url = bleDeviceUrl(device);
  appState.connect(url, label, { socketFactory: bleSocketFactory(device), ...CONNECT_OPTS });
  if (device.id) deviceStore.setBleId(url, device.id);
  return { url, label };
}

/** The user dismissed the chooser — not worth an error. */
export function isChooserCancel(e: unknown): boolean {
  return typeof DOMException !== "undefined" && e instanceof DOMException && (e.name === "NotFoundError" || e.name === "AbortError");
}
