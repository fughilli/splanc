import test from "node:test";
import assert from "node:assert/strict";

import {
  quantize,
  encodeTextureFrame,
  TextureStreamer,
  FORMAT_BPT,
} from "../src/net/textureCodec";
import { encodeClient, decodeClient } from "../src/net/proto";

// Mirror of the firmware's handle_set_texture decode: RLE-decode (zero-run) +
// XOR into the kept previous frame (a keyframe zeroes it first).
function decodeInto(
  prev: Uint8Array,
  payload: Uint8Array,
  delta: boolean,
  rle: boolean,
): void {
  if (!delta) prev.fill(0);
  if (rle) {
    let j = 0;
    let p = 0;
    const rv = () => {
      let sh = 0;
      let r = 0;
      let b = 0;
      do {
        b = payload[p++] ?? 0;
        r |= (b & 0x7f) << sh;
        sh += 7;
      } while (b & 0x80);
      return r >>> 0;
    };
    while (j < prev.length && p < payload.length) {
      j += rv();
      const lits = rv();
      for (let k = 0; k < lits; k++) {
        if (j >= prev.length || p >= payload.length) break;
        prev[j] = (prev[j] ?? 0) ^ (payload[p++] ?? 0);
        j++;
      }
    }
  } else {
    for (let j = 0; j < Math.min(payload.length, prev.length); j++) {
      prev[j] = (prev[j] ?? 0) ^ (payload[j] ?? 0);
    }
  }
}

test("keyframe payload decodes back to the quantized frame (rgb565)", () => {
  const rgba = new Uint8Array([
    255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
  ]);
  const { message, quant } = encodeTextureFrame({
    texIndex: 0,
    width: 2,
    height: 2,
    rgba,
    format: "rgb565",
    rle: false,
  });
  assert.equal(message.flags, 0, "keyframe, no rle");
  const prev = new Uint8Array(quant.length);
  decodeInto(prev, message.data, false, false);
  assert.deepEqual([...prev], [...quant]);
});

test("delta + RLE reconstructs the frame device-side", () => {
  const w = 4;
  const h = 4;
  const black = new Uint8Array(w * h * 4);
  const red = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    red[i * 4] = 255;
    red[i * 4 + 3] = 255;
  }
  const s = new TextureStreamer(0, "rgb888", true);
  const prev = new Uint8Array(w * h * FORMAT_BPT.rgb888);

  const m1 = s.frame(w, h, black); // keyframe (all black)
  decodeInto(prev, m1.data, (m1.flags & 1) !== 0, (m1.flags & 2) !== 0);
  assert.deepEqual([...prev], [...quantize(black, w, h, "rgb888")]);

  const m2 = s.frame(w, h, red); // delta to red
  assert.equal(m2.flags & 1, 1, "second frame is a delta");
  decodeInto(prev, m2.data, true, (m2.flags & 2) !== 0);
  assert.deepEqual([...prev], [...quantize(red, w, h, "rgb888")]);
});

test("set_texture round-trips through encodeClient/decodeClient", () => {
  const { message } = encodeTextureFrame({
    texIndex: 2,
    width: 2,
    height: 1,
    rgba: new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255]),
    format: "rgb888",
    rle: false,
  });
  const bin = encodeClient(message as never);
  const back = decodeClient(bin) as unknown as {
    type: string;
    texIndex: number;
    width: number;
    data: string; // inbound `data` stays base64 (see proto.ts BYTES_KEYS_OUT)
  };
  assert.equal(back.type, "set_texture");
  assert.equal(back.texIndex, 2);
  assert.equal(back.width, 2);
  assert.deepEqual([...Buffer.from(back.data, "base64")], [...message.data]);
});

test("indexed8 builds an adaptive palette and reconstructs via lookup", () => {
  // 2x2 with two distinct colors → median-cut yields exactly those two.
  const rgba = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 255, 0, 0, 255, 0, 255, 0, 255]);
  const { message } = encodeTextureFrame({
    texIndex: 0,
    width: 2,
    height: 2,
    rgba,
    format: "indexed8",
    rle: false,
  });
  assert.equal(message.format, 4, "format code = INDEXED8");
  const pal = message.palette ?? [];
  assert.ok(pal.length >= 2, "at least two palette entries");
  const idx = message.data; // no RLE → raw indices, one per texel
  for (let i = 0; i < 4; i++) {
    const v = pal[idx[i]!]!;
    assert.deepEqual(
      [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff],
      [rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]],
      `texel ${i} reconstructs from palette`,
    );
  }
});
