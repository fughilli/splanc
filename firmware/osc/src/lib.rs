//! On-device OSC input for shader uniforms (FUG-121).
//!
//! `no_std`, zero-dependency — buildable for the ESP32-C6 triple and unit-tested
//! on the host. This crate is the pure logic behind the firmware's native OSC
//! control surface: parse an OSC datagram, resolve each message's address to a
//! uniform slot, and hand back the values to write. The socket task and the FX
//! VM live outside (`firmware/player_app`); this crate never allocates and never
//! touches the network, so it drops straight into a `no_std` build and is driven
//! byte-for-byte by host tests.
//!
//! Three pieces:
//! - [`for_each_message`] — an OSC 1.0 wire parser (messages + nested bundles).
//! - [`PortTable`] / [`parse_manifest`] — the effect's uniform manifest reduced
//!   to a fixed-capacity `name → (slot, width)` table, built ONCE when an effect
//!   activates so the per-packet path is a short table scan, never a JSON parse.
//! - [`ingest`] — the orchestration: datagram in, `set(slot, values)` callbacks
//!   out. A per-slot value shadow lets per-axis vector messages (`/tint/x`)
//!   patch one component without clobbering the rest.
//!
//! Address convention (matches the web/TouchDesigner channel naming): a scalar
//! uniform is its bare name (`/speed`), a vecN component is `/<name>/<axis>`
//! with axis in `x`/`y`/`z`/`w` (`/tint/x`), and a whole vector can be set in
//! one message with N float args (`/tint` `,fff` r g b). A configurable prefix
//! is stripped first. When no manifest is present (or in slot-index mode) an
//! address of `N`, `sN` or `slotN` drives raw uniform slot `N`.

#![no_std]

// ---------------------------------------------------------------------------
// OSC wire parsing
// ---------------------------------------------------------------------------

/// Maximum arguments decoded per message. A uniform needs at most 4 (a vec4);
/// extra arguments are ignored (their tags still advance the cursor).
pub const MAX_ARGS: usize = 8;

/// A single decoded OSC argument. Non-numeric types are represented as
/// [`OscArg::Other`] so the type tag stays aligned with the data stream; only
/// numeric/boolean args carry a value (see [`OscArg::as_f32`]).
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum OscArg {
    Float(f32),
    Int(i32),
    Double(f64),
    Bool(bool),
    Other,
}

impl OscArg {
    /// The numeric value this argument carries, if any. Booleans map to
    /// `1.0`/`0.0` so an OSC `T`/`F` drives a toggle uniform.
    pub fn as_f32(&self) -> Option<f32> {
        match self {
            OscArg::Float(v) => Some(*v),
            OscArg::Int(v) => Some(*v as f32),
            OscArg::Double(v) => Some(*v as f32),
            OscArg::Bool(v) => Some(if *v { 1.0 } else { 0.0 }),
            OscArg::Other => None,
        }
    }
}

/// One decoded OSC message: an address (borrowed from the datagram) and its
/// arguments in a fixed inline buffer.
pub struct OscMessage<'a> {
    pub addr: &'a str,
    args: [OscArg; MAX_ARGS],
    n_args: usize,
}

impl OscMessage<'_> {
    /// The decoded arguments (up to [`MAX_ARGS`]).
    pub fn args(&self) -> &[OscArg] {
        &self.args[..self.n_args]
    }

    /// The first numeric/boolean argument, if any — the value for a scalar or a
    /// single vector component.
    pub fn first_f32(&self) -> Option<f32> {
        self.args().iter().find_map(OscArg::as_f32)
    }
}

/// Visit every message in an OSC packet (a whole UDP datagram), flattening
/// bundles. Returns `false` if the packet is malformed (the caller drops it).
pub fn for_each_message(data: &[u8], f: &mut impl FnMut(&OscMessage)) -> bool {
    match data.first() {
        Some(b'#') => parse_bundle(data, f),
        Some(b'/') => match parse_message(data) {
            Some(m) => {
                f(&m);
                true
            }
            None => false,
        },
        _ => false,
    }
}

/// [`for_each_message`] without recursion: a message, or a bundle of messages
/// (elements that are themselves bundles are skipped). For callers whose stack
/// must be statically bounded (the firmware's network task).
pub fn for_each_message_shallow(data: &[u8], f: &mut impl FnMut(&OscMessage)) -> bool {
    match data.first() {
        Some(b'/') => match parse_message(data) {
            Some(m) => {
                f(&m);
                true
            }
            None => false,
        },
        Some(b'#') => {
            if data.len() < 16 || &data[..8] != b"#bundle\0" {
                return false;
            }
            let mut pos = 16;
            while pos < data.len() {
                let Some(size) = read_i32(data, pos) else { return false };
                pos += 4;
                let Some(end) = pos.checked_add(size as usize) else { return false };
                if end > data.len() {
                    return false;
                }
                let elem = &data[pos..end];
                if elem.first() == Some(&b'/') {
                    match parse_message(elem) {
                        Some(m) => f(&m),
                        None => return false,
                    }
                }
                pos = end;
            }
            true
        }
        _ => false,
    }
}

fn parse_bundle(data: &[u8], f: &mut impl FnMut(&OscMessage)) -> bool {
    // "#bundle\0" (8) + time tag (8), then length-prefixed elements.
    if data.len() < 16 || &data[..8] != b"#bundle\0" {
        return false;
    }
    let mut pos = 16;
    while pos < data.len() {
        let Some(size) = read_i32(data, pos) else { return false };
        pos += 4;
        let size = size as usize;
        let Some(end) = pos.checked_add(size) else { return false };
        if end > data.len() {
            return false;
        }
        if !for_each_message(&data[pos..end], f) {
            return false;
        }
        pos = end;
    }
    true
}

fn parse_message(data: &[u8]) -> Option<OscMessage> {
    let mut pos = 0;
    let addr = read_osc_string(data, &mut pos)?;
    let mut msg = OscMessage { addr, args: [OscArg::Other; MAX_ARGS], n_args: 0 };

    // The type-tag string is optional in OSC 1.0; its absence means no args.
    let Some(tags) = read_osc_string(data, &mut pos) else {
        return Some(msg);
    };
    let tags = tags.strip_prefix(',').unwrap_or(tags);

    for tag in tags.bytes() {
        // Args that carry no bytes in the data stream.
        let arg = match tag {
            b'T' => Some(OscArg::Bool(true)),
            b'F' => Some(OscArg::Bool(false)),
            b'N' | b'I' => Some(OscArg::Other),
            _ => None,
        };
        if let Some(a) = arg {
            push_arg(&mut msg, a);
            continue;
        }
        // Args with a payload in the data stream.
        let a = match tag {
            b'f' => OscArg::Float(f32::from_bits(read_u32(data, pos)?)),
            b'i' => OscArg::Int(read_i32(data, pos)?),
            b'd' => OscArg::Double(f64::from_bits(read_u64(data, pos)?)),
            b'h' => OscArg::Int(read_u64(data, pos)? as i32),
            b's' | b'S' => {
                read_osc_string(data, &mut pos)?; // skip payload, keep alignment
                push_arg(&mut msg, OscArg::Other);
                continue;
            }
            b'b' => {
                let len = read_i32(data, pos)? as usize;
                pos += 4 + padded_len(len);
                push_arg(&mut msg, OscArg::Other);
                continue;
            }
            b'c' | b'r' | b'm' => {
                read_u32(data, pos)?; // single 4-byte word
                push_arg(&mut msg, OscArg::Other);
                pos += 4;
                continue;
            }
            _ => return None, // unknown tag: bail rather than misalign
        };
        push_arg(&mut msg, a);
        pos += 4;
    }
    Some(msg)
}

fn push_arg(msg: &mut OscMessage, a: OscArg) {
    if msg.n_args < MAX_ARGS {
        msg.args[msg.n_args] = a;
        msg.n_args += 1;
    }
}

/// Read a null-terminated, 4-byte-padded OSC-string at `*pos`; advance past it.
fn read_osc_string<'a>(data: &'a [u8], pos: &mut usize) -> Option<&'a str> {
    let rest = data.get(*pos..)?;
    let nul = rest.iter().position(|&b| b == 0)?;
    let s = core::str::from_utf8(&rest[..nul]).ok()?;
    *pos += padded_len(nul + 1); // include the terminator in the padded length
    Some(s)
}

/// The 4-byte-aligned length occupied by `n` content bytes.
fn padded_len(n: usize) -> usize {
    n.div_ceil(4) * 4
}

fn read_u32(data: &[u8], pos: usize) -> Option<u32> {
    let b: [u8; 4] = data.get(pos..pos + 4)?.try_into().ok()?;
    Some(u32::from_be_bytes(b))
}

fn read_i32(data: &[u8], pos: usize) -> Option<i32> {
    read_u32(data, pos).map(|v| v as i32)
}

fn read_u64(data: &[u8], pos: usize) -> Option<u64> {
    let b: [u8; 8] = data.get(pos..pos + 8)?.try_into().ok()?;
    Some(u64::from_be_bytes(b))
}

// ---------------------------------------------------------------------------
// Uniform manifest → name/slot table
// ---------------------------------------------------------------------------

/// Maximum uniforms tracked per effect (fixed capacity; extra uniforms in an
/// oversized manifest are ignored).
pub const MAX_PORTS: usize = 32;
/// Maximum uniform-name length stored (longer names are skipped — they can
/// still be driven by slot index).
pub const MAX_NAME: usize = 24;

/// One driveable uniform: its name, slot and component width.
#[derive(Clone, Copy)]
pub struct Port {
    name: [u8; MAX_NAME],
    name_len: u8,
    pub slot: u16,
    pub width: u8,
}

impl Port {
    /// The uniform's name.
    pub fn name(&self) -> &str {
        core::str::from_utf8(&self.name[..self.name_len as usize]).unwrap_or("")
    }
}

/// A fixed-capacity `name → (slot, width)` table, built once per effect.
pub struct PortTable {
    ports: [Port; MAX_PORTS],
    len: usize,
}

impl Default for PortTable {
    fn default() -> Self {
        Self::empty()
    }
}

impl PortTable {
    pub const fn empty() -> Self {
        PortTable { ports: [Port { name: [0; MAX_NAME], name_len: 0, slot: 0, width: 0 }; MAX_PORTS], len: 0 }
    }

    pub fn len(&self) -> usize {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    pub fn ports(&self) -> &[Port] {
        &self.ports[..self.len]
    }

    /// Resolve a uniform name to its port (exact match).
    pub fn resolve(&self, name: &str) -> Option<&Port> {
        self.ports().iter().find(|p| p.name() == name)
    }

    fn push(&mut self, name: &str, slot: u16, width: u8) {
        let bytes = name.as_bytes();
        if self.len >= MAX_PORTS || bytes.len() > MAX_NAME || bytes.is_empty() {
            return;
        }
        let mut p = Port { name: [0; MAX_NAME], name_len: bytes.len() as u8, slot, width };
        p.name[..bytes.len()].copy_from_slice(bytes);
        self.ports[self.len] = p;
        self.len += 1;
    }
}

/// Parse the compiler's uniform-manifest JSON into a [`PortTable`].
///
/// The manifest is the fixed-shape array `fx_compiler::manifest_json` emits:
/// `[{"name":"speed","slot":0,"width":1,"ui":{…},"default":[…]}]`. This is a
/// tolerant field scanner, not a general JSON parser: it walks top-level object
/// spans (tracking string/escape/brace state so nested `ui`/`default` don't
/// confuse it) and pulls `name`/`slot`/`width` from each. Anything it can't read
/// is skipped — the uniform is then still reachable by slot index.
pub fn parse_manifest(json: &[u8]) -> PortTable {
    let mut table = PortTable::empty();
    let mut depth = 0i32;
    let mut in_string = false;
    let mut escape = false;
    let mut obj_start = 0usize;
    for (i, &b) in json.iter().enumerate() {
        if in_string {
            if escape {
                escape = false;
            } else if b == b'\\' {
                escape = true;
            } else if b == b'"' {
                in_string = false;
            }
            continue;
        }
        match b {
            b'"' => in_string = true,
            b'{' => {
                if depth == 0 {
                    obj_start = i;
                }
                depth += 1;
            }
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    parse_object(&json[obj_start..=i], &mut table);
                }
            }
            _ => {}
        }
    }
    table
}

fn parse_object(obj: &[u8], table: &mut PortTable) {
    let (Some(name), Some(slot)) = (find_str_value(obj, b"\"name\""), find_uint_value(obj, b"\"slot\""))
    else {
        return;
    };
    let width = find_uint_value(obj, b"\"width\"").unwrap_or(1).clamp(1, 4) as u8;
    table.push(name, slot as u16, width);
}

/// Find `"key":"<value>"` within one object span and return `<value>`.
fn find_str_value<'a>(obj: &'a [u8], key: &[u8]) -> Option<&'a str> {
    let mut i = find_key(obj, key)?;
    while i < obj.len() && obj[i] != b'"' {
        i += 1;
    }
    i += 1; // opening quote
    let start = i;
    while i < obj.len() && obj[i] != b'"' {
        i += 1;
    }
    core::str::from_utf8(obj.get(start..i)?).ok()
}

/// Find `"key":<uint>` within one object span and return `<uint>`.
fn find_uint_value(obj: &[u8], key: &[u8]) -> Option<u32> {
    let mut i = find_key(obj, key)?;
    while i < obj.len() && !obj[i].is_ascii_digit() {
        // Stop if we hit the next key/section without seeing a digit.
        if obj[i] == b',' || obj[i] == b'}' {
            return None;
        }
        i += 1;
    }
    let start = i;
    while i < obj.len() && obj[i].is_ascii_digit() {
        i += 1;
    }
    core::str::from_utf8(obj.get(start..i)?).ok()?.parse().ok()
}

/// Return the index just past `key` (which includes its quotes) in `obj`.
fn find_key(obj: &[u8], key: &[u8]) -> Option<usize> {
    obj.windows(key.len()).position(|w| w == key).map(|p| p + key.len())
}

// ---------------------------------------------------------------------------
// Ingest orchestration
// ---------------------------------------------------------------------------

/// Maximum distinct uniform slots the value shadow tracks (slots `0..MAX_SLOTS`).
pub const MAX_SLOTS: usize = 32;

/// Per-slot last-written values, so a per-axis message (`/tint/x`) can patch one
/// component and re-send the whole vector without losing the others.
pub struct Shadow {
    vals: [[f32; 4]; MAX_SLOTS],
}

impl Default for Shadow {
    fn default() -> Self {
        Self::new()
    }
}

impl Shadow {
    pub const fn new() -> Self {
        Shadow { vals: [[0.0; 4]; MAX_SLOTS] }
    }

    /// Clear all shadow values (call when the active effect changes).
    pub fn reset(&mut self) {
        self.vals = [[0.0; 4]; MAX_SLOTS];
    }
}

/// How addresses are resolved to slots.
pub struct Config<'a> {
    /// OSC address prefix to strip (e.g. `/`).
    pub prefix: &'a str,
    /// `true`: resolve names via the manifest table (fallback to slot index when
    /// a name isn't found or the table is empty). `false`: slot index only —
    /// every address is a raw slot number (used to A/B the name-lookup cost).
    pub by_name: bool,
}

/// Handle one OSC datagram end to end: parse it, resolve each message to a
/// `(slot, values)` write and invoke `set(slot, &values)`. Returns the number of
/// uniform writes performed (0 for a dropped/garbage or unmatched datagram).
///
/// `set` is the sink the firmware wires to `lm_fx_set_uniform`; keeping it a
/// callback lets the whole path be exercised on the host with a recording sink.
pub fn ingest(
    data: &[u8],
    cfg: &Config,
    table: &PortTable,
    shadow: &mut Shadow,
    set: &mut impl FnMut(u16, &[f32]),
) -> usize {
    let mut writes = 0usize;
    for_each_message(data, &mut |msg| {
        if apply_message(msg, cfg, table, shadow, set) {
            writes += 1;
        }
    });
    writes
}

fn apply_message(
    msg: &OscMessage,
    cfg: &Config,
    table: &PortTable,
    shadow: &mut Shadow,
    set: &mut impl FnMut(u16, &[f32]),
) -> bool {
    let path = msg.addr.strip_prefix(cfg.prefix).unwrap_or(msg.addr).trim_matches('/');
    if path.is_empty() {
        return false;
    }
    // Split a trailing single-axis component: "tint/x" -> ("tint", Some(0)).
    let (name, axis) = match path.rsplit_once('/') {
        Some((head, tail)) if !head.is_empty() => match axis_index(tail) {
            Some(a) => (head, Some(a)),
            None => (path, None),
        },
        _ => (path, None),
    };

    let by_name = cfg.by_name && !table.is_empty();
    let (slot, width) = if by_name {
        match table.resolve(name) {
            Some(p) => (p.slot, p.width),
            None => return false, // named mode: unknown name is dropped
        }
    } else {
        // Slot-index mode: the address IS the slot number.
        match parse_slot(name) {
            Some(s) => (s, msg.numeric_width()),
            None => return false,
        }
    };
    if slot as usize >= MAX_SLOTS {
        return false;
    }

    match axis {
        Some(a) if by_name => {
            // One vector component: patch the shadow, re-send the whole vector.
            if a >= width as usize {
                return false;
            }
            let Some(v) = msg.first_f32() else { return false };
            shadow.vals[slot as usize][a] = v;
            set(slot, &shadow.vals[slot as usize][..width as usize]);
            true
        }
        _ => {
            // Whole uniform: take up to `width` numeric args, remembering them.
            let mut n = 0usize;
            for arg in msg.args() {
                if n >= width as usize {
                    break;
                }
                if let Some(v) = arg.as_f32() {
                    shadow.vals[slot as usize][n] = v;
                    n += 1;
                }
            }
            if n == 0 {
                return false;
            }
            let out_len = if by_name { width as usize } else { n };
            set(slot, &shadow.vals[slot as usize][..out_len]);
            true
        }
    }
}

impl OscMessage<'_> {
    /// The count of numeric args, clamped to `[1, 4]` — the assumed width of a
    /// slot-index write when no manifest gives one.
    fn numeric_width(&self) -> u8 {
        let n = self.args().iter().filter(|a| a.as_f32().is_some()).count();
        n.clamp(1, 4) as u8
    }
}

/// Map an axis suffix (`x`/`y`/`z`/`w`) to a component index.
fn axis_index(s: &str) -> Option<usize> {
    match s {
        "x" => Some(0),
        "y" => Some(1),
        "z" => Some(2),
        "w" => Some(3),
        _ => None,
    }
}

/// Parse a slot-index address: `N`, `sN` or `slotN`.
fn parse_slot(s: &str) -> Option<u16> {
    let digits = s.strip_prefix("slot").or_else(|| s.strip_prefix('s')).unwrap_or(s);
    digits.parse().ok()
}

// ---------------------------------------------------------------------------
// Latest-wins mailbox (docs/design/live-control.md: OSC on the netstack build)
// ---------------------------------------------------------------------------

/// Longest OSC address the [`Mailbox`] keeps (a longer one is dropped).
pub const MAILBOX_ADDR_CAP: usize = 40;

/// One waiting address. All-zero is "empty" (an OSC address is never empty: it
/// starts with '/'), so a [`Mailbox`] is zero-initialised: as a static it lands
/// in `.bss`, and the firmware can bind one into a fresh heap block. Arguments
/// are kept already converted to `f32` — the only form [`apply_message`] reads
/// (`OscArg::as_f32`) — which keeps an entry at 60 B instead of 112.
#[derive(Clone, Copy)]
struct Entry {
    addr: [u8; MAILBOX_ADDR_CAP],
    vals: [f32; 4],
    addr_len: u8,
    n_args: u8,
}

const EMPTY_ENTRY: Entry = Entry { addr: [0; MAILBOX_ADDR_CAP], vals: [0.0; 4], addr_len: 0, n_args: 0 };

impl Entry {
    fn used(&self) -> bool {
        self.addr_len != 0
    }
}

/// Received OSC messages waiting for the next frame, LATEST VALUE PER ADDRESS.
///
/// The network side [`post`](Mailbox::post)s every datagram as it arrives (cheap:
/// parse + a table scan, no VM work); the render side [`drain`](Mailbox::drain)s
/// once per frame, applying each address's newest value. A controller sending
/// faster than the device renders therefore never queues: a burst of 50 moves
/// on `/speed` between two frames costs one uniform write. Fixed capacity `N`;
/// a new address when full is dropped (counted in `dropped`).
pub struct Mailbox<const N: usize> {
    entries: [Entry; N],
    /// Messages replaced by a newer one for the same address before a drain.
    pub coalesced: u32,
    /// Messages dropped (mailbox full, or an address too long).
    pub dropped: u32,
}

impl<const N: usize> Default for Mailbox<N> {
    fn default() -> Self {
        Self::new()
    }
}

impl<const N: usize> Mailbox<N> {
    pub const fn new() -> Self {
        Mailbox { entries: [EMPTY_ENTRY; N], coalesced: 0, dropped: 0 }
    }

    /// Stash every message of one datagram (one bundle level flattened; a
    /// nested bundle is skipped — the walk is iterative, so it is stack-bounded
    /// on the network task). Returns the number of messages kept.
    pub fn post(&mut self, data: &[u8]) -> usize {
        let mut kept = 0usize;
        let (entries, coalesced, dropped) = (&mut self.entries, &mut self.coalesced, &mut self.dropped);
        for_each_message_shallow(data, &mut |m| {
            let a = m.addr.as_bytes();
            if a.len() > MAILBOX_ADDR_CAP {
                *dropped += 1;
                return;
            }
            if a.is_empty() {
                return; // parse_message only yields '/'-addresses; keep `addr_len != 0` = used
            }
            let hit = entries.iter().position(|e| e.used() && &e.addr[..e.addr_len as usize] == a);
            let i = match hit {
                Some(i) => {
                    *coalesced += 1;
                    i
                }
                None => match entries.iter().position(|e| !e.used()) {
                    Some(i) => i,
                    None => {
                        *dropped += 1;
                        return;
                    }
                },
            };
            let e = &mut entries[i];
            e.addr[..a.len()].copy_from_slice(a);
            e.addr_len = a.len() as u8;
            let mut n = 0usize;
            for v in m.args().iter().filter_map(OscArg::as_f32) {
                if n == 4 {
                    break;
                }
                e.vals[n] = v;
                n += 1;
            }
            e.n_args = n as u8;
            kept += 1;
        });
        kept
    }

    /// Messages waiting.
    pub fn len(&self) -> usize {
        self.entries.iter().filter(|e| e.used()).count()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Apply every waiting message (oldest address first) through the same
    /// resolution as [`ingest`], then empty the mailbox. Returns the writes.
    pub fn drain(
        &mut self,
        cfg: &Config,
        table: &PortTable,
        shadow: &mut Shadow,
        set: &mut impl FnMut(u16, &[f32]),
    ) -> usize {
        let mut writes = 0usize;
        for e in self.entries.iter_mut().filter(|e| e.used()) {
            let len = e.addr_len as usize;
            e.addr_len = 0;
            let Ok(addr) = core::str::from_utf8(&e.addr[..len]) else { continue };
            let mut msg = OscMessage { addr, args: [OscArg::Other; MAX_ARGS], n_args: e.n_args as usize };
            for (dst, v) in msg.args.iter_mut().zip(&e.vals[..e.n_args as usize]) {
                *dst = OscArg::Float(*v);
            }
            if apply_message(&msg, cfg, table, shadow, set) {
                writes += 1;
            }
        }
        writes
    }

    /// Forget everything waiting (the active effect changed).
    pub fn clear(&mut self) {
        for e in self.entries.iter_mut() {
            e.addr_len = 0;
        }
    }
}
