//! The MAX image (`max-<board>-<ver>.nixclosure`, docs/design/max-ota.md "The
//! update unit"): a short text header, then a zstd-compressed `nix-store --export`
//! stream of the store paths the device needs.
//!
//! ```text
//! SPLANC-MAX-OTA 1
//! board: pi3
//! version: 1010000
//! toplevel: /nix/store/…-nixos-system-ledmapper-…
//! compression: zstd
//! base: /nix/store/…        (zero or more: paths NOT in the stream, a delta's base)
//! <blank line>
//! <zstd(nix-store --export PATHS)>
//! ```
//!
//! The whole file (header included) is what the manifest's size and sha256 cover,
//! so the header is as authenticated as the payload. A full image has no `base:`
//! lines; a delta lists the paths it leaves out, and the updater refuses it
//! (`missing_base`) unless every one is already valid in the device's store.
//! tools/max_ota_release.py writes this format.

pub const MAGIC: &str = "SPLANC-MAX-OTA 1";
/// The header must end (blank line) within this many bytes.
pub const MAX_HEADER: usize = 1 << 20;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Header {
    pub board: String,
    pub version: u32,
    pub toplevel: String,
    pub compression: String,
    pub base: Vec<String>,
    /// Header bytes including the blank line: where the payload starts.
    pub len: usize,
}

fn store_path_ok(p: &str) -> bool {
    let Some(rest) = p.strip_prefix("/nix/store/") else {
        return false;
    };
    // <32-char hash>-<name>, one path component, no shell or whitespace surprises.
    rest.len() > 33
        && rest.as_bytes()[32] == b'-'
        && rest.bytes().all(|c| c.is_ascii_alphanumeric() || b"+-._?=".contains(&c))
}

pub fn parse_header(buf: &[u8]) -> Result<Header, &'static str> {
    let end = buf
        .windows(2)
        .take(MAX_HEADER)
        .position(|w| w == b"\n\n")
        .ok_or("no header end")?;
    let text = std::str::from_utf8(&buf[..end]).map_err(|_| "header not utf-8")?;
    let mut lines = text.lines();
    if lines.next() != Some(MAGIC) {
        return Err("bad magic");
    }
    let mut h = Header { board: String::new(), version: 0, toplevel: String::new(), compression: String::new(), base: vec![], len: end + 2 };
    for line in lines {
        let (k, v) = line.split_once(": ").ok_or("bad header line")?;
        match k {
            "board" => h.board = v.to_string(),
            "version" => h.version = v.parse().map_err(|_| "bad version")?,
            "toplevel" => h.toplevel = v.to_string(),
            "compression" => h.compression = v.to_string(),
            "base" => {
                if !store_path_ok(v) {
                    return Err("bad base path");
                }
                h.base.push(v.to_string())
            }
            _ => {} // forward compatible: unknown keys are ignored
        }
    }
    if !store_path_ok(&h.toplevel) {
        return Err("bad toplevel");
    }
    if h.compression != "zstd" {
        return Err("unsupported compression");
    }
    if h.board.is_empty() || h.version == 0 {
        return Err("missing board or version");
    }
    Ok(h)
}

/// The header bytes (tests; the release tool writes the same in Python).
pub fn encode_header(board: &str, version: u32, toplevel: &str, base: &[String]) -> Vec<u8> {
    let mut s = format!("{MAGIC}\nboard: {board}\nversion: {version}\ntoplevel: {toplevel}\ncompression: zstd\n");
    for b in base {
        s.push_str(&format!("base: {b}\n"));
    }
    s.push('\n');
    s.into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOP: &str = "/nix/store/0123456789abcdfghijklmnpqrsvwxyz-nixos-system-ledmapper-25.05";
    const BASE: &str = "/nix/store/zyxwvsrqpnmlkjihgfdcba9876543210-glibc-2.40";

    #[test]
    fn header_roundtrip() {
        let mut b = encode_header("pi3", 1_010_000, TOP, &[BASE.into()]);
        let n = b.len();
        b.extend_from_slice(b"\x28\xb5\x2f\xfdpayload");
        let h = parse_header(&b).unwrap();
        assert_eq!(h.board, "pi3");
        assert_eq!(h.version, 1_010_000);
        assert_eq!(h.toplevel, TOP);
        assert_eq!(h.base, vec![BASE.to_string()]);
        assert_eq!(h.len, n);
        assert_eq!(&b[h.len..h.len + 4], b"\x28\xb5\x2f\xfd");
    }

    #[test]
    fn header_refusals() {
        assert!(parse_header(b"nope\n\n").is_err());
        assert!(parse_header(encode_header("pi3", 1, "/tmp/x", &[]).as_slice()).is_err());
        assert!(parse_header(encode_header("pi3", 1, TOP, &["/nix/store/x y".into()]).as_slice()).is_err());
        assert!(parse_header(encode_header("pi3", 0, TOP, &[]).as_slice()).is_err());
        let gz = format!("{MAGIC}\nboard: pi3\nversion: 1\ntoplevel: {TOP}\ncompression: gzip\n\n");
        assert_eq!(parse_header(gz.as_bytes()), Err("unsupported compression"));
        assert_eq!(parse_header(MAGIC.as_bytes()), Err("no header end"));
    }
}
