//! The on-device effect store (effect_store.rs, docs/design/effect-store.md)
//! through the C ABI, with an in-memory littlefs: store without loading, list
//! with names and uniform names, replace by id, the capacity bound, load onto a
//! deck (main.cpp's staged path: lm_fxs_find + lm_fxs_load) with its uniforms
//! editable after, the deck-A boot frame, delete, the error codes, and the kiosk
//! classes. Plus the record format on its own. One flow test: the FFI state is
//! process-global.

use std::collections::HashMap;
use std::sync::Mutex;

use ledmapper_pb::ledmapper_::v1_ as pb;
use ledmapper_player_ffi::effect_store::{
    encode_prefix, lm_fxs_find, lm_fxs_last_was_store, lm_fxs_load, lm_fxs_set_store, parse_header, summarize,
    MAX_STORED, SUMMARY_CAP,
};
use ledmapper_player_ffi::kiosk_ffi::{classify, Class};
use ledmapper_player_ffi::{lm_fx_last_deck, lm_player_handle, lm_player_init, FEATURES};
use micropb::{MessageDecode, MessageEncode, PbEncoder};
use pb::ClientMessage_::Msg as CMsg;
use pb::ServerMessage_::Msg as SMsg;

static FS: Mutex<Option<HashMap<String, Vec<u8>>>> = Mutex::new(None);

fn file_name(p: *const u8, n: usize) -> String {
    String::from_utf8(unsafe { std::slice::from_raw_parts(p, n) }.to_vec()).unwrap()
}

/// As main.cpp's kp_fs_read: the file's first `cap` bytes (a header read is partial).
unsafe extern "C" fn fs_read(name: *const u8, nl: usize, buf: *mut u8, cap: usize) -> i32 {
    let g = FS.lock().unwrap();
    match g.as_ref().unwrap().get(&file_name(name, nl)) {
        Some(v) if !v.is_empty() => {
            let n = v.len().min(cap);
            std::ptr::copy_nonoverlapping(v.as_ptr(), buf, n);
            n as i32
        }
        _ => -1,
    }
}

unsafe extern "C" fn fs_write(name: *const u8, nl: usize, a: *const u8, al: usize, b: *const u8, bl: usize) -> bool {
    let mut v = std::slice::from_raw_parts(a, al).to_vec();
    v.extend_from_slice(std::slice::from_raw_parts(b, bl));
    FS.lock().unwrap().as_mut().unwrap().insert(file_name(name, nl), v);
    true
}

unsafe extern "C" fn fs_remove(name: *const u8, nl: usize) {
    FS.lock().unwrap().as_mut().unwrap().remove(&file_name(name, nl));
}

fn encode(msg: CMsg) -> Vec<u8> {
    let env = pb::ClientMessage { r#msg: Some(msg) };
    let mut enc = PbEncoder::new(micropb::heapless::Vec::<u8, 8192>::new());
    env.encode(&mut enc).unwrap();
    enc.into_writer().to_vec()
}

fn decode(out: &[u8]) -> Option<SMsg> {
    let mut reply = pb::ServerMessage::default();
    reply.decode_from_bytes(out).expect("reply decodes");
    reply.r#msg
}

fn handle_frame(frame: &[u8]) -> Option<SMsg> {
    let mut out = vec![0u8; 4096];
    let n = unsafe { lm_player_handle(frame.as_ptr(), frame.len(), 0, 0, out.as_mut_ptr(), out.len()) };
    assert!(n >= 0, "handle returned {n}");
    (n > 0).then(|| decode(&out[..n as usize])).flatten()
}

fn handle(msg: CMsg) -> Option<SMsg> {
    handle_frame(&encode(msg))
}

fn err_code(r: Option<SMsg>) -> String {
    match r {
        Some(SMsg::Error(e)) => e.r#code.as_str().to_string(),
        other => panic!("expected an error, got {other:?}"),
    }
}

/// A raw protobuf LEN field (the generated SubmitEffect.fxb keeps the 64 B
/// default cap — the firmware walks it zero-copy — so submit is hand-encoded).
fn len_field(f: u32, b: &[u8]) -> Vec<u8> {
    let mut v = Vec::new();
    let mut put = |mut n: usize| {
        while n >= 0x80 {
            v.push((n as u8) | 0x80);
            n >>= 7;
        }
        v.push(n as u8);
    };
    put(((f << 3) | 2) as usize);
    put(b.len());
    v.extend_from_slice(b);
    v
}

fn compile(src: &str) -> Vec<u8> {
    ledmapper_fx_compiler::compile(src).expect("compiles").fxb
}

/// submit_effect{store: true, name} (activate + deck set too: a store ignores them).
fn store_frame(id: &str, name: &str, fxb: &[u8]) -> Vec<u8> {
    let mut body = len_field(1, id.as_bytes());
    body.extend(len_field(2, fxb));
    body.extend([3 << 3, 1, 4 << 3, 1, 5 << 3, 1]);
    body.extend(len_field(6, name.as_bytes()));
    len_field(21, &body)
}

fn store(id: &str, name: &str, src: &str) -> Option<SMsg> {
    handle_frame(&store_frame(id, name, &compile(src)))
}

fn submit(deck: u32, id: &str, src: &str) -> Option<SMsg> {
    let mut body = len_field(1, id.as_bytes());
    body.extend(len_field(2, &compile(src)));
    body.extend([3 << 3, 1, 4 << 3, deck as u8]);
    handle_frame(&len_field(21, &body))
}

fn list() -> pb::StoredEffectList {
    match handle(CMsg::ListStoredEffects(pb::ListStoredEffects::default())) {
        Some(SMsg::StoredEffectList(l)) => l,
        other => panic!("expected stored_effect_list, got {other:?}"),
    }
}

fn ids(l: &pb::StoredEffectList) -> Vec<String> {
    let mut v: Vec<String> = l.r#effects.iter().map(|e| e.r#effect_id.as_str().to_string()).collect();
    v.sort();
    v
}

fn entry<'a>(l: &'a pb::StoredEffectList, id: &str) -> &'a pb::StoredEffectInfo {
    l.r#effects.iter().find(|e| e.r#effect_id.as_str() == id).expect("listed")
}

fn load_msg(id: &str, deck: u32, activate: bool) -> Vec<u8> {
    let mut m = pb::LoadStoredEffect { r#deck: deck, r#activate: activate, ..Default::default() };
    m.r#effect_id = id.parse().unwrap();
    encode(CMsg::LoadStoredEffect(m))
}

/// What main.cpp does for load_stored_effect: find the record, stage the whole
/// file, load it. (reply, the persisted boot frame if any). None: not staged, the
/// player core answers instead.
fn load(id: &str, deck: u32, activate: bool) -> Option<(Option<SMsg>, Option<Vec<u8>>)> {
    let msg = load_msg(id, deck, activate);
    let slot = unsafe { lm_fxs_find(msg.as_ptr(), msg.len()) };
    if slot < 0 {
        return None;
    }
    let rec = FS.lock().unwrap().as_ref().unwrap().get(&format!("fxs.{slot}")).cloned().unwrap();
    let mut out = vec![0u8; 2048];
    let (mut off, mut plen) = (0usize, 0usize);
    let n = unsafe {
        lm_fxs_load(msg.as_ptr(), msg.len(), rec.as_ptr(), rec.len(), out.as_mut_ptr(), out.len(), &mut off, &mut plen)
    };
    assert!(n > 0, "load returned {n}");
    let persisted = (plen > 0).then(|| rec[off..off + plen].to_vec());
    Some((decode(&out[..n as usize]), persisted))
}

fn effect_list() -> Vec<(String, u32, bool)> {
    match handle(CMsg::ListEffects(pb::ListEffects::default())) {
        Some(SMsg::EffectList(l)) => {
            l.r#effects.iter().map(|e| (e.r#effect_id.as_str().to_string(), e.r#deck, e.r#active)).collect()
        }
        other => panic!("expected effect_list, got {other:?}"),
    }
}

const PLASMA: &str = r#"uniform vec3 tint : color = 1.0, 0.0, 0.0;
uniform float speed : 0.0 .. 4.0 = 1.0;
uniform float gain : 0.0 .. 1.0 = 1.0;
void update() {}
vec3 shade(Led led) { return tint * gain; }"#;

const GREEN: &str = r#"void update() {}
vec3 shade(Led led) { return vec3(0.0, 1.0, 0.0); }"#;

#[test]
fn record_format() {
    let (p, n) = encode_prefix(b"fx-1", b"Plasma", b"tint,gain", 300);
    let h = parse_header(&p[..n]).expect("parses");
    assert_eq!((h.id, h.name, h.fxb_len, h.summary), (&b"fx-1"[..], &b"Plasma"[..], 300, &b"tint,gain"[..]));
    // The frame after the header: ClientMessage{submit_effect{1: id, 3: true, 2: <300 B>}}.
    assert_eq!(&p[h.frame_off..h.frame_off + 2], &[0xaa, 0x01]);
    assert!(parse_header(b"SFX0....").is_none());
    assert!(parse_header(&p[..h.frame_off - 3]).is_none(), "a truncated header doesn't parse");

    // The summary stops at the last whole name that fits.
    let mut m = String::from("[");
    for i in 0..40 {
        m.push_str(&format!("{}{{\"name\":\"uniform_{i:02}\",\"slot\":{i}}}", if i > 0 { "," } else { "" }));
    }
    m.push(']');
    let (s, sl) = summarize(m.as_bytes());
    let s = std::str::from_utf8(&s[..sl]).unwrap();
    assert!(sl <= SUMMARY_CAP);
    assert!(s.starts_with("uniform_00,uniform_01"));
    assert!(s.split(',').all(|u| u.len() == 10), "{s}");
}

#[test]
fn store_list_load_delete() {
    *FS.lock().unwrap() = Some(HashMap::new());
    lm_player_init(1);
    assert!(FEATURES.contains(&"effect_store"));

    // Without hooks: no_store, cleanly.
    assert_eq!(err_code(store("plasma", "Plasma", PLASMA)), "no_store");
    assert_eq!(err_code(handle(CMsg::ListStoredEffects(pb::ListStoredEffects::default()))), "no_store");
    unsafe { lm_fxs_set_store(Some(fs_read), Some(fs_write), Some(fs_remove)) };

    // -- store without loading ---------------------------------------------------
    assert!(list().r#effects.is_empty());
    assert_eq!(list().r#capacity, MAX_STORED as u32);
    match store("plasma", "Plasma", PLASMA) {
        Some(SMsg::ResultReady(r)) => assert_eq!(r.r#map_id.as_str(), "plasma"),
        other => panic!("store replies result_ready, got {other:?}"),
    }
    assert!(unsafe { lm_fxs_last_was_store() }, "main.cpp must not persist it as deck A's");
    assert!(effect_list().is_empty(), "storing loads nothing (activate/deck ignored)");
    let l = list();
    let e = entry(&l, "plasma");
    assert_eq!(e.r#name.as_str(), "Plasma");
    assert!(e.r#fxb_bytes > 0);
    let us: Vec<&str> = e.r#uniforms.iter().map(|u| u.as_str()).collect();
    assert_eq!(us, ["tint", "speed", "gain"]);
    assert!(e.r#decks.is_empty());

    // Same id again: replaced in place, not a second record.
    store("plasma", "Plasma v2", PLASMA);
    assert_eq!(ids(&list()), ["plasma"]);
    assert_eq!(entry(&list(), "plasma").r#name.as_str(), "Plasma v2");

    // A plain submit is not a store.
    assert!(matches!(submit(0, "green", GREEN), Some(SMsg::ResultReady(_))));
    assert!(!unsafe { lm_fxs_last_was_store() });
    assert_eq!(ids(&list()), ["plasma"]);

    // Bad input.
    assert_eq!(err_code(handle_frame(&store_frame("junk", "", b"not an fxb"))), "bad_fxb");
    assert_eq!(err_code(handle_frame(&store_frame("", "", &compile(GREEN)))), "bad_fxb");
    assert_eq!(err_code(handle_frame(&store_frame("big", "", &vec![0u8; 5000]))), "effect_too_large");

    // -- capacity ------------------------------------------------------------------
    for i in 1..MAX_STORED {
        assert!(matches!(store(&format!("fx{i}"), "", GREEN), Some(SMsg::ResultReady(_))));
    }
    assert_eq!(list().r#effects.len(), MAX_STORED);
    assert_eq!(err_code(store("one-too-many", "", GREEN)), "store_full");
    // Replacing still works when full.
    assert!(matches!(store("fx1", "renamed", GREEN), Some(SMsg::ResultReady(_))));

    // -- load onto a deck ------------------------------------------------------------
    let (reply, boot) = load("plasma", 0, true).expect("found");
    match reply {
        Some(SMsg::ResultReady(r)) => assert_eq!(r.r#map_id.as_str(), "plasma"),
        other => panic!("load replies result_ready, got {other:?}"),
    }
    assert_eq!(unsafe { lm_fx_last_deck() }, 0);
    assert_eq!(effect_list(), [("plasma".to_string(), 0, true)]);
    // Deck A, activated: its frame is the boot effect, a plain activating submit.
    let boot = boot.expect("persisted");
    assert_eq!(boot[0..2], [0xaa, 0x01], "ClientMessage.submit_effect");
    assert!(handle_frame(&boot).is_some_and(|r| matches!(r, SMsg::ResultReady(_))), "the boot frame loads");
    assert_eq!(effect_list(), [("plasma".to_string(), 0, true)]);

    // The loaded effect's uniforms are the running effect's: readable and settable.
    match handle(CMsg::GetEffectUniforms(pb::GetEffectUniforms::default())) {
        Some(SMsg::EffectUniforms(u)) => {
            assert_eq!(u.r#effect_id.as_str(), "plasma");
            assert!(std::str::from_utf8(&u.r#manifest).unwrap().contains("\"speed\""));
        }
        other => panic!("expected effect_uniforms, got {other:?}"),
    }
    let mut v = pb::UniformValue { r#slot: 3, ..Default::default() };
    v.r#value.push(2.5).unwrap();
    let mut su = pb::SetUniforms::default();
    su.r#values.push(v).unwrap();
    assert!(matches!(handle(CMsg::SetUniforms(su)), Some(SMsg::PlaybackState(_))));
    match handle(CMsg::GetEffectUniforms(pb::GetEffectUniforms::default())) {
        Some(SMsg::EffectUniforms(u)) => {
            let speed = u.r#current.iter().find(|c| c.r#slot == 3).expect("speed's value");
            assert_eq!(&speed.r#value[..], &[2.5]);
        }
        other => panic!("expected effect_uniforms, got {other:?}"),
    }

    // Onto deck B, parked: runtime only, nothing to persist.
    let (reply, boot) = load("fx1", 1, false).expect("found");
    assert!(matches!(reply, Some(SMsg::ResultReady(_))));
    assert!(boot.is_none());
    assert_eq!(unsafe { lm_fx_last_deck() }, 1);
    let mut el = effect_list();
    el.sort();
    assert_eq!(el, [("fx1".to_string(), 1, false), ("plasma".to_string(), 0, true)]);
    let l = list();
    assert_eq!(&entry(&l, "plasma").r#decks[..], &[0]);
    assert_eq!(&entry(&l, "fx1").r#decks[..], &[1]);
    // Not in the store: main.cpp doesn't stage it, the player core says not_found.
    assert!(load("nope", 0, true).is_none());
    assert_eq!(err_code(handle_frame(&load_msg("nope", 0, true))), "not_found");

    // A damaged record is refused, the decks untouched.
    let slot = {
        let msg = load_msg("fx3", 0, true);
        unsafe { lm_fxs_find(msg.as_ptr(), msg.len()) }
    };
    {
        let mut g = FS.lock().unwrap();
        let rec = g.as_mut().unwrap().get_mut(&format!("fxs.{slot}")).unwrap();
        let n = rec.len();
        rec.truncate(n - 10);
    }
    let msg = load_msg("fx3", 0, true);
    let rec = FS.lock().unwrap().as_ref().unwrap().get(&format!("fxs.{slot}")).cloned().unwrap();
    let mut out = vec![0u8; 2048];
    let (mut off, mut plen) = (0, 0);
    let n = unsafe {
        lm_fxs_load(msg.as_ptr(), msg.len(), rec.as_ptr(), rec.len(), out.as_mut_ptr(), out.len(), &mut off, &mut plen)
    };
    assert_eq!(err_code(decode(&out[..n as usize])), "bad_fxb");
    assert_eq!(plen, 0);

    // -- delete ------------------------------------------------------------------------
    let mut d = pb::DeleteStoredEffect::default();
    d.r#effect_id = "plasma".parse().unwrap();
    match handle(CMsg::DeleteStoredEffect(d.clone())) {
        Some(SMsg::StoredEffectList(l)) => assert!(!ids(&l).contains(&"plasma".to_string())),
        other => panic!("delete replies stored_effect_list, got {other:?}"),
    }
    assert_eq!(err_code(handle(CMsg::DeleteStoredEffect(d))), "not_found");
    // What was loaded keeps running.
    assert!(effect_list().contains(&("plasma".to_string(), 0, true)));
    // The freed record takes the next store.
    assert!(matches!(store("again", "", GREEN), Some(SMsg::ResultReady(_))));
    assert_eq!(list().r#effects.len(), MAX_STORED);

    // Deck A, parked: runtime only, not persisted either.
    let (reply, boot) = load("fx2", 0, false).expect("found");
    assert!(matches!(reply, Some(SMsg::ResultReady(_))));
    assert!(boot.is_none());
    assert!(effect_list().contains(&("fx2".to_string(), 0, false)));
}

#[test]
fn kiosk_classes() {
    let stores = store_frame("x", "", b"");
    assert_eq!(classify(21, &stores), Class::Refuse, "a store writes the owner's flash");
    let mut plain = len_field(1, b"x");
    plain.extend([3 << 3, 1]);
    assert_eq!(classify(21, &len_field(21, &plain)), Class::Play);
    assert_eq!(classify(95, &[]), Class::Read);
    assert_eq!(classify(96, &load_msg("x", 0, true)), Class::Play);
    assert_eq!(classify(97, &[]), Class::Refuse);
}
