//! Phase 3 acceptance (docs/esp32-led-mapping-plan.md): a chunked map upload
//! decodes into the arena, OOM at capacity+1 is clean (bounded error +
//! rollback, no panic), and persistence round-trips through the SAME decode
//! path (the NVS model: opaque blob keyed by map id, OOM re-checked on
//! reload).
//!
//! Fixtures are built with the GENERATED micropb encoder (the byte-parity
//! conformance suite pins it to canonical protobuf) and, for topology, taken
//! from the cross-language golden frames — the store decodes real phone
//! bytes, not hand-rolled ones.

use base64::Engine;
use ledmapper_arena::Arena;
use ledmapper_pb::ledmapper_::v1_ as pb;
use ledmapper_store::{
    decode_submit_map, decode_submit_topology, envelope_arm, BlobStore, ChunkedReader, StoreError,
    StoredLed, ARM_SUBMIT_MAP, ARM_SUBMIT_TOPOLOGY,
};
use micropb::{MessageEncode, PbEncoder};
use std::collections::HashMap;

// -- fixtures ---------------------------------------------------------------

fn encode_client(msg: pb::ClientMessage_::Msg) -> Vec<u8> {
    let env = pb::ClientMessage { r#msg: Some(msg) };
    let mut enc = PbEncoder::new(micropb::heapless::Vec::<u8, 131072>::new());
    env.encode(&mut enc).expect("fixture encodes");
    enc.into_writer().to_vec()
}

/// A submit_map frame with `n` LEDs (id i at [i, 2i, -i] mm-ish values),
/// including fields the store must SKIP (timestamps, trajectory, stats).
fn submit_map_frame(n: usize) -> Vec<u8> {
    let mut map = Box::new(pb::OutputMap::default());
    map.r#map_id = "m-test".parse().unwrap();
    map.r#created_at = "2026-07-12T00:00:00Z".parse().unwrap();
    map.r#units = "meters".parse().unwrap();
    map.r#frame = "gravity_leveled".parse().unwrap();
    map.r#led_count = n as i32;
    for i in 0..n {
        let mut led = pb::LedEntry::default();
        led.r#id = i as i32;
        led.r#xyz
            .extend_from_slice(&[i as f64 * 0.001, i as f64 * 0.002, -(i as f64) * 0.001])
            .unwrap();
        led.r#confidence = 0.9;
        led.r#n_views = 12;
        map.r#leds.push(led).expect("fixture within generated caps");
    }
    for i in 0..8 {
        let mut p = pb::Vec3::default();
        p.r#v.extend_from_slice(&[i as f64, 0.0, 0.0]).unwrap();
        map.r#trajectory.push(p).unwrap();
    }
    let mut stats = pb::OutputMapStats::default();
    stats.r#rms_reproj_px_global = 0.7;
    map.set_stats(stats);
    let mut submit = pb::SubmitMap::default();
    submit.set_map(*map);
    encode_client(pb::ClientMessage_::Msg::SubmitMap(submit))
}

fn chunks(bytes: &[u8], size: usize) -> Vec<&[u8]> {
    bytes.chunks(size).collect()
}

fn golden_client_frames() -> Vec<Vec<u8>> {
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
        .collect()
}

// -- the acceptance ----------------------------------------------------------

#[test]
fn chunked_map_upload_decodes_into_the_arena() {
    let frame = submit_map_frame(1024);
    assert_eq!(envelope_arm(&frame), Some(ARM_SUBMIT_MAP));

    let mut buf = vec![0u8; 32 * 1024];
    let arena = Arena::new(&mut buf);
    // Odd-sized fragments: varints/doubles straddle chunk boundaries.
    let segs = chunks(&frame, 977);
    let reader = ChunkedReader::new(&segs);
    let map = decode_submit_map(reader, frame.len(), &arena).expect("decodes");

    assert_eq!(map.map_id.as_str(), "m-test");
    assert_eq!(map.led_count, 1024);
    assert_eq!(map.leds.len(), 1024);
    assert_eq!(map.leds[0], StoredLed { id: 0, xyz: [0.0; 3] });
    assert_eq!(map.leds[513].id, 513);
    let xyz = map.leds[513].xyz;
    assert!((xyz[0] - 0.513).abs() < 1e-6 && (xyz[2] + 0.513).abs() < 1e-6);
    // The one exact region + nothing else: 1024 entries, no growth waste.
    assert_eq!(
        arena.used(),
        1024 * core::mem::size_of::<StoredLed>(),
        "leds must land in one exactly-sized region"
    );
}

#[test]
fn oom_at_capacity_plus_one_is_clean_and_rolls_back() {
    // Arena sized for exactly 512 stored LEDs.
    let led_size = core::mem::size_of::<StoredLed>();
    let mut buf = vec![0u8; 512 * led_size];
    let mut arena = Arena::new(&mut buf);

    // Capacity: a 512-LED map fits exactly.
    {
        let frame = submit_map_frame(512);
        let segs = chunks(&frame, 4096);
        let map =
            decode_submit_map(ChunkedReader::new(&segs), frame.len(), &arena).expect("fits");
        assert_eq!(map.leds.len(), 512);
        assert_eq!(arena.used(), arena.capacity());
    }
    arena.reset();

    // Capacity + 1: deterministic ArenaFull the moment the header asks for
    // more than fits — no partial state, no panic.
    let cp = arena.checkpoint();
    {
        let frame = submit_map_frame(513);
        let segs = chunks(&frame, 4096);
        let err = decode_submit_map(ChunkedReader::new(&segs), frame.len(), &arena)
            .expect_err("must not fit");
        assert_eq!(err, StoreError::ArenaFull);
    }
    // Roll back the failed upload; the arena is fully usable again.
    arena.reset_to(cp);
    assert_eq!(arena.used(), 0);
    let frame = submit_map_frame(16);
    let segs = chunks(&frame, 64);
    let map = decode_submit_map(ChunkedReader::new(&segs), frame.len(), &arena)
        .expect("small map decodes after rollback");
    assert_eq!(map.leds.len(), 16);
}

#[test]
fn leds_without_a_preceding_count_are_malformed() {
    // led_count = 0 encodes as ABSENT (proto3 implicit), so a map with LEDs
    // but no count exercises the "header must size the region" contract.
    let mut map = Box::new(pb::OutputMap::default());
    map.r#map_id = "m-bad".parse().unwrap();
    let mut led = pb::LedEntry::default();
    led.r#id = 1;
    map.r#leds.push(led).unwrap();
    let mut submit = pb::SubmitMap::default();
    submit.set_map(*map);
    let frame = encode_client(pb::ClientMessage_::Msg::SubmitMap(submit));

    let mut buf = vec![0u8; 4096];
    let arena = Arena::new(&mut buf);
    let segs = chunks(&frame, 4096);
    let err = decode_submit_map(ChunkedReader::new(&segs), frame.len(), &arena).unwrap_err();
    assert!(matches!(err, StoreError::Malformed(_)), "got {err:?}");
}

#[test]
fn golden_topology_frame_decodes_into_the_arena() {
    let frame = golden_client_frames()
        .into_iter()
        .find(|f| envelope_arm(f) == Some(ARM_SUBMIT_TOPOLOGY))
        .expect("golden has a submit_topology frame");

    let mut buf = vec![0u8; 8192];
    let arena = Arena::new(&mut buf);
    let segs = chunks(&frame, 7);
    let topo = decode_submit_topology(ChunkedReader::new(&segs), frame.len(), &arena)
        .expect("golden decodes");

    // Values from pi/server/server/proto_examples.py TOPOLOGY.
    assert_eq!(topo.map_id.as_str(), "m-1");
    assert_eq!(topo.branch_points.len(), 1);
    assert_eq!(topo.branch_points[0].id, 0);
    assert!((topo.branch_points[0].xyz[1] - 0.1).abs() < 1e-6);
    assert_eq!(topo.segments.len(), 1);
    let seg = &topo.segments[0];
    assert_eq!((seg.a, seg.b), (0, -1));
    assert_eq!(seg.length, 1.0);
    assert_eq!(seg.polyline.len(), 3);
    assert!((seg.polyline[2][0] - 0.5).abs() < 1e-6);
    assert!((seg.polyline[2][1] - 0.6).abs() < 1e-6);
    assert_eq!(topo.associations.len(), 1);
    assert!((topo.associations[0].foot_arclength - 0.25).abs() < 1e-6);
    assert!((topo.associations[0].d_perp - 0.003).abs() < 1e-6);
}

// -- persistence (the NVS model) ---------------------------------------------

struct InMemoryBlobStore(HashMap<String, Vec<u8>>);

impl BlobStore for InMemoryBlobStore {
    type Error = core::convert::Infallible;

    fn save(&mut self, key: &str, blob: &[u8]) -> Result<(), Self::Error> {
        self.0.insert(key.to_string(), blob.to_vec());
        Ok(())
    }

    fn with_blob<T>(&self, key: &str, f: impl FnOnce(&[u8]) -> T) -> Result<Option<T>, Self::Error> {
        Ok(self.0.get(key).map(|b| f(b)))
    }
}

#[test]
fn persisted_blob_reloads_through_the_same_decode_path() {
    let frame = submit_map_frame(64);
    let mut buf = vec![0u8; 8192];
    let arena = Arena::new(&mut buf);
    let segs = chunks(&frame, 128);
    let map = decode_submit_map(ChunkedReader::new(&segs), frame.len(), &arena).unwrap();

    // Persist the UPLOAD BYTES opaquely, keyed by the decoded map id.
    let mut nvs = InMemoryBlobStore(HashMap::new());
    nvs.save(map.map_id.as_str(), &frame).unwrap();
    let first: Vec<StoredLed> = map.leds.to_vec();
    drop(map);

    // "Reboot": fresh arena, reload via the SAME decoder.
    let mut buf2 = vec![0u8; 8192];
    let arena2 = Arena::new(&mut buf2);
    let reloaded = nvs
        .with_blob("m-test", |blob| {
            let segs: Vec<&[u8]> = blob.chunks(96).collect();
            decode_submit_map(ChunkedReader::new(&segs), blob.len(), &arena2)
                .map(|m| (m.led_count, m.leds.to_vec()))
        })
        .unwrap()
        .expect("blob exists")
        .expect("reload decodes");
    assert_eq!(reloaded.0, 64);
    assert_eq!(reloaded.1, first);

    // The reload re-runs the OOM check: a shrunken arena refuses cleanly.
    let mut tiny = vec![0u8; 64];
    let tiny_arena = Arena::new(&mut tiny);
    let err = nvs
        .with_blob("m-test", |blob| {
            let segs: Vec<&[u8]> = blob.chunks(96).collect();
            decode_submit_map(ChunkedReader::new(&segs), blob.len(), &tiny_arena).err()
        })
        .unwrap()
        .flatten()
        .expect("must refuse");
    assert_eq!(err, StoreError::ArenaFull);
}

#[test]
fn envelope_arm_routes_the_golden_frames() {
    // Wrong-arm frames are refused by the upload decoders, and the peek
    // helper routes every golden frame somewhere sensible.
    let mut saw_map = false;
    for frame in golden_client_frames() {
        let arm = envelope_arm(&frame).expect("every golden frame has an arm");
        if arm == ARM_SUBMIT_MAP {
            saw_map = true;
        } else {
            let mut buf = vec![0u8; 1024];
            let arena = Arena::new(&mut buf);
            let segs = [&frame[..]];
            let err = decode_submit_map(ChunkedReader::new(&segs), frame.len(), &arena)
                .expect_err("non-upload arms must be refused");
            assert!(matches!(err, StoreError::Malformed(_)));
        }
    }
    assert!(saw_map);
}

// -- MappingBundle dump (re-encode stored map+topology) ---------------------

#[test]
fn dump_reencodes_a_bundle_the_generated_decoder_accepts() {
    use ledmapper_store::{
        dump, StoredAssociation, StoredBranchPoint, StoredMap, StoredSegment, StoredTopology, Str64,
    };
    use micropb::{MessageDecode, PbDecoder};

    let mut map_id = Str64::new();
    map_id.push_str("dump-1").unwrap();

    let leds = [
        StoredLed { id: 0, xyz: [0.0, 0.0, 0.0] },
        StoredLed { id: 1, xyz: [0.05, 0.0, 0.0] },
        StoredLed { id: 2, xyz: [0.1, 0.02, -0.01] },
    ];
    let map = StoredMap { map_id: map_id.clone(), led_count: 3, leds: &leds };

    let bps = [StoredBranchPoint { id: 0, xyz: [0.05, 0.0, 0.0] }];
    let poly0: [[f32; 3]; 2] = [[0.0, 0.0, 0.0], [0.05, 0.0, 0.0]];
    let poly1: [[f32; 3]; 2] = [[0.05, 0.0, 0.0], [0.1, 0.02, -0.01]];
    let segs = [
        StoredSegment { id: 0, a: -1, b: 0, length: 0.05, polyline: &poly0 },
        StoredSegment { id: 1, a: 0, b: -1, length: 0.0559, polyline: &poly1 },
    ];
    let assoc = [
        StoredAssociation { led_id: 0, segment_id: 0, foot_arclength: 0.0, d_perp: 0.0 },
        StoredAssociation { led_id: 1, segment_id: 0, foot_arclength: 0.05, d_perp: 0.0 },
        StoredAssociation { led_id: 2, segment_id: 1, foot_arclength: 0.0559, d_perp: 0.01 },
    ];
    let topo =
        StoredTopology { map_id, branch_points: &bps, segments: &segs, associations: &assoc };

    let total = dump::bundle_len(&map, Some(&topo));
    let mut full = vec![0u8; total];
    assert_eq!(dump::encode_bundle_window(&map, Some(&topo), 0, &mut full), total);

    // Windowing: 5-byte slices concatenate to exactly the full encode.
    let mut streamed = Vec::new();
    let mut off = 0;
    while off < total {
        let mut buf = [0u8; 5];
        let got = dump::encode_bundle_window(&map, Some(&topo), off, &mut buf);
        assert!(got > 0 && got <= 5);
        streamed.extend_from_slice(&buf[..got]);
        off += got;
    }
    assert_eq!(streamed, full, "windowed encode == full encode");

    // The generated (host) decoder round-trips every field.
    let mut bundle = pb::MappingBundle::default();
    let mut dec = PbDecoder::new(full.as_slice());
    bundle.decode(&mut dec, full.len()).expect("bundle decodes");
    assert_eq!(bundle.r#map.r#map_id.as_str(), "dump-1");
    assert_eq!(bundle.r#map.r#led_count, 3);
    assert_eq!(bundle.r#map.r#leds.len(), 3);
    assert_eq!(bundle.r#map.r#leds[2].r#id, 2);
    assert_eq!(bundle.r#map.r#leds[2].r#xyz[0], 0.1_f32 as f64);
    assert_eq!(bundle.r#topology.r#segments.len(), 2);
    assert_eq!(bundle.r#topology.r#segments[0].r#a, -1);
    assert_eq!(bundle.r#topology.r#segments[1].r#a, 0);
    assert_eq!(bundle.r#topology.r#segments[1].r#polyline.len(), 2);
    assert_eq!(bundle.r#topology.r#associations.len(), 3);
    assert_eq!(bundle.r#topology.r#associations[2].r#segment_id, 1);
    assert_eq!(bundle.r#topology.r#associations[2].r#d_perp, 0.01_f32 as f64);
    assert_eq!(bundle.r#topology.r#branch_points.len(), 1);
}
