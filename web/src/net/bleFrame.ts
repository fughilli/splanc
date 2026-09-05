/**
 * Length-prefixed framing for the player protocol over a GATT byte stream.
 *
 * BLE characteristics carry unframed chunks capped at the ATT MTU, with no
 * record boundaries — so we impose our own: each logical protocol frame is sent
 * as `[u32 big-endian length][payload]`, split into MTU-sized writes, and the
 * peer reassembles by length. This mirrors the device side in
 * firmware/player_app/improv_ble.cpp (PlayerRxHandler / player_ble_notify).
 *
 * Pure + transport-free so it can be unit-tested without Web Bluetooth.
 */

/** Prefix `payload` with its u32 big-endian length, ready to be chunked out. */
export function frameWithLength(payload: Uint8Array): Uint8Array {
  const n = payload.length;
  const out = new Uint8Array(4 + n);
  out[0] = (n >>> 24) & 0xff;
  out[1] = (n >>> 16) & 0xff;
  out[2] = (n >>> 8) & 0xff;
  out[3] = n & 0xff;
  out.set(payload, 4);
  return out;
}

/** Split `bytes` into consecutive slices of at most `size` bytes (the GATT
 * write unit — MTU minus ATT overhead). Views into `bytes`, not copies. */
export function chunkBytes(bytes: Uint8Array, size: number): Uint8Array[] {
  if (size <= 0) throw new Error("chunk size must be positive");
  const out: Uint8Array[] = [];
  for (let off = 0; off < bytes.length; off += size) {
    out.push(bytes.subarray(off, Math.min(off + size, bytes.length)));
  }
  return out;
}

/**
 * Incremental reassembler for the inbound (notify) direction: feed it GATT
 * notification chunks in order, get back every complete payload that has
 * arrived. Buffers a partial frame across chunks; a single chunk may also
 * complete more than one frame (the device can notify back-to-back).
 */
export class FrameReassembler {
  private buf = new Uint8Array(0);

  /** Append `chunk` and return the payloads (length prefix stripped) of every
   * frame now fully received, in order. */
  push(chunk: Uint8Array): Uint8Array[] {
    if (chunk.length > 0) {
      const merged = new Uint8Array(this.buf.length + chunk.length);
      merged.set(this.buf);
      merged.set(chunk, this.buf.length);
      this.buf = merged;
    }
    const frames: Uint8Array[] = [];
    for (;;) {
      if (this.buf.length < 4) break;
      const len =
        (((this.buf[0]! << 24) | (this.buf[1]! << 16) | (this.buf[2]! << 8) | this.buf[3]!) >>> 0);
      if (this.buf.length < 4 + len) break;
      frames.push(this.buf.slice(4, 4 + len));
      this.buf = this.buf.slice(4 + len);
    }
    return frames;
  }

  /** Bytes buffered but not yet forming a complete frame (diagnostics/tests). */
  get pending(): number {
    return this.buf.length;
  }
}
