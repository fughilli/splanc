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

use ledmapper_pattern::{color_for_frame, stride_lit, CodeSpec, Rgb};
use ledmapper_pb::ledmapper_::v1_ as pb;
use ledmapper_view::ledmapper::v1 as pv;
use pb::ServerMessage_::Msg as SMsg;
use pv::client_message::Msg as CMsg;

/// design doc §12 default: frame period >= ~3 camera frame intervals.
pub const DEFAULT_BIT_PERIOD_MS: f64 = 100.0;
/// A group capture's epoch must be within this of the player clock (ms).
const MAX_EPOCH_SKEW_MS: f64 = 600_000.0;
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

/// A wire string as a Str64, or None if it doesn't fit (the by-value decode
/// this replaced refused such a frame outright).
fn str64(s: &str) -> Option<Str64> {
    let mut out = Str64::new();
    out.push_str(s).ok()?;
    Some(out)
}

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
    /// Diffuse-capture striding (design: diffuse_capture). `<= 1` = disabled
    /// (every LED lit, the legacy pattern). Otherwise only the `stride_phase`
    /// subset lights, ≥ `stride_spacing` LEDs apart; the phone rotates the phase
    /// across epochs (each Configure restamps the epoch). See `stride_lit`.
    stride_spacing: u32,
    anchor_density: u32,
    stride_phase: u32,
    /// PHYSICAL LEDs driven (the strip). Equals `spec.led_count` except in a
    /// group capture, where `spec` is derived from the group's shared code space.
    led_count: u32,
    /// Group capture: LED i transmits code-book id `i + code_offset` (0 = solo).
    code_offset: u32,
    /// Auto-stop deadline (player-clock ms; start_mapping + stop_after_ms), or
    /// None = run until stop_mapping. Checked by the frame loop (expire_pattern).
    stop_at_ms: Option<i64>,
}

/// Upper bound on a group capture's shared code space (ids): keeps the codeword
/// well inside u32 and the cycle short (2^12 ids = 13 data bits + SEC-DED).
pub const MAX_CODE_SPACE: u32 = 4096;

/// Group-capture code layout from the wire (feature "group_capture"):
/// `(code_offset, code_space)`, validated against the physical LED count.
fn parse_code_layout(
    led_count: u32,
    offset: Option<i32>,
    space: Option<i32>,
) -> Result<(u32, u32), pb::ServerMessage> {
    let offset = offset.unwrap_or(0);
    if offset < 0 {
        return Err(error("bad_message", "codeOffset must be >= 0"));
    }
    let offset = offset as u32;
    let need = offset.saturating_add(led_count);
    let space = match space {
        None => need,
        Some(v) if v < 1 => return Err(error("bad_message", "codeSpace must be >= 1")),
        Some(v) => v as u32,
    };
    if space < need {
        return Err(error("bad_message", "codeSpace must be >= codeOffset + ledCount"));
    }
    if space > MAX_CODE_SPACE {
        return Err(error("bad_message", "codeSpace too large"));
    }
    Ok((offset, space))
}

/// Echo the group layout onto a CodeParams reply (only for a group capture).
fn set_group_params(cp: &mut pb::CodeParams, active: &ActiveCapture) {
    if active.code_offset > 0 {
        cp.set_code_offset(active.code_offset as i32);
    }
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

/// Validate the wire stride triple (optional non-negative ints), filling `defaults`
/// for unset fields. `stride_spacing <= 1` means striding is off. Cold (once per
/// start/configure); the actual lit-mask math is `ledmapper_pattern::stride_lit`.
fn parse_stride(
    spacing: Option<i32>,
    anchor: Option<i32>,
    phase: Option<i32>,
    defaults: (i32, i32, i32),
) -> Result<(u32, u32, u32), pb::ServerMessage> {
    let spacing = spacing.unwrap_or(defaults.0);
    let anchor = anchor.unwrap_or(defaults.1);
    let phase = phase.unwrap_or(defaults.2);
    if spacing < 0 {
        return Err(error("bad_message", "strideSpacing must be >= 0"));
    }
    if anchor < 0 {
        return Err(error("bad_message", "anchorDensity must be >= 0"));
    }
    if phase < 0 {
        return Err(error("bad_message", "stridePhase must be >= 0"));
    }
    Ok((spacing as u32, anchor as u32, phase as u32))
}

/// Echo the active stride onto a CodeParams reply, only when striding is on
/// (unset fields mean "legacy all-lit" on the wire).
fn set_stride_params(cp: &mut pb::CodeParams, active: &ActiveCapture) {
    if active.stride_spacing > 1 {
        cp.set_stride_spacing(active.stride_spacing as i32);
        cp.set_anchor_density(active.anchor_density as i32);
        cp.set_stride_phase(active.stride_phase as i32);
    }
}

/// Counting-pattern block capacity the player stores. Matches the HOST wire cap
/// (SetCountingPattern.blocks); the firmware decodes that arm zero-copy (ffi.rs)
/// straight into this, so it is the real decode capacity, not the (stubbed)
/// firmware micropb profile.
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
fn color_correction_from(m: pv::SetColorCorrectionView<'_>) -> ColorCorrection {
    if let Some("ws2812" | "ws2812b") = m.profile() {
        return ColorCorrection::WS2812B;
    }
    let mut cc = ColorCorrection::WS2812B;
    for (i, v) in [m.gamma_r(), m.gamma_g(), m.gamma_b()].into_iter().enumerate() {
        if let Some(v) = v {
            cc.gamma[i] = v;
        }
    }
    for (i, v) in [m.lum_r(), m.lum_g(), m.lum_b()].into_iter().enumerate() {
        if let Some(v) = v {
            cc.luminance[i] = v;
        }
    }
    cc
}

/// Hardware output channels the player exposes to the Hardware Setup UI (the
/// two parallel RMT channels on the C6). Distinct from `MAX_CHANNELS` (the
/// logical set_led_count fan-out): only these carry a GPIO + color order.
pub const HW_CHANNELS: usize = 2;

/// The six wire color orders, each a permutation of "RGB". The `[u8; 3]` is the
/// SOURCE-INDEX permutation the driver applies: wire byte `i` carries logical
/// channel `perm[i]` of the R,G,B input (R=0, G=1, B=2). So "GRB" -> [1, 0, 2]
/// means wire = G,R,B — the WS2812B default. The strings double as the wire
/// values echoed to / accepted from the app.
pub const COLOR_ORDERS: [(&str, [u8; 3]); 6] = [
    ("RGB", [0, 1, 2]),
    ("RBG", [0, 2, 1]),
    ("GRB", [1, 0, 2]),
    ("GBR", [1, 2, 0]),
    ("BRG", [2, 0, 1]),
    ("BGR", [2, 1, 0]),
];
/// Default wire order index into [`COLOR_ORDERS`] — GRB, the WS2812B order.
pub const DEFAULT_COLOR_ORDER: u8 = 2;
/// The only LED chip family supported today (WS2811/2812/2812B/SK6812 clockless).
const LED_TYPE_WS281X: &str = "ws281x";

/// Match a wire color-order string to its [`COLOR_ORDERS`] index, case-insensitively.
pub fn color_order_index(s: &str) -> Option<u8> {
    COLOR_ORDERS
        .iter()
        .position(|(name, _)| name.eq_ignore_ascii_case(s))
        .map(|i| i as u8)
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
    /// dirty + the release version (nearest `firmware-v*` tag), set once by the
    /// firmware via [`Player::set_build_info`] (it owns the stamped `build_info.h`)
    /// and echoed in every `welcome`. Empty/false until set.
    fw_git_commit: Str64,
    fw_git_dirty: bool,
    fw_version: Str64,
    default_led_count: u32,
    active: Option<ActiveCapture>,
    counting: Option<(i64, CountingBlocks)>,
    /// Wire color order applied to the counting probe ONLY — a source-index
    /// permutation like [`COLOR_ORDERS`] (identity [0,1,2] = raw). Set per
    /// SetCountingPattern; kept out of the committed per-channel `hw_order` so
    /// the color-order test never mutates the persisted config.
    counting_order: [u8; 3],
    /// Hardware output channel the latched counting pattern paints (its block
    /// indices are relative to that channel's strip start). 0 when none latched.
    counting_channel: u8,
    led_counts: [Option<u32>; MAX_CHANNELS],
    stored_map_id: Option<Str64>,
    frame_log: FrameLog,
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
    /// Global FX deck crossfade: 0.0 (all deck A) .. 1.0 (all deck B), and the
    /// blend colour space (0 = linear RGB, 1 = HSV). RUNTIME-ONLY like brightness
    /// (a reboot returns to 0.0 / RGB); the fx layer latches it once per frame.
    crossfade: f32,
    crossfade_mode: u32,
    /// Per-channel hardware output config (GPIO + wire color order), configurable
    /// from the Hardware Setup page via `set_hardware_config` and reported by
    /// `hardware_config_state`. `hw_gpio[ch] < 0` means "not yet seeded" — the
    /// firmware calls [`Player::set_hw_defaults`] at boot with the pins it
    /// actually initialized so the echo is accurate. `hw_order` indexes
    /// [`COLOR_ORDERS`]. A `led_type` other than `ws281x` is rejected (only type
    /// supported today), so it is echoed as a constant rather than stored.
    hw_gpio: [i32; HW_CHANNELS],
    hw_order: [u8; HW_CHANNELS],
    /// Bumped on every `set_hardware_config`; the firmware polls it (like the
    /// color-correction gen) to persist the config + re-apply it to the RMT
    /// driver (color order live, a GPIO change on the transmit task).
    hw_config_gen: u32,
    /// Whether the latest `set_hardware_config` should be persisted to flash
    /// (true) or applied from RAM only (false) — the color-order test streams
    /// commit=false previews. See the `commit` field on `set_hardware_config`.
    hw_config_commit: bool,
    /// Static board capabilities (GPIO safety catalog + LED modes) the firmware
    /// embeds and installs at boot via [`Player::set_board_caps`]; echoed in
    /// `hardware_config_state` so the app builds its pin picker from THIS board.
    /// `None` until installed (and on boards/tests that never call it). Kept as
    /// the embedded ENCODED descriptor and spliced into the reply by
    /// [`Player::encode_reply`]: a decoded `BoardCapabilities` (31-pin catalog)
    /// is ~4 KiB and would size every by-value `ServerMessage` (FUG-71).
    board_caps: Option<&'static [u8]>,
    /// Whether the descriptor itself sets `led_channels` / `max_leds` (else the
    /// runtime output caps fill them in).
    board_caps_sets: (bool, bool, bool),
    /// Protocol features this firmware serves (welcome.features + the agent
    /// manifest), set at boot by [`Player::set_features`]. Spliced into the
    /// welcome at encode time like the board descriptor (the firmware profile
    /// carries no inline feature strings).
    features: &'static [&'static str],
    /// The .fxb format version the effects VM accepts (welcome.fxb_format).
    fxb_format: u32,
    /// This fixture's room pose (set_fixture_pose); None = unposed. `pose_gen`
    /// bumps on every change so the firmware re-derives its room-frame LED cache
    /// and persists (unless `pose_commit` is false).
    pose: Option<pb::FixturePose>,
    pose_gen: u32,
    pose_commit: bool,
    /// Shared effect-time epoch (set_time_base), device-clock ms; runtime only.
    time_base_ms: Option<i64>,
    /// Output capacity the firmware build actually has (parallel LED channels,
    /// total LEDs across them), set at boot via [`Player::set_output_caps`].
    /// Reported in `hardware_config_state.board` where the descriptor leaves
    /// those fields 0, and bounds `set_hardware_config.led_count`. 0 = unknown.
    out_channels: u32,
    out_max_leds: u32,
    /// LEDs ONE channel can carry (0 = only the total bounds a channel), set at
    /// boot via [`Player::set_channel_cap`].
    out_max_per_channel: u32,
    /// LEDs (summed) this boot's per-LED buffers hold (0 = unbounded / not
    /// reported): a count change past it is accepted, persisted, and asks the
    /// firmware to reboot into the bigger size ([`Player::take_reboot_request`]).
    led_capacity: u32,
    /// Latched by a count change past `led_capacity`; drained by the firmware.
    reboot_request: bool,
}

impl Player {
    pub fn new(session_id: &str, default_led_count: u32) -> Self {
        Player {
            session_id: s64(session_id),
            mac: Str64::new(),
            device_name: Str64::new(),
            fw_git_commit: Str64::new(),
            fw_git_dirty: false,
            fw_version: Str64::new(),
            default_led_count,
            active: None,
            counting: None,
            counting_order: [0, 1, 2],
            counting_channel: 0,
            led_counts: [None; MAX_CHANNELS],
            stored_map_id: None,
            frame_log: FrameLog::new(),
            color_correction: ColorCorrection::WS2812B,
            color_correction_gen: 0,
            color_correction_commit: true,
            output_brightness: 1.0,
            output_brightness_gen: 0,
            crossfade: 0.0,
            crossfade_mode: 0,
            hw_gpio: [-1; HW_CHANNELS],
            hw_order: [DEFAULT_COLOR_ORDER; HW_CHANNELS],
            hw_config_gen: 0,
            hw_config_commit: true,
            board_caps: None,
            board_caps_sets: (false, false, false),
            features: &[],
            fxb_format: 0,
            pose: None,
            pose_gen: 0,
            pose_commit: true,
            time_base_ms: None,
            out_channels: 0,
            out_max_leds: 0,
            out_max_per_channel: 0,
            led_capacity: 0,
            reboot_request: false,
        }
    }

    /// Handle one client message. `recv_ms`/`send_ms` are the player-clock
    /// receive and reply timestamps, INTEGER milliseconds (the player clock is
    /// millis()). §7.3 time sync needs both; everything else uses `send_ms` as
    /// "now". Returns the reply, or None for fire-and-forget arms.
    /// Handle one encoded `ClientMessage` frame, read IN PLACE (zero-copy
    /// pbview, no by-value envelope). A frame that isn't a valid encoding gets
    /// the bounded malformed reply.
    pub fn handle_frame(
        &mut self,
        frame: &[u8],
        recv_ms: i64,
        send_ms: i64,
    ) -> Option<pb::ServerMessage> {
        match pv::ClientMessageView::parse(frame) {
            Ok(req) => self.handle(req, recv_ms, send_ms),
            Err(_) => Some(upload_malformed()),
        }
    }

    /// Handle one parsed `ClientMessage` view (see [`Player::handle_frame`]).
    pub fn handle(
        &mut self,
        req: pv::ClientMessageView<'_>,
        recv_ms: i64,
        send_ms: i64,
    ) -> Option<pb::ServerMessage> {
        let Some(msg) = req.msg() else {
            return Some(error("bad_message", "envelope has no message set"));
        };
        match msg {
            CMsg::Hello(_) => Some(self.welcome()),
            CMsg::TimeSyncPing(p) => {
                // t0 is the phone clock (fractional, epoch-scale ms) — echoed
                // verbatim as f64; float32 could not hold it (this is the one
                // place double is genuinely required). t1/t2 are the player's
                // integer clock, widened only here at the wire boundary.
                let pong = pb::TimeSyncPong {
                    r#t0: p.t0(),
                    r#t1: recv_ms as f64,
                    r#t2: send_ms as f64,
                };
                Some(reply(SMsg::TimeSyncPong(pong)))
            }
            CMsg::StartMapping(m) => Some(self.start_mapping(m, send_ms)),
            CMsg::Configure(m) => Some(self.configure(m, send_ms)),
            CMsg::StopMapping(m) => Some(self.stop_mapping(m)),
            CMsg::GetPattern(_) => Some(self.pattern_state()),
            CMsg::SetCountingPattern(m) => Some(self.set_counting_pattern(m, send_ms)),
            CMsg::SetLedCount(m) => Some(self.set_led_count(m)),
            CMsg::SubmitMap(m) => {
                let id = m.map().map_or("", |map| map.map_id());
                let Some(id) = str64(id) else {
                    return Some(upload_malformed());
                };
                self.stored_map_id = Some(id.clone());
                Some(reply(SMsg::ResultReady(pb::ResultReady { r#map_id: id })))
            }
            CMsg::SubmitTopology(m) => {
                let id = m.topology().map_or("", |t| t.map_id());
                let Some(id) = str64(id) else {
                    return Some(upload_malformed());
                };
                if self.stored_map_id.as_ref() != Some(&id) {
                    return Some(error("unknown_map", "no stored map for this topology"));
                }
                Some(reply(SMsg::ResultReady(pb::ResultReady { r#map_id: id })))
            }
            // The native playback effects (pulse/flood) are gone: every show is
            // an FX-engine effect (submit_effect / set_effect). "off" still acks
            // with the (always idle) playback state so an old client's stop works.
            CMsg::SetPlayback(m) => match m.effect() {
                "off" => Some(self.playback_state()),
                _ => Some(error(
                    "unsupported_effect",
                    "native playback effects were removed; use the effects engine (submit_effect)",
                )),
            },
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
                let Some(name) = str64(m.name()) else {
                    return Some(error("bad_message", "name is longer than 64 bytes"));
                };
                self.device_name = name;
                Some(self.welcome())
            }
            // Color correction: store the resolved profile and bump the gen. The
            // firmware notices the change (like the rename above), regenerates the
            // per-channel LUTs, and persists them to flash.
            CMsg::SetColorCorrection(m) => {
                self.color_correction = color_correction_from(m);
                // Unset commit defaults to true (persist); a live-preview stream
                // sends commit=false to stay in RAM until the UI settles.
                self.color_correction_commit = m.commit().unwrap_or(true);
                self.color_correction_gen = self.color_correction_gen.wrapping_add(1);
                Some(self.welcome())
            }
            // Global output brightness: store the clamped scale and bump the gen.
            // The firmware polls the gen (like color correction) to apply it to
            // the strip write. Runtime-only, so nothing is persisted.
            // FX deck crossfade: store the clamped position + mode (runtime only);
            // echoed in welcome for UI hydration.
            CMsg::SetCrossfade(m) => {
                let pos = m.position();
                self.crossfade = if pos.is_finite() { (pos as f32).clamp(0.0, 1.0) } else { 0.0 };
                self.crossfade_mode = m.mode().min(1);
                Some(self.welcome())
            }
            CMsg::SetBrightness(m) => {
                self.output_brightness = (m.brightness() as f32).clamp(0.0, 1.0);
                self.output_brightness_gen = self.output_brightness_gen.wrapping_add(1);
                Some(self.welcome())
            }
            // Hardware wiring config: GPIO / LED type / wire color order per
            // channel. The firmware notices the gen bump, persists to NVS, and
            // re-applies to the RMT driver. Every field is optional (nudge one
            // setting at a time); an unset field is left unchanged.
            CMsg::SetHardwareConfig(m) => Some(self.set_hardware_config(m)),
            CMsg::GetHardwareConfig(_) => Some(self.hardware_config_state()),
            // Read-back: report the resolved gamma + luminance the device is
            // currently applying (what set_color_correction stored), so the app
            // can hydrate its curves and a journey can assert the applied gamma.
            CMsg::GetColorCorrection(_) => Some(self.color_correction_state()),
            // Room pose (multi-fixture): validate + store; the firmware polls the gen
            // to rebuild its room-frame LED cache and persist. Reply: welcome (pose).
            CMsg::SetFixturePose(m) => Some(self.set_fixture_pose(m)),
            // Shared time base: effect time = (now - epoch) / 1000. Runtime only.
            CMsg::SetTimeBase(m) => {
                self.time_base_ms = if m.clear() { None } else { Some(m.epoch_ms()) };
                Some(self.welcome())
            }
            CMsg::SubmitEffect(_)
            | CMsg::SetEffect(_)
            | CMsg::SetUniforms(_)
            | CMsg::GetEffectUniforms(_)
            | CMsg::ListEffects(_)
            | CMsg::SaveKeypoint(_)
            | CMsg::DeleteKeypoint(_)
            | CMsg::ListKeypoints(_)
            | CMsg::GetKeypoint(_)
            | CMsg::BlendKeypoints(_) => {
                Some(error("unsupported", "effects handled by the fx layer"))
            }
            // The TLS identity is the firmware's (player_app ffi), not the core's.
            // The framerate autoscaler (FUG-82) lives in the fx layer (player_app
            // ffi), which intercepts set_fps before the session core sees it.
            CMsg::SetFps(_) => Some(error("unsupported", "fps is handled by the fx layer")),
            // The sensor core lives in the firmware glue (player_app ffi), too.
            CMsg::GetSensors(_)
            | CMsg::CalibrateSensors(_)
            | CMsg::ScanI2c(_)
            | CMsg::SubmitDriver(_)
            | CMsg::RemoveDriver(_)
            | CMsg::GetDriverState(_)
            | CMsg::SetSensorMount(_)
            | CMsg::SetCaptureProfile(_)
            | CMsg::GetCaptureProfile(_) => {
                Some(error("unsupported", "sensors are handled by the firmware"))
            }
            // The TLS identity and firmware updates are the firmware's (player_app ffi /
            // ota_app.cpp / the loader), intercepted before the core. (One arm: every
            // extra `Some(error(..))` site costs a ServerMessage-sized slot in debug
            // builds, and the host test stacks are already near their limit.)
            CMsg::GetTlsInfo(_)
            | CMsg::OtaBegin(_)
            | CMsg::OtaChunk(_)
            | CMsg::OtaFinish(_)
            | CMsg::OtaAbort(_)
            | CMsg::GetOtaStatus(_)
            | CMsg::OtaReboot(_) => Some(error("unsupported", "handled by the firmware, not the player core")),
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
        }
    }

    // -- capture ----------------------------------------------------------

    fn start_mapping(&mut self, m: pv::StartMappingView<'_>, now_ms: i64) -> pb::ServerMessage {
        let Some(options) = m.options() else {
            return error("bad_message", "start_mapping without options");
        };
        let led_count = options.led_count();
        if led_count < 1 {
            return error("bad_message", "ledCount must be >= 1");
        }
        let symbols = match options.symbols() {
            None => DEFAULT_SYMBOLS,
            Some(2) => 2,
            Some(4) => 4,
            Some(_) => return error("bad_message", "symbols must be 2 or 4"),
        };
        // Wire values (ms/[0,1] doubles) are validated here at the cold decode
        // boundary, then stored in integer/fixed-point form for the hot loop.
        let bit_period_ms = options.bit_period_ms().unwrap_or(DEFAULT_BIT_PERIOD_MS);
        // `!(x > 0.0)` rejects zero, negatives, AND NaN — a rewrite to
        // `x <= 0.0` would silently accept a NaN from the wire.
        #[allow(clippy::neg_cmp_op_on_partial_ord)]
        if !(bit_period_ms > 0.0) {
            return error("bad_message", "bitPeriodMs must be > 0");
        }
        let brightness = options.brightness().unwrap_or(1.0);
        if !(0.0..=1.0).contains(&brightness) {
            return error("bad_message", "brightness must be in [0, 1]");
        }
        let (stride_spacing, anchor_density, stride_phase) = match parse_stride(
            options.stride_spacing(),
            options.anchor_density(),
            options.stride_phase(),
            (0, 3, 0),
        ) {
            Ok(v) => v,
            Err(e) => return e,
        };
        let (code_offset, code_space) =
            match parse_code_layout(led_count as u32, options.code_offset(), options.code_space()) {
                Ok(v) => v,
                Err(e) => return e,
            };
        // Group capture: a shared epoch in this player's clock aligns every
        // fixture's frames. A past epoch just phase-aligns the running pattern;
        // one far from now is a client clock bug.
        // (no_std: no f64::round / abs — integer arithmetic after a range check.)
        let epoch_ms = match options.epoch_ms() {
            None => now_ms,
            Some(e) => {
                let d = e - now_ms as f64;
                if !e.is_finite() || !(-MAX_EPOCH_SKEW_MS..=MAX_EPOCH_SKEW_MS).contains(&d) {
                    return error("bad_message", "epochMs too far from the player clock");
                }
                if e >= 0.0 {
                    (e + 0.5) as i64
                } else {
                    (e - 0.5) as i64
                }
            }
        };
        let stop_at_ms = match options.stop_after_ms() {
            Some(ms) if ms > 0 => Some(now_ms + ms as i64),
            _ => None,
        };
        let spec = CodeSpec::derive(code_space, symbols, true);
        let active = ActiveCapture {
            epoch_ms,
            spec,
            bit_period_us: (bit_period_ms * 1000.0 + 0.5) as u32,
            brightness_q8: brightness_to_q8(brightness),
            stride_spacing,
            anchor_density,
            stride_phase,
            led_count: led_count as u32,
            code_offset,
            stop_at_ms,
        };
        self.active = Some(active);
        let mut started = pb::MappingStarted {
            r#pattern_clock_epoch: epoch_ms as f64,
            ..Default::default()
        };
        let mut cp = code_params_msg(&spec, active.bit_period_ms(), active.brightness());
        set_stride_params(&mut cp, &active);
        set_group_params(&mut cp, &active);
        started.set_code_params(cp);
        reply(SMsg::MappingStarted(started))
    }

    fn configure(&mut self, m: pv::ConfigureView<'_>, now_ms: i64) -> pb::ServerMessage {
        let Some(active) = self.active else {
            return error("no_session", "configure requires an active capture session");
        };
        let options = m.options();
        let led_count = options
            .and_then(|o| o.led_count())
            .unwrap_or(active.led_count as i32);
        if led_count < 1 {
            return error("bad_message", "ledCount must be >= 1");
        }
        let symbols = match options.and_then(|o| o.symbols()) {
            None => active.spec.symbols,
            Some(2) => 2,
            Some(4) => 4,
            Some(_) => return error("bad_message", "symbols must be 2 or 4"),
        };
        let bit_period_ms = options
            .and_then(|o| o.bit_period_ms())
            .unwrap_or(active.bit_period_ms());
        // `!(x > 0.0)` rejects zero, negatives, AND NaN — a rewrite to
        // `x <= 0.0` would silently accept a NaN from the wire.
        #[allow(clippy::neg_cmp_op_on_partial_ord)]
        if !(bit_period_ms > 0.0) {
            return error("bad_message", "bitPeriodMs must be > 0");
        }
        let brightness = options
            .and_then(|o| o.brightness())
            .unwrap_or(active.brightness());
        if !(0.0..=1.0).contains(&brightness) {
            return error("bad_message", "brightness must be in [0, 1]");
        }
        // Stride params default to the ACTIVE ones, so a phase-advancing Configure
        // (only stride_phase set) keeps the spacing/anchor the session started with.
        let (stride_spacing, anchor_density, stride_phase) = match parse_stride(
            options.and_then(|o| o.stride_spacing()),
            options.and_then(|o| o.anchor_density()),
            options.and_then(|o| o.stride_phase()),
            (active.stride_spacing as i32, active.anchor_density as i32, active.stride_phase as i32),
        ) {
            Ok(v) => v,
            Err(e) => return e,
        };
        // A group capture keeps its code layout (the shared space grows only if
        // this fixture's strip outgrew it).
        let code_space = (active.spec.led_count).max(active.code_offset + led_count as u32);
        if code_space > MAX_CODE_SPACE {
            return error("bad_message", "codeSpace too large");
        }
        let spec = CodeSpec::derive(code_space, symbols, true);
        self.active = Some(ActiveCapture {
            epoch_ms: now_ms,
            spec,
            bit_period_us: (bit_period_ms * 1000.0 + 0.5) as u32,
            brightness_q8: brightness_to_q8(brightness),
            stride_spacing,
            anchor_density,
            stride_phase,
            led_count: led_count as u32,
            code_offset: active.code_offset,
            // A renegotiation keeps the original auto-stop deadline.
            stop_at_ms: active.stop_at_ms,
        });
        self.pattern_state()
    }

    fn stop_mapping(&mut self, m: pv::StopMappingView<'_>) -> pb::ServerMessage {
        if self.active.is_none() {
            return error("no_session", "no active capture session");
        }
        // solveOnHost unset/true asks for a host solve; this player has no
        // solver (its welcome carries no solverBenchMs), so that is a phone
        // placement bug — refuse loudly and keep the capture running.
        if m.solve_on_host() != Some(false) {
            return error("unsupported", "no solver on this player; stop with solveOnHost=false");
        }
        self.active = None;
        // This player persists no detection/IMU log; the counts echo that.
        let stopped = pb::MappingStopped {
            r#detections: 0,
            r#imu_samples: 0,
        };
        reply(SMsg::MappingStopped(stopped))
    }

    fn pattern_state(&self) -> pb::ServerMessage {
        let mut state = pb::PatternState::default();
        match self.active {
            Some(active) => {
                state.r#active = true;
                state.set_pattern_clock_epoch(active.epoch_ms as f64);
                let mut cp = code_params_msg(&active.spec, active.bit_period_ms(), active.brightness());
                set_stride_params(&mut cp, &active);
                set_group_params(&mut cp, &active);
                state.set_code_params(cp);
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
        m: pv::SetCountingPatternView<'_>,
        now_ms: i64,
    ) -> pb::ServerMessage {
        // Reduce each block's [0,1] wire color to 8-bit (read in place from the
        // frame), then install via the shared path.
        let mut reduced: micropb::heapless::Vec<(u32, u32, Rgb), MAX_COUNTING_BLOCKS> =
            micropb::heapless::Vec::new();
        for b in m.blocks().take(MAX_COUNTING_BLOCKS) {
            let mut rgb = [0u8; 3];
            for (c, v) in rgb.iter_mut().zip(b.rgb()) {
                *c = (v.clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
            }
            let block = (b.start().max(0) as u32, b.count().max(0) as u32, (rgb[0], rgb[1], rgb[2]));
            let _ = reduced.push(block);
        }
        self.set_counting_blocks(now_ms, &reduced, m.color_order(), m.channel())
    }

    /// Install a counting pattern from pre-reduced 8-bit blocks (empty = clear
    /// it), with an optional wire color-order override string (a permutation of
    /// "RGB"; unset/None = raw identity). Shared by the generated-decode path
    /// above and the firmware's zero-copy ffi walker, so neither materializes the
    /// wire ColorBlock array. Colors are pre-reduced by the caller so
    /// `counting_color` (polled per-LED every render pass) stays pure-integer.
    /// `color_order` and `channel` (the hardware output the blocks paint, relative
    /// to its strip start; None = 0) are validated BEFORE any mutation, so a bad
    /// value leaves the current pattern untouched.
    pub fn set_counting_blocks(
        &mut self,
        now_ms: i64,
        blocks: &[(u32, u32, Rgb)],
        color_order: Option<&str>,
        channel: Option<i32>,
    ) -> pb::ServerMessage {
        let channel = channel.unwrap_or(0);
        if channel < 0 || channel as usize >= HW_CHANNELS {
            return error("bad_message", "channel out of range");
        }
        let mut state = pb::CountingState::default();
        // Probe wire order (identity = raw). Validated before any mutation so a
        // bad string leaves the current pattern untouched.
        let order = match color_order {
            Some(s) => match color_order_index(s) {
                Some(i) => COLOR_ORDERS[i as usize].1,
                None => return error("bad_message", "unknown color_order"),
            },
            None => [0, 1, 2],
        };
        if blocks.is_empty() {
            self.counting = None;
            self.counting_order = [0, 1, 2];
            self.counting_channel = 0;
            state.r#active = false;
        } else {
            self.counting_order = order;
            self.counting_channel = channel as u8;
            state.r#active = true;
            state.set_epoch_ms(now_ms as f64); // integer clock → wire ms double
            let mut cb = CountingBlocks::new();
            for &(start, count, rgb) in blocks.iter().take(MAX_COUNTING_BLOCKS) {
                // capacity == MAX_COUNTING_BLOCKS, and we cap the iterator, so
                // push cannot fail.
                let _ = cb.push(CountingBlock { start, count, rgb });
            }
            self.counting = Some((now_ms, cb));
        }
        reply(SMsg::CountingState(state))
    }

    fn set_led_count(&mut self, m: pv::SetLedCountView<'_>) -> pb::ServerMessage {
        let channel = m.channel().unwrap_or(0);
        let led_count = m.led_count();
        if channel < 0 || channel as usize >= MAX_CHANNELS || led_count < 0 {
            return error("bad_message", "channel or ledCount out of range");
        }
        // A hardware channel is bounded by the output caps like
        // set_hardware_config (logical channels past the hardware carry no LEDs).
        if (channel as usize) < HW_CHANNELS {
            if let Some(why) = self.led_count_refusal(channel as usize, led_count as u32) {
                return error("bad_message", why);
            }
        }
        self.apply_led_count(channel as usize, led_count as u32);
        let mut state = pb::LedCountState {
            r#led_count: led_count,
            r#channel,
            ..Default::default()
        };
        if (channel as usize) < HW_CHANNELS && self.outgrew_capacity() {
            // Persist the new counts (the firmware polls the gen) so the reboot
            // comes up sized for them.
            self.hw_config_commit = true;
            self.hw_config_gen = self.hw_config_gen.wrapping_add(1);
            state.r#reboot_required = true;
        }
        reply(SMsg::LedCountState(state))
    }

    fn set_hardware_config(&mut self, m: pv::SetHardwareConfigView<'_>) -> pb::ServerMessage {
        let channel = m.channel().unwrap_or(0);
        if channel < 0 || channel as usize >= HW_CHANNELS {
            return error("bad_message", "channel out of range");
        }
        let ch = channel as usize;
        // Validate everything BEFORE mutating so a bad field leaves the config
        // untouched (and the app sees the real state echoed back).
        if let Some(gpio) = m.gpio() {
            // Any output-capable C6 GPIO (0..=30 covers the exposed pins; the
            // RMT peripheral routes through the GPIO matrix). A tighter denylist
            // lives in the app's curated pin list.
            if !(0..=30).contains(&gpio) {
                return error("bad_message", "gpio out of range");
            }
        }
        if let Some(t) = m.led_type() {
            if !t.eq_ignore_ascii_case(LED_TYPE_WS281X) {
                return error("bad_message", "unsupported led_type (only ws281x)");
            }
        }
        let order_idx = match m.color_order() {
            Some(s) => match color_order_index(s) {
                Some(i) => Some(i),
                None => return error("bad_message", "unknown color_order"),
            },
            None => None,
        };
        if let Some(n) = m.led_count() {
            if n < 0 {
                return error("bad_message", "led_count out of range");
            }
            if let Some(why) = self.led_count_refusal(ch, n as u32) {
                return error("bad_message", why);
            }
        }
        // All valid: apply the present fields.
        if let Some(gpio) = m.gpio() {
            self.hw_gpio[ch] = gpio;
        }
        if let Some(i) = order_idx {
            self.hw_order[ch] = i;
        }
        if let Some(n) = m.led_count() {
            self.apply_led_count(ch, n as u32);
        }
        self.hw_config_commit = m.commit().unwrap_or(true);
        // Outgrowing this boot's LED buffers persists (even a preview) so the
        // reboot that resizes them comes up with the new counts.
        let reboot = m.led_count().is_some() && self.outgrew_capacity();
        if reboot {
            self.hw_config_commit = true;
        }
        self.hw_config_gen = self.hw_config_gen.wrapping_add(1);
        let mut st = self.hardware_config_state();
        if let Some(SMsg::HardwareConfigState(s)) = st.r#msg.as_mut() {
            s.r#reboot_required = reboot;
        }
        st
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
            let tick = pb::FrameTick {
                r#seq,
                r#t_mono_us: t_us,
            };
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
        // No native playback effect exists any more, so it is always "off".
        let mut state = pb::PlaybackState::default();
        state.r#active = false;
        state.r#effect = s64("off");
        state.set_params(pb::PlaybackParams::default());
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
    /// hash; `dirty` marks an uncommitted working tree at build time; `version` is
    /// the release version from the nearest `firmware-v*` tag (e.g. "1.2.0").
    pub fn set_build_info(&mut self, commit: &str, dirty: bool, version: &str) {
        self.fw_git_commit = s64(commit);
        self.fw_git_dirty = dirty;
        self.fw_version = s64(version);
    }

    /// The player's current display name (after any `set_device_name`), so the
    /// firmware can persist it + rename the BLE advertisement.
    pub fn device_name(&self) -> &str {
        self.device_name.as_str()
    }

    /// The hardware id (MAC) and release version echoed in `welcome` — what the
    /// firmware advertises in its mDNS TXT record.
    pub fn mac(&self) -> &str {
        self.mac.as_str()
    }

    pub fn fw_version(&self) -> &str {
        self.fw_version.as_str()
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
    /// The FX deck crossfade position (0.0 = all deck A .. 1.0 = all deck B).
    pub fn crossfade(&self) -> f32 {
        self.crossfade
    }

    /// The FX deck crossfade colour space (0 = linear RGB, 1 = HSV).
    pub fn crossfade_mode(&self) -> u32 {
        self.crossfade_mode
    }

    pub fn output_brightness(&self) -> f32 {
        self.output_brightness
    }

    fn welcome(&self) -> pb::ServerMessage {
        let mut w = pb::Welcome {
            r#session_id: self.session_id.clone(),
            r#mac: self.mac.clone(),
            r#device_name: self.device_name.clone(),
            r#fw_git_commit: self.fw_git_commit.clone(),
            r#fw_git_dirty: self.fw_git_dirty,
            r#fw_version: self.fw_version.clone(),
            r#fxb_format: self.fxb_format,
            ..Default::default()
        };
        w.set_brightness(self.output_brightness as f64);
        w.set_crossfade(self.crossfade as f64);
        w.set_crossfade_mode(self.crossfade_mode);
        if let Some(t) = self.time_base_ms {
            w.set_time_base_ms(t);
        }
        let spec = CodeSpec::derive(self.default_led_count, DEFAULT_SYMBOLS, true);
        w.set_code_params(code_params_msg(&spec, DEFAULT_BIT_PERIOD_MS, 1.0));
        // NO solver_bench_ms: chooseSolvePlacement(phone, null) == "phone".
        reply(SMsg::Welcome(w))
    }

    /// The per-channel hardware config as a `hardware_config_state` reply (the
    /// Hardware Setup page hydrates from this and set_hardware_config echoes it).
    /// Only channels the firmware has seeded a real GPIO for are reported — an
    /// unseeded channel isn't wired up.
    fn hardware_config_state(&self) -> pb::ServerMessage {
        let mut state = pb::HardwareConfigState::default();
        for ch in 0..HW_CHANNELS {
            if self.hw_gpio[ch] < 0 {
                continue;
            }
            let hc = pb::HardwareChannel {
                r#channel: ch as i32,
                r#gpio: self.hw_gpio[ch],
                r#led_type: s64(LED_TYPE_WS281X),
                r#color_order: s64(COLOR_ORDERS[self.hw_order[ch] as usize].0),
                r#led_count: self.led_counts[ch].unwrap_or(0) as i32,
            };
            let _ = state.r#channels.push(hc);
        }
        state.r#led_capacity = self.led_capacity;
        // `board` is NOT set here: encode_reply splices it in from the encoded
        // descriptor, so the struct never holds the catalog.
        reply(SMsg::HardwareConfigState(state))
    }

    /// The encoded `hardware_config_state.board` body: the embedded descriptor
    /// followed by the runtime output caps for whichever capacity fields the
    /// descriptor leaves 0 (proto3 omits zeros; appending a scalar field is a
    /// valid encoding of setting it). `None` when there is no board to report.
    fn board_extra(&self) -> Option<([u8; 18], usize)> {
        if self.board_caps.is_none()
            && self.out_channels == 0
            && self.out_max_leds == 0
            && self.out_max_per_channel == 0
        {
            return None;
        }
        let mut extra = [0u8; 18];
        let mut n = 0;
        for (field, set, v) in [
            (4u8, self.board_caps_sets.0, self.out_channels),
            (5u8, self.board_caps_sets.1, self.out_max_leds),
            (6u8, self.board_caps_sets.2, self.out_max_per_channel),
        ] {
            if set || v == 0 {
                continue;
            }
            extra[n] = field << 3; // wire type 0 (varint)
            n += 1;
            let mut v = v;
            loop {
                let b = (v & 0x7f) as u8;
                v >>= 7;
                extra[n] = if v == 0 { b } else { b | 0x80 };
                n += 1;
                if v == 0 {
                    break;
                }
            }
        }
        Some((extra, n))
    }

    /// Encode `reply` straight into `out` (no staging buffer) and return the
    /// length, or `None` if it doesn't fit. Every reply MUST go out through
    /// here: the `hardware_config_state` arm gets its `board` descriptor spliced
    /// in from the embedded encoded bytes (see `board_caps`).
    pub fn encode_reply(&self, reply: &pb::ServerMessage, out: &mut [u8]) -> Option<usize> {
        use micropb::size::sizeof_varint32;
        use micropb::{MessageEncode, PbEncoder, PbWrite, Tag, WIRE_TYPE_LEN};
        let cap = out.len();
        let mut w: &mut [u8] = out;
        if let Some(SMsg::Welcome(wl)) = &reply.r#msg {
            if !self.features.is_empty() || self.pose.is_some() {
                return self.encode_welcome(wl, out);
            }
        }
        let board = match &reply.r#msg {
            Some(SMsg::HardwareConfigState(st)) => self.board_extra().map(|e| (st, e)),
            _ => None,
        };
        let Some((st, (extra, en))) = board else {
            reply.encode(&mut PbEncoder::new(&mut w)).ok()?;
            return Some(cap - w.len());
        };
        let caps = self.board_caps.unwrap_or(&[]);
        let blen = caps.len() + en;
        let inner = st.compute_size() + 1 + sizeof_varint32(blen as u32) + blen;
        {
            let mut enc = PbEncoder::new(&mut w);
            // ServerMessage.hardware_config_state = 19; HardwareConfigState.board = 2.
            enc.encode_tag(Tag::from_parts(19, WIRE_TYPE_LEN)).ok()?;
            enc.encode_varint32(inner as u32).ok()?;
            st.encode(&mut enc).ok()?;
            enc.encode_tag(Tag::from_parts(2, WIRE_TYPE_LEN)).ok()?;
            enc.encode_varint32(blen as u32).ok()?;
        }
        w.pb_write(caps).ok()?;
        w.pb_write(&extra[..en]).ok()?;
        Some(cap - w.len())
    }

    /// A welcome with `features` (field 10, repeated string) spliced in after the
    /// struct's own fields.
    fn encode_welcome(&self, wl: &pb::Welcome, out: &mut [u8]) -> Option<usize> {
        use micropb::size::sizeof_varint32;
        use micropb::{MessageEncode, PbEncoder, Tag, WIRE_TYPE_LEN};
        let cap = out.len();
        let mut w: &mut [u8] = out;
        let feats: usize = self
            .features
            .iter()
            .map(|f| 1 + sizeof_varint32(f.len() as u32) + f.len())
            .sum();
        let pose_len = self.pose.as_ref().map(|p| p.compute_size());
        let pose = pose_len.map_or(0, |n| 1 + sizeof_varint32(n as u32) + n);
        let inner = wl.compute_size() + feats + pose;
        {
            let mut enc = PbEncoder::new(&mut w);
            // ServerMessage.welcome = 1; Welcome.features = 10, Welcome.pose = 12.
            enc.encode_tag(Tag::from_parts(1, WIRE_TYPE_LEN)).ok()?;
            enc.encode_varint32(inner as u32).ok()?;
            wl.encode(&mut enc).ok()?;
            for f in self.features {
                enc.encode_tag(Tag::from_parts(10, WIRE_TYPE_LEN)).ok()?;
                enc.encode_string(f).ok()?;
            }
            if let (Some(p), Some(n)) = (&self.pose, pose_len) {
                enc.encode_tag(Tag::from_parts(12, WIRE_TYPE_LEN)).ok()?;
                enc.encode_varint32(n as u32).ok()?;
                p.encode(&mut enc).ok()?;
            }
        }
        Some(cap - w.len())
    }

    fn set_fixture_pose(&mut self, m: pv::SetFixturePoseView<'_>) -> pb::ServerMessage {
        if m.clear() {
            self.pose = None;
        } else {
            let Some(p) = m.pose().map_or(Some(pb::FixturePose::default()), owned_pose).as_ref().and_then(normalized_pose) else {
                return error("bad_pose", "translation/room_min/room_max need 3 floats, rotation 4, all finite");
            };
            self.pose = Some(p);
        }
        self.pose_commit = m.commit().unwrap_or(true);
        self.pose_gen = self.pose_gen.wrapping_add(1);
        self.welcome()
    }

    /// The stored room pose (None = unposed), its change generation, and whether
    /// the last change asked to be persisted.
    pub fn fixture_pose(&self) -> Option<&pb::FixturePose> {
        self.pose.as_ref()
    }

    pub fn fixture_pose_gen(&self) -> u32 {
        self.pose_gen
    }

    pub fn fixture_pose_commit(&self) -> bool {
        self.pose_commit
    }

    /// The shared effect-time epoch (device-clock ms), if one is set.
    pub fn time_base_ms(&self) -> Option<i64> {
        self.time_base_ms
    }

    /// Move the time-base epoch by `delta_ms` (device clock): after the device
    /// clock steps by `delta_ms`, shifting the epoch the same way keeps effect
    /// time (now - epoch) continuous, so the fixture stays in step.
    pub fn shift_time_base(&mut self, delta_ms: i64) {
        if let Some(t) = self.time_base_ms.as_mut() {
            *t += delta_ms;
        }
    }

    /// Declare the protocol features this firmware serves and the .fxb format
    /// its VM accepts; echoed in every welcome (and the agent manifest). Call
    /// once at boot.
    pub fn set_features(&mut self, features: &'static [&'static str], fxb_format: u32) {
        self.features = features;
        self.fxb_format = fxb_format;
    }

    /// The features declared by [`Player::set_features`].
    pub fn features(&self) -> &'static [&'static str] {
        self.features
    }

    /// The device's current color correction as a `color_correction_state` reply
    /// (the Color Correction page hydrates from this; a gamma journey asserts
    /// against it). Reports the RESOLVED per-channel gamma + luminance the last
    /// `set_color_correction` stored — the concrete values the LUTs are built
    /// from, not a profile name (the device always has a profile: WS2812B after
    /// a reboot). `get_color_correction` echoes whatever `set_color_correction`
    /// set, so set->get round-trips the gamma.
    fn color_correction_state(&self) -> pb::ServerMessage {
        let (gamma, lum) = (self.color_correction.gamma, self.color_correction.luminance);
        let state = pb::ColorCorrectionState {
            r#gamma_r: gamma[0],
            r#gamma_g: gamma[1],
            r#gamma_b: gamma[2],
            r#lum_r: lum[0],
            r#lum_g: lum[1],
            r#lum_b: lum[2],
        };
        reply(SMsg::ColorCorrectionState(state))
    }

    /// Seed a hardware channel's config at boot from what the firmware actually
    /// initialized (the default or NVS-persisted GPIO + color order). Does NOT
    /// bump `hw_config_gen` — this is the starting state, not a change to
    /// persist. `order` indexes [`COLOR_ORDERS`]; out-of-range falls back to the
    /// WS2812B default.
    pub fn set_hw_defaults(&mut self, channel: usize, gpio: i32, order: u8) {
        if channel >= HW_CHANNELS {
            return;
        }
        self.hw_gpio[channel] = gpio;
        self.hw_order[channel] = if (order as usize) < COLOR_ORDERS.len() {
            order
        } else {
            DEFAULT_COLOR_ORDER
        };
    }

    /// Install the board's static capability descriptor: the embedded
    /// binaryproto, kept encoded. Echoed verbatim in `hardware_config_state`; the app
    /// builds its GPIO picker + LED-type list from it (falling back to a built-in
    /// catalog when a board doesn't report one). Call once at boot.
    /// A malformed descriptor is ignored (returns false).
    pub fn set_board_caps(&mut self, encoded: &'static [u8]) -> bool {
        // Walk the top-level fields once: validates the framing and learns which
        // capacity fields the descriptor sets itself (4 = led_channels, 5 = max_leds,
        // 6 = max_leds_per_channel).
        let mut sets = (false, false, false);
        let mut o = 0;
        let varint = |o: &mut usize| -> Option<u64> {
            let mut v = 0u64;
            for shift in (0..64).step_by(7) {
                let b = *encoded.get(*o)?;
                *o += 1;
                v |= u64::from(b & 0x7f) << shift;
                if b & 0x80 == 0 {
                    return Some(v);
                }
            }
            None
        };
        while o < encoded.len() {
            let Some(key) = varint(&mut o) else { return false };
            // Only varint values matter (the capacity fields); skip the rest.
            let v = match key & 7 {
                0 => varint(&mut o),
                1 | 5 => {
                    o += if key & 7 == 1 { 8 } else { 4 };
                    Some(0)
                }
                2 => varint(&mut o).map(|l| {
                    o = o.saturating_add(l as usize);
                    0
                }),
                _ => None,
            };
            let Some(v) = v else { return false };
            match key {
                0x20 => sets.0 = v != 0, // led_channels, varint
                0x28 => sets.1 = v != 0, // max_leds, varint
                0x30 => sets.2 = v != 0, // max_leds_per_channel, varint
                _ => {}
            }
        }
        if o != encoded.len() {
            return false; // a field ran past the end
        }
        self.board_caps = Some(encoded);
        self.board_caps_sets = sets;
        true
    }

    /// Record the output capacity this firmware build has: `channels` parallel
    /// LED outputs and `max_leds` LEDs summed across them. Reported in
    /// `hardware_config_state.board` (where the descriptor leaves them 0) and
    /// bounds `set_hardware_config.led_count`. Call once at boot.
    pub fn set_output_caps(&mut self, channels: u32, max_leds: u32) {
        self.out_channels = channels;
        self.out_max_leds = max_leds;
    }

    /// Record how many LEDs ONE output channel can carry (the firmware's
    /// per-channel cap: a longer channel would no longer clock out in parallel
    /// with the other). Reported as `hardware_config_state.board.
    /// max_leds_per_channel` (where the descriptor leaves it 0) and bounds
    /// `set_hardware_config.led_count` / `set_led_count` per hardware channel.
    /// 0 (the default) = only the total bounds a channel. Call once at boot.
    pub fn set_channel_cap(&mut self, max_per_channel: u32) {
        self.out_max_per_channel = max_per_channel;
    }

    /// Why `n` LEDs on hardware channel `ch` don't fit the output caps, or None
    /// when they do: the per-channel cap, then the channels' shared total.
    fn led_count_refusal(&self, ch: usize, n: u32) -> Option<&'static str> {
        if self.out_max_per_channel > 0 && n > self.out_max_per_channel {
            return Some("led_count exceeds the board's max_leds_per_channel");
        }
        if self.out_max_leds > 0 && self.total_with(ch, n) > self.out_max_leds {
            // The channels share one set of per-LED buffers: the SUM must fit
            // what this board's heap can buffer (board.max_leds).
            return Some(
                "led_count exceeds the board's max_leds (the LED buffers this board's heap can hold)",
            );
        }
        None
    }

    /// The hardware channels' LED total with channel `ch` set to `n`.
    fn total_with(&self, ch: usize, n: u32) -> u32 {
        (0..HW_CHANNELS)
            .map(|c| if c == ch { n } else { self.led_counts[c].unwrap_or(0) })
            .fold(0u32, |a, b| a.saturating_add(b))
    }

    /// Record how many LEDs (summed across channels) this boot's per-LED
    /// buffers hold — the firmware sizes them once at boot from the persisted
    /// counts. A later count change that needs more is accepted (within
    /// board.max_leds), forced to persist, flagged `reboot_required` in its
    /// reply, and latched for [`take_reboot_request`](Self::take_reboot_request).
    /// Reported as `hardware_config_state.led_capacity`. Call once at boot.
    pub fn set_led_capacity(&mut self, leds: u32) {
        self.led_capacity = leds;
    }

    /// LEDs this boot's per-LED buffers hold (0 = not reported).
    pub fn led_capacity(&self) -> u32 {
        self.led_capacity
    }

    /// Read + clear the reboot latch: a count change outgrew this boot's LED
    /// buffers; the firmware restarts (after the reply goes out) to resize.
    pub fn take_reboot_request(&mut self) -> bool {
        core::mem::take(&mut self.reboot_request)
    }

    /// After a count change: true (and the config forced to persist, the latch
    /// set) when the hardware total outgrew this boot's buffers.
    fn outgrew_capacity(&mut self) -> bool {
        let total = self.total_with(0, self.led_counts[0].unwrap_or(0));
        if self.led_capacity == 0 || total <= self.led_capacity {
            return false;
        }
        self.reboot_request = true;
        true
    }

    /// Seed channel `channel`'s LED count at boot from what the firmware
    /// persisted (0 = not set). Like [`Player::set_hw_defaults`], does NOT bump
    /// `hw_config_gen` — it's the starting state, not a change to persist.
    pub fn seed_led_count(&mut self, channel: usize, n: u32) {
        if channel < HW_CHANNELS {
            self.apply_led_count(channel, n);
        }
    }

    /// Set channel `ch`'s LED count (0 clears it). The hardware channels form
    /// one global LED index space in channel order, so their TOTAL becomes the
    /// code-book default (the welcome's codeParams.ledCount) — a new map then
    /// covers every channel's LEDs by default.
    fn apply_led_count(&mut self, ch: usize, n: u32) {
        self.led_counts[ch] = if n > 0 { Some(n) } else { None };
        let total: u32 = self.led_counts[..HW_CHANNELS].iter().map(|c| c.unwrap_or(0)).sum();
        if total >= 1 {
            self.default_led_count = total;
        }
    }

    /// Generation counter bumped on every `set_hardware_config`; the firmware
    /// polls it (like the color-correction gen) to persist + re-apply the config.
    pub fn hw_config_gen(&self) -> u32 {
        self.hw_config_gen
    }

    /// Whether the latest `set_hardware_config` should be committed to flash.
    pub fn hw_config_commit(&self) -> bool {
        self.hw_config_commit
    }

    /// The GPIO configured for hardware channel `channel`, or None if the
    /// channel is out of range or unseeded.
    pub fn hw_gpio(&self, channel: usize) -> Option<i32> {
        self.hw_gpio.get(channel).copied().filter(|&g| g >= 0)
    }

    /// The wire color-order source permutation for hardware channel `channel`
    /// (wire byte `i` carries logical channel `perm[i]`; see [`COLOR_ORDERS`]),
    /// or the WS2812B default for an out-of-range channel.
    pub fn hw_color_order_perm(&self, channel: usize) -> [u8; 3] {
        let idx = self.hw_order.get(channel).copied().unwrap_or(DEFAULT_COLOR_ORDER);
        COLOR_ORDERS[idx as usize].1
    }

    /// The wire color-order NAME (e.g. "GRB") for hardware channel `channel`, or
    /// the WS2812B default for an out-of-range channel. The firmware persists
    /// this to NVS.
    pub fn hw_color_order_name(&self, channel: usize) -> &'static str {
        let idx = self.hw_order.get(channel).copied().unwrap_or(DEFAULT_COLOR_ORDER);
        COLOR_ORDERS[idx as usize].0
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
        // Diffuse striding: LEDs outside the active phase's subset are OFF. Return
        // BLACK (not None) — the render loop leaves a None LED at its prior color,
        // which would strand masked LEDs lit from the previous phase.
        if active.stride_spacing > 1
            && !stride_lit(led, active.stride_phase, active.stride_spacing, active.anchor_density)
        {
            return Some((0, 0, 0));
        }
        if led >= active.led_count {
            return Some((0, 0, 0));
        }
        let (r, g, b) = color_for_frame(led + active.code_offset, frame_index, &active.spec);
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

    /// The wire color order to apply to the counting probe's pixels — a
    /// source-index permutation ([`COLOR_ORDERS`] convention). Independent of the
    /// committed per-channel order so the color-order test can preview a candidate
    /// (or drive raw) without touching the persisted config. Identity when no
    /// pattern is latched.
    pub fn counting_color_order(&self) -> [u8; 3] {
        self.counting_order
    }

    /// The hardware output channel the latched counting pattern paints; its
    /// block indices are relative to that channel's strip start. 0 when none.
    pub fn counting_channel(&self) -> u32 {
        self.counting_channel as u32
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

    /// End the active capture if its auto-stop deadline (stop_after_ms) has
    /// passed. Called by the frame loop each pass; true when it just stopped.
    pub fn expire_pattern(&mut self, now_ms: i64) -> bool {
        match self.active {
            Some(ActiveCapture { stop_at_ms: Some(t), .. }) if now_ms >= t => {
                self.active = None;
                true
            }
            _ => false,
        }
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
            .map(|a| (a.epoch_ms, a.bit_period_us, a.spec.cycle_frames, a.led_count))
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
        let r = pb::ResultReady {
            r#map_id: s64(map_id),
        };
        reply(SMsg::ResultReady(r))
    }

    /// A topology upload decoded into the arena: ack against the stored map
    /// (mirrors the generated-path submit_topology semantics).
    pub fn topology_stored(&mut self, map_id: &str) -> pb::ServerMessage {
        if self.stored_map_id.as_deref() != Some(map_id) {
            return error("unknown_map", "no stored map for this topology");
        }
        let r = pb::ResultReady {
            r#map_id: s64(map_id),
        };
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

pub fn code_params_msg(spec: &CodeSpec, bit_period_ms: f64, brightness: f64) -> pb::CodeParams {
    let mut cp = pb::CodeParams {
        r#led_count: spec.led_count as i32,
        r#bits: spec.bits as i32,
        r#encoding: s64("hue"),
        r#bit_period_ms,
        r#sync_pattern: s64("on_off"),
        r#cycle_frames: spec.cycle_frames as i32,
        r#fec: s64(if spec.secded { "secded" } else { "none" }),
        r#symbols: spec.symbols as i32,
        ..Default::default()
    };
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
    let e = pb::Error {
        r#code: s64(code),
        r#message: {
            let mut m = micropb::heapless::String::new();
            let _ = m.push_str(message);
            m
        },
    };
    reply(SMsg::Error(e))
}

// -- agent discovery manifest (/.well-known/splanc.json) -------------------------

/// What the firmware (not the session core) knows for the agent manifest: the
/// TLS certificate pin and the build's agent-bundle location.
#[derive(Default)]
pub struct ManifestExtras<'a> {
    /// SHA-256 of the DER TLS certificate, lowercase hex ("" = unknown).
    pub tls_cert_sha256: &'a str,
    /// The per-device TLS identity's state: "generating" | "ready" ("" = not
    /// reported, i.e. firmware without per-device certs; the field is omitted).
    pub tls_state: &'a str,
    /// Whether that identity is persisted in flash (stable across reboots).
    pub tls_persisted: bool,
    /// Agent bundle URL from the release pipeline ("" = derive it for a release
    /// build: the firmware-v<version> GitHub release asset).
    pub bundle_url: &'a str,
    /// The bundle's SHA-256, lowercase hex ("" = not published with this build).
    pub bundle_sha256: &'a str,
}

/// The npm package of the agent's MCP bridge (`npx -y <pkg>@<version>`).
pub const AGENT_PACKAGE: &str = "@splanc/agent";

/// A bounded JSON writer over a byte buffer: `ok` turns false on overflow.
struct Json<'a> {
    out: &'a mut [u8],
    n: usize,
    ok: bool,
}

impl Json<'_> {
    fn raw(&mut self, s: &str) {
        let b = s.as_bytes();
        if self.n + b.len() > self.out.len() {
            self.ok = false;
            return;
        }
        self.out[self.n..self.n + b.len()].copy_from_slice(b);
        self.n += b.len();
    }

    /// A quoted, escaped JSON string.
    fn str(&mut self, s: &str) {
        const HEX: &[u8; 16] = b"0123456789abcdef";
        self.raw("\"");
        for c in s.chars() {
            match c {
                '"' => self.raw("\\\""),
                '\\' => self.raw("\\\\"),
                c if (c as u32) < 0x20 => {
                    let v = c as u32;
                    let esc = [b'\\', b'u', b'0', b'0', HEX[(v >> 4) as usize], HEX[(v & 15) as usize]];
                    self.raw(core::str::from_utf8(&esc).unwrap_or(""));
                }
                c => {
                    let mut buf = [0u8; 4];
                    self.raw(c.encode_utf8(&mut buf));
                }
            }
        }
        self.raw("\"");
    }

    fn uint(&mut self, v: u32) {
        let mut buf = [0u8; 10];
        let mut i = buf.len();
        let mut v = v;
        loop {
            i -= 1;
            buf[i] = b'0' + (v % 10) as u8;
            v /= 10;
            if v == 0 {
                break;
            }
        }
        self.raw(core::str::from_utf8(&buf[i..]).unwrap_or("0"));
    }
}

/// A clean release version ("1.2.0"): the only builds with a published bundle.
fn is_release_version(v: &str) -> bool {
    let mut parts = 0;
    for p in v.split('.') {
        if p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit()) {
            return false;
        }
        parts += 1;
    }
    parts == 3 && v != "0.0.0"
}

/// The board name (BoardCapabilities.board = 1) from the encoded descriptor.
fn board_name(caps: &[u8]) -> &str {
    let mut o = 0;
    let varint = |o: &mut usize| -> Option<u64> {
        let mut v = 0u64;
        for shift in (0..64).step_by(7) {
            let b = *caps.get(*o)?;
            *o += 1;
            v |= u64::from(b & 0x7f) << shift;
            if b & 0x80 == 0 {
                return Some(v);
            }
        }
        None
    };
    while o < caps.len() {
        let Some(key) = varint(&mut o) else { return "" };
        match key & 7 {
            0 => {
                if varint(&mut o).is_none() {
                    return "";
                }
            }
            1 => o += 8,
            5 => o += 4,
            2 => {
                let Some(l) = varint(&mut o) else { return "" };
                let (start, end) = (o, o.saturating_add(l as usize));
                if key >> 3 == 1 {
                    return caps
                        .get(start..end)
                        .and_then(|b| core::str::from_utf8(b).ok())
                        .unwrap_or("");
                }
                o = end;
            }
            _ => return "",
        }
    }
    ""
}

impl Player {
    /// Render the agent discovery manifest (`GET /.well-known/splanc.json`, schema
    /// "splanc-agent/1") into `out`, returning its length (None if it doesn't fit).
    /// Device fields mirror the welcome so a bridge can check that the /ws it
    /// reaches is the same player. Only a clean release build names a bundle; a
    /// dev or dirty build reports `"bundle": null` (the bridge then needs a local
    /// path override).
    pub fn agent_manifest(&self, out: &mut [u8], x: &ManifestExtras) -> Option<usize> {
        let mut j = Json { out, n: 0, ok: true };
        let version = self.fw_version.as_str();
        j.raw("{\"schema\":\"splanc-agent/1\",\"device\":{\"id\":");
        j.str(self.mac.as_str());
        j.raw(",\"name\":");
        j.str(self.device_name.as_str());
        j.raw(",\"board\":");
        j.str(self.board_caps.map(board_name).unwrap_or(""));
        j.raw("},\"firmware\":{\"version\":");
        j.str(version);
        j.raw(",\"commit\":");
        j.str(self.fw_git_commit.as_str());
        j.raw(if self.fw_git_dirty { ",\"dirty\":true}" } else { ",\"dirty\":false}" });
        j.raw(",\"protocol\":{\"package\":\"ledmapper.v1\",\"ws_path\":\"/ws\",\"profile\":\"core\",\"features\":[");
        for (i, f) in self.features.iter().enumerate() {
            if i > 0 {
                j.raw(",");
            }
            j.str(f);
        }
        j.raw("],\"fxb_format\":");
        j.uint(self.fxb_format);
        j.raw("},\"tls\":{\"cert_sha256\":");
        j.str(x.tls_cert_sha256);
        if !x.tls_state.is_empty() {
            j.raw(",\"state\":");
            j.str(x.tls_state);
            j.raw(if x.tls_persisted { ",\"persisted\":true" } else { ",\"persisted\":false" });
        }
        j.raw("},\"bundle\":");
        if is_release_version(version) && !self.fw_git_dirty {
            j.raw("{\"url\":");
            if x.bundle_url.is_empty() {
                j.raw("\"https://github.com/fughilli/splanc/releases/download/firmware-v");
                j.raw(version);
                j.raw("/splanc-agent-");
                j.raw(version);
                j.raw(".tgz\"");
            } else {
                j.str(x.bundle_url);
            }
            j.raw(",\"sha256\":");
            j.str(x.bundle_sha256);
            j.raw(",\"mcp\":{\"command\":\"npx\",\"args\":[\"-y\",\"");
            j.raw(AGENT_PACKAGE);
            j.raw("@");
            j.raw(version);
            j.raw("\",\"--host\",\"{host}\"]}}");
        } else {
            j.raw("null");
        }
        j.raw("}");
        j.ok.then_some(j.n)
    }
}

/// A pose with its defaults filled (identity rotation, unit scale, zero
/// translation) and the quaternion normalized; None when a vector has the wrong
/// arity or a value is not finite.
/// The wire pose (read in place) as the owned, persisted/echoed form. None when
/// a field overflows its capacity (more floats than any valid pose has).
fn owned_pose(v: pv::FixturePoseView<'_>) -> Option<pb::FixturePose> {
    let mut p = pb::FixturePose::default();
    p.r#room.push_str(v.room()).ok()?;
    for x in v.translation() {
        p.r#translation.push(x).ok()?;
    }
    for x in v.rotation() {
        p.r#rotation.push(x).ok()?;
    }
    p.r#scale = v.scale();
    for x in v.room_min() {
        p.r#room_min.push(x).ok()?;
    }
    for x in v.room_max() {
        p.r#room_max.push(x).ok()?;
    }
    Some(p)
}

fn normalized_pose(p: &pb::FixturePose) -> Option<pb::FixturePose> {
    let ok = |v: &[f32], n: usize| (v.is_empty() || v.len() == n) && v.iter().all(|x| x.is_finite());
    if !ok(&p.r#translation, 3)
        || !ok(&p.r#rotation, 4)
        || !ok(&p.r#room_min, 3)
        || !ok(&p.r#room_max, 3)
        || !p.r#scale.is_finite()
        || (p.r#room_min.is_empty() != p.r#room_max.is_empty())
    {
        return None;
    }
    let mut out = p.clone();
    if out.r#translation.is_empty() {
        out.r#translation.extend_from_slice(&[0.0; 3]).ok()?;
    }
    let mut q = [0.0f32, 0.0, 0.0, 1.0];
    if !p.r#rotation.is_empty() {
        q.copy_from_slice(&p.r#rotation);
    }
    let n2 = q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3];
    if n2 < 1e-12 {
        return None;
    }
    let k = inv_sqrt(n2);
    out.r#rotation.clear();
    out.r#rotation.extend_from_slice(&[q[0] * k, q[1] * k, q[2] * k, q[3] * k]).ok()?;
    if out.r#scale <= 0.0 {
        out.r#scale = 1.0;
    }
    Some(out)
}

/// 1/sqrt(x) for x > 0 (no_std, no libm): the bit-trick seed + three Newton steps,
/// accurate to f32 rounding — enough to normalize a quaternion.
fn inv_sqrt(x: f32) -> f32 {
    let mut y = f32::from_bits(0x5f37_59df - (x.to_bits() >> 1));
    for _ in 0..3 {
        y *= 1.5 - 0.5 * x * y * y;
    }
    y
}
