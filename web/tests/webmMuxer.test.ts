/**
 * webmMuxer (src/fx/webmMuxer.ts) — the vendored minimal WebM muxer. Verifies
 * the EBML/vint size encoding and that a muxed clip has the structural markers a
 * player needs: the EBML magic, DocType "webm", the codec id, and a SimpleBlock.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { encodeSize, muxWebm } from "../src/fx/webmMuxer";

/** Index of the first occurrence of `needle` in `hay`, or -1. */
function indexOf(hay: Uint8Array, needle: number[]): number {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

function ascii(s: string): number[] {
  return [...s].map((c) => c.charCodeAt(0));
}

test("encodeSize picks the minimal vint width and sets the length marker", () => {
  assert.deepEqual(encodeSize(0), [0x80]);
  assert.deepEqual(encodeSize(1), [0x81]);
  assert.deepEqual(encodeSize(126), [0xfe]); // still fits in 7 bits
  // 127 is the 1-byte "unknown size" sentinel, so it must spill to 2 bytes.
  assert.deepEqual(encodeSize(127), [0x40, 0x7f]);
  // 0x4000 needs 3 bytes: 14-bit max (0x3FFF) is the 2-byte "unknown" sentinel.
  assert.deepEqual(encodeSize(0x4000), [0x20, 0x40, 0x00]);
});

test("muxWebm emits a well-formed EBML/webm container", () => {
  const bytes = muxWebm({
    width: 2,
    height: 2,
    codec: "V_VP8",
    durationMs: 33,
    frames: [
      { data: new Uint8Array([1, 2, 3, 4]), timestampMs: 0, key: true },
      { data: new Uint8Array([5, 6, 7, 8]), timestampMs: 16, key: false },
    ],
  });

  // EBML magic 0x1A45DFA3 at the very start.
  assert.deepEqual([...bytes.slice(0, 4)], [0x1a, 0x45, 0xdf, 0xa3]);
  // DocType "webm" and the codec id are present.
  assert.ok(indexOf(bytes, ascii("webm")) >= 0, "DocType webm");
  assert.ok(indexOf(bytes, ascii("V_VP8")) >= 0, "codec id");
  // Segment (0x18538067), Tracks (0x1654AE6B) and a Cluster (0x1F43B675).
  assert.ok(indexOf(bytes, [0x18, 0x53, 0x80, 0x67]) >= 0, "Segment");
  assert.ok(indexOf(bytes, [0x16, 0x54, 0xae, 0x6b]) >= 0, "Tracks");
  assert.ok(indexOf(bytes, [0x1f, 0x43, 0xb6, 0x75]) >= 0, "Cluster");
  // Both frame payloads survive into the stream.
  assert.ok(indexOf(bytes, [1, 2, 3, 4]) >= 0, "keyframe payload");
  assert.ok(indexOf(bytes, [5, 6, 7, 8]) >= 0, "delta payload");
});

test("muxWebm sizes nest exactly — a recursive EBML walk consumes the whole buffer", () => {
  const frames = Array.from({ length: 120 }, (_, i) => ({
    data: new Uint8Array([1, 2, 3, 4, 5]),
    timestampMs: Math.round((i * 1000) / 60),
    key: i % 60 === 0,
  }));
  const b = muxWebm({ width: 64, height: 64, codec: "V_VP9", durationMs: 2000, frames });

  // Minimal EBML reader: element = id (vint) + size (vint) + data.
  const readVint = (off: number): { val: number; len: number } => {
    let mask = 0x80;
    let len = 1;
    while (!(b[off]! & mask) && len <= 8) ((mask >>= 1), len++);
    let val = b[off]! & (mask - 1);
    for (let i = 1; i < len; i++) val = val * 256 + b[off + i]!;
    return { val, len };
  };
  const readId = (off: number): { id: number; len: number } => {
    let mask = 0x80;
    let len = 1;
    while (!(b[off]! & mask) && len <= 4) ((mask >>= 1), len++);
    let id = 0;
    for (let i = 0; i < len; i++) id = id * 256 + b[off + i]!;
    return { id, len };
  };
  // Master elements whose bodies are themselves elements (must recurse).
  const MASTERS = new Set([
    0x1a45dfa3, 0x18538067, 0x1549a966, 0x1654ae6b, 0xae, 0xe0, 0x1f43b675,
  ]);
  const walk = (start: number, end: number): void => {
    let off = start;
    while (off < end) {
      const { id, len: il } = readId(off);
      off += il;
      const { val: size, len: sl } = readVint(off);
      off += sl;
      const cend = off + size;
      assert.ok(cend <= end, `element 0x${id.toString(16)} overruns its parent`);
      if (MASTERS.has(id)) walk(off, cend);
      off = cend;
    }
    assert.equal(off, end, "children consume their parent exactly");
  };
  walk(0, b.length);
});

test("muxWebm keyframe SimpleBlock carries the keyframe flag", () => {
  const bytes = muxWebm({
    width: 2,
    height: 2,
    codec: "V_VP9",
    durationMs: 17,
    frames: [{ data: new Uint8Array([0xaa, 0xbb]), timestampMs: 0, key: true }],
  });
  // SimpleBlock body for track 1 at rel-timecode 0: 0x81 0x00 0x00 <flags> ...
  const at = indexOf(bytes, [0x81, 0x00, 0x00]);
  assert.ok(at >= 0, "SimpleBlock header");
  assert.equal(bytes[at + 3], 0x80, "keyframe flag set");
});
