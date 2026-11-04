//! The on-device effect store (docs/design/effect-store.md): up to [`MAX_STORED`]
//! compiled effects kept on the player's littlefs, beside the deck-A effect it
//! resumes on boot. A client stores an effect without loading it
//! (`submit_effect{store: true}`), lists the store (`list_stored_effects`), loads
//! one onto a deck by id (`load_stored_effect`) and deletes one
//! (`delete_stored_effect`).
//!
//! Rust owns the record format and the protocol; C++ (main.cpp) owns the
//! filesystem and hands three hooks in at boot ([`lm_fxs_set_store`]), like the
//! keypoint store. One record per stored effect, file `fxs.<n>` (n < MAX_STORED)
//! under the FS base, written power-loss-safe (temp + fsync + rename). A record
//! is a small header followed by a submit_effect frame that loads the effect
//! onto deck A and activates it:
//!
//! ```text
//! "SFX1" | id_len u8 | id | name_len u8 | name | fxb_len u16 LE
//!        | summary_len u8 | summary (uniform names, ',' separated)
//! ClientMessage{submit_effect{effect_id, activate: true, fxb}}
//! ```
//!
//! The header is all a listing reads (the first [`HEADER_CAP`] bytes). A load
//! needs the whole record in memory (up to the 4 KiB .fxb), which this module
//! has no buffer for: main.cpp intercepts `load_stored_effect`, finds the record
//! ([`lm_fxs_find`]), stages the file on the heap and hands it to
//! [`lm_fxs_load`]. The frame inside is also exactly what deck-A persistence
//! writes to `/lfs/fx.pb`, so a loaded effect resumes on boot like a submitted
//! one.
//!
//! Everything runs on the loop task under the player mutex, so plain statics.

use core::ptr::{addr_of, addr_of_mut};

use ledmapper_fx_vm::{Program, FLAG_DRIVER};
use ledmapper_keypoint as kp;
use ledmapper_pb::ledmapper_::v1_ as pb;
use ledmapper_view::ledmapper::v1 as pv;

use super::{
    client_arm, deck, encode_reply, fx_error, submit_effect_view, varint_len, write_arm, CArm, PbOut, DECK_A_IDX,
    FX_LAST_DECK, FX_MAX_BYTES, N_DECKS,
};

/// ClientMessage arms of the store messages.
pub(crate) const ARM_LIST_STORED_EFFECTS: u32 = 95;
pub(crate) const ARM_LOAD_STORED_EFFECT: u32 = 96;
pub(crate) const ARM_DELETE_STORED_EFFECT: u32 = 97;
/// ServerMessage.stored_effect_list.
const SARM_STORED_EFFECT_LIST: u32 = 53;

/// Effects the store holds at most (8 × ≤ 4.3 KB of the 384 KB littlefs).
pub const MAX_STORED: usize = 8;
/// Bytes of a stored effect_id (as DeckState.id).
pub const MAX_ID: usize = 64;
/// Bytes of a display name.
pub const MAX_NAME: usize = 32;
/// Bytes of the uniform-name summary.
pub const SUMMARY_CAP: usize = 96;
/// The largest header: magic, the three length-prefixed strings, the fxb length.
pub const HEADER_CAP: usize = 4 + 1 + MAX_ID + 1 + MAX_NAME + 2 + 1 + SUMMARY_CAP;

const MAGIC: &[u8; 4] = b"SFX1";

/// A parsed record header (borrows the record).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Header<'a> {
    pub id: &'a [u8],
    pub name: &'a [u8],
    pub fxb_len: usize,
    /// Uniform names, ',' separated (truncated at a name).
    pub summary: &'a [u8],
    /// Where the submit_effect frame starts.
    pub frame_off: usize,
}

/// Parse the header at the start of `rec` (a whole record, or just its first
/// [`HEADER_CAP`] bytes).
pub fn parse_header(rec: &[u8]) -> Option<Header<'_>> {
    if rec.get(..4)? != MAGIC {
        return None;
    }
    let mut p = 4;
    let mut take = |p: &mut usize, n: usize| -> Option<&[u8]> {
        let s = rec.get(*p..*p + n)?;
        *p += n;
        Some(s)
    };
    let id_len = *take(&mut p, 1)?.first()? as usize;
    let id = take(&mut p, id_len)?;
    let name_len = *take(&mut p, 1)?.first()? as usize;
    let name = take(&mut p, name_len)?;
    let f = take(&mut p, 2)?;
    let fxb_len = u16::from_le_bytes([f[0], f[1]]) as usize;
    let summary_len = *take(&mut p, 1)?.first()? as usize;
    let summary = take(&mut p, summary_len)?;
    if id.is_empty() || id_len > MAX_ID || name_len > MAX_NAME || summary_len > SUMMARY_CAP {
        return None;
    }
    Some(Header { id, name, fxb_len, summary, frame_off: p })
}

/// The uniform names of `manifest`, ',' separated, cut at the last whole name
/// that fits [`SUMMARY_CAP`].
pub fn summarize(manifest: &[u8]) -> ([u8; SUMMARY_CAP], usize) {
    let mut s = [0u8; SUMMARY_CAP];
    let mut n = 0;
    let mut full = false;
    kp::for_each_uniform(manifest, |u| {
        let need = u.name.len() + usize::from(n > 0);
        if full || n + need > SUMMARY_CAP || u.name.contains(&b',') {
            full = true;
            return;
        }
        if n > 0 {
            s[n] = b',';
            n += 1;
        }
        s[n..n + u.name.len()].copy_from_slice(u.name);
        n += u.name.len();
    });
    (s, n)
}

fn varint(buf: &mut [u8], p: &mut usize, mut v: usize) {
    while v >= 0x80 {
        buf[*p] = (v as u8) | 0x80;
        v >>= 7;
        *p += 1;
    }
    buf[*p] = v as u8;
    *p += 1;
}

/// Bytes [`encode_prefix`] can write: the header plus the frame up to the fxb bytes.
pub const PREFIX_CAP: usize = HEADER_CAP + 3 * 3 + 1 + MAX_ID + 2 + 2 + 3;

/// The record up to the .fxb bytes: header, then the frame's envelope and fields
/// before `fxb` (the fxb is written last, so a record is `prefix ++ fxb`). `id`,
/// `name` and `summary` must be within their caps.
pub fn encode_prefix(id: &[u8], name: &[u8], summary: &[u8], fxb_len: usize) -> ([u8; PREFIX_CAP], usize) {
    let mut b = [0u8; PREFIX_CAP];
    let mut p = 0;
    let mut put = |b: &mut [u8; PREFIX_CAP], p: &mut usize, s: &[u8]| {
        b[*p..*p + s.len()].copy_from_slice(s);
        *p += s.len();
    };
    put(&mut b, &mut p, MAGIC);
    put(&mut b, &mut p, &[id.len() as u8]);
    put(&mut b, &mut p, id);
    put(&mut b, &mut p, &[name.len() as u8]);
    put(&mut b, &mut p, name);
    put(&mut b, &mut p, &(fxb_len as u16).to_le_bytes());
    put(&mut b, &mut p, &[summary.len() as u8]);
    put(&mut b, &mut p, summary);
    // SubmitEffect{1: effect_id, 3: activate = true, 2: fxb}.
    let body = 1 + varint_len(id.len() as u64) + id.len() + 2 + 1 + varint_len(fxb_len as u64) + fxb_len;
    b[p] = 21 << 3 | 2; // ClientMessage.submit_effect (field 21 needs a 2-byte key)
    b[p + 1] = 1;
    p += 2;
    varint(&mut b, &mut p, body);
    b[p] = 1 << 3 | 2;
    p += 1;
    varint(&mut b, &mut p, id.len());
    put(&mut b, &mut p, id);
    put(&mut b, &mut p, &[3 << 3, 1]);
    b[p] = 2 << 3 | 2;
    p += 1;
    varint(&mut b, &mut p, fxb_len);
    (b, p)
}

// -- the store (C++ hooks) ------------------------------------------------------

type FxsRead = unsafe extern "C" fn(name: *const u8, name_len: usize, buf: *mut u8, cap: usize) -> i32;
type FxsWrite =
    unsafe extern "C" fn(name: *const u8, name_len: usize, a: *const u8, a_len: usize, b: *const u8, b_len: usize) -> bool;
type FxsRemove = unsafe extern "C" fn(name: *const u8, name_len: usize);

static mut FXS_READ: Option<FxsRead> = None;
static mut FXS_WRITE: Option<FxsWrite> = None;
static mut FXS_REMOVE: Option<FxsRemove> = None;
/// The header buffer: every listing / lookup reads a record's first bytes here.
static mut FXS_HDR: [u8; HEADER_CAP] = [0; HEADER_CAP];
/// Whether the submit_effect just handled was a store (main.cpp must not persist
/// it as the deck-A effect).
pub(crate) static mut LAST_WAS_STORE: bool = false;

/// Install the effect store hooks (C++: littlefs). `write` stores `a ++ b`
/// atomically. Without them every store arm answers `no_store`.
///
/// # Safety
/// The hooks must be valid for the process lifetime; single firmware thread.
#[no_mangle]
pub unsafe extern "C" fn lm_fxs_set_store(read: Option<FxsRead>, write: Option<FxsWrite>, remove: Option<FxsRemove>) {
    FXS_READ = read;
    FXS_WRITE = write;
    FXS_REMOVE = remove;
}

/// Whether the submit_effect just handled stored the effect (nothing to persist).
///
/// # Safety
/// Single firmware thread, after `lm_player_handle`.
#[no_mangle]
pub unsafe extern "C" fn lm_fxs_last_was_store() -> bool {
    LAST_WAS_STORE
}

/// "fxs.<n>".
fn file(n: usize) -> ([u8; 5], usize) {
    ([b'f', b'x', b's', b'.', b'0' + n as u8], 5)
}

fn have_store() -> bool {
    unsafe { (*addr_of!(FXS_READ)).is_some() && (*addr_of!(FXS_WRITE)).is_some() }
}

/// Record `n`'s header, read into FXS_HDR.
unsafe fn header(n: usize) -> Option<Header<'static>> {
    let read = (*addr_of!(FXS_READ))?;
    let (f, fl) = file(n);
    let buf = &mut *addr_of_mut!(FXS_HDR);
    let got = read(f.as_ptr(), fl, buf.as_mut_ptr(), buf.len());
    if got <= 0 {
        return None;
    }
    parse_header(&(*addr_of!(FXS_HDR))[..got as usize])
}

/// The record holding `id`.
unsafe fn find(id: &[u8]) -> Option<usize> {
    (0..MAX_STORED).find(|&n| header(n).is_some_and(|h| h.id == id))
}

/// submit_effect{store: true}: validate the .fxb and keep it (replacing a record
/// with the same id), without touching the decks. Reply result_ready(effect_id).
pub(crate) unsafe fn handle_store(m: &pv::SubmitEffectView<'_>) -> pb::ServerMessage {
    LAST_WAS_STORE = true;
    if !have_store() {
        return fx_error("no_store", "the effect store is unavailable");
    }
    let id = m.effect_id().as_bytes();
    if id.is_empty() || id.len() > MAX_ID {
        return fx_error("bad_fxb", "a stored effect needs an effect_id of 1..64 bytes");
    }
    if !pbview::has_field(m.as_bytes(), pv::SubmitEffectView::FIELD_FXB) {
        return fx_error("bad_fxb", "submit_effect without fxb");
    }
    let fxb = m.fxb();
    if fxb.is_empty() || fxb.len() > FX_MAX_BYTES {
        return fx_error("effect_too_large", "fxb exceeds this player's effect buffer");
    }
    let Ok(prog) = Program::parse(fxb) else {
        return fx_error("bad_fxb", "fxb failed to parse");
    };
    if prog.flags & FLAG_DRIVER != 0 {
        return fx_error("bad_fxb", "a sensor driver is not an effect");
    }
    let name = m.name().as_bytes();
    let name = &name[..floor_char(name, MAX_NAME)];
    let Some(slot) = find(id).or_else(|| (0..MAX_STORED).find(|&n| header(n).is_none())) else {
        return fx_error("store_full", "the effect store is full: delete an effect first");
    };
    let (summary, sl) = summarize(prog.manifest);
    let (prefix, pl) = encode_prefix(id, name, &summary[..sl], fxb.len());
    let (f, fl) = file(slot);
    let write = (*addr_of!(FXS_WRITE)).unwrap();
    if !write(f.as_ptr(), fl, prefix.as_ptr(), pl, fxb.as_ptr(), fxb.len()) {
        return fx_error("no_store", "writing the effect store failed");
    }
    let mut r = pb::ResultReady::default();
    let _ = r.r#map_id.push_str(m.effect_id());
    pb::ServerMessage { r#msg: Some(pb::ServerMessage_::Msg::ResultReady(r)) }
}

/// The longest prefix of `s` within `cap` bytes that ends on a UTF-8 boundary.
fn floor_char(s: &[u8], cap: usize) -> usize {
    let mut n = s.len().min(cap);
    while n > 0 && n < s.len() && (s[n] & 0xc0) == 0x80 {
        n -= 1;
    }
    n
}

/// Decks that hold effect `id` right now.
unsafe fn decks_holding(id: &[u8]) -> ([u32; N_DECKS], usize) {
    let mut v = [0u32; N_DECKS];
    let mut n = 0;
    for d in 0..N_DECKS {
        if let Some(p) = deck(d) {
            if (*p).loaded() && &(*p).id[..(*p).id_len] == id {
                v[n] = d as u32;
                n += 1;
            }
        }
    }
    (v, n)
}

/// One StoredEffectInfo (field 1 of the list) for header `h`, into `w`.
unsafe fn write_info(w: &mut PbOut, h: &Header) {
    let (decks, nd) = decks_holding(h.id);
    let mut inner = 1 + varint_len(h.id.len() as u64) + h.id.len();
    if !h.name.is_empty() {
        inner += 1 + varint_len(h.name.len() as u64) + h.name.len();
    }
    inner += 1 + varint_len(h.fxb_len as u64);
    for u in h.summary.split(|&c| c == b',').filter(|u| !u.is_empty()) {
        inner += 1 + varint_len(u.len() as u64) + u.len();
    }
    let packed: usize = decks[..nd].iter().map(|&d| varint_len(d as u64)).sum();
    if nd > 0 {
        inner += 1 + varint_len(packed as u64) + packed;
    }
    w.key(1, 2);
    w.varint(inner as u64);
    w.bytes(1, h.id);
    if !h.name.is_empty() {
        w.bytes(2, h.name);
    }
    w.uint(3, h.fxb_len as u64);
    for u in h.summary.split(|&c| c == b',').filter(|u| !u.is_empty()) {
        w.bytes(4, u);
    }
    if nd > 0 {
        w.key(5, 2);
        w.varint(packed as u64);
        for &d in &decks[..nd] {
            w.varint(d as u64);
        }
    }
}

/// The StoredEffectList reply, zero-copy into `out`.
unsafe fn list_reply(out: *mut u8, cap: usize) -> i32 {
    write_arm(out, cap, SARM_STORED_EFFECT_LIST, |w| {
        for n in 0..MAX_STORED {
            if let Some(h) = header(n) {
                write_info(w, &h);
            }
        }
        w.uint(2, MAX_STORED as u64);
    })
}

/// list_stored_effects. Reply: stored_effect_list.
pub(crate) unsafe fn handle_list(out: *mut u8, cap: usize) -> i32 {
    if !have_store() {
        return encode_reply(&fx_error("no_store", "the effect store is unavailable"), out, cap);
    }
    list_reply(out, cap)
}

/// delete_stored_effect. Reply: stored_effect_list (what is left).
pub(crate) unsafe fn handle_delete(frame: &[u8], out: *mut u8, cap: usize) -> i32 {
    if !have_store() || (*addr_of!(FXS_REMOVE)).is_none() {
        return encode_reply(&fx_error("no_store", "the effect store is unavailable"), out, cap);
    }
    let id = match client_arm(frame) {
        Some(CArm::DeleteStoredEffect(m)) => m.effect_id(),
        _ => "",
    };
    let Some(n) = find(id.as_bytes()) else {
        return encode_reply(&fx_error("not_found", "no stored effect with that effect_id"), out, cap);
    };
    let (f, fl) = file(n);
    (*addr_of!(FXS_REMOVE)).unwrap()(f.as_ptr(), fl);
    list_reply(out, cap)
}

/// load_stored_effect reaching the player core: main.cpp loads a stored effect
/// itself ([`lm_fxs_load`]), so here it wasn't found (or there is no store).
pub(crate) unsafe fn handle_load_unstaged(frame: &[u8]) -> pb::ServerMessage {
    if let Some(CArm::LoadStoredEffect(m)) = client_arm(frame) {
        FX_LAST_DECK = super::deck_index(m.deck()) as u32;
    }
    if !have_store() {
        return fx_error("no_store", "the effect store is unavailable");
    }
    fx_error("not_found", "no stored effect with that effect_id")
}

/// The record (`fxs.<n>`) a load_stored_effect `frame` names, or -1.
///
/// # Safety
/// `frame` must point to `len` readable bytes; loop task, under the player mutex.
#[no_mangle]
pub unsafe extern "C" fn lm_fxs_find(frame: *const u8, len: usize) -> i32 {
    if frame.is_null() || !have_store() {
        return -1;
    }
    let frame = core::slice::from_raw_parts(frame, len);
    match client_arm(frame) {
        Some(CArm::LoadStoredEffect(m)) => find(m.effect_id().as_bytes()).map_or(-1, |n| n as i32),
        _ => -1,
    }
}

/// Load the stored effect in `rec` (the whole record `fxs.<n>` that
/// [`lm_fxs_find`] named, staged by main.cpp) onto the deck the
/// load_stored_effect `frame` asks for, exactly as submit_effect would. The reply
/// goes to `out` (its length is returned). When the load landed on deck A and
/// activated it, `*persist_off`/`*persist_len` locate the submit_effect frame in
/// `rec` that main.cpp persists as the boot effect; else `*persist_len` is 0.
///
/// # Safety
/// The pointers must be valid for their lengths; loop task, under the player mutex.
#[no_mangle]
pub unsafe extern "C" fn lm_fxs_load(
    frame: *const u8,
    len: usize,
    rec: *const u8,
    rec_len: usize,
    out: *mut u8,
    cap: usize,
    persist_off: *mut usize,
    persist_len: *mut usize,
) -> i32 {
    *persist_len = 0;
    let frame = core::slice::from_raw_parts(frame, len);
    let rec = core::slice::from_raw_parts(rec, rec_len);
    let Some(CArm::LoadStoredEffect(m)) = client_arm(frame) else {
        return encode_reply(&fx_error("not_found", "no stored effect with that effect_id"), out, cap);
    };
    let d = super::deck_index(m.deck());
    FX_LAST_DECK = d as u32;
    let stored = parse_header(rec).filter(|h| h.id == m.effect_id().as_bytes()).and_then(|h| {
        let inner = rec.get(h.frame_off..)?;
        match client_arm(inner) {
            Some(CArm::SubmitEffect(s)) => Some((s, h.frame_off, inner.len())),
            _ => None,
        }
    });
    let Some((s, off, flen)) = stored else {
        return encode_reply(&fx_error("bad_fxb", "the stored effect is damaged"), out, cap);
    };
    let reply = submit_effect_view(&s, d, m.activate());
    if d == DECK_A_IDX && m.activate() && matches!(reply.r#msg, Some(pb::ServerMessage_::Msg::ResultReady(_))) {
        *persist_off = off;
        *persist_len = flen;
    }
    encode_reply(&reply, out, cap)
}
