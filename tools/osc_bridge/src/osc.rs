//! A minimal, dependency-free OSC 1.0 parser — just enough to receive control
//! messages from a DAW / VJ tool and read their numeric arguments.
//!
//! OSC is a tiny binary format so, following this repo's hand-rolled-protobuf
//! (`crate::proto`) and hand-rolled-WebSocket (`crate::ws`) style, we parse it
//! by hand rather than pulling in a crate (which would need a crates.io re-lock
//! the offline fleet build can't do). We decode exactly what the bridge uses:
//!
//! - **Messages**: an OSC-string address, an OSC-string type tag (`,` + tags),
//!   then one big-endian argument per tag.
//! - **Bundles**: `#bundle\0` + an 8-byte time tag + length-prefixed elements,
//!   each itself a message or a (nested) bundle — flattened recursively.
//!
//! Only the argument types the bridge cares about carry a value; everything
//! else (strings, blobs, …) is skipped so an unknown tag never derails parsing
//! of the arguments that matter.
//!
//! All OSC data is 4-byte aligned and big-endian (OSC 1.0 §Atomic Data Types).

/// A single decoded OSC argument. Non-numeric types are represented so the type
/// tag stays aligned with the data stream, but the bridge only consumes the
/// numeric/boolean ones (see [`OscArg::as_f32`]).
#[derive(Debug, Clone, PartialEq)]
pub enum OscArg {
    Float(f32),
    Int(i32),
    Double(f64),
    Bool(bool),
    /// A parsed but unused type (string, blob, char, …) — kept only to preserve
    /// the tag-to-argument correspondence during decoding.
    Other,
}

impl OscArg {
    /// The numeric value a control argument carries, if any. Booleans map to
    /// `1.0` / `0.0` so an OSC `T`/`F` toggle drives a uniform like a knob at 1
    /// or 0. `None` for non-numeric arguments.
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

/// One decoded OSC message: its address pattern and its arguments in order.
#[derive(Debug, Clone, PartialEq)]
pub struct OscMessage {
    pub addr: String,
    pub args: Vec<OscArg>,
}

/// Parse one OSC packet (a whole UDP datagram) into its flattened messages.
///
/// A bundle yields all of its element messages in order; a bare message yields
/// one. Returns `None` if the packet isn't valid OSC (so the caller can drop a
/// stray/garbage datagram rather than crash).
pub fn parse_packet(data: &[u8]) -> Option<Vec<OscMessage>> {
    let mut out = Vec::new();
    parse_into(data, &mut out)?;
    Some(out)
}

fn parse_into(data: &[u8], out: &mut Vec<OscMessage>) -> Option<()> {
    if data.first() == Some(&b'#') {
        parse_bundle(data, out)
    } else if data.first() == Some(&b'/') {
        out.push(parse_message(data)?);
        Some(())
    } else {
        None
    }
}

fn parse_bundle(data: &[u8], out: &mut Vec<OscMessage>) -> Option<()> {
    // "#bundle\0" (8) + time tag (8), then length-prefixed elements.
    if data.len() < 16 || &data[..8] != b"#bundle\0" {
        return None;
    }
    let mut pos = 16;
    while pos < data.len() {
        let size = read_i32(data, pos)? as usize;
        pos += 4;
        let end = pos.checked_add(size)?;
        if end > data.len() {
            return None;
        }
        parse_into(&data[pos..end], out)?;
        pos = end;
    }
    Some(())
}

fn parse_message(data: &[u8]) -> Option<OscMessage> {
    let mut pos = 0;
    let addr = read_osc_string(data, &mut pos)?;
    // A type-tag string is technically optional in OSC 1.0; treat its absence
    // as a no-argument message.
    let tags = match read_osc_string(data, &mut pos) {
        Some(t) => t,
        None => return Some(OscMessage { addr, args: Vec::new() }),
    };
    let tags = tags.strip_prefix(',').unwrap_or(&tags);

    let mut args = Vec::new();
    for tag in tags.chars() {
        match tag {
            'f' => args.push(OscArg::Float(f32::from_bits(read_u32(data, pos)?))),
            'i' => args.push(OscArg::Int(read_i32(data, pos)?)),
            'd' => args.push(OscArg::Double(f64::from_bits(read_u64(data, pos)?))),
            'h' => args.push(OscArg::Int(read_u64(data, pos)? as i32)),
            'T' => {
                args.push(OscArg::Bool(true));
                continue; // no bytes in the argument stream
            }
            'F' => {
                args.push(OscArg::Bool(false));
                continue;
            }
            'N' | 'I' => {
                args.push(OscArg::Other); // nil / infinitum: no bytes
                continue;
            }
            's' | 'S' => {
                // Skip the string payload to stay aligned with later args.
                read_osc_string(data, &mut pos)?;
                args.push(OscArg::Other);
                continue;
            }
            'b' => {
                // Blob: int32 length + padded bytes.
                let len = read_i32(data, pos)? as usize;
                pos += 4;
                pos += padded_len(len);
                args.push(OscArg::Other);
                continue;
            }
            'c' | 'r' | 'm' => {
                // char / rgba / midi: a single 4-byte word.
                read_u32(data, pos)?;
                args.push(OscArg::Other);
            }
            _ => return None, // unknown tag: bail rather than misalign
        }
        pos += 4;
    }
    Some(OscMessage { addr, args })
}

/// Read a null-terminated, 4-byte-padded OSC-string starting at `*pos`, and
/// advance `*pos` past its padded end.
fn read_osc_string(data: &[u8], pos: &mut usize) -> Option<String> {
    if *pos >= data.len() {
        return None;
    }
    let rest = &data[*pos..];
    let nul = rest.iter().position(|&b| b == 0)?;
    let s = std::str::from_utf8(&rest[..nul]).ok()?.to_string();
    *pos += padded_len(nul + 1); // include the terminator in the padded length
    Some(s)
}

/// The 4-byte-aligned byte length occupied by `n` content bytes.
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Build an OSC-string (null-terminated, 4-byte padded).
    fn ostr(s: &str) -> Vec<u8> {
        let mut v = s.as_bytes().to_vec();
        v.push(0);
        while v.len() % 4 != 0 {
            v.push(0);
        }
        v
    }

    fn msg(addr: &str, tags: &str, body: &[u8]) -> Vec<u8> {
        let mut v = ostr(addr);
        v.extend(ostr(&format!(",{tags}")));
        v.extend_from_slice(body);
        v
    }

    #[test]
    fn parses_single_float() {
        let pkt = msg("/speed", "f", &2.5f32.to_be_bytes());
        let msgs = parse_packet(&pkt).unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].addr, "/speed");
        assert_eq!(msgs[0].args, vec![OscArg::Float(2.5)]);
        assert_eq!(msgs[0].args[0].as_f32(), Some(2.5));
    }

    #[test]
    fn parses_int_and_bools() {
        let mut body = 7i32.to_be_bytes().to_vec();
        // T and F carry no bytes.
        let pkt = {
            let mut v = ostr("/mix");
            v.extend(ostr(",iTF"));
            v.append(&mut body);
            v
        };
        let m = &parse_packet(&pkt).unwrap()[0];
        assert_eq!(m.args, vec![OscArg::Int(7), OscArg::Bool(true), OscArg::Bool(false)]);
        assert_eq!(m.args[0].as_f32(), Some(7.0));
        assert_eq!(m.args[1].as_f32(), Some(1.0));
        assert_eq!(m.args[2].as_f32(), Some(0.0));
    }

    #[test]
    fn skips_string_arg_but_keeps_alignment() {
        // ,sf  — a string label then the float we actually want.
        let mut v = ostr("/named");
        v.extend(ostr(",sf"));
        v.extend(ostr("hello"));
        v.extend_from_slice(&1.25f32.to_be_bytes());
        let m = &parse_packet(&v).unwrap()[0];
        assert_eq!(m.args.len(), 2);
        assert_eq!(m.args[0], OscArg::Other);
        assert_eq!(m.args[1].as_f32(), Some(1.25));
    }

    #[test]
    fn parses_bundle_of_messages() {
        let a = msg("/tint/x", "f", &1.0f32.to_be_bytes());
        let b = msg("/tint/y", "f", &0.5f32.to_be_bytes());
        let mut pkt = b"#bundle\0".to_vec();
        pkt.extend_from_slice(&1u64.to_be_bytes()); // time tag (immediately)
        pkt.extend_from_slice(&(a.len() as i32).to_be_bytes());
        pkt.extend_from_slice(&a);
        pkt.extend_from_slice(&(b.len() as i32).to_be_bytes());
        pkt.extend_from_slice(&b);
        let msgs = parse_packet(&pkt).unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].addr, "/tint/x");
        assert_eq!(msgs[1].addr, "/tint/y");
        assert_eq!(msgs[1].args[0].as_f32(), Some(0.5));
    }

    #[test]
    fn rejects_garbage() {
        assert!(parse_packet(b"not-osc").is_none());
        assert!(parse_packet(&[]).is_none());
        // Truncated float argument.
        let mut v = ostr("/x");
        v.extend(ostr(",f"));
        v.extend_from_slice(&[0, 0]); // only 2 of 4 bytes
        assert!(parse_packet(&v).is_none());
    }

    #[test]
    fn message_without_typetag_has_no_args() {
        let pkt = ostr("/ping");
        let m = &parse_packet(&pkt).unwrap()[0];
        assert_eq!(m.addr, "/ping");
        assert!(m.args.is_empty());
    }
}
