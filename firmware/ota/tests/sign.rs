//! Real ECDSA P-256 signatures end to end through the signer (:ota_sign): sign with
//! the checked-in TEST key, verify with its public key, and refuse a tampered
//! manifest, a tampered image and the wrong key. Also pins the loader's boot-time
//! known answer (firmware/loader/ota_kat.h) to what the signer produces.

use std::path::PathBuf;
use std::process::Command;

use splanc_ota::manifest::{Manifest, ENCODED_LEN};
use splanc_ota::sha256::sha256;

fn runfile(var: &str) -> PathBuf {
    let rel = std::env::var(var).unwrap_or_else(|_| panic!("{var} unset"));
    let base = std::env::var("RUNFILES_DIR")
        .or_else(|_| std::env::var("TEST_SRCDIR"))
        .map(PathBuf::from)
        .unwrap_or_default();
    for cand in [base.join("_main").join(&rel), PathBuf::from(&rel)] {
        if cand.exists() {
            return cand;
        }
    }
    panic!("runfile {rel} not found");
}

fn tmp(name: &str) -> PathBuf {
    PathBuf::from(std::env::var("TEST_TMPDIR").unwrap_or_else(|_| "/tmp".into())).join(name)
}

fn sign(args: &[&str]) -> std::process::Output {
    Command::new(runfile("OTA_SIGN")).args(args).output().expect("ota_sign runs")
}

fn pubkey_hex() -> String {
    std::fs::read_to_string(runfile("OTA_TEST_PUB"))
        .unwrap()
        .lines()
        .filter(|l| !l.starts_with('#'))
        .collect::<String>()
        .trim()
        .to_string()
}

fn signed(image: &[u8], version: &str, name: &str) -> (PathBuf, PathBuf) {
    let img = tmp(&format!("{name}.bin"));
    let man = tmp(&format!("{name}.manifest"));
    std::fs::write(&img, image).unwrap();
    let key = runfile("OTA_TEST_KEY");
    let out = sign(&[
        "sign",
        "--key-file",
        key.to_str().unwrap(),
        "--version",
        version,
        "--in",
        img.to_str().unwrap(),
        "--out",
        man.to_str().unwrap(),
    ]);
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    (img, man)
}

fn verify(img: &PathBuf, man: &PathBuf, pubkey: &str) -> bool {
    sign(&["verify", "--pubkey", pubkey, "--manifest", man.to_str().unwrap(), "--in", img.to_str().unwrap()])
        .status
        .success()
}

#[test]
fn signs_verifies_and_refuses_tampering() {
    let image: Vec<u8> = (0..70_000u32).map(|i| (i * 31 % 251) as u8).collect();
    let (img, man) = signed(&image, "1.9.0", "a");
    let m = Manifest::decode(&std::fs::read(&man).unwrap()).unwrap();
    assert_eq!(m.version, 1_009_000);
    assert_eq!(m.size as usize, image.len());
    assert_eq!(m.sha256, sha256(&image));
    assert_eq!(m.flags, 0);
    let pk = pubkey_hex();
    assert!(verify(&img, &man, &pk));

    // RFC 6979: deterministic, so re-signing reproduces the manifest byte for byte.
    let (_, man2) = signed(&image, "1009000", "a2");
    assert_eq!(std::fs::read(&man).unwrap(), std::fs::read(&man2).unwrap());

    // A flipped signature bit.
    let bad = tmp("bad.manifest");
    assert!(sign(&["corrupt", "--in", man.to_str().unwrap(), "--out", bad.to_str().unwrap()]).status.success());
    assert!(!verify(&img, &bad, &pk));

    // A signed-part change (the version) without re-signing.
    let mut raw = std::fs::read(&man).unwrap();
    raw[0] ^= 1;
    let bumped = tmp("bumped.manifest");
    std::fs::write(&bumped, &raw).unwrap();
    assert!(!verify(&img, &bumped, &pk));

    // The image changed after signing.
    let mut other = image.clone();
    other[12345] ^= 0x80;
    let other_img = tmp("other.bin");
    std::fs::write(&other_img, &other).unwrap();
    assert!(!verify(&other_img, &man, &pk));

    // Someone else's key.
    let wrong_key = tmp("wrong.key");
    std::fs::write(&wrong_key, "11".repeat(32)).unwrap();
    let out = sign(&["pubkey", "--key-file", wrong_key.to_str().unwrap()]);
    let wrong_pub = String::from_utf8(out.stdout).unwrap().trim().to_string();
    assert_ne!(wrong_pub, pk);
    assert!(!verify(&img, &man, &wrong_pub));
}

#[test]
fn the_signer_reads_the_key_from_the_environment() {
    let key: String = std::fs::read_to_string(runfile("OTA_TEST_KEY"))
        .unwrap()
        .lines()
        .filter(|l| !l.starts_with('#'))
        .collect();
    let out = Command::new(runfile("OTA_SIGN"))
        .args(["pubkey"])
        .env("OTA_SIGNING_KEY", key.trim())
        .output()
        .unwrap();
    assert!(out.status.success());
    assert_eq!(String::from_utf8(out.stdout).unwrap().trim(), pubkey_hex());
    let out = Command::new(runfile("OTA_SIGN")).args(["pubkey"]).env_remove("OTA_SIGNING_KEY").output().unwrap();
    assert!(!out.status.success(), "no key, no signature");
}

fn c_array(header: &str, name: &str) -> Vec<u8> {
    let start = header.find(&format!("{name}[")).unwrap_or_else(|| panic!("{name} in header"));
    let body = &header[start..];
    let open = body.find('{').unwrap();
    let close = body.find('}').unwrap();
    body[open + 1..close]
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| u8::from_str_radix(s.trim_start_matches("0x"), 16).unwrap())
        .collect()
}

#[test]
fn the_loaders_known_answer_is_current() {
    let (_, man) = signed(b"splanc-ota-kat", "1", "kat");
    let m = std::fs::read(&man).unwrap();
    assert_eq!(m.len(), ENCODED_LEN);
    let header = std::fs::read_to_string(runfile("OTA_KAT_H")).unwrap();
    assert_eq!(c_array(&header, "kSigned"), m[..44].to_vec(), "regenerate firmware/loader/ota_kat.h");
    assert_eq!(c_array(&header, "kSignature"), m[44..].to_vec(), "regenerate firmware/loader/ota_kat.h");
    let pk: Vec<u8> = (0..65).map(|i| u8::from_str_radix(&pubkey_hex()[2 * i..2 * i + 2], 16).unwrap()).collect();
    assert_eq!(c_array(&header, "kPublic"), pk);
}

fn ring() -> String {
    format!(
        "0={},1={}",
        runfile("OTA_TEST_PUB").display(),
        runfile("OTA_TEST_BACKUP_PUB").display()
    )
}

fn sign_with(key_var: &str, image: &[u8], name: &str, extra: &[&str]) -> (PathBuf, PathBuf) {
    let img = tmp(&format!("{name}.bin"));
    let man = tmp(&format!("{name}.manifest"));
    std::fs::write(&img, image).unwrap();
    let key = runfile(key_var);
    let mut args = vec!["sign", "--key-file", key.to_str().unwrap(), "--version", "7", "--in", img.to_str().unwrap(), "--out", man.to_str().unwrap()];
    args.extend_from_slice(extra);
    let out = sign(&args);
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    (img, man)
}

fn verify_ring(img: &PathBuf, man: &PathBuf) -> bool {
    sign(&["verify", "--ring", &ring(), "--manifest", man.to_str().unwrap(), "--in", img.to_str().unwrap()]).status.success()
}

#[test]
fn key_ids_select_the_verifying_key() {
    let image = vec![9u8; 5000];
    // Backup-signed with key id 1: verifies against the ring that has the backup key.
    let (img, man) = sign_with("OTA_TEST_BACKUP_KEY", &image, "bk", &["--key-id", "1", "--security-version", "3"]);
    let m = Manifest::decode(&std::fs::read(&man).unwrap()).unwrap();
    assert_eq!(splanc_ota::keyring::key_id(&m), 1);
    assert_eq!(splanc_ota::keyring::security_version(&m), 3);
    assert!(verify_ring(&img, &man));
    // The backup key's signature under key id 0 (release) is refused...
    let (img, man) = sign_with("OTA_TEST_BACKUP_KEY", &image, "bk0", &["--key-id", "0"]);
    assert!(!verify_ring(&img, &man));
    // ...and so is the release key claiming to be the backup.
    let (img, man) = sign_with("OTA_TEST_KEY", &image, "rel1", &["--key-id", "1"]);
    assert!(!verify_ring(&img, &man));
    // A key id the ring doesn't have.
    let (img, man) = sign_with("OTA_TEST_KEY", &image, "rel5", &["--key-id", "5"]);
    assert!(!verify_ring(&img, &man));
}

#[test]
fn epoch_records_sign_and_verify() {
    let rec = tmp("e.bin");
    let key = runfile("OTA_TEST_BACKUP_KEY");
    let out = sign(&["epoch", "--key-file", key.to_str().unwrap(), "--key-id", "1", "--epoch", "2", "--revoke", "0", "--out", rec.to_str().unwrap()]);
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let r = splanc_ota::keyring::EpochRecord::decode(&std::fs::read(&rec).unwrap()).unwrap();
    assert_eq!((r.epoch, r.revoked, r.signer), (2, 1, 1));
    assert!(sign(&["verify-epoch", "--ring", &ring(), "--in", rec.to_str().unwrap()]).status.success());
    // Claiming another signer breaks the signature.
    let mut b = std::fs::read(&rec).unwrap();
    b[12] = 0;
    let forged = tmp("e2.bin");
    std::fs::write(&forged, b).unwrap();
    assert!(!sign(&["verify-epoch", "--ring", &ring(), "--in", forged.to_str().unwrap()]).status.success());
    // A key can't sign its own revocation.
    let own = sign(&["epoch", "--key-file", key.to_str().unwrap(), "--key-id", "1", "--epoch", "3", "--revoke", "1", "--out", rec.to_str().unwrap()]);
    assert!(!own.status.success());
}

#[test]
fn committed_public_keys_are_valid_and_in_the_pubkey_format() {
    // `pubkey` of a private key prints exactly what a keys/*.pub file holds.
    for (key, pubf) in [("OTA_TEST_KEY", "OTA_TEST_PUB"), ("OTA_TEST_BACKUP_KEY", "OTA_TEST_BACKUP_PUB")] {
        let k = runfile(key);
        let out = sign(&["pubkey", "--key-file", k.to_str().unwrap()]);
        let printed = String::from_utf8(out.stdout).unwrap().trim().to_string();
        let file: String = std::fs::read_to_string(runfile(pubf)).unwrap().lines().filter(|l| !l.starts_with('#')).collect();
        assert_eq!(printed, file.trim(), "{pubf}");
    }
    // The release key (the OTA_SIGNING_KEY secret's public half) is a real P-256 point.
    let rel = runfile("OTA_RELEASE_PUB");
    let out = sign(&["check-pub", "--in", rel.to_str().unwrap()]);
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let file: String = std::fs::read_to_string(&rel).unwrap().lines().filter(|l| !l.starts_with('#')).collect();
    assert_eq!(String::from_utf8(out.stdout).unwrap().trim(), file.trim());
}

// --- keygen labels, --name and --pub-out ---------------------------------------------

/// keygen's (private, public) hex from its "private (...): X" / "public  (...): Y" lines.
fn keygen_halves(stdout: &str) -> (String, String) {
    let field = |prefix: &str| {
        let line = stdout.lines().find(|l| l.starts_with(prefix)).unwrap_or_else(|| panic!("no {prefix} line"));
        line.rsplit(": ").next().unwrap().trim().to_string()
    };
    (field("private ("), field("public  ("))
}

fn assert_halves_match(private: &str, public: &str) {
    assert_eq!(private.len(), 64, "private scalar is 64 hex chars");
    assert!(public.starts_with("04") && public.len() == 130, "SEC1 uncompressed public key");
    let out = Command::new(runfile("OTA_SIGN"))
        .args(["pubkey", "--key-env", "KG_TEST_KEY"])
        .env("KG_TEST_KEY", private)
        .output()
        .unwrap();
    assert!(out.status.success());
    assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), public, "the public line is the private key's");
}

#[test]
fn keygen_labels_are_generic_without_a_name() {
    let out = sign(&["keygen"]);
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    assert!(text.contains("private (store as the signing secret, never in the repo): "));
    assert!(text.contains("public  (commit as firmware/ota/keys/<name>.pub): "));
    // The bug: every key was labelled as the release key.
    assert!(!text.contains("OTA_SIGNING_KEY") && !text.contains("release.pub"));
    let (private, public) = keygen_halves(&text);
    assert_halves_match(&private, &public);
}

#[test]
fn keygen_name_prints_that_keys_secret_and_file() {
    for (name, id, secret) in [
        ("release", 0, Some("OTA_SIGNING_KEY repository secret")),
        ("backup", 1, None),
        ("next", 2, None),
    ] {
        let out = sign(&["keygen", "--name", name]);
        assert!(out.status.success(), "{name}: {}", String::from_utf8_lossy(&out.stderr));
        let text = String::from_utf8_lossy(&out.stdout).to_string();
        assert!(text.starts_with(&format!("key: {name} (id {id})\n")), "{name}: header line");
        assert!(text.contains(&format!("(commit as firmware/ota/keys/{name}.pub): ")), "{name}: pub path");
        let private_line = text.lines().find(|l| l.starts_with("private (")).unwrap();
        match secret {
            Some(s) => assert!(private_line.contains(s), "{name}: names {s}"),
            None => assert!(!private_line.contains("SIGNING_KEY repository secret"), "{name}: not a CI secret"),
        }
        if name == "backup" {
            assert!(private_line.contains("OFFLINE"), "{name}: offline key");
        }
        if name != "release" {
            assert!(!text.contains("release.pub") && !text.contains("(store as the OTA_SIGNING_KEY"), "{name}");
        }
        let (private, public) = keygen_halves(&text);
        assert_halves_match(&private, &public);
    }
    // Unknown names, including the reserved ids' former MAX names, are refused.
    for bad_name in ["releese", "max", "max_backup"] {
        let bad = sign(&["keygen", "--name", bad_name]);
        assert!(!bad.status.success(), "{bad_name}");
        assert!(String::from_utf8_lossy(&bad.stderr).contains("unknown key name"), "{bad_name}");
        assert!(bad.stdout.is_empty(), "{bad_name}: no key printed");
    }
}

#[test]
fn keygen_pub_out_writes_a_committable_pub_and_guards_real_keys() {
    let dir = tmp("keygen_pub_out");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let path = |f: &str| dir.join(f).to_str().unwrap().to_string();

    // --name backup --pub-out backup.pub: header (key id, purpose) + the public hex only.
    let out = sign(&["keygen", "--name", "backup", "--pub-out", &path("backup.pub")]);
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    let (private, public) = keygen_halves(&text);
    assert!(text.contains(&format!("wrote {} (public half only)", path("backup.pub"))));
    let file = std::fs::read_to_string(path("backup.pub")).unwrap();
    let (comments, body): (Vec<&str>, Vec<&str>) = file.lines().partition(|l| l.starts_with('#'));
    assert!(comments.len() >= 2 && comments.iter().all(|l| l.starts_with("# ")));
    assert!(file.contains("key id 1, \"backup\"") && file.contains("OFFLINE"));
    assert_eq!(body, vec![public.as_str()], "exactly one key line");
    assert!(!file.contains(&private), "the private half never reaches the file");
    let chk = sign(&["check-pub", "--in", &path("backup.pub")]);
    assert!(chk.status.success());
    assert_eq!(String::from_utf8_lossy(&chk.stdout).trim(), public, "check-pub reads the file back");

    // A real key is never silently replaced; --force does it.
    let again = sign(&["keygen", "--name", "backup", "--pub-out", &path("backup.pub")]);
    assert!(!again.status.success());
    assert!(String::from_utf8_lossy(&again.stderr).contains("already holds a key"));
    assert_eq!(std::fs::read_to_string(path("backup.pub")).unwrap(), file, "untouched");
    let forced = sign(&["keygen", "--name", "backup", "--pub-out", &path("backup.pub"), "--force"]);
    assert!(forced.status.success());
    assert_ne!(std::fs::read_to_string(path("backup.pub")).unwrap(), file);

    // An UNSET placeholder is filled without --force; the name comes from the file name.
    std::fs::write(path("next.pub"), "# Planned successor key (key id 2, \"next\").\nUNSET\n").unwrap();
    let next = sign(&["keygen", "--pub-out", &path("next.pub")]);
    assert!(next.status.success(), "{}", String::from_utf8_lossy(&next.stderr));
    let next_text = String::from_utf8_lossy(&next.stdout).to_string();
    assert!(next_text.starts_with("key: next (id 2)\n"));
    let next_file = std::fs::read_to_string(path("next.pub")).unwrap();
    assert!(next_file.contains("key id 2, \"next\"") && !next_file.contains("UNSET"));

    // A name / file mismatch (another key written over release.pub) is refused.
    let mismatch = sign(&["keygen", "--name", "backup", "--pub-out", &path("release.pub")]);
    assert!(!mismatch.status.success());
    assert!(String::from_utf8_lossy(&mismatch.stderr).contains("want backup.pub"));
    assert!(!dir.join("release.pub").exists());

    // Only .pub files are ever written (never a private key file).
    let key_file = sign(&["keygen", "--name", "backup", "--pub-out", &path("backup.key")]);
    assert!(!key_file.status.success());
    assert!(!dir.join("backup.key").exists());
}
