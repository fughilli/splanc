//! The full arena-upload flow the firmware transport runs (Phase 3): peek
//! the envelope arm, decode the upload into the arena (ledmapper_store),
//! and produce the protocol reply through the player — including the
//! bounded map_too_large path with arena rollback.

use base64::Engine;
use ledmapper_arena::Arena;
use ledmapper_pb::ledmapper_::v1_ as pb;
use ledmapper_player::{upload_too_large, Player};
use ledmapper_store::{
    decode_submit_map, decode_submit_topology, envelope_arm, ChunkedReader, StoreError,
    ARM_SUBMIT_MAP, ARM_SUBMIT_TOPOLOGY,
};
use micropb::{MessageEncode, PbEncoder};
use pb::ServerMessage_::Msg as SMsg;

fn submit_map_frame(map_id: &str, n: usize) -> Vec<u8> {
    let mut map = Box::new(pb::OutputMap::default());
    map.r#map_id = map_id.parse().unwrap();
    map.r#led_count = n as i32;
    for i in 0..n {
        let mut led = pb::LedEntry::default();
        led.r#id = i as i32;
        led.r#xyz.extend_from_slice(&[0.0, 0.0, 0.0]).unwrap();
        map.r#leds.push(led).unwrap();
    }
    let mut submit = pb::SubmitMap::default();
    submit.set_map(*map);
    let env = pb::ClientMessage {
        r#msg: Some(pb::ClientMessage_::Msg::SubmitMap(submit)),
    };
    let mut enc = PbEncoder::new(micropb::heapless::Vec::<u8, 131072>::new());
    env.encode(&mut enc).unwrap();
    enc.into_writer().to_vec()
}

fn golden_topology_frame() -> Vec<u8> {
    let path = std::env::var("GOLDEN_PROTO_FRAMES").unwrap();
    let json: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let b64 = base64::engine::general_purpose::STANDARD;
    json["frames"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|f| f["direction"] == "client")
        .map(|f| b64.decode(f["frameB64"].as_str().unwrap()).unwrap())
        .find(|f| envelope_arm(f) == Some(ARM_SUBMIT_TOPOLOGY))
        .expect("golden has a submit_topology frame")
}

#[test]
fn transport_routes_uploads_through_the_arena_to_protocol_replies() {
    let mut player = Player::new("esp32-arena", 1024);
    let mut buf = vec![0u8; 8192];
    let mut arena = Arena::new(&mut buf);

    // Topology for a map the player does not have: unknown_map.
    let topo_frame = golden_topology_frame();
    {
        let segs = [&topo_frame[..]];
        let topo =
            decode_submit_topology(ChunkedReader::new(&segs), topo_frame.len(), &arena).unwrap();
        let map_id: String = topo.map_id.as_str().into();
        drop(topo);
        let reply = player.topology_stored(&map_id);
        assert!(
            matches!(reply.r#msg, Some(SMsg::Error(ref e)) if e.r#code.as_str() == "unknown_map"),
            "{reply:?}"
        );
    }
    arena.reset();

    // Map upload (the golden topology references map m-1) -> result_ready.
    let map_frame = submit_map_frame("m-1", 64);
    assert_eq!(envelope_arm(&map_frame), Some(ARM_SUBMIT_MAP));
    {
        let segs: Vec<&[u8]> = map_frame.chunks(100).collect();
        let map = decode_submit_map(ChunkedReader::new(&segs), map_frame.len(), &arena).unwrap();
        assert_eq!(map.leds.len(), 64);
        let map_id: String = map.map_id.as_str().into();
        drop(map);
        let reply = player.map_stored(&map_id);
        assert!(
            matches!(reply.r#msg, Some(SMsg::ResultReady(ref r)) if r.r#map_id.as_str() == "m-1")
        );
    }

    // Now the topology lands: result_ready for the same id.
    {
        let cp = arena.checkpoint();
        let segs = [&topo_frame[..]];
        let topo =
            decode_submit_topology(ChunkedReader::new(&segs), topo_frame.len(), &arena).unwrap();
        let map_id: String = topo.map_id.as_str().into();
        drop(topo);
        let _ = cp;
        let reply = player.topology_stored(&map_id);
        assert!(
            matches!(reply.r#msg, Some(SMsg::ResultReady(ref r)) if r.r#map_id.as_str() == "m-1")
        );
    }
}

#[test]
fn oversized_upload_gets_a_bounded_error_and_the_arena_rolls_back() {
    let mut buf = vec![0u8; 256]; // far too small for 64 LEDs
    let mut arena = Arena::new(&mut buf);
    let frame = submit_map_frame("m-big", 64);

    let cp = arena.checkpoint();
    let err = {
        let segs: Vec<&[u8]> = frame.chunks(100).collect();
        decode_submit_map(ChunkedReader::new(&segs), frame.len(), &arena).unwrap_err()
    };
    assert_eq!(err, StoreError::ArenaFull);
    arena.reset_to(cp);
    assert_eq!(arena.used(), 0);

    // The reply is bounded protocol traffic, and it encodes.
    let reply = upload_too_large();
    assert!(
        matches!(reply.r#msg, Some(SMsg::Error(ref e)) if e.r#code.as_str() == "map_too_large")
    );
    let mut enc = PbEncoder::new(micropb::heapless::Vec::<u8, 256>::new());
    reply.encode(&mut enc).expect("bounded reply encodes");
}
