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
    walk(&mut dec, frame_len, |field, wt, dec| match field {
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
    walk(&mut dec, frame_len, |field, wt, dec| match field {
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
