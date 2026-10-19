//! Zero-copy protobuf **views**: read a message straight from its wire bytes.
//!
//! A view is a validated `&'a [u8]` plus generated accessors. Nothing is
//! decoded into a struct, nothing is copied or allocated: strings and bytes
//! come back as borrows of the input, nested messages as further views,
//! repeated fields as iterators over the buffer. A view is two words, so a
//! handler that receives one costs a couple of registers of stack, not the
//! size of the largest message the schema can describe.
//!
//! This crate is the `no_std` runtime the `pbview-gen` generator targets:
//! - [`Reader`]: a bounded field iterator (never panics, never reads out of
//!   bounds; a malformed field ends iteration with an [`Error`]).
//! - [`kind`]: one marker type per protobuf scalar type, mapping wire values
//!   to Rust values ([`ScalarKind`]).
//! - Accessor helpers ([`last_scalar`], [`last_len`], [`RepeatedScalar`],
//!   [`RepeatedLen`], …) with protobuf semantics: last occurrence wins for
//!   singular scalars, packed and unpacked repeated encodings both accepted.
//! - Validation helpers the generated `parse` uses to check a buffer once, up
//!   front (framing, wire types, UTF-8, nesting depth), so accessors on a
//!   parsed view never silently skip anything.
//! - [`Writer`]: an encoder into `&mut [u8]` with in-place length
//!   backpatching for nested messages, so replies are built without a
//!   by-value message struct either.
//!
//! Deviation from full protobuf semantics, by design (zero-copy): a singular
//! *message* field that occurs more than once is not merged; the last
//! occurrence wins. Groups (wire types 3/4) are rejected.
#![no_std]
#![forbid(unsafe_code)]

use core::marker::PhantomData;

/// Why a buffer is not a valid encoding of the message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    /// The buffer ends inside a field.
    Truncated,
    /// A varint longer than 10 bytes, or one that overflows 64 bits.
    Overlong,
    /// Field number 0, or a group / reserved wire type.
    BadTag,
    /// A known field arrived with a wire type its schema type can't take.
    WireMismatch { field: u32 },
    /// A `string` field that is not UTF-8.
    BadUtf8 { field: u32 },
    /// Nested messages deeper than the parse limit.
    TooDeep,
    /// A packed repeated field whose payload is not a whole number of values.
    BadPacked { field: u32 },
}

pub type Result<T> = core::result::Result<T, Error>;

/// Protobuf wire types (groups are not supported).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WireType {
    Varint = 0,
    I64 = 1,
    Len = 2,
    I32 = 5,
}

/// One field's raw wire value. `Len` borrows the input (zero copy).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Value<'a> {
    Varint(u64),
    I64(u64),
    Len(&'a [u8]),
    I32(u32),
}

impl Value<'_> {
    pub fn wire_type(&self) -> WireType {
        match self {
            Value::Varint(_) => WireType::Varint,
            Value::I64(_) => WireType::I64,
            Value::Len(_) => WireType::Len,
            Value::I32(_) => WireType::I32,
        }
    }
}

/// A decoded field: its number and raw value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Field<'a> {
    pub number: u32,
    pub value: Value<'a>,
}

/// Read a varint at `*pos`, advancing it.
pub fn read_varint(buf: &[u8], pos: &mut usize) -> Result<u64> {
    let mut v: u64 = 0;
    for i in 0..10 {
        let b = *buf.get(*pos).ok_or(Error::Truncated)?;
        *pos += 1;
        // The 10th byte may only carry the top bit of a 64-bit value.
        if i == 9 && b > 1 {
            return Err(Error::Overlong);
        }
        v |= u64::from(b & 0x7f) << (7 * i);
        if b & 0x80 == 0 {
            return Ok(v);
        }
    }
    Err(Error::Overlong)
}

fn take<'a>(buf: &'a [u8], pos: &mut usize, n: usize) -> Result<&'a [u8]> {
    let end = pos.checked_add(n).ok_or(Error::Truncated)?;
    let s = buf.get(*pos..end).ok_or(Error::Truncated)?;
    *pos = end;
    Ok(s)
}

/// Bounded field iterator over an encoded message. Yields `Err` once (and then
/// stops) on malformed input; never panics or reads out of bounds.
#[derive(Debug, Clone)]
pub struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
    done: bool,
}

impl<'a> Reader<'a> {
    pub const fn new(buf: &'a [u8]) -> Self {
        Reader { buf, pos: 0, done: false }
    }

    /// Bytes not yet consumed.
    pub fn remaining(&self) -> &'a [u8] {
        self.buf.get(self.pos..).unwrap_or(&[])
    }

    fn field(&mut self) -> Result<Field<'a>> {
        let tag = read_varint(self.buf, &mut self.pos)?;
        let number = u32::try_from(tag >> 3).map_err(|_| Error::BadTag)?;
        if number == 0 {
            return Err(Error::BadTag);
        }
        let value = match tag & 7 {
            0 => Value::Varint(read_varint(self.buf, &mut self.pos)?),
            1 => {
                let b = take(self.buf, &mut self.pos, 8)?;
                let mut a = [0u8; 8];
                a.copy_from_slice(b);
                Value::I64(u64::from_le_bytes(a))
            }
            2 => {
                let n = read_varint(self.buf, &mut self.pos)?;
                let n = usize::try_from(n).map_err(|_| Error::Truncated)?;
                Value::Len(take(self.buf, &mut self.pos, n)?)
            }
            5 => {
                let b = take(self.buf, &mut self.pos, 4)?;
                let mut a = [0u8; 4];
                a.copy_from_slice(b);
                Value::I32(u32::from_le_bytes(a))
            }
            _ => return Err(Error::BadTag),
        };
        Ok(Field { number, value })
    }
}

impl<'a> Iterator for Reader<'a> {
    type Item = Result<Field<'a>>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.done || self.pos >= self.buf.len() {
            return None;
        }
        let r = self.field();
        if r.is_err() {
            self.done = true;
        }
        Some(r)
    }
}

/// The fields of `buf` that parse, stopping at the first malformed one. Used by
/// accessors, which are defensive even on an unvalidated view.
pub fn fields(buf: &[u8]) -> impl Iterator<Item = Field<'_>> {
    Reader::new(buf).map_while(|r| r.ok())
}

/// A protobuf scalar type: its wire type and value mapping.
pub trait ScalarKind {
    type Out: Copy;
    /// The non-packed wire type.
    const WIRE: WireType;
    /// Whether a repeated field of this type may be packed.
    const PACKABLE: bool = true;
    fn from_value(v: Value<'_>) -> Option<Self::Out>;
    /// Decode one element of a packed run at `*pos`.
    fn from_packed(buf: &[u8], pos: &mut usize) -> Result<Self::Out>;
}

/// Marker types, one per protobuf scalar type.
pub mod kind {
    use super::*;

    macro_rules! varint_kind {
        ($name:ident, $out:ty, |$v:ident| $conv:expr) => {
            pub struct $name;
            impl ScalarKind for $name {
                type Out = $out;
                const WIRE: WireType = WireType::Varint;
                fn from_value(v: Value<'_>) -> Option<$out> {
                    match v {
                        Value::Varint($v) => Some($conv),
                        _ => None,
                    }
                }
                fn from_packed(buf: &[u8], pos: &mut usize) -> Result<$out> {
                    let $v = read_varint(buf, pos)?;
                    Ok($conv)
                }
            }
        };
    }
    macro_rules! fixed_kind {
        ($name:ident, $out:ty, $wire:ident, $n:expr, $raw:ty, |$v:ident| $conv:expr) => {
            pub struct $name;
            impl ScalarKind for $name {
                type Out = $out;
                const WIRE: WireType = WireType::$wire;
                fn from_value(v: Value<'_>) -> Option<$out> {
                    match v {
                        Value::$wire(raw) => {
                            let $v = raw as $raw;
                            Some($conv)
                        }
                        _ => None,
                    }
                }
                fn from_packed(buf: &[u8], pos: &mut usize) -> Result<$out> {
                    let b = take(buf, pos, $n)?;
                    let mut a = [0u8; $n];
                    a.copy_from_slice(b);
                    let $v = <$raw>::from_le_bytes(a);
                    Ok($conv)
                }
            }
        };
    }

    // int32/int64 are sign-extended to 64 bits on the wire; truncation is the
    // protobuf-specified narrowing.
    varint_kind!(Int32, i32, |v| v as i32);
    varint_kind!(Int64, i64, |v| v as i64);
    varint_kind!(Uint32, u32, |v| v as u32);
    varint_kind!(Uint64, u64, |v| v);
    varint_kind!(Sint32, i32, |v| ((v as u32) >> 1) as i32 ^ -((v as u32 & 1) as i32));
    varint_kind!(Sint64, i64, |v| (v >> 1) as i64 ^ -((v & 1) as i64));
    varint_kind!(Bool, bool, |v| v != 0);
    // Enum: an enum field's raw value (proto3 enums are open: unknown values are kept).
    varint_kind!(Enum, i32, |v| v as i32);
    fixed_kind!(Fixed32, u32, I32, 4, u32, |v| v);
    fixed_kind!(Sfixed32, i32, I32, 4, u32, |v| v as i32);
    fixed_kind!(Float, f32, I32, 4, u32, |v| f32::from_bits(v));
    fixed_kind!(Fixed64, u64, I64, 8, u64, |v| v);
    fixed_kind!(Sfixed64, i64, I64, 8, u64, |v| v as i64);
    fixed_kind!(Double, f64, I64, 8, u64, |v| f64::from_bits(v));
}

/// A generated message view: constructible from a buffer `validate` accepted.
pub trait View<'a>: Sized + Copy {
    /// Check `buf` is a valid encoding of this message, recursing into nested
    /// messages up to `depth` levels.
    fn validate(buf: &[u8], depth: u32) -> Result<()>;
    /// Wrap bytes without checking them (accessors stay bounds-safe and simply
    /// stop at malformed data).
    fn from_bytes_unchecked(buf: &'a [u8]) -> Self;
    /// The view's underlying bytes.
    fn as_bytes(&self) -> &'a [u8];
}

/// Default nesting limit for `parse`.
pub const DEFAULT_MAX_DEPTH: u32 = 32;

/// The last occurrence of singular scalar field `num` (protobuf: last wins).
/// A packed run under a singular field contributes its last element.
pub fn last_scalar<K: ScalarKind>(buf: &[u8], num: u32) -> Option<K::Out> {
    let mut out = None;
    for f in fields(buf) {
        if f.number != num {
            continue;
        }
        if let Some(v) = K::from_value(f.value) {
            out = Some(v);
        } else if let (Value::Len(run), true) = (f.value, K::PACKABLE) {
            let mut pos = 0;
            while pos < run.len() {
                match K::from_packed(run, &mut pos) {
                    Ok(v) => out = Some(v),
                    Err(_) => break,
                }
            }
        }
    }
    out
}

/// The last length-delimited occurrence of field `num`.
pub fn last_len(buf: &[u8], num: u32) -> Option<&[u8]> {
    let mut out = None;
    for f in fields(buf) {
        if let (true, Value::Len(b)) = (f.number == num, f.value) {
            out = Some(b);
        }
    }
    out
}

/// Whether field `num` occurs at all.
pub fn has_field(buf: &[u8], num: u32) -> bool {
    fields(buf).any(|f| f.number == num)
}

/// Every length-delimited occurrence of field `num`, in order.
#[derive(Clone)]
pub struct RepeatedLen<'a> {
    inner: Reader<'a>,
    num: u32,
}

impl<'a> RepeatedLen<'a> {
    pub fn new(buf: &'a [u8], num: u32) -> Self {
        RepeatedLen { inner: Reader::new(buf), num }
    }
}

impl<'a> Iterator for RepeatedLen<'a> {
    type Item = &'a [u8];
    fn next(&mut self) -> Option<&'a [u8]> {
        loop {
            let f = self.inner.next()?.ok()?;
            if let (true, Value::Len(b)) = (f.number == self.num, f.value) {
                return Some(b);
            }
        }
    }
}

/// Every occurrence of repeated `string` field `num` (non-UTF-8 entries, which
/// `parse` rejects, are skipped on an unchecked view).
#[derive(Clone)]
pub struct RepeatedStr<'a>(RepeatedLen<'a>);

impl<'a> RepeatedStr<'a> {
    pub fn new(buf: &'a [u8], num: u32) -> Self {
        RepeatedStr(RepeatedLen::new(buf, num))
    }
}

impl<'a> Iterator for RepeatedStr<'a> {
    type Item = &'a str;
    fn next(&mut self) -> Option<&'a str> {
        loop {
            if let Ok(s) = core::str::from_utf8(self.0.next()?) {
                return Some(s);
            }
        }
    }
}

/// Every occurrence of repeated message field `num`, as views.
pub struct RepeatedMsg<'a, V> {
    inner: RepeatedLen<'a>,
    _v: PhantomData<V>,
}

impl<'a, V> Clone for RepeatedMsg<'a, V> {
    fn clone(&self) -> Self {
        RepeatedMsg { inner: self.inner.clone(), _v: PhantomData }
    }
}

impl<'a, V: View<'a>> RepeatedMsg<'a, V> {
    pub fn new(buf: &'a [u8], num: u32) -> Self {
        RepeatedMsg { inner: RepeatedLen::new(buf, num), _v: PhantomData }
    }
}

impl<'a, V: View<'a>> Iterator for RepeatedMsg<'a, V> {
    type Item = V;
    fn next(&mut self) -> Option<V> {
        self.inner.next().map(V::from_bytes_unchecked)
    }
}

/// Every element of repeated scalar field `num`, accepting both the packed and
/// the unpacked encoding (and a mix of them), in wire order.
pub struct RepeatedScalar<'a, K: ScalarKind> {
    inner: Reader<'a>,
    num: u32,
    run: &'a [u8],
    run_pos: usize,
    single: Option<K::Out>,
    _k: PhantomData<K>,
}

impl<'a, K: ScalarKind> Clone for RepeatedScalar<'a, K> {
    fn clone(&self) -> Self {
        RepeatedScalar {
            inner: self.inner.clone(),
            num: self.num,
            run: self.run,
            run_pos: self.run_pos,
            single: self.single,
            _k: PhantomData,
        }
    }
}

impl<'a, K: ScalarKind> RepeatedScalar<'a, K> {
    pub fn new(buf: &'a [u8], num: u32) -> Self {
        RepeatedScalar {
            inner: Reader::new(buf),
            num,
            run: &[],
            run_pos: 0,
            single: None,
            _k: PhantomData,
        }
    }

    /// The elements of ONE occurrence (a single value or a packed run).
    pub fn of_value(v: Value<'a>) -> Self {
        let mut it = RepeatedScalar::new(&[], 0);
        match v {
            Value::Len(run) => it.run = run,
            other => it.single = K::from_value(other),
        }
        it
    }
}

impl<'a, K: ScalarKind> Iterator for RepeatedScalar<'a, K> {
    type Item = K::Out;
    fn next(&mut self) -> Option<K::Out> {
        if let Some(v) = self.single.take() {
            return Some(v);
        }
        loop {
            if self.run_pos < self.run.len() {
                match K::from_packed(self.run, &mut self.run_pos) {
                    Ok(v) => return Some(v),
                    Err(_) => self.run_pos = self.run.len(),
                }
                continue;
            }
            let f = self.inner.next()?.ok()?;
            if f.number != self.num {
                continue;
            }
            if let Some(v) = K::from_value(f.value) {
                return Some(v);
            }
            if let (Value::Len(run), true) = (f.value, K::PACKABLE) {
                self.run = run;
                self.run_pos = 0;
            }
        }
    }
}

// --- validation (used by generated `validate`) ------------------------------

/// Check a known scalar field's occurrence: its wire type (or a well-formed
/// packed run when `repeated`).
pub fn check_scalar<K: ScalarKind>(f: &Field<'_>, repeated: bool) -> Result<()> {
    if f.value.wire_type() == K::WIRE {
        return Ok(());
    }
    if let (Value::Len(run), true) = (f.value, repeated && K::PACKABLE) {
        let mut pos = 0;
        while pos < run.len() {
            K::from_packed(run, &mut pos).map_err(|_| Error::BadPacked { field: f.number })?;
        }
        return Ok(());
    }
    Err(Error::WireMismatch { field: f.number })
}

/// Check a known `bytes` field's occurrence.
pub fn check_bytes<'a>(f: &Field<'a>) -> Result<&'a [u8]> {
    match f.value {
        Value::Len(b) => Ok(b),
        _ => Err(Error::WireMismatch { field: f.number }),
    }
}

/// Check a known `string` field's occurrence (UTF-8).
pub fn check_str(f: &Field<'_>) -> Result<()> {
    let b = check_bytes(f)?;
    core::str::from_utf8(b).map(|_| ()).map_err(|_| Error::BadUtf8 { field: f.number })
}

/// Check a known message field's occurrence, recursing with `depth - 1`.
pub fn check_msg<'a, V: View<'a>>(f: &Field<'_>, depth: u32) -> Result<()> {
    let b = check_bytes(f)?;
    if depth == 0 {
        return Err(Error::TooDeep);
    }
    V::validate(b, depth - 1)
}

/// Decode a string accessor's bytes (`""` on an unchecked, non-UTF-8 view).
pub fn str_of(b: &[u8]) -> &str {
    core::str::from_utf8(b).unwrap_or("")
}

// --- encoding ---------------------------------------------------------------

/// The output buffer is too small.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Full;

/// Bytes `v` takes as a varint.
pub const fn varint_len(v: u64) -> usize {
    let mut n = 1;
    let mut v = v >> 7;
    while v != 0 {
        n += 1;
        v >>= 7;
    }
    n
}

/// A protobuf encoder writing straight into a caller's buffer. Nested messages
/// ([`Writer::message`]) are written in place and their length prefix
/// backpatched, so no message struct (and no second buffer) is needed.
pub struct Writer<'b> {
    buf: &'b mut [u8],
    pos: usize,
}

impl<'b> Writer<'b> {
    pub fn new(buf: &'b mut [u8]) -> Self {
        Writer { buf, pos: 0 }
    }

    /// Bytes written so far.
    pub fn len(&self) -> usize {
        self.pos
    }

    pub fn is_empty(&self) -> bool {
        self.pos == 0
    }

    /// The encoded bytes.
    pub fn as_bytes(&self) -> &[u8] {
        &self.buf[..self.pos]
    }

    pub fn raw(&mut self, b: &[u8]) -> core::result::Result<(), Full> {
        let end = self.pos.checked_add(b.len()).ok_or(Full)?;
        self.buf.get_mut(self.pos..end).ok_or(Full)?.copy_from_slice(b);
        self.pos = end;
        Ok(())
    }

    pub fn varint(&mut self, mut v: u64) -> core::result::Result<(), Full> {
        loop {
            let b = (v & 0x7f) as u8;
            v >>= 7;
            if v == 0 {
                return self.raw(&[b]);
            }
            self.raw(&[b | 0x80])?;
        }
    }

    pub fn tag(&mut self, field: u32, wire: WireType) -> core::result::Result<(), Full> {
        self.varint((u64::from(field) << 3) | wire as u64)
    }

    pub fn uint64(&mut self, field: u32, v: u64) -> core::result::Result<(), Full> {
        self.tag(field, WireType::Varint)?;
        self.varint(v)
    }
    pub fn int64(&mut self, field: u32, v: i64) -> core::result::Result<(), Full> {
        self.uint64(field, v as u64)
    }
    pub fn int32(&mut self, field: u32, v: i32) -> core::result::Result<(), Full> {
        self.uint64(field, i64::from(v) as u64)
    }
    pub fn uint32(&mut self, field: u32, v: u32) -> core::result::Result<(), Full> {
        self.uint64(field, u64::from(v))
    }
    pub fn sint32(&mut self, field: u32, v: i32) -> core::result::Result<(), Full> {
        self.uint64(field, u64::from(((v << 1) ^ (v >> 31)) as u32))
    }
    pub fn sint64(&mut self, field: u32, v: i64) -> core::result::Result<(), Full> {
        self.uint64(field, ((v << 1) ^ (v >> 63)) as u64)
    }
    pub fn bool(&mut self, field: u32, v: bool) -> core::result::Result<(), Full> {
        self.uint64(field, u64::from(v))
    }
    pub fn fixed32(&mut self, field: u32, v: u32) -> core::result::Result<(), Full> {
        self.tag(field, WireType::I32)?;
        self.raw(&v.to_le_bytes())
    }
    pub fn float(&mut self, field: u32, v: f32) -> core::result::Result<(), Full> {
        self.fixed32(field, v.to_bits())
    }
    pub fn fixed64(&mut self, field: u32, v: u64) -> core::result::Result<(), Full> {
        self.tag(field, WireType::I64)?;
        self.raw(&v.to_le_bytes())
    }
    pub fn double(&mut self, field: u32, v: f64) -> core::result::Result<(), Full> {
        self.fixed64(field, v.to_bits())
    }
    pub fn bytes(&mut self, field: u32, v: &[u8]) -> core::result::Result<(), Full> {
        self.tag(field, WireType::Len)?;
        self.varint(v.len() as u64)?;
        self.raw(v)
    }
    pub fn string(&mut self, field: u32, v: &str) -> core::result::Result<(), Full> {
        self.bytes(field, v.as_bytes())
    }

    /// Write nested message `field` with `body` encoding its fields in place.
    /// The length prefix is reserved as one byte and, if the body turns out
    /// longer than 127 bytes, the body is shifted right to make room (one
    /// in-buffer memmove; no second buffer).
    pub fn message(
        &mut self,
        field: u32,
        body: impl FnOnce(&mut Writer<'_>) -> core::result::Result<(), Full>,
    ) -> core::result::Result<(), Full> {
        self.tag(field, WireType::Len)?;
        let len_at = self.pos;
        self.raw(&[0])?;
        let start = self.pos;
        {
            let mut inner = Writer { buf: &mut self.buf[start..], pos: 0 };
            body(&mut inner)?;
            self.pos = start + inner.pos;
        }
        let n = self.pos - start;
        let need = varint_len(n as u64);
        if need > 1 {
            let extra = need - 1;
            let end = self.pos.checked_add(extra).ok_or(Full)?;
            if end > self.buf.len() {
                return Err(Full);
            }
            self.buf.copy_within(start..self.pos, start + extra);
            self.pos = end;
        }
        // Write the length varint into the reserved slot(s).
        let mut v = n as u64;
        let mut at = len_at;
        loop {
            let b = (v & 0x7f) as u8;
            v >>= 7;
            self.buf[at] = if v == 0 { b } else { b | 0x80 };
            at += 1;
            if v == 0 {
                break;
            }
        }
        Ok(())
    }
}
