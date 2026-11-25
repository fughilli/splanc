//! The hue-code kernel's flat C ABI: `ledmapper_pattern` behind `extern "C"`
//! functions of plain numbers, so one build per target serves every
//! non-Rust caller with no binding generator and no glue:
//!
//! - wasm32 (`//firmware/pattern:kernel_wasm`): the phone app instantiates the
//!   few-KB module synchronously (`web/src/code/kernel.ts`); every export is a
//!   wasm function of i32/f64, so the import object is empty.
//! - host cdylib (`//firmware/pattern:kernel_abi`): Python loads it with ctypes
//!   through ONE binding, `firmware/pattern/python/ledmapper_pattern.py`
//!   (`//firmware/pattern:pattern_py`): the M2 dev backend's code-book sizing
//!   (`pi/server/server/codebook.py`) and the APA102 M1 driver's frames
//!   (`pi/led_driver`, also built for the Pi image by `pi/provisioning/nix`).
//!
//! Only marshalling lives here — every rule is in `src/lib.rs`. Packed results:
//! [`pk_secded_decode`] and [`pk_decode_cycle`] return flag bits above a value
//! field (see their docs); [`pk_decode_cycle`] reads its symbols from the static
//! buffer at [`pk_symbol_buf`].

#![cfg_attr(target_arch = "wasm32", no_std)]
#![allow(clippy::missing_safety_doc)]

use ledmapper_pattern as k;
use ledmapper_pattern::timing;

#[cfg(target_arch = "wasm32")]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

/// Capacity of the decode symbol buffer: more than any code-book's data frames
/// (a 32-bit codeword at 1 bit/frame).
pub const SYMBOL_BUF_LEN: u32 = 64;
static mut SYMBOL_BUF: [u8; SYMBOL_BUF_LEN as usize] = [0; SYMBOL_BUF_LEN as usize];

/// Result flags of [`pk_decode_cycle`] / [`pk_secded_decode`].
pub const FLAG_CORRECTED: u32 = 1 << 31;
pub const FLAG_UNCORRECTABLE: u32 = 1 << 30;
/// [`pk_decode_cycle`]: the received word is wider than the SEC-DED code for
/// `led_count` (an inconsistent code-book: `bits` too large); the low 28 bits
/// hold the word. No decode was attempted.
pub const FLAG_MALFORMED: u32 = 1 << 28;
/// [`pk_decode_cycle`]: the low 29 bits hold an id. [`pk_secded_decode`]: the
/// low 29 bits hold the data word.
pub const FLAG_VALUE: u32 = 1 << 29;
pub const VALUE_MASK: u32 = FLAG_VALUE - 1;

fn spec(led_count: u32, symbols: u32, secded: u32) -> k::CodeSpec {
    k::CodeSpec::derive(led_count, symbols as u8, secded != 0)
}

/// The code-book DERIVED under a sync pattern code (0 on_off, 1 stagger_pilot,
/// 2 stagger_white, 3 stagger_gm — [`k::SyncPattern::from_code`]). A pruned
/// book counts its words (2^k validity checks): code-book sizing only.
fn spec_sync(led_count: u32, symbols: u32, secded: u32, sync: u32) -> k::CodeSpec {
    k::CodeSpec::derive_sync(led_count, symbols as u8, secded != 0, k::SyncPattern::from_code(sync))
}

/// The code-book a received CodeParams describes (`bits` as received): O(1),
/// for the per-LED / per-frame calls.
fn spec_params(led_count: u32, bits: u32, symbols: u32, secded: u32, sync: u32) -> k::CodeSpec {
    k::CodeSpec::from_params(led_count, bits, symbols as u8, secded != 0, k::SyncPattern::from_code(sync))
}

/// Capacity of the coded-index buffer [`pk_stagger_fill`] writes.
pub const IDS_BUF_LEN: u32 = 8192;
static mut IDS_BUF: [u32; IDS_BUF_LEN as usize] = [0; IDS_BUF_LEN as usize];

// --- constants ------------------------------------------------------------

#[no_mangle]
pub extern "C" fn pk_code_offset() -> u32 {
    k::CODE_OFFSET
}
#[no_mangle]
pub extern "C" fn pk_frame_all_on() -> u32 {
    k::FRAME_ALL_ON
}
#[no_mangle]
pub extern "C" fn pk_frame_all_off() -> u32 {
    k::FRAME_ALL_OFF
}
#[no_mangle]
pub extern "C" fn pk_data_frame_offset() -> u32 {
    k::DATA_FRAME_OFFSET
}

// --- Gray + code-book sizing ------------------------------------------------

#[no_mangle]
pub extern "C" fn pk_gray(i: u32) -> u32 {
    k::gray(i)
}
#[no_mangle]
pub extern "C" fn pk_decode_gray(value: u32) -> u32 {
    k::decode_gray(value)
}
#[no_mangle]
pub extern "C" fn pk_data_bits(led_count: u32) -> u32 {
    k::data_bits(led_count)
}
#[no_mangle]
pub extern "C" fn pk_expected_bits(led_count: u32, secded: u32) -> u32 {
    k::expected_bits(led_count, secded != 0)
}
#[no_mangle]
pub extern "C" fn pk_data_frames(bits: u32, symbols: u32) -> u32 {
    k::data_frames(bits, symbols as u8)
}
#[no_mangle]
pub extern "C" fn pk_cycle_frames(led_count: u32, symbols: u32, secded: u32) -> u32 {
    spec(led_count, symbols, secded).cycle_frames
}

// --- SEC-DED ------------------------------------------------------------------

#[no_mangle]
pub extern "C" fn pk_secded_parity_bits(k_bits: u32) -> u32 {
    k::secded_parity_bits(k_bits)
}
#[no_mangle]
pub extern "C" fn pk_secded_total_bits(k_bits: u32) -> u32 {
    k::secded_total_bits(k_bits)
}
#[no_mangle]
pub extern "C" fn pk_secded_encode(data: u32, k_bits: u32) -> u32 {
    k::secded_encode(data, k_bits)
}
/// `FLAG_VALUE | data` (+ `FLAG_CORRECTED`) on success; `0` on a detected
/// double error.
#[no_mangle]
pub extern "C" fn pk_secded_decode(word: u32, k_bits: u32) -> u32 {
    match k::secded_decode(word, k_bits) {
        (Some(data), corrected) => FLAG_VALUE | (data & VALUE_MASK) | if corrected { FLAG_CORRECTED } else { 0 },
        (None, _) => 0,
    }
}

// --- encode: codewords, symbols, colors ------------------------------------------

#[no_mangle]
pub extern "C" fn pk_codeword(led_id: u32, led_count: u32, secded: u32) -> u32 {
    k::codeword(led_id, &spec(led_count, 2, secded))
}
#[no_mangle]
pub extern "C" fn pk_symbol_at(led_id: u32, frame: u32, led_count: u32, symbols: u32, secded: u32) -> u32 {
    k::symbol_at(led_id, frame, &spec(led_count, symbols, secded)) as u32
}
/// The [`k::Color`] discriminant `led_id` shows in cycle frame `frame_index`.
#[no_mangle]
pub extern "C" fn pk_color_index(led_id: u32, frame_index: u32, led_count: u32, symbols: u32, secded: u32) -> u32 {
    k::color_index_for_frame(led_id, frame_index, &spec(led_count, symbols, secded)) as u32
}
/// The [`k::Color`] discriminant of symbol `value` in alphabet `symbols`.
#[no_mangle]
pub extern "C" fn pk_symbol_color(symbols: u32, value: u32) -> u32 {
    k::symbol_color(symbols as u8, value as u8) as u32
}

/// The [`k::Color`] discriminant id `led_id`, whose coded index is `n`
/// ([`pk_stagger_fill`]; `led_id + 1` for an unpruned book), shows in GLOBAL
/// cycle frame `frame_index` under sync pattern `sync` (rotated per LED inside
/// the kernel). `bits` is the code-book's, as received.
#[no_mangle]
pub extern "C" fn pk_color_index_coded(
    led_id: u32,
    n: u32,
    frame_index: u32,
    led_count: u32,
    bits: u32,
    symbols: u32,
    secded: u32,
    sync: u32,
) -> u32 {
    let spec = spec_params(led_count, bits, symbols, secded, sync);
    k::color_index_for_frame_coded(led_id, n, frame_index, &spec) as u32
}

/// The symbol value coded index `n` transmits in data frame `frame`.
#[no_mangle]
pub extern "C" fn pk_symbol_at_coded(
    n: u32,
    frame: u32,
    led_count: u32,
    bits: u32,
    symbols: u32,
    secded: u32,
    sync: u32,
) -> u32 {
    k::symbol_at_coded(n, frame, &spec_params(led_count, bits, symbols, secded, sync)) as u32
}

/// The stagger step S for a cycle of `cycle_frames` frames.
#[no_mangle]
pub extern "C" fn pk_stagger_step(cycle_frames: u32) -> u32 {
    k::stagger_step(cycle_frames)
}

/// The phase rotation `(id * S + h(id / C)) mod C` of coded id `led_id`
/// (h: the per-block offset of `stagger_phase`; 0 under on_off).
#[no_mangle]
pub extern "C" fn pk_stagger_phase(led_id: u32, led_count: u32, bits: u32, symbols: u32, secded: u32, sync: u32) -> u32 {
    k::stagger_phase(led_id, &spec_params(led_count, bits, symbols, secded, sync))
}

/// Sync-position frames: the palette pilot's length under stagger_pilot, else 2.
#[no_mangle]
pub extern "C" fn pk_sync_frames(symbols: u32, sync: u32) -> u32 {
    k::sync_frames(k::SyncPattern::from_code(sync), symbols as u8)
}

/// The [`k::Color`] discriminant of sync-position frame `j`.
#[no_mangle]
pub extern "C" fn pk_sync_color(sync: u32, symbols: u32, j: u32) -> u32 {
    k::sync_color(k::SyncPattern::from_code(sync), symbols as u8, j) as u32
}

/// Coded bits of the code book DERIVED under `sync` (a pruned book may need a
/// wider data word than `pk_expected_bits`).
#[no_mangle]
pub extern "C" fn pk_expected_bits_sync(led_count: u32, symbols: u32, secded: u32, sync: u32) -> u32 {
    spec_sync(led_count, symbols, secded, sync).bits
}

/// Cycle frames of the code book DERIVED under `sync`.
#[no_mangle]
pub extern "C" fn pk_cycle_frames_sync(led_count: u32, symbols: u32, secded: u32, sync: u32) -> u32 {
    spec_sync(led_count, symbols, secded, sync).cycle_frames
}

/// The buffer [`pk_stagger_fill`] writes coded indices into.
#[no_mangle]
pub extern "C" fn pk_stagger_ids_buf() -> *mut u32 {
    core::ptr::addr_of_mut!(IDS_BUF) as *mut u32
}

/// Write the coded index of ids `0..count` (the id -> codeword table of a
/// pruned book, walked with [`k::stagger_next`]; `id + 1` otherwise) into
/// [`pk_stagger_ids_buf`]. Returns `count`, or 0 if it exceeds the buffer or
/// the book.
#[no_mangle]
pub extern "C" fn pk_stagger_fill(count: u32, led_count: u32, bits: u32, symbols: u32, secded: u32, sync: u32) -> u32 {
    if count > IDS_BUF_LEN {
        return 0;
    }
    let spec = spec_params(led_count, bits, symbols, secded, sync);
    // SAFETY: single-threaded callers (one wasm instance / the GIL).
    let buf = unsafe { &mut *core::ptr::addr_of_mut!(IDS_BUF) };
    let mut n = 0;
    for slot in buf.iter_mut().take(count as usize) {
        n = if spec.sync.pruned() { k::stagger_next(n, &spec) } else { n + 1 };
        if n == u32::MAX {
            return 0;
        }
        *slot = n;
    }
    count
}

/// Packed `0xRRGGBB` of the palette entry `led_id` shows in cycle frame
/// `frame_index` (the RGB the player renders; [`k::Color::rgb`]). Host-only,
/// like [`pk_frame_rgb`]: the phone's wasm keeps palette indices.
#[cfg(not(target_arch = "wasm32"))]
#[no_mangle]
pub extern "C" fn pk_color_rgb(led_id: u32, frame_index: u32, led_count: u32, symbols: u32, secded: u32) -> u32 {
    let (r, g, b) = k::color_index_for_frame(led_id, frame_index, &spec(led_count, symbols, secded)).rgb();
    (r as u32) << 16 | (g as u32) << 8 | b as u32
}

/// [`pk_color_rgb`] under sync pattern `sync`. Host-only.
#[cfg(not(target_arch = "wasm32"))]
#[no_mangle]
pub extern "C" fn pk_color_rgb_sync(
    led_id: u32,
    frame_index: u32,
    led_count: u32,
    symbols: u32,
    secded: u32,
    sync: u32,
) -> u32 {
    // Derives (and for a pruned book counts) per call: goldens / tests only.
    let (r, g, b) = k::color_index_for_frame(led_id, frame_index, &spec_sync(led_count, symbols, secded, sync)).rgb();
    (r as u32) << 16 | (g as u32) << 8 | b as u32
}

/// [`pk_frame_rgb`] under sync pattern `sync`. Host-only.
#[cfg(not(target_arch = "wasm32"))]
#[no_mangle]
pub unsafe extern "C" fn pk_frame_rgb_sync(
    frame_index: u32,
    led_count: u32,
    symbols: u32,
    secded: u32,
    sync: u32,
    out: *mut u8,
    out_len: u32,
) -> u32 {
    frame_rgb(&spec_sync(led_count, symbols, secded, sync), frame_index, out, out_len)
}

/// Host-only (not in the phone's wasm): write cycle frame `frame_index` for
/// every LED as `led_count` R,G,B byte triplets into `out` (capacity `out_len`
/// bytes) — the APA102 Python driver's whole-frame render (`led_driver.pattern`)
/// in one call. Returns the bytes written, or `0` if `out` is too small or
/// `frame_index` is outside the cycle.
#[cfg(not(target_arch = "wasm32"))]
#[no_mangle]
pub unsafe extern "C" fn pk_frame_rgb(
    frame_index: u32,
    led_count: u32,
    symbols: u32,
    secded: u32,
    out: *mut u8,
    out_len: u32,
) -> u32 {
    frame_rgb(&spec(led_count, symbols, secded), frame_index, out, out_len)
}

#[cfg(not(target_arch = "wasm32"))]
unsafe fn frame_rgb(spec: &k::CodeSpec, frame_index: u32, out: *mut u8, out_len: u32) -> u32 {
    let led_count = spec.led_count;
    let need = led_count as usize * 3;
    if out.is_null() || (out_len as usize) < need || frame_index >= spec.cycle_frames {
        return 0;
    }
    // SAFETY: the caller owns `out_len >= need` writable bytes at `out`.
    let buf = core::slice::from_raw_parts_mut(out, need);
    // Walk the ids in order: a pruned book's coded indices come from
    // stagger_next (O(1) amortised per LED), never a per-LED unrank.
    let mut n = 0;
    for (id, px) in buf.chunks_exact_mut(3).enumerate() {
        n = if spec.sync.pruned() { k::stagger_next(n, spec) } else { id as u32 + k::CODE_OFFSET };
        let (r, g, b) = k::color_index_for_frame_coded(id as u32, n, frame_index, spec).rgb();
        px.copy_from_slice(&[r, g, b]);
    }
    need as u32
}

// --- decode ---------------------------------------------------------------------

/// The buffer [`pk_decode_cycle`] reads its symbol values from.
#[no_mangle]
pub extern "C" fn pk_symbol_buf() -> *mut u8 {
    core::ptr::addr_of_mut!(SYMBOL_BUF) as *mut u8
}

/// Decode the first `n` symbols of [`pk_symbol_buf`] against the code-book AS
/// RECEIVED (`bits` is not re-derived). Returns `FLAG_VALUE | id` for a decoded
/// id, plus `FLAG_CORRECTED` / `FLAG_UNCORRECTABLE`; `0` means no id.
#[no_mangle]
pub extern "C" fn pk_decode_cycle(n: u32, led_count: u32, bits: u32, symbols: u32, secded: u32) -> u32 {
    if n > SYMBOL_BUF_LEN {
        return 0; // longer than any code-book: a frame-count mismatch
    }
    let spec = k::CodeSpec {
        led_count,
        data_bits: k::data_bits(led_count),
        bits,
        symbols: symbols as u8,
        cycle_frames: k::DATA_FRAME_OFFSET + k::data_frames(bits, symbols as u8),
        secded: secded != 0,
        sync: k::SyncPattern::OnOff, // decoding a cycle's data is sync-independent
    };
    // SAFETY: single-threaded callers (one wasm instance / the GIL); the buffer
    // is only read here, after the caller filled it.
    let buf = unsafe { &*core::ptr::addr_of!(SYMBOL_BUF) };
    let symbols = &buf[..n as usize];
    if spec.secded && symbols.len() as u32 == spec.data_frames() {
        let width = k::secded_total_bits(k::data_bits(led_count));
        let code = k::cycle_code(symbols, &spec);
        if code.wrapping_shr(width) != 0 {
            return FLAG_MALFORMED | (code & (FLAG_MALFORMED - 1));
        }
    }
    let d = k::decode_cycle_symbols(symbols, &spec);
    let mut out = match d.id {
        Some(id) => FLAG_VALUE | (id & VALUE_MASK),
        None => 0,
    };
    if d.corrected {
        out |= FLAG_CORRECTED;
    }
    if d.uncorrectable {
        out |= FLAG_UNCORRECTABLE;
    }
    out
}

/// [`pk_decode_cycle`] for a code book under sync pattern `sync` (the book a
/// received CodeParams describes: `bits` as received). A pruned book maps the
/// decoded word back to its id by rank (O(2^k) validity checks at worst).
#[no_mangle]
pub extern "C" fn pk_decode_cycle_sync(n: u32, led_count: u32, bits: u32, symbols: u32, secded: u32, sync: u32) -> u32 {
    if n > SYMBOL_BUF_LEN {
        return 0;
    }
    let spec = spec_params(led_count, bits, symbols, secded, sync);
    // SAFETY: as pk_decode_cycle.
    let buf = unsafe { &*core::ptr::addr_of!(SYMBOL_BUF) };
    let d = k::decode_cycle_symbols(&buf[..n as usize], &spec);
    let mut out = match d.id {
        Some(id) => FLAG_VALUE | (id & VALUE_MASK),
        None => 0,
    };
    if d.corrected {
        out |= FLAG_CORRECTED;
    }
    if d.uncorrectable {
        out |= FLAG_UNCORRECTABLE;
    }
    out
}

/// [`pk_decode_cycle_sync`] up to the coded index: `FLAG_VALUE | n` for the
/// index the word carries (not ranked to an id — the caller maps it with the
/// table [`pk_stagger_fill`] wrote, O(1) where the rank walks the book), plus
/// the same correction flags. 0 / `FLAG_UNCORRECTABLE` as pk_decode_cycle_sync.
#[no_mangle]
pub extern "C" fn pk_decode_cycle_coded(n: u32, led_count: u32, bits: u32, symbols: u32, secded: u32, sync: u32) -> u32 {
    if n > SYMBOL_BUF_LEN {
        return 0;
    }
    let spec = spec_params(led_count, bits, symbols, secded, sync);
    // SAFETY: as pk_decode_cycle.
    let buf = unsafe { &*core::ptr::addr_of!(SYMBOL_BUF) };
    let d = k::decode_cycle_coded(&buf[..n as usize], &spec);
    let mut out = match d.id {
        Some(c) => FLAG_VALUE | (c & VALUE_MASK),
        None => 0,
    };
    if d.corrected {
        out |= FLAG_CORRECTED;
    }
    if d.uncorrectable {
        out |= FLAG_UNCORRECTABLE;
    }
    out
}

// --- stride ----------------------------------------------------------------------

#[no_mangle]
pub extern "C" fn pk_stride_phase_count(spacing: u32) -> u32 {
    k::stride_phase_count(spacing)
}
#[no_mangle]
pub extern "C" fn pk_stride_lit(led: u32, phase: u32, spacing: u32, anchor_density: u32) -> u32 {
    k::stride_lit(led, phase, spacing, anchor_density) as u32
}

/// Rolling stride ([`k::stride_lit_rolling`]): is physical LED `led` lit at
/// pattern-clock frame `seq` (absolute, since the epoch)? The code spec is a
/// received CodeParams (`led_count` = the code-book size); `n_leds` the
/// physical strip length (0 = unbounded) and `code_offset` the group offset.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn pk_stride_lit_rolling(
    led: u32,
    seq: u32,
    led_count: u32,
    bits: u32,
    symbols: u32,
    secded: u32,
    sync: u32,
    spacing: u32,
    anchor_density: u32,
    dwell_cycles: u32,
    n_leds: u32,
    code_offset: u32,
) -> u32 {
    let spec = spec_params(led_count, bits, symbols, secded, sync);
    let rs = k::RollingStride::new(spacing, anchor_density, dwell_cycles, n_leds, code_offset);
    k::stride_lit_rolling(led, seq, &spec, &rs) as u32
}

/// The dwell the kernel actually runs for a requested `dwell_cycles` (clamped).
#[no_mangle]
pub extern "C" fn pk_stride_rolling_dwell(dwell_cycles: u32) -> u32 {
    k::RollingStride::new(2, 3, dwell_cycles, 0, 0).dwell()
}

// --- timing (f64 ms) ----------------------------------------------------------------

#[no_mangle]
pub extern "C" fn pk_cycle_ms(cycle_frames: u32, bit_period_ms: f64) -> f64 {
    timing::cycle_ms(cycle_frames, bit_period_ms)
}
#[no_mangle]
pub extern "C" fn pk_phase_ms(t: f64, epoch: f64, cycle_frames: u32, bit_period_ms: f64) -> f64 {
    timing::phase_ms(t, epoch, cycle_frames, bit_period_ms)
}
#[no_mangle]
pub extern "C" fn pk_frame_index_at(t: f64, epoch: f64, cycle_frames: u32, bit_period_ms: f64) -> f64 {
    timing::frame_index_at(t, epoch, cycle_frames, bit_period_ms)
}
#[no_mangle]
pub extern "C" fn pk_cycle_index_at(t: f64, epoch: f64, cycle_frames: u32, bit_period_ms: f64) -> f64 {
    timing::cycle_index_at(t, epoch, cycle_frames, bit_period_ms)
}
#[no_mangle]
pub extern "C" fn pk_frame_fraction_at(t: f64, epoch: f64, cycle_frames: u32, bit_period_ms: f64) -> f64 {
    timing::frame_fraction_at(t, epoch, cycle_frames, bit_period_ms)
}
