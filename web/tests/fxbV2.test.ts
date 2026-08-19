import { strict as assert } from "node:assert";
import { test } from "node:test";

import { parseFxbTextures } from "../src/net/fxbTextures";
import { parseFxb } from "../src/effects/costModel";

// Build a minimal .fxb with the given version + optional buffer table. v2
// (FUG-107) has a 20-byte header (poll_entry appended); v1 is 18 bytes.
function makeFxb(opts: {
  version: number;
  manifest?: Uint8Array;
  consts?: number; // n_consts (each 4 bytes)
  code?: Uint8Array;
  buffers?: { kind: number; elem: number; comp: number; w: number; h: number }[];
}): Uint8Array {
  const manifest = opts.manifest ?? new Uint8Array(0);
  const nConsts = opts.consts ?? 0;
  const code = opts.code ?? new Uint8Array(0);
  const buffers = opts.buffers ?? [];
  const flags = buffers.length > 0 ? 0x01 : 0x00;
  const headerLen = opts.version >= 2 ? 20 : 18;
  const bufTable = buffers.length > 0 ? 1 + buffers.length * 7 : 0;
  const total = headerLen + manifest.length + nConsts * 4 + code.length + bufTable;
  const b = new Uint8Array(total);
  const dv = new DataView(b.buffer);
  b.set([0x46, 0x58, 0x42, 0x31], 0); // "FXB1"
  b[4] = opts.version;
  b[5] = flags;
  dv.setUint16(8, manifest.length, true);
  dv.setUint16(10, nConsts, true);
  dv.setUint16(12, code.length, true);
  dv.setUint16(14, 0xffff, true); // update_entry
  dv.setUint16(16, 0xffff, true); // shade_entry
  if (opts.version >= 2) dv.setUint16(18, 0xffff, true); // poll_entry
  let o = headerLen;
  b.set(manifest, o);
  o += manifest.length;
  o += nConsts * 4;
  b.set(code, o);
  o += code.length;
  if (buffers.length > 0) {
    b[o++] = buffers.length;
    for (const d of buffers) {
      b[o] = d.kind;
      b[o + 1] = d.elem;
      b[o + 2] = d.comp;
      dv.setUint16(o + 3, d.w, true);
      dv.setUint16(o + 5, d.h, true);
      o += 7;
    }
  }
  return b;
}

test("parseFxb accepts a v2 header and offsets code past poll_entry", () => {
  const code = new Uint8Array([1, 2, 3, 4]);
  // A non-empty manifest (as FUG-121 now embeds) to catch a header-size slip.
  const manifest = new TextEncoder().encode('[{"name":"k","slot":0,"width":1}]');
  const fxb = makeFxb({ version: 2, manifest, consts: 1, code });
  const h = parseFxb(fxb);
  assert.deepEqual([...h.code], [1, 2, 3, 4], "v2 code sliced at the right offset");
  assert.equal(h.updateEntry, 0xffff);
  assert.equal(h.shadeEntry, 0xffff);
});

test("parseFxb still accepts v1 and rejects other versions", () => {
  assert.doesNotThrow(() => parseFxb(makeFxb({ version: 1, code: new Uint8Array([9]) })));
  assert.throws(() => parseFxb(makeFxb({ version: 3 })), /bad fxb version/);
});

test("parseFxbTextures reads the buffer table from a v2 fxb", () => {
  const manifest = new TextEncoder().encode('[{"name":"t","slot":0,"width":1}]');
  const fxb = makeFxb({
    version: 2,
    manifest,
    consts: 2,
    code: new Uint8Array([0, 0, 0]),
    buffers: [
      { kind: 0, elem: 1, comp: 0, w: 0, h: 0 }, // LED-arity buffer (skipped)
      { kind: 1, elem: 3, comp: 0, w: 64, h: 48 }, // a texture
    ],
  });
  const tex = parseFxbTextures(fxb);
  assert.equal(tex.length, 1);
  assert.deepEqual(tex[0], { index: 1, width: 64, height: 48, elem: 3 });
});
