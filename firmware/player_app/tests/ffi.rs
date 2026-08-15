//! Host test of the C ABI the Arduino app calls — the same routing the
//! device runs, driven end-to-end through the extern "C" surface (compiled
//! here against the HOST capacity profile; the profiles differ only in
//! repeated-field capacities).
//!
//! ONE #[test] on purpose: the FFI state is process-global and
//! single-threaded (as on the device); the rust test harness is not.

use ledmapper_pb::ledmapper_::v1_ as pb;
use ledmapper_player_ffi::{
    lm_color_correction_commit, lm_color_correction_gen, lm_color_correction_params,
    lm_counting_color, lm_envelope_arm,
    lm_fx_load, lm_fx_set_active, lm_fx_shade, lm_fx_update, lm_led_count, lm_map_led, lm_map_len,
    lm_osc_ingest, lm_osc_set_by_name, lm_pattern_color, lm_pattern_timing, lm_perf_build_report,
    lm_perf_interval_ms, lm_perf_mode,
    lm_perf_push, lm_player_handle, lm_player_init,
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
    // Set from the first chunk's total_len (every iteration assigns it before
    // any break), then used after the loop.
    let mut total: usize;
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

    // -- effects: per-LED topology (led.seg / led.s / led.branch) end-to-end ---
    // Replace the (empty) topology with a real Y-junction: three segments meeting
    // at branch point 0 (degree 3 -> a junction), so a shader can read a mapped
    // LED's segment index, normalized arclength and junction flag. A shade() that
    // returns vec3(led.s, led.seg*0.1, led.branch) surfaces those terms straight
    // into the RGB the render loop would drive.
    {
        let mut topo = pb::Topology::default();
        topo.r#map_id = "m-ffi".parse().unwrap();
        for id in 0..4 {
            let mut bp = pb::BranchPoint::default();
            bp.r#id = id;
            bp.r#xyz.extend_from_slice(&[0.0, 0.0, 0.0]).unwrap();
            topo.r#branch_points.push(bp).unwrap();
        }
        // seg ids 10/11/12 -> indices 0/1/2, all rooted at junction bp 0.
        for (sid, endb) in [(10, 1), (11, 2), (12, 3)] {
            let mut s = pb::TopologySegment::default();
            s.r#id = sid;
            s.r#a = 0; // junction endpoint (degree 3)
            s.r#b = endb; // terminal (degree 1)
            s.r#length = 1.0;
            topo.r#segments.push(s).unwrap();
        }
        // LED 0 near the junction (branch=true, s≈0.02, seg idx 0); LED 1 mid
        // seg 10 (branch=false, s=0.5, seg idx 0); LED 2 near the terminal end of
        // seg 11 (branch=false, s≈0.99, seg idx 1).
        let assoc = |led_id, segment_id, foot: f64| {
            let mut a = pb::LedAssociation::default();
            a.r#led_id = led_id;
            a.r#segment_id = segment_id;
            a.r#foot_arclength = foot;
            a
        };
        topo.r#associations.push(assoc(0, 10, 0.02)).unwrap();
        topo.r#associations.push(assoc(1, 10, 0.5)).unwrap();
        topo.r#associations.push(assoc(2, 11, 0.99)).unwrap();
        let mut submit = pb::SubmitTopology::default();
        submit.set_topology(topo);
        let Some(SMsg::ResultReady(_)) = handle(&encode(CMsg::SubmitTopology(submit)), 3700.0)
        else {
            panic!("topology result_ready expected");
        };

        // Compile a shader that surfaces the topology terms into RGB.
        let src = "vec3 shade(Led led) {\n  \
                   float b = 0.0;\n  \
                   if (led.branch) { b = 1.0; }\n  \
                   return vec3(led.s, led.seg * 0.1, b);\n}\n";
        let compiled = ledmapper_fx_compiler::compile(src).expect("shader compiles");
        assert!(unsafe { lm_fx_load(compiled.fxb.as_ptr(), compiled.fxb.len()) });
        unsafe { lm_fx_set_active(true) };
        // update() rebuilds the per-LED topology cache the shade sweep reads.
        assert!(unsafe { lm_fx_update(0.0, 0.033, 0, 64) });
        let shade = |i: u32| -> [u8; 3] {
            let mut rgb = [0u8; 3];
            assert!(unsafe { lm_fx_shade(i, 0.0, 0.0, 0.0, rgb.as_mut_ptr()) });
            rgb
        };
        // LED 0: s≈0.02 -> tiny R, seg idx 0 -> G=0, at the junction -> B=255.
        let c0 = shade(0);
        assert!(c0[0] <= 10, "led 0 s≈0.02 -> small R, got {}", c0[0]);
        assert_eq!(c0[1], 0, "led 0 on segment index 0");
        assert_eq!(c0[2], 255, "led 0 sits at the junction");
        // LED 1: s=0.5 -> R≈127, seg idx 0 -> G=0, mid-segment -> B=0.
        let c1 = shade(1);
        assert!((120..=135).contains(&c1[0]), "led 1 s=0.5 -> R≈127, got {}", c1[0]);
        assert_eq!(c1[1], 0);
        assert_eq!(c1[2], 0, "led 1 mid-segment is not a junction");
        // LED 2: s≈0.99 -> large R, seg idx 1 -> G≈25, terminal end -> B=0.
        let c2 = shade(2);
        assert!(c2[0] >= 245, "led 2 s≈0.99 -> large R, got {}", c2[0]);
        assert!((20..=30).contains(&c2[1]), "led 2 seg index 1 -> G≈25, got {}", c2[1]);
        assert_eq!(c2[2], 0, "led 2 near a terminal (degree 1) is not a junction");
        // An unassociated LED reads seg=-1 (G clamps to 0), s=0, branch=false.
        assert_eq!(shade(5), [0, 0, 0], "unassociated LED has no topology terms");

        // Park the effect so the rest of the flow (which asserts map wipes) runs
        // against the built-in playback path, not an active shader.
        unsafe { lm_fx_set_active(false) };
    }

    // --- set_texture: stream a video frame into a texture-sampler effect -----
    // Upload UNIFORM frames so the sampled colour is uv-independent (any led.uv
    // returns the same texel), making the decode assertions deterministic
    // regardless of the map bounds. Exercises keyframe, DELTA (XOR-prev) and RLE.
    {
        let src = "texture vec3 v(2, 2);\n\
                   void update() {}\n\
                   vec3 shade(Led led) { return sample(v, led.uv); }\n";
        let compiled = ledmapper_fx_compiler::compile(src).expect("texture shader compiles");
        assert!(unsafe { lm_fx_load(compiled.fxb.as_ptr(), compiled.fxb.len()) });
        unsafe { lm_fx_set_active(true) };
        assert!(unsafe { lm_fx_update(0.0, 0.033, 0, 64) });
        let shade0 = || -> [u8; 3] {
            let mut rgb = [0u8; 3];
            assert!(unsafe { lm_fx_shade(0, 0.0, 0.0, 0.0, rgb.as_mut_ptr()) });
            rgb
        };
        let set_tex = |flags: u32, data: &[u8]| {
            let mut st = pb::SetTexture::default();
            st.r#tex_index = 0;
            st.r#format = 0; // RGB888
            st.r#width = 2;
            st.r#height = 2;
            st.r#flags = flags;
            st.r#data = micropb::heapless::Vec::from_slice(data).unwrap();
            // Fire-and-forget: no reply.
            assert!(handle(&encode(CMsg::SetTexture(st)), 4000.0).is_none());
        };

        // Keyframe (no flags): all-red, 4 texels of RGB888.
        set_tex(0, &[0xFF, 0, 0, 0xFF, 0, 0, 0xFF, 0, 0, 0xFF, 0, 0]);
        assert_eq!(shade0(), [255, 0, 0], "keyframe all-red -> sample red");

        // DELTA (bit0): red -> green. delta = new XOR prev = 00FF00 ^ FF0000 = FFFF00.
        set_tex(0x01, &[0xFF, 0xFF, 0, 0xFF, 0xFF, 0, 0xFF, 0xFF, 0, 0xFF, 0xFF, 0]);
        assert_eq!(shade0(), [0, 255, 0], "delta XOR -> sample green");

        // RLE keyframe (bit1) back to all-red. Zero-run scheme for FF 00 00 x4:
        // [z0 l1 FF][z2 l1 FF][z2 l1 FF][z2 l1 FF][z2 l0].
        set_tex(0x02, &[0, 1, 0xFF, 2, 1, 0xFF, 2, 1, 0xFF, 2, 1, 0xFF, 2, 0]);
        assert_eq!(shade0(), [255, 0, 0], "RLE keyframe all-red -> sample red");

        // Sub-byte grayscale formats decode into the vec3 sampler (g,g,g). Use
        // uniform frames so the sample is uv-independent.
        let set_tex_fmt = |format: u32, flags: u32, data: &[u8]| {
            let mut st = pb::SetTexture::default();
            st.r#tex_index = 0;
            st.r#format = format;
            st.r#width = 2;
            st.r#height = 2;
            st.r#flags = flags;
            st.r#data = micropb::heapless::Vec::from_slice(data).unwrap();
            assert!(handle(&encode(CMsg::SetTexture(st)), 4000.0).is_none());
        };
        // gray4 (5): 4 bits/texel, 2 texels/byte. 4 texels -> 2 bytes; 0xFF fills
        // both nibbles white, 0x00 black.
        set_tex_fmt(5, 0, &[0xFF, 0xFF]);
        assert_eq!(shade0(), [255, 255, 255], "gray4 all-white -> sample white");
        set_tex_fmt(5, 0, &[0x00, 0x00]);
        assert_eq!(shade0(), [0, 0, 0], "gray4 all-black -> sample black");
        // mono (6): 1 bit/texel. 4 texels -> 1 byte; low 4 bits set = all white.
        set_tex_fmt(6, 0, &[0x0F]);
        assert_eq!(shade0(), [255, 255, 255], "mono all-white -> sample white");
        set_tex_fmt(6, 0, &[0x00]);
        assert_eq!(shade0(), [0, 0, 0], "mono all-black -> sample black");

        // get_effect_uniforms advertises the declared 2x2 vec3 texture (index 0)
        // so a texture source can size its stream to match (a mismatched
        // set_texture is silently dropped).
        let Some(SMsg::EffectUniforms(eu)) = handle(
            &encode(CMsg::GetEffectUniforms(pb::GetEffectUniforms::default())),
            4000.0,
        ) else {
            panic!("effect_uniforms expected");
        };
        assert_eq!(eu.r#textures.len(), 1, "one declared texture");
        assert_eq!(eu.r#textures[0].r#index, 0);
        assert_eq!(eu.r#textures[0].r#width, 2);
        assert_eq!(eu.r#textures[0].r#height, 2);
        assert_eq!(eu.r#textures[0].r#elem, 3, "vec3 sampler -> 3 components");

        unsafe { lm_fx_set_active(false) };
    }

    // A NARROW texture (`: fixed8`, Q1.6, 1 byte/component) decodes through the
    // same float-free LUT path — no per-texel software float, and byte-exact for
    // 0/1-valued channels (64/64 == 1.0 in Q1.6). Confirms `texture … : fixed8`
    // both compiles and streams.
    {
        let src = "texture vec3 v(2, 2) : fixed8;\n\
                   void update() {}\n\
                   vec3 shade(Led led) { return sample(v, led.uv); }\n";
        let compiled = ledmapper_fx_compiler::compile(src).expect("fixed8 texture compiles");
        assert!(unsafe { lm_fx_load(compiled.fxb.as_ptr(), compiled.fxb.len()) });
        unsafe { lm_fx_set_active(true) };
        assert!(unsafe { lm_fx_update(0.0, 0.033, 0, 64) });
        let shade0 = || -> [u8; 3] {
            let mut rgb = [0u8; 3];
            assert!(unsafe { lm_fx_shade(0, 0.0, 0.0, 0.0, rgb.as_mut_ptr()) });
            rgb
        };
        let set_tex_fmt = |format: u32, data: &[u8]| {
            let mut st = pb::SetTexture::default();
            st.r#tex_index = 0;
            st.r#format = format;
            st.r#width = 2;
            st.r#height = 2;
            st.r#flags = 0;
            st.r#data = micropb::heapless::Vec::from_slice(data).unwrap();
            assert!(handle(&encode(CMsg::SetTexture(st)), 4000.0).is_none());
        };
        // rgb888 all-red -> (1,0,0), exact in Q1.6.
        set_tex_fmt(0, &[0xFF, 0, 0, 0xFF, 0, 0, 0xFF, 0, 0, 0xFF, 0, 0]);
        assert_eq!(shade0(), [255, 0, 0], "fixed8 arena, rgb888 red -> red");
        // gray8 all-white -> (1,1,1).
        set_tex_fmt(3, &[0xFF, 0xFF, 0xFF, 0xFF]);
        assert_eq!(shade0(), [255, 255, 255], "fixed8 arena, gray8 white -> white");
        // mono all-black -> (0,0,0).
        set_tex_fmt(6, &[0x00]);
        assert_eq!(shade0(), [0, 0, 0], "fixed8 arena, mono black -> black");
        unsafe { lm_fx_set_active(false) };
    }

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

    // Color correction: no request yet -> generation still 0.
    assert_eq!(unsafe { lm_color_correction_gen() }, 0);

    // A named profile resolves to the WS2812B defaults, bumps the generation
    // (the firmware polls this to regenerate the flash LUT), and replies welcome.
    let mut cc = pb::SetColorCorrection::default();
    cc.set_profile(micropb::heapless::String::try_from("ws2812b").unwrap());
    let Some(SMsg::Welcome(_)) = handle(&encode(CMsg::SetColorCorrection(cc)), 7000.0) else {
        panic!("set_color_correction -> welcome");
    };
    assert_eq!(unsafe { lm_color_correction_gen() }, 1);
    let mut params = [0.0f32; 6];
    assert_eq!(unsafe { lm_color_correction_params(params.as_mut_ptr()) }, 0);
    assert_eq!(&params[0..3], &[2.8, 2.8, 2.8]); // gamma R,G,B
    assert_eq!(&params[3..6], &[625.0, 1250.0, 300.0]); // luminance R,G,B
    // commit unset -> defaults to true (persist to flash).
    assert_eq!(unsafe { lm_color_correction_commit() }, 1);

    // A live-preview update sets commit=false: the firmware applies from RAM only.
    let mut ccl = pb::SetColorCorrection::default();
    ccl.set_gamma_r(2.0);
    ccl.set_commit(false);
    let Some(SMsg::Welcome(_)) = handle(&encode(CMsg::SetColorCorrection(ccl)), 7050.0) else {
        panic!("set_color_correction (live) -> welcome");
    };
    assert_eq!(unsafe { lm_color_correction_gen() }, 2);
    assert_eq!(unsafe { lm_color_correction_commit() }, 0);

    // Explicit per-channel fields override the default; the generation advances.
    let mut cc2 = pb::SetColorCorrection::default();
    cc2.set_gamma_r(2.2);
    cc2.set_lum_b(500.0);
    cc2.set_commit(true);
    let Some(SMsg::Welcome(_)) = handle(&encode(CMsg::SetColorCorrection(cc2)), 7100.0) else {
        panic!("set_color_correction (explicit) -> welcome");
    };
    assert_eq!(unsafe { lm_color_correction_gen() }, 3);
    assert_eq!(unsafe { lm_color_correction_params(params.as_mut_ptr()) }, 0);
    assert_eq!(params[0], 2.2); // gamma_r overridden
    assert_eq!(params[1], 2.8); // gamma_g still default
    assert_eq!(params[5], 500.0); // lum_b overridden
    assert_eq!(unsafe { lm_color_correction_commit() }, 1);

    // -- native OSC input (FUG-121): drive a uniform through lm_osc_ingest, the
    // same entry the UDP task feeds, and confirm it moves the rendered pixel.
    fn osc_str(s: &str) -> Vec<u8> {
        let mut v = s.as_bytes().to_vec();
        v.push(0);
        while v.len() % 4 != 0 {
            v.push(0);
        }
        v
    }
    fn osc_msg(addr: &str, tags: &str, body: &[u8]) -> Vec<u8> {
        let mut v = osc_str(addr);
        v.extend(osc_str(&format!(",{tags}")));
        v.extend_from_slice(body);
        v
    }
    let ingest = |pkt: &[u8]| -> u32 { unsafe { lm_osc_ingest(pkt.as_ptr(), pkt.len()) } };

    let src = "uniform float k : 0.0 .. 1.0 = 0.5;\n\
               vec3 shade(Led led) { return vec3(k, 0.0, 0.0); }\n";
    let compiled = ledmapper_fx_compiler::compile(src).expect("uniform shader compiles");
    assert!(unsafe { lm_fx_load(compiled.fxb.as_ptr(), compiled.fxb.len()) });
    unsafe { lm_fx_set_active(true) };
    assert!(unsafe { lm_fx_update(0.0, 0.033, 0, 8) });
    let shade_r = || -> u8 {
        let mut rgb = [0u8; 3];
        assert!(unsafe { lm_fx_shade(0, 0.0, 0.0, 0.0, rgb.as_mut_ptr()) });
        rgb[0]
    };

    // By name: /k = 1.0 -> red 255; /k = 0.0 -> red 0 (the manifest maps k->slot0).
    assert_eq!(ingest(&osc_msg("/k", "f", &1.0f32.to_be_bytes())), 1);
    assert_eq!(shade_r(), 255, "OSC /k=1.0 drives uniform k by name");
    assert_eq!(ingest(&osc_msg("/k", "f", &0.0f32.to_be_bytes())), 1);
    assert_eq!(shade_r(), 0, "OSC /k=0.0 by name");
    // An unknown name is dropped in name mode (pixel unchanged).
    assert_eq!(ingest(&osc_msg("/nope", "f", &1.0f32.to_be_bytes())), 0);
    assert_eq!(shade_r(), 0, "unknown OSC name is dropped");
    // A bundle carrying the named message applies too.
    {
        let m = osc_msg("/k", "f", &1.0f32.to_be_bytes());
        let mut b = b"#bundle\0".to_vec();
        b.extend_from_slice(&1u64.to_be_bytes());
        b.extend_from_slice(&(m.len() as i32).to_be_bytes());
        b.extend_from_slice(&m);
        assert_eq!(ingest(&b), 1);
        assert_eq!(shade_r(), 255, "OSC bundle drives the uniform");
    }
    // Slot-index mode: address is the raw slot. /0 = 0.0 -> red 0.
    unsafe { lm_osc_set_by_name(false) };
    assert_eq!(ingest(&osc_msg("/0", "f", &0.0f32.to_be_bytes())), 1);
    assert_eq!(shade_r(), 0, "slot-index mode drives slot 0");
    unsafe { lm_osc_set_by_name(true) };
    // Garbage is dropped, and ingest is inert with no active effect.
    assert_eq!(ingest(b"not-osc"), 0, "garbage datagram dropped");
    unsafe { lm_fx_set_active(false) };
    assert_eq!(ingest(&osc_msg("/k", "f", &0.5f32.to_be_bytes())), 0, "no active effect -> inert");
}
