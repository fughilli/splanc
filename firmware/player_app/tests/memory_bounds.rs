//! The player bounds its memory pressure instead of growing with its input —
//! the risk control against heap exhaustion/fragmentation on the C6. Driven
//! through the C ABI exactly as main.cpp drives it:
//!
//! * streamed, not resident — an upload decodes through one small fixed block
//!   however large it is;
//! * efficient storage — narrow (`: fixed8`) effect buffers pack per-LED state
//!   into a quarter of the f32 footprint;
//! * monitored — the heap figures handed to the core (lm_perf_set_heap: free,
//!   low-water mark, and the largest contiguous block, i.e. fragmentation) are
//!   carried in the polled and pushed PerfReport. (main.cpp samples them only on
//!   FX-rendered frames with perf on; that sampling is not tested here.)
//! * refused, never overflowed — an upload past the storage arena, an effect
//!   past the effect buffer, a video frame past the texture buffer, LEDs past
//!   the LED cap and effect buffers past the FX arena are rejected / dropped /
//!   clamped with the device left consistent, never written out of bounds.
//!
//! The FFI state is process-global (one player, as on the device), so every
//! test re-initializes it and the target runs with `--test-threads=1`.

use core::ffi::c_void;

use ledmapper_fx_vm::Program;
use ledmapper_pb::ledmapper_::v1_ as pb;
use ledmapper_player_ffi::{
    lm_decode_upload_stream, lm_fx_active, lm_fx_clear, lm_fx_load, lm_fx_set_active, lm_fx_shade,
    lm_fx_update, lm_map_led, lm_map_len, lm_perf_build_report, lm_perf_set_heap, lm_playback_step,
    lm_player_handle, lm_player_init, FX_TOPO_CAP,
};
use micropb::{MessageDecode, MessageEncode, PbEncoder};
use pb::ClientMessage_::Msg as CMsg;
use pb::ServerMessage_::Msg as SMsg;

const ARM_SUBMIT_MAP: i32 = 13;

fn encode(msg: CMsg) -> Vec<u8> {
    let env = pb::ClientMessage { r#msg: Some(msg) };
    let mut enc = PbEncoder::new(micropb::heapless::Vec::<u8, 131072>::new());
    env.encode(&mut enc).unwrap();
    enc.into_writer().to_vec()
}

fn decode_reply(bytes: &[u8]) -> SMsg {
    let mut reply = pb::ServerMessage::default();
    reply.decode_from_bytes(bytes).expect("reply decodes");
    reply.r#msg.expect("reply has an arm")
}

fn handle(frame: &[u8]) -> Option<SMsg> {
    let mut out = vec![0u8; 4096];
    let n = unsafe { lm_player_handle(frame.as_ptr(), frame.len(), 0, 0, out.as_mut_ptr(), out.len()) };
    assert!(n >= 0, "lm_player_handle returned {n}");
    (n > 0).then(|| decode_reply(&out[..n as usize]))
}

fn error_code(reply: Option<SMsg>) -> String {
    match reply {
        Some(SMsg::Error(e)) => e.r#code.as_str().to_string(),
        other => panic!("an error reply expected, got {other:?}"),
    }
}

fn varint(mut v: u64, out: &mut Vec<u8>) {
    loop {
        let b = (v & 0x7f) as u8;
        v >>= 7;
        if v == 0 {
            out.push(b);
            return;
        }
        out.push(b | 0x80);
    }
}

fn len_field(field: u32, bytes: &[u8], out: &mut Vec<u8>) {
    varint(u64::from(field << 3 | 2), out);
    varint(bytes.len() as u64, out);
    out.extend_from_slice(bytes);
}

fn varint_field(field: u32, v: u64, out: &mut Vec<u8>) {
    varint(u64::from(field << 3), out);
    varint(v, out);
}

/// `ClientMessage{submit_effect{effect_id, fxb, activate=true}}` as the app
/// sends it (hand-encoded: the generated bindings cap `fxb` far below a real
/// effect, which is why the player hand-walks this arm too).
fn submit_effect_frame(id: &str, fxb: &[u8]) -> Vec<u8> {
    let mut body = Vec::new();
    len_field(1, id.as_bytes(), &mut body);
    len_field(2, fxb, &mut body);
    varint_field(3, 1, &mut body);
    let mut frame = Vec::new();
    len_field(21, &body, &mut frame);
    frame
}

/// `ClientMessage{set_texture{...}}` (keyframe, no RLE), hand-encoded for the
/// same reason.
fn set_texture_frame(format: u64, width: u64, height: u64, data: &[u8]) -> Vec<u8> {
    let mut body = Vec::new();
    varint_field(1, 0, &mut body); // tex_index
    varint_field(2, format, &mut body);
    varint_field(3, width, &mut body);
    varint_field(4, height, &mut body);
    varint_field(5, 0, &mut body); // flags: keyframe
    len_field(6, data, &mut body);
    let mut frame = Vec::new();
    len_field(28, &body, &mut frame);
    frame
}

fn compile(src: &str) -> Vec<u8> {
    ledmapper_fx_compiler::compile(src)
        .unwrap_or_else(|d| panic!("effect compiles: {d:?}"))
        .fxb
}

fn submit_map_frame(map_id: &str, n: u32) -> Vec<u8> {
    let mut map = Box::new(pb::OutputMap::default());
    map.r#map_id = map_id.parse().unwrap();
    map.r#led_count = n as i32;
    for i in 0..n {
        let mut led = pb::LedEntry { r#id: i as i32, r#confidence: 0.9, r#n_views: 9, ..Default::default() };
        led.r#xyz.extend_from_slice(&[i as f64 * 0.002, 0.1, -0.3]).unwrap();
        map.r#leds.push(led).unwrap();
    }
    let mut submit = pb::SubmitMap::default();
    submit.set_map(*map);
    encode(CMsg::SubmitMap(submit))
}

/// A topology for `map_id` with `segs` free-ended segments of `pts` polyline
/// points each, and one association per LED.
fn topology_frame(map_id: &str, segs: i32, pts: usize, n_leds: u32) -> Vec<u8> {
    let mut topo = Box::new(pb::Topology { r#map_id: map_id.parse().unwrap(), ..Default::default() });
    let mut bp = pb::BranchPoint { r#id: 0, ..Default::default() };
    bp.r#xyz.extend_from_slice(&[0.0, 0.0, 0.0]).unwrap();
    topo.r#branch_points.push(bp).unwrap();
    for s in 0..segs {
        let mut seg = pb::TopologySegment { r#id: s, r#a: 0, r#b: -1, r#length: 1.0, ..Default::default() };
        for p in 0..pts {
            let mut v = pb::Vec3::default();
            v.r#v.extend_from_slice(&[p as f64 * 0.01, s as f64 * 0.01, 0.0]).unwrap();
            seg.r#polyline.push(v).unwrap();
        }
        topo.r#segments.push(seg).unwrap();
    }
    for i in 0..n_leds {
        let a = pb::LedAssociation {
            r#led_id: i as i32,
            r#segment_id: i as i32 % segs,
            r#foot_arclength: 0.5,
            ..Default::default()
        };
        topo.r#associations.push(a).unwrap();
    }
    let mut submit = pb::SubmitTopology::default();
    submit.set_topology(*topo);
    encode(CMsg::SubmitTopology(submit))
}

fn get_stored_map_head() -> pb::StoredMapChunk {
    let g = pb::GetStoredMap { r#offset: 0, r#max_len: 64 };
    match handle(&encode(CMsg::GetStoredMap(g))) {
        Some(SMsg::StoredMapChunk(c)) => c,
        other => panic!("stored_map_chunk expected, got {other:?}"),
    }
}

fn set_pulse_playback() {
    let mut params = pb::PlaybackParams::default();
    params.set_speed(0.5);
    let mut sp = pb::SetPlayback::default();
    sp.r#effect = "pulse".parse().unwrap();
    sp.set_params(params);
    assert!(matches!(handle(&encode(CMsg::SetPlayback(sp))), Some(SMsg::PlaybackState(_))));
}

/// Records how the stream decoder pulls a "flash file" (main.cpp upload_refill).
struct Flash<'a> {
    data: &'a [u8],
    pos: usize,
    calls: usize,
    largest_request: usize,
}

extern "C" fn refill(ctx: *mut c_void, buf: *mut u8, cap: usize) -> usize {
    let f = unsafe { &mut *(ctx as *mut Flash) };
    f.calls += 1;
    f.largest_request = f.largest_request.max(cap);
    let n = cap.min(f.data.len() - f.pos);
    unsafe { core::ptr::copy_nonoverlapping(f.data.as_ptr().add(f.pos), buf, n) };
    f.pos += n;
    n
}

/// Stream-decode a submit_map frame off "flash"; returns (reply, largest single
/// read the decoder asked for, number of reads).
fn stream_decode_map(frame: &[u8]) -> (SMsg, usize, usize) {
    let mut src = Flash { data: frame, pos: 0, calls: 0, largest_request: 0 };
    let mut tx = [0u8; 2048];
    let n = unsafe {
        lm_decode_upload_stream(
            ARM_SUBMIT_MAP,
            refill,
            &mut src as *mut Flash as *mut c_void,
            frame.len(),
            tx.as_mut_ptr(),
            tx.len(),
        )
    };
    assert!(n > 0, "the stream decode replies ({n})");
    assert_eq!(src.pos, frame.len(), "every byte of the frame is read exactly once");
    (decode_reply(&tx[..n as usize]), src.largest_request, src.calls)
}

#[test]
fn uploads_decode_through_one_small_block_whatever_their_size() {
    rr::verifies!("PR-26");
    lm_player_init(64);
    let small = submit_map_frame("m-small", 32);
    let large = submit_map_frame("m-large", FX_TOPO_CAP as u32);
    assert!(large.len() > 16 * 1024, "the large upload is {} B", large.len());
    let (reply, small_block, _) = stream_decode_map(&small);
    assert!(matches!(reply, SMsg::ResultReady(_)));
    let (reply, large_block, large_calls) = stream_decode_map(&large);
    assert!(matches!(reply, SMsg::ResultReady(_)));
    assert_eq!(unsafe { lm_map_len() }, FX_TOPO_CAP as u32);
    // The decode buffer is one fixed small block: it does not grow with the
    // upload, and the large frame is never held whole — it streams through.
    assert_eq!(large_block, small_block, "the block size is independent of the upload size");
    assert!(large_block <= 512, "the decoder reads at most a 512 B block at a time ({large_block})");
    assert!(large_calls >= large.len() / large_block, "the large frame streamed in {large_calls} reads");
}

#[test]
fn an_upload_past_the_storage_arena_is_refused_rolled_back_and_recoverable() {
    rr::verifies!("PR-26");
    lm_player_init(64);
    assert!(matches!(handle(&submit_map_frame("m-big", 64)), Some(SMsg::ResultReady(_))));
    set_pulse_playback();
    // 32 segments x 64 polyline points of geometry: ~24 KiB, three times the
    // topology arena. Refused with the bounded error, never a crash/overflow.
    let too_big = topology_frame("m-big", 32, 64, 64);
    assert_eq!(error_code(handle(&too_big)), "map_too_large");
    // Rolled back: no half-stored topology is left behind to render from.
    assert!(!get_stored_map_head().r#has_topology, "no partial topology is resident");
    assert!(!unsafe { lm_playback_step(33) }, "nothing to play without a topology");
    // The arena was reclaimed: a topology that fits is accepted right after.
    let fits = topology_frame("m-big", 4, 8, 64);
    assert!(matches!(handle(&fits), Some(SMsg::ResultReady(_))));
    assert!(get_stored_map_head().r#has_topology);
    assert!(unsafe { lm_playback_step(33) }, "the recovered topology plays");
}

/// An effect whose bytecode outgrows the player's 4 KiB effect buffer: a long
/// unrolled shade, compiled for real.
fn oversized_effect_source() -> String {
    let mut src = String::from("vec3 shade(Led led) {\n  float x = 0.0;\n");
    for k in 0..600 {
        src.push_str(&format!("  x = x + sin(led.pos.x * {}.25);\n", k + 1));
    }
    src.push_str("  return vec3(fract(x), 0.0, 0.0);\n}\n");
    src
}

#[test]
fn an_effect_past_the_effect_buffer_is_refused_and_the_running_one_keeps_rendering() {
    rr::verifies!("PR-26");
    lm_player_init(64);
    unsafe { lm_fx_clear() };
    let good = compile("vec3 shade(Led led) { return vec3(0.0, 1.0, 0.0); }\n");
    assert!(matches!(handle(&submit_effect_frame("green", &good)), Some(SMsg::ResultReady(_))));
    let huge = compile(&oversized_effect_source());
    assert!(huge.len() > 4 * 1024, "the oversized effect is {} B of bytecode", huge.len());
    assert_eq!(error_code(handle(&submit_effect_frame("huge", &huge))), "effect_too_large");
    // Nothing of the refused effect was loaded: the running effect is intact.
    assert!(unsafe { lm_fx_active() });
    assert!(unsafe { lm_fx_update(0.0, 1.0 / 30.0, 0, 8) });
    let mut rgb = [0u8; 3];
    assert!(unsafe { lm_fx_shade(0, 0.0, 0.0, 0.0, rgb.as_mut_ptr()) });
    assert_eq!(rgb, [0, 255, 0], "the previously running effect still renders unchanged");
}

#[test]
fn video_frames_past_the_texture_buffer_are_dropped_and_frames_within_it_apply() {
    rr::verifies!("PR-26");
    lm_player_init(64);
    unsafe { lm_fx_clear() };
    // A 64x64 texture stored at 1 byte per channel: 12 KiB, inside the FX arena.
    let fxb = compile(
        "texture vec3 v(64, 64) : fixed8;\n\
         void update() {}\n\
         vec3 shade(Led led) { return sample(v, led.uv); }\n",
    );
    assert!(unsafe { lm_fx_load(fxb.as_ptr(), fxb.len()) });
    unsafe { lm_fx_set_active(true) };
    assert!(unsafe { lm_fx_update(0.0, 1.0 / 30.0, 0, 8) });
    let sample = || {
        let mut rgb = [0u8; 3];
        assert!(unsafe { lm_fx_shade(0, 0.0, 0.0, 0.0, rgb.as_mut_ptr()) });
        rgb
    };
    const RGB888: u64 = 0;
    const GRAY8: u64 = 3;
    // An RGB888 frame of it is 12 KiB — more than the 8 KiB frame buffer: dropped.
    assert!(handle(&set_texture_frame(RGB888, 64, 64, &[0xFF; 64 * 64 * 3])).is_none());
    assert_eq!(sample(), [0, 0, 0], "the oversized frame never reached the texture");
    // The same picture as GRAY8 is 4 KiB: within budget, applied.
    assert!(handle(&set_texture_frame(GRAY8, 64, 64, &[0xFF; 64 * 64])).is_none());
    assert_eq!(sample(), [255, 255, 255]);
    // A later oversized frame is dropped without disturbing the applied texture.
    assert!(handle(&set_texture_frame(RGB888, 64, 64, &[0x00; 64 * 64 * 3])).is_none());
    assert_eq!(sample(), [255, 255, 255]);
}

#[test]
fn heap_figures_handed_to_the_core_are_carried_in_the_polled_and_pushed_perf_report() {
    rr::verifies!("PR-26");
    lm_player_init(64);
    let sp = pb::SetPerf { r#mode: pb::SetPerf_::Mode::Basic, r#interval_ms: 0 };
    assert!(matches!(handle(&encode(CMsg::SetPerf(sp))), Some(SMsg::PerfReport(_))));
    // Free heap, its low-water mark, and the largest contiguous block (the real
    // ceiling on one allocation — free-but-fragmented is the TLS-handshake OOM).
    unsafe { lm_perf_set_heap(31_000, 12_500, 9_200) };
    let Some(SMsg::PerfReport(r)) = handle(&encode(CMsg::GetPerfReport(pb::GetPerfReport::default()))) else {
        panic!("perf_report expected");
    };
    assert_eq!((r.r#heap_free, r.r#heap_min_free, r.r#heap_largest_free), (31_000, 12_500, 9_200));
    // A later, more fragmented sample is what the next (pushed) report carries.
    unsafe { lm_perf_set_heap(30_400, 11_000, 4_100) };
    let mut buf = vec![0u8; 2048];
    let n = unsafe { lm_perf_build_report(buf.as_mut_ptr(), buf.len()) };
    assert!(n > 0, "a perf mode is active, so a report is pushed ({n})");
    match decode_reply(&buf[..n as usize]) {
        SMsg::PerfReport(p) => {
            assert_eq!((p.r#heap_free, p.r#heap_min_free, p.r#heap_largest_free), (30_400, 11_000, 4_100))
        }
        other => panic!("pushed frame is a perf_report, got {other:?}"),
    }
}

#[test]
fn map_leds_past_the_led_cap_are_validated_but_never_stored() {
    rr::verifies!("PR-26");
    lm_player_init(64);
    let cap = FX_TOPO_CAP as u32;
    match handle(&submit_map_frame("m-over", cap + 16)) {
        Some(SMsg::ResultReady(r)) => assert_eq!(r.r#map_id.as_str(), "m-over"),
        other => panic!("the (whole-frame validated) upload is accepted, got {other:?}"),
    }
    assert_eq!(unsafe { lm_map_len() }, cap + 16, "the map reports what was uploaded");
    // Every stored LED keeps its own position: the extra LEDs neither spill past
    // the per-LED storage nor wrap around onto the first entries.
    for i in [0, 1, 15, cap - 1] {
        let (mut id, mut xyz) = (0u32, [0f32; 3]);
        assert!(unsafe { lm_map_led(i, &mut id, xyz.as_mut_ptr()) });
        assert!((xyz[0] - i as f32 * 0.002).abs() < 1e-5, "led {i} holds its own position, got {}", xyz[0]);
    }
    let (mut id, mut xyz) = (0u32, [0f32; 3]);
    assert!(!unsafe { lm_map_led(cap, &mut id, xyz.as_mut_ptr()) }, "nothing is stored past the LED cap");
}

/// Four vec4 per-LED buffers; shade() reports what the previous frame stored
/// (a.x, c.y, d.z) and then stores 0.5 / 0.5 / 0.25 / 1.0 into a / b / c / d.
fn four_buffers_source(storage: &str) -> String {
    format!(
        "buffer vec4 a{storage};\nbuffer vec4 b{storage};\nbuffer vec4 c{storage};\nbuffer vec4 d{storage};\n\
         vec3 shade(Led led) {{\n\
           vec3 seen = vec3(a[led.idx].x, c[led.idx].y, d[led.idx].z);\n\
           a[led.idx] = vec4(0.5, 0.5, 0.5, 0.5);\n\
           b[led.idx] = vec4(0.5, 0.5, 0.5, 0.5);\n\
           c[led.idx] = vec4(0.25, 0.25, 0.25, 0.25);\n\
           d[led.idx] = vec4(1.0, 1.0, 1.0, 1.0);\n\
           return seen;\n\
         }}\n"
    )
}

/// Run two frames of `fxb` over a `leds`-LED strip and return the second
/// frame's colours (what each LED read back from its first-frame state).
fn second_frame_colours(fxb: &[u8], leds: u32) -> Vec<[u8; 3]> {
    lm_player_init(64);
    unsafe { lm_fx_clear() };
    assert!(unsafe { lm_fx_load(fxb.as_ptr(), fxb.len()) });
    unsafe { lm_fx_set_active(true) };
    let mut out = Vec::new();
    for frame in 0..2u32 {
        assert!(unsafe { lm_fx_update(frame as f32 / 30.0, 1.0 / 30.0, frame, leds) });
        out.clear();
        for i in 0..leds {
            let mut rgb = [0u8; 3];
            assert!(unsafe { lm_fx_shade(i, 0.0, 0.0, 0.0, rgb.as_mut_ptr()) });
            out.push(rgb);
        }
    }
    out
}

#[test]
fn narrow_buffers_keep_per_led_state_in_a_quarter_of_the_memory() {
    rr::verifies!("PR-26");
    let cap = FX_TOPO_CAP;
    let wide = compile(&four_buffers_source(""));
    let narrow = compile(&four_buffers_source(" : fixed8"));
    let wide_bytes = Program::parse(&wide).expect("parses").arena_bytes(cap);
    let narrow_bytes = Program::parse(&narrow).expect("parses").arena_bytes(cap);
    assert_eq!(wide_bytes, cap * 4 * 4 * 4, "f32 storage: 16 B per vec4 per LED per buffer");
    assert_eq!(narrow_bytes * 4, wide_bytes, "fixed8 storage packs the same state in a quarter");
    // The packed effect runs at the LED cap with every buffer of every LED intact.
    let colours = second_frame_colours(&narrow, cap as u32);
    assert!(colours.iter().all(|c| *c == [127, 63, 255]), "every LED read back its stored state");
}

#[test]
fn effect_buffers_past_the_fx_arena_are_clamped_never_written_out_of_bounds() {
    rr::verifies!("PR-26");
    // Four f32 vec4 buffers on a 512-LED strip need 32 KiB; the FX arena holds
    // 24 KiB, so the fourth buffer starts exactly at the arena's end.
    const LEDS: u32 = 512;
    let wide = compile(&four_buffers_source(""));
    assert_eq!(Program::parse(&wide).expect("parses").arena_bytes(LEDS as usize), 32 * 1024);
    let colours = second_frame_colours(&wide, LEDS);
    // The buffers that fit keep their state; the one past the arena end is
    // clamped (reads zero, writes dropped) instead of spilling into other RAM.
    assert!(
        colours.iter().all(|c| *c == [127, 63, 0]),
        "a / c intact, d clamped: {:?}",
        &colours[..4]
    );
}
