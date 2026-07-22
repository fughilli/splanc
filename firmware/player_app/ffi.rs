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

use core::sync::atomic::AtomicBool;

use ledmapper_arena::Arena;
use ledmapper_fx_vm::{Budget, Frame as FxFrame, Led as FxLed, Outcome, Program, Vm as FxVm};
use ledmapper_pb::ledmapper_::v1_ as pb;
use ledmapper_player::{upload_malformed, upload_too_large, Player};
use ledmapper_pulse::{Graph, Sim, MAX_SEGMENTS};
use ledmapper_store::{
    decode_submit_map, decode_submit_topology, dump, envelope_arm, StoreError, StoredMap,
    StoredTopology, ARM_GET_STORED_MAP, ARM_SUBMIT_MAP, ARM_SUBMIT_TOPOLOGY,
};
use micropb::{MessageDecode, MessageEncode, PbDecoder, PbEncoder};

/// Storage for the decoded map + topology (Phase 3 arena). Reset wholesale per
/// upload, so it only holds ONE map+topology at a time. Sized to the firmware's
/// 256-LED cap (~16 B/LED → ~4 KB map; with topology + bump-arena grow-churn the
/// worst case is ~16 KB), 32 KiB gives 2× margin. This was 96 KiB (sized for a
/// ~5000-LED map we can't drive) — the reclaimed 64 KB of .bss is heap the
/// TLS/wss handshake needs for its 16 KB record buffers. ArenaFull is still the
/// bounded answer for an over-large upload.
const ARENA_BYTES: usize = 32 * 1024;

/// Reply frames are control traffic (firmware caps): welcome is the
/// largest at a few hundred bytes.
const REPLY_CAP: usize = 2048;

static mut ARENA_MEM: [u8; ARENA_BYTES] = [0; ARENA_BYTES];
static mut ARENA: Option<Arena<'static>> = None;
static mut MAP: Option<StoredMap<'static>> = None;
static mut TOPO: Option<StoredTopology<'static>> = None;
static mut PLAYER: Option<Player> = None;

/// The topology-aware effect simulator, rebuilt lazily from TOPO + the active
/// effect config. `SIM_GEN` records the `playback_gen` it was built for so a
/// config change forces a rebuild; a topology upload nulls SIM directly.
static mut SIM: Option<Sim> = None;
static mut SIM_GEN: u32 = u32::MAX;

// -- effects VM (fx_vm) -------------------------------------------------------
// The active `.fxb` lives in a fixed static buffer the C++ side copies the
// upload into (lm_fx_load); the parsed Program borrows it fresh each call
// (a cheap header parse, like the wasm preview) so nothing is self-referential.
// The Vm holds the persistent uniforms + state across frames. Bounded execution
// (docs/design/effects-runtime.md) guards every invocation: a per-call
// instruction budget (primary) and a wall-time deadline flag a hardware timer
// raises (secondary).

/// Max `.fxb` the player will hold. A compiled effect is small (bytecode +
/// manifest); 8 KiB is generous and bounds the static cost.
const FX_MAX_BYTES: usize = 8 * 1024;

static mut FX_BYTES: [u8; FX_MAX_BYTES] = [0; FX_MAX_BYTES];
static mut FX_LEN: usize = 0;
static mut FX_VM: Option<FxVm> = None;
/// Whether the loaded effect is the ACTIVE one the render loop drives. An
/// upload with `activate=false` parks the effect (loaded, validated) without
/// taking over rendering; set_effect can activate it, or clear it.
static mut FX_ACTIVE: bool = false;
/// Wall-time cancel flag, raised by the C++ hardware-timer callback at a
/// frame-relative deadline; the VM loop polls it and unwinds to a timeout.
static FX_DEADLINE: AtomicBool = AtomicBool::new(false);
/// Per-invocation instruction budget for one update()/shade(). Tunable from
/// C++ (lm_fx_set_budget); defaults to the VM's default.
static mut FX_BUDGET: u32 = ledmapper_fx_vm::DEFAULT_BUDGET;

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
        *addr_of_mut!(SIM) = None;
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
    recv_ms: i64,
    send_ms: i64,
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
        // Dump the stored map+topology (it lives in the arena, not the session
        // core) back out to the phone, one MappingBundle byte-window per call.
        Some(ARM_GET_STORED_MAP) => handle_get_stored_map(frame),
        // Effects arms: decoded by a hand-rolled walker (the firmware profile
        // caps SubmitEffect.fxb at 64 B), then loaded/selected/tuned on the VM.
        Some(ARM_SUBMIT_EFFECT) => handle_submit_effect(frame),
        Some(ARM_SET_EFFECT) => handle_set_effect(frame),
        Some(ARM_SET_UNIFORMS) => handle_set_uniforms(frame),
        Some(ARM_GET_EFFECT_UNIFORMS) => handle_get_effect_uniforms(frame),
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
    *addr_of_mut!(SIM) = None;
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
    *addr_of_mut!(SIM) = None;
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

/// Stream a byte window of the stored map+topology re-encoded as a
/// MappingBundle. The phone requests [offset, offset+max_len) repeatedly until
/// it has `total_len` bytes. `no_map` when nothing is stored.
unsafe fn handle_get_stored_map(frame: &[u8]) -> pb::ServerMessage {
    let mut env = pb::ClientMessage::default();
    let mut dec = PbDecoder::new(frame);
    dec.ignore_repeated_cap_err = true;
    let (offset, max_len) = match env.decode(&mut dec, frame.len()) {
        Ok(()) => match env.r#msg {
            Some(pb::ClientMessage_::Msg::GetStoredMap(g)) => {
                (g.r#offset.max(0) as usize, g.r#max_len.max(1) as usize)
            }
            _ => return upload_malformed(),
        },
        Err(_) => return upload_malformed(),
    };
    let Some(map) = (*addr_of!(MAP)).as_ref() else {
        return dump_error("no_map", "no stored map to dump");
    };
    let topo = (*addr_of!(TOPO)).as_ref();
    let total = dump::bundle_len(map, topo);
    // Bound the chunk by the reply field capacity (StoredMapChunk.data).
    let cap = max_len.min(1024);
    let mut chunk = [0u8; 1024];
    let n = if offset < total {
        dump::encode_bundle_window(map, topo, offset, &mut chunk[..cap])
    } else {
        0
    };
    let mut m = pb::StoredMapChunk::default();
    m.r#total_len = total as i32;
    m.r#offset = offset as i32;
    let _ = m.r#data.extend_from_slice(&chunk[..n]);
    m.r#has_topology = topo.is_some();
    pb::ServerMessage { r#msg: Some(pb::ServerMessage_::Msg::StoredMapChunk(m)) }
}

fn dump_error(code: &str, message: &str) -> pb::ServerMessage {
    let mut e = pb::Error::default();
    let _ = e.r#code.push_str(code);
    let _ = e.r#message.push_str(message);
    pb::ServerMessage { r#msg: Some(pb::ServerMessage_::Msg::Error(e)) }
}

/// The oneof arm (first-tag field number) of a protocol envelope, or -1 if it
/// can't be read. Lets the C app classify a frame without a full protobuf
/// decode — e.g. a request as submit_map (13) / submit_topology (16) and a
/// reply as result_ready (8) — so it can persist only successful uploads.
///
/// # Safety
/// `data` must point to `len` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn lm_envelope_arm(data: *const u8, len: usize) -> i32 {
    if data.is_null() || len == 0 {
        return -1;
    }
    let s = core::slice::from_raw_parts(data, len);
    envelope_arm(s).map(|a| a as i32).unwrap_or(-1)
}

// -- effects protocol dispatch (submit_effect / set_effect / set_uniforms /
//    get_effect_uniforms) -----------------------------------------------------
//
// These are decoded by a tiny hand-rolled protobuf walker rather than the
// generated envelope, exactly like the arena upload arms: the firmware profile
// caps `SubmitEffect.fxb` at 64 B and `SetUniforms.values` at a handful, far
// too small for a real effect, so the generated decode can't be used. Walking
// the raw frame lets a full `.fxb` (up to FX_MAX_BYTES) and any number of
// uniform slots ride the same fixed statics the VM already owns.

/// ClientMessage oneof field numbers for the effect arms.
const ARM_SUBMIT_EFFECT: u32 = 21;
const ARM_SET_EFFECT: u32 = 22;
const ARM_SET_UNIFORMS: u32 = 23;
const ARM_GET_EFFECT_UNIFORMS: u32 = 24;

/// Read a base-128 varint at `buf[*o..]`, advancing `*o`. None on truncation.
fn rd_varint(buf: &[u8], o: &mut usize) -> Option<u64> {
    let mut val: u64 = 0;
    let mut shift = 0u32;
    while *o < buf.len() {
        let b = buf[*o];
        *o += 1;
        val |= u64::from(b & 0x7f) << shift;
        if b & 0x80 == 0 {
            return Some(val);
        }
        shift += 7;
        if shift >= 64 {
            return None;
        }
    }
    None
}

/// Skip a field of the given wire type at `buf[*o..]`. False on truncation.
fn skip_field(buf: &[u8], o: &mut usize, wire: u8) -> bool {
    match wire {
        0 => rd_varint(buf, o).is_some(),
        1 => {
            *o += 8;
            *o <= buf.len()
        }
        5 => {
            *o += 4;
            *o <= buf.len()
        }
        2 => match rd_varint(buf, o) {
            Some(len) => {
                *o += len as usize;
                *o <= buf.len()
            }
            None => false,
        },
        _ => false,
    }
}

/// Unwrap `ClientMessage { <arm> = N }` → the inner message's byte slice for
/// the expected arm number. Returns None if the frame's first field isn't a
/// LEN-delimited field with that number.
fn unwrap_arm(frame: &[u8], arm: u32) -> Option<&[u8]> {
    let mut o = 0;
    let key = rd_varint(frame, &mut o)?;
    let field = (key >> 3) as u32;
    let wire = (key & 7) as u8;
    if field != arm || wire != 2 {
        return None;
    }
    let len = rd_varint(frame, &mut o)? as usize;
    frame.get(o..o + len)
}

/// submit_effect: extract fxb (field 2, LEN) + activate (field 3, varint) from
/// the raw frame, load it into the VM, and (optionally) activate. Reply
/// result_ready(effect_id) or error(bad_fxb / effect_too_large).
unsafe fn handle_submit_effect(frame: &[u8]) -> pb::ServerMessage {
    let Some(body) = unwrap_arm(frame, ARM_SUBMIT_EFFECT) else {
        return fx_error("bad_fxb", "submit_effect is malformed");
    };
    // SubmitEffect { string effect_id = 1; bytes fxb = 2; bool activate = 3; }
    let mut fxb: Option<&[u8]> = None;
    let mut activate = false;
    let mut o = 0;
    while o < body.len() {
        let Some(key) = rd_varint(body, &mut o) else {
            return fx_error("bad_fxb", "submit_effect is malformed");
        };
        let field = (key >> 3) as u32;
        let wire = (key & 7) as u8;
        match (field, wire) {
            (2, 2) => {
                let Some(len) = rd_varint(body, &mut o) else {
                    return fx_error("bad_fxb", "submit_effect is malformed");
                };
                let len = len as usize;
                let Some(s) = body.get(o..o + len) else {
                    return fx_error("bad_fxb", "submit_effect is malformed");
                };
                fxb = Some(s);
                o += len;
            }
            (3, 0) => {
                let Some(v) = rd_varint(body, &mut o) else {
                    return fx_error("bad_fxb", "submit_effect is malformed");
                };
                activate = v != 0;
            }
            _ => {
                if !skip_field(body, &mut o, wire) {
                    return fx_error("bad_fxb", "submit_effect is malformed");
                }
            }
        }
    }
    let Some(fxb) = fxb else {
        return fx_error("bad_fxb", "submit_effect without fxb");
    };
    if fxb.len() > FX_MAX_BYTES {
        return fx_error("effect_too_large", "fxb exceeds this player's effect buffer");
    }
    let ok = lm_fx_load(fxb.as_ptr(), fxb.len());
    if !ok {
        // Distinguish size (bounded) from a parse failure.
        if fxb.len() > FX_MAX_BYTES {
            return fx_error("effect_too_large", "fxb exceeds this player's effect buffer");
        }
        return fx_error("bad_fxb", "fxb failed to parse");
    }
    // activate=true takes over rendering now; false parks it (loaded + valid,
    // set_effect can activate later).
    lm_fx_set_active(activate);
    let mut r = pb::ResultReady::default();
    // effect_id echoes back so the app can correlate the ack.
    if let Some(id) = read_effect_id(body) {
        let _ = r.r#map_id.push_str(id);
    }
    pb::ServerMessage { r#msg: Some(pb::ServerMessage_::Msg::ResultReady(r)) }
}

/// Read a message's `effect_id` (field 1, string) if present.
fn read_effect_id(body: &[u8]) -> Option<&str> {
    let mut o = 0;
    while o < body.len() {
        let key = rd_varint(body, &mut o)?;
        let field = (key >> 3) as u32;
        let wire = (key & 7) as u8;
        if field == 1 && wire == 2 {
            let len = rd_varint(body, &mut o)? as usize;
            let s = body.get(o..o + len)?;
            return core::str::from_utf8(s).ok();
        }
        if !skip_field(body, &mut o, wire) {
            return None;
        }
    }
    None
}

/// set_effect: "" / "off" clears the active effect; any other id keeps the
/// loaded effect active (a single effect is held at a time, matching the arena
/// map). Reply: playback_state (via the session core, so the app's playback UI
/// stays consistent). We just clear/keep and echo the current playback state.
unsafe fn handle_set_effect(frame: &[u8]) -> pb::ServerMessage {
    let id = unwrap_arm(frame, ARM_SET_EFFECT).and_then(read_effect_id).unwrap_or("");
    if id.is_empty() || id == "off" {
        lm_fx_clear();
    } else {
        // Select the (single) loaded effect as active. One effect is held at a
        // time, so any non-empty id activates whatever is loaded.
        lm_fx_set_active(true);
    }
    // Ack with the session's playback state so the app's playback UI stays put.
    player().playback_reply()
}

/// set_uniforms: apply every UniformValue{slot, value[]} to the VM. Reply:
/// playback_state.
unsafe fn handle_set_uniforms(frame: &[u8]) -> pb::ServerMessage {
    if let Some(body) = unwrap_arm(frame, ARM_SET_UNIFORMS) {
        // SetUniforms { repeated UniformValue values = 1; }
        let mut o = 0;
        while o < body.len() {
            let Some(key) = rd_varint(body, &mut o) else { break };
            let field = (key >> 3) as u32;
            let wire = (key & 7) as u8;
            if field == 1 && wire == 2 {
                let Some(len) = rd_varint(body, &mut o) else { break };
                let len = len as usize;
                let Some(uv) = body.get(o..o + len) else { break };
                apply_uniform_value(uv);
                o += len;
            } else if !skip_field(body, &mut o, wire) {
                break;
            }
        }
    }
    player().playback_reply()
}

/// Decode one UniformValue{ uint32 slot = 1; repeated float value = 2; } and
/// push it into the VM. `value` may arrive packed (a single LEN field of f32s)
/// or unpacked (repeated fixed32) — handle both.
unsafe fn apply_uniform_value(uv: &[u8]) {
    let mut slot: u32 = 0;
    let mut vals = [0.0f32; 4];
    let mut n = 0usize;
    let mut o = 0;
    while o < uv.len() {
        let Some(key) = rd_varint(uv, &mut o) else { break };
        let field = (key >> 3) as u32;
        let wire = (key & 7) as u8;
        match (field, wire) {
            (1, 0) => {
                let Some(v) = rd_varint(uv, &mut o) else { break };
                slot = v as u32;
            }
            (2, 2) => {
                // packed floats
                let Some(len) = rd_varint(uv, &mut o) else { break };
                let len = len as usize;
                let Some(p) = uv.get(o..o + len) else { break };
                let mut k = 0;
                while k + 4 <= p.len() && n < vals.len() {
                    vals[n] = f32::from_le_bytes([p[k], p[k + 1], p[k + 2], p[k + 3]]);
                    n += 1;
                    k += 4;
                }
                o += len;
            }
            (2, 5) => {
                // unpacked single float
                let Some(p) = uv.get(o..o + 4) else { break };
                if n < vals.len() {
                    vals[n] = f32::from_le_bytes([p[0], p[1], p[2], p[3]]);
                    n += 1;
                }
                o += 4;
            }
            _ => {
                if !skip_field(uv, &mut o, wire) {
                    break;
                }
            }
        }
    }
    if n > 0 {
        lm_fx_set_uniform(slot, vals.as_ptr(), n);
    }
}

/// get_effect_uniforms: build an EffectUniforms reply carrying the active
/// effect's manifest bytes. `current` uniform values aren't tracked back out
/// (the app holds them); left empty. Error `no_effect` when nothing is loaded.
unsafe fn handle_get_effect_uniforms(_frame: &[u8]) -> pb::ServerMessage {
    if !lm_fx_active() {
        return fx_error("no_effect", "no active effect to describe");
    }
    let bytes = &(*addr_of!(FX_BYTES))[..FX_LEN];
    let Ok(prog) = Program::parse(bytes) else {
        return fx_error("no_effect", "no active effect to describe");
    };
    let mut m = pb::EffectUniforms::default();
    let _ = m.r#manifest.extend_from_slice(prog.manifest);
    pb::ServerMessage { r#msg: Some(pb::ServerMessage_::Msg::EffectUniforms(m)) }
}

fn fx_error(code: &str, message: &str) -> pb::ServerMessage {
    let mut e = pb::Error::default();
    let _ = e.r#code.push_str(code);
    let _ = e.r#message.push_str(message);
    pb::ServerMessage { r#msg: Some(pb::ServerMessage_::Msg::Error(e)) }
}

// -- render-side accessors (pure reads; the FastLED loop polls these) --------

/// Mapping-pattern timing, all INTEGER (the render loop touches no f64):
/// writes epoch_ms (i64), bit_period_us (u32), cycle_frames, led_count. False
/// when no capture is active. Absolute frame index at player-clock ms `t` is
/// `((t - epoch_ms) * 1000) / bit_period_us`.
#[no_mangle]
pub unsafe extern "C" fn lm_pattern_timing(
    epoch_ms: *mut i64,
    bit_period_us: *mut u32,
    cycle_frames: *mut u32,
    led_count: *mut u32,
) -> bool {
    match player().pattern_timing() {
        Some((epoch, period_us, frames, leds)) => {
            *epoch_ms = epoch;
            *bit_period_us = period_us;
            *cycle_frames = frames;
            *led_count = leds;
            true
        }
        None => false,
    }
}

/// Record that the frame loop just pushed mapping-pattern frame `seq` (the
/// absolute frame index since the pattern epoch, before the cycle modulo) to
/// the LEDs at player monotonic clock `t_mono_us` (raw micros(), integer µs).
/// Buffered for the phone to drain via get_frame_timing (stutter diagnosis).
/// Cheap ring write — call it unconditionally right after the strip update.
#[no_mangle]
pub unsafe extern "C" fn lm_pattern_frame_shown(seq: u32, t_mono_us: u32) {
    player().record_frame_shown(seq, t_mono_us);
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

/// Whether a playback effect ("pulse"/"flood") is configured — the render loop
/// drives the LEDs via lm_playback_step + lm_playback_color when so (and no
/// capture/counting is running). LEDs stay black until a topology is uploaded.
#[no_mangle]
pub unsafe extern "C" fn lm_playback_active() -> bool {
    player().effect_config().is_some()
}

/// (Re)build the effect simulator from the stored topology + active config if
/// stale, then advance it by `dt_ms`. Returns whether a renderable sim exists
/// (config active AND a topology is stored). Call once per render frame before
/// the per-LED lm_playback_color sweep.
#[no_mangle]
pub unsafe extern "C" fn lm_playback_step(dt_ms: u32) -> bool {
    ensure_sim();
    match (*addr_of_mut!(SIM)).as_mut() {
        Some(sim) => {
            sim.step(dt_ms);
            true
        }
        None => false,
    }
}

/// Ensure SIM reflects the current TOPO + effect config. A config-only change
/// (a live slider) is ADOPTED IN PLACE so the running animation isn't reset; a
/// fresh sim is built only when none exists yet or the topology was (re)uploaded
/// (which nulls SIM). Nulls SIM when the effect is off or no topology is stored.
unsafe fn ensure_sim() {
    let cfg = match player().effect_config() {
        Some(c) => *c,
        None => {
            *addr_of_mut!(SIM) = None;
            return;
        }
    };
    let gen = player().playback_gen();
    // A sim already exists (same topology): adopt config changes smoothly.
    if let Some(sim) = (*addr_of_mut!(SIM)).as_mut() {
        if SIM_GEN != gen {
            sim.set_config(cfg);
            SIM_GEN = gen;
        }
        return;
    }
    let Some(topo) = (*addr_of!(TOPO)).as_ref() else {
        return;
    };
    // Graph::build takes (branch-point a, b, length_mm) per segment in order;
    // the resulting segment index equals the input position, which is how
    // lm_playback_color maps an association's segment_id back to a sim segment.
    let mut segs = [(0i32, 0i32, 0u32); MAX_SEGMENTS];
    let mut n = 0usize;
    for s in topo.segments.iter() {
        if n >= MAX_SEGMENTS {
            break;
        }
        segs[n] = (s.a, s.b, (s.length * 1000.0) as u32);
        n += 1;
    }
    let graph = Graph::build(&segs[..n]);
    // Vary the PRNG seed per config so successive effects don't replay identically.
    *addr_of_mut!(SIM) = Some(Sim::new(graph, cfg, gen ^ 0x9E37_79B9));
    SIM_GEN = gen;
}

/// The color LED `led` shows under the active effect, from the stepped sim and
/// this LED's stored association (segment index, foot arclength, perpendicular
/// offset). False when no sim is renderable or this LED has no association.
/// Meters→mm uses f32 (hardware on the C6); the sim math itself is integer.
#[no_mangle]
pub unsafe extern "C" fn lm_playback_color(led: u32, rgb: *mut u8) -> bool {
    let Some(sim) = (*addr_of!(SIM)).as_ref() else {
        return false;
    };
    let Some(topo) = (*addr_of!(TOPO)).as_ref() else {
        return false;
    };
    let Some(assoc) = topo.associations.iter().find(|a| a.led_id == led) else {
        return false;
    };
    let Some(idx) = topo.segments.iter().position(|s| s.id == assoc.segment_id) else {
        return false;
    };
    if idx >= MAX_SEGMENTS {
        return false;
    }
    let s_mm = (assoc.foot_arclength * 1000.0) as u32;
    let d_perp_mm = (assoc.d_perp * 1000.0) as u32;
    let (r, g, b) = sim.led_color(idx as u16, s_mm, d_perp_mm);
    *rgb = r;
    *rgb.add(1) = g;
    *rgb.add(2) = b;
    true
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

// -- effects VM FFI (fx_vm) ---------------------------------------------------
// Single-threaded, like the rest of this file: the render task and the message
// handler both call these under the C++ player_mutex.

/// The per-invocation bounded-execution guard for the active budget + the
/// wall-time deadline flag.
unsafe fn fx_budget() -> Budget {
    Budget {
        instructions: FX_BUDGET,
        deadline: Some(&FX_DEADLINE as *const AtomicBool),
    }
}

/// Load (parse + hold) a `.fxb` effect, copying `len` bytes into the static
/// buffer. Resets the VM's state (fresh effect). Returns false if the bytes
/// don't fit or don't parse as a valid `.fxb`. After a successful load the
/// effect is HELD but not necessarily active (see lm_fx_active is a pure read
/// of "is a program loaded").
///
/// # Safety
/// `fxb` must point to `len` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn lm_fx_load(fxb: *const u8, len: usize) -> bool {
    if fxb.is_null() || len == 0 || len > FX_MAX_BYTES {
        return false;
    }
    let src = core::slice::from_raw_parts(fxb, len);
    // Validate before committing: reject a malformed .fxb so a bad upload can't
    // wedge the render loop on garbage.
    if Program::parse(src).is_err() {
        return false;
    }
    let buf = &mut *addr_of_mut!(FX_BYTES);
    buf[..len].copy_from_slice(src);
    FX_LEN = len;
    *addr_of_mut!(FX_VM) = Some(FxVm::new());
    FX_DEADLINE.store(false, core::sync::atomic::Ordering::Relaxed);
    true
}

/// Clear the loaded effect (back to the built-in playback/idle). Frees nothing
/// (the buffer is static) but marks no program loaded and not active.
#[no_mangle]
pub unsafe extern "C" fn lm_fx_clear() {
    FX_LEN = 0;
    FX_ACTIVE = false;
    *addr_of_mut!(FX_VM) = None;
}

/// Whether an effect is loaded, ACTIVE, and renderable — the render loop gates
/// on this, taking priority over the built-in pulse/flood playback.
#[no_mangle]
pub unsafe extern "C" fn lm_fx_active() -> bool {
    FX_ACTIVE && FX_LEN > 0 && (*addr_of!(FX_VM)).is_some()
}

/// Whether an effect is loaded at all (active or parked). Used by persistence.
#[no_mangle]
pub unsafe extern "C" fn lm_fx_loaded() -> bool {
    FX_LEN > 0 && (*addr_of!(FX_VM)).is_some()
}

/// Mark the loaded effect active (true) or parked (false). No-op with nothing
/// loaded.
#[no_mangle]
pub unsafe extern "C" fn lm_fx_set_active(active: bool) {
    if FX_LEN > 0 && (*addr_of!(FX_VM)).is_some() {
        FX_ACTIVE = active;
    }
}

/// Set the max instruction count for one update()/shade() invocation (bounded
/// execution, primary guard). 0 restores the default.
#[no_mangle]
pub unsafe extern "C" fn lm_fx_set_budget(instructions: u32) {
    FX_BUDGET = if instructions == 0 {
        ledmapper_fx_vm::DEFAULT_BUDGET
    } else {
        instructions
    };
}

/// Raise/lower the wall-time deadline flag (secondary guard). The C++ hardware
/// timer callback calls this with `true` at the frame deadline; the render loop
/// clears it (false) before each frame's update()/shade() sweep. Cheap atomic
/// store — safe to call from an ISR/timer context. TODO(hw): wire an
/// esp_timer/systimer one-shot armed each frame to invoke this at the deadline.
#[no_mangle]
pub extern "C" fn lm_fx_set_deadline(hit: bool) {
    FX_DEADLINE.store(hit, core::sync::atomic::Ordering::Relaxed);
}

/// Apply a uniform value (`vals` = its slot count, 1..4) to the active VM.
///
/// # Safety
/// `vals` must point to `n` readable f32.
#[no_mangle]
pub unsafe extern "C" fn lm_fx_set_uniform(slot: u32, vals: *const f32, n: usize) {
    if vals.is_null() || n == 0 {
        return;
    }
    if let Some(vm) = (*addr_of_mut!(FX_VM)).as_mut() {
        let s = core::slice::from_raw_parts(vals, n);
        vm.set_uniform(slot as usize, s);
    }
}

/// Run `update()` once for this frame (before the per-LED shade sweep). Clears
/// the wall-time deadline flag first (a fresh frame gets the full budget).
/// Returns false when no effect is loaded. A cancelled update (budget/timeout)
/// still returns true — a partial state advance is harmless.
#[no_mangle]
pub unsafe extern "C" fn lm_fx_update(time_s: f32, dt_s: f32, frame: u32, led_count: u32) -> bool {
    FX_DEADLINE.store(false, core::sync::atomic::Ordering::Relaxed);
    let Some(vm) = (*addr_of_mut!(FX_VM)).as_mut() else {
        return false;
    };
    let bytes = &(*addr_of!(FX_BYTES))[..FX_LEN];
    let Ok(prog) = Program::parse(bytes) else {
        return false;
    };
    let f = FxFrame {
        time: time_s,
        dt: dt_s,
        frame,
        led_count,
        ..Default::default()
    };
    vm.run_update_bounded(&prog, &f, &fx_budget());
    true
}

/// Shade one LED: run `shade(led)` → rgb (3 bytes). `x`,`y`,`z` are the LED's
/// position (the render loop passes the stored map position via lm_map_led).
/// Returns false when no effect is loaded OR the invocation was cancelled by a
/// bounded-execution guard (budget/timeout) — the caller then holds last/black
/// for that LED rather than hanging the render task.
///
/// # Safety
/// `rgb` must point to 3 writable bytes.
#[no_mangle]
pub unsafe extern "C" fn lm_fx_shade(
    idx: u32,
    x: f32,
    y: f32,
    z: f32,
    rgb: *mut u8,
) -> bool {
    let Some(vm) = (*addr_of!(FX_VM)).as_ref() else {
        return false;
    };
    let bytes = &(*addr_of!(FX_BYTES))[..FX_LEN];
    let Ok(prog) = Program::parse(bytes) else {
        return false;
    };
    // time/dt/frame carry across from the last update() via the VM's state; the
    // shade only needs the per-frame Frame for time-driven built-ins, which we
    // reconstruct minimally (position is what varies per LED).
    let f = FxFrame::default();
    let led = FxLed {
        pos: [x, y, z],
        idx,
        seg: -1,
        s: 0.0,
        branch: false,
    };
    let ((r, g, b), outcome) = vm.run_shade_bounded(&prog, &f, &led, &fx_budget());
    if outcome != Outcome::Ok {
        return false;
    }
    *rgb = r;
    *rgb.add(1) = g;
    *rgb.add(2) = b;
    true
}

/// Copy the active effect's uniforms manifest into `out` (cap `cap`). Returns
/// the manifest length written, or -1 when no effect is loaded, or -2 when the
/// manifest doesn't fit `cap`. Used to build the get_effect_uniforms reply.
///
/// # Safety
/// `out` must point to `cap` writable bytes.
#[no_mangle]
pub unsafe extern "C" fn lm_fx_manifest(out: *mut u8, cap: usize) -> i32 {
    if FX_LEN == 0 {
        return -1;
    }
    let bytes = &(*addr_of!(FX_BYTES))[..FX_LEN];
    let Ok(prog) = Program::parse(bytes) else {
        return -1;
    };
    let m = prog.manifest;
    if m.len() > cap {
        return -2;
    }
    if !out.is_null() && !m.is_empty() {
        core::ptr::copy_nonoverlapping(m.as_ptr(), out, m.len());
    }
    m.len() as i32
}
