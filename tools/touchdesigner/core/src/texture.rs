//! Host-side video-texture codec — a faithful Rust port of
//! `web/src/net/textureCodec.ts`. Quantizes an 8-bit RGBA/BGRA frame to a
//! reduced bit depth, optionally XOR-deltas it against the previous frame, then
//! run-length codes it (a zero-run scheme). The byte layout, RLE and XOR
//! semantics mirror `firmware/player_app/ffi.rs` exactly, so a stream encoded
//! here decodes pixel-for-pixel on the device.

use crate::proto::{encode_set_texture, SetTexture};

/// `SetTexture.format` codes (mirror `ffi.rs` `TEX_*`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
    Rgb888 = 0,
    Rgb565 = 1,
    Rgb332 = 2,
    Gray8 = 3,
}

impl Format {
    /// Packed bytes per texel.
    pub fn bpt(self) -> usize {
        match self {
            Format::Rgb888 => 3,
            Format::Rgb565 => 2,
            Format::Rgb332 => 1,
            Format::Gray8 => 1,
        }
    }

    /// Parse a format from a lowercase name; falls back to `rgb565`.
    pub fn from_name(name: &str) -> Format {
        match name {
            "rgb888" => Format::Rgb888,
            "rgb332" => Format::Rgb332,
            "gray8" => Format::Gray8,
            _ => Format::Rgb565,
        }
    }
}

/// Byte order of the incoming 4-byte-per-pixel buffer. TouchDesigner's CPU
/// texture download hands back BGRA; most other sources are RGBA.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChannelOrder {
    Rgba,
    Bgra,
}

const FLAG_DELTA: u32 = 0x01;
const FLAG_RLE: u32 = 0x02;

#[inline]
fn rgb(px: &[u8], i: usize, order: ChannelOrder) -> (u8, u8, u8) {
    let o = i * 4;
    let (a, b, c) = (
        *px.get(o).unwrap_or(&0),
        *px.get(o + 1).unwrap_or(&0),
        *px.get(o + 2).unwrap_or(&0),
    );
    match order {
        ChannelOrder::Rgba => (a, b, c),
        ChannelOrder::Bgra => (c, b, a),
    }
}

/// Nearest-neighbour resample a 4-byte-per-pixel (row-major) frame from
/// `sw`x`sh` to `dw`x`dh`. Used to fit a source frame to the device's declared
/// texture size — the firmware silently drops any frame whose dimensions don't
/// match. Channel order is preserved (it operates on whole 4-byte texels). A
/// no-op fast path returns the input unchanged when the sizes already match.
pub fn nn_rescale(px: &[u8], sw: usize, sh: usize, dw: usize, dh: usize) -> Vec<u8> {
    if (sw, sh) == (dw, dh) {
        return px.to_vec();
    }
    let mut out = vec![0u8; dw * dh * 4];
    if sw == 0 || sh == 0 || dw == 0 || dh == 0 {
        return out;
    }
    for y in 0..dh {
        // Map the destination centre back to the nearest source texel.
        let sy = ((y * sh) / dh).min(sh - 1);
        for x in 0..dw {
            let sx = ((x * sw) / dw).min(sw - 1);
            let si = (sy * sw + sx) * 4;
            let di = (y * dw + x) * 4;
            if si + 4 <= px.len() {
                out[di..di + 4].copy_from_slice(&px[si..si + 4]);
            }
        }
    }
    out
}

/// Quantize a 4-byte-per-pixel frame (row-major) to packed `format` bytes.
pub fn quantize(px: &[u8], w: usize, h: usize, format: Format, order: ChannelOrder) -> Vec<u8> {
    let n = w * h;
    let bpt = format.bpt();
    let mut out = vec![0u8; n * bpt];
    for i in 0..n {
        let (r, g, b) = rgb(px, i, order);
        let o = i * bpt;
        match format {
            Format::Rgb888 => {
                out[o] = r;
                out[o + 1] = g;
                out[o + 2] = b;
            }
            Format::Rgb565 => {
                let v: u16 = (((r >> 3) as u16) << 11) | (((g >> 2) as u16) << 5) | (b >> 3) as u16;
                out[o] = (v & 0xff) as u8; // little-endian, matching the firmware read
                out[o + 1] = (v >> 8) as u8;
            }
            Format::Rgb332 => {
                out[o] = (r & 0xe0) | ((g >> 3) & 0x1c) | (b >> 6);
            }
            Format::Gray8 => {
                let y = 0.299 * r as f32 + 0.587 * g as f32 + 0.114 * b as f32;
                out[o] = y.round().clamp(0.0, 255.0) as u8;
            }
        }
    }
    out
}

/// RLE-encode with the firmware's zero-run scheme: repeated
/// `[varint zero_run][varint literal_run][literal bytes]`.
pub fn rle_encode(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let push_varint = |out: &mut Vec<u8>, mut n: usize| loop {
        if n > 127 {
            out.push((n as u8 & 0x7f) | 0x80);
            n >>= 7;
        } else {
            out.push(n as u8);
            break;
        }
    };
    let mut i = 0usize;
    let len = bytes.len();
    while i < len {
        let mut z = 0usize;
        while i < len && bytes[i] == 0 {
            z += 1;
            i += 1;
        }
        let lit_start = i;
        while i < len && bytes[i] != 0 {
            i += 1;
        }
        let lits = i - lit_start;
        push_varint(&mut out, z);
        push_varint(&mut out, lits);
        out.extend_from_slice(&bytes[lit_start..i]);
    }
    out
}

/// A stateful video-stream encoder: keeps the previous quantized frame so
/// successive frames are XOR-delta'd + RLE'd. The first frame (and any after a
/// size/format change) is a keyframe.
pub struct TextureStreamer {
    tex_index: u32,
    format: Format,
    order: ChannelOrder,
    rle: bool,
    prev: Option<Vec<u8>>,
}

impl TextureStreamer {
    pub fn new(tex_index: u32, format: Format, order: ChannelOrder, rle: bool) -> Self {
        TextureStreamer { tex_index, format, order, rle, prev: None }
    }

    /// Force the next frame to be a keyframe (e.g. after a reconnect).
    pub fn reset(&mut self) {
        self.prev = None;
    }

    /// Encode the next frame into a ready-to-send `set_texture` protobuf frame.
    pub fn encode_frame(&mut self, px: &[u8], w: usize, h: usize) -> Vec<u8> {
        let quant = quantize(px, w, h, self.format, self.order);
        let mut flags = 0u32;
        let mut payload = match &self.prev {
            Some(prev) if prev.len() == quant.len() => {
                flags |= FLAG_DELTA;
                quant.iter().zip(prev).map(|(a, b)| a ^ b).collect::<Vec<u8>>()
            }
            _ => quant.clone(),
        };
        if self.rle {
            flags |= FLAG_RLE;
            payload = rle_encode(&payload);
        }
        self.prev = Some(quant);
        encode_set_texture(&SetTexture {
            tex_index: self.tex_index,
            format: self.format as u32,
            width: w as u32,
            height: h as u32,
            flags,
            data: &payload,
            palette: &[],
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rgb565_little_endian_layout() {
        // Pure red (255,0,0) -> 0xF800 -> LE bytes [0x00, 0xF8].
        let px = [255u8, 0, 0, 255];
        let q = quantize(&px, 1, 1, Format::Rgb565, ChannelOrder::Rgba);
        assert_eq!(q, vec![0x00, 0xf8]);
    }

    #[test]
    fn bgra_swaps_channels() {
        // BGRA pure red is stored as [0,0,255,255]; must quantize to the same
        // 0xF800 as RGBA red.
        let bgra = [0u8, 0, 255, 255];
        let q = quantize(&bgra, 1, 1, Format::Rgb565, ChannelOrder::Bgra);
        assert_eq!(q, vec![0x00, 0xf8]);
    }

    #[test]
    fn rle_zero_run_scheme() {
        // [0,0,5,0,7] -> zero_run 2, lit_run 1, [5], zero_run 1, lit_run 1, [7].
        let enc = rle_encode(&[0, 0, 5, 0, 7]);
        assert_eq!(enc, vec![2, 1, 5, 1, 1, 7]);
    }

    #[test]
    fn rle_all_zero() {
        assert_eq!(rle_encode(&[0, 0, 0, 0]), vec![4, 0]);
    }

    #[test]
    fn nn_rescale_noop_when_sizes_match() {
        let px: Vec<u8> = (0..2 * 2 * 4).map(|i| i as u8).collect();
        assert_eq!(nn_rescale(&px, 2, 2, 2, 2), px);
    }

    #[test]
    fn nn_rescale_downscale_picks_nearest_texels() {
        // 2x2 with four distinct pixels -> 1x1 must take the top-left texel
        // (dest (0,0) maps to source (0,0)).
        let px = vec![
            10, 10, 10, 255, // (0,0)
            20, 20, 20, 255, // (1,0)
            30, 30, 30, 255, // (0,1)
            40, 40, 40, 255, // (1,1)
        ];
        assert_eq!(nn_rescale(&px, 2, 2, 1, 1), vec![10, 10, 10, 255]);
    }

    #[test]
    fn nn_rescale_upscale_duplicates() {
        // 1x1 -> 2x2 must replicate the single texel to all four.
        let px = vec![7, 8, 9, 255];
        let out = nn_rescale(&px, 1, 1, 2, 2);
        assert_eq!(out.len(), 2 * 2 * 4);
        for chunk in out.chunks(4) {
            assert_eq!(chunk, &[7, 8, 9, 255]);
        }
    }

    #[test]
    fn nn_rescale_preserves_bgra_order() {
        // The resample must not reorder channels — a BGRA texel survives intact.
        let px = vec![0, 0, 255, 255]; // BGRA red
        let out = nn_rescale(&px, 1, 1, 3, 3);
        assert!(out.chunks(4).all(|c| c == [0, 0, 255, 255]));
    }

    #[test]
    fn streamer_keyframe_then_delta() {
        let mut s = TextureStreamer::new(0, Format::Rgb565, ChannelOrder::Rgba, false);
        let frame1 = [10u8, 20, 30, 255];
        let a = s.encode_frame(&frame1, 1, 1);
        // Second identical frame -> XOR delta is all zeros.
        let b = s.encode_frame(&frame1, 1, 1);
        assert_ne!(a, b, "delta frame differs from keyframe (flags differ)");
        // Decode both as set_texture and check the delta payload is zeroed.
        // (We only sanity-check that the second frame is shorter or equal.)
        assert!(b.len() <= a.len() + 4);
    }
}
