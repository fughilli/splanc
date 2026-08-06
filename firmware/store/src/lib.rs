//! Decode-into-arena for the variable-size uploads (Phase 3).
//!
//! The generated micropb bindings hold repeated fields in fixed-capacity
//! heapless storage — fine for control messages, hopeless for the map and
//! topology uploads (hundreds of KB of inline capacity for a big fixture).
//! This crate hand-walks EXACTLY those two messages out of a byte stream and
//! bump-appends into [`ledmapper_arena::Arena`]:
//!
//! - the LED list is pre-sized from the upload's own header (`led_count`
//!   precedes `leds` on the canonical wire — field 5 vs 6 — so one exact
//!   allocation, no growth);
//! - topology lists carry no count headers and use the growable
//!   [`ArenaVec`];
//! - exhaustion is a deterministic [`StoreError::ArenaFull`] — the caller
//!   replies a bounded "map too large" error and rolls the arena back to
//!   its checkpoint (allocation-free, panic-free by construction);
//! - positions are stored as `f32` (the wire is f64): playback needs
//!   millimeters on a meters-scale fixture, not doubles, and it halves the
//!   footprint on the C6.
//!
//! Field numbers are hard-wired from `shared/protocol/proto/ledmapper.proto`
//! and pinned by the cross-language conformance suite + the golden-frame
//! test in tests/ — a proto renumbering fails tests, not devices.
//!
//! The reader is any [`micropb::PbRead`]; [`ChunkedReader`] adapts a list of
//! fragments (a WSS reassembly queue) with no contiguous frame buffer.
//! Persistence ([`BlobStore`]) stores the UPLOAD BYTES opaquely (NVS blob on
//! the ESP32, keyed by map id); reload runs the SAME decode path — one
//! format, and the OOM check re-runs on every boot.

#![no_std]

use core::convert::Infallible;

use ledmapper_arena::{Arena, ArenaFull, ArenaVec};
use micropb::{DecodeError, PbDecoder, PbRead, WIRE_TYPE_LEN};

pub type Str64 = micropb::heapless::String<64>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StoreError {
    /// The upload does not fit the arena (deterministic; caller replies a
    /// bounded "map too large" error and resets to its checkpoint).
    ArenaFull,
    /// Structurally valid protobuf that violates the upload contract.
    Malformed(&'static str),
    /// Wire-level decode failure.
    Decode,
}

impl From<ArenaFull> for StoreError {
    fn from(_: ArenaFull) -> Self {
        StoreError::ArenaFull
    }
}

impl From<DecodeError<Infallible>> for StoreError {
    fn from(_: DecodeError<Infallible>) -> Self {
        StoreError::Decode
    }
}

// ---------------------------------------------------------------------------
// Stored (arena-backed) shapes — what the playback engines consume.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StoredLed {
    pub id: u32,
    pub xyz: [f32; 3],
}

#[derive(Debug)]
pub struct StoredMap<'a> {
    pub map_id: Str64,
    pub led_count: u32,
    pub leds: &'a [StoredLed],
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StoredBranchPoint {
    pub id: u32,
    pub xyz: [f32; 3],
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StoredSegment<'a> {
    pub id: u32,
    /// Endpoint branch-point ids; -1 = free end.
    pub a: i32,
    pub b: i32,
    pub length: f32,
    pub polyline: &'a [[f32; 3]],
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StoredAssociation {
    pub led_id: u32,
    pub segment_id: u32,
    pub foot_arclength: f32,
    pub d_perp: f32,
}

#[derive(Debug)]
pub struct StoredTopology<'a> {
    pub map_id: Str64,
    pub branch_points: &'a [StoredBranchPoint],
    pub segments: &'a [StoredSegment<'a>],
    pub associations: &'a [StoredAssociation],
}

// ---------------------------------------------------------------------------
// Envelope routing
// ---------------------------------------------------------------------------

/// ClientMessage oneof arms that take the arena path (ledmapper.proto).
pub const ARM_SUBMIT_MAP: u32 = 13;
pub const ARM_SUBMIT_TOPOLOGY: u32 = 16;
/// ClientMessage arm the ffi intercepts to stream the stored map+topology
/// back out (it lives in the arena, not the session core).
pub const ARM_GET_STORED_MAP: u32 = 20;
/// ClientMessage arm carrying one window of a sharded submit_map /
/// submit_topology (the transport reassembles the windows and decodes the
/// concatenation through the normal arena path).
pub const ARM_UPLOAD_CHUNK: u32 = 29;

/// A parsed `UploadChunk` window: header fields plus the payload byte slice
/// (a sub-slice of the frame that was walked — the reassembler copies it into
/// the accumulation buffer, in `seq` order).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UploadChunkView<'a> {
    pub upload_id: u32,
    pub seq: u32,
    pub last: bool,
    /// 0 = MAP (reassembles a submit_map frame), 1 = TOPOLOGY.
    pub kind: u32,
    pub payload: &'a [u8],
}

/// Read a base-128 varint out of `buf` at `*p`, advancing `*p`.
fn read_varint(buf: &[u8], p: &mut usize) -> Result<u64, StoreError> {
    let mut val: u64 = 0;
    let mut shift: u32 = 0;
    loop {
        let b = *buf.get(*p).ok_or(StoreError::Decode)?;
        *p += 1;
        val |= u64::from(b & 0x7f) << shift;
        if b & 0x80 == 0 {
            return Ok(val);
        }
        shift += 7;
        if shift >= 64 {
            return Err(StoreError::Decode);
        }
    }
}

/// Parse a `ClientMessage{ upload_chunk }` frame into its header fields and the
/// payload slice, WITHOUT touching the (bytes-capped) generated bindings — the
/// player intercepts this arm and copies the payload straight into the
/// reassembly buffer, exactly like the arena upload arms. Hand-walks the
/// contiguous frame so it can hand back a borrow of the payload bytes.
///
/// `Ok(None)` means the frame is well-formed protobuf but not an upload_chunk
/// (the caller handles it as an ordinary message); `Err` is a malformed frame.
pub fn parse_upload_chunk(frame: &[u8]) -> Result<Option<UploadChunkView<'_>>, StoreError> {
    let mut p = 0usize;
    let tag = read_varint(frame, &mut p)?;
    if (tag & 0x7) != u64::from(WIRE_TYPE_LEN) || (tag >> 3) as u32 != ARM_UPLOAD_CHUNK {
        return Ok(None);
    }
    let inner_len = read_varint(frame, &mut p)? as usize;
    let inner_end = p.checked_add(inner_len).ok_or(StoreError::Decode)?;
    if inner_end > frame.len() {
        return Err(StoreError::Decode);
    }

    let mut v = UploadChunkView { upload_id: 0, seq: 0, last: false, kind: 0, payload: &[] };
    while p < inner_end {
        let tag = read_varint(frame, &mut p)?;
        let field = (tag >> 3) as u32;
        let wt = (tag & 0x7) as u8;
        match (field, wt) {
            (1, 0) => v.upload_id = read_varint(frame, &mut p)? as u32,
            (2, 0) => v.seq = read_varint(frame, &mut p)? as u32,
            (3, 0) => v.last = read_varint(frame, &mut p)? != 0,
            (4, 0) => v.kind = read_varint(frame, &mut p)? as u32,
            (5, wt) if wt == WIRE_TYPE_LEN => {
                let n = read_varint(frame, &mut p)? as usize;
                let end = p.checked_add(n).ok_or(StoreError::Decode)?;
                if end > inner_end {
                    return Err(StoreError::Decode);
                }
                v.payload = &frame[p..end];
                p = end;
            }
            // Skip unknown fields to stay forward-compatible.
            (_, 0) => {
                read_varint(frame, &mut p)?;
            }
            (_, wt) if wt == WIRE_TYPE_LEN => {
                let n = read_varint(frame, &mut p)? as usize;
                p = p.checked_add(n).ok_or(StoreError::Decode)?;
            }
            (_, 5) => p = p.checked_add(4).ok_or(StoreError::Decode)?,
            (_, 1) => p = p.checked_add(8).ok_or(StoreError::Decode)?,
            _ => return Err(StoreError::Decode),
        }
        if p > inner_end {
            return Err(StoreError::Decode);
        }
    }
    Ok(Some(v))
}

/// Peek the envelope's oneof arm (the first tag's field number) from the
/// frame's first buffered bytes, so the transport can route arena uploads
/// before reassembling anything.
pub fn envelope_arm(prefix: &[u8]) -> Option<u32> {
    let mut key: u32 = 0;
    for (i, b) in prefix.iter().copied().enumerate().take(5) {
        key |= u32::from(b & 0x7f) << (7 * i);
        if b & 0x80 == 0 {
            return Some(key >> 3);
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Chunked reader — decode straight out of a fragment list.
// ---------------------------------------------------------------------------

/// [`PbRead`] over a sequence of byte fragments (e.g. reassembled WSS
/// continuation frames) — no contiguous copy of the upload ever exists.
pub struct ChunkedReader<'b> {
    segments: &'b [&'b [u8]],
    seg: usize,
    off: usize,
}

impl<'b> ChunkedReader<'b> {
    pub fn new(segments: &'b [&'b [u8]]) -> Self {
        ChunkedReader {
            segments,
            seg: 0,
            off: 0,
        }
    }

    pub fn total_len(&self) -> usize {
        self.segments.iter().map(|s| s.len()).sum()
    }
}

impl PbRead for ChunkedReader<'_> {
    type Error = Infallible;

    fn pb_read_chunk(&mut self) -> Result<&[u8], Infallible> {
        while self.seg < self.segments.len() && self.off >= self.segments[self.seg].len() {
            self.seg += 1;
            self.off = 0;
        }
        Ok(if self.seg < self.segments.len() {
            &self.segments[self.seg][self.off..]
        } else {
            &[]
        })
    }

    fn pb_advance(&mut self, bytes: usize) {
        self.off += bytes;
    }
}

/// [`PbRead`] that pulls the upload one BLOCK at a time from a fill callback
/// into a small reused buffer — so a large upload decodes with no contiguous
/// copy of it in RAM (the firmware backs `fill` with a LittleFS read, letting
/// the reassembly buffer shrink to one block instead of a whole frame). Safe
/// with a reused buffer because the decoder copies each primitive out via
/// `pb_read_exact` before the next refill (multi-byte values that straddle a
/// block boundary are stitched, not held as a borrow).
///
/// `fill(buf) -> n` writes up to `buf.len()` bytes and returns how many; `0`
/// means EOF (an early EOF surfaces as a decode error via the length checks).
pub struct BlockReader<'b, F> {
    fill: F,
    buf: &'b mut [u8],
    len: usize,
    off: usize,
}

impl<'b, F: FnMut(&mut [u8]) -> usize> BlockReader<'b, F> {
    pub fn new(buf: &'b mut [u8], fill: F) -> Self {
        BlockReader { fill, buf, len: 0, off: 0 }
    }
}

impl<F: FnMut(&mut [u8]) -> usize> PbRead for BlockReader<'_, F> {
    type Error = Infallible;

    fn pb_read_chunk(&mut self) -> Result<&[u8], Infallible> {
        if self.off >= self.len {
            self.len = (self.fill)(self.buf);
            self.off = 0;
        }
        Ok(&self.buf[self.off..self.len])
    }

    fn pb_advance(&mut self, bytes: usize) {
        self.off += bytes;
    }
}

// ---------------------------------------------------------------------------
// Decoders
// ---------------------------------------------------------------------------

type Dec<R> = PbDecoder<R>;

/// Decode a `ClientMessage{submit_map{map}}` frame of `frame_len` bytes.
pub fn decode_submit_map<'a, R>(
    reader: R,
    frame_len: usize,
    arena: &'a Arena<'_>,
) -> Result<StoredMap<'a>, StoreError>
where
    R: PbRead<Error = Infallible>,
{
    let mut dec = PbDecoder::new(reader);
    let mut map = None;
    walk(&mut dec, frame_len, |field, _wt, dec| match field {
        ARM_SUBMIT_MAP => len_record(dec, |len, dec| {
            // SubmitMap { OutputMap map = 1; }
            walk(dec, len, |f, wt, dec| match f {
                1 => len_record(dec, |len, dec| {
                    map = Some(decode_output_map(dec, len, arena)?);
                    Ok(())
                }),
                _ => skip(dec, wt),
            })
        }),
        _ => Err(StoreError::Malformed("frame is not submit_map")),
    })?;
    map.ok_or(StoreError::Malformed("submit_map without map"))
}

/// Decode a `ClientMessage{submit_topology{topology}}` frame.
pub fn decode_submit_topology<'a, R>(
    reader: R,
    frame_len: usize,
    arena: &'a Arena<'_>,
) -> Result<StoredTopology<'a>, StoreError>
where
    R: PbRead<Error = Infallible>,
{
    let mut dec = PbDecoder::new(reader);
    let mut topo = None;
    walk(&mut dec, frame_len, |field, _wt, dec| match field {
        ARM_SUBMIT_TOPOLOGY => len_record(dec, |len, dec| {
            walk(dec, len, |f, wt, dec| match f {
                1 => len_record(dec, |len, dec| {
                    topo = Some(decode_topology(dec, len, arena)?);
                    Ok(())
                }),
                _ => skip(dec, wt),
            })
        }),
        _ => Err(StoreError::Malformed("frame is not submit_topology")),
    })?;
    topo.ok_or(StoreError::Malformed("submit_topology without topology"))
}

/// OutputMap: map_id=1, led_count=5 (MUST precede leds — it sizes the one
/// exact arena region), leds=6 { id=1, xyz=2 }; everything else (timestamps,
/// trajectory, stats) is skipped — playback does not consume it.
fn decode_output_map<'a, R>(
    dec: &mut Dec<R>,
    len: usize,
    arena: &'a Arena<'_>,
) -> Result<StoredMap<'a>, StoreError>
where
    R: PbRead<Error = Infallible>,
{
    let mut map_id = Str64::new();
    let mut led_count: u32 = 0;
    let mut leds: Option<ArenaVec<'a, '_, StoredLed>> = None;
    walk(dec, len, |field, wt, dec| match field {
        1 => {
            dec.decode_string(&mut map_id, micropb::Presence::Implicit)?;
            Ok(())
        }
        5 => {
            let n = dec.decode_int32()?;
            if n < 0 {
                return Err(StoreError::Malformed("negative led_count"));
            }
            led_count = n as u32;
            Ok(())
        }
        6 => {
            let vec = match leds.as_mut() {
                Some(v) => v,
                None => {
                    // First LED entry: size the region from the header.
                    if led_count == 0 {
                        return Err(StoreError::Malformed("led_count must precede leds"));
                    }
                    leds = Some(ArenaVec::with_exact_capacity(arena, led_count as usize)?);
                    leds.as_mut().unwrap()
                }
            };
            let led = len_record_value(dec, |len, dec| {
                let mut led = StoredLed { id: 0, xyz: [0.0; 3] };
                walk(dec, len, |f, wt, dec| match f {
                    1 => {
                        led.id = dec.decode_int32()?.max(0) as u32;
                        Ok(())
                    }
                    2 => decode_vec3(dec, wt, &mut led.xyz),
                    _ => skip(dec, wt),
                })?;
                Ok(led)
            })?;
            vec.push(led)
                .map_err(|_| StoreError::Malformed("more leds than led_count"))?;
            Ok(())
        }
        _ => skip(dec, wt),
    })?;
    Ok(StoredMap {
        map_id,
        led_count,
        leds: leds.map(ArenaVec::into_slice).unwrap_or(&[]),
    })
}

/// Topology: map_id=1, branch_points=2 {id=1, xyz=2}, segments=3 {id=1, a=2,
/// b=3, polyline=4 (Vec3{v=1}), length=5}, associations=4 {led_id=1,
/// segment_id=2, foot_arclength=3, d_perp=4}.
fn decode_topology<'a, R>(
    dec: &mut Dec<R>,
    len: usize,
    arena: &'a Arena<'_>,
) -> Result<StoredTopology<'a>, StoreError>
where
    R: PbRead<Error = Infallible>,
{
    let mut map_id = Str64::new();
    let mut branch_points = ArenaVec::<StoredBranchPoint>::new(arena);
    let mut segments = ArenaVec::<StoredSegment<'a>>::new(arena);
    let mut associations = ArenaVec::<StoredAssociation>::new(arena);
    walk(dec, len, |field, wt, dec| match field {
        1 => {
            dec.decode_string(&mut map_id, micropb::Presence::Implicit)?;
            Ok(())
        }
        2 => {
            let bp = len_record_value(dec, |len, dec| {
                let mut bp = StoredBranchPoint { id: 0, xyz: [0.0; 3] };
                walk(dec, len, |f, wt, dec| match f {
                    1 => {
                        bp.id = dec.decode_int32()?.max(0) as u32;
                        Ok(())
                    }
                    2 => decode_vec3(dec, wt, &mut bp.xyz),
                    _ => skip(dec, wt),
                })?;
                Ok(bp)
            })?;
            branch_points.push(bp)?;
            Ok(())
        }
        3 => {
            let seg = len_record_value(dec, |len, dec| {
                let mut id = 0u32;
                let (mut a, mut b) = (0i32, 0i32);
                let mut length = 0f32;
                let mut polyline = ArenaVec::<[f32; 3]>::new(arena);
                walk(dec, len, |f, wt, dec| match f {
                    1 => {
                        id = dec.decode_int32()?.max(0) as u32;
                        Ok(())
                    }
                    2 => {
                        a = dec.decode_int32()?;
                        Ok(())
                    }
                    3 => {
                        b = dec.decode_int32()?;
                        Ok(())
                    }
                    4 => {
                        // repeated Vec3 { repeated double v = 1 [packed] }
                        let p = len_record_value(dec, |len, dec| {
                            let mut p = [0f32; 3];
                            walk(dec, len, |f, wt, dec| match f {
                                1 => decode_vec3(dec, wt, &mut p),
                                _ => skip(dec, wt),
                            })?;
                            Ok(p)
                        })?;
                        polyline.push(p)?;
                        Ok(())
                    }
                    5 => {
                        length = dec.decode_double()? as f32;
                        Ok(())
                    }
                    _ => skip(dec, wt),
                })?;
                Ok(StoredSegment {
                    id,
                    a,
                    b,
                    length,
                    polyline: polyline.into_slice(),
                })
            })?;
            segments.push(seg)?;
            Ok(())
        }
        4 => {
            let assoc = len_record_value(dec, |len, dec| {
                let mut v = StoredAssociation {
                    led_id: 0,
                    segment_id: 0,
                    foot_arclength: 0.0,
                    d_perp: 0.0,
                };
                walk(dec, len, |f, wt, dec| match f {
                    1 => {
                        v.led_id = dec.decode_int32()?.max(0) as u32;
                        Ok(())
                    }
                    2 => {
                        v.segment_id = dec.decode_int32()?.max(0) as u32;
                        Ok(())
                    }
                    3 => {
                        v.foot_arclength = dec.decode_double()? as f32;
                        Ok(())
                    }
                    4 => {
                        v.d_perp = dec.decode_double()? as f32;
                        Ok(())
                    }
                    _ => skip(dec, wt),
                })?;
                Ok(v)
            })?;
            associations.push(assoc)?;
            Ok(())
        }
        _ => skip(dec, wt),
    })?;
    Ok(StoredTopology {
        map_id,
        branch_points: branch_points.into_slice(),
        segments: segments.into_slice(),
        associations: associations.into_slice(),
    })
}

// ---------------------------------------------------------------------------
// Wire-walk helpers
// ---------------------------------------------------------------------------

/// Iterate `len` bytes of fields, dispatching on (field number, wire type).
/// The handler must fully consume each field's value (skip() for unknown
/// fields).
fn walk<R, F>(dec: &mut Dec<R>, len: usize, mut on_field: F) -> Result<(), StoreError>
where
    R: PbRead<Error = Infallible>,
    F: FnMut(u32, u8, &mut Dec<R>) -> Result<(), StoreError>,
{
    let before = dec.bytes_read();
    while dec.bytes_read() - before < len {
        let tag = dec.decode_tag()?;
        if tag.field_num() == 0 {
            return Err(StoreError::Decode);
        }
        on_field(tag.field_num(), tag.wire_type(), dec)?;
    }
    Ok(())
}

fn skip<R>(dec: &mut Dec<R>, wire_type: u8) -> Result<(), StoreError>
where
    R: PbRead<Error = Infallible>,
{
    dec.skip_wire_value(wire_type)?;
    Ok(())
}

/// A `[x, y, z]` from a `repeated double` field: packed (canonical) or a
/// single unpacked element per tag (tolerated).
fn decode_vec3<R>(dec: &mut Dec<R>, wire_type: u8, out: &mut [f32; 3]) -> Result<(), StoreError>
where
    R: PbRead<Error = Infallible>,
{
    if wire_type == WIRE_TYPE_LEN {
        let mut i = 0usize;
        len_record(dec, |len, dec| {
            let before = dec.bytes_read();
            while dec.bytes_read() - before < len {
                let v = dec.decode_double()? as f32;
                if i < 3 {
                    out[i] = v;
                }
                i += 1;
            }
            Ok(())
        })
    } else {
        // Unpacked: one element per tag; overflow beyond 3 is dropped.
        let v = dec.decode_double()? as f32;
        out.copy_within(1.., 0);
        out[2] = v;
        Ok(())
    }
}

fn len_record<R, F>(dec: &mut Dec<R>, f: F) -> Result<(), StoreError>
where
    R: PbRead<Error = Infallible>,
    F: FnOnce(usize, &mut Dec<R>) -> Result<(), StoreError>,
{
    len_record_value(dec, f)
}

/// Enter a length-delimited record: read the length prefix, run `f` over
/// exactly that many bytes, and verify it consumed them all.
fn len_record_value<R, F, T>(dec: &mut Dec<R>, f: F) -> Result<T, StoreError>
where
    R: PbRead<Error = Infallible>,
    F: FnOnce(usize, &mut Dec<R>) -> Result<T, StoreError>,
{
    let len = dec.decode_varint32()? as usize;
    let before = dec.bytes_read();
    let out = f(len, dec)?;
    if dec.bytes_read() - before != len {
        return Err(StoreError::Decode);
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Persistence: uploads stored as OPAQUE proto blobs (NVS on the ESP32);
// reload runs the same decoder — one format, OOM re-checked every boot.
// ---------------------------------------------------------------------------

pub trait BlobStore {
    type Error;

    /// Persist `blob` under `key` (overwrite).
    fn save(&mut self, key: &str, blob: &[u8]) -> Result<(), Self::Error>;

    /// Borrow the stored blob for the duration of `f`; `None` if absent.
    fn with_blob<T>(
        &self,
        key: &str,
        f: impl FnOnce(&[u8]) -> T,
    ) -> Result<Option<T>, Self::Error>;
}

// ---------------------------------------------------------------------------
// MappingBundle dump — re-encode the stored map + topology back to protobuf.
// ---------------------------------------------------------------------------

/// Streaming protobuf encoder for the `MappingBundle` file format, straight
/// from the arena-backed `Stored*` structs — the player has no protobuf
/// ENCODER otherwise (uploads take a hand-written decoder), and a full map far
/// exceeds one control frame, so this emits an arbitrary byte window without
/// ever buffering the whole bundle: [`bundle_len`] gives the total, and
/// [`encode_bundle_window`] fills bytes `[start, start+buf.len())`. The phone
/// loops requesting windows until it has `bundle_len` bytes, then decodes it as
/// a `MappingBundle` (wire fields mirror ledmapper.proto exactly).
pub mod dump {
    use super::{StoredAssociation, StoredBranchPoint, StoredLed, StoredMap, StoredSegment, StoredTopology};

    // OutputMap defaults we fill so the bundle is a complete, valid map.
    const UNITS: &str = "meters";
    const FRAME: &str = "gravity_leveled";

    // -- size pass (no buffering) -------------------------------------------
    fn varint_len(v: u64) -> usize {
        let mut n = 1;
        let mut x = v >> 7;
        while x > 0 {
            n += 1;
            x >>= 7;
        }
        n
    }
    fn tag_len(field: u32) -> usize {
        varint_len((field as u64) << 3)
    }
    fn i32_len(field: u32, v: i32) -> usize {
        tag_len(field) + varint_len(v as i64 as u64)
    }
    fn f64_len(field: u32) -> usize {
        tag_len(field) + 8
    }
    fn str_len(field: u32, s: &str) -> usize {
        tag_len(field) + varint_len(s.len() as u64) + s.len()
    }
    fn packed3_len(field: u32) -> usize {
        tag_len(field) + varint_len(24) + 24 // three packed doubles
    }
    fn sub_len(field: u32, content: usize) -> usize {
        tag_len(field) + varint_len(content as u64) + content
    }

    fn led_len(l: &StoredLed) -> usize {
        i32_len(1, l.id as i32) + packed3_len(2)
    }
    fn map_len(m: &StoredMap) -> usize {
        let mut n = str_len(1, m.map_id.as_str())
            + str_len(3, UNITS)
            + str_len(4, FRAME)
            + i32_len(5, m.led_count as i32);
        for l in m.leds {
            n += sub_len(6, led_len(l));
        }
        n
    }
    fn bp_len(b: &StoredBranchPoint) -> usize {
        i32_len(1, b.id as i32) + packed3_len(2)
    }
    fn vec3_len() -> usize {
        packed3_len(1)
    }
    fn seg_len(s: &StoredSegment) -> usize {
        let mut n = i32_len(1, s.id as i32) + i32_len(2, s.a) + i32_len(3, s.b) + f64_len(5);
        for _ in s.polyline {
            n += sub_len(4, vec3_len());
        }
        n
    }
    fn assoc_len(a: &StoredAssociation) -> usize {
        i32_len(1, a.led_id as i32) + i32_len(2, a.segment_id as i32) + f64_len(3) + f64_len(4)
    }
    fn topo_len(t: &StoredTopology) -> usize {
        let mut n = str_len(1, t.map_id.as_str());
        for b in t.branch_points {
            n += sub_len(2, bp_len(b));
        }
        for s in t.segments {
            n += sub_len(3, seg_len(s));
        }
        for a in t.associations {
            n += sub_len(4, assoc_len(a));
        }
        n
    }

    /// Total encoded MappingBundle length in bytes.
    pub fn bundle_len(map: &StoredMap, topo: Option<&StoredTopology>) -> usize {
        let mut n = sub_len(1, map_len(map));
        if let Some(t) = topo {
            n += sub_len(2, topo_len(t));
        }
        n
    }

    // -- windowed encode ----------------------------------------------------
    struct Win<'b> {
        pos: usize,
        start: usize,
        end: usize,
        buf: &'b mut [u8],
        w: usize,
    }
    impl Win<'_> {
        fn put(&mut self, b: u8) {
            if self.pos >= self.start && self.pos < self.end {
                self.buf[self.w] = b;
                self.w += 1;
            }
            self.pos += 1;
        }
        fn bytes(&mut self, s: &[u8]) {
            for &b in s {
                self.put(b);
            }
        }
        fn varint(&mut self, mut v: u64) {
            loop {
                let mut byte = (v & 0x7f) as u8;
                v >>= 7;
                if v != 0 {
                    byte |= 0x80;
                }
                self.put(byte);
                if v == 0 {
                    break;
                }
            }
        }
        fn tag(&mut self, field: u32, wire: u32) {
            self.varint(((field as u64) << 3) | wire as u64);
        }
        fn i32_field(&mut self, field: u32, v: i32) {
            self.tag(field, 0);
            self.varint(v as i64 as u64);
        }
        fn f64_field(&mut self, field: u32, x: f64) {
            self.tag(field, 1);
            self.bytes(&x.to_le_bytes());
        }
        fn str_field(&mut self, field: u32, s: &str) {
            self.tag(field, 2);
            self.varint(s.len() as u64);
            self.bytes(s.as_bytes());
        }
        fn packed3(&mut self, field: u32, xyz: [f32; 3]) {
            self.tag(field, 2);
            self.varint(24);
            for c in xyz {
                self.bytes(&(c as f64).to_le_bytes());
            }
        }
        fn sub(&mut self, field: u32, content_len: usize) {
            self.tag(field, 2);
            self.varint(content_len as u64);
        }
    }

    fn enc_led(w: &mut Win, l: &StoredLed) {
        w.i32_field(1, l.id as i32);
        w.packed3(2, l.xyz);
    }
    fn enc_map(w: &mut Win, m: &StoredMap) {
        w.str_field(1, m.map_id.as_str());
        w.str_field(3, UNITS);
        w.str_field(4, FRAME);
        w.i32_field(5, m.led_count as i32);
        for l in m.leds {
            w.sub(6, led_len(l));
            enc_led(w, l);
        }
    }
    fn enc_topo(w: &mut Win, t: &StoredTopology) {
        w.str_field(1, t.map_id.as_str());
        for b in t.branch_points {
            w.sub(2, bp_len(b));
            w.i32_field(1, b.id as i32);
            w.packed3(2, b.xyz);
        }
        for s in t.segments {
            w.sub(3, seg_len(s));
            w.i32_field(1, s.id as i32);
            w.i32_field(2, s.a);
            w.i32_field(3, s.b);
            for p in s.polyline {
                w.sub(4, vec3_len());
                w.packed3(1, *p);
            }
            w.f64_field(5, s.length as f64);
        }
        for a in t.associations {
            w.sub(4, assoc_len(a));
            w.i32_field(1, a.led_id as i32);
            w.i32_field(2, a.segment_id as i32);
            w.f64_field(3, a.foot_arclength as f64);
            w.f64_field(4, a.d_perp as f64);
        }
    }

    /// Encode bytes `[start, start+buf.len())` of the MappingBundle into `buf`;
    /// returns the chunk length written (`< buf.len()` for the final window).
    pub fn encode_bundle_window(
        map: &StoredMap,
        topo: Option<&StoredTopology>,
        start: usize,
        buf: &mut [u8],
    ) -> usize {
        let end = start + buf.len();
        let mut w = Win { pos: 0, start, end, buf, w: 0 };
        w.sub(1, map_len(map));
        enc_map(&mut w, map);
        if let Some(t) = topo {
            w.sub(2, topo_len(t));
            enc_topo(&mut w, t);
        }
        w.w
    }
}
