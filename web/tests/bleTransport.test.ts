/** BLE transport SocketLike wiring (src/net/bleTransport.ts) — drive a fake GATT
 * device and assert the send path frames+chunks and the notify path reassembles,
 * matching the firmware framing (improv_ble.cpp). No Web Bluetooth needed. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { BleSocket } from "../src/net/bleTransport";
import { FrameReassembler, frameWithLength } from "../src/net/bleFrame";

type Listener = (ev: { target: unknown }) => void;

/** A fake GATT characteristic: records writes; can fire notifications. */
class FakeChar {
  value?: DataView;
  writes: Uint8Array[] = [];
  private listeners: Listener[] = [];
  addEventListener(_type: string, cb: Listener): void {
    this.listeners.push(cb);
  }
  startNotifications(): Promise<unknown> {
    return Promise.resolve();
  }
  async writeValueWithResponse(data: BufferSource): Promise<void> {
    const u = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
    this.writes.push(u.slice());
  }
  async writeValue(data: BufferSource): Promise<void> {
    return this.writeValueWithResponse(data);
  }
  /** Simulate a device->app notification carrying `bytes`. */
  fire(bytes: Uint8Array): void {
    this.value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (const cb of this.listeners) cb({ target: this });
  }
}

class FakeDevice {
  rx = new FakeChar();
  tx = new FakeChar();
  gatt = {
    connect: async () => ({
      getPrimaryService: async (_uuid: string) => ({
        getCharacteristic: async (uuid: string) =>
          uuid.startsWith("9f5b0001") ? this.rx : this.tx,
      }),
    }),
    disconnect: () => undefined,
  };
  addEventListener(_type: string, _cb: () => void): void {}
}

const opened = (sock: BleSocket): Promise<void> =>
  new Promise((resolve) => {
    sock.onopen = () => resolve();
  });
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

test("BleSocket opens, frames+chunks the send, and reassembles notifications", async () => {
  const dev = new FakeDevice();
  const sock = new BleSocket(dev as never);
  await opened(sock);
  assert.equal(sock.readyState, 1); // OPEN

  // Send a payload larger than one GATT write unit (180) so it is chunked.
  const payload = Uint8Array.from({ length: 400 }, (_, i) => (i * 3) & 0xff);
  const received: Uint8Array[] = [];
  sock.onmessage = (ev) => received.push(ev.data as Uint8Array);
  sock.send(payload);
  await tick();
  await tick();

  // The RX characteristic saw the length-prefixed frame, split into <=180B writes.
  assert.ok(dev.rx.writes.length >= 3, `expected multiple chunks, got ${dev.rx.writes.length}`);
  for (const w of dev.rx.writes) assert.ok(w.length <= 180);
  const reassembled = dev.rx.writes.reduce((acc, w) => {
    const m = new Uint8Array(acc.length + w.length);
    m.set(acc);
    m.set(w, acc.length);
    return m;
  }, new Uint8Array(0));
  assert.deepEqual(Array.from(reassembled), Array.from(frameWithLength(payload)));

  // A framed reply split across two notifications reassembles into one message.
  const reply = Uint8Array.from({ length: 250 }, (_, i) => i & 0xff);
  const wire = frameWithLength(reply);
  dev.tx.fire(wire.subarray(0, 100));
  dev.tx.fire(wire.subarray(100));
  assert.equal(received.length, 1);
  assert.deepEqual(Array.from(received[0]!), Array.from(reply));
});

test("BleSocket ignores string sends (binary protocol only) and closes cleanly", async () => {
  const dev = new FakeDevice();
  const sock = new BleSocket(dev as never);
  await opened(sock);
  sock.send("not binary");
  await tick();
  assert.equal(dev.rx.writes.length, 0);

  let closed = false;
  sock.onclose = () => {
    closed = true;
  };
  sock.close();
  assert.equal(sock.readyState, 3); // CLOSED
  assert.ok(closed);
});

test("FrameReassembler and frameWithLength round-trip (transport uses both)", () => {
  const r = new FrameReassembler();
  const a = frameWithLength(Uint8Array.of(1, 2, 3));
  const out = r.push(a);
  assert.equal(out.length, 1);
  assert.deepEqual(Array.from(out[0]!), [1, 2, 3]);
});
