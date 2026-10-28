//! `key=value` lines: the updater's state file, its request inbox and the player's
//! health file. Plain text so a person can `cat` it on the Pi, and so the player,
//! the updater and the HITL gate (Python) all read the same thing with no parser
//! dependency. Values are single-line; binary fields are hex.

use std::collections::BTreeMap;

pub type Kv = BTreeMap<String, String>;

pub fn parse(text: &str) -> Kv {
    let mut out = Kv::new();
    for line in text.lines() {
        let line = line.trim_end_matches('\r');
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((k, v)) = line.split_once('=') {
            out.insert(k.trim().to_string(), v.to_string());
        }
    }
    out
}

/// Sorted, one `key=value` per line. Newlines in a value are dropped (they would
/// split it): every writer passes single-line values.
pub fn encode(kv: &Kv) -> String {
    let mut s = String::new();
    for (k, v) in kv {
        s.push_str(k);
        s.push('=');
        s.extend(v.chars().filter(|c| *c != '\n' && *c != '\r'));
        s.push('\n');
    }
    s
}

pub fn get_u32(kv: &Kv, k: &str) -> u32 {
    kv.get(k).and_then(|v| v.trim().parse().ok()).unwrap_or(0)
}

pub fn get_u64(kv: &Kv, k: &str) -> u64 {
    kv.get(k).and_then(|v| v.trim().parse().ok()).unwrap_or(0)
}

pub fn get_bool(kv: &Kv, k: &str) -> bool {
    matches!(kv.get(k).map(|v| v.trim()), Some("1") | Some("true"))
}

pub fn get_str(kv: &Kv, k: &str) -> String {
    kv.get(k).cloned().unwrap_or_default()
}

pub fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

pub fn unhex(s: &str) -> Option<Vec<u8>> {
    let s = s.trim();
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let mut kv = Kv::new();
        kv.insert("phase".into(), "downloading".into());
        kv.insert("manifest".into(), hex(&[1, 2, 0xff]));
        kv.insert("bad".into(), "a\nb".into());
        let back = parse(&encode(&kv));
        assert_eq!(get_str(&back, "phase"), "downloading");
        assert_eq!(unhex(&get_str(&back, "manifest")).unwrap(), vec![1, 2, 0xff]);
        assert_eq!(get_str(&back, "bad"), "ab");
        assert_eq!(get_u32(&back, "missing"), 0);
        assert!(unhex("abc").is_none());
        assert!(unhex("zz").is_none());
    }
}
