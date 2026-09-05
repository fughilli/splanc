/**
 * Player-protocol transport over Bluetooth (Web Bluetooth / GATT).
 *
 * Why: accepting a device's self-signed TLS cert requires the browser to load
 * the device's https page, and a phone hotspot with no upstream internet
 * refuses to ("no internet, won't load") — so wss:// onboarding dead-ends. BLE
 * needs no cert, no LAN, no DHCP: it carries the full ledmapper.v1 protocol
 * offline. The device exposes a second GATT service alongside Improv (see
 * firmware/player_app/improv_ble.cpp): RX (app→device write) + TX (device→app
 * notify), a length-prefixed byte stream (bleFrame.ts).
 *
 * `BleSocket` implements the same `SocketLike` the WebSocket path uses, so it
 * drops straight into `LedMapperClient` via `socketFactory` — the client, its
 * chunked uploads, clock sync, and every RPC run unchanged over Bluetooth.
 */

import { FrameReassembler, chunkBytes, frameWithLength } from "./bleFrame";
import type { SocketFactory, SocketLike } from "./client";
import { IMPROV_SERVICE } from "./improv";

/** Player-transport GATT service + characteristics (must match the firmware
 * UUIDs in improv_ble.cpp). */
export const PLAYER_SERVICE_UUID = "9f5b0000-8a2e-4c1d-9b3a-1f0e2d3c4b5a";
const PLAYER_RX_UUID = "9f5b0001-8a2e-4c1d-9b3a-1f0e2d3c4b5a"; // app→device (write)
const PLAYER_TX_UUID = "9f5b0002-8a2e-4c1d-9b3a-1f0e2d3c4b5a"; // device→app (notify)

// GATT write unit. The device negotiates MTU 247 (ATT payload 244), but stacks
// vary — 180 leaves comfortable headroom and matches the firmware notify chunk.
const WRITE_CHUNK = 180;

// WebSocket.readyState values (SocketLike mirrors them).
const SOCK_CONNECTING = 0;
const SOCK_OPEN = 1;
const SOCK_CLOSED = 3;

// --- Minimal Web Bluetooth typings (hand-rolled; no @types/web-bluetooth dep,
// matching net/improv.ts) ----------------------------------------------------
interface BleGattChar {
  value?: DataView;
  startNotifications(): Promise<unknown>;
  addEventListener(type: string, cb: (ev: { target: unknown }) => void): void;
  writeValueWithResponse?(data: BufferSource): Promise<void>;
  writeValue(data: BufferSource): Promise<void>;
}
interface BleGattService {
  getCharacteristic(uuid: string): Promise<BleGattChar>;
}
interface BleGattServer {
  connect(): Promise<{ getPrimaryService(uuid: string): Promise<BleGattService> }>;
  disconnect(): void;
}
export interface BleDevice {
  id?: string;
  name?: string;
  gatt?: BleGattServer;
  addEventListener(type: string, cb: () => void): void;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** True if this browser exposes Web Bluetooth. */
export function bleAvailable(): boolean {
  return typeof navigator !== "undefined" && "bluetooth" in navigator;
}

/**
 * Show the Bluetooth chooser and return the picked device. MUST be the first
 * async call in a click handler — `requestDevice` demands an unconsumed user
 * gesture. We filter on the Improv service (every splanc device advertises it)
 * and list the player service as optional so we may use it after connecting.
 */
export async function requestBleDevice(): Promise<BleDevice> {
  const bt = (
    navigator as {
      bluetooth?: { requestDevice(o: unknown): Promise<unknown> };
    }
  ).bluetooth;
  if (!bt) throw new Error("Web Bluetooth is unavailable in this browser");
  return (await bt.requestDevice({
    filters: [{ services: [IMPROV_SERVICE] }],
    optionalServices: [PLAYER_SERVICE_UUID],
  })) as BleDevice;
}

/**
 * A `SocketLike` backed by the device's player GATT service. Connecting is
 * async (GATT discovery + subscribe) but the constructor returns immediately in
 * CONNECTING and fires `onopen`/`onclose` once settled — same contract as
 * WebSocket, so `LedMapperClient` treats it identically.
 */
export class BleSocket implements SocketLike {
  readyState: number = SOCK_CONNECTING;
  onopen: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;

  private readonly device: BleDevice;
  private rx: BleGattChar | null = null;
  private readonly reasm = new FrameReassembler();
  // GATT forbids overlapping writes; serialize them on a promise chain.
  private writeChain: Promise<void> = Promise.resolve();

  constructor(device: BleDevice) {
    this.device = device;
    void this.open();
  }

  private async open(): Promise<void> {
    try {
      const gatt = this.device.gatt;
      if (!gatt) throw new Error("device has no GATT server");
      // The device drops the link when the user leaves range / powers off; the
      // client's backoff makes a fresh BleSocket, so just report the close.
      this.device.addEventListener("gattserverdisconnected", () => this.fail());
      const server = await gatt.connect();
      // Some stacks resolve connect() before the link is usable (see improv.ts).
      await sleep(200);
      const svc = await server.getPrimaryService(PLAYER_SERVICE_UUID);
      this.rx = await svc.getCharacteristic(PLAYER_RX_UUID);
      const tx = await svc.getCharacteristic(PLAYER_TX_UUID);
      tx.addEventListener("characteristicvaluechanged", (ev) => {
        const dv = (ev.target as BleGattChar).value;
        if (!dv) return;
        const bytes = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
        for (const frame of this.reasm.push(bytes)) this.onmessage?.({ data: frame });
      });
      await tx.startNotifications();
      if (this.readyState !== SOCK_CONNECTING) return; // closed while opening
      this.readyState = SOCK_OPEN;
      this.onopen?.();
    } catch {
      this.fail();
    }
  }

  send(data: string | Uint8Array): void {
    // The player protocol is binary framing only; strings are never sent.
    if (typeof data === "string" || !this.rx || this.readyState !== SOCK_OPEN) return;
    const rx = this.rx;
    const chunks = chunkBytes(frameWithLength(data), WRITE_CHUNK);
    this.writeChain = this.writeChain.then(async () => {
      if (this.readyState !== SOCK_OPEN) return;
      try {
        for (const c of chunks) {
          // A subarray view's backing buffer is larger than the chunk; copy so
          // the GATT write sees exactly the chunk bytes.
          const buf = c.slice();
          if (rx.writeValueWithResponse) await rx.writeValueWithResponse(buf);
          else await rx.writeValue(buf);
        }
      } catch {
        this.fail();
      }
    });
  }

  close(): void {
    if (this.readyState === SOCK_CLOSED) return;
    try {
      this.device.gatt?.disconnect();
    } catch {
      // already down
    }
    this.fail();
  }

  private fail(): void {
    if (this.readyState === SOCK_CLOSED) return;
    this.readyState = SOCK_CLOSED;
    this.onclose?.();
  }
}

/** A `SocketFactory` bound to an already-picked device — hand to
 * `LedMapperClient`. The url is ignored (BLE has no address); each call (incl.
 * the client's reconnect) opens a fresh GATT link to the same device. */
export function bleSocketFactory(device: BleDevice): SocketFactory {
  return (_url: string) => new BleSocket(device);
}
