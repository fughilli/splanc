/**
 * Pure-TS reader for a compiled effect's `.fxb` buffer table — just enough to
 * discover its 2D textures (their index + width/height/channels) so the
 * video-texture streamer can size frames to what the firmware expects. The frame
 * you send MUST match a texture's width×height or the device drops it, so the
 * dimensions are read from the compiled buffer rather than hardcoded.
 *
 * `.fxb` layout (little-endian). Header: magic "FXB1"(4) · version u8 · flags u8
 *   · n_state u8 · n_uniform_slots u8 · manifest_len u16 · n_consts u16 ·
 *   code_len u16 · update_entry u16 · shade_entry u16 — 18 bytes for v1, and v2
 *   (FUG-107) appends poll_entry u16 for a 20-byte header.
 * Then: manifest(manifest_len) · consts(n_consts*4) · code(code_len).
 * If (flags & 0x01) a buffer table follows: n_buffers u8, then n_buffers ×
 *   [kind u8, elem u8, comp u8, w u16, h u16].
 * A TEXTURE is a buffer with kind == 1 (w×h its dims, elem = channels); LED-arity
 * buffers are kind == 0 and are skipped here. `comp` is the per-component storage
 * precision (FUG-10 packed storage — fx_vm `comp`); this reader doesn't need it,
 * but it MUST account for the byte or w/h read off by one (see BUF_DESC_LEN=7).
 */

// "FXB1" (bytes 0x46 0x58 0x42 0x31) read as a little-endian u32:
// 0x46 | 0x58<<8 | 0x42<<16 | 0x31<<24.
const MAGIC = 0x31425846;
const FLAG_HAS_BUFFERS = 0x01;
const KIND_TEXTURE = 1;
// Bytes per buffer descriptor: kind(u8) elem(u8) comp(u8) w(u16) h(u16). Mirrors
// fx_vm::BUF_DESC_LEN — keep in lockstep with the compiler's serialization.
const BUF_DESC_LEN = 7;

/** One texture buffer declared by a compiled effect. `index` is its position in
 * the .fxb buffer table (the `texIndex` the firmware's set_texture keys on). */
export interface FxbTexture {
  index: number;
  width: number;
  height: number;
  elem: number;
}

/** Parse the buffer table out of a compiled `.fxb` and return its textures
 * (kind == 1) in table order. Returns [] if the effect declares no buffer table
 * (flags bit0 clear) or no kind-1 entries. Throws on a malformed/short buffer. */
export function parseFxbTextures(fxb: Uint8Array): FxbTexture[] {
  const dv = new DataView(fxb.buffer, fxb.byteOffset, fxb.byteLength);
  if (fxb.byteLength < 18) throw new Error("fxb too short for header");
  if (dv.getUint32(0, true) !== MAGIC) throw new Error("bad fxb magic");

  const flags = dv.getUint8(5);
  if ((flags & FLAG_HAS_BUFFERS) === 0) return [];

  const manifestLen = dv.getUint16(8, true);
  const nConsts = dv.getUint16(10, true);
  const codeLen = dv.getUint16(12, true);

  // v2 (FUG-107) appends poll_entry to the fixed header (18 → 20 bytes); the
  // manifest/consts/code follow it. Read the version to place the buffer table.
  const headerLen = dv.getUint8(4) >= 2 ? 20 : 18;

  // Buffer table starts right after header + manifest + consts + code.
  let off = headerLen + manifestLen + nConsts * 4 + codeLen;
  if (off + 1 > fxb.byteLength) throw new Error("fxb missing buffer table");

  const nBuffers = dv.getUint8(off);
  off += 1;

  const out: FxbTexture[] = [];
  for (let i = 0; i < nBuffers; i++) {
    if (off + BUF_DESC_LEN > fxb.byteLength) throw new Error("fxb buffer table truncated");
    const kind = dv.getUint8(off);
    const elem = dv.getUint8(off + 1);
    // off + 2 is `comp` (per-component storage precision) — skipped here.
    const w = dv.getUint16(off + 3, true);
    const h = dv.getUint16(off + 5, true);
    off += BUF_DESC_LEN;
    if (kind === KIND_TEXTURE) out.push({ index: i, width: w, height: h, elem });
  }
  return out;
}
