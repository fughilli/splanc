//! Hue-code pattern generation for firmware players (design doc §8.1,
//! docs/esp32-led-mapping-plan.md Phase 4a).
//!
//! no_std, zero-dependency port of the Python authority
//! (`pi/led_driver/led_driver/graycode.py` + `ledmapper_protocol/fec.py`).
//! The phone's decoder mirrors the same logic (`web/src/code/gray.ts` +
//! `web/src/code/fec.ts`); all three implementations are pinned to the SAME
//! golden fixtures (`web/tests/golden_secded16.json` /
//! `golden_secded16_sym4.json`), so a firmware/phone disagreement is a test
//! failure here, not a field debugging session.
//!
//! The cycle: `[white ALL_ON][green ALL_OFF]` sync delimiter, then
//! `ceil(bits / log2(symbols))` data frames. Every LED is lit EVERY frame at
//! constant brightness — the code is carried entirely by color, which is
//! exactly the per-LED-RGB shape the ESP32 RMT output wants.

#![no_std]

/// 255-scale RGB, the driver-facing color type.
pub type Rgb = (u8, u8, u8);

pub const WHITE: Rgb = (255, 255, 255);
pub const GREEN: Rgb = (0, 255, 0);
pub const RED: Rgb = (255, 0, 0);
pub const BLUE: Rgb = (0, 0, 255);
pub const MAGENTA: Rgb = (255, 0, 255);
pub const YELLOW: Rgb = (255, 255, 0);

/// Symbol value -> color for `symbols=2` (bit 0 -> blue, bit 1 -> red).
pub const SYMBOL_COLORS_2: [Rgb; 2] = [BLUE, RED];
/// Symbol value -> color for `symbols=4`: the hue-adjacent path
/// blue(240°) -> magenta(300°) -> red(0°) -> yellow(60°) carries
/// binary-reflected-Gray bit pairs 00, 01, 11, 10, so the dominant misread
/// (adjacent hues) flips exactly one bit — which SEC-DED corrects.
pub const SYMBOL_COLORS_4: [Rgb; 4] = [BLUE, MAGENTA, YELLOW, RED];

/// Codewords carry `id + CODE_OFFSET`: the all-zero data word is
/// reserved-invalid (LED 0 would otherwise be a decode magnet).
pub const CODE_OFFSET: u32 = 1;

/// Cycle-frame indices of the sync delimiter; data frame d is frame 2+d.
pub const FRAME_ALL_ON: u32 = 0;
pub const FRAME_ALL_OFF: u32 = 1;
pub const DATA_FRAME_OFFSET: u32 = 2;

/// Binary-reflected Gray code.
#[inline]
pub const fn gray(i: u32) -> u32 {
    i ^ (i >> 1)
}

/// Inverse of [`gray`].
pub const fn decode_gray(mut value: u32) -> u32 {
    let mut result = 0;
    while value != 0 {
        result ^= value;
        value >>= 1;
    }
    result
}

/// Gray data-word width for `led_count` LEDs: `ceil(log2(led_count + 1))`,
/// minimum 1 (codewords carry id + 1).
pub const fn data_bits(led_count: u32) -> u32 {
    // ceil(log2(n)) for n = led_count + CODE_OFFSET >= 2.
    let n = led_count + CODE_OFFSET;
    if n <= 2 {
        1
    } else {
        32 - (n - 1).leading_zeros()
    }
}

// ---------------------------------------------------------------------------
// Extended-Hamming SEC-DED (mirror of ledmapper_protocol/fec.py — see its
// docstring for the canonical layout).
// ---------------------------------------------------------------------------

/// Number of Hamming parity bits `r` for `k` data bits (excluding the overall
/// parity bit): the smallest `r` with `2^r >= k + r + 1`.
pub const fn secded_parity_bits(k: u32) -> u32 {
    let mut r = 1;
    while (1 << r) < k + r + 1 {
        r += 1;
    }
    r
}

/// Total transmitted code bits for `k` data bits: `k + r + 1`.
pub const fn secded_total_bits(k: u32) -> u32 {
    k + secded_parity_bits(k) + 1
}

const fn is_pow2(x: u32) -> bool {
    x & (x - 1) == 0
}

/// Encode a `k`-bit data word into the transmitted codeword. Bit `j` of the
/// result is the value of transmission frame `j`.
pub fn secded_encode(data: u32, k: u32) -> u32 {
    debug_assert!(data >> k == 0, "data word does not fit in k bits");
    let r = secded_parity_bits(k);
    let m_inner = k + r;
    // Data bits at non-power-of-two inner positions 1..=m_inner.
    let mut word: u32 = 0;
    let mut bit = 0;
    let mut pos = 1;
    while pos <= m_inner {
        if !is_pow2(pos) {
            if (data >> bit) & 1 != 0 {
                word |= 1 << (pos - 1);
            }
            bit += 1;
        }
        pos += 1;
    }
    // Even parity at each power-of-two position over the positions it covers.
    let mut p_log = 0;
    while p_log < r {
        let p = 1 << p_log;
        let mut parity = 0;
        let mut pos = 1;
        while pos <= m_inner {
            if pos & p != 0 && (word >> (pos - 1)) & 1 != 0 {
                parity ^= 1;
            }
            pos += 1;
        }
        if parity != 0 {
            word |= 1 << (p - 1);
        }
        p_log += 1;
    }
    // Overall even parity over the inner word, transmitted last.
    if word.count_ones() & 1 != 0 {
        word |= 1 << m_inner;
    }
    word
}

/// Decode a received codeword: `(Some(data), corrected)` on success, or
/// `(None, false)` when a double error is detected (uncorrectable by design).
pub fn secded_decode(mut word: u32, k: u32) -> (Option<u32>, bool) {
    let r = secded_parity_bits(k);
    let m_inner = k + r;
    debug_assert!(word >> (m_inner + 1) == 0, "codeword too wide");
    let mut syndrome: u32 = 0;
    for pos in 1..=m_inner {
        if (word >> (pos - 1)) & 1 != 0 {
            syndrome ^= pos;
        }
    }
    let overall_ok = word.count_ones() & 1 == 0;
    let mut corrected = false;
    if syndrome == 0 {
        if !overall_ok {
            corrected = true; // the overall parity bit itself flipped
        }
    } else if overall_ok {
        return (None, false); // double error
    } else {
        if syndrome > m_inner {
            return (None, false); // multi-error signature
        }
        word ^= 1 << (syndrome - 1);
        corrected = true;
    }
    let mut data = 0;
    let mut bit = 0;
    for pos in 1..=m_inner {
        if !is_pow2(pos) {
            if (word >> (pos - 1)) & 1 != 0 {
                data |= 1 << bit;
            }
            bit += 1;
        }
    }
    (Some(data), corrected)
}

// ---------------------------------------------------------------------------
// Code-book (mirror of pi/server/server/codebook.py — the M2 authority) and
// the per-frame color plan (mirror of graycode.py).
// ---------------------------------------------------------------------------

/// The pattern-relevant subset of `CodeParams` (§7.6). The player derives it
/// with [`CodeSpec::derive`] (the same derivation the Pi's codebook.py runs)
/// so both ends of `mapping_started` agree by construction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CodeSpec {
    pub led_count: u32,
    /// Coded BITS per cycle (data + FEC parity), sent log2(symbols) per frame.
    pub bits: u32,
    /// Data alphabet size: 2 or 4.
    pub symbols: u8,
    /// 2 (sync delimiter) + ceil(bits / log2(symbols)).
    pub cycle_frames: u32,
    /// SEC-DED FEC around the Gray data word.
    pub secded: bool,
}

impl CodeSpec {
    /// The code-book derivation (codebook.py `code_params_for`).
    pub const fn derive(led_count: u32, symbols: u8, secded: bool) -> Self {
        let k = data_bits(led_count);
        let bits = if secded { secded_total_bits(k) } else { k };
        let bps = if symbols == 2 { 1 } else { 2 };
        CodeSpec {
            led_count,
            bits,
            symbols,
            cycle_frames: 2 + bits.div_ceil(bps),
            secded,
        }
    }

    pub const fn bits_per_symbol(&self) -> u32 {
        if self.symbols == 2 {
            1
        } else {
            2
        }
    }

    /// Data-frame count (last frame zero-padded in its high bit when odd).
    pub const fn data_frames(&self) -> u32 {
        self.bits.div_ceil(self.bits_per_symbol())
    }
}

/// The TRANSMITTED codeword for `led_id`: `gray(id+1)`, SEC-DED-wrapped when
/// the spec says so. Bits are sent log2(symbols) per data frame, LSB first.
pub fn codeword(led_id: u32, spec: &CodeSpec) -> u32 {
    let data = gray(led_id + CODE_OFFSET);
    if spec.secded {
        secded_encode(data, data_bits(spec.led_count))
    } else {
        data
    }
}

/// The symbol VALUE `led_id` transmits in data frame `frame`.
pub fn symbol_at(led_id: u32, frame: u32, spec: &CodeSpec) -> u8 {
    let bps = spec.bits_per_symbol();
    ((codeword(led_id, spec) >> (frame * bps)) & ((1 << bps) - 1)) as u8
}

// ---------------------------------------------------------------------------
// Diffuse-capture striding (mirror of web/src/code/stride.ts — see its docstring
// for the design). On a diffused fixture, lighting every LED every frame blends
// adjacent spots; instead the player lights only a sparse, ≥ `spacing`-separated
// subset per phase and the phone rotates the phase across epochs. Coverage is the
// `spacing` uniform-stride phases; the remaining `spacing-1` "bridge" phases wire a
// depth-2 registration star through class 0 (anchor reps + a class-`j` rep in the
// block gap). Every lit LED still shows its own full hue code, so ids stay absolute.
// ---------------------------------------------------------------------------

/// Total phases in one schedule: `spacing` coverage + `spacing-1` bridges; `1`
/// when striding is disabled (`spacing <= 1`, the legacy all-lit pattern).
pub const fn stride_phase_count(spacing: u32) -> u32 {
    if spacing <= 1 {
        1
    } else {
        2 * spacing - 1
    }
}

/// The coverage phases are `0 .. spacing-1`; the rest are bridges.
pub const fn stride_is_coverage(phase: u32, spacing: u32) -> bool {
    phase < spacing
}

/// Is `led` lit in `phase` under the stride schedule? `spacing <= 1` ⇒ always lit.
/// Out-of-range phases wrap (the caller may pass a running counter). `anchor_density`
/// is clamped up to 3 (below it a bridge's lit spots can fall closer than `spacing`).
pub fn stride_lit(led: u32, phase: u32, spacing: u32, anchor_density: u32) -> bool {
    let s = spacing;
    if s <= 1 {
        return true;
    }
    let n = 2 * s - 1;
    let ph = phase % n;
    if ph < s {
        // Coverage: uniform stride-`s` grid at offset `ph`.
        return led % s == ph;
    }
    // Bridge linking class 0 with class `j` (j = 1 .. s-1).
    let j = ph - s + 1;
    let a = if anchor_density < 3 { 3 } else { anchor_density };
    let period = a * s;
    let m = led % period;
    // Class-0 anchor rep at the block start; class-`j` rep in the block's mid gap.
    m == 0 || m == (a / 2) * s + j
}

/// The color `led_id` shows in cycle frame `frame_index`.
///
/// `frame_index` must be within the cycle (callers index with
/// `frame % cycle_frames`); out-of-range is a firmware logic bug.
pub fn color_for_frame(led_id: u32, frame_index: u32, spec: &CodeSpec) -> Rgb {
    debug_assert!(frame_index < spec.cycle_frames, "frame outside cycle");
    match frame_index {
        FRAME_ALL_ON => WHITE,
        FRAME_ALL_OFF => GREEN,
        _ => {
            let value = symbol_at(led_id, frame_index - DATA_FRAME_OFFSET, spec);
            if spec.symbols == 2 {
                SYMBOL_COLORS_2[value as usize]
            } else {
                SYMBOL_COLORS_4[value as usize]
            }
        }
    }
}
