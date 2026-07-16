//! C ABI over the Rust player stack, for the Arduino (C++) player app.
//!
//! One player, one arena, one connection at a time — everything lives in
//! `static`s (the C6 app is single-threaded; Arduino `loop()` is the only
//! caller). The transport hands every received protocol frame to
//! [`lm_player_handle`], which routes exactly like the host tests do:
//! upload arms (submit_map / submit_topology) go through the arena decoder
//! (`ledmapper_store`) so the generated envelope never needs upload-sized
//! capacity; everything else decodes through the firmware-profile bindings
//! (`ledmapper_pb_fw`) into the session core (`ledmapper_player`), with
//! `ignore_repeated_cap_err` so oversized Pi-profile telemetry truncates
//! instead of erroring.
//!
//! The render-side accessors (`lm_pattern_*`, `lm_counting_color`) are what
//! the FastLED frame loop polls; they are pure reads.

#![no_std]

use core::ptr::{addr_of, addr_of_mut};

use ledmapper_arena::Arena;
use ledmapper_pb::ledmapper_::v1_ as pb;
use ledmapper_player::{upload_malformed, upload_too_large, Player};
use ledmapper_store::{
    decode_submit_map, decode_submit_topology, envelope_arm, StoreError, StoredMap,
    StoredTopology, ARM_SUBMIT_MAP, ARM_SUBMIT_TOPOLOGY,
};
use micropb::{MessageDecode, MessageEncode, PbDecoder, PbEncoder};

/// Storage for the decoded map + topology (Phase 3 arena). 96 KiB holds a
/// ~5000-LED map (16 B/LED) plus a topology; ArenaFull is the bounded
/// answer beyond that.
const ARENA_BYTES: usize = 96 * 1024;

/// Reply frames are control traffic (firmware caps): welcome is the
/// largest at a few hundred bytes.
const REPLY_CAP: usize = 2048;

static mut ARENA_MEM: [u8; ARENA_BYTES] = [0; ARENA_BYTES];
static mut ARENA: Option<Arena<'static>> = None;
static mut MAP: Option<StoredMap<'static>> = None;
static mut TOPO: Option<StoredTopology<'static>> = None;
static mut PLAYER: Option<Player> = None;

// The staticlib is linked into the Arduino app, which has no Rust runtime:
// provide the panic handler on the bare-metal target. Host tests (std)
// bring their own.
#[cfg(all(not(test), target_os = "none"))]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    // The player contract is bounded errors, never panics; reaching this is
    // a firmware bug. Halt where a debugger can see it.
    loop {}
}

unsafe fn player() -> &'static mut Player {
    (*addr_of_mut!(PLAYER)).as_mut().expect("lm_player_init first")
}

unsafe fn arena_ref() -> &'static Arena<'static> {
    (*addr_of!(ARENA)).as_ref().expect("lm_player_init first")
}

unsafe fn arena_mut() -> &'static mut Arena<'static> {
    (*addr_of_mut!(ARENA)).as_mut().expect("lm_player_init first")
}

/// Initialize (or re-initialize) the player state. `default_led_count` is
/// the code-book fallback until set_led_count / start_mapping override it.
#[no_mangle]
pub extern "C" fn lm_player_init(default_led_count: u32) {
    unsafe {
        *addr_of_mut!(MAP) = None;
        *addr_of_mut!(TOPO) = None;
        *addr_of_mut!(ARENA) = Some(Arena::new(&mut *addr_of_mut!(ARENA_MEM)));
        *addr_of_mut!(PLAYER) = Some(Player::new("esp32c6-player", default_led_count.max(1)));
    }
}

fn encode_reply(reply: &pb::ServerMessage, out: *mut u8, out_cap: usize) -> i32 {
    let mut enc = PbEncoder::new(micropb::heapless::Vec::<u8, REPLY_CAP>::new());
    if reply.encode(&mut enc).is_err() {
        return -2; // reply exceeds REPLY_CAP — a firmware bug, not remote input
    }
    let bytes = enc.into_writer();
    if bytes.len() > out_cap {
        return -2;
    }
    unsafe { core::ptr::copy_nonoverlapping(bytes.as_ptr(), out, bytes.len()) };
    bytes.len() as i32
}

/// Handle one received protocol frame; writes the reply frame (if any) to
/// `out`. Returns the reply length, 0 for fire-and-forget arms (no reply),
/// -1 for bad arguments, -2 if `out_cap` is too small.
///
/// # Safety
/// `data` must point to `len` readable bytes; `out` to `out_cap` writable.
#[no_mangle]
pub unsafe extern "C" fn lm_player_handle(
    data: *const u8,
    len: usize,
    recv_ms: f64,
    send_ms: f64,
    out: *mut u8,
    out_cap: usize,
) -> i32 {
    if data.is_null() || out.is_null() || len == 0 {
        return -1;
    }
    let frame = core::slice::from_raw_parts(data, len);
    let reply = match envelope_arm(frame) {
        Some(ARM_SUBMIT_MAP) => handle_map_upload(frame),
        Some(ARM_SUBMIT_TOPOLOGY) => handle_topology_upload(frame),
        _ => {
            let mut env = pb::ClientMessage::default();
            let mut dec = PbDecoder::new(frame);
            // Oversized repeated fields (Pi-profile telemetry) truncate;
            // the arms that matter carry firmware-sized data.
            dec.ignore_repeated_cap_err = true;
            match env.decode(&mut dec, frame.len()) {
                Ok(()) => match player().handle(env, recv_ms, send_ms) {
                    Some(reply) => reply,
                    None => return 0,
                },
                Err(_) => upload_malformed(),
            }
        }
    };
    encode_reply(&reply, out, out_cap)
}

/// A map upload replaces the stored map AND its topology (a topology is
/// meaningless against a different solve), so the arena resets wholesale.
unsafe fn handle_map_upload(frame: &[u8]) -> pb::ServerMessage {
    *addr_of_mut!(MAP) = None;
    *addr_of_mut!(TOPO) = None;
    arena_mut().reset();
    match decode_submit_map(frame, frame.len(), arena_ref()) {
        Ok(map) => {
            let reply = player().map_stored(map.map_id.as_str());
            *addr_of_mut!(MAP) = Some(map);
            reply
        }
        Err(e) => {
            arena_mut().reset();
            upload_error(e)
        }
    }
}

/// Topology appends after the map; a failed decode rolls back to the map.
unsafe fn handle_topology_upload(frame: &[u8]) -> pb::ServerMessage {
    *addr_of_mut!(TOPO) = None;
    let cp = arena_ref().checkpoint();
    match decode_submit_topology(frame, frame.len(), arena_ref()) {
        Ok(topo) => {
            let reply = player().topology_stored(topo.map_id.as_str());
            if matches!(
                reply.r#msg,
                Some(pb::ServerMessage_::Msg::ResultReady(_))
            ) {
                *addr_of_mut!(TOPO) = Some(topo);
            } else {
                drop(topo);
                arena_mut().reset_to(cp);
            }
            reply
        }
        Err(e) => {
            arena_mut().reset_to(cp);
            upload_error(e)
        }
    }
}

fn upload_error(e: StoreError) -> pb::ServerMessage {
    match e {
        StoreError::ArenaFull => upload_too_large(),
        _ => upload_malformed(),
    }
}

// -- render-side accessors (pure reads; the FastLED loop polls these) --------

/// Mapping-pattern timing: writes [epoch_ms, bit_period_ms] and
/// [cycle_frames, led_count]; false when no capture is active.
#[no_mangle]
pub unsafe extern "C" fn lm_pattern_timing(
    epoch_ms: *mut f64,
    bit_period_ms: *mut f64,
    cycle_frames: *mut u32,
    led_count: *mut u32,
) -> bool {
    match player().pattern_timing() {
        Some((epoch, period, frames, leds)) => {
            *epoch_ms = epoch;
            *bit_period_ms = period;
            *cycle_frames = frames;
            *led_count = leds;
            true
        }
        None => false,
    }
}

/// Record that the frame loop just pushed mapping-pattern frame `seq` (the
/// absolute frame index since the pattern epoch, before the cycle modulo) to
/// the LEDs at player monotonic clock `t_mono_ms`. Buffered for the phone to
/// drain via get_frame_timing (stutter diagnosis). Cheap ring write — call it
/// unconditionally right after the strip update.
#[no_mangle]
pub unsafe extern "C" fn lm_pattern_frame_shown(seq: u32, t_mono_ms: f64) {
    player().record_frame_shown(seq, t_mono_ms);
}

/// The color LED `led` shows in mapping cycle frame `frame_index`
/// (caller reduces modulo cycle_frames). False when no capture is active.
#[no_mangle]
pub unsafe extern "C" fn lm_pattern_color(led: u32, frame_index: u32, rgb: *mut u8) -> bool {
    match player().pattern_color(led, frame_index) {
        Some((r, g, b)) => {
            *rgb = r;
            *rgb.add(1) = g;
            *rgb.add(2) = b;
            true
        }
        None => false,
    }
}

/// The color LED `led` shows under the latched counting pattern (blocks
/// paint, everything else off). False when no counting pattern is latched.
#[no_mangle]
pub unsafe extern "C" fn lm_counting_color(led: u32, rgb: *mut u8) -> bool {
    match player().counting_color(led) {
        Some((r, g, b)) => {
            *rgb = r;
            *rgb.add(1) = g;
            *rgb.add(2) = b;
            true
        }
        None => false,
    }
}

/// The persisted strip length for `channel` (set_led_count); -1 when unset.
#[no_mangle]
pub unsafe extern "C" fn lm_led_count(channel: u32) -> i32 {
    match player().led_count(channel as usize) {
        Some(n) => n as i32,
        None => -1,
    }
}

/// Number of LEDs in the stored (arena-decoded) map; 0 when none stored.
#[no_mangle]
pub unsafe extern "C" fn lm_map_len() -> u32 {
    (*addr_of!(MAP)).as_ref().map_or(0, |m| m.leds.len() as u32)
}

/// The stored map entry at `index`: id + xyz (meters). False out of range.
#[no_mangle]
pub unsafe extern "C" fn lm_map_led(index: u32, id: *mut u32, xyz: *mut f32) -> bool {
    match (*addr_of!(MAP)).as_ref().and_then(|m| m.leds.get(index as usize)) {
        Some(led) => {
            *id = led.id;
            *xyz = led.xyz[0];
            *xyz.add(1) = led.xyz[1];
            *xyz.add(2) = led.xyz[2];
            true
        }
        None => false,
    }
}
