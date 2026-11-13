//! Read what discovery needs from a WLED board's `GET /json/info` reply: its
//! name, version, MAC and LED count. A small scanner rather than a JSON
//! library: it walks the object once, tracks nesting, and picks the top-level
//! `name`, `ver`, `mac` and `leds.count` (WLED nests other objects with their
//! own `name`-like keys, e.g. `wifi`, `fs`, `maps`). Bounded by the input; never
//! allocates.

pub const NAME_MAX: usize = 32;
pub const VERSION_MAX: usize = 16;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct WledInfo {
    pub name: [u8; NAME_MAX],
    pub name_len: u8,
    pub version: [u8; VERSION_MAX],
    pub version_len: u8,
    /// All zero = not reported.
    pub mac: [u8; 6],
    pub led_count: u32,
}

impl WledInfo {
    pub fn name(&self) -> &[u8] {
        &self.name[..self.name_len as usize]
    }
    pub fn version(&self) -> &[u8] {
        &self.version[..self.version_len as usize]
    }
}

/// Copy a JSON string body into `out` (a `\\x` escape keeps `x`, so `\\"`
/// keeps its quote), cut at a UTF-8 character boundary. Returns the length.
fn copy_str(s: &[u8], out: &mut [u8]) -> u8 {
    let (mut n, mut i) = (0, 0);
    while i < s.len() && n < out.len() {
        if s[i] == b'\\' && i + 1 < s.len() {
            i += 1;
        }
        out[n] = s[i];
        n += 1;
        i += 1;
    }
    if i < s.len() {
        // Cut short: drop a trailing character that didn't fit whole.
        let mut lead = n;
        while lead > 0 && (out[lead - 1] & 0xC0) == 0x80 {
            lead -= 1;
        }
        if lead > 0 && out[lead - 1] >= 0xC0 {
            let b = out[lead - 1];
            let want = if b >= 0xF0 {
                4
            } else if b >= 0xE0 {
                3
            } else {
                2
            };
            if n - (lead - 1) < want {
                n = lead - 1;
            }
        }
    }
    n as u8
}

fn hex(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

/// WLED reports the MAC as 12 hex digits ("c0cdd6e9fb14"); colons are accepted too.
fn parse_mac(s: &[u8]) -> Option<[u8; 6]> {
    let mut m = [0u8; 6];
    let mut k = 0;
    let mut hi: Option<u8> = None;
    for &c in s {
        if c == b':' || c == b'-' {
            continue;
        }
        let d = hex(c)?;
        match hi.take() {
            None => hi = Some(d),
            Some(h) => {
                *m.get_mut(k)? = (h << 4) | d;
                k += 1;
            }
        }
    }
    (k == 6 && hi.is_none()).then_some(m)
}

/// Parse a `/json/info` body. None if it isn't a JSON object or has no `leds`
/// object with a `count` (not a WLED board, or an unrelated server).
pub fn parse_info(json: &[u8]) -> Option<WledInfo> {
    let mut info = WledInfo::default();
    let mut found_count = false;
    let mut depth = 0usize;
    // Inside the top-level "leds" object (at depth 2).
    let mut in_leds = false;
    // The key just read at this depth, waiting for its value.
    let mut key: &[u8] = &[];
    let mut expecting_value = false;
    let mut i = 0;
    let b = json;
    // Skip leading whitespace; must start with '{'.
    while i < b.len() && b[i].is_ascii_whitespace() {
        i += 1;
    }
    if b.get(i) != Some(&b'{') {
        return None;
    }
    while i < b.len() {
        let c = b[i];
        match c {
            b'"' => {
                // A string: find its end, honouring escapes.
                let start = i + 1;
                let mut j = start;
                while j < b.len() && b[j] != b'"' {
                    if b[j] == b'\\' {
                        j += 1;
                    }
                    j += 1;
                }
                if j >= b.len() {
                    return None; // unterminated
                }
                let s = &b[start..j];
                i = j + 1;
                if expecting_value {
                    expecting_value = false;
                    if depth == 1 {
                        match key {
                            b"name" => info.name_len = copy_str(s, &mut info.name),
                            b"ver" => info.version_len = copy_str(s, &mut info.version),
                            b"mac" => info.mac = parse_mac(s).unwrap_or([0; 6]),
                            _ => {}
                        }
                    }
                } else {
                    key = s;
                }
                continue;
            }
            b':' => expecting_value = true,
            b',' => expecting_value = false,
            b'{' | b'[' => {
                if expecting_value && depth == 1 && c == b'{' && key == b"leds" {
                    in_leds = true;
                }
                expecting_value = false;
                depth += 1;
            }
            b'}' | b']' => {
                depth = depth.checked_sub(1)?;
                if depth == 1 {
                    in_leds = false;
                }
                if depth == 0 {
                    break;
                }
            }
            b'0'..=b'9' if expecting_value => {
                let start = i;
                while i < b.len() && b[i].is_ascii_digit() {
                    i += 1;
                }
                if in_leds && depth == 2 && key == b"count" {
                    let mut v: u32 = 0;
                    for &d in &b[start..i] {
                        v = v.saturating_mul(10).saturating_add((d - b'0') as u32);
                    }
                    info.led_count = v;
                    found_count = true;
                }
                expecting_value = false;
                continue;
            }
            _ => {}
        }
        i += 1;
    }
    found_count.then_some(info)
}
