import test from "node:test";
import assert from "node:assert/strict";

import { parseFxbTextures } from "../src/net/fxbTextures";

/** Hand-build a minimal .fxb byte buffer: an 18-byte header, empty
 * manifest/consts/code, then a buffer table with the given entries. */
function buildFxb(opts: {
  flags: number;
  manifest?: Uint8Array;
  consts?: number; // n_consts (each 4 bytes)
  code?: Uint8Array;
  // `comp` (per-component storage precision, FUG-10) defaults to 0 (f32).
  buffers?: { kind: number; elem: number; w: number; h: number; comp?: number }[] | null;
}): Uint8Array {
  const manifest = opts.manifest ?? new Uint8Array(0);
  const nConsts = opts.consts ?? 0;
  const code = opts.code ?? new Uint8Array(0);
  const bufs = opts.buffers ?? null;

  // Descriptor: kind u8, elem u8, comp u8, w u16, h u16 = 7 bytes (BUF_DESC_LEN).
  const bufBytes = bufs === null ? 0 : 1 + bufs.length * 7;
  const total = 18 + manifest.length + nConsts * 4 + code.length + bufBytes;
  const buf = new Uint8Array(total);
  const dv = new DataView(buf.buffer);

  // magic "FXB1"
  buf[0] = 0x46; // F
  buf[1] = 0x58; // X
  buf[2] = 0x42; // B
  buf[3] = 0x31; // 1
  dv.setUint8(4, 1); // version
  dv.setUint8(5, opts.flags); // flags
  dv.setUint8(6, 0); // n_state
  dv.setUint8(7, 0); // n_uniform_slots
  dv.setUint16(8, manifest.length, true);
  dv.setUint16(10, nConsts, true);
  dv.setUint16(12, code.length, true);
  dv.setUint16(14, 0, true); // update_entry
  dv.setUint16(16, 0, true); // shade_entry

  let off = 18;
  buf.set(manifest, off);
  off += manifest.length;
  off += nConsts * 4; // consts left zero
  buf.set(code, off);
  off += code.length;

  if (bufs !== null) {
    dv.setUint8(off, bufs.length);
    off += 1;
    for (const b of bufs) {
      dv.setUint8(off, b.kind);
      dv.setUint8(off + 1, b.elem);
      dv.setUint8(off + 2, b.comp ?? 0);
      dv.setUint16(off + 3, b.w, true);
      dv.setUint16(off + 5, b.h, true);
      off += 7;
    }
  }
  return buf;
}

test("parses a single kind-1 texture entry", () => {
  const fxb = buildFxb({
    flags: 0x01,
    buffers: [{ kind: 1, elem: 4, w: 64, h: 32 }],
  });
  assert.deepEqual(parseFxbTextures(fxb), [
    { index: 0, width: 64, height: 32, elem: 4 },
  ]);
});

// Regression (FUG-57): the descriptor gained a `comp` byte after `elem`
// (FUG-10, BUF_DESC_LEN 6→7). A reader still on the 6-byte stride reads `comp`
// as the low byte of `w`, so a 64×64 texture parses as 16384×16384 — which
// blew the video-texture canvas up to ~1GB/frame (7fps) and made every
// set_texture frame drop on the dimension guard. Assert the real dims survive,
// including a non-zero `comp`.
test("reads dims past the comp byte (7-byte descriptor)", () => {
  const fxb = buildFxb({
    flags: 0x01,
    buffers: [{ kind: 1, elem: 3, comp: 2, w: 64, h: 64 }],
  });
  assert.deepEqual(parseFxbTextures(fxb), [{ index: 0, width: 64, height: 64, elem: 3 }]);
});

test("stays aligned across multiple 7-byte descriptors", () => {
  const fxb = buildFxb({
    flags: 0x01,
    buffers: [
      { kind: 1, elem: 4, comp: 1, w: 32, h: 16 },
      { kind: 1, elem: 3, comp: 0, w: 8, h: 4 },
    ],
  });
  assert.deepEqual(parseFxbTextures(fxb), [
    { index: 0, width: 32, height: 16, elem: 4 },
    { index: 1, width: 8, height: 4, elem: 3 },
  ]);
});

test("skips kind-0 (LED-arity) buffers and keeps table indices", () => {
  const fxb = buildFxb({
    flags: 0x01,
    buffers: [
      { kind: 0, elem: 3, w: 0, h: 0 },
      { kind: 1, elem: 3, w: 16, h: 16 },
    ],
  });
  assert.deepEqual(parseFxbTextures(fxb), [
    { index: 1, width: 16, height: 16, elem: 3 },
  ]);
});

test("offsets past a non-empty manifest/consts/code", () => {
  const fxb = buildFxb({
    flags: 0x01,
    manifest: new Uint8Array([1, 2, 3, 4, 5]),
    consts: 2,
    code: new Uint8Array([9, 9, 9]),
    buffers: [{ kind: 1, elem: 4, w: 8, h: 4 }],
  });
  assert.deepEqual(parseFxbTextures(fxb), [
    { index: 0, width: 8, height: 4, elem: 4 },
  ]);
});

test("returns [] when the buffer-table flag is clear", () => {
  const fxb = buildFxb({ flags: 0x00, buffers: null });
  assert.deepEqual(parseFxbTextures(fxb), []);
});

test("rejects a bad magic", () => {
  const fxb = buildFxb({ flags: 0x01, buffers: [{ kind: 1, elem: 4, w: 2, h: 2 }] });
  fxb[0] = 0x00;
  assert.throws(() => parseFxbTextures(fxb), /bad fxb magic/);
});
