/**
 * P4 demo page: the OSC codec (a port of the desktop demo's osc.py) and the OSC arms
 * of the session protocol (ClientMessage.osc / ServerMessage.osc) through the client.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { bundle, decode, describe, message, messageTyped } from "../src/p4demo/osc";
import { decodeClient, decodeServer, encodeClient, encodeServer } from "../src/net/proto";
import { LedMapperClient } from "../src/net/client";
import type { ClientMessage, ServerMessage } from "@ledmapper/protocol";

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

test("message: address, type tags and float32s padded as OSC 1.0 (osc.message)", () => {
  // Python: osc.message("/width", 0.5).hex()
  assert.equal(hex(message("/width", 0.5)), "2f776964746800002c6600003f000000");
  // An address that is a multiple of 4 long still gets a whole word of NULs.
  assert.equal(hex(message("/abc", 1)), "2f61626300000000" + "2c660000" + "3f800000");
});

test("messageTyped: ints and floats in order (the P4's /lh/station ,iffffff f)", () => {
  const m = messageTyped("/lh/station", { i: 1 }, 0.5, -1, 2, 1, 0, 0, 0);
  const [d] = decode(m);
  assert.equal(d!.address, "/lh/station");
  assert.deepEqual(d!.args, [1, 0.5, -1, 2, 1, 0, 0, 0]);
  // The tag string is ",iffffff" + "f" = ",ifffffff" (9 chars -> 12 bytes).
  const tagStart = 12; // "/lh/station" is 11 chars -> 12 bytes
  assert.equal(Buffer.from(m.subarray(tagStart, tagStart + 10)).toString(), ",ifffffff\0");
  assert.equal(m.length, 12 + 12 + 8 * 4);
});

test("strings round-trip", () => {
  const [d] = decode(messageTyped("/name", "lamp", 2));
  assert.deepEqual(d!.args, ["lamp", 2]);
});

test("bundle: '#bundle', immediate time tag, length-prefixed elements; decode flattens", () => {
  const a = message("/plane", 0, 0, 1, 0.9);
  const b = message("/width", 0.01);
  const pkt = bundle(a, b);
  assert.equal(Buffer.from(pkt.subarray(0, 8)).toString(), "#bundle\0");
  assert.equal(hex(pkt.subarray(8, 16)), "0000000000000001");
  assert.equal(new DataView(pkt.buffer).getInt32(16, false), a.length);
  const out = decode(pkt);
  assert.deepEqual(out.map((m) => m.address), ["/plane", "/width"]);
  assert.ok(Math.abs((out[0]!.args[3] as number) - 0.9) < 1e-6);
  assert.ok(Math.abs((out[1]!.args[0] as number) - 0.01) < 1e-7);
});

test("decode: /lh/pose as the P4 tracker module sends it", () => {
  const pkt = message("/lh/pose", 1, 0.1, 0.2, 0.9, 1, 0, 0, 0);
  const [m] = decode(pkt);
  assert.equal(m!.address, "/lh/pose");
  assert.equal(m!.args.length, 8);
  assert.match(describe(m!), /^\/lh\/pose 1 0\.1 0\.2 0\.9 1 0 0 0$/);
});

test("decode: rejects malformed packets", () => {
  assert.throws(() => decode(new Uint8Array([0x2f, 0x61])), /not terminated/);
  const bad = message("/x", 1).slice(0, 10); // tag string present, argument cut
  assert.throws(() => decode(bad));
  const weird = new Uint8Array([...message("/x"), 0]);
  weird.set(new TextEncoder().encode(",b\0\0"), 4);
  assert.throws(() => decode(weird), /unsupported/);
});

class FakeSocket {
  readyState = 0;
  binaryType?: string;
  sent: Uint8Array[] = [];
  onopen: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(msg: unknown): void {
    this.onmessage?.({ data: encodeServer(msg as ServerMessage) });
  }
  send(data: Uint8Array): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

test("LedMapperClient.sendOsc / onOsc: OSC out in the session, module replies fanned out", async () => {
  const sockets: FakeSocket[] = [];
  const client = new LedMapperClient("ws://test/ws", {
    socketFactory: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    now: () => 1000,
    schedule: () => {},
  });
  // Not connected: nothing goes out.
  assert.equal(client.sendOsc(message("/x", 1)), false);
  const p = client.connect();
  const s = sockets[0]!;
  s.open();
  s.receive({
    type: "welcome",
    sessionId: "s-1",
    codeParams: { ledCount: 1, bits: 1, encoding: "hue", symbols: 2, bitPeriodMs: 100, syncPattern: "on_off", cycleFrames: 8 },
    solverBenchMs: null,
    features: ["osc"],
  });
  await p;
  const pkt = message("/plane", 0, 0, 1, 1);
  assert.equal(client.sendOsc(pkt), true);
  const sent = decodeClient(s.sent[s.sent.length - 1]!) as unknown as { type: string; packet: Uint8Array };
  assert.equal(sent.type, "osc");
  assert.deepEqual([...sent.packet], [...pkt]);

  const got: Uint8Array[] = [];
  const unsub = client.onOsc((b) => got.push(b));
  s.receive({ type: "osc", packet: message("/lh/pose", 1, 0, 0, 1, 1, 0, 0, 0) });
  assert.equal(got.length, 1);
  assert.equal(decode(got[0]!)[0]!.address, "/lh/pose");
  unsub();
  s.receive({ type: "osc", packet: message("/lh/pose", 0, 0, 0, 1, 1, 0, 0, 0) });
  assert.equal(got.length, 1);
  client.close();
});

test("session protocol: ClientMessage.osc / ServerMessage.osc carry the packet bytes", () => {
  const pkt = message("/plane", 0, 0, 1, 1.25);
  const wire = encodeClient({ type: "osc", packet: pkt } as unknown as ClientMessage);
  const back = decodeClient(wire) as unknown as { type: string; packet: Uint8Array };
  assert.equal(back.type, "osc");
  assert.deepEqual([...back.packet], [...pkt]);
  // Field 110, length-delimited: tag varint (110 << 3 | 2) = 0xf2 0x06.
  assert.equal(wire[0], 0xf2);
  assert.equal(wire[1], 0x06);

  const pose = message("/lh/pose", 1, 0, 0, 1, 1, 0, 0, 0);
  const s = encodeServer({ type: "osc", packet: pose } as unknown as ServerMessage);
  assert.equal(s[0], 0xe2); // field 60: (60 << 3 | 2) = 482 = 0xe2 0x03
  assert.equal(s[1], 0x03);
  const msg = decodeServer(s) as unknown as { type: string; packet: Uint8Array };
  assert.equal(msg.type, "osc");
  assert.deepEqual(decode(msg.packet)[0]!.args.length, 8);
});
