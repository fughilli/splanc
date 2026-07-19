//! Scripted phone mapping session against the player core.
//!
//! Mirrors the phone client's actual flow (web/src/net/client.ts usage):
//! hello -> clock sync -> start_mapping -> pattern -> configure ->
//! counting handshake -> stop -> submit_map/topology -> playback. The
//! pattern-generator integration is pinned to the SAME golden the phone
//! decoder verifies: a 16-LED capture must produce golden_secded16.json's
//! colorPlan frame for frame.

use ledmapper_pattern as pat;
use ledmapper_pb::ledmapper_::v1_ as pb;
use ledmapper_player::Player;
use pb::ClientMessage_::Msg as CMsg;
use pb::ServerMessage_::Msg as SMsg;

// `now` stays f64 at the call sites (the golden fixtures are written that way)
// and is narrowed to the player's integer clock here.
fn send(player: &mut Player, msg: CMsg, now: f64) -> Option<SMsg> {
    let req = pb::ClientMessage { r#msg: Some(msg) };
    player.handle(req, now as i64, now as i64).and_then(|r| r.r#msg)
}

fn expect_error(reply: Option<SMsg>, code: &str) {
    match reply {
        Some(SMsg::Error(e)) => assert_eq!(e.r#code.as_str(), code, "{}", e.r#message.as_str()),
        other => panic!("expected error {code:?}, got {other:?}"),
    }
}

fn golden() -> serde_json::Value {
    let path = std::env::var("GOLDEN_SECDED16").expect("GOLDEN_SECDED16 not set");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn letter(color: pat::Rgb) -> char {
    match color {
        pat::WHITE => 'W',
        pat::GREEN => 'G',
        pat::RED => 'R',
        pat::BLUE => 'B',
        pat::MAGENTA => 'M',
        pat::YELLOW => 'Y',
        other => panic!("color {other:?} is not in the palette"),
    }
}

#[test]
fn full_phone_session() {
    let mut player = Player::new("esp32-0001", 1024);

    // hello -> welcome: session id, default code-book, and CRUCIALLY no
    // solverBenchMs — that absence is what routes the phone's solve local.
    let Some(SMsg::Welcome(w)) = send(&mut player, CMsg::Hello(pb::Hello::default()), 1.0) else {
        panic!("hello must produce welcome");
    };
    assert_eq!(w.r#session_id.as_str(), "esp32-0001");
    assert!(!w._has.r#solver_bench_ms(), "a solverless player must not advertise a bench score");
    assert_eq!(w.r#code_params.r#led_count, 1024);
    assert_eq!(w.r#code_params.r#encoding.as_str(), "hue");

    // Clock sync (§7.3): t0 echoed, t1 = receive, t2 = send.
    let mut ping = pb::TimeSyncPing::default();
    ping.r#t0 = 123.5;
    let req = pb::ClientMessage { r#msg: Some(CMsg::TimeSyncPing(ping)) };
    let Some(SMsg::TimeSyncPong(pong)) = player.handle(req, 500, 501).and_then(|r| r.r#msg)
    else {
        panic!("ping must produce pong");
    };
    // t0 keeps its fractional value (the phone clock); t1/t2 are the player's
    // integer clock widened to the wire double.
    assert_eq!((pong.r#t0, pong.r#t1, pong.r#t2), (123.5, 500.0, 501.0));

    // start_mapping for the golden's geometry: 16 LEDs, symbols=2.
    let g = golden();
    let mut opts = pb::StartMappingOptions::default();
    opts.r#led_count = 16;
    let mut start = pb::StartMapping::default();
    start.set_options(opts);
    let Some(SMsg::MappingStarted(started)) = send(&mut player, CMsg::StartMapping(start), 1000.0)
    else {
        panic!("start_mapping must produce mapping_started");
    };
    assert_eq!(started.r#pattern_clock_epoch, 1000.0);
    let cp = &started.r#code_params;
    assert_eq!(cp.r#led_count, 16);
    assert_eq!(cp.r#symbols, 2);
    assert_eq!(cp.r#fec.as_str(), "secded");
    assert_eq!(cp.r#bits as u64, g["bits"].as_u64().unwrap());
    assert_eq!(cp.r#cycle_frames as u64, g["cycleFrames"].as_u64().unwrap());

    // The pattern the player would drive out matches the golden colorPlan —
    // i.e. exactly what the phone decoder is tested to read.
    for (f, row) in g["colorPlan"].as_array().unwrap().iter().enumerate() {
        for (id, expected) in row.as_str().unwrap().chars().enumerate() {
            let got = letter(player.pattern_color(id as u32, f as u32, 0).expect("active"));
            assert_eq!(got, expected, "frame {f}, LED {id}");
        }
    }

    // Mid-capture renegotiation to symbols=4 (good chroma SNR): new epoch,
    // half the data frames (10 bits -> 5 frames + 2 sync).
    let mut copts = pb::ConfigureOptions::default();
    copts.set_symbols(4);
    let mut configure = pb::Configure::default();
    configure.set_options(copts);
    let Some(SMsg::PatternState(state)) = send(&mut player, CMsg::Configure(configure), 2000.0)
    else {
        panic!("configure must produce pattern_state");
    };
    assert!(state.r#active);
    assert_eq!(state.r#pattern_clock_epoch().copied(), Some(2000.0));
    assert_eq!(state.r#code_params.r#symbols, 4);
    assert_eq!(state.r#code_params.r#cycle_frames, 7);

    // Counting handshake: latch a two-block pattern on channel 1...
    let mut counting = pb::SetCountingPattern::default();
    for (start, rgb) in [(0, [1.0, 0.0, 0.0]), (64, [0.0, 0.0, 1.0])] {
        let mut b = pb::ColorBlock::default();
        b.r#start = start;
        b.r#count = 64;
        b.r#rgb.extend_from_slice(&rgb).unwrap();
        counting.r#blocks.push(b).unwrap();
    }
    counting.set_channel(1);
    let Some(SMsg::CountingState(cs)) =
        send(&mut player, CMsg::SetCountingPattern(counting), 3000.0)
    else {
        panic!("set_counting_pattern must produce counting_state");
    };
    assert!(cs.r#active);
    assert_eq!(cs.r#epoch_ms().copied(), Some(3000.0));
    // ...the driver-facing colors paint the blocks and nothing else (past
    // the last block IS the probe region — off).
    assert_eq!(player.counting_color(10), Some((255, 0, 0)));
    assert_eq!(player.counting_color(64), Some((0, 0, 255)));
    assert_eq!(player.counting_color(127), Some((0, 0, 255)));
    assert_eq!(player.counting_color(128), Some((0, 0, 0)));
    // Clearing: empty blocks -> inactive, no epoch.
    let Some(SMsg::CountingState(cs)) =
        send(&mut player, CMsg::SetCountingPattern(pb::SetCountingPattern::default()), 3500.0)
    else {
        panic!("clear must produce counting_state");
    };
    assert!(!cs.r#active);
    assert!(cs.r#epoch_ms().is_none());
    assert_eq!(player.counting_color(10), None);

    // The detected count persists per channel; channel 0 becomes the new
    // default code-book size.
    let mut slc = pb::SetLedCount::default();
    slc.r#led_count = 300;
    let Some(SMsg::LedCountState(ls)) = send(&mut player, CMsg::SetLedCount(slc), 4000.0) else {
        panic!("set_led_count must produce led_count_state");
    };
    assert_eq!((ls.r#led_count, ls.r#channel), (300, 0));
    assert_eq!(player.led_count(0), Some(300));

    // A host solve is impossible here: bare stop_mapping is a placement bug
    // and must be refused loudly (capture keeps running)...
    expect_error(
        send(&mut player, CMsg::StopMapping(pb::StopMapping::default()), 5000.0),
        "unsupported",
    );
    assert!(player.pattern_epoch_ms().is_some(), "refused stop must not kill the capture");
    // ...while the phone-solve path stops cleanly.
    let mut stop = pb::StopMapping::default();
    stop.set_solve_on_host(false);
    let Some(SMsg::MappingStopped(stopped)) = send(&mut player, CMsg::StopMapping(stop), 5100.0)
    else {
        panic!("stop_mapping(solveOnHost=false) must produce mapping_stopped");
    };
    assert_eq!((stopped.r#detections, stopped.r#imu_samples), (0, 0));
    assert!(player.pattern_epoch_ms().is_none());

    // Idle pattern poll advertises the NEW default (the counted 300).
    let Some(SMsg::PatternState(idle)) =
        send(&mut player, CMsg::GetPattern(pb::GetPattern::default()), 5200.0)
    else {
        panic!("get_pattern must produce pattern_state");
    };
    assert!(!idle.r#active);
    assert!(idle.r#pattern_clock_epoch().is_none());
    assert_eq!(idle.r#code_params.r#led_count, 300);

    // Phone-solved map upload, then its topology (order matters: topology
    // for an unknown map is refused).
    let mut topo = pb::SubmitTopology::default();
    let mut t = pb::Topology::default();
    t.r#map_id = core::str::FromStr::from_str("m-77").unwrap();
    topo.r#topology = t;
    expect_error(send(&mut player, CMsg::SubmitTopology(topo.clone()), 6000.0), "unknown_map");
    let mut submit = pb::SubmitMap::default();
    let mut map = pb::OutputMap::default();
    map.r#map_id = core::str::FromStr::from_str("m-77").unwrap();
    submit.r#map = map;
    let Some(SMsg::ResultReady(r)) = send(&mut player, CMsg::SubmitMap(submit), 6100.0) else {
        panic!("submit_map must produce result_ready");
    };
    assert_eq!(r.r#map_id.as_str(), "m-77");
    let Some(SMsg::ResultReady(r)) = send(&mut player, CMsg::SubmitTopology(topo), 6200.0) else {
        panic!("submit_topology must produce result_ready");
    };
    assert_eq!(r.r#map_id.as_str(), "m-77");

    // Playback: off is universal, "pulse" is the topology-aware effect, any
    // other name is a bounded refusal.
    let Some(SMsg::PlaybackState(ps)) =
        send(&mut player, CMsg::GetPlayback(pb::GetPlayback::default()), 7000.0)
    else {
        panic!("get_playback must produce playback_state");
    };
    assert!(!ps.r#active);
    assert_eq!(ps.r#effect.as_str(), "off");
    // Enable the pulse effect: state goes active + the config is stored.
    let mut params = pb::PlaybackParams::default();
    params.set_speed(0.5);
    params.set_agent_count(2);
    let mut sp = pb::SetPlayback::default();
    sp.r#effect = core::str::FromStr::from_str("pulse").unwrap();
    sp.set_params(params);
    let Some(SMsg::PlaybackState(ps)) = send(&mut player, CMsg::SetPlayback(sp), 7100.0) else {
        panic!("set_playback pulse must produce playback_state");
    };
    assert!(ps.r#active);
    assert_eq!(ps.r#effect.as_str(), "pulse");
    assert!(player.effect_config().is_some());
    // The topology-aware flood effect is also accepted.
    let mut flood = pb::SetPlayback::default();
    flood.r#effect = core::str::FromStr::from_str("flood").unwrap();
    let Some(SMsg::PlaybackState(ps)) = send(&mut player, CMsg::SetPlayback(flood), 7120.0) else {
        panic!("set_playback flood must produce playback_state");
    };
    assert!(ps.r#active);
    assert_eq!(ps.r#effect.as_str(), "flood");
    // An unknown effect is refused and leaves the effect running.
    let mut bad = pb::SetPlayback::default();
    bad.r#effect = core::str::FromStr::from_str("rainbow").unwrap();
    expect_error(send(&mut player, CMsg::SetPlayback(bad), 7150.0), "unsupported_effect");
    // "off" clears it.
    let mut off = pb::SetPlayback::default();
    off.r#effect = core::str::FromStr::from_str("off").unwrap();
    let Some(SMsg::PlaybackState(ps)) = send(&mut player, CMsg::SetPlayback(off), 7200.0) else {
        panic!("set_playback off");
    };
    assert!(!ps.r#active);
    assert!(player.effect_config().is_none());

    // Pi-profile arms: telemetry drops silently, polls refuse loudly.
    assert!(send(&mut player, CMsg::Detections(pb::Detections::default()), 8000.0).is_none());
    assert!(send(&mut player, CMsg::ImuBatch(pb::ImuBatch::default()), 8000.0).is_none());
    expect_error(send(&mut player, CMsg::GetStatus(pb::GetStatus::default()), 8000.0), "unsupported");
    expect_error(
        send(&mut player, CMsg::GetLiveMap(pb::GetLiveMap::default()), 8000.0),
        "unsupported",
    );
}

/// get_frame_timing drains the rendered-frame log the output driver feeds via
/// record_frame_shown: the reply carries the active capture's context, the
/// samples in emit order, and the overflow-drop count; a second poll comes
/// back empty (the log was drained, not re-read).
#[test]
fn frame_timing_drain() {
    let mut player = Player::new("esp32-0001", 16);

    // No capture yet: empty context, no ticks, nothing dropped.
    let Some(SMsg::FrameTiming(ft)) =
        send(&mut player, CMsg::GetFrameTiming(pb::GetFrameTiming::default()), 10.0)
    else {
        panic!("get_frame_timing must produce frame_timing");
    };
    assert_eq!(ft.r#pattern_clock_epoch_ms(), None, "idle: no epoch");
    assert!(ft.r#ticks.is_empty());
    assert_eq!(ft.r#dropped, 0);

    // Start a capture so the reply can report epoch/period/cycle context.
    let mut opts = pb::StartMappingOptions::default();
    opts.r#led_count = 16;
    opts.set_bit_period_ms(100.0);
    let mut start = pb::StartMapping::default();
    start.set_options(opts);
    let Some(SMsg::MappingStarted(started)) = send(&mut player, CMsg::StartMapping(start), 1000.0)
    else {
        panic!("start_mapping must produce mapping_started");
    };
    let cycle_frames = started.r#code_params.r#cycle_frames as u32;

    // Frame loop emits frames 0..5, one bit-period (100 ms = 100_000 µs) apart.
    for seq in 0..5u32 {
        player.record_frame_shown(seq, 1_000_000 + seq * 100_000);
    }
    let Some(SMsg::FrameTiming(ft)) =
        send(&mut player, CMsg::GetFrameTiming(pb::GetFrameTiming::default()), 1600.0)
    else {
        panic!("frame_timing");
    };
    assert_eq!(ft.r#pattern_clock_epoch_ms().copied(), Some(1000));
    assert_eq!(ft.r#bit_period_us, 100_000);
    assert_eq!(ft.r#cycle_frames, cycle_frames);
    assert_eq!(ft.r#dropped, 0);
    assert_eq!(ft.r#ticks.len(), 5);
    for (i, tick) in ft.r#ticks.iter().enumerate() {
        assert_eq!(tick.r#seq, i as u32);
        assert_eq!(tick.r#t_mono_us, 1_000_000 + (i as u32) * 100_000);
    }

    // Draining consumes the log: an immediate re-poll is empty.
    let Some(SMsg::FrameTiming(ft)) =
        send(&mut player, CMsg::GetFrameTiming(pb::GetFrameTiming::default()), 1700.0)
    else {
        panic!("frame_timing");
    };
    assert!(ft.r#ticks.is_empty());
    assert_eq!(ft.r#dropped, 0);

    // Overflow: flood well past the ring depth without polling. The oldest
    // samples are dropped (and counted); what survives is the most recent.
    for seq in 0..500u32 {
        player.record_frame_shown(seq, 2_000_000 + seq);
    }
    let Some(SMsg::FrameTiming(ft)) =
        send(&mut player, CMsg::GetFrameTiming(pb::GetFrameTiming::default()), 3000.0)
    else {
        panic!("frame_timing");
    };
    assert!(ft.r#dropped > 0, "flood past the ring must drop samples");
    // Survivors are contiguous and the newest: last survivor is frame 499.
    let last = ft.r#ticks.iter().last().expect("some survivors");
    assert_eq!(last.r#seq, 499);
    // dropped + delivered accounts for every sample pushed since the last poll.
    assert_eq!(ft.r#dropped + ft.r#ticks.len() as u32, 500);
}

#[test]
fn masked_recapture_holds_off_unmasked_and_rolls_targets() {
    let mut player = Player::new("p", 8);
    send(&mut player, CMsg::Hello(pb::Hello::default()), 0.0);

    // Light LEDs 0, 2, 5 only (byte 0 bits 0,2,5 = 0x25); the rest are held off.
    let mut opts = pb::StartMappingOptions::default();
    opts.r#led_count = 8;
    opts.r#led_mask.extend_from_slice(&[0x25]).unwrap();
    let mut sm = pb::StartMapping::default();
    sm.set_options(opts);
    send(&mut player, CMsg::StartMapping(sm), 1000.0);
    // Frame 0 is ALL_ON white for lit LEDs; masked-off LEDs are black.
    assert_eq!(player.pattern_color(0, 0, 0).unwrap(), pat::WHITE, "masked LED 0 lit");
    assert_eq!(player.pattern_color(2, 0, 0).unwrap(), pat::WHITE, "masked LED 2 lit");
    assert_eq!(player.pattern_color(1, 0, 0).unwrap(), (0, 0, 0), "unmasked LED 1 off");
    assert_eq!(player.pattern_color(7, 0, 0).unwrap(), (0, 0, 0), "unmasked LED 7 off");

    // Rolling: mask 0,1,2,3; anchor 0; mod 2. Anchor lit every cycle; a target
    // lights only on cycles where cycle % 2 == id % 2.
    let mut opts = pb::StartMappingOptions::default();
    opts.r#led_count = 8;
    opts.r#led_mask.extend_from_slice(&[0x0F]).unwrap();
    opts.r#anchor_mask.extend_from_slice(&[0x01]).unwrap();
    opts.r#rolling_mod = 2;
    let mut sm = pb::StartMapping::default();
    sm.set_options(opts);
    send(&mut player, CMsg::StartMapping(sm), 2000.0);
    assert_eq!(player.pattern_color(0, 0, 0).unwrap(), pat::WHITE, "anchor lit on even cycle");
    assert_eq!(player.pattern_color(0, 0, 1).unwrap(), pat::WHITE, "anchor lit on odd cycle");
    assert_eq!(player.pattern_color(1, 0, 0).unwrap(), (0, 0, 0), "target 1 off out of phase");
    assert_eq!(player.pattern_color(1, 0, 1).unwrap(), pat::WHITE, "target 1 lit in phase");
    assert_eq!(player.pattern_color(2, 0, 0).unwrap(), pat::WHITE, "target 2 lit in phase");
    assert_eq!(player.pattern_color(2, 0, 1).unwrap(), (0, 0, 0), "target 2 off out of phase");
}
