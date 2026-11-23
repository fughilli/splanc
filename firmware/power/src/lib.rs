//! Lamp power (docs/design/lamp-power.md): the on/off state machine with its
//! ON/OFF transitions, the toggle-trigger step and the persisted config record.
//! (The touch sensor itself is a driver-VM driver, firmware/sensor/drivers/
//! ttp223_touch.fx, that exports the trigger.)
//!
//! `no_std`, zero-dependency, never allocates: the player app drives it through
//! `firmware/player_app/power_ffi.rs`, and the host tests drive it directly.
//! Time is a wrapping `u32` millisecond clock (the firmware's `millis()`).

#![no_std]

// ---------------------------------------------------------------------------
// Wire values (ledmapper.proto "Lamp power")
// ---------------------------------------------------------------------------

/// PowerTransition.style: instant.
pub const STYLE_CUT: u8 = 0;
/// PowerTransition.style: a brightness ramp over the running effect.
pub const STYLE_FADE: u8 = 1;
/// PowerTransition.style: play the stored transition effect (deck B).
pub const STYLE_EFFECT: u8 = 2;

/// PowerState.phase values.
pub const PHASE_OFF: u8 = 0;
pub const PHASE_ON: u8 = 1;
pub const PHASE_TURNING_ON: u8 = 2;
pub const PHASE_TURNING_OFF: u8 = 3;

/// PowerState.source values.
pub const SOURCE_BOOT: u8 = 0;
pub const SOURCE_CLIENT: u8 = 1;
/// The bound toggle trigger fired (a lid tap through the touch driver).
pub const SOURCE_TRIGGER: u8 = 2;

/// PowerConfig boot values.
pub const BOOT_LAST: u8 = 0;
pub const BOOT_ON: u8 = 1;
pub const BOOT_OFF: u8 = 2;

/// A toggle-trigger counter's new value: Some(true) = it fired (toggle the
/// lamp), Some(false) = first sight or a reset (a driver reload restarts its
/// count): adopt it without toggling. None = unchanged.
pub fn trigger_step(last: Option<f32>, now: f32) -> Option<bool> {
    match last {
        None => Some(false),
        Some(l) if now == l => None,
        Some(l) => Some(now > l),
    }
}

/// Default transition lengths (ms) when the config says 0.
pub const DEFAULT_ON_MS: u32 = 700;
pub const DEFAULT_OFF_MS: u32 = 900;
/// Transition length bounds (ms).
pub const MIN_MS: u32 = 100;
pub const MAX_MS: u32 = 30_000;

/// Uniform preset values per transition.
pub const MAX_UNIFORMS: usize = 8;
/// Label bytes (a keypoint name).
pub const MAX_LABEL: usize = 32;
/// Stored transition effect id bytes.
pub const MAX_ID: usize = 64;
/// Toggle-trigger name bytes (a pool / uniform name).
pub const MAX_TRIGGER: usize = 24;

/// Q8 full scale: 256 == 1.0.
pub const LEVEL_ONE: u16 = 256;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/// One slot-addressed uniform value (UniformValue, <= 4 floats).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Uniform {
    pub slot: u16,
    pub n: u8,
    pub v: [f32; 4],
}

impl Uniform {
    pub const EMPTY: Uniform = Uniform { slot: 0, n: 0, v: [0.0; 4] };
    pub fn values(&self) -> &[f32] {
        &self.v[..(self.n as usize).min(4)]
    }
}

/// How the lamp turns ON or OFF (PowerTransition).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Transition {
    pub style: u8,
    /// 0 = the default for the direction.
    pub duration_ms: u32,
    pub uniforms: [Uniform; MAX_UNIFORMS],
    pub n_uniforms: u8,
    pub label: [u8; MAX_LABEL],
    pub label_len: u8,
    /// The stored transition effect's id (empty = none stored).
    pub effect_id: [u8; MAX_ID],
    pub effect_id_len: u8,
}

impl Transition {
    pub const DEFAULT: Transition = Transition {
        style: STYLE_FADE,
        duration_ms: 0,
        uniforms: [Uniform::EMPTY; MAX_UNIFORMS],
        n_uniforms: 0,
        label: [0; MAX_LABEL],
        label_len: 0,
        effect_id: [0; MAX_ID],
        effect_id_len: 0,
    };

    pub fn uniforms(&self) -> &[Uniform] {
        &self.uniforms[..(self.n_uniforms as usize).min(MAX_UNIFORMS)]
    }
    pub fn label(&self) -> &[u8] {
        &self.label[..(self.label_len as usize).min(MAX_LABEL)]
    }
    pub fn effect_id(&self) -> &[u8] {
        &self.effect_id[..(self.effect_id_len as usize).min(MAX_ID)]
    }
    pub fn has_effect(&self) -> bool {
        self.effect_id_len > 0
    }
    pub fn set_label(&mut self, s: &[u8]) {
        let n = clip_utf8(s, MAX_LABEL);
        self.label = [0; MAX_LABEL];
        self.label[..n].copy_from_slice(&s[..n]);
        self.label_len = n as u8;
    }
    pub fn set_effect_id(&mut self, s: &[u8]) {
        let n = clip_utf8(s, MAX_ID);
        self.effect_id = [0; MAX_ID];
        self.effect_id[..n].copy_from_slice(&s[..n]);
        self.effect_id_len = n as u8;
    }
    /// Append a preset value (false when full or malformed).
    pub fn push_uniform(&mut self, slot: u32, vals: &[f32]) -> bool {
        let i = self.n_uniforms as usize;
        if i >= MAX_UNIFORMS || vals.is_empty() || vals.len() > 4 || slot > u16::MAX as u32 {
            return false;
        }
        let mut u = Uniform { slot: slot as u16, n: vals.len() as u8, v: [0.0; 4] };
        u.v[..vals.len()].copy_from_slice(vals);
        self.uniforms[i] = u;
        self.n_uniforms += 1;
        true
    }
    pub fn clear_uniforms(&mut self) {
        self.uniforms = [Uniform::EMPTY; MAX_UNIFORMS];
        self.n_uniforms = 0;
    }
}

/// Clip `s` to at most `cap` bytes without splitting a UTF-8 sequence.
fn clip_utf8(s: &[u8], cap: usize) -> usize {
    if s.len() <= cap {
        return s.len();
    }
    let mut n = cap;
    while n > 0 && (s[n] & 0xC0) == 0x80 {
        n -= 1;
    }
    n
}

/// The transition length actually used: 0 -> the direction's default, then
/// clamped to MIN_MS..=MAX_MS.
pub fn effective_ms(duration_ms: u32, on: bool) -> u32 {
    let d = if duration_ms == 0 { if on { DEFAULT_ON_MS } else { DEFAULT_OFF_MS } } else { duration_ms };
    d.clamp(MIN_MS, MAX_MS)
}

/// The lamp's power config (PowerConfig), persisted as one record.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Config {
    pub boot: u8,
    pub on: Transition,
    pub off: Transition,
    /// The uniform-pool trigger that toggles the lamp ("" = none).
    pub trigger: [u8; MAX_TRIGGER],
    pub trigger_len: u8,
}

impl Config {
    pub const DEFAULT: Config = Config {
        boot: BOOT_LAST,
        on: Transition::DEFAULT,
        off: Transition::DEFAULT,
        trigger: [0; MAX_TRIGGER],
        trigger_len: 0,
    };

    pub fn trigger(&self) -> &[u8] {
        &self.trigger[..(self.trigger_len as usize).min(MAX_TRIGGER)]
    }
    /// Bind the toggle trigger (an identifier, <= MAX_TRIGGER bytes; "" or an
    /// invalid name unbinds). Returns false for an invalid name.
    pub fn set_trigger(&mut self, name: &[u8]) -> bool {
        self.trigger = [0; MAX_TRIGGER];
        self.trigger_len = 0;
        let ok = !name.is_empty()
            && name.len() <= MAX_TRIGGER
            && (name[0].is_ascii_alphabetic() || name[0] == b'_')
            && name.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'_');
        if ok {
            self.trigger[..name.len()].copy_from_slice(name);
            self.trigger_len = name.len() as u8;
        }
        ok || name.is_empty()
    }

    pub fn transition(&self, on: bool) -> &Transition {
        if on {
            &self.on
        } else {
            &self.off
        }
    }
    pub fn transition_mut(&mut self, on: bool) -> &mut Transition {
        if on {
            &mut self.on
        } else {
            &mut self.off
        }
    }
}

/// Sanitize a boot value from the wire (unknown -> BOOT_LAST).
pub fn sanitize_boot(b: u32) -> u8 {
    if b <= BOOT_OFF as u32 {
        b as u8
    } else {
        BOOT_LAST
    }
}

/// Sanitize a style from the wire (unknown -> FADE).
pub fn sanitize_style(s: u32) -> u8 {
    if s <= STYLE_EFFECT as u32 {
        s as u8
    } else {
        STYLE_FADE
    }
}

const MAGIC: &[u8; 4] = b"SPW1";
const RECORD_VERSION: u8 = 1;
/// One transition's encoded size (fixed layout).
const T_LEN: usize = 1 + 4 + 1 + MAX_UNIFORMS * (2 + 1 + 16) + 1 + MAX_LABEL + 1 + MAX_ID;
/// The config record's size: magic, version, boot, two transitions, the trigger.
pub const RECORD_LEN: usize = 4 + 1 + 1 + 2 * T_LEN + 1 + MAX_TRIGGER;

fn enc_t(t: &Transition, o: &mut [u8]) {
    let mut p = 0;
    o[p] = t.style;
    p += 1;
    o[p..p + 4].copy_from_slice(&t.duration_ms.to_le_bytes());
    p += 4;
    o[p] = t.n_uniforms;
    p += 1;
    for u in &t.uniforms {
        o[p..p + 2].copy_from_slice(&u.slot.to_le_bytes());
        o[p + 2] = u.n;
        for (k, v) in u.v.iter().enumerate() {
            o[p + 3 + 4 * k..p + 7 + 4 * k].copy_from_slice(&v.to_le_bytes());
        }
        p += 19;
    }
    o[p] = t.label_len;
    p += 1;
    o[p..p + MAX_LABEL].copy_from_slice(&t.label);
    p += MAX_LABEL;
    o[p] = t.effect_id_len;
    p += 1;
    o[p..p + MAX_ID].copy_from_slice(&t.effect_id);
}

fn dec_t(r: &[u8]) -> Option<Transition> {
    let mut t = Transition::DEFAULT;
    let mut p = 0;
    t.style = sanitize_style(r[p] as u32);
    p += 1;
    t.duration_ms = u32::from_le_bytes([r[p], r[p + 1], r[p + 2], r[p + 3]]).min(MAX_MS);
    p += 4;
    let n = r[p] as usize;
    if n > MAX_UNIFORMS {
        return None;
    }
    t.n_uniforms = n as u8;
    p += 1;
    for u in t.uniforms.iter_mut() {
        u.slot = u16::from_le_bytes([r[p], r[p + 1]]);
        u.n = r[p + 2].min(4);
        for k in 0..4 {
            let b = [r[p + 3 + 4 * k], r[p + 4 + 4 * k], r[p + 5 + 4 * k], r[p + 6 + 4 * k]];
            u.v[k] = f32::from_le_bytes(b);
        }
        p += 19;
    }
    for u in &t.uniforms[..n] {
        if u.n == 0 || u.values().iter().any(|v| !v.is_finite()) {
            return None;
        }
    }
    let ll = r[p] as usize;
    p += 1;
    if ll > MAX_LABEL || core::str::from_utf8(&r[p..p + ll]).is_err() {
        return None;
    }
    t.label_len = ll as u8;
    t.label[..ll].copy_from_slice(&r[p..p + ll]);
    p += MAX_LABEL;
    let il = r[p] as usize;
    p += 1;
    if il > MAX_ID || core::str::from_utf8(&r[p..p + il]).is_err() {
        return None;
    }
    t.effect_id_len = il as u8;
    t.effect_id[..il].copy_from_slice(&r[p..p + il]);
    Some(t)
}

/// Encode the config record.
pub fn encode_config(c: &Config, out: &mut [u8; RECORD_LEN]) {
    *out = [0; RECORD_LEN];
    out[..4].copy_from_slice(MAGIC);
    out[4] = RECORD_VERSION;
    out[5] = c.boot;
    enc_t(&c.on, &mut out[6..6 + T_LEN]);
    enc_t(&c.off, &mut out[6 + T_LEN..6 + 2 * T_LEN]);
    let p = 6 + 2 * T_LEN;
    out[p] = c.trigger_len;
    out[p + 1..p + 1 + MAX_TRIGGER].copy_from_slice(&c.trigger);
}

/// Decode a config record (None = not ours / corrupt: keep the defaults).
pub fn decode_config(r: &[u8]) -> Option<Config> {
    if r.len() != RECORD_LEN || &r[..4] != MAGIC || r[4] != RECORD_VERSION {
        return None;
    }
    let mut c = Config {
        boot: sanitize_boot(r[5] as u32),
        on: dec_t(&r[6..6 + T_LEN])?,
        off: dec_t(&r[6 + T_LEN..6 + 2 * T_LEN])?,
        ..Config::DEFAULT
    };
    let p = 6 + 2 * T_LEN;
    let n = r[p] as usize;
    if n > MAX_TRIGGER || !c.set_trigger(&r[p + 1..p + 1 + n]) {
        return None;
    }
    Some(c)
}

/// What a cold boot does: the state to come up in.
pub fn boot_state(boot: u8, last_on: Option<bool>) -> bool {
    match boot {
        BOOT_ON => true,
        BOOT_OFF => false,
        // Never saved (a first boot, or firmware from before the power feature):
        // on, like every Splanc lamp before it had an off state.
        _ => last_on.unwrap_or(true),
    }
}

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

/// Hermite smoothstep of x clamped to [0, 1].
pub fn smooth(x: f32) -> f32 {
    let x = if x < 0.0 {
        0.0
    } else if x > 1.0 {
        1.0
    } else {
        x
    };
    x * x * (3.0 - 2.0 * x)
}

/// EFFECT style, ON: the first part fades in from dark, the effect plays
/// alone, the last part crossfades into the show.
pub const EFFECT_ON_FADE_IN: f32 = 0.15;
pub const EFFECT_ON_XF_START: f32 = 0.70;
/// EFFECT style, OFF: crossfade from the show into the effect over the first
/// part, the effect alone, then fade to dark over the last part.
pub const EFFECT_OFF_XF_END: f32 = 0.30;
pub const EFFECT_OFF_FADE_OUT: f32 = 0.85;

/// The output level (0..1) and deck-B crossfade (None = untouched) at progress
/// `t` of a transition of `style` towards `on`, starting from `from` (the light
/// level when it started: 0 or 1 for a fresh one, in between for a reversal,
/// which is always a fade).
pub fn envelope(style: u8, on: bool, from: f32, t: f32) -> (f32, Option<f32>) {
    let t = if t < 0.0 {
        0.0
    } else if t > 1.0 {
        1.0
    } else {
        t
    };
    let to = if on { 1.0 } else { 0.0 };
    match style {
        STYLE_EFFECT if on => {
            let level = smooth(t / EFFECT_ON_FADE_IN);
            // Crossfade position: 1 = deck B (the effect) only, 0 = the show.
            let xf = 1.0 - smooth((t - EFFECT_ON_XF_START) / (1.0 - EFFECT_ON_XF_START));
            (level, Some(xf))
        }
        STYLE_EFFECT => {
            let xf = smooth(t / EFFECT_OFF_XF_END);
            let level = 1.0 - smooth((t - EFFECT_OFF_FADE_OUT) / (1.0 - EFFECT_OFF_FADE_OUT));
            (level, Some(xf))
        }
        STYLE_CUT => (to, None),
        _ => (from + (to - from) * smooth(t), None),
    }
}

fn level_q8(level: f32) -> u16 {
    let v = level * LEVEL_ONE as f32 + 0.5;
    if v <= 0.0 {
        0
    } else if v >= LEVEL_ONE as f32 {
        LEVEL_ONE
    } else {
        v as u16
    }
}

// ---------------------------------------------------------------------------
// The state machine
// ---------------------------------------------------------------------------

/// A change request (set_power, a tap).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Request {
    pub on: bool,
    pub instant: bool,
    /// Overrides the configured duration for this change (0 = configured).
    pub duration_ms: u32,
    pub source: u8,
}

/// What the caller must do after a request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Start {
    /// Nothing changed (already there).
    Unchanged,
    /// The change started (or completed, for a cut).
    Started,
    /// Load the ON (true) / OFF (false) transition effect onto deck B, then call
    /// [`Machine::effect_loaded`]. Until then the lamp holds its current look.
    LoadEffect(bool),
}

/// One render frame's power output.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Frame {
    /// False only when settled off (the render loop blanks and idles).
    pub render: bool,
    /// Output scale, Q8 (256 = full), on top of the user brightness.
    pub level_q8: u16,
    /// Deck-B crossfade override (EFFECT transitions), else None.
    pub crossfade: Option<f32>,
    /// The `power` uniform: the light level (0..1).
    pub power: f32,
    /// The `transition` uniform: progress 0..1 (1 when settled).
    pub progress: f32,
    /// A transition finished this frame (clear deck B if it played an effect,
    /// persist, push).
    pub settled: bool,
    /// The transition that settled had deck B loaded (clear it).
    pub release_deck_b: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Machine {
    phase: u8,
    /// The running transition: start time, length, style, the level it started
    /// from, and whether deck B holds its effect.
    start_ms: u32,
    dur_ms: u32,
    style: u8,
    from: f32,
    deck_b: bool,
    /// A held crossfade (a reversal of an EFFECT transition fades the light
    /// with the deck mix frozen where it was).
    xf_hold: Option<f32>,
    /// Waiting for the transition effect to load (LoadEffect).
    pending: bool,
    /// The running transition's clock starts at the next frame (the boot
    /// fade-in: setup runs long before the first frame renders).
    start_at_frame: bool,
    pending_dur: u32,
    /// The last frame's light level (for a smooth reversal) and crossfade.
    last_level: f32,
    last_xf: Option<f32>,
    pub source: u8,
    /// Bumped on every change (PowerState.seq).
    pub seq: u32,
}

impl Machine {
    pub const fn new(on: bool) -> Machine {
        Machine {
            phase: if on { PHASE_ON } else { PHASE_OFF },
            start_ms: 0,
            dur_ms: 0,
            style: STYLE_CUT,
            from: if on { 1.0 } else { 0.0 },
            deck_b: false,
            xf_hold: None,
            pending: false,
            start_at_frame: false,
            pending_dur: 0,
            last_level: if on { 1.0 } else { 0.0 },
            last_xf: None,
            source: SOURCE_BOOT,
            seq: 0,
        }
    }

    pub fn phase(&self) -> u8 {
        self.phase
    }
    /// The target state (on, or turning on).
    pub fn target(&self) -> bool {
        matches!(self.phase, PHASE_ON | PHASE_TURNING_ON)
    }
    pub fn transitioning(&self) -> bool {
        matches!(self.phase, PHASE_TURNING_ON | PHASE_TURNING_OFF)
    }
    /// ms left in the running transition.
    pub fn left_ms(&self, now: u32) -> u32 {
        if !self.transitioning() {
            return 0;
        }
        if self.pending {
            return self.pending_dur;
        }
        self.dur_ms.saturating_sub(now.wrapping_sub(self.start_ms))
    }
    /// Deck B holds this machine's transition effect.
    pub fn owns_deck_b(&self) -> bool {
        self.deck_b
    }

    fn bump(&mut self) {
        self.seq = self.seq.wrapping_add(1);
    }

    /// Request a change. `cfg` supplies the transition; `effect_ok` says the
    /// stored transition effect for that direction can play now (one is stored
    /// and deck B is free).
    pub fn request(&mut self, req: Request, cfg: &Config, effect_ok: bool, now: u32) -> Start {
        if self.target() == req.on && !(req.instant && self.transitioning()) {
            return Start::Unchanged;
        }
        let t = cfg.transition(req.on);
        let dur = effective_ms(if req.duration_ms != 0 { req.duration_ms } else { t.duration_ms }, req.on);
        self.source = req.source;
        self.bump();
        let was_transitioning = self.transitioning() && !self.pending;
        // An instant change, or a cut: straight to the target.
        if req.instant || t.style == STYLE_CUT {
            self.pending = false;
            self.settle(req.on);
            return Start::Started;
        }
        if was_transitioning || self.pending {
            // A reversal (or a request while an effect was still loading): fade
            // from where the light is now, scaled to the distance left, with any
            // deck mix held still. Smooth whatever was running.
            let from = self.last_level;
            let dist = if req.on { 1.0 - from } else { from };
            let d = ((dur as f32 * dist) as u32).max(MIN_MS);
            self.xf_hold = if self.deck_b { self.last_xf } else { None };
            self.pending = false;
            self.begin(req.on, STYLE_FADE, from, d, now);
            return Start::Started;
        }
        let from = if req.on { 0.0 } else { 1.0 };
        if t.style == STYLE_EFFECT && effect_ok {
            self.phase = if req.on { PHASE_TURNING_ON } else { PHASE_TURNING_OFF };
            self.pending = true;
            self.pending_dur = dur;
            self.from = from;
            return Start::LoadEffect(req.on);
        }
        self.begin(req.on, STYLE_FADE, from, dur, now);
        Start::Started
    }

    /// Boot into ON with a fade-in from dark of `dur_ms` (0 = the default ON
    /// length) that starts on the first rendered frame.
    pub fn boot_fade_in(&mut self, dur_ms: u32) {
        self.begin(true, STYLE_FADE, 0.0, effective_ms(dur_ms, true), 0);
        self.start_at_frame = true;
        self.last_level = 0.0;
        self.source = SOURCE_BOOT;
    }

    /// The transition effect requested by [`Start::LoadEffect`] loaded (`ok`)
    /// or didn't (falls back to a fade). The transition clock starts now.
    /// Returns false when the request it answers is gone (a reversal came
    /// first): the caller unloads deck B again.
    pub fn effect_loaded(&mut self, ok: bool, now: u32) -> bool {
        if !self.pending {
            return false;
        }
        self.pending = false;
        let on = self.phase == PHASE_TURNING_ON;
        self.deck_b = ok;
        self.xf_hold = None;
        self.begin(on, if ok { STYLE_EFFECT } else { STYLE_FADE }, self.from, self.pending_dur, now);
        ok
    }

    fn begin(&mut self, on: bool, style: u8, from: f32, dur: u32, now: u32) {
        self.phase = if on { PHASE_TURNING_ON } else { PHASE_TURNING_OFF };
        self.style = style;
        self.from = from;
        self.dur_ms = dur.max(1);
        self.start_ms = now;
        self.start_at_frame = false;
    }

    fn settle(&mut self, on: bool) {
        self.phase = if on { PHASE_ON } else { PHASE_OFF };
        self.from = if on { 1.0 } else { 0.0 };
        self.last_level = self.from;
        self.last_xf = None;
        self.xf_hold = None;
        self.style = STYLE_CUT;
    }

    /// One render frame at `now`.
    pub fn frame(&mut self, now: u32) -> Frame {
        match self.phase {
            PHASE_ON => {
                return Frame {
                    render: true,
                    level_q8: LEVEL_ONE,
                    crossfade: None,
                    power: 1.0,
                    progress: 1.0,
                    settled: false,
                    release_deck_b: false,
                }
            }
            PHASE_OFF => {
                return Frame {
                    render: false,
                    level_q8: 0,
                    crossfade: None,
                    power: 0.0,
                    progress: 1.0,
                    settled: false,
                    release_deck_b: false,
                }
            }
            _ => {}
        }
        let on = self.phase == PHASE_TURNING_ON;
        if self.pending {
            // Holding the current look while the effect loads (a frame or so).
            let level = self.from;
            return Frame {
                render: true,
                level_q8: level_q8(level),
                crossfade: None,
                power: level,
                progress: 0.0,
                settled: false,
                release_deck_b: false,
            };
        }
        if self.start_at_frame {
            self.start_at_frame = false;
            self.start_ms = now;
        }
        let el = now.wrapping_sub(self.start_ms);
        if el >= self.dur_ms {
            let release = self.deck_b;
            self.deck_b = false;
            self.settle(on);
            self.bump();
            return Frame {
                render: on,
                level_q8: if on { LEVEL_ONE } else { 0 },
                crossfade: None,
                power: if on { 1.0 } else { 0.0 },
                progress: 1.0,
                settled: true,
                release_deck_b: release,
            };
        }
        let t = el as f32 / self.dur_ms as f32;
        let (level, xf) = envelope(self.style, on, self.from, t);
        let xf = if self.xf_hold.is_some() { self.xf_hold } else { xf };
        self.last_level = level;
        self.last_xf = xf;
        // The `power` uniform follows the transition's own light curve: 0 -> 1
        // on, 1 -> 0 off (a fresh EFFECT transition's level is the outer fade, so
        // use the plain progress for the effect's own animation).
        let power = if self.style == STYLE_EFFECT {
            if on {
                t
            } else {
                1.0 - t
            }
        } else {
            level
        };
        Frame {
            render: true,
            level_q8: level_q8(level),
            crossfade: xf,
            power,
            progress: t,
            settled: false,
            release_deck_b: false,
        }
    }
}
