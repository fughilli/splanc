//! Regression: a map with unmapped LEDs (the normal case for a real scan) must
//! land each position on its LED id, not on its position in the uploaded list.
//!
//! The upload omits unmapped LEDs, so keying the render cache by list position
//! shifted every LED after the first gap onto the wrong strip slot (and left the
//! tail at the origin) — the map rendered twisted. This locks: positions keyed by
//! id, unmapped LEDs interpolated from their mapped neighbours (clamped at the
//! ends), nothing surviving from a previous map, and get_stored_map handing back
//! the real ids + the unmapped list.
//!
//! Own test binary (fresh process-global FFI state), like counting_preempt.rs.

use ledmapper_pb::ledmapper_::v1_ as pb;
use ledmapper_player_ffi::{lm_map_led, lm_map_len, lm_player_handle, lm_player_init};
use micropb::{MessageDecode, MessageEncode, PbEncoder};
use pb::ClientMessage_::Msg as CMsg;
use pb::ServerMessage_::Msg as SMsg;

fn encode(msg: CMsg) -> Vec<u8> {
    let env = pb::ClientMessage { r#msg: Some(msg) };
    let mut enc = PbEncoder::new(micropb::heapless::Vec::<u8, 131072>::new());
    env.encode(&mut enc).unwrap();
    enc.into_writer().to_vec()
}

fn handle(frame: &[u8], now: f64) -> Option<SMsg> {
    let mut out = vec![0u8; 4096];
    let n = unsafe {
        lm_player_handle(frame.as_ptr(), frame.len(), now as i64, now as i64, out.as_mut_ptr(),
                         out.len())
    };
    assert!(n >= 0, "handle returned {n}");
    if n == 0 {
        return None;
    }
    let mut reply = pb::ServerMessage::default();
    reply.decode_from_bytes(&out[..n as usize]).expect("reply decodes");
    Some(reply.r#msg.expect("reply has an arm"))
}

/// A recognizable per-id position, so a slot holding the wrong LED shows up.
fn xyz_of(id: u32) -> [f32; 3] {
    [id as f32 * 0.1, 1.0 + id as f32 * 0.01, -0.5]
}

fn upload(map_id: &str, led_count: u32, unmapped: &[u32], now: f64) {
    let mut map = Box::new(pb::OutputMap::default());
    map.r#map_id = map_id.parse().unwrap();
    map.r#led_count = led_count as i32;
    for id in (0..led_count).filter(|i| !unmapped.contains(i)) {
        let mut led = pb::LedEntry {
            r#id: id as i32,
            ..Default::default()
        };
        let p = xyz_of(id);
        led.r#xyz.extend_from_slice(&[p[0] as f64, p[1] as f64, p[2] as f64]).unwrap();
        map.r#leds.push(led).unwrap();
    }
    for &id in unmapped {
        map.r#unmapped.push(id as i32).unwrap();
    }
    let mut submit = pb::SubmitMap::default();
    submit.set_map(*map);
    let Some(SMsg::ResultReady(r)) = handle(&encode(CMsg::SubmitMap(submit)), now) else {
        panic!("result_ready expected");
    };
    assert_eq!(r.r#map_id.as_str(), map_id);
    assert_eq!(unsafe { lm_map_len() }, led_count);
}

fn led(i: u32) -> (u32, [f32; 3]) {
    let (mut id, mut xyz) = (u32::MAX, [f32::NAN; 3]);
    assert!(unsafe { lm_map_led(i, &mut id, xyz.as_mut_ptr()) }, "LED {i} readable");
    (id, xyz)
}

fn assert_close(got: [f32; 3], want: [f32; 3], what: &str) {
    for k in 0..3 {
        assert!((got[k] - want[k]).abs() < 1e-5, "{what}: got {got:?}, want {want:?}");
    }
}

fn dump() -> pb::OutputMap {
    let mut assembled: Vec<u8> = Vec::new();
    loop {
        let g = pb::GetStoredMap {
            r#offset: assembled.len() as i32,
            r#max_len: 64,
        };
        let Some(SMsg::StoredMapChunk(c)) = handle(&encode(CMsg::GetStoredMap(g)), 9000.0) else {
            panic!("stored_map_chunk expected");
        };
        let total = c.r#total_len as usize;
        assembled.extend_from_slice(&c.r#data);
        if c.r#data.is_empty() || assembled.len() >= total {
            assert_eq!(assembled.len(), total, "assembled the whole bundle");
            break;
        }
    }
    let mut bundle = pb::MappingBundle::default();
    bundle.decode_from_bytes(&assembled).expect("dumped bundle decodes");
    bundle.r#map
}

#[test]
fn sparse_map_positions_are_keyed_by_led_id() {
    lm_player_init(64);

    // 20 LEDs: unmapped at the start (0,1), a run in the middle (5..=7) and the
    // end (19) — the shape of a real partial scan.
    let unmapped = [0u32, 1, 5, 6, 7, 19];
    upload("m-sparse", 20, &unmapped, 1000.0);

    // Every mapped LED reads back its OWN uploaded position.
    for i in (0..20).filter(|i| !unmapped.contains(i)) {
        let (id, xyz) = led(i);
        assert_eq!(id, i);
        assert_close(xyz, xyz_of(i), &format!("mapped LED {i}"));
    }
    // A gap interpolates by index between its mapped neighbours (4 and 8).
    for i in 5..=7u32 {
        let t = (i - 4) as f32 / 4.0;
        let (a, b) = (xyz_of(4), xyz_of(8));
        let want = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
        assert_close(led(i).1, want, &format!("interpolated LED {i}"));
    }
    // Unmapped runs at either end clamp to the nearest mapped LED.
    assert_close(led(0).1, xyz_of(2), "leading unmapped LED 0");
    assert_close(led(1).1, xyz_of(2), "leading unmapped LED 1");
    assert_close(led(19).1, xyz_of(18), "trailing unmapped LED 19");

    // Pulling the map back off the device keeps the real ids + unmapped list
    // (interpolated positions are a render detail, not map data).
    let m = dump();
    assert_eq!(m.r#led_count, 20);
    let ids: Vec<i32> = m.r#leds.iter().map(|l| l.r#id).collect();
    let want_ids: Vec<i32> = (0..20).filter(|i| !unmapped.contains(i)).map(|i| i as i32).collect();
    assert_eq!(ids, want_ids, "dump emits the mapped LEDs under their real ids");
    for l in m.r#leds.iter() {
        let p = xyz_of(l.r#id as u32);
        for k in 0..3 {
            assert!((l.r#xyz[k] - p[k] as f64).abs() < 1e-5, "dumped xyz of LED {}", l.r#id);
        }
    }
    let got_unmapped: Vec<i32> = m.r#unmapped.iter().copied().collect();
    let want_unmapped: Vec<i32> = unmapped.iter().map(|&i| i as i32).collect();
    assert_eq!(got_unmapped, want_unmapped, "dump carries the unmapped list");

    // A new map replaces the old one wholesale: LED 3 is unmapped now and must
    // interpolate between 2 and 4 of THIS map, not keep the old map's position.
    upload("m-next", 10, &[3], 2000.0);
    let (a, b) = (xyz_of(2), xyz_of(4));
    assert_close(
        led(3).1,
        [(a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0, (a[2] + b[2]) / 2.0],
        "LED 3 after re-upload",
    );
    let m = dump();
    let got_unmapped: Vec<i32> = m.r#unmapped.iter().copied().collect();
    assert_eq!(got_unmapped, vec![3]);
    assert_eq!(m.r#leds.len(), 9);

    // A dense map dumps with no unmapped list.
    upload("m-dense", 8, &[], 3000.0);
    let m = dump();
    assert_eq!(m.r#leds.len(), 8);
    assert!(m.r#unmapped.is_empty());
}
