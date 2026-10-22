//! Firmware image signing for OTA (docs/design/ota.md "Signing").
//!
//!   ota_sign keygen
//!       A new ECDSA P-256 key: prints the private scalar (hex — store it as the
//!       OTA_SIGNING_KEY GitHub Actions secret, never in the repo) and the public
//!       key (hex, SEC1 uncompressed — commit it as firmware/ota/keys/release.pub).
//!   ota_sign pubkey [--key-env VAR | --key-file F]
//!       The public key for a private key.
//!   ota_sign sign --version 1.9.0|1009000 --in app.bin --out app.manifest
//!                 [--key-env VAR | --key-file F] [--flags N]
//!       The 108-byte signed manifest (the swarm loader's layout) for an image.
//!   ota_sign verify --pubkey HEX|--pubkey-file F --manifest M --in app.bin
//!       Exit 0 when the manifest is signed by that key and matches the image.
//!   ota_sign corrupt --in M --out M2
//!       Flip a signature bit (tests: a manifest that must be refused).
//!   ota_sign epoch --epoch N --revoke 0[,2] --key-id SIGNER --out rec.bin [key]
//!       A signed key-epoch record (docs/design/ota.md "Key rotation"): raise the
//!       epoch to N and revoke the listed key ids, signed by key SIGNER.
//!   ota_sign verify-epoch --ring 0=release.pub,1=backup.pub --in rec.bin
//!
//! sign takes --key-id (0 release, the default; 1 backup; 2 next) and
//! --security-version (0..255, default 0), carried in the manifest's flags; verify
//! accepts --ring ID=FILE,... to check the manifest against the key its id names.
//!
//! The default key source is the OTA_SIGNING_KEY environment variable (64 hex
//! characters). Signatures are RFC 6979 deterministic, so re-signing the same
//! image with the same key yields the same manifest.

use std::fs;
use std::process::ExitCode;

use p256::ecdsa::signature::{Signer, Verifier};
use p256::ecdsa::{Signature, SigningKey, VerifyingKey};
use splanc_ota::keyring::{self, EpochRecord};
use splanc_ota::manifest::{self, Manifest};
use splanc_ota::sha256::sha256;

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Hex, ignoring whitespace and `#` comment lines (the keys/*.pub|key format).
fn unhex(s: &str) -> Result<Vec<u8>, String> {
    let s: String = s
        .lines()
        .filter(|l| !l.trim_start().starts_with('#'))
        .flat_map(|l| l.chars())
        .filter(|c| !c.is_whitespace())
        .collect();
    if s.len() % 2 != 0 {
        return Err("odd-length hex".into());
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|e| format!("bad hex: {e}")))
        .collect()
}

struct Args(Vec<String>);

impl Args {
    fn opt(&self, name: &str) -> Option<String> {
        self.0.iter().position(|a| a == name).and_then(|i| self.0.get(i + 1).cloned())
    }

    fn req(&self, name: &str) -> Result<String, String> {
        self.opt(name).ok_or_else(|| format!("missing {name}"))
    }
}

fn signing_key(a: &Args) -> Result<SigningKey, String> {
    let text = if let Some(f) = a.opt("--key-file") {
        fs::read_to_string(&f).map_err(|e| format!("{f}: {e}"))?
    } else {
        let var = a.opt("--key-env").unwrap_or_else(|| "OTA_SIGNING_KEY".into());
        std::env::var(&var).map_err(|_| format!("${var} is not set (the OTA signing key, 64 hex chars)"))?
    };
    let b = unhex(text.trim())?;
    if b.len() != 32 {
        return Err(format!("signing key must be 32 bytes, got {}", b.len()));
    }
    SigningKey::from_slice(&b).map_err(|e| format!("bad signing key: {e}"))
}

fn public_hex(k: &SigningKey) -> String {
    hex(VerifyingKey::from(k).to_encoded_point(false).as_bytes())
}

fn parse_version(s: &str) -> Result<u32, String> {
    if let Ok(n) = s.parse::<u32>() {
        return Ok(n);
    }
    manifest::parse_version(s).ok_or_else(|| format!("bad version {s:?} (want X.Y.Z or a number)"))
}

fn sign(a: &Args) -> Result<(), String> {
    let key = signing_key(a)?;
    let version = parse_version(&a.req("--version")?)?;
    let input = a.req("--in")?;
    let image = fs::read(&input).map_err(|e| format!("{input}: {e}"))?;
    let key_id: u8 = a.opt("--key-id").map(|f| f.parse().map_err(|_| "bad --key-id")).transpose()?.unwrap_or(0);
    let secv: u8 =
        a.opt("--security-version").map(|f| f.parse().map_err(|_| "bad --security-version")).transpose()?.unwrap_or(0);
    let flags: u32 = match a.opt("--flags") {
        Some(f) => f.parse().map_err(|_| "bad --flags")?,
        None => keyring::flags(key_id, secv),
    };
    let mut m = Manifest::unsigned(version, image.len() as u32, sha256(&image), flags);
    let sig: Signature = key.sign(&m.signed_bytes());
    m.signature.copy_from_slice(&sig.to_bytes());
    let out = a.req("--out")?;
    fs::write(&out, m.encode()).map_err(|e| format!("{out}: {e}"))?;
    println!(
        "{{\"version\":{},\"size\":{},\"sha256\":\"{}\",\"flags\":{},\"pubkey\":\"{}\"}}",
        m.version,
        m.size,
        hex(&m.sha256),
        m.flags,
        public_hex(&key)
    );
    Ok(())
}

/// --ring 0=a.pub,1=b.pub -> the key for `id` (UNSET entries are absent).
fn ring_key(a: &Args, id: u8) -> Result<VerifyingKey, String> {
    let ring = a.req("--ring")?;
    for spec in ring.split(',') {
        let (kid, path) = spec.split_once('=').ok_or("--ring wants ID=FILE,...")?;
        if kid.parse::<u8>().map_err(|_| "bad ring id")? == id {
            let text = fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))?;
            if text.lines().any(|l| l.trim() == "UNSET") {
                return Err(format!("key id {id} is UNSET in the ring"));
            }
            return VerifyingKey::from_sec1_bytes(&unhex(&text)?).map_err(|e| format!("bad pubkey: {e}"));
        }
    }
    Err(format!("key id {id} is not in the ring"))
}

fn verify(a: &Args) -> Result<(), String> {
    let mf = a.req("--manifest")?;
    let m = Manifest::decode(&fs::read(&mf).map_err(|e| format!("{mf}: {e}"))?).ok_or("not a 108-byte manifest")?;
    let vk = if a.opt("--ring").is_some() {
        ring_key(a, keyring::key_id(&m))?
    } else {
        let pk_hex = match a.opt("--pubkey-file") {
            Some(f) => fs::read_to_string(&f).map_err(|e| format!("{f}: {e}"))?,
            None => a.req("--pubkey")?,
        };
        VerifyingKey::from_sec1_bytes(&unhex(pk_hex.trim())?).map_err(|e| format!("bad pubkey: {e}"))?
    };
    let input = a.req("--in")?;
    let image = fs::read(&input).map_err(|e| format!("{input}: {e}"))?;
    let sig = Signature::from_slice(&m.signature).map_err(|e| format!("bad signature encoding: {e}"))?;
    vk.verify(&m.signed_bytes(), &sig).map_err(|_| "signature does not verify".to_string())?;
    if m.size as usize != image.len() || m.sha256 != sha256(&image) {
        return Err("image does not match the manifest".into());
    }
    println!("ok version={} size={}", m.version, m.size);
    Ok(())
}

fn run() -> Result<(), String> {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let Some(cmd) = argv.first().cloned() else {
        return Err("usage: ota_sign keygen|pubkey|sign|verify|corrupt ...".into());
    };
    let a = Args(argv[1..].to_vec());
    match cmd.as_str() {
        "keygen" => {
            let k = SigningKey::random(&mut rand_core::OsRng);
            println!("private (OTA_SIGNING_KEY secret): {}", hex(&k.to_bytes()));
            println!("public  (firmware/ota/keys/release.pub): {}", public_hex(&k));
            Ok(())
        }
        "pubkey" => {
            println!("{}", public_hex(&signing_key(&a)?));
            Ok(())
        }
        "sign" => sign(&a),
        "verify" => verify(&a),
        "check-pub" => {
            // A keys/*.pub file: a valid on-curve P-256 point, printed in the file format
            // (lowercase hex SEC1 uncompressed) — what `pubkey` prints for its private key.
            let f = a.req("--in")?;
            let text = fs::read_to_string(&f).map_err(|e| format!("{f}: {e}"))?;
            let vk = VerifyingKey::from_sec1_bytes(&unhex(&text)?).map_err(|e| format!("{f}: not a P-256 public key: {e}"))?;
            println!("{}", hex(vk.to_encoded_point(false).as_bytes()));
            Ok(())
        }
        "epoch" => {
            let key = signing_key(&a)?;
            let signer: u8 = a.req("--key-id")?.parse().map_err(|_| "bad --key-id")?;
            let epoch: u32 = a.req("--epoch")?.parse().map_err(|_| "bad --epoch")?;
            let mut revoked = 0u32;
            if let Some(list) = a.opt("--revoke") {
                for id in list.split(',').filter(|x| !x.is_empty()) {
                    let id: u8 = id.parse().map_err(|_| "bad --revoke id")?;
                    if id >= keyring::MAX_KEYS {
                        return Err(format!("key id {id} out of range"));
                    }
                    revoked |= 1 << id;
                }
            }
            if revoked & (1 << signer) != 0 {
                return Err("a key can't sign its own revocation".into());
            }
            let mut r = EpochRecord { epoch, revoked, signer, signature: [0; 64] };
            let sig: Signature = key.sign(&r.signed_bytes());
            r.signature.copy_from_slice(&sig.to_bytes());
            let out = a.req("--out")?;
            fs::write(&out, r.encode()).map_err(|e| format!("{out}: {e}"))?;
            println!("{{\"epoch\":{epoch},\"revoked\":{revoked},\"signer\":{signer}}}");
            Ok(())
        }
        "verify-epoch" => {
            let i = a.req("--in")?;
            let r = EpochRecord::decode(&fs::read(&i).map_err(|e| format!("{i}: {e}"))?).ok_or("not an epoch record")?;
            let vk = ring_key(&a, r.signer)?;
            let sig = Signature::from_slice(&r.signature).map_err(|e| format!("bad signature: {e}"))?;
            vk.verify(&r.signed_bytes(), &sig).map_err(|_| "epoch signature does not verify".to_string())?;
            println!("ok epoch={} revoked={:#x} signer={}", r.epoch, r.revoked, r.signer);
            Ok(())
        }
        "corrupt" => {
            let i = a.req("--in")?;
            let mut b = fs::read(&i).map_err(|e| format!("{i}: {e}"))?;
            if b.len() != manifest::ENCODED_LEN {
                return Err("not a manifest".into());
            }
            b[manifest::SIGNED_LEN + 7] ^= 0x01;
            let o = a.req("--out")?;
            fs::write(&o, b).map_err(|e| format!("{o}: {e}"))
        }
        other => Err(format!("unknown command {other}")),
    }
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("ota_sign: {e}");
            ExitCode::FAILURE
        }
    }
}
