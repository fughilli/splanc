use super::*;
use keyring::HmacKey;

fn hex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

fn hmac(key: &[u8], data: &[u8]) -> [u8; 32] {
    HmacKey::new(key, SoftSha256::new).mac(&[data])
}

// --- RFC 4231 HMAC-SHA256 known answers, then the 32-bit truncation ----------

#[test]
fn rfc4231_hmac_sha256() {
    let cases: &[(Vec<u8>, Vec<u8>, &str)] = &[
        (
            vec![0x0b; 20],
            b"Hi There".to_vec(),
            "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
        ),
        (
            b"Jefe".to_vec(),
            b"what do ya want for nothing?".to_vec(),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
        ),
        (
            vec![0xaa; 20],
            vec![0xdd; 50],
            "773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe",
        ),
        (
            (1u8..=25).collect(),
            vec![0xcd; 50],
            "82558a389a443c0ea4cc819899f2083a85f0faa3e578f8077a2e3ff46729665b",
        ),
        (
            vec![0xaa; 131],
            b"Test Using Larger Than Block-Size Key - Hash Key First".to_vec(),
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54",
        ),
        (
            vec![0xaa; 131],
            b"This is a test using a larger than block-size key and a larger than block-size data. The key needs to be hashed before being used by the HMAC algorithm.".to_vec(),
            "9b09ffa71b942fcb27635fbcd5b0e944bfdc63644f0713938a7f51535c3a35e2",
        ),
    ];
    for (i, (k, d, want)) in cases.iter().enumerate() {
        let got = hmac(k, d);
        assert_eq!(got.to_vec(), hex(want), "RFC 4231 case {}", i + 1);
        // The tag is the first 4 bytes of the same MAC.
        assert_eq!(got[..TAG_LEN], hex(want)[..TAG_LEN]);
    }
    // Test case 5: truncation (128-bit output) is a prefix of the full MAC.
    let got = hmac(&[0x0c; 20], b"Test With Truncation");
    assert_eq!(got[..16].to_vec(), hex("a3b6167473100ee06e0c796c2955552b"));
}

// --- the .fxn format ----------------------------------------------------------

const CODE: [u32; 3] = [0x0000_0013, 0x0000_8067, 0xdead_beef];
const OP: [u8; 3] = [1, 2, 3];
const FXB: &[u8] = b"FXB-test-bytes";
const ABIS: &[u16] = &[1];
const FW: u32 = 1_006_000; // 1.6.0

fn header() -> Header {
    Header {
        key_id: DEV_KEY_ID,
        key_epoch: 7,
        abi: 1,
        flags: 0,
        min_fw: FW,
        scope: SCOPE_FLEET,
        code_words: 0,
        op_code_len: 0,
        update_off: NO_ENTRY,
        shade_off: 1,
        prep_off: NO_ENTRY,
        tag: [0; TAG_LEN],
    }
}

fn signed_with(key: &[u8], h: Header) -> Vec<u8> {
    let mut out = vec![0u8; 256];
    let n = build_into(&mut out, key, h, &CODE, &OP, FXB).unwrap();
    out.truncate(n);
    out
}

fn signed() -> Vec<u8> {
    signed_with(&DEV_KEY, header())
}

fn dev() -> Device<'static> {
    Device {
        fw_version: FW,
        abis: ABIS,
        device_id: [0xA, 0xB, 0xC, 0xD, 0xE, 0xF, 0, 0],
    }
}

fn ring() -> KeyRing<SoftSha256> {
    KeyRing::with_dev_key(SoftSha256::new)
}

fn check(blob: &[u8], fxb: &[u8]) -> Result<(), Reject> {
    check_with(blob, fxb, &ring(), &Policy::default(), &dev())
}

fn check_with(
    blob: &[u8],
    fxb: &[u8],
    ring: &KeyRing<SoftSha256>,
    policy: &Policy,
    dev: &Device,
) -> Result<(), Reject> {
    let fxn = Fxn::parse(blob)?;
    let mut lim = Limiter::default();
    verify(&fxn, fxb, ring, policy, dev, &mut lim, 0, SoftSha256::new)
}

/// Known answer computed independently (Python `hmac`/`hashlib`) for the
/// canonical message: DOMAIN || header[0..36] || SHA-256(code || op || fxb).
#[test]
fn format_known_answer() {
    let b = signed();
    assert_eq!(b.len(), HEADER_LEN + 12 + 3);
    assert_eq!(&b[36..40], &hex("ffb1f683")[..]);
    let h = Header::decode(&b).unwrap();
    assert_eq!(h.code_words, 3);
    assert_eq!(h.op_code_len, 3);
    assert_eq!(h.encode().to_vec(), b[..HEADER_LEN].to_vec());
}

#[test]
fn good_signature_verifies() {
    assert_eq!(check(&signed(), FXB), Ok(()));
}

#[test]
fn every_byte_flip_rejects() {
    let good = signed();
    for i in 0..good.len() {
        for bit in [0x01u8, 0x80] {
            let mut b = good.clone();
            b[i] ^= bit;
            let r = check(&b, FXB);
            assert!(r.is_err(), "flip byte {i} bit {bit:#x} accepted");
        }
    }
    // ... and of the .fxb the blob was lowered from.
    for i in 0..FXB.len() {
        let mut f = FXB.to_vec();
        f[i] ^= 1;
        assert_eq!(check(&good, &f), Err(Reject::BadTag), "fxb byte {i}");
    }
    let mut longer = FXB.to_vec();
    longer.push(0);
    assert_eq!(check(&good, &longer), Err(Reject::BadTag));
}

#[test]
fn signed_fields_relabelled_reject() {
    // A second supported ABI / a lower min_fw / another epoch the device would
    // accept: relabelling any of them without re-signing must fail the tag.
    let abis: &[u16] = &[1, 2];
    let d = Device { abis, ..dev() };
    let good = signed();
    let relabel = |f: &dyn Fn(&mut Header)| {
        let mut h = Header::decode(&good).unwrap();
        f(&mut h);
        let mut b = good.clone();
        b[..HEADER_LEN].copy_from_slice(&h.encode());
        check_with(&b, FXB, &ring(), &Policy::default(), &d)
    };
    assert_eq!(relabel(&|h| h.abi = 2), Err(Reject::BadTag));
    assert_eq!(relabel(&|h| h.min_fw = 0), Err(Reject::BadTag));
    assert_eq!(relabel(&|h| h.key_epoch = 8), Err(Reject::BadTag));
    assert_eq!(relabel(&|h| h.scope = d.device_id), Err(Reject::BadTag));
    assert_eq!(relabel(&|h| h.shade_off = 0), Err(Reject::BadTag));
    // Unsupported values are refused before the tag (no limiter cost).
    assert_eq!(relabel(&|h| h.abi = 9), Err(Reject::AbiUnsupported));
    assert_eq!(relabel(&|h| h.min_fw = FW + 1), Err(Reject::FirmwareTooOld));
}

#[test]
fn abi_and_firmware_gates() {
    let mut h = header();
    h.abi = 2;
    assert_eq!(
        check(&signed_with(&DEV_KEY, h), FXB),
        Err(Reject::AbiUnsupported)
    );
    let mut h = header();
    h.min_fw = fw_version(1, 6, 1).unwrap();
    assert_eq!(
        check(&signed_with(&DEV_KEY, h), FXB),
        Err(Reject::FirmwareTooOld)
    );
    // Newer firmware still runs an older blob (no build binding).
    let newer = Device {
        fw_version: fw_version(2, 0, 0).unwrap(),
        ..dev()
    };
    assert_eq!(
        check_with(&signed(), FXB, &ring(), &Policy::default(), &newer),
        Ok(())
    );
    // An untagged dev build (version 0) runs only min_fw = 0 blobs.
    let devbuild = Device {
        fw_version: 0,
        ..dev()
    };
    assert_eq!(
        check_with(&signed(), FXB, &ring(), &Policy::default(), &devbuild),
        Err(Reject::FirmwareTooOld)
    );
    let mut h = header();
    h.min_fw = 0;
    assert_eq!(
        check_with(
            &signed_with(&DEV_KEY, h),
            FXB,
            &ring(),
            &Policy::default(),
            &devbuild
        ),
        Ok(())
    );
    assert_eq!(parse_fw_version("v1.6.0"), Some(1_006_000));
}

#[test]
fn wrong_key_rejects() {
    let user = [0x42u8; 32];
    assert_eq!(
        check(&signed_with(&user, header()), FXB),
        Err(Reject::BadTag)
    );
    // Signed with a key id the device doesn't have.
    let mut h = header();
    h.key_id = 5;
    assert_eq!(check(&signed_with(&user, h), FXB), Err(Reject::UnknownKey));
    // Once provisioned under that id, it verifies; the dev key still does too.
    let mut r = ring();
    assert!(r.install(5, &user, SoftSha256::new));
    assert_eq!(
        check_with(&signed_with(&user, h), FXB, &r, &Policy::default(), &dev()),
        Ok(())
    );
    assert_eq!(
        check_with(&signed(), FXB, &r, &Policy::default(), &dev()),
        Ok(())
    );
    // A dev-key tag relabelled to the user key id fails.
    let mut b = signed();
    b[5] = 5;
    assert_eq!(
        check_with(&b, FXB, &r, &Policy::default(), &dev()),
        Err(Reject::BadTag)
    );
}

#[test]
fn revocation_and_epoch() {
    let mut p = Policy::default();
    assert!(p.revoke(DEV_KEY_ID));
    assert_eq!(
        check_with(&signed(), FXB, &ring(), &p, &dev()),
        Err(Reject::RevokedKey)
    );
    let mut p = Policy::default();
    assert!(p.raise_min_epoch(8));
    assert!(!p.raise_min_epoch(3), "never lowered");
    assert_eq!(p.min_epoch, 8);
    assert_eq!(
        check_with(&signed(), FXB, &ring(), &p, &dev()),
        Err(Reject::OldEpoch)
    );
    let mut h = header();
    h.key_epoch = 8;
    assert_eq!(
        check_with(&signed_with(&DEV_KEY, h), FXB, &ring(), &p, &dev()),
        Ok(())
    );
}

#[test]
fn scope() {
    let d = dev();
    let mut h = header();
    h.scope = d.device_id;
    assert_eq!(check(&signed_with(&DEV_KEY, h), FXB), Ok(()));
    h.scope = [1, 2, 3, 4, 5, 6, 0, 0];
    assert_eq!(
        check(&signed_with(&DEV_KEY, h), FXB),
        Err(Reject::WrongScope)
    );
}

#[test]
fn malformed_containers() {
    let good = signed();
    assert_eq!(
        Fxn::parse(&good[..good.len() - 1]).err(),
        Some(Reject::Malformed)
    );
    let mut extra = good.clone();
    extra.push(0);
    assert_eq!(Fxn::parse(&extra).err(), Some(Reject::Malformed));
    assert_eq!(Fxn::parse(&good[..10]).err(), Some(Reject::Malformed));
    let mut h = header();
    h.shade_off = 3; // past the 3 code words
    let mut b = signed_with(&DEV_KEY, h);
    assert_eq!(Fxn::parse(&b).err(), Some(Reject::Malformed));
    b = good.clone();
    b[34] = 1; // reserved
    assert_eq!(Fxn::parse(&b).err(), Some(Reject::Malformed));
    let f = Fxn::parse(&good).unwrap();
    assert_eq!(f.word(2), 0xdead_beef);
    assert_eq!(f.op_code, &OP);
}

#[test]
fn ct_eq_basic() {
    assert!(ct_eq(&[1, 2, 3, 4], &[1, 2, 3, 4]));
    for i in 0..4 {
        let mut b = [1, 2, 3, 4];
        b[i] ^= 0x80;
        assert!(!ct_eq(&[1, 2, 3, 4], &b));
    }
}

// --- rate limiting ------------------------------------------------------------

#[test]
fn backoff_schedule() {
    assert_eq!(limiter::backoff_ms(0), 0);
    assert_eq!(limiter::backoff_ms(limiter::FREE_FAILS - 1), 0);
    assert_eq!(limiter::backoff_ms(limiter::FREE_FAILS), limiter::BASE_MS);
    assert_eq!(
        limiter::backoff_ms(limiter::FREE_FAILS + 1),
        2 * limiter::BASE_MS
    );
    assert_eq!(
        limiter::backoff_ms(limiter::FREE_FAILS + 7),
        limiter::MAX_MS
    );
    assert_eq!(limiter::backoff_ms(u32::MAX), limiter::MAX_MS);
}

#[test]
fn bad_tags_back_off_and_recover() {
    let mut bad = signed();
    bad[HEADER_LEN] ^= 1; // tamper a code byte
    let good = signed();
    let r = ring();
    let p = Policy::default();
    let d = dev();
    let mut lim = Limiter::default();
    let mut now = 1_000u64;
    let run = |blob: &[u8], lim: &mut Limiter, now: u64| {
        verify(
            &Fxn::parse(blob).unwrap(),
            FXB,
            &r,
            &p,
            &d,
            lim,
            now,
            SoftSha256::new,
        )
    };
    // FREE_FAILS bad tags back to back, no waiting.
    for _ in 0..limiter::FREE_FAILS {
        assert_eq!(run(&bad, &mut lim, now), Err(Reject::BadTag));
    }
    assert!(lim.take_dirty());
    assert_eq!(lim.persisted(), limiter::FREE_FAILS);
    // Now even a good blob must wait: the limiter runs before the MAC, so the
    // backoff can't be probed for tag information either.
    assert_eq!(
        run(&good, &mut lim, now),
        Err(Reject::RateLimited {
            retry_ms: limiter::BASE_MS as u32
        })
    );
    now += limiter::BASE_MS;
    assert_eq!(run(&bad, &mut lim, now), Err(Reject::BadTag));
    // The window doubled.
    assert!(matches!(
        run(&good, &mut lim, now + limiter::BASE_MS),
        Err(Reject::RateLimited { .. })
    ));
    now += 2 * limiter::BASE_MS;
    // A good tag clears the streak (one persisted write).
    assert_eq!(run(&good, &mut lim, now), Ok(()));
    assert!(lim.take_dirty());
    assert_eq!(lim.persisted(), 0);
    assert_eq!(run(&bad, &mut lim, now), Err(Reject::BadTag));
    assert_eq!(lim.boot_fails, limiter::FREE_FAILS + 2);
    // Structural refusals never touch the limiter.
    let mut lim2 = Limiter::default();
    let mut h = header();
    h.abi = 9;
    for _ in 0..50 {
        let b = signed_with(&DEV_KEY, h);
        assert_eq!(run(&b, &mut lim2, 0), Err(Reject::AbiUnsupported));
    }
    assert!(!lim2.take_dirty());
}

#[test]
fn backoff_survives_reboot() {
    let mut lim = Limiter::default();
    for i in 0..limiter::FREE_FAILS + 4 {
        lim.fail(i as u64);
    }
    let saved = lim.persisted();
    // Reboot: restored at boot clock 0, the backoff is re-armed in full.
    let lim = Limiter::restore(saved, 0);
    let want = limiter::backoff_ms(saved);
    assert_eq!(
        lim.check(0),
        Err(Reject::RateLimited {
            retry_ms: want as u32
        })
    );
    assert_eq!(lim.check(want), Ok(()));
    assert_eq!(Limiter::restore(0, 0).check(0), Ok(()));
}

#[test]
fn keyring_capacity_and_replace() {
    let mut r = ring();
    assert!(r.install(1, &[1; 32], SoftSha256::new));
    assert!(r.install(2, &[2; 32], SoftSha256::new));
    assert!(r.install(3, &[3; 32], SoftSha256::new));
    assert!(!r.install(4, &[4; 32], SoftSha256::new), "full");
    assert!(r.install(1, &[9; 32], SoftSha256::new), "replace in place");
    r.remove(2);
    assert!(r.install(4, &[4; 32], SoftSha256::new));
    let mut ids: Vec<u8> = r.ids().collect();
    ids.sort();
    assert_eq!(ids, vec![0, 1, 3, 4]);
    assert_eq!(r.get(1).unwrap().mac(&[b"x"]), hmac(&[9; 32], b"x"));
}
