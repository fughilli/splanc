/**
 * Virtual BLE devices for the phone-in-the-loop HITL harness (and unit tests).
 *
 * These are software stand-ins for a real Improv-advertising splanc device,
 * implementing the exact `ImprovDevice` / `BleDevice` GATT seams the production
 * provisioning + player-transport code goes through. They mirror the firmware
 * device side (improv_ble.cpp / improv_codec.h): the Improv peripheral parses the
 * wifi-settings RPC and answers on RPC_RESULT / ERROR_STATE with the same wire the
 * C++ firmware emits.
 *
 * Used two ways, both off the production path:
 *  - the HITL app-driver substitutes these at `requestImprovDevice()` /
 *    `requestBleDevice()` when `driverActive()` (loaded via dynamic import, so this
 *    module never enters the production bundle); and
 *  - the provisioning / transport unit tests drive the real code against them.
 *
 * (Promoted from the in-line fakes in web/tests/improv_provision.test.ts and
 * web/tests/bleTransport.test.ts so there is one authoritative virtual device.)
 */

import type { BleDevice } from "./bleTransport";
import {
  CHAR_ERROR_STATE,
  CHAR_RPC_COMMAND,
  CHAR_RPC_RESULT,
  IMPROV_SERVICE,
  type ImprovDevice,
} from "./improv";

/** A GATT characteristic backed by memory: writes invoke a device-side callback,
 * and `emit()` delivers a notification to subscribers exactly as Web Bluetooth's
 * `characteristicvaluechanged` does (`ev.target.value` is a DataView). */
class VirtualChar {
  value?: DataView;
  writes: Uint8Array[] = [];
  private listeners: Array<(ev: { target: unknown }) => void> = [];
  constructor(private readonly onWrite?: (data: Uint8Array) => void) {}
  async startNotifications(): Promise<unknown> {
    return this;
  }
  addEventListener(_type: string, cb: (ev: { target: unknown }) => void): void {
    this.listeners.push(cb);
  }
  async writeValue(data: Uint8Array): Promise<void> {
    this.writes.push(data.slice());
    this.onWrite?.(data);
  }
  async writeValueWithResponse(data: BufferSource): Promise<void> {
    const u = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
    return this.writeValue(u);
  }
  emit(bytes: Uint8Array): void {
    this.value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (const cb of this.listeners) cb({ target: this });
  }
}

/** Build an RPC_RESULT packet `[cmd, total_len, (len, str)…, checksum]` — the same
 * framing `improv_build_result()` emits on the firmware. */
function buildRpcResult(url: string): Uint8Array {
  const enc = new TextEncoder().encode(url);
  const body = [0x01, enc.length + 1, enc.length, ...enc];
  const sum = body.reduce((a, b) => (a + b) & 0xff, 0);
  return new Uint8Array([...body, sum]);
}

export interface VirtualImprovOpts {
  /** URL the device reports on a successful join (its address on the network). */
  redirect?: string;
  /** If set, the device answers with this Improv error code instead of a redirect. */
  errorCode?: number;
  /** Fail the first N connect()s with the Android "GATT operation failed" flake,
   * so the production retry loop is exercised. */
  failConnects?: number;
  /** Modeled seconds-long WiFi-join delay before the device answers (ms). */
  joinDelayMs?: number;
  /** Records every write to the RPC_COMMAND characteristic (for assertions). */
  writes?: Uint8Array[];
}

/** A virtual Improv peripheral implementing `ImprovDevice` — provisioning-only. */
export function makeVirtualImprovDevice(opts: VirtualImprovOpts = {}): ImprovDevice {
  const result = new VirtualChar();
  const errorState = new VirtualChar();
  const rpcCommand = new VirtualChar((data) => {
    opts.writes?.push(data.slice());
    // Device side: "join" then report back on the already-subscribed chars.
    setTimeout(() => {
      if (opts.errorCode) errorState.emit(new Uint8Array([opts.errorCode]));
      else result.emit(buildRpcResult(opts.redirect ?? "http://192.168.1.50/"));
    }, opts.joinDelayMs ?? 20);
  });
  const chars: Record<string, VirtualChar> = {
    [CHAR_RPC_COMMAND]: rpcCommand,
    [CHAR_RPC_RESULT]: result,
    [CHAR_ERROR_STATE]: errorState,
  };
  let connects = 0;
  return {
    id: "virtual-improv-device",
    name: "Virtual Splanc",
    gatt: {
      async connect() {
        connects++;
        if (opts.failConnects && connects <= opts.failConnects) {
          throw new Error("GATT operation failed for unknown reason");
        }
        return {
          async getPrimaryService(uuid: string) {
            if (uuid !== IMPROV_SERVICE) throw new Error(`no service ${uuid}`);
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
}

/** A virtual player-protocol peripheral implementing `BleDevice` (the 9f5b GATT
 * service). Minimal: satisfies the connect-over-BLE journey's transport wiring;
 * the MVP runs the data plane over wss to a real device, so this loops back rather
 * than emulating the full player protocol. */
export function makeVirtualPlayerDevice(): BleDevice {
  const rx = new VirtualChar();
  const tx = new VirtualChar();
  return {
    id: "virtual-player-device",
    name: "Virtual Splanc",
    gatt: {
      async connect() {
        return {
          async getPrimaryService() {
            return {
              async getCharacteristic(uuid: string) {
                return uuid.startsWith("9f5b0001") ? rx : tx;
              },
            };
          },
        };
      },
      disconnect() {},
    },
    addEventListener() {},
  } as unknown as BleDevice;
}
