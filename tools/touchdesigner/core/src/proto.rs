//! Minimal, dependency-free protobuf codec for the subset of the `ledmapper.v1`
//! protocol the TouchDesigner operators need.
//!
//! The player firmware speaks the same protobuf envelopes the phone/web app
//! does (`ClientMessage` / `ServerMessage` in
//! `shared/protocol/proto/ledmapper.proto`), one message per binary WebSocket
//! frame. Rather than pull the `micropb`-generated crate (which is `no_std`
//! with tiny fixed heapless capacities — e.g. a 64-byte cap on the very
//! `bytes` fields we stream), we hand-roll the handful of messages used here.
//! The protobuf wire format is trivial and the field numbers below are pinned
//! to the `.proto` (see the `oneof` arm numbers).

// -- ClientMessage oneof arm (field) numbers --------------------------------
const ARM_HELLO: u32 = 1;
const ARM_GET_STATUS: u32 = 9;
const ARM_SET_EFFECT: u32 = 22;
const ARM_SET_UNIFORMS: u32 = 23;
const ARM_GET_EFFECT_UNIFORMS: u32 = 24;
const ARM_SET_TEXTURE: u32 = 28;

// -- ServerMessage oneof arm (field) numbers --------------------------------
const S_WELCOME: u32 = 1;
const S_STATUS: u32 = 4;
const S_ERROR: u32 = 9;
const S_PLAYBACK_STATE: u32 = 13;
const S_EFFECT_UNIFORMS: u32 = 16;

// Protobuf wire types.
const WT_VARINT: u32 = 0;
const WT_I64: u32 = 1;
const WT_LEN: u32 = 2;
const WT_I32: u32 = 5;

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

/// A tiny append-only protobuf writer.
#[derive(Default)]
struct Writer {
    buf: Vec<u8>,
}

impl Writer {
    fn varint(&mut self, mut v: u64) {
        loop {
            let b = (v & 0x7f) as u8;
            v >>= 7;
            if v != 0 {
                self.buf.push(b | 0x80);
            } else {
                self.buf.push(b);
                break;
            }
        }
    }

    fn tag(&mut self, field: u32, wire: u32) {
        self.varint(((field as u64) << 3) | wire as u64);
    }

    fn field_varint(&mut self, field: u32, v: u64) {
        self.tag(field, WT_VARINT);
        self.varint(v);
    }

    fn field_len(&mut self, field: u32, bytes: &[u8]) {
        self.tag(field, WT_LEN);
        self.varint(bytes.len() as u64);
        self.buf.extend_from_slice(bytes);
    }

    fn field_str(&mut self, field: u32, s: &str) {
        self.field_len(field, s.as_bytes());
    }
}

/// Wrap a message body in a `ClientMessage` envelope arm.
fn envelope(arm: u32, body: &[u8]) -> Vec<u8> {
    let mut w = Writer::default();
    w.field_len(arm, body);
    w.buf
}

// ---------------------------------------------------------------------------
// Client message encoders
// ---------------------------------------------------------------------------

/// `hello` — the required handshake; the reply is `welcome`.
pub fn encode_hello(client: &str, app_version: &str) -> Vec<u8> {
    let mut b = Writer::default();
    b.field_str(1, client);
    b.field_str(2, app_version);
    envelope(ARM_HELLO, &b.buf)
}

/// `get_status` — an empty probe; the reply is `status`.
pub fn encode_get_status() -> Vec<u8> {
    envelope(ARM_GET_STATUS, &[])
}

/// `set_effect` — select the active effect by id ("" / "off" clears it).
pub fn encode_set_effect(effect_id: &str) -> Vec<u8> {
    let mut b = Writer::default();
    b.field_str(1, effect_id);
    envelope(ARM_SET_EFFECT, &b.buf)
}

/// `get_effect_uniforms` — request the manifest for `effect_id` (None = the
/// active effect). The reply is `effect_uniforms`.
pub fn encode_get_effect_uniforms(effect_id: Option<&str>) -> Vec<u8> {
    let mut b = Writer::default();
    if let Some(id) = effect_id {
        b.field_str(1, id);
    }
    envelope(ARM_GET_EFFECT_UNIFORMS, &b.buf)
}

/// One uniform's live value: a slot index and 1..4 floats.
pub struct UniformValue {
    pub slot: u32,
    pub values: Vec<f32>,
}

fn encode_uniform_value(uv: &UniformValue) -> Vec<u8> {
    let mut b = Writer::default();
    b.field_varint(1, uv.slot as u64);
    // repeated float value = 2 [packed = true]
    if !uv.values.is_empty() {
        let mut packed = Vec::with_capacity(uv.values.len() * 4);
        for v in &uv.values {
            packed.extend_from_slice(&v.to_bits().to_le_bytes());
        }
        b.field_len(2, &packed);
    }
    b.buf
}

/// `set_uniforms` — push live uniform values onto the active effect.
pub fn encode_set_uniforms(values: &[UniformValue]) -> Vec<u8> {
    let mut b = Writer::default();
    for uv in values {
        b.field_len(1, &encode_uniform_value(uv));
    }
    envelope(ARM_SET_UNIFORMS, &b.buf)
}

/// A `set_texture` frame (already quantized/encoded by [`crate::texture`]).
pub struct SetTexture<'a> {
    pub tex_index: u32,
    pub format: u32,
    pub width: u32,
    pub height: u32,
    pub flags: u32,
    pub data: &'a [u8],
    pub palette: &'a [u32],
}

/// `set_texture` — stream one quantized frame into a texture port.
pub fn encode_set_texture(t: &SetTexture) -> Vec<u8> {
    let mut b = Writer::default();
    b.field_varint(1, t.tex_index as u64);
    b.field_varint(2, t.format as u64);
    b.field_varint(3, t.width as u64);
    b.field_varint(4, t.height as u64);
    b.field_varint(5, t.flags as u64);
    b.field_len(6, t.data);
    if !t.palette.is_empty() {
        // repeated uint32 palette = 7 [packed = true]
        let mut packed = Writer::default();
        for p in t.palette {
            packed.varint(*p as u64);
        }
        b.field_len(7, &packed.buf);
    }
    envelope(ARM_SET_TEXTURE, &b.buf)
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

struct Reader<'a> {
    b: &'a [u8],
    i: usize,
}

impl<'a> Reader<'a> {
    fn new(b: &'a [u8]) -> Self {
        Reader { b, i: 0 }
    }
    fn eof(&self) -> bool {
        self.i >= self.b.len()
    }
    fn varint(&mut self) -> Option<u64> {
        let mut shift = 0u32;
        let mut out = 0u64;
        loop {
            let byte = *self.b.get(self.i)?;
            self.i += 1;
            out |= ((byte & 0x7f) as u64) << shift;
            if byte & 0x80 == 0 {
                return Some(out);
            }
            shift += 7;
            if shift >= 64 {
                return None;
            }
        }
    }
    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        let end = self.i.checked_add(n)?;
        let s = self.b.get(self.i..end)?;
        self.i = end;
        Some(s)
    }
    /// Read one field header; returns (field_number, wire_type).
    fn tag(&mut self) -> Option<(u32, u32)> {
        let t = self.varint()?;
        Some(((t >> 3) as u32, (t & 7) as u32))
    }
    /// Skip a field of the given wire type (for fields we don't model).
    fn skip(&mut self, wire: u32) -> Option<()> {
        match wire {
            WT_VARINT => {
                self.varint()?;
            }
            WT_I64 => {
                self.take(8)?;
            }
            WT_LEN => {
                let n = self.varint()? as usize;
                self.take(n)?;
            }
            WT_I32 => {
                self.take(4)?;
            }
            _ => return None,
        }
        Some(())
    }
}

// ---------------------------------------------------------------------------
// Server messages
// ---------------------------------------------------------------------------

/// The `welcome` handshake reply — identifies a fixture.
#[derive(Debug, Default, Clone)]
pub struct Welcome {
    pub session_id: String,
    pub mac: String,
    pub device_name: String,
}

/// A declared 2D texture input of the active effect (from `effect_uniforms`).
/// The device silently drops any `set_texture` frame whose dimensions don't
/// match one of these, so a texture source uses them to size its stream.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct TexturePort {
    pub index: u32,
    pub width: u32,
    pub height: u32,
    pub elem: u32,
}

/// A decoded `effect_uniforms` reply.
#[derive(Debug, Default, Clone)]
pub struct EffectUniforms {
    pub effect_id: String,
    /// Raw manifest JSON bytes (see [`crate::manifest`]). Empty on current
    /// firmware (the compiler leaves the embedded manifest empty).
    pub manifest: Vec<u8>,
    /// Declared 2D texture inputs (empty on older firmware that predates the
    /// `textures` field).
    pub textures: Vec<TexturePort>,
}

/// The subset of `ServerMessage` arms the operators act on.
#[derive(Debug, Clone)]
pub enum ServerMsg {
    Welcome(Welcome),
    Status { identified: i32, total: i32, low_parallax: i32 },
    Error { code: String, message: String },
    PlaybackState { active: bool, effect: String },
    EffectUniforms(EffectUniforms),
    /// An arm we don't model (kept so callers can ignore it gracefully).
    Other(u32),
}

fn utf8(b: &[u8]) -> String {
    String::from_utf8_lossy(b).into_owned()
}

/// Decode one `ServerMessage` frame. Returns `None` on a malformed frame.
pub fn decode_server(frame: &[u8]) -> Option<ServerMsg> {
    let mut r = Reader::new(frame);
    let (arm, wire) = r.tag()?;
    if wire != WT_LEN {
        return None;
    }
    let n = r.varint()? as usize;
    let body = r.take(n)?;
    Some(match arm {
        S_WELCOME => ServerMsg::Welcome(decode_welcome(body)?),
        S_STATUS => decode_status(body)?,
        S_ERROR => decode_error(body)?,
        S_PLAYBACK_STATE => decode_playback(body)?,
        S_EFFECT_UNIFORMS => ServerMsg::EffectUniforms(decode_effect_uniforms(body)?),
        other => ServerMsg::Other(other),
    })
}

fn decode_welcome(body: &[u8]) -> Option<Welcome> {
    let mut r = Reader::new(body);
    let mut w = Welcome::default();
    while !r.eof() {
        let (f, wire) = r.tag()?;
        match (f, wire) {
            (1, WT_LEN) => {
                let n = r.varint()? as usize;
                w.session_id = utf8(r.take(n)?);
            }
            (4, WT_LEN) => {
                let n = r.varint()? as usize;
                w.mac = utf8(r.take(n)?);
            }
            (5, WT_LEN) => {
                let n = r.varint()? as usize;
                w.device_name = utf8(r.take(n)?);
            }
            (_, wire) => r.skip(wire)?,
        }
    }
    Some(w)
}

fn decode_status(body: &[u8]) -> Option<ServerMsg> {
    let mut r = Reader::new(body);
    let (mut identified, mut total, mut low) = (0i32, 0i32, 0i32);
    while !r.eof() {
        let (f, wire) = r.tag()?;
        match (f, wire) {
            (1, WT_VARINT) => identified = r.varint()? as i32,
            (2, WT_VARINT) => total = r.varint()? as i32,
            (3, WT_VARINT) => low = r.varint()? as i32,
            (_, wire) => r.skip(wire)?,
        }
    }
    Some(ServerMsg::Status { identified, total, low_parallax: low })
}

fn decode_error(body: &[u8]) -> Option<ServerMsg> {
    let mut r = Reader::new(body);
    let (mut code, mut message) = (String::new(), String::new());
    while !r.eof() {
        let (f, wire) = r.tag()?;
        match (f, wire) {
            (1, WT_LEN) => {
                let n = r.varint()? as usize;
                code = utf8(r.take(n)?);
            }
            (2, WT_LEN) => {
                let n = r.varint()? as usize;
                message = utf8(r.take(n)?);
            }
            (_, wire) => r.skip(wire)?,
        }
    }
    Some(ServerMsg::Error { code, message })
}

fn decode_playback(body: &[u8]) -> Option<ServerMsg> {
    let mut r = Reader::new(body);
    let (mut active, mut effect) = (false, String::new());
    while !r.eof() {
        let (f, wire) = r.tag()?;
        match (f, wire) {
            (1, WT_VARINT) => active = r.varint()? != 0,
            (2, WT_LEN) => {
                let n = r.varint()? as usize;
                effect = utf8(r.take(n)?);
            }
            (_, wire) => r.skip(wire)?,
        }
    }
    Some(ServerMsg::PlaybackState { active, effect })
}

fn decode_effect_uniforms(body: &[u8]) -> Option<EffectUniforms> {
    let mut r = Reader::new(body);
    let mut e = EffectUniforms::default();
    while !r.eof() {
        let (f, wire) = r.tag()?;
        match (f, wire) {
            (1, WT_LEN) => {
                let n = r.varint()? as usize;
                e.effect_id = utf8(r.take(n)?);
            }
            (2, WT_LEN) => {
                let n = r.varint()? as usize;
                e.manifest = r.take(n)?.to_vec();
            }
            (4, WT_LEN) => {
                let n = r.varint()? as usize;
                if let Some(t) = decode_texture_port(r.take(n)?) {
                    e.textures.push(t);
                }
            }
            (_, wire) => r.skip(wire)?,
        }
    }
    Some(e)
}

fn decode_texture_port(body: &[u8]) -> Option<TexturePort> {
    let mut r = Reader::new(body);
    let mut t = TexturePort::default();
    while !r.eof() {
        let (f, wire) = r.tag()?;
        match (f, wire) {
            (1, WT_VARINT) => t.index = r.varint()? as u32,
            (2, WT_VARINT) => t.width = r.varint()? as u32,
            (3, WT_VARINT) => t.height = r.varint()? as u32,
            (4, WT_VARINT) => t.elem = r.varint()? as u32,
            (_, wire) => r.skip(wire)?,
        }
    }
    Some(t)
}

#[cfg(test)]
mod tests {
    use super::*;

    // The golden `hello` frame from web/tests/golden_proto_frames.json:
    // {"type":"hello","client":"android-web","appVersion":"0.1.0"}
    #[test]
    fn hello_matches_golden() {
        // base64 "ChQKC2FuZHJvaWQtd2ViEgUwLjEuMA=="
        let golden: &[u8] = &[
            0x0a, 0x14, 0x0a, 0x0b, b'a', b'n', b'd', b'r', b'o', b'i', b'd', b'-', b'w', b'e',
            b'b', 0x12, 0x05, b'0', b'.', b'1', b'.', b'0',
        ];
        assert_eq!(encode_hello("android-web", "0.1.0"), golden);
    }

    #[test]
    fn get_status_matches_golden() {
        // base64 "SgA=" -> 0x4a 0x00 (field 9, LEN, empty).
        assert_eq!(encode_get_status(), vec![0x4a, 0x00]);
    }

    #[test]
    fn set_texture_roundtrips_fields() {
        let data = [1u8, 2, 3, 4];
        let frame = encode_set_texture(&SetTexture {
            tex_index: 2,
            format: 1,
            width: 16,
            height: 8,
            flags: 3,
            data: &data,
            palette: &[],
        });
        // Envelope arm 28 (LEN).
        assert_eq!(frame[0], (28 << 3) | 2);
        // Body length prefix, then the SetTexture fields.
        let mut r = Reader::new(&frame);
        let (arm, wire) = r.tag().unwrap();
        assert_eq!((arm, wire), (28, WT_LEN));
        let n = r.varint().unwrap() as usize;
        let body = r.take(n).unwrap();
        let mut br = Reader::new(body);
        let mut seen = std::collections::HashMap::new();
        while !br.eof() {
            let (f, w) = br.tag().unwrap();
            if w == WT_VARINT {
                seen.insert(f, br.varint().unwrap());
            } else {
                let ln = br.varint().unwrap() as usize;
                br.take(ln).unwrap();
            }
        }
        assert_eq!(seen[&1], 2); // tex_index
        assert_eq!(seen[&2], 1); // format
        assert_eq!(seen[&3], 16); // width
        assert_eq!(seen[&4], 8); // height
        assert_eq!(seen[&5], 3); // flags
    }

    #[test]
    fn set_uniforms_encodes_packed_floats() {
        let frame = encode_set_uniforms(&[UniformValue { slot: 1, values: vec![0.5, 1.0, 0.0] }]);
        assert_eq!(frame[0], (23 << 3) | 2);
    }

    #[test]
    fn decode_welcome_frame() {
        // Build a Welcome server frame by hand and decode it.
        let mut inner = Writer::default();
        inner.field_str(1, "sess"); // session_id
        inner.field_str(4, "AA:BB:CC:DD:EE:FF"); // mac
        inner.field_str(5, "Led Widget abcdef"); // device_name
        let frame = {
            let mut w = Writer::default();
            w.field_len(S_WELCOME, &inner.buf);
            w.buf
        };
        match decode_server(&frame).unwrap() {
            ServerMsg::Welcome(w) => {
                assert_eq!(w.session_id, "sess");
                assert_eq!(w.mac, "AA:BB:CC:DD:EE:FF");
                assert_eq!(w.device_name, "Led Widget abcdef");
            }
            other => panic!("expected welcome, got {other:?}"),
        }
    }

    #[test]
    fn decode_effect_uniforms_textures() {
        // Build an EffectUniforms server frame carrying two TexturePort entries
        // (field 4) plus a manifest (field 2), and decode them back.
        let tex = |index: u32, w: u32, h: u32, elem: u32| {
            let mut b = Writer::default();
            b.field_varint(1, index as u64);
            b.field_varint(2, w as u64);
            b.field_varint(3, h as u64);
            b.field_varint(4, elem as u64);
            b.buf
        };
        let mut inner = Writer::default();
        inner.field_str(1, "sparkle"); // effect_id
        inner.field_str(2, "[]"); // manifest
        inner.field_len(4, &tex(0, 24, 24, 3));
        inner.field_len(4, &tex(2, 8, 8, 1));
        let mut w = Writer::default();
        w.field_len(S_EFFECT_UNIFORMS, &inner.buf);

        match decode_server(&w.buf).unwrap() {
            ServerMsg::EffectUniforms(e) => {
                assert_eq!(e.effect_id, "sparkle");
                assert_eq!(e.textures.len(), 2);
                assert_eq!(e.textures[0], TexturePort { index: 0, width: 24, height: 24, elem: 3 });
                assert_eq!(e.textures[1], TexturePort { index: 2, width: 8, height: 8, elem: 1 });
            }
            other => panic!("expected effect_uniforms, got {other:?}"),
        }
    }

    #[test]
    fn decode_effect_uniforms_without_textures_is_empty() {
        // Older firmware omits field 4 entirely -> textures decode to empty.
        let mut inner = Writer::default();
        inner.field_str(1, "old");
        inner.field_str(2, "[]");
        let mut w = Writer::default();
        w.field_len(S_EFFECT_UNIFORMS, &inner.buf);
        match decode_server(&w.buf).unwrap() {
            ServerMsg::EffectUniforms(e) => assert!(e.textures.is_empty()),
            other => panic!("expected effect_uniforms, got {other:?}"),
        }
    }

    #[test]
    fn decode_error_frame() {
        let mut inner = Writer::default();
        inner.field_str(1, "no_effect");
        inner.field_str(2, "no active effect");
        let mut w = Writer::default();
        w.field_len(S_ERROR, &inner.buf);
        match decode_server(&w.buf).unwrap() {
            ServerMsg::Error { code, .. } => assert_eq!(code, "no_effect"),
            other => panic!("expected error, got {other:?}"),
        }
    }
}
