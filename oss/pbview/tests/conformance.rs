//! Generated views against protoc's own encoding of testdata/all.textproto
//! (every field kind), plus malformed-input robustness of generated `parse`.

use conformance_views::pbview::test::{all, AllView, Color, EmptyView, InnerView};
use pbview::{Error, View};

fn golden() -> Vec<u8> {
    std::fs::read(std::env::var("ALL_BIN").expect("ALL_BIN")).expect("golden encoding")
}

#[test]
fn every_field_kind_decodes() {
    let buf = golden();
    let m = AllView::parse(&buf).expect("protoc's encoding validates");
    assert_eq!(m.f_double(), -1.5);
    assert_eq!(m.f_float(), 2.25);
    assert_eq!(m.f_int64(), -9_000_000_000);
    assert_eq!(m.f_uint64(), u64::MAX);
    assert_eq!(m.f_int32(), -7);
    assert_eq!(m.f_fixed64(), 1_234_567_890_123);
    assert_eq!(m.f_fixed32(), 4_000_000_000);
    assert!(m.f_bool());
    assert_eq!(m.f_string(), "héllo");
    assert_eq!(m.f_bytes(), &[0, 1, 0xff]);
    assert_eq!(m.f_uint32(), 300);
    assert_eq!(Color::try_from(m.f_color()), Ok(Color::Green));
    assert_eq!(m.f_sfixed32(), -2);
    assert_eq!(m.f_sfixed64(), -3);
    assert_eq!(m.f_sint32(), -64);
    assert_eq!(m.f_sint64(), -1_000_000_000_000);

    // Nested message views, recursively.
    let inner = m.f_inner().expect("f_inner set");
    assert_eq!((inner.a(), inner.label()), (3, "in"));
    assert_eq!(inner.child().map(|c| c.a()), Some(4));
    assert!(inner.child().unwrap().child().is_none());

    // proto3 `optional`: presence is visible even for a default value.
    assert_eq!(m.opt_int32(), Some(0));
    assert_eq!(m.opt_string(), None);

    // Repeated: packed (protoc packs proto3 scalars by default) and unpacked.
    assert_eq!(m.r_packed().collect::<Vec<_>>(), [1, -2, 300]);
    assert_eq!(m.r_sint64().collect::<Vec<_>>(), [-1, 1]);
    assert_eq!(m.r_double().collect::<Vec<_>>(), [0.5, -0.25]);
    assert_eq!(m.r_string().collect::<Vec<_>>(), ["a", "", "ccc"]);
    let inners: Vec<(i32, &str)> = m.r_inner().map(|i| (i.a(), i.label())).collect();
    assert_eq!(inners, [(1, ""), (2, "two")]);
    assert_eq!(m.r_bytes().collect::<Vec<_>>(), [b"x"]);
    assert_eq!(m.r_color().collect::<Vec<_>>(), [Color::Red as i32, Color::Green as i32]);

    // Maps are repeated entry views.
    let counts: Vec<(&str, i32)> = m.counts().map(|e| (e.key(), e.value())).collect();
    assert_eq!(counts, [("k1", 1), ("k2", 2)]);

    // The oneof as a borrowed enum; members also have their own accessors.
    match m.choice() {
        Some(all::Choice::CText(t)) => assert_eq!(t, "picked"),
        other => panic!("expected c_text, got {other:?}"),
    }
    assert_eq!(m.c_text(), Some("picked"));
    assert!(m.c_inner().is_none());

    // Keyword fields, nested enum and nested message.
    assert_eq!(m.r#type(), 9);
    assert_eq!(m.r#match(), "m");
    assert_eq!(all::Mode::try_from(m.mode()), Ok(all::Mode::On));
    assert_eq!(m.nested().map(|n| n.x()), Some(77));
}

#[test]
fn single_pass_fields_iterator_sees_every_field() {
    let buf = golden();
    let m = AllView::parse(&buf).unwrap();
    let (mut packed, mut strings, mut unknown) = (Vec::new(), 0, 0);
    for f in m.fields() {
        match f {
            all::AnyField::RPacked(run) => packed.extend(run),
            all::AnyField::RString(_) => strings += 1,
            all::AnyField::Unknown(_) => unknown += 1,
            _ => {}
        }
    }
    assert_eq!(packed, [1, -2, 300]);
    assert_eq!(strings, 3);
    assert_eq!(unknown, 0);
}

#[test]
fn absent_fields_read_as_defaults() {
    let e = AllView::parse(&[]).unwrap();
    assert_eq!((e.f_int32(), e.f_string(), e.f_bool()), (0, "", false));
    assert!(e.f_inner().is_none() && e.choice().is_none() && e.opt_int32().is_none());
    assert_eq!(e.r_packed().count(), 0);
    assert!(EmptyView::parse(&[]).is_ok());
}

#[test]
fn parse_rejects_malformed_and_mistyped() {
    let buf = golden();
    // Every strict truncation of the encoding is rejected or decodes a valid
    // prefix (a cut on a field boundary) — never a panic.
    for n in 0..buf.len() {
        let _ = AllView::parse(&buf[..n]);
    }
    assert!(AllView::parse(&buf[..buf.len() - 1]).is_err());
    // f_int32 (5) sent as a string: wire mismatch.
    assert_eq!(AllView::parse(&[0x2a, 0x00]).unwrap_err(), Error::WireMismatch { field: 5 });
    // f_string (9) not UTF-8.
    assert_eq!(AllView::parse(&[0x4a, 0x01, 0xff]).unwrap_err(), Error::BadUtf8 { field: 9 });
    // Nested message garbage is caught by the recursive validation.
    assert!(AllView::parse(&[0x5a, 0x02, 0x08, 0x80]).is_err());
}

#[test]
fn nesting_depth_is_bounded() {
    // Inner.child nested 40 deep: past DEFAULT_MAX_DEPTH (32).
    let mut msg: Vec<u8> = Vec::new();
    for _ in 0..40 {
        let mut outer = vec![0x1a];
        let mut n = msg.len() as u64;
        loop {
            let b = (n & 0x7f) as u8;
            n >>= 7;
            outer.push(if n == 0 { b } else { b | 0x80 });
            if n == 0 {
                break;
            }
        }
        outer.extend_from_slice(&msg);
        msg = outer;
    }
    assert_eq!(InnerView::parse(&msg).unwrap_err(), Error::TooDeep);
    assert!(<InnerView<'_> as View<'_>>::validate(&msg, 64).is_ok());
}

#[test]
fn mutated_goldens_never_panic() {
    let buf = golden();
    let mut x: u64 = 0x2545_f491_4f6c_dd1d;
    for _ in 0..5000 {
        let mut m = buf.clone();
        for _ in 0..3 {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            let i = (x as usize) % m.len();
            m[i] = (x >> 32) as u8;
        }
        if let Ok(v) = AllView::parse(&m) {
            // Exercise every accessor on whatever validated.
            let _ = (v.f_double(), v.f_string(), v.f_inner().map(|i| i.label()), v.choice());
            let _: Vec<_> = v.r_inner().map(|i| i.child().map(|c| c.a())).collect();
            let _: Vec<_> = v.counts().map(|e| (e.key(), e.value())).collect();
        }
        // Unchecked views must be just as safe.
        let u = AllView::new_unchecked(&m);
        let _ = (u.f_string(), u.r_packed().count(), u.fields().count(), u.choice());
    }
}

#[test]
fn views_are_two_words() {
    assert_eq!(std::mem::size_of::<AllView<'_>>(), 2 * std::mem::size_of::<usize>());
    // The oneof enum holds a view or a slice: three words at most.
    assert!(std::mem::size_of::<all::Choice<'_>>() <= 3 * std::mem::size_of::<usize>());
}
