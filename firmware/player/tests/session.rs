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
/// One request through the handler AND the wire: the reply is encoded the way
/// the firmware sends it (`Player::encode_reply`, which splices in the board
/// descriptor) and decoded back, so assertions see what the phone receives.
fn send(player: &mut Player, msg: CMsg, now: f64) -> Option<SMsg> {
    use micropb::{MessageDecode, PbDecoder};
    let req = pb::ClientMessage { r#msg: Some(msg) };
    let reply = player.handle_frame(&encode(&req), now as i64, now as i64)?;
    let mut buf = vec![0u8; 16 * 1024];
    let n = player.encode_reply(&reply, &mut buf).expect("reply fits");
    let mut back = pb::ServerMessage::default();
    back.decode(&mut PbDecoder::new(&buf[..n]), n).expect("reply decodes");
    back.r#msg
}

/// The wire bytes of a request: the player reads frames, not structs.
fn encode(req: &pb::ClientMessage) -> Vec<u8> {
    use micropb::{MessageEncode, PbEncoder};
    let mut enc = PbEncoder::new(micropb::heapless::Vec::<u8, 65536>::new());
    req.encode(&mut enc).expect("request encodes");
    enc.into_writer().to_vec()
}

fn get_hw(player: &mut Player) -> pb::HardwareConfigState {
    match send(player, CMsg::GetHardwareConfig(pb::GetHardwareConfig::default()), 0.0) {
        Some(SMsg::HardwareConfigState(st)) => st,
        other => panic!("expected hardware_config_state, got {other:?}"),
    }
}

/// The board descriptor stays ENCODED in the player and is spliced into
/// hardware_config_state at encode time; the runtime output caps fill only the
/// capacity fields the descriptor leaves 0.
#[test]
fn board_caps_spliced_into_hardware_config() {
    use micropb::{MessageEncode, PbEncoder};
    fn encoded(caps: &pb::BoardCapabilities) -> &'static [u8] {
        let mut enc = PbEncoder::new(micropb::heapless::Vec::<u8, 4096>::new());
        caps.encode(&mut enc).unwrap();
        Vec::leak(enc.into_writer().to_vec())
    }
    let mut caps = pb::BoardCapabilities::default();
    caps.r#board = micropb::heapless::String::try_from("esp32c6-devkit").unwrap();
    for g in [4u32, 9, 30] {
        let mut pin = pb::GpioPin::default();
        pin.r#gpio = g;
        pin.r#note = micropb::heapless::String::try_from("strap").unwrap();
        caps.r#gpio_pins.push(pin).unwrap();
    }

    // No descriptor, no output caps: no board at all.
    let mut player = Player::new("esp32-0001", 64);
    player.set_hw_defaults(0, 20, ledmapper_player::DEFAULT_COLOR_ORDER);
    assert!(get_hw(&mut player).r#board().is_none());

    // Descriptor with capacity fields unset: the output caps fill them.
    assert!(player.set_board_caps(encoded(&caps)));
    player.set_output_caps(2, 512);
    let st = get_hw(&mut player);
    assert_eq!(st.r#channels.len(), 1, "channels still encoded alongside the board");
    let b = st.r#board().expect("board reported");
    assert_eq!(b.r#board.as_str(), "esp32c6-devkit");
    let pins: Vec<u32> = b.r#gpio_pins.iter().map(|p| p.r#gpio).collect();
    assert_eq!(pins, [4, 9, 30]);
    assert_eq!(b.r#gpio_pins[1].r#note.as_str(), "strap");
    assert_eq!((b.r#led_channels, b.r#max_leds), (2, 512));

    // A descriptor that sets max_leds itself keeps it; led_channels still fills.
    caps.r#max_leds = 300;
    assert!(player.set_board_caps(encoded(&caps)));
    let b = get_hw(&mut player).r#board().cloned().expect("board");
    assert_eq!((b.r#led_channels, b.r#max_leds), (2, 300));

    // Malformed (truncated) descriptor: rejected, the previous one stays.
    let good = encoded(&caps);
    assert!(!player.set_board_caps(&good[..good.len() - 1]));
    assert_eq!(get_hw(&mut player).r#board().map(|b| b.r#max_leds), Some(300));
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
    let ping = pb::TimeSyncPing { r#t0: 123.5 };
    let req = pb::ClientMessage { r#msg: Some(CMsg::TimeSyncPing(ping)) };
    let Some(SMsg::TimeSyncPong(pong)) = player.handle_frame(&encode(&req), 500, 501).and_then(|r| r.r#msg)
    else {
        panic!("ping must produce pong");
    };
    // t0 keeps its fractional value (the phone clock); t1/t2 are the player's
    // integer clock widened to the wire double.
    assert_eq!((pong.r#t0, pong.r#t1, pong.r#t2), (123.5, 500.0, 501.0));

    // start_mapping for the golden's geometry: 16 LEDs, symbols=2.
    let g = golden();
    let opts = pb::StartMappingOptions { r#led_count: 16, ..Default::default() };
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
            let got = letter(player.pattern_color(id as u32, f as u32).expect("active"));
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
        let mut b = pb::ColorBlock { r#start, r#count: 64, ..Default::default() };
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
    // ...on the channel it named (the firmware routes the blocks, relative to
    // that channel's strip start, to that output)...
    assert_eq!(player.counting_channel(), 1);
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
    assert_eq!(player.counting_channel(), 0);
    // A channel the player doesn't drive is refused, leaving no pattern latched.
    let mut bad = pb::SetCountingPattern::default();
    let mut b = pb::ColorBlock { r#start: 0, r#count: 3, ..Default::default() };
    b.r#rgb.extend_from_slice(&[1.0, 0.0, 0.0]).unwrap();
    bad.r#blocks.push(b).unwrap();
    bad.set_channel(ledmapper_player::HW_CHANNELS as i32);
    expect_error(send(&mut player, CMsg::SetCountingPattern(bad), 3600.0), "bad_message");
    assert_eq!(player.counting_color(0), None);

    // The detected count persists per channel; channel 0 becomes the new
    // default code-book size.
    let slc = pb::SetLedCount { r#led_count: 300, ..Default::default() };
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
    let t = pb::Topology {
        r#map_id: core::str::FromStr::from_str("m-77").unwrap(),
        ..Default::default()
    };
    // set_* marks presence: an unset message field is not on the wire.
    let mut topo = pb::SubmitTopology::default();
    topo.set_topology(t);
    expect_error(send(&mut player, CMsg::SubmitTopology(topo.clone()), 6000.0), "unknown_map");
    let map = pb::OutputMap {
        r#map_id: core::str::FromStr::from_str("m-77").unwrap(),
        ..Default::default()
    };
    let mut submit = pb::SubmitMap::default();
    submit.set_map(map);
    let Some(SMsg::ResultReady(r)) = send(&mut player, CMsg::SubmitMap(submit), 6100.0) else {
        panic!("submit_map must produce result_ready");
    };
    assert_eq!(r.r#map_id.as_str(), "m-77");
    let Some(SMsg::ResultReady(r)) = send(&mut player, CMsg::SubmitTopology(topo), 6200.0) else {
        panic!("submit_topology must produce result_ready");
    };
    assert_eq!(r.r#map_id.as_str(), "m-77");

    // Playback: the native effects (pulse/flood) were removed in favour of the
    // effects engine, so playback is always "off": "off" acks idle, any named
    // native effect is a bounded refusal.
    let Some(SMsg::PlaybackState(ps)) =
        send(&mut player, CMsg::GetPlayback(pb::GetPlayback::default()), 7000.0)
    else {
        panic!("get_playback must produce playback_state");
    };
    assert!(!ps.r#active);
    assert_eq!(ps.r#effect.as_str(), "off");
    for name in ["pulse", "flood", "rainbow"] {
        let sp = pb::SetPlayback {
            r#effect: core::str::FromStr::from_str(name).unwrap(),
            ..Default::default()
        };
        expect_error(send(&mut player, CMsg::SetPlayback(sp), 7100.0), "unsupported_effect");
    }
    let off = pb::SetPlayback {
        r#effect: core::str::FromStr::from_str("off").unwrap(),
        ..Default::default()
    };
    let Some(SMsg::PlaybackState(ps)) = send(&mut player, CMsg::SetPlayback(off), 7200.0) else {
        panic!("set_playback off");
    };
    assert!(!ps.r#active);

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
    let mut opts = pb::StartMappingOptions { r#led_count: 16, ..Default::default() };
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

/// set_hardware_config / get_hardware_config: GPIO + wire color order round-trip,
/// validation, and the hardware_config_state the Hardware Setup page hydrates from.
#[test]
fn hardware_config_roundtrip() {
    let mut player = Player::new("esp32-0001", 256);
    // The firmware seeds the two RMT channels at boot; without a seed a channel
    // isn't wired and is omitted from the state.
    player.set_hw_defaults(0, 20, ledmapper_player::DEFAULT_COLOR_ORDER);
    player.set_hw_defaults(1, 14, ledmapper_player::DEFAULT_COLOR_ORDER);

    // get_hardware_config reports both seeded channels at the GRB default.
    let Some(SMsg::HardwareConfigState(st)) =
        send(&mut player, CMsg::GetHardwareConfig(pb::GetHardwareConfig::default()), 0.0)
    else {
        panic!("get_hardware_config must produce hardware_config_state");
    };
    assert_eq!(st.r#channels.len(), 2);
    let ch0 = &st.r#channels[0];
    assert_eq!((ch0.r#channel, ch0.r#gpio), (0, 20));
    assert_eq!(ch0.r#led_type.as_str(), "ws281x");
    assert_eq!(ch0.r#color_order.as_str(), "GRB");

    // Set channel 0's color order to RBG (the identity-ish preview the color test
    // uses). The reply echoes the new order; the FFI permutation follows.
    let mut cfg = pb::SetHardwareConfig::default();
    cfg.set_channel(0);
    cfg.set_color_order(micropb::heapless::String::try_from("RBG").unwrap());
    cfg.set_commit(false);
    let g0 = player.hw_config_gen();
    let Some(SMsg::HardwareConfigState(st)) = send(&mut player, CMsg::SetHardwareConfig(cfg), 100.0)
    else {
        panic!("set_hardware_config must produce hardware_config_state");
    };
    assert_eq!(st.r#channels[0].r#color_order.as_str(), "RBG");
    assert!(player.hw_config_gen() != g0, "a config change bumps the gen");
    assert!(!player.hw_config_commit(), "commit=false is a RAM preview");
    // RBG = wire R,B,G -> source permutation [0, 2, 1].
    assert_eq!(player.hw_color_order_perm(0), [0, 2, 1]);
    assert_eq!(player.hw_color_order_name(0), "RBG");
    // Channel 1 is untouched.
    assert_eq!(player.hw_color_order_name(1), "GRB");

    // A GPIO change on channel 1 (commit) sticks and echoes back.
    let mut cfg = pb::SetHardwareConfig::default();
    cfg.set_channel(1);
    cfg.set_gpio(21);
    cfg.set_commit(true);
    let Some(SMsg::HardwareConfigState(st)) = send(&mut player, CMsg::SetHardwareConfig(cfg), 200.0)
    else {
        panic!("hardware_config_state");
    };
    assert_eq!(st.r#channels[1].r#gpio, 21);
    assert_eq!(player.hw_gpio(1), Some(21));
    assert!(player.hw_config_commit(), "commit=true persists");

    // Validation: unknown order, bad GPIO, unsupported LED type, out-of-range
    // channel are all refused without mutating state.
    let mut bad = pb::SetHardwareConfig::default();
    bad.set_channel(0);
    bad.set_color_order(micropb::heapless::String::try_from("XYZ").unwrap());
    expect_error(send(&mut player, CMsg::SetHardwareConfig(bad), 300.0), "bad_message");
    let mut bad = pb::SetHardwareConfig::default();
    bad.set_channel(0);
    bad.set_gpio(99);
    expect_error(send(&mut player, CMsg::SetHardwareConfig(bad), 310.0), "bad_message");
    let mut bad = pb::SetHardwareConfig::default();
    bad.set_channel(0);
    bad.set_led_type(micropb::heapless::String::try_from("apa102").unwrap());
    expect_error(send(&mut player, CMsg::SetHardwareConfig(bad), 320.0), "bad_message");
    let mut bad = pb::SetHardwareConfig::default();
    bad.set_channel(9);
    expect_error(send(&mut player, CMsg::SetHardwareConfig(bad), 330.0), "bad_message");
    // Nothing above changed channel 0's order.
    assert_eq!(player.hw_color_order_name(0), "RBG");
}

/// set_color_correction -> get_color_correction: the read-back echoes the gamma
/// (and luminance) the device is applying, so the Color Correction page can
/// hydrate on open and a gamma HITL journey can assert "device applied gamma =
/// X" rather than only that the set was ack'd.
#[test]
fn color_correction_roundtrip() {
    let mut player = Player::new("esp32-0001", 256);

    // A fresh player reports the WS2812B default (gamma 2.8, datasheet luminance)
    // — the device always has a concrete profile, so the read-back is never empty.
    let Some(SMsg::ColorCorrectionState(st)) =
        send(&mut player, CMsg::GetColorCorrection(pb::GetColorCorrection::default()), 0.0)
    else {
        panic!("get_color_correction must produce color_correction_state");
    };
    assert_eq!(st.r#gamma_r, 2.8);
    assert_eq!(st.r#gamma_g, 2.8);
    assert_eq!(st.r#gamma_b, 2.8);
    assert_eq!((st.r#lum_r, st.r#lum_g, st.r#lum_b), (625.0, 1250.0, 300.0));

    // Set explicit per-channel gamma + luminance, then read it straight back:
    // the reply must echo exactly what was set.
    let mut cc = pb::SetColorCorrection::default();
    cc.set_gamma_r(2.0);
    cc.set_gamma_g(2.2);
    cc.set_gamma_b(2.4);
    cc.set_lum_r(700.0);
    cc.set_lum_g(1200.0);
    cc.set_lum_b(350.0);
    // set_color_correction acks with welcome (no state in the reply).
    let Some(SMsg::Welcome(_)) = send(&mut player, CMsg::SetColorCorrection(cc), 100.0) else {
        panic!("set_color_correction acks with welcome");
    };

    let Some(SMsg::ColorCorrectionState(st)) =
        send(&mut player, CMsg::GetColorCorrection(pb::GetColorCorrection::default()), 200.0)
    else {
        panic!("get_color_correction must produce color_correction_state");
    };
    assert_eq!((st.r#gamma_r, st.r#gamma_g, st.r#gamma_b), (2.0, 2.2, 2.4));
    assert_eq!((st.r#lum_r, st.r#lum_g, st.r#lum_b), (700.0, 1200.0, 350.0));

    // A named profile resolves to its concrete values, which the read-back
    // reports (a partial gamma-only set leaves the profile's luminance in place).
    let mut cc = pb::SetColorCorrection::default();
    cc.set_gamma_r(3.0);
    let Some(SMsg::Welcome(_)) = send(&mut player, CMsg::SetColorCorrection(cc), 300.0) else {
        panic!("set_color_correction acks with welcome");
    };
    let Some(SMsg::ColorCorrectionState(st)) =
        send(&mut player, CMsg::GetColorCorrection(pb::GetColorCorrection::default()), 400.0)
    else {
        panic!("color_correction_state");
    };
    // Only gamma_r was overridden; the rest fall back to the WS2812B default.
    assert_eq!(st.r#gamma_r, 3.0);
    assert_eq!((st.r#gamma_g, st.r#gamma_b), (2.8, 2.8));
    assert_eq!((st.r#lum_r, st.r#lum_g, st.r#lum_b), (625.0, 1250.0, 300.0));
}

#[test]
fn diffuse_striding_masks_and_rotates_phase() {
    // Diffuse capture: only the active phase's sparse subset lights; masked LEDs
    // read BLACK (never None), and a phase-only Configure advances the phase while
    // keeping the spacing/anchor the session started with.
    let mut player = Player::new("esp32-0001", 64);
    send(&mut player, CMsg::Hello(pb::Hello::default()), 1.0);

    let (spacing, anchor, led_count) = (3u32, 3u32, 32u32);
    let spec = pat::CodeSpec::derive(led_count, 2, true);
    let mut opts = pb::StartMappingOptions::default();
    opts.r#led_count = led_count as i32;
    opts.set_stride_spacing(spacing as i32);
    opts.set_anchor_density(anchor as i32);
    opts.set_stride_phase(0);
    let mut start = pb::StartMapping::default();
    start.set_options(opts);
    let Some(SMsg::MappingStarted(started)) = send(&mut player, CMsg::StartMapping(start), 1000.0)
    else {
        panic!("start_mapping must produce mapping_started");
    };
    // The active stride is echoed on CodeParams.
    let cp = &started.r#code_params;
    assert_eq!(cp.r#stride_spacing().copied(), Some(spacing as i32));
    assert_eq!(cp.r#anchor_density().copied(), Some(anchor as i32));
    assert_eq!(cp.r#stride_phase().copied(), Some(0));

    // Masking matches ledmapper_pattern::stride_lit for the active phase, across a
    // sync frame (ALL_OFF = green) and a data frame — lit LEDs keep their code
    // color, masked LEDs are black.
    let check_phase = |player: &Player, phase: u32| {
        for frame in [pat::FRAME_ALL_OFF, pat::DATA_FRAME_OFFSET] {
            for led in 0..led_count {
                let got = player.pattern_color(led, frame).expect("active");
                if pat::stride_lit(led, phase, spacing, anchor) {
                    assert_eq!(got, pat::color_for_frame(led, frame, &spec), "lit led {led} f{frame}");
                    assert_ne!(got, (0, 0, 0), "lit led {led} must not be black at f{frame}");
                } else {
                    assert_eq!(got, (0, 0, 0), "masked led {led} must be black at f{frame} phase {phase}");
                }
            }
        }
    };
    check_phase(&player, 0);

    // A phase-only Configure advances to phase 1 (spacing/anchor persist).
    let mut copts = pb::ConfigureOptions::default();
    copts.set_stride_phase(1);
    let mut configure = pb::Configure::default();
    configure.set_options(copts);
    let Some(SMsg::PatternState(state)) = send(&mut player, CMsg::Configure(configure), 2000.0)
    else {
        panic!("configure must produce pattern_state");
    };
    assert_eq!(state.r#code_params.r#stride_spacing().copied(), Some(spacing as i32));
    assert_eq!(state.r#code_params.r#stride_phase().copied(), Some(1));
    check_phase(&player, 1);
    // Turning striding OFF mid-session (the capture screen's live diffuse
    // toggle: Configure{stride_spacing: 0}) returns to dense capture — every
    // LED lit with its code color, and no stride echoed on CodeParams.
    let mut copts = pb::ConfigureOptions::default();
    copts.set_stride_spacing(0);
    let mut configure = pb::Configure::default();
    configure.set_options(copts);
    let Some(SMsg::PatternState(state)) = send(&mut player, CMsg::Configure(configure), 3000.0)
    else {
        panic!("configure must produce pattern_state");
    };
    assert_eq!(state.r#code_params.r#stride_spacing().copied(), None);
    for frame in [pat::FRAME_ALL_OFF, pat::DATA_FRAME_OFFSET] {
        for led in 0..led_count {
            let got = player.pattern_color(led, frame).expect("active");
            assert_eq!(got, pat::color_for_frame(led, frame, &spec), "dense led {led} f{frame}");
        }
    }

    // ...and back ON again, restarting at phase 0.
    let mut copts = pb::ConfigureOptions::default();
    copts.set_stride_spacing(spacing as i32);
    copts.set_anchor_density(anchor as i32);
    copts.set_stride_phase(0);
    let mut configure = pb::Configure::default();
    configure.set_options(copts);
    let Some(SMsg::PatternState(state)) = send(&mut player, CMsg::Configure(configure), 4000.0)
    else {
        panic!("configure must produce pattern_state");
    };
    assert_eq!(state.r#code_params.r#stride_spacing().copied(), Some(spacing as i32));
    check_phase(&player, 0);
}

/// Per-channel LED counts (set_hardware_config.led_count): echoed per channel in
/// hardware_config_state, bounded by the board's total LED cap, and their total
/// becomes the default map size so a new map covers every channel.
#[test]
fn hardware_config_led_counts() {
    let mut player = Player::new("esp32-0001", 64);
    player.set_hw_defaults(0, 20, ledmapper_player::DEFAULT_COLOR_ORDER);
    player.set_hw_defaults(1, 14, ledmapper_player::DEFAULT_COLOR_ORDER);
    player.set_output_caps(2, 512);
    // Boot seed from flash: channel 0 had 100 LEDs persisted.
    player.seed_led_count(0, 100);
    let gen0 = player.hw_config_gen();
    assert_eq!(player.hw_config_gen(), gen0, "seeding isn't a change to persist");

    let Some(SMsg::HardwareConfigState(st)) =
        send(&mut player, CMsg::GetHardwareConfig(pb::GetHardwareConfig::default()), 0.0)
    else {
        panic!("hardware_config_state");
    };
    assert_eq!(st.r#channels[0].r#led_count, 100);
    assert_eq!(st.r#channels[1].r#led_count, 0, "unset reads 0");
    // The runtime output caps fill the board descriptor's capacity fields.
    let board = st.r#board().expect("board reported");
    assert_eq!((board.r#led_channels, board.r#max_leds), (2, 512));

    // Channel 1 gets 150 LEDs: echoed, persisted (commit), and the default map
    // size becomes the TOTAL across channels.
    let set = |ch: i32, n: i32| {
        let mut cfg = pb::SetHardwareConfig::default();
        cfg.set_channel(ch);
        cfg.set_led_count(n);
        cfg.set_commit(true);
        CMsg::SetHardwareConfig(cfg)
    };
    let Some(SMsg::HardwareConfigState(st)) = send(&mut player, set(1, 150), 100.0) else {
        panic!("hardware_config_state");
    };
    assert_eq!(st.r#channels[1].r#led_count, 150);
    assert!(player.hw_config_gen() != gen0, "a count change bumps the gen (persist)");
    assert_eq!((player.led_count(0), player.led_count(1)), (Some(100), Some(150)));
    let Some(SMsg::Welcome(w)) = send(&mut player, CMsg::Hello(pb::Hello::default()), 150.0) else {
        panic!("welcome");
    };
    assert_eq!(w.r#code_params.r#led_count, 250, "default map size = channel total");

    // The SUM across channels is bounded by max_leds; a refusal leaves state alone.
    expect_error(send(&mut player, set(1, 413), 200.0), "bad_message");
    expect_error(send(&mut player, set(0, -1), 210.0), "bad_message");
    assert_eq!(player.led_count(1), Some(150));
    let Some(SMsg::HardwareConfigState(_)) = send(&mut player, set(1, 412), 220.0) else {
        panic!("exactly max_leds total is fine");
    };

    // 0 clears a channel's count.
    let Some(SMsg::HardwareConfigState(st)) = send(&mut player, set(1, 0), 300.0) else {
        panic!("hardware_config_state");
    };
    assert_eq!(st.r#channels[1].r#led_count, 0);
    assert_eq!(player.led_count(1), None);
}

/// 1024 LEDs per channel (firmware/player_app/led_caps.bzl): each hardware
/// channel is bounded by the per-channel cap as well as the shared total, through
/// both set_hardware_config and set_led_count, and the board reports the cap
/// (board.max_leds_per_channel) next to max_leds.
#[test]
fn per_channel_led_cap() {
    let mut player = Player::new("esp32-0001", 64);
    player.set_hw_defaults(0, 20, ledmapper_player::DEFAULT_COLOR_ORDER);
    player.set_hw_defaults(1, 14, ledmapper_player::DEFAULT_COLOR_ORDER);
    player.set_output_caps(2, 2048);
    player.set_channel_cap(1024);
    let Some(SMsg::HardwareConfigState(st)) = send(
        &mut player,
        CMsg::GetHardwareConfig(pb::GetHardwareConfig::default()),
        0.0,
    ) else {
        panic!("hardware_config_state");
    };
    let board = st.r#board().expect("board reported");
    assert_eq!(
        (
            board.r#led_channels,
            board.r#max_leds,
            board.r#max_leds_per_channel
        ),
        (2, 2048, 1024)
    );

    let hw = |ch: i32, n: i32| {
        let mut cfg = pb::SetHardwareConfig::default();
        cfg.set_channel(ch);
        cfg.set_led_count(n);
        CMsg::SetHardwareConfig(cfg)
    };
    let count = |ch: i32, n: i32| {
        let mut m = pb::SetLedCount {
            r#led_count: n,
            ..Default::default()
        };
        m.set_channel(ch);
        CMsg::SetLedCount(m)
    };
    // One past the per-channel cap is refused on either path; state untouched.
    expect_error(send(&mut player, hw(0, 1025), 1.0), "bad_message");
    expect_error(send(&mut player, count(1, 1025), 2.0), "bad_message");
    assert_eq!((player.led_count(0), player.led_count(1)), (None, None));
    // Exactly the cap on both channels: the full 2048.
    let Some(SMsg::HardwareConfigState(_)) = send(&mut player, hw(0, 1024), 3.0) else {
        panic!("1024 on channel 0 fits");
    };
    let Some(SMsg::LedCountState(s)) = send(&mut player, count(1, 1024), 4.0) else {
        panic!("1024 on channel 1 fits");
    };
    assert_eq!((s.r#channel, s.r#led_count), (1, 1024));
    assert_eq!(
        (player.led_count(0), player.led_count(1)),
        (Some(1024), Some(1024))
    );
    let Some(SMsg::Welcome(w)) = send(&mut player, CMsg::Hello(pb::Hello::default()), 5.0) else {
        panic!("welcome");
    };
    assert_eq!(
        w.r#code_params.r#led_count, 2048,
        "the code book covers both channels"
    );
    // Logical channels past the hardware are not bounded by the output caps.
    let Some(SMsg::LedCountState(_)) = send(&mut player, count(5, 4000), 6.0) else {
        panic!("a logical channel isn't a hardware output");
    };

    // A descriptor that sets max_leds_per_channel itself keeps it.
    let mut caps = pb::BoardCapabilities::default();
    caps.r#board = micropb::heapless::String::try_from("custom").unwrap();
    caps.r#max_leds_per_channel = 600;
    let encoded: &'static [u8] = {
        use micropb::{MessageEncode, PbEncoder};
        let mut enc = PbEncoder::new(micropb::heapless::Vec::<u8, 4096>::new());
        caps.encode(&mut enc).unwrap();
        Vec::leak(enc.into_writer().to_vec())
    };
    assert!(player.set_board_caps(encoded));
    let b = get_hw(&mut player).r#board().cloned().expect("board");
    assert_eq!((b.r#max_leds, b.r#max_leds_per_channel), (2048, 600));
}

/// The per-LED buffers are sized at boot for the persisted counts
/// (set_led_capacity): a change within them just applies; one past them (but
/// within board.max_leds) is accepted, forced to persist and answered
/// reboot_required + latched for the firmware; past board.max_leds it's refused.
#[test]
fn growing_past_the_boot_capacity_asks_for_a_reboot() {
    let mut player = Player::new("esp32-0001", 64);
    player.set_hw_defaults(0, 20, ledmapper_player::DEFAULT_COLOR_ORDER);
    player.set_hw_defaults(1, 14, ledmapper_player::DEFAULT_COLOR_ORDER);
    player.set_output_caps(2, 1600); // what this board's heap can buffer
    player.set_channel_cap(1024);
    player.set_led_capacity(512); // this boot's buffers
    player.seed_led_count(0, 256);
    player.seed_led_count(1, 256);
    assert_eq!(get_hw(&mut player).r#led_capacity, 512);

    let hw = |ch: i32, n: i32, commit: bool| {
        let mut cfg = pb::SetHardwareConfig::default();
        cfg.set_channel(ch);
        cfg.set_led_count(n);
        cfg.set_commit(commit);
        CMsg::SetHardwareConfig(cfg)
    };
    // Within the boot capacity: no reboot.
    let Some(SMsg::HardwareConfigState(st)) = send(&mut player, hw(0, 200, true), 1.0) else {
        panic!("hardware_config_state");
    };
    assert!(!st.r#reboot_required);
    assert!(!player.take_reboot_request());
    // Past it (even as a preview): applied, persisted, reboot asked for once.
    let gen = player.hw_config_gen();
    let Some(SMsg::HardwareConfigState(st)) = send(&mut player, hw(1, 1000, false), 2.0) else {
        panic!("hardware_config_state");
    };
    assert!(st.r#reboot_required);
    assert!(player.hw_config_commit(), "a resize persists even a preview");
    assert!(player.hw_config_gen() != gen);
    assert!(player.take_reboot_request());
    assert!(!player.take_reboot_request(), "the latch drains");
    // set_led_count does the same.
    let mut m = pb::SetLedCount { r#led_count: 600, ..Default::default() };
    m.set_channel(0);
    let Some(SMsg::LedCountState(s)) = send(&mut player, CMsg::SetLedCount(m), 3.0) else {
        panic!("led_count_state");
    };
    assert!(s.r#reboot_required);
    assert!(player.take_reboot_request());
    // Past board.max_leds (1600): refused, nothing changes, no reboot.
    expect_error(send(&mut player, hw(0, 1000, true), 4.0), "bad_message");
    assert_eq!((player.led_count(0), player.led_count(1)), (Some(600), Some(1000)));
    assert!(!player.take_reboot_request());
}

/// Start a group capture: `led_count` physical LEDs at `offset` in a shared
/// `space`-id code book, epoch pinned in the player's clock.
fn start_group(player: &mut Player, led_count: u32, offset: i32, space: i32, epoch: f64, now: f64) -> Option<SMsg> {
    let mut opts = pb::StartMappingOptions::default();
    opts.r#led_count = led_count as i32;
    opts.set_symbols(4);
    opts.set_code_offset(offset);
    opts.set_code_space(space);
    opts.set_epoch_ms(epoch);
    let mut start = pb::StartMapping::default();
    start.set_options(opts);
    send(player, CMsg::StartMapping(start), now)
}

#[test]
fn group_capture_offsets_ids_and_pins_the_epoch() {
    // docs/design/multi-fixture-localization.md: two fixtures share one 100-id
    // code book; fixture B's LED i transmits id 40 + i, on an epoch chosen by
    // the phone (in B's clock), and drives only its own 60 LEDs.
    let mut player = Player::new("esp32-0002", 64);
    send(&mut player, CMsg::Hello(pb::Hello::default()), 1.0);
    let Some(SMsg::MappingStarted(started)) = start_group(&mut player, 60, 40, 100, 4321.0, 5000.0) else {
        panic!("group start_mapping must produce mapping_started");
    };
    let spec = pat::CodeSpec::derive(100, 4, true);
    // The echo carries the SHARED code book (led_count = code space) + offset,
    // so every fixture of the group reports identical bits / cycle_frames.
    let cp = &started.r#code_params;
    assert_eq!(cp.r#led_count, 100);
    assert_eq!(cp.r#bits, spec.bits as i32);
    assert_eq!(cp.r#cycle_frames, spec.cycle_frames as i32);
    assert_eq!(cp.r#code_offset().copied(), Some(40));
    assert_eq!(started.r#pattern_clock_epoch, 4321.0);
    // Physical LEDs show id + offset; the frame loop drives exactly 60.
    for frame in [pat::FRAME_ALL_ON, pat::FRAME_ALL_OFF, pat::DATA_FRAME_OFFSET, pat::DATA_FRAME_OFFSET + 1] {
        for led in 0..60 {
            assert_eq!(player.pattern_color(led, frame), Some(pat::color_for_frame(led + 40, frame, &spec)));
        }
    }
    assert_eq!(player.pattern_timing().map(|t| (t.0, t.2, t.3)), Some((4321, spec.cycle_frames, 60)));
    // A Configure (e.g. brightness) keeps the group layout.
    let mut copts = pb::ConfigureOptions::default();
    copts.set_brightness(0.5);
    let mut configure = pb::Configure::default();
    configure.set_options(copts);
    let Some(SMsg::PatternState(state)) = send(&mut player, CMsg::Configure(configure), 6000.0) else {
        panic!("pattern_state");
    };
    assert_eq!(state.r#code_params.r#led_count, 100);
    assert_eq!(state.r#code_params.r#code_offset().copied(), Some(40));
}

#[test]
fn group_capture_rejects_bad_layouts() {
    let mut player = Player::new("esp32-0003", 64);
    send(&mut player, CMsg::Hello(pb::Hello::default()), 1.0);
    // Space too small for offset + LEDs.
    assert!(matches!(start_group(&mut player, 60, 50, 100, 1000.0, 1000.0), Some(SMsg::Error(_))));
    // Negative offset.
    assert!(matches!(start_group(&mut player, 10, -1, 100, 1000.0, 1000.0), Some(SMsg::Error(_))));
    // Space beyond the cap.
    assert!(matches!(start_group(&mut player, 10, 0, 100_000, 1000.0, 1000.0), Some(SMsg::Error(_))));
    // Epoch absurdly far from the player clock (a clock-sync bug).
    assert!(matches!(start_group(&mut player, 10, 0, 100, 1.0e9, 1000.0), Some(SMsg::Error(_))));
    // A solo capture (no group fields) is unchanged: led_count = code space, no offset echoed.
    let mut opts = pb::StartMappingOptions::default();
    opts.r#led_count = 32;
    let mut start = pb::StartMapping::default();
    start.set_options(opts);
    let Some(SMsg::MappingStarted(started)) = send(&mut player, CMsg::StartMapping(start), 2000.0) else {
        panic!("mapping_started");
    };
    assert_eq!(started.r#code_params.r#led_count, 32);
    assert_eq!(started.r#code_params.r#code_offset().copied(), None);
    assert_eq!(started.r#pattern_clock_epoch, 2000.0);
}

#[test]
fn group_capture_auto_stops() {
    // stop_after_ms: the pattern ends by itself (a dead phone can't leave the
    // fixture flashing); a Configure keeps the original deadline.
    let mut player = Player::new("esp32-0004", 64);
    send(&mut player, CMsg::Hello(pb::Hello::default()), 1.0);
    let mut opts = pb::StartMappingOptions::default();
    opts.r#led_count = 16;
    opts.set_stop_after_ms(60_000);
    let mut start = pb::StartMapping::default();
    start.set_options(opts);
    assert!(matches!(send(&mut player, CMsg::StartMapping(start), 1000.0), Some(SMsg::MappingStarted(_))));
    let mut copts = pb::ConfigureOptions::default();
    copts.set_brightness(0.5);
    let mut configure = pb::Configure::default();
    configure.set_options(copts);
    assert!(matches!(send(&mut player, CMsg::Configure(configure), 30_000.0), Some(SMsg::PatternState(_))));
    assert!(!player.expire_pattern(60_999));
    assert!(player.pattern_timing().is_some());
    assert!(player.expire_pattern(61_000));
    assert!(player.pattern_timing().is_none());
    assert!(!player.expire_pattern(70_000));
    // Without stop_after_ms it never expires.
    let mut opts = pb::StartMappingOptions::default();
    opts.r#led_count = 16;
    let mut start = pb::StartMapping::default();
    start.set_options(opts);
    send(&mut player, CMsg::StartMapping(start), 80_000.0);
    assert!(!player.expire_pattern(i64::MAX / 2));
}
