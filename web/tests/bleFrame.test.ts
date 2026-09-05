/** BLE player-transport framing — pure length-prefix chunk/reassemble
 * (src/net/bleFrame.ts). Mirrors the device side in improv_ble.cpp. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { chunkBytes, frameWithLength, FrameReassembler } from "../src/net/bleFrame";

const bytes = (...v: number[]): Uint8Array => Uint8Array.from(v);

test("frameWithLength prefixes a u32 big-endian length", () => {
  assert.deepEqual(Array.from(frameWithLength(bytes(0xaa, 0xbb))), [0, 0, 0, 2, 0xaa, 0xbb]);
  assert.deepEqual(Array.from(frameWithLength(new Uint8Array(0))), [0, 0, 0, 0]);
  // A length that spans two bytes (258 = 0x0102).
  const big = frameWithLength(new Uint8Array(258));
  assert.deepEqual(Array.from(big.subarray(0, 4)), [0, 0, 0x01, 0x02]);
  assert.equal(big.length, 4 + 258);
});

test("chunkBytes splits into MTU-sized slices, last one short", () => {
  const src = Uint8Array.from({ length: 10 }, (_, i) => i);
  const chunks = chunkBytes(src, 4);
  assert.equal(chunks.length, 3);
  assert.deepEqual(Array.from(chunks[0]!), [0, 1, 2, 3]);
  assert.deepEqual(Array.from(chunks[1]!), [4, 5, 6, 7]);
  assert.deepEqual(Array.from(chunks[2]!), [8, 9]);
});

test("chunkBytes rejects a non-positive size", () => {
  assert.throws(() => chunkBytes(bytes(1, 2), 0));
});

test("reassembler recovers a frame split across arbitrary chunk boundaries", () => {
  const payload = Uint8Array.from({ length: 300 }, (_, i) => (i * 7) & 0xff);
  const wire = frameWithLength(payload);
  const r = new FrameReassembler();
  const out: Uint8Array[] = [];
  // Feed the wire bytes in 17-byte GATT notifications (prefix straddles a chunk).
  for (const c of chunkBytes(wire, 17)) out.push(...r.push(c));
  assert.equal(out.length, 1);
  assert.deepEqual(Array.from(out[0]!), Array.from(payload));
  assert.equal(r.pending, 0);
});

test("reassembler yields multiple frames coalesced into one chunk", () => {
  const a = frameWithLength(bytes(1, 2, 3));
  const b = frameWithLength(bytes(9));
  const merged = new Uint8Array(a.length + b.length);
  merged.set(a);
  merged.set(b, a.length);
  const r = new FrameReassembler();
  const out = r.push(merged);
  assert.equal(out.length, 2);
  assert.deepEqual(Array.from(out[0]!), [1, 2, 3]);
  assert.deepEqual(Array.from(out[1]!), [9]);
});

test("reassembler holds a partial frame until the remainder arrives", () => {
  const wire = frameWithLength(bytes(0xde, 0xad, 0xbe, 0xef));
  const r = new FrameReassembler();
  assert.deepEqual(r.push(wire.subarray(0, 3)), []); // only part of the length prefix
  assert.equal(r.pending, 3);
  assert.deepEqual(r.push(wire.subarray(3, 6)), []); // length complete, payload partial
  const out = r.push(wire.subarray(6));
  assert.equal(out.length, 1);
  assert.deepEqual(Array.from(out[0]!), [0xde, 0xad, 0xbe, 0xef]);
});

test("an empty chunk is a no-op", () => {
  const r = new FrameReassembler();
  assert.deepEqual(r.push(new Uint8Array(0)), []);
  const out = r.push(frameWithLength(bytes(42)));
  assert.deepEqual(Array.from(out[0]!), [42]);
});
