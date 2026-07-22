/**
 * Improv Wi-Fi BLE provisioning (https://www.improv-wifi.com/ble/) — the
 * player onboarding path (docs/esp32-led-mapping-plan.md).
 *
 * The soft-AP + bounce onboarding is a dead end: a phone joined to the
 * device's AP routes ALL traffic there, so the hosted app can never load.
 * Inverted flow instead: the user opens the HOSTED app on their normal
 * network, this module sends their WiFi credentials to the player over
 * Web Bluetooth (Improv is the ESPHome-established standard for exactly
 * this), the player joins the same LAN and answers with its address.
 *
 * Platform note: Web Bluetooth exists on Chrome (Android + desktop) but NOT
 * on iOS Safari — callers gate the UI on `bleAvailable()`; iOS keeps the
 * manual `?url=` path.
 *
 * The byte-level codec is pure and unit-tested (improv.test.ts); only
 * `provisionViaBle` touches navigator.bluetooth.
 */

// Improv BLE service + characteristic UUIDs (spec constants).
export const IMPROV_SERVICE = "00467768-6228-2272-4663-277478268000";
export const CHAR_CURRENT_STATE = "00467768-6228-2272-4663-277478268001";
export const CHAR_ERROR_STATE = "00467768-6228-2272-4663-277478268002";
export const CHAR_RPC_COMMAND = "00467768-6228-2272-4663-277478268003";
export const CHAR_RPC_RESULT = "00467768-6228-2272-4663-277478268004";
export const CHAR_CAPABILITIES = "00467768-6228-2272-4663-277478268005";

export const STATE_AUTHORIZATION_REQUIRED = 0x01;
export const STATE_AUTHORIZED = 0x02;
export const STATE_PROVISIONING = 0x03;
export const STATE_PROVISIONED = 0x04;

export const ERROR_NONE = 0x00;
export const ERROR_UNABLE_TO_CONNECT = 0x03;

const CMD_WIFI_SETTINGS = 0x01;

export const IMPROV_ERRORS: Record<number, string> = {
  0x01: "invalid RPC packet",
  0x02: "unknown RPC command",
  0x03: "unable to connect to the network (check SSID/password)",
  0x04: "not authorized (press the device's authorize button)",
  0xff: "unknown device error",
};

function checksum(bytes: Uint8Array): number {
  let sum = 0;
  for (const b of bytes) sum = (sum + b) & 0xff;
  return sum;
}

/** RPC packet for CMD_WIFI_SETTINGS: [cmd, len, ssid_len, ssid…,
 * pass_len, pass…, checksum]. */
export function buildWifiSettings(ssid: string, password: string): Uint8Array {
  const enc = new TextEncoder();
  const s = enc.encode(ssid);
  const p = enc.encode(password);
  if (s.length === 0 || s.length > 255 || p.length > 255) {
    throw new Error("SSID must be 1–255 bytes; password at most 255");
  }
  const data = new Uint8Array(2 + 1 + s.length + 1 + p.length + 1);
  let o = 0;
  data[o++] = CMD_WIFI_SETTINGS;
  data[o++] = 2 + s.length + p.length;
  data[o++] = s.length;
  data.set(s, o);
  o += s.length;
  data[o++] = p.length;
  data.set(p, o);
  o += p.length;
  data[o] = checksum(data.subarray(0, o));
  return data;
}

/** Parse an RPC result: [cmd, total_len, (len, str)…, checksum] → the
 * strings. Null when the packet is not a valid result for `cmd`. */
export function parseRpcResult(packet: Uint8Array, cmd = CMD_WIFI_SETTINGS): string[] | null {
  if (packet.length < 3 || packet[0] !== cmd) return null;
  const total = packet[1]!;
  if (packet.length < 2 + total + 1) return null;
  if (packet[2 + total] !== checksum(packet.subarray(0, 2 + total))) return null;
  const dec = new TextDecoder();
  const out: string[] = [];
  let o = 2;
  const end = 2 + total;
  while (o < end) {
    const n = packet[o++]!;
    if (o + n > end) return null;
    out.push(dec.decode(packet.subarray(o, o + n)));
    o += n;
  }
  return out;
}

/** The player's WS endpoint from Improv's redirect URL (the device answers
 * e.g. "http://192.168.1.50/"): ws on the bring-up port until TLS lands. */
export function wsUrlFromRedirect(redirect: string): string | null {
  try {
    const u = new URL(redirect);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    // The player speaks wss on 443 (TLS terminated on-device), so the hosted
    // https app can reach it directly — no mixed-content wall, no relay. Derive
    // that from whatever address the device reported (http://<ip>/ over BLE).
    // A one-time self-signed-cert accept (certApprovalUrl → https://<ip>/) is
    // handled by the connect flow.
    return `wss://${u.hostname}/ws`;
  } catch {
    return null;
  }
}

export function bleAvailable(): boolean {
  return typeof navigator !== "undefined" && "bluetooth" in navigator;
}

/** A picked Improv device (from `requestImprovDevice`). */
export interface ImprovDevice {
  gatt?: {
    connect(): Promise<{
      getPrimaryService(uuid: string): Promise<{
        getCharacteristic(uuid: string): Promise<BleChar>;
      }>;
    }>;
    disconnect(): void;
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Retry a GATT operation sequence. Android's Bluetooth stack routinely fails
 * the first connect / service-discovery with "GATT operation failed for
 * unknown reason", then succeeds on a retry — so wrap the whole
 * connect+discover block, not individual calls.
 */
export async function retryGatt<T>(
  fn: () => Promise<T>,
  opts: {
    attempts?: number;
    onRetry?: (attempt: number, err: unknown) => void;
    delayMs?: (attempt: number) => number;
    sleepFn?: (ms: number) => Promise<void>;
  } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 4;
  const delayMs = opts.delayMs ?? ((a) => 400 * a);
  const sleepFn = opts.sleepFn ?? sleep;
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < attempts) {
        opts.onRetry?.(i, e);
        await sleepFn(delayMs(i));
      }
    }
  }
  throw lastErr;
}

/**
 * Show the Bluetooth device chooser. MUST be the first async thing the
 * click handler does: `requestDevice` demands an unconsumed user gesture,
 * and even a `prompt()` beforehand consumes it — so pick the device first,
 * ask for credentials after.
 */
export async function requestImprovDevice(): Promise<ImprovDevice> {
  const bt = (navigator as { bluetooth?: { requestDevice(o: unknown): Promise<unknown> } })
    .bluetooth;
  if (!bt) throw new Error("Web Bluetooth is unavailable in this browser");
  return (await bt.requestDevice({
    filters: [{ services: [IMPROV_SERVICE] }],
  })) as ImprovDevice;
}

/**
 * Provision a picked device: send credentials, await the device's redirect
 * URL strings (typically one: its http address on the joined network).
 */
export async function provisionViaBle(
  device: ImprovDevice,
  ssid: string,
  password: string,
  onStatus: (msg: string) => void = () => undefined,
): Promise<string[]> {
  const gatt = device.gatt;
  if (!gatt) throw new Error("device has no GATT server");
  onStatus("Connecting…");

  // Android's BLE stack flakes "GATT operation failed for unknown reason" on
  // the first attempt(s) — and NOT only at connect: service discovery,
  // startNotifications and writeValue fail the same way. The old code retried
  // just connect+discover, so a flake at subscribe/write threw the whole thing
  // and the user had to re-click. Wrap the ENTIRE GATT handshake (connect →
  // settle → discover → subscribe → send credentials) in the retry, with a
  // full disconnect between tries, so one button press succeeds.
  const { rpcResult, errorState } = await retryGatt(
    async () => {
      const server = await gatt.connect();
      // Some Android stacks resolve connect() before the link is really ready;
      // a short settle before the first GATT op avoids an immediate failure.
      await sleep(300);
      const service = await server.getPrimaryService(IMPROV_SERVICE);
      const rpcCommand = await service.getCharacteristic(CHAR_RPC_COMMAND);
      const rpcResult = await service.getCharacteristic(CHAR_RPC_RESULT);
      const errorState = await service.getCharacteristic(CHAR_ERROR_STATE);
      // Subscribe BEFORE writing so the device's reply is never missed; both
      // of these are inside the retry because they flake too.
      await rpcResult.startNotifications();
      await errorState.startNotifications();
      onStatus("Sending WiFi credentials…");
      await rpcCommand.writeValue(buildWifiSettings(ssid, password));
      return { rpcResult, errorState };
    },
    {
      attempts: 5,
      onRetry: (attempt) => {
        try {
          gatt.disconnect(); // clean slate — the next connect re-discovers
        } catch {
          // already disconnected — fine
        }
        onStatus(`Connecting (retry ${attempt})…`);
      },
    },
  );

  // Network-join phase: the player now tries to join WiFi and reports back on
  // the (already-subscribed) result/error notifications. The device joins
  // seconds after the write, so attaching listeners here misses nothing. This
  // is NOT a GATT flake, so it is not wrapped in the BLE retry — just a
  // generous timeout.
  onStatus("Waiting for the player to join the network…");
  return new Promise<string[]>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("timed out waiting for the player to join the network")),
      45_000,
    );
    rpcResult.addEventListener("characteristicvaluechanged", (ev) => {
      const dv = (ev.target as BleChar).value;
      if (!dv) return;
      const strings = parseRpcResult(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength));
      if (strings) {
        clearTimeout(timer);
        resolve(strings);
      }
    });
    errorState.addEventListener("characteristicvaluechanged", (ev) => {
      const dv = (ev.target as BleChar).value;
      const code = dv && dv.byteLength > 0 ? dv.getUint8(0) : 0;
      if (code !== ERROR_NONE) {
        clearTimeout(timer);
        reject(new Error(IMPROV_ERRORS[code] ?? `device error ${code}`));
      }
    });
  });
}

interface BleChar {
  value?: DataView;
  startNotifications(): Promise<unknown>;
  addEventListener(type: string, cb: (ev: { target: unknown }) => void): void;
  writeValue(data: Uint8Array): Promise<void>;
}
