//! Uniform keypoints: named positions in an effect's parameter space, and the
//! on-device blend between them (docs/design/uniform-keypoints.md).
//!
//! `no_std`, zero-dependency, never allocates — linked into the player app and
//! host-tested byte for byte. Four pieces:
//!
//! - [`Rules`]: the effect's uniform manifest (fx_compiler JSON) reduced to a
//!   fixed table of per-uniform blend rules (slot, width, ui kind, range, step),
//!   built once per effect load. Uniform values for blending are PACKED in
//!   manifest order ([`Packed`]), so a keypoint costs its effect's real width,
//!   not the VM's 128 slots.
//! - [`blend`]: a weighted blend of packed sources under those rules — sliders
//!   lerp (snapped, clamped), colours blend in linear RGB or HSV (shortest hue),
//!   toggles/dropdowns take the heaviest source's value.
//! - [`Morph`]: the per-deck blend state the firmware advances once per frame —
//!   a live snapshot plus up to [`MAX_BLEND`] cached keypoints, eased from one
//!   weight vector to another.
//! - The storage record ([`encode_record`] / [`decode_record`]): one keypoint per
//!   small littlefs file, values keyed by uniform NAME so a recompiled effect
//!   whose slots moved still recalls correctly, stamped with the manifest hash so
//!   a stale keypoint is reported.

#![no_std]

/// Keypoints per effect (the storage index range).
pub const MAX_KEYPOINTS: usize = 16;
/// Keypoint name bytes.
pub const MAX_NAME: usize = 32;
/// Uniforms per effect the blend tracks (more are ignored, like the OSC table).
pub const MAX_PORTS: usize = 32;
/// Uniform name bytes stored in a record (fx_compiler names are short).
pub const MAX_UNIFORM_NAME: usize = 24;
/// Packed floats per keypoint (sum of the tracked uniforms' widths).
pub const MAX_FLOATS: usize = 64;
/// Keypoints one blend can mix (plus the live snapshot during a morph).
pub const MAX_BLEND: usize = 4;
/// Largest encoded record: header + every port at full name length and width 4.
pub const RECORD_CAP: usize = 4 + 1 + MAX_NAME + 4 + 1 + MAX_PORTS * (1 + MAX_UNIFORM_NAME + 1) + MAX_FLOATS * 4;

const MAGIC: &[u8; 4] = b"SKP1";

/// A packed value vector (manifest order). NaN = "this keypoint doesn't set it".
pub type Packed = [f32; MAX_FLOATS];

/// An all-unset packed vector.
pub const UNSET: Packed = [f32::NAN; MAX_FLOATS];

/// FNV-1a 32-bit (manifest hash, uniform-name hash, effect-id file key).
pub fn fnv1a(bytes: &[u8]) -> u32 {
    let mut h: u32 = 0x811c_9dc5;
    for &b in bytes {
        h ^= b as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    h
}

// ---------------------------------------------------------------------------
// Manifest → rules
// ---------------------------------------------------------------------------

/// A uniform's `ui.kind`, which picks its blend rule.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// First, so an all-zero table is valid (statics land in .bss).
    Other,
    Slider,
    Color,
    Toggle,
    Dropdown,
}

/// One tracked uniform.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rule {
    pub slot: u16,
    pub width: u8,
    /// Offset of this uniform's components in a [`Packed`] vector.
    pub off: u8,
    pub kind: Kind,
    pub min: f32,
    pub max: f32,
    /// Slider step (0 = continuous).
    pub step: f32,
    /// [`fnv1a`] of the uniform's name (records resolve by name through this).
    pub name_hash: u32,
}

const NO_RULE: Rule =
    Rule { slot: 0, width: 0, off: 0, kind: Kind::Other, min: 0.0, max: 0.0, step: 0.0, name_hash: 0 };

/// The effect's blend rules, in manifest order.
#[derive(Clone, Copy, Debug)]
pub struct Rules {
    rules: [Rule; MAX_PORTS],
    len: u8,
    floats: u8,
    /// [`fnv1a`] of the whole manifest JSON (a record saved against another
    /// build of the effect is reported stale).
    pub manifest_hash: u32,
}

impl Default for Rules {
    fn default() -> Self {
        Self::empty()
    }
}

impl Rules {
    pub const fn empty() -> Self {
        Rules { rules: [NO_RULE; MAX_PORTS], len: 0, floats: 0, manifest_hash: 0 }
    }

    /// Parse the fx_compiler manifest (`[{"name","slot","width","ui":{kind,..},
    /// "default","min","max",..}]`). Uniforms past [`MAX_PORTS`] / [`MAX_FLOATS`]
    /// are dropped (still reachable by set_uniforms, just not keypointed).
    pub fn parse(manifest: &[u8]) -> Rules {
        let mut r = Rules::empty();
        r.parse_into(manifest);
        r
    }

    /// [`Rules::parse`] in place (no stack temporary of the table).
    pub fn parse_into(&mut self, manifest: &[u8]) {
        let r = self;
        r.len = 0;
        r.floats = 0;
        r.manifest_hash = fnv1a(manifest);
        for_each_uniform(manifest, |u| {
            let width = u.width.clamp(1, 4);
            if (r.len as usize) >= MAX_PORTS || r.floats as usize + width as usize > MAX_FLOATS {
                return;
            }
            let (min, max) = match (u.min, u.max) {
                (Some(a), Some(b)) => (a, b),
                _ => match u.kind {
                    Kind::Color | Kind::Toggle => (0.0, 1.0),
                    _ => (f32::NEG_INFINITY, f32::INFINITY),
                },
            };
            r.rules[r.len as usize] = Rule {
                slot: u.slot,
                width,
                off: r.floats,
                kind: u.kind,
                min,
                max,
                step: u.step.unwrap_or(0.0).max(0.0),
                name_hash: fnv1a(u.name),
            };
            r.len += 1;
            r.floats += width;
        });
    }

    pub fn rules(&self) -> &[Rule] {
        &self.rules[..self.len as usize]
    }

    /// Total packed floats.
    pub fn floats(&self) -> usize {
        self.floats as usize
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// The rule for a uniform name.
    pub fn by_name(&self, name: &[u8]) -> Option<&Rule> {
        let h = fnv1a(name);
        self.rules().iter().find(|r| r.name_hash == h)
    }

    /// The rule whose slot range covers `slot`.
    pub fn by_slot(&self, slot: u32) -> Option<&Rule> {
        self.rules().iter().find(|r| slot >= r.slot as u32 && slot < r.slot as u32 + r.width as u32)
    }

    /// Pack a VM uniform array (slot-indexed) into manifest order.
    pub fn pack(&self, uniforms: &[f32]) -> Packed {
        let mut p = UNSET;
        for r in self.rules() {
            for k in 0..r.width as usize {
                if let Some(&v) = uniforms.get(r.slot as usize + k) {
                    p[r.off as usize + k] = v;
                }
            }
        }
        p
    }

    /// Hand each set (non-NaN) uniform of `p` to `apply(slot, values)`.
    pub fn unpack(&self, p: &Packed, mut apply: impl FnMut(u16, &[f32])) {
        for r in self.rules() {
            let v = &p[r.off as usize..r.off as usize + r.width as usize];
            if v.iter().all(|x| !x.is_nan()) {
                apply(r.slot, v);
            }
        }
    }
}

/// One manifest object, as the scanner sees it.
pub struct Uniform<'a> {
    pub name: &'a [u8],
    pub slot: u16,
    pub width: u8,
    pub kind: Kind,
    pub min: Option<f32>,
    pub max: Option<f32>,
    pub step: Option<f32>,
}

/// Walk the manifest's top-level objects, handing each uniform that has a name
/// and a slot to `f`. A small JSON pull scanner (strings, escapes, nesting), not
/// a general parser: keys are only matched in key position, so a `doc` string
/// mentioning `"min":` can't confuse it. Malformed input yields fewer uniforms,
/// never a panic.
pub fn for_each_uniform<'a>(json: &'a [u8], mut f: impl FnMut(&Uniform<'a>)) {
    let mut i = skip_ws(json, 0);
    if json.get(i) != Some(&b'[') {
        return;
    }
    i += 1;
    loop {
        i = skip_ws(json, i);
        match json.get(i) {
            Some(b'{') => {
                let mut u = Uniform { name: b"", slot: u16::MAX, width: 1, kind: Kind::Other, min: None, max: None, step: None };
                let Some(end) = scan_object(json, i, &mut u) else { return };
                if !u.name.is_empty() && u.slot != u16::MAX {
                    f(&u);
                }
                i = end;
            }
            Some(b',') => i += 1,
            _ => return,
        }
    }
}

fn skip_ws(j: &[u8], mut i: usize) -> usize {
    while i < j.len() && matches!(j[i], b' ' | b'\n' | b'\r' | b'\t') {
        i += 1;
    }
    i
}

/// A string starting at `j[i] == '"'`: returns (contents span, index after the
/// closing quote). Escapes are skipped, not decoded (names are plain ASCII).
fn scan_string(j: &[u8], i: usize) -> Option<(&[u8], usize)> {
    let mut k = i + 1;
    while k < j.len() {
        match j[k] {
            b'\\' => k += 2,
            b'"' => return Some((&j[i + 1..k], k + 1)),
            _ => k += 1,
        }
    }
    None
}

/// Skip any JSON value at `i`; returns the index after it.
fn skip_value(j: &[u8], i: usize) -> Option<usize> {
    let i = skip_ws(j, i);
    match *j.get(i)? {
        b'"' => scan_string(j, i).map(|(_, e)| e),
        b'{' | b'[' => {
            let mut depth = 0i32;
            let mut k = i;
            while k < j.len() {
                match j[k] {
                    b'"' => {
                        k = scan_string(j, k)?.1;
                        continue;
                    }
                    b'{' | b'[' => depth += 1,
                    b'}' | b']' => {
                        depth -= 1;
                        if depth == 0 {
                            return Some(k + 1);
                        }
                    }
                    _ => {}
                }
                k += 1;
            }
            None
        }
        _ => {
            let mut k = i;
            while k < j.len() && !matches!(j[k], b',' | b'}' | b']') {
                k += 1;
            }
            Some(k)
        }
    }
}

/// The uniform's `ui` object: `kind` + the slider range/step; anything else
/// (incl. nested values) is skipped. A flat walk of its own rather than a
/// recursive [`scan_object`] call, so the scanner's stack is statically bounded
/// (the firmware stack gate rejects recursion).
fn scan_ui<'a>(j: &'a [u8], i: usize, u: &mut Uniform<'a>) -> Option<usize> {
    let mut k = i + 1;
    loop {
        k = skip_ws(j, k);
        match *j.get(k)? {
            b'}' => return Some(k + 1),
            b',' => k += 1,
            b'"' => {
                let (key, e) = scan_string(j, k)?;
                k = skip_ws(j, e);
                if j.get(k) != Some(&b':') {
                    return None;
                }
                k = skip_ws(j, k + 1);
                match key {
                    b"kind" if j.get(k) == Some(&b'"') => {
                        let (s, e) = scan_string(j, k)?;
                        u.kind = match s {
                            b"slider" => Kind::Slider,
                            b"color" => Kind::Color,
                            b"toggle" => Kind::Toggle,
                            b"dropdown" => Kind::Dropdown,
                            _ => Kind::Other,
                        };
                        k = e;
                    }
                    // The top-level range wins (explicit for every kind); the
                    // slider's ui range is the same number when both exist.
                    b"min" => {
                        if u.min.is_none() {
                            u.min = parse_num(j, k);
                        }
                        k = skip_value(j, k)?;
                    }
                    b"max" => {
                        if u.max.is_none() {
                            u.max = parse_num(j, k);
                        }
                        k = skip_value(j, k)?;
                    }
                    b"step" => {
                        u.step = parse_num(j, k);
                        k = skip_value(j, k)?;
                    }
                    _ => k = skip_value(j, k)?,
                }
            }
            _ => return None,
        }
    }
}

/// Scan one uniform object at `j[i] == '{'` into `u`; returns the index after
/// its closing brace.
fn scan_object<'a>(j: &'a [u8], i: usize, u: &mut Uniform<'a>) -> Option<usize> {
    let mut k = i + 1;
    loop {
        k = skip_ws(j, k);
        match *j.get(k)? {
            b'}' => return Some(k + 1),
            b',' => k += 1,
            b'"' => {
                let (key, e) = scan_string(j, k)?;
                k = skip_ws(j, e);
                if j.get(k) != Some(&b':') {
                    return None;
                }
                k = skip_ws(j, k + 1);
                match key {
                    b"name" if j.get(k) == Some(&b'"') => {
                        let (s, e) = scan_string(j, k)?;
                        u.name = s;
                        k = e;
                    }
                    b"slot" => {
                        u.slot = parse_num(j, k).map(|v| v as u16).unwrap_or(u16::MAX);
                        k = skip_value(j, k)?;
                    }
                    b"width" => {
                        u.width = parse_num(j, k).map(|v| v as u8).unwrap_or(1);
                        k = skip_value(j, k)?;
                    }
                    b"ui" if j.get(k) == Some(&b'{') => k = scan_ui(j, k, u)?,
                    // Explicit for every kind (wins over the slider's ui range).
                    b"min" => {
                        u.min = parse_num(j, k);
                        k = skip_value(j, k)?;
                    }
                    b"max" => {
                        u.max = parse_num(j, k);
                        k = skip_value(j, k)?;
                    }
                    _ => k = skip_value(j, k)?,
                }
            }
            _ => return None,
        }
    }
}

/// Parse a JSON number at `j[i..]` (sign, digits, fraction, exponent).
fn parse_num(j: &[u8], i: usize) -> Option<f32> {
    let mut k = i;
    let neg = j.get(k) == Some(&b'-');
    if neg {
        k += 1;
    }
    let mut v: f64 = 0.0;
    let mut any = false;
    while let Some(&c) = j.get(k).filter(|c| c.is_ascii_digit()) {
        v = v * 10.0 + (c - b'0') as f64;
        k += 1;
        any = true;
    }
    if j.get(k) == Some(&b'.') {
        k += 1;
        let mut scale = 0.1;
        while let Some(&c) = j.get(k).filter(|c| c.is_ascii_digit()) {
            v += (c - b'0') as f64 * scale;
            scale *= 0.1;
            k += 1;
            any = true;
        }
    }
    if !any {
        return None;
    }
    if matches!(j.get(k), Some(b'e' | b'E')) {
        k += 1;
        let eneg = j.get(k) == Some(&b'-');
        if matches!(j.get(k), Some(b'-' | b'+')) {
            k += 1;
        }
        let mut e: i32 = 0;
        while let Some(&c) = j.get(k).filter(|c| c.is_ascii_digit()) {
            e = e.saturating_mul(10).saturating_add((c - b'0') as i32);
            k += 1;
        }
        let e = e.min(60);
        for _ in 0..e {
            if eneg {
                v /= 10.0;
            } else {
                v *= 10.0;
            }
        }
    }
    Some(if neg { -v as f32 } else { v as f32 })
}

// ---------------------------------------------------------------------------
// Blend
// ---------------------------------------------------------------------------

fn floorf(x: f32) -> f32 {
    let i = x as i64 as f32;
    if i > x {
        i - 1.0
    } else {
        i
    }
}

fn fract(x: f32) -> f32 {
    x - floorf(x)
}

/// RGB (0..1) → HSV (hue 0..1 wrapping). Grey reports hue 0, saturation 0.
pub fn rgb_to_hsv(r: f32, g: f32, b: f32) -> (f32, f32, f32) {
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let d = max - min;
    let s = if max <= 0.0 { 0.0 } else { d / max };
    let h = if d <= 0.0 {
        0.0
    } else if max == r {
        ((g - b) / d) / 6.0
    } else if max == g {
        ((b - r) / d + 2.0) / 6.0
    } else {
        ((r - g) / d + 4.0) / 6.0
    };
    (fract(h), s, max)
}

/// HSV → RGB (all 0..1).
pub fn hsv_to_rgb(h: f32, s: f32, v: f32) -> (f32, f32, f32) {
    let h6 = fract(h) * 6.0;
    let sector = floorf(h6);
    let f = h6 - sector;
    let p = v * (1.0 - s);
    let q = v * (1.0 - s * f);
    let t = v * (1.0 - s * (1.0 - f));
    match sector as i32 {
        0 => (v, t, p),
        1 => (q, v, p),
        2 => (p, v, t),
        3 => (p, q, v),
        4 => (t, p, v),
        _ => (v, p, q),
    }
}

/// Move hue `a` toward `b` by `t` along the shorter arc of the [0,1) circle.
pub fn hue_lerp(a: f32, b: f32, t: f32) -> f32 {
    let mut d = b - a;
    if d > 0.5 {
        d -= 1.0;
    } else if d < -0.5 {
        d += 1.0;
    }
    fract(a + t * d)
}

/// Colour blend space for `color` uniforms.
pub const COLOR_RGB: u32 = 0;
pub const COLOR_HSV: u32 = 1;

/// Blend packed `sources` by `weights` under `rules` into `out`. Weights are
/// normalised over the positive ones (all zero → `out` untouched). A NaN
/// component in a source falls back to `fill` (the live value), so a keypoint
/// that never set a uniform leaves it where it is. Uniforms NaN in `fill` and
/// every weighted source stay NaN (not applied).
pub fn blend(rules: &Rules, sources: &[&Packed], weights: &[f32], fill: &Packed, color_mode: u32, out: &mut Packed) {
    let n = sources.len().min(weights.len());
    let total: f32 = weights[..n].iter().filter(|w| **w > 0.0).sum();
    if total <= 0.0 {
        return;
    }
    let w = |i: usize| if weights[i] > 0.0 { weights[i] / total } else { 0.0 };
    let val = |i: usize, c: usize| {
        let v = sources[i][c];
        if v.is_nan() {
            fill[c]
        } else {
            v
        }
    };
    for r in rules.rules() {
        let (o, wd) = (r.off as usize, r.width as usize);
        match r.kind {
            Kind::Toggle | Kind::Dropdown => {
                // Nearest: the heaviest source's value (first on a tie).
                let mut best = 0;
                for i in 1..n {
                    if weights[i] > weights[best] {
                        best = i;
                    }
                }
                for c in o..o + wd {
                    out[c] = val(best, c);
                }
            }
            Kind::Color if color_mode == COLOR_HSV && wd >= 3 => {
                // Hue blended pairwise in source order along the shorter arc
                // (exact for two sources; order-dependent but smooth for more),
                // grey sources contributing no hue. S/V (and alpha) sum linearly.
                let (mut h, mut has_h, mut acc) = (0.0f32, false, 0.0f32);
                let (mut s, mut v) = (0.0f32, 0.0f32);
                let mut nan = false;
                for i in 0..n {
                    let wi = w(i);
                    if wi <= 0.0 {
                        continue;
                    }
                    let (rr, gg, bb) = (val(i, o), val(i, o + 1), val(i, o + 2));
                    if rr.is_nan() || gg.is_nan() || bb.is_nan() {
                        nan = true;
                        break;
                    }
                    let (hi, si, vi) = rgb_to_hsv(rr, gg, bb);
                    s += wi * si;
                    v += wi * vi;
                    if si > 1e-4 {
                        if has_h {
                            h = hue_lerp(h, hi, wi / (acc + wi));
                        } else {
                            h = hi;
                            has_h = true;
                        }
                        acc += wi;
                    }
                }
                if nan {
                    for c in o..o + wd {
                        out[c] = f32::NAN;
                    }
                    continue;
                }
                let (rr, gg, bb) = hsv_to_rgb(h, s.clamp(0.0, 1.0), v);
                out[o] = rr.clamp(r.min, r.max);
                out[o + 1] = gg.clamp(r.min, r.max);
                out[o + 2] = bb.clamp(r.min, r.max);
                for c in o + 3..o + wd {
                    out[c] = (0..n).map(|i| w(i) * val(i, c)).sum::<f32>();
                }
            }
            _ => {
                for c in o..o + wd {
                    let mut x = 0.0f32;
                    for i in 0..n {
                        let wi = w(i);
                        if wi > 0.0 {
                            x += wi * val(i, c);
                        }
                    }
                    if r.kind == Kind::Slider && r.step > 0.0 && r.min.is_finite() {
                        x = r.min + floorf((x - r.min) / r.step + 0.5) * r.step;
                    }
                    if r.min <= r.max {
                        x = x.clamp(r.min, r.max);
                    }
                    out[c] = x;
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Morph (per-deck blend state)
// ---------------------------------------------------------------------------

/// A deck's keypoint blend: the effect's rules, a live snapshot, the cached
/// keypoint sources of the last blend and (while morphing) the weight ramp.
/// Source 0 is the live snapshot; 1..=MAX_BLEND are keypoints.
pub struct Morph {
    pub rules: Rules,
    live: Packed,
    kp: [Packed; MAX_BLEND],
    /// The cached keypoints' names (fnv1a) + the effect they were read for;
    /// a blend over the same names reuses them without touching flash.
    kp_hash: [u32; MAX_BLEND],
    kp_n: u8,
    kp_effect: u32,
    w_from: [f32; MAX_BLEND + 1],
    w_to: [f32; MAX_BLEND + 1],
    elapsed: f32,
    seconds: f32,
    running: bool,
    color_mode: u32,
}

impl Default for Morph {
    fn default() -> Self {
        Self::new()
    }
}

impl Morph {
    /// All-zero (so a `static` of it lands in .bss, not .data): the source
    /// buffers are only read after [`Morph::start`] / [`Morph::push_source`]
    /// filled them.
    pub const fn new() -> Self {
        Morph {
            rules: Rules::empty(),
            live: [0.0; MAX_FLOATS],
            kp: [[0.0; MAX_FLOATS]; MAX_BLEND],
            kp_hash: [0; MAX_BLEND],
            kp_n: 0,
            kp_effect: 0,
            w_from: [0.0; MAX_BLEND + 1],
            w_to: [0.0; MAX_BLEND + 1],
            elapsed: 0.0,
            seconds: 0.0,
            running: false,
            color_mode: 0,
        }
    }

    /// A fresh effect on the deck: rebuild the rules, drop every cache. (Field
    /// by field, never `*self = ..`: on the device the ~2 KB struct must not pass
    /// through a stack temporary.)
    pub fn reset(&mut self, manifest: &[u8]) {
        self.clear();
        self.rules.parse_into(manifest);
    }

    /// Clear the deck (no effect).
    pub fn clear(&mut self) {
        self.rules.len = 0;
        self.rules.floats = 0;
        self.rules.manifest_hash = 0;
        self.invalidate();
        self.running = false;
        self.w_to = [0.0; MAX_BLEND + 1];
    }

    pub fn running(&self) -> bool {
        self.running
    }

    /// Stop a morph where it is (a set_uniforms took over).
    pub fn cancel(&mut self) {
        self.running = false;
    }

    /// Whether the cached sources are exactly `names` for `effect` (in order).
    pub fn cached(&self, effect: u32, names: &[&[u8]]) -> bool {
        self.kp_effect == effect
            && self.kp_n as usize == names.len()
            && names.iter().zip(&self.kp_hash).all(|(n, h)| fnv1a(n) == *h)
    }

    /// Start (re)filling the keypoint cache for `effect`.
    pub fn begin_sources(&mut self, effect: u32) {
        self.kp_effect = effect;
        self.kp_n = 0;
    }

    /// Append one keypoint's packed values to the cache. False when full.
    pub fn push_source(&mut self, name: &[u8], values: &Packed) -> bool {
        let k = self.kp_n as usize;
        if k >= MAX_BLEND {
            return false;
        }
        self.kp[k] = *values;
        self.kp_hash[k] = fnv1a(name);
        self.kp_n += 1;
        true
    }

    /// Drop the cache (e.g. a keypoint was re-saved or deleted).
    pub fn invalidate(&mut self) {
        self.kp_n = 0;
        self.kp_effect = 0;
    }

    /// Begin a blend toward `weights` (one per cached source, in order). `live` =
    /// the deck's current values, packed. `seconds` <= 0 → returns the blended
    /// target at once (apply it); > 0 → starts a morph from `live` and returns
    /// None (advance() applies it per frame).
    pub fn start(&mut self, live: &Packed, weights: &[f32], seconds: f32, color_mode: u32) -> Option<Packed> {
        self.live = *live;
        self.color_mode = color_mode;
        let n = self.kp_n as usize;
        let mut to = [0.0f32; MAX_BLEND + 1];
        for (i, w) in weights.iter().take(n).enumerate() {
            to[i + 1] = w.max(0.0);
        }
        if seconds > 0.0 {
            self.w_from = [0.0; MAX_BLEND + 1];
            self.w_from[0] = 1.0;
            self.w_to = to;
            self.elapsed = 0.0;
            self.seconds = seconds;
            self.running = true;
            None
        } else {
            self.running = false;
            self.w_to = to;
            Some(self.eval(&to))
        }
    }

    /// The target of the current/last blend (what a `commit` persists).
    pub fn target(&self) -> Packed {
        self.eval(&self.w_to)
    }

    fn eval(&self, w: &[f32; MAX_BLEND + 1]) -> Packed {
        let n = self.kp_n as usize;
        let mut srcs: [&Packed; MAX_BLEND + 1] = [&self.live; MAX_BLEND + 1];
        for i in 0..n {
            srcs[i + 1] = &self.kp[i];
        }
        let mut out = self.live;
        blend(&self.rules, &srcs[..n + 1], &w[..n + 1], &self.live, self.color_mode, &mut out);
        out
    }

    /// Advance a running morph by `dt` seconds; the values to apply this frame
    /// (None when not morphing). The last step lands exactly on the target.
    pub fn advance(&mut self, dt: f32) -> Option<Packed> {
        if !self.running {
            return None;
        }
        self.elapsed += dt.max(0.0);
        let p = (self.elapsed / self.seconds).clamp(0.0, 1.0);
        let e = p * p * (3.0 - 2.0 * p); // smoothstep
        let mut w = [0.0f32; MAX_BLEND + 1];
        for (i, x) in w.iter_mut().enumerate() {
            *x = self.w_from[i] + (self.w_to[i] - self.w_from[i]) * e;
        }
        if p >= 1.0 {
            self.running = false;
        }
        Some(self.eval(&w))
    }
}

// ---------------------------------------------------------------------------
// Storage record
// ---------------------------------------------------------------------------

/// Why a record couldn't be built or read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RecordError {
    /// Name empty or longer than [`MAX_NAME`].
    BadName,
    /// The output buffer is smaller than the record.
    TooBig,
    /// Not a keypoint record (magic / truncation).
    Corrupt,
}

/// Header of a stored record.
#[derive(Clone, Copy, Debug)]
pub struct RecordInfo<'a> {
    pub name: &'a [u8],
    pub manifest_hash: u32,
}

/// Encode keypoint `name` holding the set uniforms of `values` (packed under
/// `rules`, names taken from `manifest`) into `out`. Returns the length.
///
/// Layout: `"SKP1"`, u8 name_len, name, u32 manifest_hash (LE), u8 n, then per
/// uniform: u8 name_len, name, u8 width, width × f32 LE.
pub fn encode_record(
    name: &[u8],
    manifest: &[u8],
    rules: &Rules,
    values: &Packed,
    out: &mut [u8],
) -> Result<usize, RecordError> {
    if name.is_empty() || name.len() > MAX_NAME {
        return Err(RecordError::BadName);
    }
    let mut w = Wr { out, n: 0, ok: true };
    w.put(MAGIC);
    w.put(&[name.len() as u8]);
    w.put(name);
    w.put(&rules.manifest_hash.to_le_bytes());
    let count_at = w.n;
    w.put(&[0]);
    let mut count = 0u8;
    // Names come from the manifest in the same order the rules were built; a
    // name is matched to its rule by hash (the rules dropped any over-cap ones).
    for_each_uniform(manifest, |u| {
        let Some(r) = rules.by_name(u.name) else { return };
        if u.name.len() > MAX_UNIFORM_NAME {
            return;
        }
        let v = &values[r.off as usize..r.off as usize + r.width as usize];
        if v.iter().any(|x| x.is_nan()) {
            return;
        }
        w.put(&[u.name.len() as u8]);
        w.put(u.name);
        w.put(&[r.width]);
        for x in v {
            w.put(&x.to_le_bytes());
        }
        count += 1;
    });
    if !w.ok {
        return Err(RecordError::TooBig);
    }
    w.out[count_at] = count;
    Ok(w.n)
}

struct Wr<'a> {
    out: &'a mut [u8],
    n: usize,
    ok: bool,
}

impl Wr<'_> {
    fn put(&mut self, b: &[u8]) {
        match self.out.get_mut(self.n..self.n + b.len()) {
            Some(d) => d.copy_from_slice(b),
            None => self.ok = false,
        }
        self.n += b.len();
    }
}

/// Read a record's header (name + manifest hash).
pub fn record_info(buf: &[u8]) -> Result<RecordInfo<'_>, RecordError> {
    if buf.get(..4) != Some(MAGIC) {
        return Err(RecordError::Corrupt);
    }
    let nl = *buf.get(4).ok_or(RecordError::Corrupt)? as usize;
    let name = buf.get(5..5 + nl).ok_or(RecordError::Corrupt)?;
    let h = buf.get(5 + nl..9 + nl).ok_or(RecordError::Corrupt)?;
    Ok(RecordInfo { name, manifest_hash: u32::from_le_bytes([h[0], h[1], h[2], h[3]]) })
}

/// Walk a record's stored values: `f(uniform_name, values)`.
pub fn for_each_value(buf: &[u8], mut f: impl FnMut(&[u8], &[f32])) -> Result<(), RecordError> {
    let info = record_info(buf)?;
    let mut o = 9 + info.name.len();
    let n = *buf.get(o).ok_or(RecordError::Corrupt)?;
    o += 1;
    for _ in 0..n {
        let ul = *buf.get(o).ok_or(RecordError::Corrupt)? as usize;
        let uname = buf.get(o + 1..o + 1 + ul).ok_or(RecordError::Corrupt)?;
        o += 1 + ul;
        let wd = (*buf.get(o).ok_or(RecordError::Corrupt)? as usize).min(4);
        o += 1;
        let mut v = [0.0f32; 4];
        for (k, x) in v.iter_mut().enumerate().take(wd) {
            let b = buf.get(o + 4 * k..o + 4 * k + 4).ok_or(RecordError::Corrupt)?;
            *x = f32::from_le_bytes([b[0], b[1], b[2], b[3]]);
        }
        o += 4 * wd;
        f(uname, &v[..wd]);
    }
    Ok(())
}

/// Decode a record into packed values under `rules` (uniforms the effect no
/// longer declares, or whose width changed, are skipped → NaN). Returns the
/// header and whether it is stale (saved against another manifest).
pub fn decode_record<'a>(buf: &'a [u8], rules: &Rules, out: &mut Packed) -> Result<(RecordInfo<'a>, bool), RecordError> {
    let info = record_info(buf)?;
    *out = UNSET;
    for_each_value(buf, |uname, v| {
        if let Some(r) = rules.by_name(uname) {
            if r.width as usize == v.len() {
                out[r.off as usize..r.off as usize + v.len()].copy_from_slice(v);
            }
        }
    })?;
    Ok((info, info.manifest_hash != rules.manifest_hash))
}
