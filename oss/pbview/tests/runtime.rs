//! Runtime behavior: wire decoding, protobuf field semantics, malformed-input
//! robustness, and the backpatching writer.

use pbview::kind::{Double, Fixed32, Int32, Sint32, Sint64, Uint64};
use pbview::{
    last_len, last_scalar, read_varint, Error, Field, Reader, RepeatedLen, RepeatedScalar,
    RepeatedStr, Value, WireType, Writer,
};

fn enc(f: impl FnOnce(&mut Writer<'_>) -> Result<(), pbview::Full>) -> Vec<u8> {
    let mut buf = vec![0u8; 1 << 16];
    let mut w = Writer::new(&mut buf);
    f(&mut w).unwrap();
    let n = w.len();
    buf.truncate(n);
    buf
}

#[test]
fn varints() {
    for v in [0u64, 1, 127, 128, 300, u32::MAX as u64, u64::MAX] {
        let b = enc(|w| w.varint(v));
        assert_eq!(b.len(), pbview::varint_len(v));
        let mut pos = 0;
        assert_eq!(read_varint(&b, &mut pos), Ok(v));
        assert_eq!(pos, b.len());
    }
    // 11-byte and 10th-byte-overflow varints are rejected, not wrapped.
    let mut pos = 0;
    assert_eq!(read_varint(&[0xff; 11], &mut pos), Err(Error::Overlong));
    let mut over = vec![0xffu8; 9];
    over.push(0x02);
    let mut pos = 0;
    assert_eq!(read_varint(&over, &mut pos), Err(Error::Overlong));
    let mut pos = 0;
    assert_eq!(read_varint(&[0x80, 0x80], &mut pos), Err(Error::Truncated));
}

#[test]
fn scalars_round_trip_and_last_one_wins() {
    let b = enc(|w| {
        w.int32(1, -5)?;
        w.sint32(2, -64)?;
        w.sint64(3, i64::MIN)?;
        w.double(4, 1.25)?;
        w.fixed32(5, 0xdead_beef)?;
        w.uint64(6, u64::MAX)?;
        w.int32(1, 42) // a later occurrence of field 1 wins
    });
    assert_eq!(last_scalar::<Int32>(&b, 1), Some(42));
    assert_eq!(last_scalar::<Sint32>(&b, 2), Some(-64));
    assert_eq!(last_scalar::<Sint64>(&b, 3), Some(i64::MIN));
    assert_eq!(last_scalar::<Double>(&b, 4), Some(1.25));
    assert_eq!(last_scalar::<Fixed32>(&b, 5), Some(0xdead_beef));
    assert_eq!(last_scalar::<Uint64>(&b, 6), Some(u64::MAX));
    assert_eq!(last_scalar::<Int32>(&b, 9), None);
    // Wrong wire type for the kind: not a value of that field.
    assert_eq!(last_scalar::<Double>(&b, 1), None);
}

#[test]
fn repeated_accepts_packed_unpacked_and_mixed() {
    let b = enc(|w| {
        w.int32(7, 1)?; // unpacked
        // packed run [2, -3, 300]
        w.tag(7, WireType::Len)?;
        let mut run = vec![0u8; 64];
        let mut rw = Writer::new(&mut run);
        rw.varint(2)?;
        rw.varint(-3i64 as u64)?;
        rw.varint(300)?;
        let n = rw.len();
        w.varint(n as u64)?;
        w.raw(&run[..n])?;
        w.int32(7, 4)?;
        w.string(8, "x")?;
        w.string(8, "yz")?;
        w.bytes(8, &[0xff]) // not UTF-8: skipped by the str iterator
    });
    let v: Vec<i32> = RepeatedScalar::<Int32>::new(&b, 7).collect();
    assert_eq!(v, [1, 2, -3, 300, 4]);
    // A singular read of a repeated-encoded field: last element wins.
    assert_eq!(last_scalar::<Int32>(&b, 7), Some(4));
    let s: Vec<&str> = RepeatedStr::new(&b, 8).collect();
    assert_eq!(s, ["x", "yz"]);
    assert_eq!(RepeatedLen::new(&b, 8).count(), 3);
    assert_eq!(last_len(&b, 8), Some(&[0xffu8][..]));
}

#[test]
fn values_borrow_the_input() {
    let b = enc(|w| w.string(1, "zero-copy"));
    let s = last_len(&b, 1).unwrap();
    let base = b.as_ptr() as usize;
    assert!((s.as_ptr() as usize) > base && (s.as_ptr() as usize) < base + b.len());
}

#[test]
fn reader_reports_malformed_once_then_stops() {
    // len says 5, 2 bytes follow
    let mut r = Reader::new(&[0x12, 0x05, b'a', b'b']);
    assert_eq!(r.next(), Some(Err(Error::Truncated)));
    assert_eq!(r.next(), None);
    // field number 0
    assert_eq!(Reader::new(&[0x00, 0x01]).next(), Some(Err(Error::BadTag)));
    // group wire type
    assert_eq!(Reader::new(&[0x0b]).next(), Some(Err(Error::BadTag)));
    let f: Vec<Field<'_>> = Reader::new(&[0x08, 0x01]).map(|r| r.unwrap()).collect();
    assert_eq!(f, [Field { number: 1, value: Value::Varint(1) }]);
}

#[test]
fn writer_backpatches_nested_lengths() {
    for body_len in [0usize, 5, 127, 128, 300, 16383, 16384, 40000] {
        let payload = vec![0xabu8; body_len];
        let b = enc(|w| {
            w.int32(1, 7)?;
            w.message(2, |m| {
                if body_len > 0 {
                    m.bytes(1, &payload)?;
                }
                Ok(())
            })?;
            w.int32(3, 9)
        });
        let outer: Vec<Field<'_>> = Reader::new(&b).map(|r| r.unwrap()).collect();
        assert_eq!(outer.len(), 3, "body {body_len}");
        let Value::Len(inner) = outer[1].value else { panic!() };
        if body_len > 0 {
            assert_eq!(last_len(inner, 1).map(|p| p.len()), Some(body_len));
        } else {
            assert!(inner.is_empty());
        }
        assert_eq!(outer[2].value, Value::Varint(9));
    }
    // Too small a buffer: Full, never a panic.
    let mut small = [0u8; 4];
    let mut w = Writer::new(&mut small);
    assert!(w.message(1, |m| m.bytes(1, &[0; 200])).is_err());
}

/// Deterministic xorshift for the fuzz-style tests.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
}

#[test]
fn random_bytes_never_panic() {
    let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
    for _ in 0..20000 {
        let n = (rng.next() % 64) as usize;
        let buf: Vec<u8> = (0..n).map(|_| rng.next() as u8).collect();
        for f in Reader::new(&buf) {
            let _ = f;
        }
        let _ = last_scalar::<Int32>(&buf, 1);
        let _ = last_scalar::<Double>(&buf, 2);
        let _: Vec<i32> = RepeatedScalar::<Int32>::new(&buf, 1).take(100).collect();
        let _: Vec<&str> = RepeatedStr::new(&buf, 2).collect();
    }
}
