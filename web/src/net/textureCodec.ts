/**
 * Host-side video-texture codec (Phase 4). Encodes an RGBA frame into a
 * `SetTextureMessage` the firmware's `handle_set_texture` decodes: quantize to a
 * reduced bit depth, optionally XOR-delta against the previous frame, then
 * run-length code (a zero-run scheme). The byte layout + RLE + XOR semantics
 * mirror firmware/player_app/ffi.rs exactly, so a stream encoded here decodes
 * pixel-for-pixel on the device.
 */

import type { SetTextureMessage } from "./proto";

export type TextureFormat = "rgb888" | "rgb565" | "rgb332" | "gray8" | "indexed8";

/** proto SetTexture.format codes (mirror ffi.rs TEX_*). */
export const FORMAT_CODE: Record<TextureFormat, number> = {
  rgb888: 0,
  rgb565: 1,
  rgb332: 2,
  gray8: 3,
  indexed8: 4,
};
/** Packed bytes per texel for each format. */
export const FORMAT_BPT: Record<TextureFormat, number> = {
  rgb888: 3,
  rgb565: 2,
  rgb332: 1,
  gray8: 1,
  indexed8: 1,
};

/** Median-cut palette quantizer for INDEXED8: pick ≤`maxColors` representative
 * colors and map each texel to its box's index. Returns row-major `indices`
 * (1 byte/texel) + a `palette` of 0x00RRGGBB entries. Per-frame (adaptive), so
 * INDEXED8 frames are sent as keyframes (indices aren't comparable across
 * palettes, so no XOR-delta). */
export function quantizeIndexed(
  rgba: Uint8Array | Uint8ClampedArray,
  w: number,
  h: number,
  maxColors = 256,
): { indices: Uint8Array; palette: number[] } {
  const n = w * h;
  const px: number[][] = new Array(n);
  for (let i = 0; i < n; i++) px[i] = [rgba[i * 4] ?? 0, rgba[i * 4 + 1] ?? 0, rgba[i * 4 + 2] ?? 0, i];
  const rangeOf = (b: number[][]): { ch: number; range: number } => {
    let ch = 0;
    let best = -1;
    for (let c = 0; c < 3; c++) {
      let mn = 255;
      let mx = 0;
      for (const p of b) {
        const v = p[c]!;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      if (mx - mn > best) {
        best = mx - mn;
        ch = c;
      }
    }
    return { ch, range: best };
  };
  const init = rangeOf(px);
  const boxes: { px: number[][]; ch: number; range: number }[] = [{ px, ch: init.ch, range: init.range }];
  while (boxes.length < maxColors) {
    let bi = -1;
    let best = 0;
    for (let k = 0; k < boxes.length; k++) {
      const b = boxes[k]!;
      if (b.px.length > 1 && b.range > best) {
        best = b.range;
        bi = k;
      }
    }
    if (bi < 0) break; // every box is a single colour
    const box = boxes[bi]!;
    box.px.sort((a, b) => a[box.ch]! - b[box.ch]!);
    const mid = box.px.length >> 1;
    const a = box.px.slice(0, mid);
    const b = box.px.slice(mid);
    const ra = rangeOf(a);
    const rb = rangeOf(b);
    boxes.splice(bi, 1, { px: a, ch: ra.ch, range: ra.range }, { px: b, ch: rb.ch, range: rb.range });
  }
  const palette: number[] = [];
  const indices = new Uint8Array(n);
  boxes.forEach((box, bi) => {
    let r = 0;
    let g = 0;
    let bl = 0;
    for (const p of box.px) {
      r += p[0]!;
      g += p[1]!;
      bl += p[2]!;
    }
    const c = box.px.length || 1;
    palette.push((Math.round(r / c) << 16) | (Math.round(g / c) << 8) | Math.round(bl / c));
    for (const p of box.px) indices[p[3]!] = bi;
  });
  return { indices, palette };
}
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
  // INDEXED8: adaptive per-frame palette → keyframe (no cross-palette delta);
  // RLE still compresses flat/limited-colour regions of the index map.
  if (format === "indexed8") {
    const { indices, palette } = quantizeIndexed(rgba, width, height, 256);
    let flags = 0;
    let payload = indices;
    if (opts.rle) {
      flags |= FLAG_RLE;
      payload = rleEncode(indices);
    }
    return {
      message: { type: "set_texture", texIndex, format: FORMAT_CODE.indexed8, width, height, flags, data: payload, palette },
      quant: indices,
    };
  }
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
