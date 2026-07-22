//! Host test of the C ABI the Arduino app calls — the same routing the
//! device runs, driven end-to-end through the extern "C" surface (compiled
//! here against the HOST capacity profile; the profiles differ only in
//! repeated-field capacities).
//!
//! ONE #[test] on purpose: the FFI state is process-global and
//! single-threaded (as on the device); the rust test harness is not.

use ledmapper_pb::ledmapper_::v1_ as pb;
use ledmapper_player_ffi::{
    lm_counting_color, lm_envelope_arm, lm_led_count, lm_map_led, lm_map_len, lm_pattern_color,
    lm_pattern_timing, lm_perf_build_report, lm_perf_interval_ms, lm_perf_mode, lm_perf_push,
    lm_player_handle, lm_player_init,
};
use micropb::{MessageDecode, MessageEncode, PbEncoder};
use pb::ClientMessage_::Msg as CMsg;
use pb::ServerMessage_::Msg as SMsg;

fn encode(msg: CMsg) -> Vec<u8> {
    let env = pb::ClientMessage { r#msg: Some(msg) };
    let mut enc = PbEncoder::new(micropb::heapless::Vec::<u8, 131072>::new());
    env.encode(&mut enc).unwrap();
    enc.into_writer().to_vec()
}

// `now` stays f64 at the call sites; the FFI clock is integer ms.
fn handle(frame: &[u8], now: f64) -> Option<SMsg> {
    let mut out = vec![0u8; 4096];
    let n = unsafe {
        lm_player_handle(
            frame.as_ptr(),
            frame.len(),
            now as i64,
            now as i64,
            out.as_mut_ptr(),
            out.len(),
        )
    };
    assert!(n >= 0, "handle returned {n}");
    if n == 0 {
        return None;
    }
    let mut reply = pb::ServerMessage::default();
    reply.decode_from_bytes(&out[..n as usize]).expect("reply decodes");
    Some(reply.r#msg.expect("reply has an arm"))
}

#[test]
fn full_device_flow_through_the_c_abi() {
    lm_player_init(64);

    // hello -> welcome without a solver bench score.
    let Some(SMsg::Welcome(w)) = handle(&encode(CMsg::Hello(pb::Hello::default())), 1.0) else {
        panic!("welcome expected");
    };
    assert!(!w._has.r#solver_bench_ms());
    assert_eq!(w.r#code_params.r#led_count, 64);

    // start_mapping 16 LEDs -> pattern timing + frame colors line up.
    let mut opts = pb::StartMappingOptions::default();
    opts.r#led_count = 16;
    let mut start = pb::StartMapping::default();
    start.set_options(opts);
    let Some(SMsg::MappingStarted(started)) =
        handle(&encode(CMsg::StartMapping(start)), 1000.0)
    else {
        panic!("mapping_started expected");
    };
    let (mut epoch, mut period_us, mut frames, mut leds) = (0i64, 0u32, 0u32, 0u32);
    assert!(unsafe { lm_pattern_timing(&mut epoch, &mut period_us, &mut frames, &mut leds) });
    assert_eq!(epoch, 1000);
    // Integer µs period == the wire's ms period * 1000 (default 100 ms).
    assert_eq!(period_us, started.r#code_params.r#bit_period_ms as u32 * 1000);
    assert_eq!(frames as i32, started.r#code_params.r#cycle_frames);
    assert_eq!(leds, 16);
    let mut rgb = [0u8; 3];
    assert!(unsafe { lm_pattern_color(0, 0, rgb.as_mut_ptr()) });
    assert_eq!(rgb, [255, 255, 255], "frame 0 is the white ALL_ON reference");
    assert!(unsafe { lm_pattern_color(0, 1, rgb.as_mut_ptr()) });
    assert_eq!(rgb, [0, 255, 0], "frame 1 is the green ALL_OFF sync");

    // Fire-and-forget telemetry produces no reply.
    assert!(handle(&encode(CMsg::Detections(pb::Detections::default())), 1100.0).is_none());

    // Counting pattern latches; the render hook paints the block.
    let mut counting = pb::SetCountingPattern::default();
    let mut block = pb::ColorBlock::default();
    block.r#start = 0;
    block.r#count = 8;
    block.r#rgb.extend_from_slice(&[1.0, 0.0, 0.0]).unwrap();
    counting.r#blocks.push(block).unwrap();
    let Some(SMsg::CountingState(cs)) =
        handle(&encode(CMsg::SetCountingPattern(counting)), 2000.0)
    else {
        panic!("counting_state expected");
    };
    assert!(cs.r#active);
    assert!(unsafe { lm_counting_color(3, rgb.as_mut_ptr()) });
    assert_eq!(rgb, [255, 0, 0]);
    assert!(unsafe { lm_counting_color(9, rgb.as_mut_ptr()) });
    assert_eq!(rgb, [0, 0, 0], "past the block is off (the probe region)");

    // set_led_count persists per channel.
    let mut slc = pb::SetLedCount::default();
    slc.r#led_count = 300;
    let Some(SMsg::LedCountState(_)) = handle(&encode(CMsg::SetLedCount(slc)), 2500.0) else {
        panic!("led_count_state expected");
    };
    assert_eq!(unsafe { lm_led_count(0) }, 300);
    assert_eq!(unsafe { lm_led_count(1) }, -1);

    // Map upload takes the ARENA path (never the generated envelope):
    // result_ready + the stored entries readable through the map accessors.
    let mut map = Box::new(pb::OutputMap::default());
    map.r#map_id = "m-ffi".parse().unwrap();
    map.r#led_count = 64;
    for i in 0..64 {
        let mut led = pb::LedEntry::default();
        led.r#id = i;
        led.r#xyz
            .extend_from_slice(&[i as f64 * 0.01, 0.0, -0.5])
            .unwrap();
        map.r#leds.push(led).unwrap();
    }
    let mut submit = pb::SubmitMap::default();
    submit.set_map(*map);
    // The envelope-arm classifier (drives LittleFS persistence): a submit_map
    // request is arm 13; its result_ready reply is arm 8.
    let map_frame = encode(CMsg::SubmitMap(submit));
    assert_eq!(unsafe { lm_envelope_arm(map_frame.as_ptr(), map_frame.len()) }, 13);
    assert_eq!(unsafe { lm_envelope_arm(core::ptr::null(), 0) }, -1);
    let Some(SMsg::ResultReady(r)) = handle(&map_frame, 3000.0) else {
        panic!("result_ready expected");
    };
    let rr = {
        let mut enc = PbEncoder::new(micropb::heapless::Vec::<u8, 128>::new());
        pb::ServerMessage { r#msg: Some(SMsg::ResultReady(pb::ResultReady::default())) }
            .encode(&mut enc)
            .unwrap();
        enc.into_writer().to_vec()
    };
    assert_eq!(unsafe { lm_envelope_arm(rr.as_ptr(), rr.len()) }, 8);
    assert_eq!(r.r#map_id.as_str(), "m-ffi");
    assert_eq!(unsafe { lm_map_len() }, 64);
    let (mut id, mut xyz) = (0u32, [0f32; 3]);
    assert!(unsafe { lm_map_led(63, &mut id, xyz.as_mut_ptr()) });
    assert_eq!(id, 63);
    assert!((xyz[0] - 0.63).abs() < 1e-6);
    assert!(!unsafe { lm_map_led(64, &mut id, xyz.as_mut_ptr()) });

    // Topology for the stored map: result_ready through the arena path.
    let mut topo = pb::SubmitTopology::default();
    let mut t = pb::Topology::default();
    t.r#map_id = "m-ffi".parse().unwrap();
    topo.set_topology(t);
    let Some(SMsg::ResultReady(_)) = handle(&encode(CMsg::SubmitTopology(topo)), 3500.0) else {
        panic!("topology result_ready expected");
    };

    // Dump the stored map+topology back out (get_stored_map), streamed in small
    // windows; reassemble and decode as a MappingBundle.
    let mut assembled: Vec<u8> = Vec::new();
    let mut total = 0usize;
    loop {
        let mut g = pb::GetStoredMap::default();
        g.r#offset = assembled.len() as i32;
        g.r#max_len = 40; // small chunk to exercise the windowed encoder
        let Some(SMsg::StoredMapChunk(c)) = handle(&encode(CMsg::GetStoredMap(g)), 3600.0) else {
            panic!("stored_map_chunk expected");
        };
        assert_eq!(c.r#offset as usize, assembled.len());
        assert!(c.r#has_topology);
        total = c.r#total_len as usize;
        if c.r#data.is_empty() {
            break;
        }
        assembled.extend_from_slice(&c.r#data);
        if assembled.len() >= total {
            break;
        }
    }
    assert_eq!(assembled.len(), total, "assembled the whole bundle");
    let mut bundle = pb::MappingBundle::default();
    bundle.decode_from_bytes(&assembled).expect("dumped bundle decodes");
    assert_eq!(bundle.r#map.r#map_id.as_str(), "m-ffi");
    assert_eq!(bundle.r#map.r#leds.len(), 64);
    assert_eq!(bundle.r#map.r#leds[63].r#id, 63);

    // A malformed upload (leds without a led_count header) gets a bounded
    // error, and the previously stored map is GONE (the upload reset the
    // arena) — the phone re-uploads.
    let mut bad = Box::new(pb::OutputMap::default());
    bad.r#map_id = "m-bad".parse().unwrap();
    let mut led = pb::LedEntry::default();
    led.r#id = 1;
    bad.r#leds.push(led).unwrap();
    let mut submit = pb::SubmitMap::default();
    submit.set_map(*bad);
    let Some(SMsg::Error(e)) = handle(&encode(CMsg::SubmitMap(submit)), 4000.0) else {
        panic!("error expected");
    };
    assert_eq!(e.r#code.as_str(), "bad_message");
    assert_eq!(unsafe { lm_map_len() }, 0);

    // stop with solveOnHost=false ends the pattern.
    let mut stop = pb::StopMapping::default();
    stop.set_solve_on_host(false);
    let Some(SMsg::MappingStopped(_)) = handle(&encode(CMsg::StopMapping(stop)), 5000.0) else {
        panic!("mapping_stopped expected");
    };
    assert!(!unsafe { lm_pattern_timing(&mut epoch, &mut period_us, &mut frames, &mut leds) });

    // -- perf monitoring: set_perf toggles the tier + interval, lm_perf_push
    // fills the ring, and get_perf_report rolls up the window (min/mean/max)
    // and drains the tail. Exercises the rollup off-device (the crux logic).
    let mut sp = pb::SetPerf::default();
    sp.r#mode = pb::SetPerf_::Mode::Full;
    sp.r#interval_ms = 250;
    // set_perf replies with an immediate (empty-window) PerfReport.
    let Some(SMsg::PerfReport(rep0)) = handle(&encode(CMsg::SetPerf(sp)), 6000.0) else {
        panic!("perf_report expected from set_perf");
    };
    assert_eq!(rep0.r#cpu_hz, 160_000_000);
    assert_eq!(rep0.r#budget_cycles, (160_000_000 / 1000) * 33);
    assert_eq!(rep0.r#ticks.len(), 0, "ring empty right after set_perf");
    assert_eq!(unsafe { lm_perf_mode() }, 2, "FULL latched");
    assert_eq!(unsafe { lm_perf_interval_ms() }, 250);

    // Push three frames with known frame_cycles {100, 300, 200} → min 100,
    // max 300, mean 200; one marked overran.
    unsafe {
        lm_perf_push(0, 40, 60, 100, 500, 64, false);
        lm_perf_push(1, 90, 210, 300, 500, 64, true); // overran
        lm_perf_push(2, 80, 120, 200, 500, 64, false);
    }
    let Some(SMsg::PerfReport(rep)) = handle(&encode(CMsg::GetPerfReport(Default::default())), 6300.0)
    else {
        panic!("perf_report expected from get_perf_report");
    };
    assert_eq!(rep.r#frame_cycles_min, 100);
    assert_eq!(rep.r#frame_cycles_max, 300);
    assert_eq!(rep.r#frame_cycles_mean, 200);
    assert_eq!(rep.r#show_cycles_mean, 500);
    assert_eq!(rep.r#overruns, 1, "one frame over budget");
    // Host profile caps ticks generously; all three drained here.
    assert_eq!(rep.r#ticks.len(), 3);
    assert_eq!(rep.r#ticks[1].r#frame_cycles, 300);
    assert_eq!(rep.r#ticks[1].r#seq, 1);

    // A second poll sees the counters reset and the ring drained.
    let Some(SMsg::PerfReport(rep2)) =
        handle(&encode(CMsg::GetPerfReport(Default::default())), 6400.0)
    else {
        panic!("perf_report expected");
    };
    assert_eq!(rep2.r#overruns, 0, "counters reset on drain");
    assert_eq!(rep2.r#ticks.len(), 0, "ring drained");

    // The unsolicited builder produces the same PerfReport frame shape.
    let mut buf = vec![0u8; 2048];
    let n = unsafe { lm_perf_build_report(buf.as_mut_ptr(), buf.len()) };
    assert!(n > 0, "unsolicited report encodes ({n})");
    let mut rep3 = pb::ServerMessage::default();
    rep3.decode_from_bytes(&buf[..n as usize]).expect("decodes");
    assert!(matches!(rep3.r#msg, Some(SMsg::PerfReport(_))));

    // OFF stops the stream; the builder then returns 0 (nothing to push).
    let mut off = pb::SetPerf::default();
    off.r#mode = pb::SetPerf_::Mode::Off;
    let _ = handle(&encode(CMsg::SetPerf(off)), 6500.0);
    assert_eq!(unsafe { lm_perf_mode() }, 0);
    let n_off = unsafe { lm_perf_build_report(buf.as_mut_ptr(), buf.len()) };
    assert_eq!(n_off, 0, "OFF: unsolicited builder emits nothing");
}
