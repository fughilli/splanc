/**
 * Host-side video-texture codec (Phase 4). Encodes an RGBA frame into a
 * `SetTextureMessage` the firmware's `handle_set_texture` decodes: quantize to a
 * reduced bit depth, optionally XOR-delta against the previous frame, then
 * run-length code (a zero-run scheme). The byte layout + RLE + XOR semantics
 * mirror firmware/player_app/ffi.rs exactly, so a stream encoded here decodes
 * pixel-for-pixel on the device.
 */

import type { SetTextureMessage } from "./proto";

export type TextureFormat = "rgb888" | "rgb565" | "rgb332" | "gray8";

/** proto SetTexture.format codes (mirror ffi.rs TEX_*). */
export const FORMAT_CODE: Record<TextureFormat, number> = {
  rgb888: 0,
  rgb565: 1,
  rgb332: 2,
  gray8: 3,
};
/** Packed bytes per texel for each format. */
export const FORMAT_BPT: Record<TextureFormat, number> = {
  rgb888: 3,
  rgb565: 2,
  rgb332: 1,
  gray8: 1,
};
const FLAG_DELTA = 0x01;
const FLAG_RLE = 0x02;

/** Quantize an RGBA frame (row-major, 4 bytes/px) to packed `format` bytes. */
export function quantize(
  rgba: Uint8Array | Uint8ClampedArray,
  w: number,
  h: number,
  format: TextureFormat,
): Uint8Array {
  const n = w * h;
  const bpt = FORMAT_BPT[format];
  const out = new Uint8Array(n * bpt);
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4] ?? 0;
    const g = rgba[i * 4 + 1] ?? 0;
    const b = rgba[i * 4 + 2] ?? 0;
    const o = i * bpt;
    switch (format) {
      case "rgb888":
        out[o] = r;
        out[o + 1] = g;
        out[o + 2] = b;
        break;
      case "rgb565": {
        const v = ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
        out[o] = v & 0xff; // little-endian, matching the firmware's read
        out[o + 1] = (v >> 8) & 0xff;
        break;
      }
      case "rgb332":
        out[o] = (r & 0xe0) | ((g >> 3) & 0x1c) | (b >> 6);
        break;
      case "gray8":
        out[o] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
        break;
    }
  }
  return out;
}

/** RLE-encode with the firmware's zero-run scheme: repeated
 * [varint zero_run][varint literal_run][literal bytes]. Compresses the mostly-
 * zero XOR-deltas of a near-static frame. */
export function rleEncode(bytes: Uint8Array): Uint8Array {
  const out: number[] = [];
  const pushVarint = (n: number) => {
    while (n > 127) {
      out.push((n & 0x7f) | 0x80);
      n >>>= 7;
    }
    out.push(n);
  };
  let i = 0;
  const N = bytes.length;
  while (i < N) {
    let z = 0;
    while (i < N && bytes[i] === 0) {
      z++;
      i++;
    }
    const litStart = i;
    while (i < N && bytes[i] !== 0) i++;
    const lits = i - litStart;
    pushVarint(z);
    pushVarint(lits);
    for (let k = 0; k < lits; k++) out.push(bytes[litStart + k] ?? 0);
  }
  return new Uint8Array(out);
}

/** Encode one frame → a `SetTextureMessage` plus the quantized bytes (feed those
 * back as the next frame's `prev` to enable XOR-delta). A keyframe (no `prev`)
 * sends the quantized frame; the firmware zeroes its previous-frame buffer first
 * so XOR-vs-0 reproduces it. */
export function encodeTextureFrame(opts: {
  texIndex: number;
  width: number;
  height: number;
  rgba: Uint8Array | Uint8ClampedArray;
  format: TextureFormat;
  prev?: Uint8Array | null;
  rle?: boolean;
}): { message: SetTextureMessage; quant: Uint8Array } {
  const { texIndex, width, height, rgba, format } = opts;
  const quant = quantize(rgba, width, height, format);
  let flags = 0;
  let payload: Uint8Array;
  if (opts.prev != null && opts.prev.length === quant.length) {
    flags |= FLAG_DELTA;
    payload = new Uint8Array(quant.length);
    for (let i = 0; i < quant.length; i++) payload[i] = (quant[i] ?? 0) ^ (opts.prev[i] ?? 0);
  } else {
    payload = quant; // keyframe
  }
  if (opts.rle) {
    flags |= FLAG_RLE;
    payload = rleEncode(payload);
  }
  return {
    message: {
      type: "set_texture",
      texIndex,
      format: FORMAT_CODE[format],
      width,
      height,
      flags,
      data: payload,
    },
    quant,
  };
}

/** Stateful helper for a video stream: keeps the previous quantized frame so
 * successive frames are XOR-delta'd + RLE'd. The first frame (and any after a
 * size/format change) is a keyframe. */
export class TextureStreamer {
  private prev: Uint8Array | null = null;

  constructor(
    private readonly texIndex: number,
    private readonly format: TextureFormat = "rgb565",
    private readonly rle = true,
  ) {}

  /** Encode the next frame into a message ready for `client.setTexture`. */
  frame(
    width: number,
    height: number,
    rgba: Uint8Array | Uint8ClampedArray,
  ): SetTextureMessage {
    const need = width * height * FORMAT_BPT[this.format];
    const prev = this.prev && this.prev.length === need ? this.prev : null;
    const { message, quant } = encodeTextureFrame({
      texIndex: this.texIndex,
      width,
      height,
      rgba,
      format: this.format,
      prev,
      rle: this.rle,
    });
    this.prev = quant;
    return message;
  }

  /** Force the next frame to be a keyframe (e.g. after a reconnect). */
  reset(): void {
    this.prev = null;
  }
}
