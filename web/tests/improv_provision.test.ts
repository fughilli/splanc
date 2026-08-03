/**
 * Software-only exercise of the PRODUCTION provisioning path
 * (`provisionViaBle` in src/net/improv.ts) — the exact code the hosted app runs
 * to onboard a player. It's decoupled from Web Bluetooth via the `ImprovDevice`
 * gatt interface, so we drive it against a fake in-memory Improv peripheral that
 * mirrors the firmware device side (improv_ble.cpp / improv_codec.h): it parses
 * the wifi-settings RPC and answers on the RPC_RESULT / ERROR_STATE
 * characteristics with the same wire the C++ firmware emits.
 *
 * This covers the connect -> discover -> subscribe -> write -> await-result
 * state machine end to end, with no hardware and no navigator.bluetooth.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHAR_ERROR_STATE,
  CHAR_RPC_COMMAND,
  CHAR_RPC_RESULT,
  ERROR_UNABLE_TO_CONNECT,
  IMPROV_SERVICE,
  buildWifiSettings,
  provisionViaBle,
  type ImprovDevice,
} from "../src/net/improv";

// A GATT characteristic backed by memory: writes invoke a callback (the device
// logic), and emit() delivers a notification to subscribers exactly as Web
// Bluetooth's characteristicvaluechanged does (ev.target.value is a DataView).
class FakeChar {
  value?: DataView;
  private listeners: Array<(ev: { target: unknown }) => void> = [];
  constructor(private readonly onWrite?: (data: Uint8Array) => void) {}
  async startNotifications(): Promise<unknown> {
    return this;
  }
  addEventListener(_type: string, cb: (ev: { target: unknown }) => void): void {
    this.listeners.push(cb);
  }
  async writeValue(data: Uint8Array): Promise<void> {
    this.onWrite?.(data);
  }
  emit(bytes: Uint8Array): void {
    this.value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (const cb of this.listeners) cb({ target: this });
  }
}

/** Build an RPC_RESULT packet [cmd, total_len, (len, str)…, checksum] — the same
 * framing improv_build_result() emits on the firmware. */
function buildResult(url: string): Uint8Array {
  const enc = new TextEncoder().encode(url);
  const body = [0x01, enc.length + 1, enc.length, ...enc];
  const sum = body.reduce((a, b) => (a + b) & 0xff, 0);
  return new Uint8Array([...body, sum]);
}

interface FakeOpts {
  redirect?: string;
  errorCode?: number;
  failConnects?: number; // simulate Android's first-attempt GATT flake
}

function fakeDevice(opts: FakeOpts = {}): { device: ImprovDevice; writes: Uint8Array[] } {
  const result = new FakeChar();
  const errorState = new FakeChar();
  const writes: Uint8Array[] = [];
  const rpcCommand = new FakeChar((data) => {
    writes.push(data);
    // Device side: "join" then report back on the already-subscribed chars. A
    // small delay models the seconds-long join and, like real hardware, lands
    // after the app has attached its result/error listeners.
    setTimeout(() => {
      if (opts.errorCode) errorState.emit(new Uint8Array([opts.errorCode]));
      else result.emit(buildResult(opts.redirect ?? "http://192.168.1.50/"));
    }, 20);
  });
  const chars: Record<string, FakeChar> = {
    [CHAR_RPC_COMMAND]: rpcCommand,
    [CHAR_RPC_RESULT]: result,
    [CHAR_ERROR_STATE]: errorState,
  };
  let connects = 0;
  const device: ImprovDevice = {
    gatt: {
      async connect() {
        connects++;
        if (opts.failConnects && connects <= opts.failConnects) {
          throw new Error("GATT operation failed for unknown reason");
        }
        return {
          async getPrimaryService(uuid: string) {
            assert.equal(uuid, IMPROV_SERVICE);
            return {
              async getCharacteristic(u: string) {
                const c = chars[u];
                if (!c) throw new Error(`no characteristic ${u}`);
                return c;
              },
            };
          },
        };
      },
      disconnect() {},
    },
  };
  return { device, writes };
}

test("provisionViaBle: sends the correct wifi-settings wire and returns the redirect", async () => {
  const { device, writes } = fakeDevice({ redirect: "http://192.168.1.77/" });
  const statuses: string[] = [];
  const urls = await provisionViaBle(device, "FugLink", "bigblinkycube", (s) => statuses.push(s));

  assert.deepEqual(urls, ["http://192.168.1.77/"]);
  assert.equal(writes.length, 1, "exactly one RPC write");
  assert.deepEqual(
    Array.from(writes[0]!),
    Array.from(buildWifiSettings("FugLink", "bigblinkycube")),
    "the production path must emit the spec wifi-settings packet",
  );
  assert.ok(
    statuses.some((s) => /join/i.test(s)),
    "status should reach the join-wait phase",
  );
});

test("provisionViaBle: surfaces a device error notification as a rejection", async () => {
  const { device } = fakeDevice({ errorCode: ERROR_UNABLE_TO_CONNECT });
  await assert.rejects(
    () => provisionViaBle(device, "FugLink", "wrongpass"),
    /unable to connect/i,
  );
});

test("provisionViaBle: survives Android's first-attempt GATT flake via retry", async () => {
  const { device, writes } = fakeDevice({ redirect: "http://192.168.1.50/", failConnects: 2 });
  const urls = await provisionViaBle(device, "net", "pw");
  assert.deepEqual(urls, ["http://192.168.1.50/"]);
  assert.equal(writes.length, 1, "credentials written once, after the retries succeed");
});
