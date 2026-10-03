//! The device's fixed memory budget carries the workloads it is meant to run.
//! The player keeps no heap: a fixed reassembly path for uploads (1 KiB windows
//! appended to flash, decoded back in small blocks), an 8 KiB arena for topology
//! geometry, per-LED caches sized to the LED cap, and a static FX arena for
//! effect buffers. These tests drive the C ABI exactly as main.cpp does and
//! check that the intended workloads complete on that budget:
//!
//! * networking — a map at the full LED cap arrives as sharded UploadChunk
//!   windows (the size the netstack/BLE transports use) and decodes off "flash";
//! * control — the topology of a realistic scan is stored beside its map and is
//!   playable and dumpable;
//! * effects — an effect keeping per-LED state renders every LED at the cap.
//!
//! The FFI state is process-global (one player, as on the device), so every
//! test re-initializes it and the target runs with `--test-threads=1`.

use core::ffi::c_void;

use ledmapper_pb::ledmapper_::v1_ as pb;
use ledmapper_player_ffi::{
    lm_decode_upload_stream, lm_encode_chunk_ack, lm_fx_clear, lm_fx_load, lm_fx_set_active,
    lm_fx_shade, lm_fx_update, lm_map_led, lm_map_len, lm_parse_upload_chunk, lm_playback_step,
    lm_player_handle, lm_player_init, LmUploadChunk, FX_TOPO_CAP,
};
use micropb::{MessageDecode, MessageEncode, PbEncoder};
use pb::ClientMessage_::Msg as CMsg;
use pb::ServerMessage_::Msg as SMsg;

/// The upload window the netstack + BLE transports send (HITL_CHUNK_BYTES /
/// the web client's uploadChunkBytes on those links).
const WINDOW: usize = 1024;
/// ClientMessage arm numbers main.cpp passes to lm_decode_upload_stream.
const ARM_SUBMIT_MAP: i32 = 13;
const ARM_SUBMIT_TOPOLOGY: i32 = 16;

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

/// A submit_map frame shaped like the phone's: per-LED pose + quality fields
/// plus trajectory/stats the player must skip.
fn submit_map_frame(map_id: &str, n: u32) -> Vec<u8> {
    let mut map = Box::new(pb::OutputMap::default());
    map.r#map_id = map_id.parse().unwrap();
    map.r#created_at = "2026-10-02T00:00:00Z".parse().unwrap();
    map.r#units = "meters".parse().unwrap();
    map.r#frame = "gravity_leveled".parse().unwrap();
    map.r#led_count = n as i32;
    for i in 0..n {
        let mut led = pb::LedEntry { r#id: i as i32, r#confidence: 0.9, r#n_views: 12, ..Default::default() };
        led.r#xyz
            .extend_from_slice(&[i as f64 * 0.003, 0.5 - i as f64 * 0.001, 1.25])
            .unwrap();
        map.r#leds.push(led).unwrap();
    }
    for i in 0..32 {
        let mut p = pb::Vec3::default();
        p.r#v.extend_from_slice(&[i as f64 * 0.1, 1.5, 0.0]).unwrap();
        map.r#trajectory.push(p).unwrap();
    }
    let mut submit = pb::SubmitMap::default();
    submit.set_map(*map);
    encode(CMsg::SubmitMap(submit))
}

/// The topology a solver emits for a ~150-LED scan (the FUG-74 shape): 12 branch
/// points, 12 segments x 20 polyline points, one association per LED.
fn scan_topology_frame(map_id: &str, n_leds: u32) -> Vec<u8> {
    const SEGS: i32 = 12;
    const PTS: usize = 20;
    let mut topo = Box::new(pb::Topology { r#map_id: map_id.parse().unwrap(), ..Default::default() });
    for id in 0..SEGS {
        let mut bp = pb::BranchPoint { r#id: id, ..Default::default() };
        bp.r#xyz.extend_from_slice(&[id as f64 * 0.1, 0.2, 0.0]).unwrap();
        topo.r#branch_points.push(bp).unwrap();
    }
    for s in 0..SEGS {
        let mut seg = pb::TopologySegment {
            r#id: 100 + s,
            r#a: s,
            r#b: if s + 1 < SEGS { s + 1 } else { -1 },
            r#length: 0.5,
            ..Default::default()
        };
        for p in 0..PTS {
            let mut v = pb::Vec3::default();
            let t = p as f64 / PTS as f64;
            v.r#v.extend_from_slice(&[s as f64 * 0.1 + t * 0.1, 0.2, t * 0.01]).unwrap();
            seg.r#polyline.push(v).unwrap();
        }
        topo.r#segments.push(seg).unwrap();
    }
    for i in 0..n_leds {
        let a = pb::LedAssociation {
            r#led_id: i as i32,
            r#segment_id: 100 + (i as i32 % SEGS),
            r#foot_arclength: (i / SEGS as u32) as f64 * 0.04,
            r#d_perp: 0.002,
            ..Default::default()
        };
        topo.r#associations.push(a).unwrap();
    }
    let mut submit = pb::SubmitTopology::default();
    submit.set_topology(*topo);
    encode(CMsg::SubmitTopology(submit))
}

/// One UploadChunk window as the web client sends it.
fn upload_chunk(
    upload_id: u32,
    seq: u32,
    last: bool,
    kind: pb::UploadChunk_::Kind,
    payload: &[u8],
) -> Vec<u8> {
    let mut c = pb::UploadChunk { r#upload_id, r#seq: seq, r#last: last, r#kind: kind, ..Default::default() };
    c.r#payload.extend_from_slice(payload).expect("window within the host payload cap");
    encode(CMsg::UploadChunk(c))
}

/// The "flash file" the decoder streams back, as main.cpp's upload_refill reads
/// the reassembled LittleFS temp file.
struct Flash<'a> {
    data: &'a [u8],
    pos: usize,
}

extern "C" fn refill(ctx: *mut c_void, buf: *mut u8, cap: usize) -> usize {
    let f = unsafe { &mut *(ctx as *mut Flash) };
    let n = cap.min(f.data.len() - f.pos);
    unsafe { core::ptr::copy_nonoverlapping(f.data.as_ptr().add(f.pos), buf, n) };
    f.pos += n;
    n
}

/// Shard `frame` into `WINDOW`-byte UploadChunk windows and push them through the
/// transport path main.cpp's process_upload_chunk implements: parse each window
/// with lm_parse_upload_chunk, append its payload to the flash file, ack every
/// non-final window, and on the last one stream-decode the file. Returns the
/// final reply.
fn upload_sharded(frame: &[u8], kind: pb::UploadChunk_::Kind, arm: i32) -> SMsg {
    let mut flash: Vec<u8> = Vec::new();
    let windows: Vec<&[u8]> = frame.chunks(WINDOW).collect();
    for (seq, payload) in windows.iter().enumerate() {
        let last = seq + 1 == windows.len();
        let wire = upload_chunk(9, seq as u32, last, kind, payload);
        let mut ch = LmUploadChunk { upload_id: 0, seq: 0, payload_off: 0, payload_len: 0, kind: 0, last: 0 };
        assert_eq!(unsafe { lm_parse_upload_chunk(wire.as_ptr(), wire.len(), &mut ch) }, 1);
        assert_eq!((ch.upload_id, ch.seq, ch.last != 0), (9, seq as u32, last));
        let off = ch.payload_off as usize;
        flash.extend_from_slice(&wire[off..off + ch.payload_len as usize]);
        if !last {
            let mut tx = [0u8; 64];
            let n = unsafe { lm_encode_chunk_ack(9, seq as u32, tx.as_mut_ptr(), tx.len()) };
            assert!(n > 0, "chunk_ack fits a small reply buffer");
            match decode_reply(&tx[..n as usize]) {
                SMsg::ChunkAck(a) => assert_eq!((a.r#upload_id, a.r#seq), (9, seq as u32)),
                other => panic!("chunk_ack expected, got {other:?}"),
            }
        }
    }
    assert_eq!(flash, frame, "the windows reassemble the frame byte-exactly");
    let mut src = Flash { data: &flash, pos: 0 };
    let mut tx = [0u8; 2048];
    let n = unsafe {
        lm_decode_upload_stream(
            arm,
            refill,
            &mut src as *mut Flash as *mut c_void,
            flash.len(),
            tx.as_mut_ptr(),
            tx.len(),
        )
    };
    assert!(n > 0, "the stream decode replies ({n})");
    decode_reply(&tx[..n as usize])
}

#[test]
fn a_map_at_the_full_led_cap_uploads_in_small_windows_and_decodes_off_flash() {
    rr::verifies!("PR-21");
    lm_player_init(64);
    let cap = FX_TOPO_CAP as u32;
    let frame = submit_map_frame("m-cap", cap);
    // Far bigger than one transport frame: it only fits the device sharded.
    assert!(frame.len() > 16 * WINDOW, "a full-cap map is a multi-window upload ({} B)", frame.len());
    match upload_sharded(&frame, pb::UploadChunk_::Kind::Map, ARM_SUBMIT_MAP) {
        SMsg::ResultReady(r) => assert_eq!(r.r#map_id.as_str(), "m-cap"),
        other => panic!("result_ready expected, got {other:?}"),
    }
    assert_eq!(unsafe { lm_map_len() }, cap);
    // Every LED up to the cap is stored and readable by the render loop.
    for i in [0, cap / 2, cap - 1] {
        let (mut id, mut xyz) = (0u32, [0f32; 3]);
        assert!(unsafe { lm_map_led(i, &mut id, xyz.as_mut_ptr()) });
        assert_eq!(id, i);
        assert!((xyz[0] - i as f32 * 0.003).abs() < 1e-5, "led {i} x = {}", xyz[0]);
        assert!((xyz[2] - 1.25).abs() < 1e-6);
    }
}

#[test]
fn a_realistic_scan_topology_is_stored_beside_its_map_and_plays() {
    rr::verifies!("PR-21");
    lm_player_init(64);
    let n = 150;
    match upload_sharded(&submit_map_frame("m-scan", n), pb::UploadChunk_::Kind::Map, ARM_SUBMIT_MAP) {
        SMsg::ResultReady(_) => {}
        other => panic!("map stored, got {other:?}"),
    }
    let topo = scan_topology_frame("m-scan", n);
    match upload_sharded(&topo, pb::UploadChunk_::Kind::Topology, ARM_SUBMIT_TOPOLOGY) {
        SMsg::ResultReady(r) => assert_eq!(r.r#map_id.as_str(), "m-scan"),
        other => panic!("the scan's topology fits beside its map, got {other:?}"),
    }
    // The stored topology drives the built-in topology effects...
    let mut params = pb::PlaybackParams::default();
    params.set_speed(0.5);
    let mut sp = pb::SetPlayback::default();
    sp.r#effect = "pulse".parse().unwrap();
    sp.set_params(params);
    assert!(matches!(handle(&encode(CMsg::SetPlayback(sp))), Some(SMsg::PlaybackState(_))));
    assert!(unsafe { lm_playback_step(33) }, "the stored topology is playable");
    // ...and dumps back out complete (every segment with its whole polyline).
    let mut bundle_bytes: Vec<u8> = Vec::new();
    loop {
        let g = pb::GetStoredMap { r#offset: bundle_bytes.len() as i32, r#max_len: 1024 };
        let Some(SMsg::StoredMapChunk(c)) = handle(&encode(CMsg::GetStoredMap(g))) else {
            panic!("stored_map_chunk expected");
        };
        assert!(c.r#has_topology);
        bundle_bytes.extend_from_slice(&c.r#data);
        if c.r#data.is_empty() || bundle_bytes.len() >= c.r#total_len as usize {
            break;
        }
    }
    let mut bundle = Box::new(pb::MappingBundle::default());
    bundle.decode_from_bytes(&bundle_bytes).expect("the dump decodes");
    assert_eq!(bundle.r#map.r#leds.len(), n as usize);
    assert_eq!(bundle.r#topology.r#segments.len(), 12);
    assert!(bundle.r#topology.r#segments.iter().all(|s| s.r#polyline.len() == 20));
    assert_eq!(bundle.r#topology.r#associations.len(), n as usize);
}

/// The editor's "trails" starter: per-LED feedback state in a hidden buffer.
const TRAILS: &str = "buffer float trail;\n\
     vec3 shade(Led led) {\n\
       float v = trail[led.idx] + 0.25;\n\
       trail[led.idx] = v;\n\
       return vec3(v, 0.0, 0.0);\n\
     }\n";

#[test]
fn an_effect_with_per_led_state_renders_every_led_at_the_cap() {
    rr::verifies!("PR-21");
    lm_player_init(64);
    unsafe { lm_fx_clear() };
    let fxb = ledmapper_fx_compiler::compile(TRAILS)
        .unwrap_or_else(|d| panic!("effect compiles: {d:?}"))
        .fxb;
    assert!(unsafe { lm_fx_load(fxb.as_ptr(), fxb.len()) });
    unsafe { lm_fx_set_active(true) };
    let cap = FX_TOPO_CAP as u32;
    // Two frames over the whole strip: each LED's state persists between frames.
    for (frame, expect_r) in [(0u32, 63u8), (1, 127)] {
        assert!(unsafe { lm_fx_update(frame as f32 / 30.0, 1.0 / 30.0, frame, cap) });
        for i in 0..cap {
            let mut rgb = [0u8; 3];
            assert!(unsafe { lm_fx_shade(i, 0.0, 0.0, 0.0, rgb.as_mut_ptr()) }, "led {i} renders");
            assert_eq!(rgb, [expect_r, 0, 0], "led {i} frame {frame}: its own state, intact");
        }
    }
}
