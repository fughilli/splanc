//! Host tests for the OTA core: digest, manifest layout, the receive session
//! (ordering, erase planning, persistence cadence, resume after a power cut on a
//! simulated NOR flash), the image header gate, and the boot/health decisions.

use splanc_ota::boot::{self, AppState, Handoff, Health, LoaderAction, LoaderInputs, Reason, Reset, Verdict};
use splanc_ota::image::{self, ImageError, CHIP_ESP32C3, CHIP_ESP32C6};
use splanc_ota::manifest::{self, Manifest, ENCODED_LEN, FLAG_LOADER};
use splanc_ota::session::{self, Refusal, Resume, Session, Target, MAX_CHUNK, PERSIST_EVERY, SECTOR};
use splanc_ota::sha256::{sha256, Sha256};

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

// -- sha256 ---------------------------------------------------------------------------

#[test]
fn sha256_known_answers() {
    assert_eq!(hex(&sha256(b"")), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    assert_eq!(hex(&sha256(b"abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    assert_eq!(
        hex(&sha256(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")),
        "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
    );
    let million_a = vec![b'a'; 1_000_000];
    assert_eq!(hex(&sha256(&million_a)), "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
}

#[test]
fn sha256_streaming_matches_one_shot_for_any_split() {
    let data: Vec<u8> = (0..1000u32).map(|i| (i * 7 + 3) as u8).collect();
    let want = sha256(&data);
    for split in [0, 1, 55, 56, 63, 64, 65, 127, 128, 500, 999, 1000] {
        let mut h = Sha256::new();
        h.update(&data[..split]);
        h.update(&data[split..]);
        assert_eq!(h.finish(), want, "split {split}");
    }
}

// -- manifest -------------------------------------------------------------------------

fn manifest_for(image: &[u8], version: u32) -> Manifest {
    let mut m = Manifest::unsigned(version, image.len() as u32, sha256(image), 0);
    m.signature = [0x5a; 64];
    m
}

#[test]
fn manifest_layout_is_the_swarm_layout() {
    let m = Manifest { version: 0x01020304, size: 0x0a0b0c0d, sha256: [7; 32], flags: 1, signature: [9; 64] };
    let b = m.encode();
    assert_eq!(b.len(), 108, "one UWB frame in the swarm; one wire field here");
    assert_eq!(&b[0..4], &[4, 3, 2, 1]);
    assert_eq!(&b[4..8], &[0x0d, 0x0c, 0x0b, 0x0a]);
    assert_eq!(&b[8..40], &[7; 32]);
    assert_eq!(&b[40..44], &[1, 0, 0, 0]);
    assert_eq!(&b[44..], &[9; 64][..]);
    assert_eq!(Manifest::decode(&b), Some(m));
    assert_eq!(&m.signed_bytes()[..], &b[..44]);
    assert_eq!(Manifest::decode(&b[..107]), None);
    let mut long = b.to_vec();
    long.push(0);
    assert_eq!(Manifest::decode(&long), None);
}

#[test]
fn versions() {
    assert_eq!(manifest::parse_version("1.9.0"), Some(1_009_000));
    assert_eq!(manifest::parse_version("v1.10.3"), Some(1_010_003));
    assert_eq!(manifest::parse_version("2.0.1-4-gabcdef"), Some(2_000_001));
    assert_eq!(manifest::parse_version("0.0.0-dev"), Some(0));
    assert!(manifest::parse_version("1.9.0") < manifest::parse_version("1.10.0"));
    for bad in ["", "1", "1.2", "1.2.3.4", "a.b.c", "1.1000.0", "1..2"] {
        assert_eq!(manifest::parse_version(bad), None, "{bad}");
    }
}

// -- image header ---------------------------------------------------------------------

fn app_image(chip: u16, len: usize) -> Vec<u8> {
    let mut b: Vec<u8> = (0..len as u32).map(|i| (i.wrapping_mul(2654435761) >> 24) as u8).collect();
    b[0] = image::IMAGE_MAGIC;
    b[1] = 4;
    b[12..14].copy_from_slice(&chip.to_le_bytes());
    b[23] = 1;
    b[32..36].copy_from_slice(&image::APP_DESC_MAGIC.to_le_bytes());
    b
}

#[test]
fn image_header_gate() {
    let ok = app_image(CHIP_ESP32C6, 64);
    assert_eq!(image::check_header(&ok, CHIP_ESP32C6), Ok(()));
    assert_eq!(image::check_header(&ok, CHIP_ESP32C3), Err(ImageError::WrongChip { got: CHIP_ESP32C6 }));
    assert_eq!(image::check_header(&ok[..20], CHIP_ESP32C6), Err(ImageError::Short));
    let mut bad = ok.clone();
    bad[0] = 0;
    assert_eq!(image::check_header(&bad, CHIP_ESP32C6), Err(ImageError::BadMagic));
    let mut nohash = ok.clone();
    nohash[23] = 0;
    assert_eq!(image::check_header(&nohash, CHIP_ESP32C6), Err(ImageError::NoAppendedHash));
    let mut notapp = ok;
    notapp[32] ^= 1;
    assert_eq!(image::check_header(&notapp, CHIP_ESP32C6), Err(ImageError::NotAnApp));
}

// -- offers ---------------------------------------------------------------------------

const SLOT: u32 = 0x240000;

fn target(installed: u32) -> Target {
    Target { slot_size: SLOT, chip: CHIP_ESP32C6, installed_version: installed }
}

#[test]
fn offers_are_checked_before_anything_is_touched() {
    let img = app_image(CHIP_ESP32C6, 10_000);
    let m = manifest_for(&img, 1_009_000);
    assert!(session::check_offer(&m, true, &target(0), false).is_ok());
    assert_eq!(session::check_offer(&m, false, &target(0), false), Err(Refusal::BadSignature));
    let mut loader = m;
    loader.flags = FLAG_LOADER;
    assert_eq!(session::check_offer(&loader, true, &target(0), false), Err(Refusal::LoaderImage));
    // A Splanc MAX image (board != 0 in the signed flags), validly signed by the
    // SHARED release key: the board, not the key, keeps it off a C6.
    for board in [1u32, 2, 3, 4, 0xff] {
        let mut max = m;
        max.flags = splanc_ota::keyring::flags(splanc_ota::keyring::KEY_RELEASE, 0) | (board << manifest::BOARD_SHIFT);
        assert_eq!(session::check_offer(&max, true, &target(0), false), Err(Refusal::WrongBoard), "board {board}");
        assert_eq!(Refusal::WrongBoard.code(), "wrong_board");
        // The C entry points the app and the loader call say so too.
        let enc = max.encode();
        let err = unsafe { splanc_ota::capi::ota_check_offer(enc.as_ptr(), enc.len(), true, SLOT, 0, false) };
        assert_eq!(unsafe { std::ffi::CStr::from_ptr(err) }.to_str(), Ok("wrong_board"));
    }
    let mut big = m;
    big.size = SLOT + 1;
    assert_eq!(session::check_offer(&big, true, &target(0), false), Err(Refusal::TooLarge));
    let mut empty = m;
    empty.size = 0;
    assert_eq!(session::check_offer(&empty, true, &target(0), false), Err(Refusal::BadManifest));
    // Downgrades need the explicit flag; an unknown installed version (0) takes anything.
    assert_eq!(session::check_offer(&m, true, &target(1_010_000), false), Err(Refusal::Downgrade));
    assert!(session::check_offer(&m, true, &target(1_010_000), true).is_ok());
    assert!(session::check_offer(&m, true, &target(1_009_000), false).is_ok(), "same version: reinstall");
}

// -- the receive session --------------------------------------------------------------

/// NOR flash: erase sets 0xFF, programming can only clear bits.
struct Nor {
    mem: Vec<u8>,
}

impl Nor {
    fn new(len: usize) -> Nor {
        // Start from stale content (an old app), not erased flash.
        Nor { mem: (0..len).map(|i| (i % 251) as u8).collect() }
    }
    fn erase(&mut self, off: u32, len: u32) {
        assert_eq!(off % SECTOR, 0);
        assert_eq!(len % SECTOR, 0);
        self.mem[off as usize..(off + len) as usize].fill(0xff);
    }
    fn program(&mut self, off: u32, data: &[u8]) {
        for (i, b) in data.iter().enumerate() {
            self.mem[off as usize + i] &= *b;
        }
    }
}

/// Drive a whole transfer; `cut` = Some(n) stops after n flash steps (a power cut
/// mid-erase or mid-write: the step is applied partially). Returns the persisted
/// resume record at the time of the cut (None if never persisted), and whether the
/// transfer completed.
fn transfer(
    flash: &mut Nor,
    img: &[u8],
    m: Manifest,
    resume: Option<Resume>,
    chunk: usize,
    mut cut: Option<usize>,
) -> (Option<Resume>, bool) {
    let mut s = Session::begin(m, true, &target(0), false, resume.as_ref()).unwrap();
    let mut persisted = Some(s.resume());
    let mut steps = 0usize;
    while !s.complete() {
        let off = s.offset();
        let end = core::cmp::min(off as usize + chunk, img.len());
        let p = s.plan(off, &img[off as usize..end], CHIP_ESP32C6).unwrap();
        if let Some((eo, el)) = p.erase {
            steps += 1;
            if cut == Some(steps) {
                // Cut mid-erase: only the first sector of the range got erased.
                flash.erase(eo, SECTOR);
                return (persisted, false);
            }
            flash.erase(eo, el);
        }
        steps += 1;
        if cut == Some(steps) {
            // Cut mid-write: half the chunk programmed.
            let half = (p.len / 2) as usize;
            flash.program(p.write_at, &img[off as usize..off as usize + half]);
            return (persisted, false);
        }
        flash.program(p.write_at, &img[off as usize..end]);
        if let Some(_) = s.commit(&p) {
            persisted = Some(s.resume());
        }
        if cut.is_some_and(|c| c <= steps) {
            cut = None;
        }
    }
    s.finish().unwrap();
    (persisted, true)
}

#[test]
fn a_clean_transfer_writes_the_image() {
    let img = app_image(CHIP_ESP32C6, 300_000);
    let m = manifest_for(&img, 7);
    let mut flash = Nor::new(SLOT as usize);
    let (_, done) = transfer(&mut flash, &img, m, None, MAX_CHUNK as usize, None);
    assert!(done);
    assert_eq!(sha256(&flash.mem[..img.len()]), m.sha256);
}

#[test]
fn odd_chunk_sizes_still_erase_every_sector_exactly_once_before_writing() {
    let img = app_image(CHIP_ESP32C6, 50_000);
    let m = manifest_for(&img, 7);
    for chunk in [1000usize, 3000, 4095, 4096] {
        let mut flash = Nor::new(SLOT as usize);
        let (_, done) = transfer(&mut flash, &img, m, None, chunk, None);
        assert!(done);
        assert_eq!(&flash.mem[..img.len()], &img[..], "chunk {chunk}");
    }
}

#[test]
fn every_power_cut_point_resumes_to_the_exact_image() {
    let img = app_image(CHIP_ESP32C6, 3 * PERSIST_EVERY as usize + 12_345);
    let m = manifest_for(&img, 9);
    // Cut after every flash step of the first attempt (erase or write), then
    // "reboot": begin again from whatever record was persisted, and finish.
    let total_steps = 2 * img.len().div_ceil(MAX_CHUNK as usize);
    for cut in 1..=total_steps {
        let mut flash = Nor::new(SLOT as usize);
        let (rec, done) = transfer(&mut flash, &img, m, None, MAX_CHUNK as usize, Some(cut));
        if done {
            continue;
        }
        // The record survives as encoded bytes (NVS) — round-trip it.
        let rec = rec.map(|r| Resume::decode(&r.encode()).unwrap());
        let (_, done) = transfer(&mut flash, &img, m, rec, MAX_CHUNK as usize, None);
        assert!(done);
        assert_eq!(&flash.mem[..img.len()], &img[..], "cut at step {cut}");
    }
}

#[test]
fn resume_restarts_at_the_persisted_sector_and_only_for_the_same_manifest() {
    let img = app_image(CHIP_ESP32C6, 200_000);
    let m = manifest_for(&img, 3);
    let r = Resume { manifest: m, offset: PERSIST_EVERY + 100 };
    let s = Session::begin(m, true, &target(0), false, Some(&r)).unwrap();
    assert_eq!(s.offset(), PERSIST_EVERY, "rounded down to the sector");
    // A different image (or version) starts over.
    let other = manifest_for(&app_image(CHIP_ESP32C6, 1000), 3);
    assert_eq!(Session::begin(other, true, &target(0), false, Some(&r)).unwrap().offset(), 0);
    // A record that says "everything arrived" goes straight to finish.
    let full = Resume { manifest: m, offset: m.size };
    let s = Session::begin(m, true, &target(0), false, Some(&full)).unwrap();
    assert!(s.complete() && s.finish().is_ok());
}

#[test]
fn resume_records_round_trip_and_reject_garbage() {
    let m = manifest_for(&app_image(CHIP_ESP32C6, 5000), 1);
    let r = Resume { manifest: m, offset: 4096 };
    let b = r.encode();
    assert_eq!(b.len(), session::RESUME_LEN);
    assert_eq!(Resume::decode(&b), Some(r));
    assert_eq!(Resume::decode(&b[..100]), None);
    let past_end = Resume { manifest: m, offset: m.size + 1 }.encode();
    assert_eq!(Resume::decode(&past_end), None);
}

#[test]
fn chunks_must_arrive_in_order_and_in_bounds() {
    let img = app_image(CHIP_ESP32C6, 10_000);
    let m = manifest_for(&img, 1);
    let mut s = Session::begin(m, true, &target(0), false, None).unwrap();
    assert_eq!(s.plan(4096, &img[4096..8192], CHIP_ESP32C6), Err(Refusal::OutOfOrder { want: 0 }));
    assert_eq!(s.plan(0, &[], CHIP_ESP32C6), Err(Refusal::BadChunk));
    assert_eq!(s.plan(0, &vec![0; MAX_CHUNK as usize + 1], CHIP_ESP32C6), Err(Refusal::BadChunk));
    assert_eq!(
        s.plan(0, &img[..4096], CHIP_ESP32C3),
        Err(Refusal::Image(ImageError::WrongChip { got: CHIP_ESP32C6 }))
    );
    let p = s.plan(0, &img[..4096], CHIP_ESP32C6).unwrap();
    assert_eq!(p.erase, Some((0, SECTOR)));
    s.commit(&p);
    let p = s.plan(4096, &img[4096..8192], CHIP_ESP32C6).unwrap();
    s.commit(&p);
    assert_eq!(s.plan(8192, &vec![0; 4096], CHIP_ESP32C6), Err(Refusal::Overflow), "past the manifest size");
    assert_eq!(s.finish(), Err(Refusal::Incomplete));
    let p = s.plan(8192, &img[8192..], CHIP_ESP32C6).unwrap();
    assert_eq!(s.commit(&p), Some(10_000), "the last byte always persists");
    assert!(s.finish().is_ok());
}

#[test]
fn progress_persists_every_64k_not_every_chunk() {
    let img = app_image(CHIP_ESP32C6, 4 * PERSIST_EVERY as usize);
    let m = manifest_for(&img, 1);
    let mut s = Session::begin(m, true, &target(0), false, None).unwrap();
    let mut persists = vec![];
    while !s.complete() {
        let off = s.offset() as usize;
        let p = s.plan(off as u32, &img[off..off + MAX_CHUNK as usize], CHIP_ESP32C6).unwrap();
        if let Some(o) = s.commit(&p) {
            persists.push(o);
        }
    }
    assert_eq!(persists, vec![PERSIST_EVERY, 2 * PERSIST_EVERY, 3 * PERSIST_EVERY, 4 * PERSIST_EVERY]);
}

#[test]
fn refusal_codes_are_the_documented_ones() {
    for (r, code) in [
        (Refusal::BadSignature, "bad_signature"),
        (Refusal::OutOfOrder { want: 3 }, "out_of_order"),
        (Refusal::Image(ImageError::WrongChip { got: 5 }), "wrong_chip"),
        (Refusal::Image(ImageError::BadMagic), "bad_image"),
        (Refusal::VerifyFailed, "verify_failed"),
        (Refusal::Downgrade, "downgrade"),
    ] {
        assert_eq!(r.code(), code);
    }
    assert_eq!(ENCODED_LEN, 108);
}

// -- the loader's boot decision -------------------------------------------------------

fn inputs(app: AppState) -> LoaderInputs {
    LoaderInputs { app, update_incomplete: false, handoff: Handoff::None, reset: Reset::Software, retry_spent: false }
}

#[test]
fn a_healthy_slot_boots_straight_through() {
    assert_eq!(boot::loader_decide(&inputs(AppState::Bootable)), LoaderAction::BootApp);
}

#[test]
fn half_written_slots_and_handoffs_stay_in_recovery() {
    let mut i = inputs(AppState::Bootable);
    i.update_incomplete = true;
    assert_eq!(boot::loader_decide(&i), LoaderAction::Recover(Reason::Incomplete));
    for (h, r) in [(Handoff::Update, Reason::Update), (Handoff::Stay, Reason::Requested), (Handoff::CrashLoop, Reason::CrashLoop)] {
        let mut i = inputs(AppState::Bootable);
        i.handoff = h;
        assert_eq!(boot::loader_decide(&i), LoaderAction::Recover(r));
    }
    // An incomplete transfer outranks any handoff: the slot is not bootable.
    let mut i = inputs(AppState::Missing);
    i.update_incomplete = true;
    i.handoff = Handoff::Update;
    assert_eq!(boot::loader_decide(&i), LoaderAction::Recover(Reason::Incomplete));
}

#[test]
fn rolled_back_apps_stay_down_unless_the_power_did_it() {
    assert_eq!(boot::loader_decide(&inputs(AppState::Missing)), LoaderAction::Recover(Reason::NoApp));
    assert_eq!(boot::loader_decide(&inputs(AppState::Invalid)), LoaderAction::Recover(Reason::RolledBack));
    for reset in [Reset::Panic, Reset::Watchdog, Reset::Software, Reset::Other] {
        let mut i = inputs(AppState::Aborted);
        i.reset = reset;
        assert_eq!(boot::loader_decide(&i), LoaderAction::Recover(Reason::RolledBack), "{reset:?}");
    }
    for reset in [Reset::PowerOn, Reset::Brownout] {
        let mut i = inputs(AppState::Aborted);
        i.reset = reset;
        assert_eq!(boot::loader_decide(&i), LoaderAction::RetryApp, "{reset:?}: one retry");
        i.retry_spent = true;
        assert_eq!(boot::loader_decide(&i), LoaderAction::Recover(Reason::RolledBack), "{reset:?}: only one");
    }
}

#[test]
fn only_an_unanswered_handoff_times_out_back_to_the_app() {
    assert_eq!(Reason::Update.idle_timeout_ms(), Some(300_000));
    for r in [Reason::Requested, Reason::Incomplete, Reason::NoApp, Reason::RolledBack, Reason::CrashLoop] {
        assert_eq!(r.idle_timeout_ms(), None, "{r:?}");
    }
    for h in [Handoff::None, Handoff::Update, Handoff::Stay, Handoff::CrashLoop] {
        assert_eq!(Handoff::from_u8(h.to_u8()), h);
    }
    assert_eq!(Handoff::from_u8(200), Handoff::None);
}

// -- the app: crash-loop guard and health ----------------------------------------------

#[test]
fn crash_loop_counts_consecutive_crash_resets() {
    let mut n = boot::crash_count(0, false, Reset::PowerOn);
    assert_eq!(n, 0);
    for expect in 1..=3 {
        n = boot::crash_count(n, true, Reset::Panic);
        assert_eq!(n, expect);
    }
    assert!(boot::crash_loop(n));
    // A clean restart or a power cycle breaks the run; garbage RTC memory is no run.
    assert_eq!(boot::crash_count(2, true, Reset::Software), 0);
    assert_eq!(boot::crash_count(2, true, Reset::PowerOn), 0);
    assert_eq!(boot::crash_count(2, false, Reset::Watchdog), 0);
    assert!(!boot::crash_loop(2));
}

fn healthy(uptime_ms: u32) -> Health {
    Health { uptime_ms, render_alive: true, tls_ready: true, network_required: true, leased: true }
}

#[test]
fn health_waits_then_passes_or_fails_by_the_deadline() {
    assert_eq!(boot::health(&healthy(5_000)), Verdict::Wait, "too early");
    assert_eq!(boot::health(&healthy(boot::HEALTHY_AFTER_MS)), Verdict::Healthy);
    let mut h = healthy(60_000);
    h.render_alive = false;
    assert_eq!(boot::health(&h), Verdict::Wait);
    h.uptime_ms = boot::HEALTH_DEADLINE_MS;
    assert_eq!(boot::health(&h), Verdict::Failed("render"));
    let mut h = healthy(boot::HEALTH_DEADLINE_MS);
    h.leased = false;
    assert_eq!(boot::health(&h), Verdict::Failed("network"));
    let mut h = healthy(boot::HEALTH_DEADLINE_MS);
    h.tls_ready = false;
    assert_eq!(boot::health(&h), Verdict::Failed("tls"));
    assert!(boot::WATCHDOG_MS > boot::HEALTH_DEADLINE_MS, "the watchdog backs up the soft deadline");
}

#[test]
fn the_network_only_counts_when_the_loader_had_it() {
    // The AP went down during the update: a good image must not roll back for it.
    let h = Health { uptime_ms: 30_000, render_alive: true, tls_ready: true, network_required: false, leased: false };
    assert_eq!(boot::health(&h), Verdict::Healthy);
}

// -- keyring: key ids, epochs, the security floor ----------------------------------------

mod keyring_tests {
    use splanc_ota::keyring::{self, EpochRecord, KeyRefusal, KeyState, KEY_BACKUP, KEY_NEXT, KEY_RELEASE};
    use splanc_ota::manifest::Manifest;

    fn manifest(key_id: u8, secv: u8) -> Manifest {
        Manifest::unsigned(1, 100, [0; 32], keyring::flags(key_id, secv))
    }

    /// The ring a release loader ships: release + backup (next UNSET).
    fn ring(id: u8) -> bool {
        id == KEY_RELEASE || id == KEY_BACKUP
    }

    #[test]
    fn the_key_id_and_security_version_ride_in_the_signed_flags() {
        let m = manifest(KEY_BACKUP, 7);
        assert_eq!((keyring::key_id(&m), keyring::security_version(&m)), (1, 7));
        assert_eq!(m.flags & 1, 0, "the swarm's loader flag stays clear");
        assert_eq!(keyring::flags(0, 0), 0, "release key, security 0 = the swarm's flags 0");
    }

    #[test]
    fn manifests_must_name_a_trusted_unrevoked_key() {
        let st = KeyState::default();
        assert_eq!(keyring::select_key(&manifest(KEY_RELEASE, 0), ring, &st), Ok(0));
        assert_eq!(keyring::select_key(&manifest(KEY_BACKUP, 0), ring, &st), Ok(1));
        assert_eq!(keyring::select_key(&manifest(KEY_NEXT, 0), ring, &st), Err(KeyRefusal::UnknownKey));
        assert_eq!(keyring::select_key(&manifest(200, 0), ring, &st), Err(KeyRefusal::UnknownKey));
        // Backup-signed images only where the backup key is in the ring.
        assert_eq!(keyring::select_key(&manifest(KEY_BACKUP, 0), |id| id == 0, &st), Err(KeyRefusal::UnknownKey));
        let revoked = KeyState { revoked: 1 << KEY_RELEASE, ..st };
        assert_eq!(keyring::select_key(&manifest(KEY_RELEASE, 0), ring, &revoked), Err(KeyRefusal::RevokedKey));
        assert_eq!(keyring::select_key(&manifest(KEY_BACKUP, 0), ring, &revoked), Ok(1));
    }

    #[test]
    fn the_security_floor_only_rises_and_blocks_replays() {
        let st = KeyState::default();
        let after = keyring::raise_floor(&st, &manifest(0, 4));
        assert_eq!(after.security_floor, 4);
        assert_eq!(keyring::raise_floor(&after, &manifest(0, 2)).security_floor, 4, "never lowered");
        assert_eq!(keyring::select_key(&manifest(0, 3), ring, &after), Err(KeyRefusal::SecurityFloor));
        assert_eq!(keyring::select_key(&manifest(0, 4), ring, &after), Ok(0));
    }

    fn rec(epoch: u32, revoked: u32, signer: u8) -> EpochRecord {
        EpochRecord { epoch, revoked, signer, signature: [3; 64] }
    }

    #[test]
    fn epochs_revoke_monotonically() {
        let st = KeyState { security_floor: 2, ..KeyState::default() };
        // Compromised release key: the backup signs epoch 1 revoking it.
        let s1 = keyring::apply_epoch(&st, &rec(1, 1 << KEY_RELEASE, KEY_BACKUP), true, ring).unwrap();
        assert_eq!((s1.epoch, s1.revoked, s1.security_floor), (1, 1, 2));
        // Never decreases; replaying the same record is stale.
        assert_eq!(keyring::apply_epoch(&s1, &rec(1, 1, KEY_BACKUP), true, ring), Err(KeyRefusal::StaleEpoch));
        assert_eq!(keyring::apply_epoch(&s1, &rec(0, 0, KEY_BACKUP), true, ring), Err(KeyRefusal::StaleEpoch));
        // Can't un-revoke, can't be signed by a revoked key, can't revoke its signer.
        assert_eq!(keyring::apply_epoch(&s1, &rec(2, 0, KEY_BACKUP), true, ring), Err(KeyRefusal::BadRevocation));
        assert_eq!(keyring::apply_epoch(&s1, &rec(2, 1, KEY_RELEASE), true, ring), Err(KeyRefusal::RevokedKey));
        assert_eq!(keyring::apply_epoch(&st, &rec(1, 1 << KEY_BACKUP, KEY_BACKUP), true, ring), Err(KeyRefusal::BadRevocation));
        // Unknown signer, bad signature.
        assert_eq!(keyring::apply_epoch(&st, &rec(1, 0, KEY_NEXT), true, ring), Err(KeyRefusal::UnknownKey));
        assert_eq!(keyring::apply_epoch(&st, &rec(1, 0, KEY_BACKUP), false, ring), Err(KeyRefusal::BadSignature));
        // Records round-trip, and reject garbage.
        let r = rec(9, 5, 1);
        assert_eq!(EpochRecord::decode(&r.encode()), Some(r));
        assert_eq!(EpochRecord::decode(&r.encode()[..79]), None);
        let mut b = r.encode();
        b[0] ^= 1;
        assert_eq!(EpochRecord::decode(&b), None, "magic");
    }
}
