//! The rule model and its wire form: exactly the `ScheduleRule` message of
//! ledmapper.proto, encoded and decoded here by hand (no_std, no protobuf
//! dependency), so the firmware stores and answers rules zero-copy and
//! `player_rs` can share the crate.
//!
//! ```text
//! ScheduleRule { 1 id: uint32, 2 disabled: bool, 3 label: string (<= 24 B),
//!   4 when: ScheduleWhen (0 LOCAL_TIME, 1 SUNRISE, 2 SUNSET),
//!   5 minute_of_day: uint32 (LOCAL_TIME), 6 offset_min: sint32 (SUNRISE/SUNSET),
//!   7 days_mask: uint32 (bit 0 = Sunday; 0 = every day),
//!   oneof action { 10 power: { 1 on: bool, 2 duration_ms: uint32 }
//!                  11 brightness: { 1 level: float, 2 ramp_ms: uint32 }
//!                  12 effect: { 1 effect_id: string, 2 crossfade_ms: uint32 }
//!                  13 trigger: { 1 name: string } } }
//! ```

/// Bytes of a label.
pub const MAX_LABEL: usize = 24;
/// Bytes of an effect id or a trigger name (the effect store's id length).
pub const MAX_NAME: usize = 64;
/// Offsets from sunrise / sunset are within ±12 h.
pub const MAX_OFFSET_MIN: i16 = 720;
/// The longest effect crossfade or brightness ramp (10 min), ms.
pub const MAX_FADE_MS: u32 = 600_000;
/// The longest power transition a rule may ask for (the power machine's cap), ms.
pub const MAX_POWER_MS: u32 = 600_000;

/// A short byte string of at most `N` bytes (UTF-8 checked on decode).
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct Str<const N: usize> {
    buf: [u8; N],
    len: u8,
}

impl<const N: usize> Str<N> {
    pub const EMPTY: Self = Str {
        buf: [0; N],
        len: 0,
    };

    /// `s`, or None when it is longer than `N` bytes.
    pub fn new(s: &str) -> Option<Self> {
        Self::from_bytes(s.as_bytes())
    }

    fn from_bytes(b: &[u8]) -> Option<Self> {
        if b.len() > N || b.len() > u8::MAX as usize || core::str::from_utf8(b).is_err() {
            return None;
        }
        let mut s = Self::EMPTY;
        s.buf[..b.len()].copy_from_slice(b);
        s.len = b.len() as u8;
        Some(s)
    }

    pub fn as_str(&self) -> &str {
        core::str::from_utf8(self.as_bytes()).unwrap_or("")
    }

    pub fn as_bytes(&self) -> &[u8] {
        &self.buf[..self.len as usize]
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }
}

impl<const N: usize> core::fmt::Debug for Str<N> {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "{:?}", self.as_str())
    }
}

/// What a rule's time is relative to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WhenKind {
    /// A local wall time (`minute_of_day`) in the lamp's zone.
    LocalTime,
    /// Sunrise / sunset at the lamp's location, plus `offset_min`.
    Sunrise,
    Sunset,
}

/// When a rule fires.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct When {
    pub kind: WhenKind,
    /// LocalTime: 0..1440.
    pub minute_of_day: u16,
    /// Sunrise / Sunset: minutes after the event (negative = before).
    pub offset_min: i16,
    /// Bit 0 = Sunday .. bit 6 = Saturday, of the LOCAL date of the fire; 0 = every day.
    pub days_mask: u8,
}

impl When {
    pub const fn local(minute_of_day: u16, days_mask: u8) -> Self {
        When {
            kind: WhenKind::LocalTime,
            minute_of_day,
            offset_min: 0,
            days_mask,
        }
    }

    /// Fires on a local date with this weekday (0 = Sunday).
    pub const fn on_weekday(&self, weekday: u8) -> bool {
        self.days_mask & 0x7f == 0 || self.days_mask & (1 << weekday) != 0
    }
}

/// The kinds of action (the compact form the firmware keeps in RAM).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ActionKind {
    None,
    Power,
    Brightness,
    Effect,
    Trigger,
}

impl ActionKind {
    /// A state rule (reconciled after a power loss or a late clock, D-566), not
    /// a momentary one.
    pub const fn is_state(self) -> bool {
        matches!(
            self,
            ActionKind::Power | ActionKind::Brightness | ActionKind::Effect
        )
    }
}

/// What a rule does.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Action {
    /// No action (a rule being edited): never fires.
    None,
    /// Turn the lamp on / off through the power machine (its configured
    /// transition; `duration_ms` 0 = the configured duration).
    Power { on: bool, duration_ms: u32 },
    /// Ramp the output brightness to `level` (0..1) over `ramp_ms`.
    Brightness { level: f32, ramp_ms: u32 },
    /// Crossfade to the stored effect `effect_id` over `crossfade_ms`.
    Effect {
        effect_id: Str<MAX_NAME>,
        crossfade_ms: u32,
    },
    /// Bump the pool trigger `name` (an effect's `uniform trigger name;` /
    /// counter fires). Momentary: never replayed.
    Trigger { name: Str<MAX_NAME> },
}

impl Action {
    pub const fn kind(&self) -> ActionKind {
        match self {
            Action::None => ActionKind::None,
            Action::Power { .. } => ActionKind::Power,
            Action::Brightness { .. } => ActionKind::Brightness,
            Action::Effect { .. } => ActionKind::Effect,
            Action::Trigger { .. } => ActionKind::Trigger,
        }
    }
}

/// One schedule rule.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rule {
    /// 1..=255, unique per lamp.
    pub id: u8,
    pub enabled: bool,
    pub label: Str<MAX_LABEL>,
    pub when: When,
    pub action: Action,
}

/// Why a rule was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RuleError {
    /// Bad framing or wire types.
    Malformed,
    /// id 0 or > 255.
    BadId,
    /// minute_of_day >= 1440 or |offset_min| > 720 or an unknown `when`.
    BadTime,
    /// A label or name too long / not UTF-8, an empty effect id / trigger name,
    /// a level outside 0..1 or a fade over the cap.
    BadAction,
}

// -- protobuf wire helpers ----------------------------------------------------------

const WT_VARINT: u8 = 0;
const WT_I64: u8 = 1;
const WT_LEN: u8 = 2;
const WT_I32: u8 = 5;

fn read_varint(b: &[u8], i: &mut usize) -> Option<u64> {
    let mut v = 0u64;
    for shift in (0..64).step_by(7) {
        let byte = *b.get(*i)?;
        *i += 1;
        v |= ((byte & 0x7f) as u64) << shift;
        if byte & 0x80 == 0 {
            return Some(v);
        }
    }
    None
}

/// One field: (number, wire type, varint value or fixed bits, payload for LEN).
pub(crate) struct Field<'a> {
    pub number: u32,
    pub wt: u8,
    pub value: u64,
    pub bytes: &'a [u8],
}

/// Iterates the fields of a message; None from `next` ends it, and `bad`
/// says whether it ended on malformed input.
pub(crate) struct Fields<'a> {
    b: &'a [u8],
    i: usize,
    pub bad: bool,
}

impl<'a> Fields<'a> {
    pub fn new(b: &'a [u8]) -> Self {
        Fields {
            b,
            i: 0,
            bad: false,
        }
    }
}

impl<'a> Iterator for Fields<'a> {
    type Item = Field<'a>;
    fn next(&mut self) -> Option<Field<'a>> {
        if self.i >= self.b.len() || self.bad {
            return None;
        }
        let r = (|| {
            let key = read_varint(self.b, &mut self.i)?;
            let number = u32::try_from(key >> 3).ok().filter(|&n| n > 0)?;
            let wt = (key & 7) as u8;
            let (value, bytes): (u64, &[u8]) = match wt {
                WT_VARINT => (read_varint(self.b, &mut self.i)?, &[]),
                WT_I64 => {
                    let s = self.b.get(self.i..self.i + 8)?;
                    self.i += 8;
                    (u64::from_le_bytes(s.try_into().ok()?), &[])
                }
                WT_LEN => {
                    let n = usize::try_from(read_varint(self.b, &mut self.i)?).ok()?;
                    let s = self.b.get(self.i..self.i.checked_add(n)?)?;
                    self.i += n;
                    (n as u64, s)
                }
                WT_I32 => {
                    let s = self.b.get(self.i..self.i + 4)?;
                    self.i += 4;
                    (u32::from_le_bytes(s.try_into().ok()?) as u64, &[])
                }
                _ => return None,
            };
            Some(Field {
                number,
                wt,
                value,
                bytes,
            })
        })();
        if r.is_none() {
            self.bad = true;
        }
        r
    }
}

/// A protobuf writer into a fixed buffer (overflow sets `full`, never panics).
pub struct Writer<'a> {
    buf: &'a mut [u8],
    pub n: usize,
    pub full: bool,
    /// Only count the bytes (sizing a nested message).
    count: bool,
}

impl<'a> Writer<'a> {
    pub fn new(buf: &'a mut [u8]) -> Self {
        Writer {
            buf,
            n: 0,
            full: false,
            count: false,
        }
    }

    /// A writer that only counts.
    pub fn counter() -> Writer<'static> {
        Writer {
            buf: &mut [],
            n: 0,
            full: false,
            count: true,
        }
    }

    fn byte(&mut self, b: u8) {
        if self.count {
            self.n += 1;
        } else if self.n < self.buf.len() {
            self.buf[self.n] = b;
            self.n += 1;
        } else {
            self.full = true;
        }
    }

    pub fn varint(&mut self, mut v: u64) {
        loop {
            let b = (v & 0x7f) as u8;
            v >>= 7;
            if v == 0 {
                self.byte(b);
                return;
            }
            self.byte(b | 0x80);
        }
    }

    pub fn key(&mut self, field: u32, wt: u8) {
        self.varint(((field as u64) << 3) | wt as u64);
    }

    /// A varint field (skipped when 0: proto3 default).
    pub fn uint(&mut self, field: u32, v: u64) {
        if v != 0 {
            self.key(field, WT_VARINT);
            self.varint(v);
        }
    }

    pub fn sint(&mut self, field: u32, v: i64) {
        self.uint(field, ((v << 1) ^ (v >> 63)) as u64);
    }

    pub fn float(&mut self, field: u32, v: f32) {
        if v.to_bits() != 0 {
            self.key(field, WT_I32);
            for b in v.to_le_bytes() {
                self.byte(b);
            }
        }
    }

    /// A length-delimited field (skipped when empty).
    pub fn bytes(&mut self, field: u32, b: &[u8]) {
        if !b.is_empty() {
            self.key(field, WT_LEN);
            self.varint(b.len() as u64);
            for &x in b {
                self.byte(x);
            }
        }
    }

    /// A nested message: `f` writes its body (run twice: once to size it).
    pub fn message(&mut self, field: u32, f: impl Fn(&mut Writer)) {
        let mut c = Writer::counter();
        f(&mut c);
        self.key(field, WT_LEN);
        self.varint(c.n as u64);
        f(self);
    }

    pub fn written(&self) -> usize {
        self.n
    }
}

fn zigzag_dec(v: u64) -> i64 {
    ((v >> 1) as i64) ^ -((v & 1) as i64)
}

impl Rule {
    /// Parses a `ScheduleRule` message body.
    pub fn decode(b: &[u8]) -> Result<Rule, RuleError> {
        let mut id = 0u64;
        let mut enabled = true;
        let mut label = Str::EMPTY;
        let mut when_kind = 0u64;
        let mut minute = 0u64;
        let mut offset = 0i64;
        let mut days = 0u64;
        let mut action = Action::None;
        let mut fs = Fields::new(b);
        for f in fs.by_ref() {
            match (f.number, f.wt) {
                (1, WT_VARINT) => id = f.value,
                (2, WT_VARINT) => enabled = f.value == 0,
                (3, WT_LEN) => label = Str::from_bytes(f.bytes).ok_or(RuleError::BadAction)?,
                (4, WT_VARINT) => when_kind = f.value,
                (5, WT_VARINT) => minute = f.value,
                (6, WT_VARINT) => offset = zigzag_dec(f.value),
                (7, WT_VARINT) => days = f.value,
                (10..=13, WT_LEN) => action = decode_action(f.number, f.bytes)?,
                (1..=13, _) => return Err(RuleError::Malformed),
                _ => {} // unknown fields: forward compatible
            }
        }
        if fs.bad {
            return Err(RuleError::Malformed);
        }
        if id == 0 || id > 255 {
            return Err(RuleError::BadId);
        }
        let kind = match when_kind {
            0 => WhenKind::LocalTime,
            1 => WhenKind::Sunrise,
            2 => WhenKind::Sunset,
            _ => return Err(RuleError::BadTime),
        };
        if minute >= 1440
            || offset.abs() > MAX_OFFSET_MIN as i64
            || (kind == WhenKind::LocalTime && offset != 0)
        {
            return Err(RuleError::BadTime);
        }
        Ok(Rule {
            id: id as u8,
            enabled,
            label,
            when: When {
                kind,
                minute_of_day: minute as u16,
                offset_min: offset as i16,
                days_mask: (days & 0x7f) as u8,
            },
            action,
        })
    }

    /// Writes the `ScheduleRule` message body.
    pub fn encode(&self, w: &mut Writer) {
        w.uint(1, self.id as u64);
        w.uint(2, (!self.enabled) as u64);
        w.bytes(3, self.label.as_bytes());
        w.uint(
            4,
            match self.when.kind {
                WhenKind::LocalTime => 0,
                WhenKind::Sunrise => 1,
                WhenKind::Sunset => 2,
            },
        );
        w.uint(5, self.when.minute_of_day as u64);
        w.sint(6, self.when.offset_min as i64);
        w.uint(7, self.when.days_mask as u64);
        match &self.action {
            Action::None => {}
            Action::Power { on, duration_ms } => w.message(10, |w| {
                w.uint(1, *on as u64);
                w.uint(2, *duration_ms as u64);
            }),
            Action::Brightness { level, ramp_ms } => w.message(11, |w| {
                w.float(1, *level);
                w.uint(2, *ramp_ms as u64);
            }),
            Action::Effect {
                effect_id,
                crossfade_ms,
            } => w.message(12, |w| {
                w.bytes(1, effect_id.as_bytes());
                w.uint(2, *crossfade_ms as u64);
            }),
            Action::Trigger { name } => w.message(13, |w| w.bytes(1, name.as_bytes())),
        }
    }
}

fn decode_action(which: u32, b: &[u8]) -> Result<Action, RuleError> {
    let mut on = false;
    let mut ms = 0u64;
    let mut level = 0f32;
    let mut name: Str<MAX_NAME> = Str::EMPTY;
    let mut fs = Fields::new(b);
    for f in fs.by_ref() {
        match (which, f.number, f.wt) {
            (10, 1, WT_VARINT) => on = f.value != 0,
            (11, 1, WT_I32) => level = f32::from_bits(f.value as u32),
            (12 | 13, 1, WT_LEN) => name = Str::from_bytes(f.bytes).ok_or(RuleError::BadAction)?,
            (10..=12, 2, WT_VARINT) => ms = f.value,
            (_, 1 | 2, _) => return Err(RuleError::Malformed),
            _ => {}
        }
    }
    if fs.bad {
        return Err(RuleError::Malformed);
    }
    let ms32 = u32::try_from(ms).map_err(|_| RuleError::BadAction)?;
    Ok(match which {
        10 if ms32 <= MAX_POWER_MS => Action::Power {
            on,
            duration_ms: ms32,
        },
        11 if (0.0..=1.0).contains(&level) && ms32 <= MAX_FADE_MS => Action::Brightness {
            level,
            ramp_ms: ms32,
        },
        12 if !name.is_empty() && ms32 <= MAX_FADE_MS => Action::Effect {
            effect_id: name,
            crossfade_ms: ms32,
        },
        13 if !name.is_empty() => Action::Trigger { name },
        _ => return Err(RuleError::BadAction),
    })
}

/// Iterates the `rules = 1` entries of a stored schedule file (or any message
/// whose field 1 is repeated ScheduleRule), yielding each rule's raw body.
pub fn rule_bodies(file: &[u8]) -> impl Iterator<Item = &[u8]> {
    Fields::new(file)
        .filter(|f| f.number == 1 && f.wt == WT_LEN)
        .map(|f| f.bytes)
}
