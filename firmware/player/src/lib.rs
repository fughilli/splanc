//! Player protocol core — the firmware-side session state machine.
//!
//! no_std, transport-free: one decoded `ClientMessage` in, at most one
//! `ServerMessage` out. The WSS/RMT plumbing (Phases 2/4c) wraps this; the
//! host tests drive it with the SAME golden client frames the phone's wire
//! is verified against, so "firmware server vs phone client" is pinned by
//! fixtures, not by hope.
//!
//! Implements the CORE player profile from ledmapper.proto:
//! - hello -> welcome (NO solverBenchMs: this player has no solver, which
//!   makes the phone's placement decision "solve on phone" by itself);
//! - stop_mapping with solveOnHost unset/true -> error{unsupported}: there
//!   is no host solve here, the phone must stop with solveOnHost=false and
//!   upload via submit_map;
//! - Pi-only request arms (get_status, get_live_map, get_solve_status) ->
//!   error{unsupported}; fire-and-forget Pi arms (detections, imu_batch,
//!   exposure_report) are silently dropped (a chatty phone must not flood
//!   the error channel);
//! - the code-book derivation matches pi/server/server/codebook.py by
//!   construction (ledmapper_pattern::CodeSpec::derive), so mapping_started
//!   carries the exact CodeParams the phone decodes against.

#![no_std]

use ledmapper_pattern::{color_for_frame, CodeSpec, Rgb};
use ledmapper_pb::ledmapper_::v1_ as pb;
use pb::ClientMessage_::Msg as CMsg;
use pb::ServerMessage_::Msg as SMsg;

/// design doc §12 default: frame period >= ~3 camera frame intervals.
pub const DEFAULT_BIT_PERIOD_MS: f64 = 100.0;
/// Robust fallback alphabet; the client negotiates 4 when its SNR allows.
pub const DEFAULT_SYMBOLS: u8 = 2;
/// Output channels a player may drive (the C6 has plenty of RMT channels).
pub const MAX_CHANNELS: usize = 8;

type Str64 = micropb::heapless::String<64>;

fn s64(s: &str) -> Str64 {
    let mut out = Str64::new();
    // Protocol strings are short by contract; truncation would be a bug in
    // OUR constants, not remote input.
    let _ = out.push_str(s);
    out
}

#[derive(Debug, Clone, Copy)]
struct ActiveCapture {
    epoch_ms: f64,
    spec: CodeSpec,
    bit_period_ms: f64,
}

/// The protocol session core. One per WSS connection (like the Pi's
/// ConnectionHandler), with the persisted bits (led_counts, stored map)
/// living for the player's lifetime in the real firmware.
pub struct Player {
    session_id: Str64,
    default_led_count: u32,
    active: Option<ActiveCapture>,
    counting: Option<(f64, pb::SetCountingPattern)>,
    led_counts: [Option<u32>; MAX_CHANNELS],
    stored_map_id: Option<Str64>,
}

impl Player {
    pub fn new(session_id: &str, default_led_count: u32) -> Self {
        Player {
            session_id: s64(session_id),
            default_led_count,
            active: None,
            counting: None,
            led_counts: [None; MAX_CHANNELS],
            stored_map_id: None,
        }
    }

    /// Handle one client message. `recv_ms`/`send_ms` are the player-clock
    /// receive and reply timestamps (§7.3 time sync needs both; everything
    /// else uses `send_ms` as "now"). Returns the reply, or None for
    /// fire-and-forget arms.
    pub fn handle(
        &mut self,
        req: pb::ClientMessage,
        recv_ms: f64,
        send_ms: f64,
    ) -> Option<pb::ServerMessage> {
        let Some(msg) = req.r#msg else {
            return Some(error("bad_message", "envelope has no message set"));
        };
        match msg {
            CMsg::Hello(_) => Some(self.welcome()),
            CMsg::TimeSyncPing(p) => {
                let mut pong = pb::TimeSyncPong::default();
                pong.r#t0 = p.r#t0;
                pong.r#t1 = recv_ms;
                pong.r#t2 = send_ms;
                Some(reply(SMsg::TimeSyncPong(pong)))
            }
            CMsg::StartMapping(m) => Some(self.start_mapping(&m, send_ms)),
            CMsg::Configure(m) => Some(self.configure(&m, send_ms)),
            CMsg::StopMapping(m) => Some(self.stop_mapping(&m)),
            CMsg::GetPattern(_) => Some(self.pattern_state()),
            CMsg::SetCountingPattern(m) => Some(self.set_counting_pattern(m, send_ms)),
            CMsg::SetLedCount(m) => Some(self.set_led_count(&m)),
            CMsg::SubmitMap(m) => {
                self.stored_map_id = Some(m.r#map.r#map_id.clone());
                let mut r = pb::ResultReady::default();
                r.r#map_id = m.r#map.r#map_id.clone();
                Some(reply(SMsg::ResultReady(r)))
            }
            CMsg::SubmitTopology(m) => {
                if self.stored_map_id.as_ref() != Some(&m.r#topology.r#map_id) {
                    return Some(error("unknown_map", "no stored map for this topology"));
                }
                let mut r = pb::ResultReady::default();
                r.r#map_id = m.r#topology.r#map_id.clone();
                Some(reply(SMsg::ResultReady(r)))
            }
            CMsg::SetPlayback(m) => {
                if m.r#effect.as_str() == "off" {
                    Some(self.playback_state())
                } else {
                    Some(error(
                        "unsupported_effect",
                        "effect not available on this player (supported: off)",
                    ))
                }
            }
            CMsg::GetPlayback(_) => Some(self.playback_state()),
            // Fire-and-forget Pi-profile telemetry: silently dropped.
            CMsg::Detections(_) | CMsg::ImuBatch(_) | CMsg::ExposureReport(_) => None,
            // Pi-only REQUEST arms: bounded unsupported error.
            CMsg::GetStatus(_) | CMsg::GetLiveMap(_) | CMsg::GetSolveStatus(_) => {
                Some(error("unsupported", "not available on this player profile"))
            }
        }
    }

    // -- capture ----------------------------------------------------------

    fn start_mapping(&mut self, m: &pb::StartMapping, now_ms: f64) -> pb::ServerMessage {
        let Some(options) = m.r#options() else {
            return error("bad_message", "start_mapping without options");
        };
        let led_count = options.r#led_count;
        if led_count < 1 {
            return error("bad_message", "ledCount must be >= 1");
        }
        let symbols = match options.r#symbols().copied() {
            None => DEFAULT_SYMBOLS,
            Some(2) => 2,
            Some(4) => 4,
            Some(_) => return error("bad_message", "symbols must be 2 or 4"),
        };
        let bit_period_ms = options
            .r#bit_period_ms()
            .copied()
            .unwrap_or(DEFAULT_BIT_PERIOD_MS);
        if !(bit_period_ms > 0.0) {
            return error("bad_message", "bitPeriodMs must be > 0");
        }
        let spec = CodeSpec::derive(led_count as u32, symbols, true);
        self.active = Some(ActiveCapture {
            epoch_ms: now_ms,
            spec,
            bit_period_ms,
        });
        let mut started = pb::MappingStarted::default();
        started.r#pattern_clock_epoch = now_ms;
        started.set_code_params(code_params_msg(&spec, bit_period_ms));
        reply(SMsg::MappingStarted(started))
    }

    fn configure(&mut self, m: &pb::Configure, now_ms: f64) -> pb::ServerMessage {
        let Some(active) = self.active else {
            return error("no_session", "configure requires an active capture session");
        };
        let options = m.r#options();
        let led_count = options
            .and_then(|o| o.r#led_count().copied())
            .unwrap_or(active.spec.led_count as i32);
        if led_count < 1 {
            return error("bad_message", "ledCount must be >= 1");
        }
        let symbols = match options.and_then(|o| o.r#symbols().copied()) {
            None => active.spec.symbols,
            Some(2) => 2,
            Some(4) => 4,
            Some(_) => return error("bad_message", "symbols must be 2 or 4"),
        };
        let bit_period_ms = options
            .and_then(|o| o.r#bit_period_ms().copied())
            .unwrap_or(active.bit_period_ms);
        if !(bit_period_ms > 0.0) {
            return error("bad_message", "bitPeriodMs must be > 0");
        }
        let spec = CodeSpec::derive(led_count as u32, symbols, true);
        self.active = Some(ActiveCapture {
            epoch_ms: now_ms,
            spec,
            bit_period_ms,
        });
        self.pattern_state()
    }

    fn stop_mapping(&mut self, m: &pb::StopMapping) -> pb::ServerMessage {
        if self.active.is_none() {
            return error("no_session", "no active capture session");
        }
        // solveOnHost unset/true asks for a host solve; this player has no
        // solver (its welcome carries no solverBenchMs), so that is a phone
        // placement bug — refuse loudly and keep the capture running.
        if m.r#solve_on_host().copied() != Some(false) {
            return error("unsupported", "no solver on this player; stop with solveOnHost=false");
        }
        self.active = None;
        // This player persists no detection/IMU log; the counts echo that.
        let mut stopped = pb::MappingStopped::default();
        stopped.r#detections = 0;
        stopped.r#imu_samples = 0;
        reply(SMsg::MappingStopped(stopped))
    }

    fn pattern_state(&self) -> pb::ServerMessage {
        let mut state = pb::PatternState::default();
        match self.active {
            Some(active) => {
                state.r#active = true;
                state.set_pattern_clock_epoch(active.epoch_ms);
                state.set_code_params(code_params_msg(&active.spec, active.bit_period_ms));
            }
            None => {
                state.r#active = false;
                let spec = CodeSpec::derive(self.default_led_count, DEFAULT_SYMBOLS, true);
                state.set_code_params(code_params_msg(&spec, DEFAULT_BIT_PERIOD_MS));
            }
        }
        reply(SMsg::PatternState(state))
    }

    // -- counting / config ------------------------------------------------

    fn set_counting_pattern(
        &mut self,
        m: pb::SetCountingPattern,
        now_ms: f64,
    ) -> pb::ServerMessage {
        let mut state = pb::CountingState::default();
        if m.r#blocks.is_empty() {
            self.counting = None;
            state.r#active = false;
        } else {
            state.r#active = true;
            state.set_epoch_ms(now_ms);
            self.counting = Some((now_ms, m));
        }
        reply(SMsg::CountingState(state))
    }

    fn set_led_count(&mut self, m: &pb::SetLedCount) -> pb::ServerMessage {
        let channel = m.r#channel().copied().unwrap_or(0);
        if channel < 0 || channel as usize >= MAX_CHANNELS || m.r#led_count < 0 {
            return error("bad_message", "channel or ledCount out of range");
        }
        self.led_counts[channel as usize] = Some(m.r#led_count as u32);
        if channel == 0 && m.r#led_count >= 1 {
            self.default_led_count = m.r#led_count as u32;
        }
        let mut state = pb::LedCountState::default();
        state.r#led_count = m.r#led_count;
        state.r#channel = channel;
        reply(SMsg::LedCountState(state))
    }

    fn playback_state(&self) -> pb::ServerMessage {
        // Playback engines land in Phase G; until then the truthful state is
        // "off", params at player defaults (an empty overlay).
        let mut state = pb::PlaybackState::default();
        state.r#active = false;
        state.r#effect = s64("off");
        state.set_params(pb::PlaybackParams::default());
        reply(SMsg::PlaybackState(state))
    }

    fn welcome(&self) -> pb::ServerMessage {
        let mut w = pb::Welcome::default();
        w.r#session_id = self.session_id.clone();
        let spec = CodeSpec::derive(self.default_led_count, DEFAULT_SYMBOLS, true);
        w.set_code_params(code_params_msg(&spec, DEFAULT_BIT_PERIOD_MS));
        // NO solver_bench_ms: chooseSolvePlacement(phone, null) == "phone".
        reply(SMsg::Welcome(w))
    }

    // -- output-driver hooks ------------------------------------------------

    /// The color LED `led` shows in mapping-pattern cycle frame
    /// `frame_index` (callers reduce the running frame counter modulo
    /// `cycle_frames`); None when no capture is active.
    pub fn pattern_color(&self, led: u32, frame_index: u32) -> Option<Rgb> {
        let active = self.active.as_ref()?;
        Some(color_for_frame(led, frame_index, &active.spec))
    }

    /// The color LED `led` shows under the latched counting pattern: blocks
    /// paint [start, start+count), everything else is off. Painting past the
    /// physical strip end is expected — that IS the length probe.
    pub fn counting_color(&self, led: u32) -> Option<Rgb> {
        let (_, pattern) = self.counting.as_ref()?;
        let mut color = (0, 0, 0);
        for block in pattern.r#blocks.iter() {
            let start = block.r#start.max(0) as u32;
            let count = block.r#count.max(0) as u32;
            if led >= start && led < start + count {
                let ch = |i: usize| -> u8 {
                    let v = block.r#rgb.get(i).copied().unwrap_or(0.0);
                    (v.clamp(0.0, 1.0) * 255.0 + 0.5) as u8
                };
                color = (ch(0), ch(1), ch(2));
            }
        }
        Some(color)
    }

    /// Pattern clock epoch of the active capture, if any.
    pub fn pattern_epoch_ms(&self) -> Option<f64> {
        self.active.as_ref().map(|a| a.epoch_ms)
    }

    /// Timing of the active mapping pattern, for the output driver's frame
    /// loop: `(pattern_clock_epoch_ms, bit_period_ms, cycle_frames,
    /// led_count)`. Frame index at player-clock `t` is
    /// `((t - epoch) / bit_period) % cycle_frames`.
    pub fn pattern_timing(&self) -> Option<(f64, f64, u32, u32)> {
        self.active
            .as_ref()
            .map(|a| (a.epoch_ms, a.bit_period_ms, a.spec.cycle_frames, a.spec.led_count))
    }

    /// The persisted strip length for `channel` (set_led_count).
    pub fn led_count(&self, channel: usize) -> Option<u32> {
        self.led_counts.get(channel).copied().flatten()
    }

    // -- arena-upload integration (Phase 3) ---------------------------------
    // The transport routes the upload arms (ledmapper_store::ARM_SUBMIT_MAP /
    // ARM_SUBMIT_TOPOLOGY, peeked with envelope_arm) through the arena
    // decoder instead of handle(), so the generated envelope's inline
    // heapless capacity never has to fit an upload. These produce the
    // protocol replies for that path.

    /// A map upload decoded into the arena: record it and ack result_ready.
    pub fn map_stored(&mut self, map_id: &str) -> pb::ServerMessage {
        self.stored_map_id = Some(s64(map_id));
        let mut r = pb::ResultReady::default();
        r.r#map_id = s64(map_id);
        reply(SMsg::ResultReady(r))
    }

    /// A topology upload decoded into the arena: ack against the stored map
    /// (mirrors the generated-path submit_topology semantics).
    pub fn topology_stored(&mut self, map_id: &str) -> pb::ServerMessage {
        if self.stored_map_id.as_deref() != Some(map_id) {
            return error("unknown_map", "no stored map for this topology");
        }
        let mut r = pb::ResultReady::default();
        r.r#map_id = s64(map_id);
        reply(SMsg::ResultReady(r))
    }
}

/// Bounded reply for an upload that exceeded the arena (StoreError::
/// ArenaFull): the phone learns the fixture is too large for this player.
pub fn upload_too_large() -> pb::ServerMessage {
    error("map_too_large", "upload exceeds this player's storage arena")
}

/// Bounded reply for an upload that violated the wire contract.
pub fn upload_malformed() -> pb::ServerMessage {
    error("bad_message", "upload violates the map/topology contract")
}

/// pb CodeParams from a derived spec (mirrors codebook.py code_params_for;
/// the derivation itself lives in ledmapper_pattern so the pattern generator
/// and the advertised code-book cannot disagree).
pub fn code_params_msg(spec: &CodeSpec, bit_period_ms: f64) -> pb::CodeParams {
    let mut cp = pb::CodeParams::default();
    cp.r#led_count = spec.led_count as i32;
    cp.r#bits = spec.bits as i32;
    cp.r#encoding = s64("hue");
    cp.r#bit_period_ms = bit_period_ms;
    cp.r#sync_pattern = s64("on_off");
    cp.r#cycle_frames = spec.cycle_frames as i32;
    cp.r#fec = s64(if spec.secded { "secded" } else { "none" });
    cp.r#symbols = spec.symbols as i32;
    cp
}

fn reply(msg: SMsg) -> pb::ServerMessage {
    pb::ServerMessage { r#msg: Some(msg) }
}

fn error(code: &str, message: &str) -> pb::ServerMessage {
    let mut e = pb::Error::default();
    e.r#code = s64(code);
    e.r#message = {
        let mut m = micropb::heapless::String::new();
        let _ = m.push_str(message);
        m
    };
    reply(SMsg::Error(e))
}
