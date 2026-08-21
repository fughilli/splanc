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
use ledmapper_pulse::{Effect, EffectConfig};
use ledmapper_pb::ledmapper_::v1_ as pb;
use pb::ClientMessage_::Msg as CMsg;
use pb::ServerMessage_::Msg as SMsg;

/// design doc §12 default: frame period >= ~3 camera frame intervals.
pub const DEFAULT_BIT_PERIOD_MS: f64 = 100.0;
/// Robust fallback alphabet; the client negotiates 4 when its SNR allows.
pub const DEFAULT_SYMBOLS: u8 = 2;
/// Output channels a player may drive (the C6 has plenty of RMT channels).
pub const MAX_CHANNELS: usize = 8;

/// Rendered-frame timing ring-buffer depth. Holds recent frames until the
/// phone polls (get_frame_timing); at 100 ms/frame that is ~13 s of history,
/// far more than the phone's poll interval, so overflow only happens when the
/// phone is not draining (and then `dropped` records it).
const FRAME_LOG_CAP: usize = 128;

/// Ring buffer of recently rendered mapping-pattern frames. The output driver
/// appends one `(seq, monotonic-clock)` sample per frame it pushes to the
/// LEDs; get_frame_timing drains it. On overflow the oldest sample is dropped
/// and `dropped` counts it, so a phone that fell behind learns its history
/// has gaps rather than reading stale data.
struct FrameLog {
    seq: [u32; FRAME_LOG_CAP],
    // Microseconds (raw micros()), integer — no f64 on the render hot path.
    t_us: [u32; FRAME_LOG_CAP],
    head: usize,
    len: usize,
    dropped: u32,
}

impl FrameLog {
    const fn new() -> Self {
        FrameLog {
            seq: [0; FRAME_LOG_CAP],
            t_us: [0; FRAME_LOG_CAP],
            head: 0,
            len: 0,
            dropped: 0,
        }
    }

    fn push(&mut self, seq: u32, t_us: u32) {
        let tail = (self.head + self.len) % FRAME_LOG_CAP;
        self.seq[tail] = seq;
        self.t_us[tail] = t_us;
        if self.len == FRAME_LOG_CAP {
            self.head = (self.head + 1) % FRAME_LOG_CAP; // overwrite oldest
            self.dropped = self.dropped.saturating_add(1);
        } else {
            self.len += 1;
        }
    }

    fn pop(&mut self) -> Option<(u32, u32)> {
        if self.len == 0 {
            return None;
        }
        let s = self.seq[self.head];
        let t = self.t_us[self.head];
        self.head = (self.head + 1) % FRAME_LOG_CAP;
        self.len -= 1;
        Some((s, t))
    }
}

type Str64 = micropb::heapless::String<64>;

fn s64(s: &str) -> Str64 {
    let mut out = Str64::new();
    // Protocol strings are short by contract; truncation would be a bug in
    // OUR constants, not remote input.
    let _ = out.push_str(s);
    out
}

/// Fixed-point brightness at full scale (Q8: 256 == 1.0). The phone-facing
/// brightness is [0,1]; we carry it as an integer so the per-LED scale in the
/// render loop is an integer multiply+shift, not an f64 multiply (the C6's
/// RISC-V FPU is single-precision only, so f64 ops are software-emulated).
const BRIGHTNESS_ONE_Q8: u16 = 256;

/// The active capture, in the INTEGER forms the render hot path needs (see
/// the module note on f64 cost). The wire is milliseconds/[0,1] doubles; those
/// are reconstructed only at the cold encode boundary (`bit_period_ms()` /
/// `brightness()`), never in the frame loop.
#[derive(Debug, Clone, Copy)]
struct ActiveCapture {
    /// Player-clock epoch (integer milliseconds; the clock is millis()).
    epoch_ms: i64,
    spec: CodeSpec,
    /// Frame period in MICROSECONDS — integer so the frame-index division in
    /// the render loop stays integer even for fractional-ms periods.
    bit_period_us: u32,
    /// LED brightness as Q8 fixed-point in [0, 256] (256 == full); servoed by
    /// the phone against its measured bloom/wash-out (§7.1).
    brightness_q8: u16,
}

impl ActiveCapture {
    /// Wire brightness in [0,1] (cold: only for encoding CodeParams).
    fn brightness(&self) -> f64 {
        self.brightness_q8 as f64 / BRIGHTNESS_ONE_Q8 as f64
    }
    /// Wire bit period in ms (cold: only for encoding CodeParams).
    fn bit_period_ms(&self) -> f64 {
        self.bit_period_us as f64 / 1000.0
    }
}

/// Parse the wire brightness ([0,1] double) into Q8 fixed-point, rounding to
/// the nearest step. Cold (once per start/configure).
fn brightness_to_q8(v: f64) -> u16 {
    let q = (v * BRIGHTNESS_ONE_Q8 as f64 + 0.5) as i32;
    q.clamp(0, BRIGHTNESS_ONE_Q8 as i32) as u16
}

/// Counting-pattern block capacity (matches SetCountingPattern.blocks in the
/// firmware micropb profile, //shared/protocol/rust:gen_main.rs).
const MAX_COUNTING_BLOCKS: usize = 32;

/// A counting-pattern block with its color pre-reduced to 8-bit RGB. The wire
/// carries [0,1] doubles; we convert them ONCE here (cold, at set time) so
/// `counting_color` — polled per-LED on every render pass — is pure integer.
#[derive(Clone, Copy, Default)]
struct CountingBlock {
    start: u32,
    count: u32,
    rgb: Rgb,
}

type CountingBlocks = micropb::heapless::Vec<CountingBlock, MAX_COUNTING_BLOCKS>;

/// Per-channel color-correction profile. The firmware turns this into 3x256
/// LUTs (gamma curve + white balance to the dimmest channel) it applies on the
/// strip write path, so LEDs render with proper contrast instead of washed out.
/// `luminance` is a relative datasheet figure (mcd) — only the ratios matter.
#[derive(Clone, Copy)]
struct ColorCorrection {
    gamma: [f32; 3],
    luminance: [f32; 3],
}

impl ColorCorrection {
    /// WS2812B datasheet defaults: gamma 2.8, per-channel luminance R/G/B taken
    /// at the middle of the datasheet's min..max bins (mcd).
    const WS2812B: ColorCorrection = ColorCorrection {
        gamma: [2.8, 2.8, 2.8],
        luminance: [625.0, 1250.0, 300.0],
    };
}

/// Resolve a `set_color_correction` request to a concrete profile: a recognized
/// `profile` name wins outright; otherwise start from the WS2812B default and
/// override whichever explicit per-channel fields are present.
fn color_correction_from(m: &pb::SetColorCorrection) -> ColorCorrection {
    if let Some(p) = m.r#profile() {
        match p.as_str() {
            "ws2812" | "ws2812b" => return ColorCorrection::WS2812B,
            _ => {}
        }
    }
    let mut cc = ColorCorrection::WS2812B;
    if let Some(&v) = m.r#gamma_r() {
        cc.gamma[0] = v;
    }
    if let Some(&v) = m.r#gamma_g() {
        cc.gamma[1] = v;
    }
    if let Some(&v) = m.r#gamma_b() {
        cc.gamma[2] = v;
    }
    if let Some(&v) = m.r#lum_r() {
        cc.luminance[0] = v;
    }
    if let Some(&v) = m.r#lum_g() {
        cc.luminance[1] = v;
    }
    if let Some(&v) = m.r#lum_b() {
        cc.luminance[2] = v;
    }
    cc
}

/// The protocol session core. One per WSS connection (like the Pi's
/// ConnectionHandler), with the persisted bits (led_counts, stored map)
/// living for the player's lifetime in the real firmware.
pub struct Player {
    session_id: Str64,
    /// Stable hardware MAC + current display/BLE name, set by the firmware via
    /// [`Player::set_identity`] and echoed in every `welcome`. `set_device_name`
    /// updates `device_name` in place (the firmware persists it + renames BLE).
    mac: Str64,
    device_name: Str64,
    /// Git commit the firmware was built from (full hash) + whether the tree was
    /// dirty, set once by the firmware via [`Player::set_build_info`] (it owns the
    /// stamped `build_info.h`) and echoed in every `welcome`. Empty/false until set.
    fw_git_commit: Str64,
    fw_git_dirty: bool,
    default_led_count: u32,
    active: Option<ActiveCapture>,
    counting: Option<(i64, CountingBlocks)>,
    led_counts: [Option<u32>; MAX_CHANNELS],
    stored_map_id: Option<Str64>,
    frame_log: FrameLog,
    /// Active playback effect: the sim config (integer, for the hot path) + the
    /// wire params it was built from (to echo). None = "off".
    playback: Option<(EffectConfig, pb::PlaybackParams)>,
    /// Bumped on every set_playback so the render side can rebuild its sim when
    /// the effect/params change.
    playback_gen: u32,
    /// Active color-correction profile + a generation the firmware polls (like
    /// set_device_name) to regenerate and re-persist the flash LUT on a change.
    color_correction: ColorCorrection,
    color_correction_gen: u32,
    /// Whether the latest color-correction update should be committed to flash
    /// (true) or applied from RAM only (false, live preview) — see the `commit`
    /// field on `set_color_correction`.
    color_correction_commit: bool,
    /// Global output brightness in 0.0..=1.0 applied to every rendered LED just
    /// before the strip write (1.0 = unattenuated). RUNTIME-ONLY (not persisted):
    /// a reboot returns to 1.0, so a device can never get stuck dark. Set by
    /// `set_brightness` — a user master dimmer and the perf-measurement blanking
    /// hook. The firmware polls `output_brightness_gen` to notice a change.
    output_brightness: f32,
    output_brightness_gen: u32,
}

impl Player {
    pub fn new(session_id: &str, default_led_count: u32) -> Self {
        Player {
            session_id: s64(session_id),
            mac: Str64::new(),
            device_name: Str64::new(),
            fw_git_commit: Str64::new(),
            fw_git_dirty: false,
            default_led_count,
            active: None,
            counting: None,
            led_counts: [None; MAX_CHANNELS],
            stored_map_id: None,
            frame_log: FrameLog::new(),
            playback: None,
            playback_gen: 0,
            color_correction: ColorCorrection::WS2812B,
            color_correction_gen: 0,
            color_correction_commit: true,
            output_brightness: 1.0,
            output_brightness_gen: 0,
        }
    }

    /// Handle one client message. `recv_ms`/`send_ms` are the player-clock
    /// receive and reply timestamps, INTEGER milliseconds (the player clock is
    /// millis()). §7.3 time sync needs both; everything else uses `send_ms` as
    /// "now". Returns the reply, or None for fire-and-forget arms.
    pub fn handle(
        &mut self,
        req: pb::ClientMessage,
        recv_ms: i64,
        send_ms: i64,
    ) -> Option<pb::ServerMessage> {
        let Some(msg) = req.r#msg else {
            return Some(error("bad_message", "envelope has no message set"));
        };
        match msg {
            CMsg::Hello(_) => Some(self.welcome()),
            CMsg::TimeSyncPing(p) => {
                let mut pong = pb::TimeSyncPong::default();
                // t0 is the phone clock (fractional, epoch-scale ms) — echoed
                // verbatim as f64; float32 could not hold it (this is the one
                // place double is genuinely required). t1/t2 are the player's
                // integer clock, widened only here at the wire boundary.
                pong.r#t0 = p.r#t0;
                pong.r#t1 = recv_ms as f64;
                pong.r#t2 = send_ms as f64;
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
                let effect = match m.r#effect.as_str() {
                    "off" => Some(None),
                    "pulse" => Some(Some(Effect::Pulse)),
                    "flood" => Some(Some(Effect::Flood)),
                    _ => None,
                };
                match effect {
                    Some(None) => {
                        self.playback = None;
                        self.playback_gen = self.playback_gen.wrapping_add(1);
                        Some(self.playback_state())
                    }
                    Some(Some(e)) => {
                        let params = m.r#params.clone();
                        self.playback = Some((effect_config_from(e, &params), params));
                        self.playback_gen = self.playback_gen.wrapping_add(1);
                        Some(self.playback_state())
                    }
                    None => Some(error(
                        "unsupported_effect",
                        "effect not available on this player (supported: off, pulse, flood)",
                    )),
                }
            }
            CMsg::GetPlayback(_) => Some(self.playback_state()),
            CMsg::GetFrameTiming(_) => Some(self.frame_timing()),
            // The map dump lives in the arena layer (ffi), which intercepts this
            // arm before the session core ever sees it; unreachable here.
            CMsg::GetStoredMap(_) => Some(error("unsupported", "map dump handled by the arena layer")),
            // Sharded uploads are reassembled + decoded by the transport/arena
            // layer, which intercepts this arm before the core sees it.
            CMsg::UploadChunk(_) => Some(error("unsupported", "upload_chunk handled by the transport")),
            // Effects arms are intercepted by the fx layer (ffi) before the
            // session core sees them (the firmware profile can't decode a full
            // .fxb / uniform set); unreachable here.
            // Rename: update the in-core name and reply welcome (echoing it).
            // The firmware notices this arm, persists the name, and renames the
            // BLE advertisement.
            CMsg::SetDeviceName(m) => {
                self.device_name = s64(m.r#name.as_str());
                Some(self.welcome())
            }
            // Color correction: store the resolved profile and bump the gen. The
            // firmware notices the change (like the rename above), regenerates the
            // per-channel LUTs, and persists them to flash.
            CMsg::SetColorCorrection(m) => {
                self.color_correction = color_correction_from(&m);
                // Unset commit defaults to true (persist); a live-preview stream
                // sends commit=false to stay in RAM until the UI settles.
                self.color_correction_commit = m.r#commit().copied().unwrap_or(true);
                self.color_correction_gen = self.color_correction_gen.wrapping_add(1);
                Some(self.welcome())
            }
            // Global output brightness: store the clamped scale and bump the gen.
            // The firmware polls the gen (like color correction) to apply it to
            // the strip write. Runtime-only, so nothing is persisted.
            CMsg::SetBrightness(m) => {
                self.output_brightness = (m.r#brightness as f32).clamp(0.0, 1.0);
                self.output_brightness_gen = self.output_brightness_gen.wrapping_add(1);
                Some(self.welcome())
            }
            CMsg::SubmitEffect(_)
            | CMsg::SetEffect(_)
            | CMsg::SetUniforms(_)
            | CMsg::GetEffectUniforms(_) => {
                Some(error("unsupported", "effects handled by the fx layer"))
            }
            // Fire-and-forget: Pi-profile telemetry, set_texture (a video frame),
            // and set_jit (the JIT debug/bench toggle) — all handled by the fx
            // layer before they reach here. Dropped.
            CMsg::Detections(_)
            | CMsg::ImuBatch(_)
            | CMsg::ExposureReport(_)
            | CMsg::SetTexture(_)
            | CMsg::SetJit(_) => None,
            // Pi-only REQUEST arms: bounded unsupported error.
            CMsg::GetStatus(_) | CMsg::GetLiveMap(_) | CMsg::GetSolveStatus(_) => {
                Some(error("unsupported", "not available on this player profile"))
            }
            // Perf-monitoring arms: not implemented on this player yet.
            CMsg::SetPerf(_) | CMsg::GetPerfReport(_) => {
                Some(error("unsupported", "perf monitoring not available on this player"))
            }
            // set_fps is intercepted by the fx/autoscaler layer (ffi) before the
            // session core sees it; unreachable here.
            CMsg::SetFps(_) => Some(error("unsupported", "fps handled by the autoscaler layer")),
        }
    }

    // -- capture ----------------------------------------------------------

    fn start_mapping(&mut self, m: &pb::StartMapping, now_ms: i64) -> pb::ServerMessage {
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
        // Wire values (ms/[0,1] doubles) are validated here at the cold decode
        // boundary, then stored in integer/fixed-point form for the hot loop.
        let bit_period_ms = options
            .r#bit_period_ms()
            .copied()
            .unwrap_or(DEFAULT_BIT_PERIOD_MS);
        if !(bit_period_ms > 0.0) {
            return error("bad_message", "bitPeriodMs must be > 0");
        }
        let brightness = options.r#brightness().copied().unwrap_or(1.0);
        if !(0.0..=1.0).contains(&brightness) {
            return error("bad_message", "brightness must be in [0, 1]");
        }
        let spec = CodeSpec::derive(led_count as u32, symbols, true);
        let active = ActiveCapture {
            epoch_ms: now_ms,
            spec,
            bit_period_us: (bit_period_ms * 1000.0 + 0.5) as u32,
            brightness_q8: brightness_to_q8(brightness),
        };
        self.active = Some(active);
        let mut started = pb::MappingStarted::default();
        started.r#pattern_clock_epoch = now_ms as f64;
        started.set_code_params(code_params_msg(&spec, active.bit_period_ms(), active.brightness()));
        reply(SMsg::MappingStarted(started))
    }

    fn configure(&mut self, m: &pb::Configure, now_ms: i64) -> pb::ServerMessage {
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
            .unwrap_or(active.bit_period_ms());
        if !(bit_period_ms > 0.0) {
            return error("bad_message", "bitPeriodMs must be > 0");
        }
        let brightness = options
            .and_then(|o| o.r#brightness().copied())
            .unwrap_or(active.brightness());
        if !(0.0..=1.0).contains(&brightness) {
            return error("bad_message", "brightness must be in [0, 1]");
        }
        let spec = CodeSpec::derive(led_count as u32, symbols, true);
        self.active = Some(ActiveCapture {
            epoch_ms: now_ms,
            spec,
            bit_period_us: (bit_period_ms * 1000.0 + 0.5) as u32,
            brightness_q8: brightness_to_q8(brightness),
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
                state.set_pattern_clock_epoch(active.epoch_ms as f64);
                state.set_code_params(code_params_msg(
                    &active.spec,
                    active.bit_period_ms(),
                    active.brightness(),
                ));
            }
            None => {
                state.r#active = false;
                let spec = CodeSpec::derive(self.default_led_count, DEFAULT_SYMBOLS, true);
                state.set_code_params(code_params_msg(&spec, DEFAULT_BIT_PERIOD_MS, 1.0));
            }
        }
        reply(SMsg::PatternState(state))
    }

    // -- counting / config ------------------------------------------------

    fn set_counting_pattern(
        &mut self,
        m: pb::SetCountingPattern,
        now_ms: i64,
    ) -> pb::ServerMessage {
        let mut state = pb::CountingState::default();
        if m.r#blocks.is_empty() {
            self.counting = None;
            state.r#active = false;
        } else {
            state.r#active = true;
            state.set_epoch_ms(now_ms as f64); // integer clock → wire ms double
            // Pre-reduce each block's [0,1] wire color to 8-bit RGB now (cold),
            // so the per-LED counting_color polled every render pass is integer.
            let mut blocks = CountingBlocks::new();
            for b in m.r#blocks.iter() {
                let ch = |i: usize| -> u8 {
                    let v = b.r#rgb.get(i).copied().unwrap_or(0.0);
                    (v.clamp(0.0, 1.0) * 255.0 + 0.5) as u8
                };
                // blocks capacity == the wire block cap, so push cannot fail.
                let _ = blocks.push(CountingBlock {
                    start: b.r#start.max(0) as u32,
                    count: b.r#count.max(0) as u32,
                    rgb: (ch(0), ch(1), ch(2)),
                });
            }
            self.counting = Some((now_ms, blocks));
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

    /// Drain the rendered-frame timing log into a FrameTiming reply. Reports
    /// the active capture's context (epoch/period/cycle) so the phone can
    /// compute expected-vs-actual emit times without a second lookup, the
    /// overflow `dropped` count since the last poll, and as many buffered
    /// ticks as fit the reply's capacity (the rest stay for the next poll).
    fn frame_timing(&mut self) -> pb::ServerMessage {
        let mut ft = pb::FrameTiming::default();
        if let Some(active) = self.active.as_ref() {
            ft.set_pattern_clock_epoch_ms(active.epoch_ms as u32);
            ft.r#bit_period_us = active.bit_period_us;
            ft.r#cycle_frames = active.spec.cycle_frames;
        }
        ft.r#dropped = self.frame_log.dropped;
        self.frame_log.dropped = 0;
        // Drain oldest-first until the FrameTick vector is at capacity; any
        // remaining samples are NOT dropped, they wait for the next poll.
        while !ft.r#ticks.is_full() {
            let Some((seq, t_us)) = self.frame_log.pop() else {
                break;
            };
            let mut tick = pb::FrameTick::default();
            tick.r#seq = seq;
            tick.r#t_mono_us = t_us;
            // is_full() was just checked, so this push cannot fail.
            let _ = ft.r#ticks.push(tick);
        }
        reply(SMsg::FrameTiming(ft))
    }

    /// The current playback selection as a `playback_state` reply. Public so
    /// the effects arms (ffi.rs) can ack set_effect / set_uniforms with the
    /// session's playback state (keeping the app's playback UI consistent).
    pub fn playback_reply(&self) -> pb::ServerMessage {
        self.playback_state()
    }

    fn playback_state(&self) -> pb::ServerMessage {
        let mut state = pb::PlaybackState::default();
        match self.playback.as_ref() {
            Some((cfg, params)) => {
                state.r#active = true;
                state.r#effect = s64(match cfg.effect {
                    Effect::Pulse => "pulse",
                    Effect::Flood => "flood",
                });
                state.set_params(params.clone());
            }
            None => {
                state.r#active = false;
                state.r#effect = s64("off");
                state.set_params(pb::PlaybackParams::default());
            }
        }
        reply(SMsg::PlaybackState(state))
    }

    /// Set the player identity echoed in `welcome` (called once at init by the
    /// firmware, which owns the MAC read + persisted name).
    pub fn set_identity(&mut self, mac: &str, device_name: &str) {
        self.mac = s64(mac);
        self.device_name = s64(device_name);
    }

    /// Set the firmware build info echoed in `welcome` (called once at init by the
    /// firmware, which owns the stamped `build_info.h`). `commit` is the full git
    /// hash; `dirty` marks an uncommitted working tree at build time.
    pub fn set_build_info(&mut self, commit: &str, dirty: bool) {
        self.fw_git_commit = s64(commit);
        self.fw_git_dirty = dirty;
    }

    /// The player's current display name (after any `set_device_name`), so the
    /// firmware can persist it + rename the BLE advertisement.
    pub fn device_name(&self) -> &str {
        self.device_name.as_str()
    }

    /// Generation counter bumped on every `set_color_correction`; the firmware
    /// polls it (like the device name) to notice a profile change.
    pub fn color_correction_gen(&self) -> u32 {
        self.color_correction_gen
    }

    /// The active color-correction profile as `(gamma, luminance)` per channel,
    /// which the firmware turns into the flash LUTs.
    pub fn color_correction(&self) -> ([f32; 3], [f32; 3]) {
        (self.color_correction.gamma, self.color_correction.luminance)
    }

    /// Whether the latest color-correction update should be committed to flash
    /// (true) or applied from RAM only (false — live preview).
    pub fn color_correction_commit(&self) -> bool {
        self.color_correction_commit
    }

    /// Generation counter bumped on every `set_brightness`; the firmware polls it
    /// (like color correction) to notice a change to the global output scale.
    pub fn output_brightness_gen(&self) -> u32 {
        self.output_brightness_gen
    }

    /// The active global output brightness in 0.0..=1.0 (1.0 = unattenuated).
    pub fn output_brightness(&self) -> f32 {
        self.output_brightness
    }

    fn welcome(&self) -> pb::ServerMessage {
        let mut w = pb::Welcome::default();
        w.r#session_id = self.session_id.clone();
        w.r#mac = self.mac.clone();
        w.r#device_name = self.device_name.clone();
        w.r#fw_git_commit = self.fw_git_commit.clone();
        w.r#fw_git_dirty = self.fw_git_dirty;
        w.set_brightness(self.output_brightness as f64);
        let spec = CodeSpec::derive(self.default_led_count, DEFAULT_SYMBOLS, true);
        w.set_code_params(code_params_msg(&spec, DEFAULT_BIT_PERIOD_MS, 1.0));
        // NO solver_bench_ms: chooseSolvePlacement(phone, null) == "phone".
        reply(SMsg::Welcome(w))
    }

    // -- output-driver hooks ------------------------------------------------

    /// The color LED `led` shows in mapping-pattern cycle frame
    /// `frame_index` (callers reduce the running frame counter modulo
    /// `cycle_frames`); None when no capture is active. Scaled by the
    /// phone-servoed capture brightness — hue is the carrier, so a uniform
    /// scale changes nothing the decoder reads (it normalizes against each
    /// track's own white frame).
    pub fn pattern_color(&self, led: u32, frame_index: u32) -> Option<Rgb> {
        let active = self.active.as_ref()?;
        let (r, g, b) = color_for_frame(led, frame_index, &active.spec);
        // Integer Q8 scale (v * q8 / 256, rounded) — no f64 in the per-LED,
        // per-frame hot path. q8 == 256 is exact identity.
        let q8 = active.brightness_q8 as u32;
        let scale = |v: u8| -> u8 { ((v as u32 * q8 + 128) >> 8) as u8 };
        Some((scale(r), scale(g), scale(b)))
    }

    /// The highest LED index the latched counting pattern lights + 1 (the max of
    /// `start + count` over the blocks), or 0 when no pattern is latched. The
    /// output driver transmits exactly this many LEDs for the calibration pattern
    /// rather than the whole render buffer.
    pub fn counting_len(&self) -> u32 {
        let Some((_, blocks)) = self.counting.as_ref() else {
            return 0;
        };
        blocks.iter().map(|b| b.start + b.count).max().unwrap_or(0)
    }

    /// The color LED `led` shows under the latched counting pattern: blocks
    /// paint [start, start+count), everything else is off. Painting past the
    /// physical strip end is expected — that IS the length probe.
    pub fn counting_color(&self, led: u32) -> Option<Rgb> {
        let (_, blocks) = self.counting.as_ref()?;
        let mut color = (0, 0, 0);
        for block in blocks.iter() {
            // Later blocks win on overlap (matches the wire-order semantics).
            if led >= block.start && led < block.start + block.count {
                color = block.rgb;
            }
        }
        Some(color)
    }

    /// Record that the output driver just pushed mapping-pattern frame `seq`
    /// (the absolute frame index since the pattern epoch, BEFORE the
    /// cycle-length modulo) to the LEDs at player monotonic clock `t_us`
    /// (raw micros(), integer). Buffered until the phone polls
    /// get_frame_timing; on overflow the oldest sample is dropped (and
    /// counted). Cheap (a ring write) so the frame loop can call it
    /// unconditionally.
    pub fn record_frame_shown(&mut self, seq: u32, t_us: u32) {
        self.frame_log.push(seq, t_us);
    }

    /// The active effect-playback config, or None when playback is "off". The
    /// render loop feeds it (plus the stored topology) to a `Sim` that it steps
    /// each frame and samples per LED via its (segment, foot arclength, dPerp).
    pub fn effect_config(&self) -> Option<&EffectConfig> {
        self.playback.as_ref().map(|(cfg, _)| cfg)
    }

    /// Monotonic counter bumped on every SetPlayback; the render side rebuilds
    /// its `Sim` when this changes.
    pub fn playback_gen(&self) -> u32 {
        self.playback_gen
    }

    /// Pattern clock epoch of the active capture, if any (integer ms).
    pub fn pattern_epoch_ms(&self) -> Option<i64> {
        self.active.as_ref().map(|a| a.epoch_ms)
    }

    /// Timing of the active mapping pattern, for the output driver's frame
    /// loop, all INTEGER: `(epoch_ms, bit_period_us, cycle_frames,
    /// led_count)`. Absolute frame index at player-clock ms `t` is
    /// `((t - epoch_ms) * 1000) / bit_period_us`; the render frame is that
    /// modulo `cycle_frames`. Integer throughout so the frame loop touches no
    /// f64.
    pub fn pattern_timing(&self) -> Option<(i64, u32, u32, u32)> {
        self.active
            .as_ref()
            .map(|a| (a.epoch_ms, a.bit_period_us, a.spec.cycle_frames, a.spec.led_count))
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
/// Build the fixed-point EffectConfig from the wire PlaybackParams. Decoding
/// the wire doubles here is COLD (once per set_playback); the derivation itself
/// lives in ledmapper_pulse::EffectConfig::from_wire so the player and the host
/// WASM preview share one source of truth. Optional knobs unset → sensible
/// defaults (lead/decay derive from glow; split → the default fork rate).
fn effect_config_from(effect: Effect, p: &pb::PlaybackParams) -> EffectConfig {
    EffectConfig::from_wire(
        effect,
        p.r#intensity().copied().unwrap_or(1.0) as f32,
        p.r#glow_radius().copied().unwrap_or(0.15) as f32,
        p.r#speed().copied().unwrap_or(0.5) as f32,
        p.r#agent_count().copied().unwrap_or(2).max(0) as u32,
        p.r#lead_in().copied().unwrap_or(0.0) as f32,
        p.r#split_prob().map(|v| *v as f32).unwrap_or(-1.0),
        p.r#decay().copied().unwrap_or(0.0) as f32,
        &p.r#palette,
    )
}

pub fn code_params_msg(spec: &CodeSpec, bit_period_ms: f64, brightness: f64) -> pb::CodeParams {
    let mut cp = pb::CodeParams::default();
    cp.r#led_count = spec.led_count as i32;
    cp.r#bits = spec.bits as i32;
    cp.r#encoding = s64("hue");
    cp.r#bit_period_ms = bit_period_ms;
    cp.r#sync_pattern = s64("on_off");
    cp.r#cycle_frames = spec.cycle_frames as i32;
    cp.r#fec = s64(if spec.secded { "secded" } else { "none" });
    cp.r#symbols = spec.symbols as i32;
    // Wire contract: unset means 1.0 — only a servoed-down level is echoed.
    if brightness < 1.0 {
        cp.set_brightness(brightness);
    }
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
