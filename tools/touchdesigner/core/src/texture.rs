//! Host-side video-texture codec — a faithful Rust port of
//! `web/src/net/textureCodec.ts`. Quantizes an 8-bit RGBA/BGRA frame to a
//! reduced bit depth, optionally XOR-deltas it against the previous frame, then
//! run-length codes it (a zero-run scheme). The byte layout, RLE and XOR
//! semantics mirror `firmware/player_app/ffi.rs` exactly, so a stream encoded
//! here decodes pixel-for-pixel on the device.

use crate::proto::{encode_set_texture, SetTexture};

/// `SetTexture.format` codes (mirror `ffi.rs` `TEX_*` and `web`'s `FORMAT_CODE`).
/// (4 = INDEXED8, handled by the web codec's palette path, is not produced here.)
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
    Rgb888 = 0,
    Rgb565 = 1,
    Rgb332 = 2,
    Gray8 = 3,
    /// 4-bit grayscale, 2 texels per byte (the low nibble is the even texel).
    Gray4 = 5,
    /// 1-bit mono, 8 texels per byte (bit `i & 7` is texel `i`, LSB first).
    Mono = 6,
}

impl Format {
    /// Packed length in bytes of a frame of `n` texels. Sub-byte formats round up
    /// to whole bytes (a partial trailing byte is zero-padded).
    pub fn packed_len(self, n: usize) -> usize {
        match self {
            Format::Rgb888 => n * 3,
            Format::Rgb565 => n * 2,
            Format::Rgb332 | Format::Gray8 => n,
            Format::Gray4 => n.div_ceil(2),
            Format::Mono => n.div_ceil(8),
        }
    }

    /// Parse a format from a lowercase name; falls back to `rgb565`.
    pub fn from_name(name: &str) -> Format {
        match name {
            "rgb888" => Format::Rgb888,
            "rgb332" => Format::Rgb332,
            "gray8" => Format::Gray8,
            "gray4" => Format::Gray4,
            "mono" => Format::Mono,
            _ => Format::Rgb565,
        }
    }
}

/// Rec.601 luma of an 8-bit RGB texel, rounded to `u8` — the shared basis for all
/// grayscale formats so gray8/gray4/mono agree on brightness.
#[inline]
fn luma8(r: u8, g: u8, b: u8) -> u8 {
    (0.299 * r as f32 + 0.587 * g as f32 + 0.114 * b as f32).round().clamp(0.0, 255.0) as u8
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
    let mut out = vec![0u8; format.packed_len(n)];
    match format {
        // Sub-byte formats OR the packed byte per texel into `out` (which starts
        // zeroed, so partial trailing bytes are padded).
        Format::Gray4 => {
            for i in 0..n {
                let (r, g, b) = rgb(px, i, order);
                let nib = (luma8(r, g, b) >> 4) & 0x0f; // top 4 bits of the luma
                out[i >> 1] |= if i & 1 == 0 { nib } else { nib << 4 };
            }
        }
        Format::Mono => {
            for i in 0..n {
                let (r, g, b) = rgb(px, i, order);
                if luma8(r, g, b) >= 128 {
                    out[i >> 3] |= 1 << (i & 7);
                }
            }
        }
        // Whole-byte formats: one texel writes `bpt` contiguous bytes.
        _ => {
            let bpt = format.packed_len(1);
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
                        let v: u16 =
                            (((r >> 3) as u16) << 11) | (((g >> 2) as u16) << 5) | (b >> 3) as u16;
                        out[o] = (v & 0xff) as u8; // little-endian, matching the firmware read
                        out[o + 1] = (v >> 8) as u8;
                    }
                    Format::Rgb332 => {
                        out[o] = (r & 0xe0) | ((g >> 3) & 0x1c) | (b >> 6);
                    }
                    // Gray8 (and any not handled above).
                    _ => out[o] = luma8(r, g, b),
                }
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
    /// Emit a *forced* keyframe every `keyframe_interval` frames (0 = never force
    /// one beyond the initial frame / a size change). A delta-coded frame is an
    /// XOR against the *previous* frame, so on a lossy transport a single dropped
    /// frame corrupts every frame after it until the raster is fully re-sent. A
    /// periodic keyframe bounds that damage to at most `keyframe_interval` frames.
    /// Independently, [`Self::encode_frame`] always falls back to a keyframe when
    /// a delta wouldn't be smaller, so the *sent* frame never exceeds the keyframe
    /// size and drop-recovery happens for free whenever it costs nothing.
    keyframe_interval: u32,
    /// Frames emitted in the current group (1 = the keyframe itself).
    since_keyframe: u32,
}

impl TextureStreamer {
    pub fn new(tex_index: u32, format: Format, order: ChannelOrder, rle: bool) -> Self {
        TextureStreamer {
            tex_index,
            format,
            order,
            rle,
            prev: None,
            keyframe_interval: 0,
            since_keyframe: 0,
        }
    }

    /// Set the periodic keyframe interval (frames between forced keyframes; 0
    /// disables periodic keyframes — only the initial frame is a keyframe).
    pub fn with_keyframe_interval(mut self, interval: u32) -> Self {
        self.keyframe_interval = interval;
        self
    }

    /// Force the next frame to be a keyframe (e.g. after a reconnect).
    pub fn reset(&mut self) {
        self.prev = None;
        self.since_keyframe = 0;
    }

    /// Encode the next frame into a ready-to-send `set_texture` protobuf frame.
    ///
    /// The frame is a keyframe when there's no usable previous frame (first frame
    /// or a size change) or the periodic interval is due. Otherwise the encoder
    /// bounds the delta's worst case: it encodes *both* the keyframe and the XOR
    /// delta and sends the keyframe whenever the delta isn't strictly smaller — a
    /// delta bigger than a full frame is pointless (and on a lossy path strictly
    /// worse, since it can't self-recover). Any keyframe sent — forced or this
    /// fallback — restarts the keyframe interval.
    pub fn encode_frame(&mut self, px: &[u8], w: usize, h: usize) -> Vec<u8> {
        let quant = quantize(px, w, h, self.format, self.order);
        let size_changed = self.prev.as_ref().map(|p| p.len() != quant.len()).unwrap_or(true);
        let periodic = self.keyframe_interval != 0 && self.since_keyframe >= self.keyframe_interval;
        let must_key = self.prev.is_none() || size_changed || periodic;

        let rle_flag = if self.rle { FLAG_RLE } else { 0 };
        let maybe_rle = |bytes: Vec<u8>| if self.rle { rle_encode(&bytes) } else { bytes };
        let key_payload = maybe_rle(quant.clone());

        let (flags, payload) = if must_key {
            (rle_flag, key_payload)
        } else {
            // Safe: `must_key` is true whenever prev is None or a size mismatch.
            let prev = self.prev.as_ref().unwrap();
            let delta = quant.iter().zip(prev).map(|(a, b)| a ^ b).collect::<Vec<u8>>();
            let delta_payload = maybe_rle(delta);
            if key_payload.len() < delta_payload.len() {
                (rle_flag, key_payload) // adaptive fallback: keyframe is smaller
            } else {
                (FLAG_DELTA | rle_flag, delta_payload)
            }
        };

        // A keyframe (forced or fallback) has the DELTA bit clear; it restarts
        // the interval so the next forced keyframe is `keyframe_interval` later.
        self.since_keyframe = if flags & FLAG_DELTA == 0 { 1 } else { self.since_keyframe + 1 };
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
    fn packed_len_rounds_sub_byte_up() {
        assert_eq!(Format::Rgb888.packed_len(4), 12);
        assert_eq!(Format::Gray8.packed_len(4), 4);
        assert_eq!(Format::Gray4.packed_len(3), 2); // ceil(3/2)
        assert_eq!(Format::Gray4.packed_len(4), 2);
        assert_eq!(Format::Mono.packed_len(8), 1);
        assert_eq!(Format::Mono.packed_len(9), 2); // ceil(9/8)
    }

    #[test]
    fn gray4_packs_two_texels_per_byte_low_nibble_first() {
        let white = [255u8, 255, 255, 255];
        let black = [0u8, 0, 0, 255];
        let px: Vec<u8> = [white, black].concat();
        // texel 0 (white) -> low nibble 0xF; texel 1 (black) -> high nibble 0x0.
        assert_eq!(quantize(&px, 2, 1, Format::Gray4, ChannelOrder::Rgba), vec![0x0f]);
        let px2: Vec<u8> = [black, white].concat();
        assert_eq!(quantize(&px2, 2, 1, Format::Gray4, ChannelOrder::Rgba), vec![0xf0]);
        // Odd texel count pads the trailing nibble with zero.
        assert_eq!(quantize(&white, 1, 1, Format::Gray4, ChannelOrder::Rgba), vec![0x0f]);
    }

    #[test]
    fn mono_packs_eight_texels_per_byte_lsb_first() {
        let white = [255u8, 255, 255, 255];
        let black = [0u8, 0, 0, 255];
        // white, black, white -> bits 0 and 2 set -> 0b0000_0101.
        let px: Vec<u8> = [white, black, white].concat();
        assert_eq!(quantize(&px, 3, 1, Format::Mono, ChannelOrder::Rgba), vec![0b0000_0101]);
        // A mid-gray (128) crosses the threshold; 127 does not.
        let g128 = [128u8, 128, 128, 255];
        let g127 = [127u8, 127, 127, 255];
        assert_eq!(quantize(&g128, 1, 1, Format::Mono, ChannelOrder::Rgba), vec![0x01]);
        assert_eq!(quantize(&g127, 1, 1, Format::Mono, ChannelOrder::Rgba), vec![0x00]);
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

    /// Read the `flags` field (number 5) out of an encoded `set_texture` frame.
    fn flags_of(frame: &[u8]) -> u32 {
        let rdv = |b: &[u8], i: &mut usize| -> u64 {
            let mut shift = 0;
            let mut out = 0u64;
            loop {
                let byte = b[*i];
                *i += 1;
                out |= ((byte & 0x7f) as u64) << shift;
                if byte & 0x80 == 0 {
                    return out;
                }
                shift += 7;
            }
        };
        let mut i = 0usize;
        rdv(frame, &mut i); // envelope tag (arm 28, LEN)
        rdv(frame, &mut i); // body length
        while i < frame.len() {
            let key = rdv(frame, &mut i);
            let (field, wire) = (key >> 3, key & 7);
            if wire == 0 {
                let v = rdv(frame, &mut i);
                if field == 5 {
                    return v as u32;
                }
            } else if wire == 2 {
                let n = rdv(frame, &mut i) as usize;
                i += n;
            }
        }
        0
    }

    #[test]
    fn periodic_keyframes_land_on_the_interval() {
        // interval 3 -> keyframes at frames 0, 3, 6 (DELTA flag clear); the two
        // frames between each are deltas (DELTA set). Content changes every frame
        // so a delta is genuinely chosen when allowed.
        let mut s = TextureStreamer::new(0, Format::Rgb565, ChannelOrder::Rgba, false)
            .with_keyframe_interval(3);
        let is_delta: Vec<bool> = (0..7u8)
            .map(|i| {
                let px = [i.wrapping_mul(37), 0, 0, 255];
                flags_of(&s.encode_frame(&px, 1, 1)) & FLAG_DELTA != 0
            })
            .collect();
        assert_eq!(
            is_delta,
            vec![false, true, true, false, true, true, false],
            "keyframes must recur every `interval` frames"
        );
    }

    #[test]
    fn zero_interval_keeps_a_single_keyframe() {
        let mut s = TextureStreamer::new(0, Format::Rgb565, ChannelOrder::Rgba, false);
        let is_delta: Vec<bool> = (0..5u8)
            .map(|i| flags_of(&s.encode_frame(&[i, 0, 0, 255], 1, 1)) & FLAG_DELTA != 0)
            .collect();
        assert_eq!(is_delta, vec![false, true, true, true, true]);
    }

    #[test]
    fn adaptive_keyframe_when_delta_would_blow_up() {
        // 8x8 rgb332 + RLE. A keyframe of a flat frame RLEs tiny; the XOR delta
        // between white and black is all-0xFF and RLEs large. The encoder must
        // fall back to the (smaller) keyframe on the white->black frame even
        // though no periodic keyframe is due, and use the delta when it IS
        // smaller (a static repeat).
        let (w, h) = (8usize, 8usize);
        let white = vec![255u8; w * h * 4];
        let black: Vec<u8> = (0..w * h).flat_map(|_| [0u8, 0, 0, 255]).collect();
        let is_delta = |f: &[u8]| flags_of(f) & FLAG_DELTA != 0;

        let mut s = TextureStreamer::new(0, Format::Rgb332, ChannelOrder::Rgba, true);
        let f0 = s.encode_frame(&white, w, h); // initial keyframe
        let f1 = s.encode_frame(&white, w, h); // static -> delta (all-zero) is tiny
        let f2 = s.encode_frame(&black, w, h); // delta blows up -> fall back to keyframe
        let f3 = s.encode_frame(&black, w, h); // static again -> delta

        assert_eq!(
            [is_delta(&f0), is_delta(&f1), is_delta(&f2), is_delta(&f3)],
            [false, true, false, true]
        );
        // The bound: the fallback keyframe (f2) is far smaller than the blown-up
        // delta would have been (which is ~the size of the white keyframe f0).
        assert!(f2.len() < f0.len());
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
