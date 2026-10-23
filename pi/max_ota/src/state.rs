//! The updater's persistent state (`/var/lib/splanc-ota/state`, docs/design/
//! max-ota.md "State"). Written atomically (temp file, fsync, rename, fsync the
//! directory) at every step, so a power cut leaves either the old or the new
//! record, never a torn one. World-readable: the player answers get_ota_status
//! from it.

use splanc_ota::keyring::KeyState;
use splanc_ota::manifest::{Manifest, ENCODED_LEN};

use crate::kv::{self, Kv};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Phase {
    #[default]
    Idle,
    /// Fetching the image (resumable: the `.part` file survives a reboot).
    Downloading,
    /// Verified; importing it into the Nix store and writing the trial entry.
    Importing,
    /// The trial entry and the one-shot flag are written; rebooting into it.
    Staged,
    /// Booted into the new system once; it must prove healthy by the deadline.
    Trial,
    /// Healthy: making it the default generation.
    Committing,
    /// The last request failed (`error` says why) — until the next one.
    Failed,
}

impl Phase {
    pub fn name(self) -> &'static str {
        match self {
            Phase::Idle => "idle",
            Phase::Downloading => "downloading",
            Phase::Importing => "importing",
            Phase::Staged => "staged",
            Phase::Trial => "trial",
            Phase::Committing => "committing",
            Phase::Failed => "failed",
        }
    }

    pub fn parse(s: &str) -> Phase {
        match s.trim() {
            "downloading" => Phase::Downloading,
            "importing" => Phase::Importing,
            "staged" => Phase::Staged,
            "trial" => Phase::Trial,
            "committing" => Phase::Committing,
            "failed" => Phase::Failed,
            _ => Phase::Idle,
        }
    }

    /// An update is under way (a new request is refused as `busy` unless it is the
    /// same manifest).
    pub fn busy(self) -> bool {
        !matches!(self, Phase::Idle | Phase::Failed)
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct State {
    pub phase: Phase,
    /// The update in flight (108-byte manifest), if any.
    pub manifest: Option<[u8; ENCODED_LEN]>,
    /// Where the image comes from (empty: the release asset for its version).
    pub source_url: String,
    /// The new system's store path, once imported.
    pub toplevel: String,
    /// The system that was running when the trial was staged (the fallback).
    pub prev_toplevel: String,
    /// Random per staging; the one-shot flag file carries it, so a consumed flag
    /// can be told apart from one left by an earlier update.
    pub nonce: String,
    /// Manifest version of the running system (0 = unknown).
    pub app_version: u32,
    /// "installed" (trial pending), "ok", "rolled_back", or a failure code.
    pub last_result: String,
    pub error: String,
    pub keys: KeyState,
    /// The old system had a network when the trial was staged: the new one must too.
    pub net: bool,
    /// When the trial boot began (ms since the epoch), for the health deadline.
    pub trial_started_ms: u64,
}

impl State {
    pub fn manifest(&self) -> Option<Manifest> {
        self.manifest.as_ref().and_then(|m| Manifest::decode(m))
    }

    pub fn version(&self) -> u32 {
        self.manifest().map(|m| m.version).unwrap_or(0)
    }

    pub fn size(&self) -> u32 {
        self.manifest().map(|m| m.size).unwrap_or(0)
    }

    pub fn sha_hex(&self) -> String {
        self.manifest().map(|m| kv::hex(&m.sha256)).unwrap_or_default()
    }

    pub fn to_kv(&self) -> Kv {
        let mut k = Kv::new();
        let mut put = |a: &str, b: String| {
            k.insert(a.to_string(), b);
        };
        put("phase", self.phase.name().into());
        put("manifest", self.manifest.map(|m| kv::hex(&m)).unwrap_or_default());
        put("source_url", self.source_url.clone());
        put("toplevel", self.toplevel.clone());
        put("prev_toplevel", self.prev_toplevel.clone());
        put("nonce", self.nonce.clone());
        put("app_version", self.app_version.to_string());
        put("last_result", self.last_result.clone());
        put("error", self.error.clone());
        put("key_epoch", self.keys.epoch.to_string());
        put("revoked_keys", self.keys.revoked.to_string());
        put("security_floor", self.keys.security_floor.to_string());
        put("net", if self.net { "1" } else { "0" }.into());
        put("trial_started_ms", self.trial_started_ms.to_string());
        // Derived, for people and the player (not read back).
        put("version", self.version().to_string());
        put("size", self.size().to_string());
        put("sha256", self.sha_hex());
        k
    }

    pub fn from_kv(k: &Kv) -> State {
        let manifest = kv::unhex(&kv::get_str(k, "manifest")).and_then(|b| <[u8; ENCODED_LEN]>::try_from(b.as_slice()).ok());
        State {
            phase: Phase::parse(&kv::get_str(k, "phase")),
            manifest,
            source_url: kv::get_str(k, "source_url"),
            toplevel: kv::get_str(k, "toplevel"),
            prev_toplevel: kv::get_str(k, "prev_toplevel"),
            nonce: kv::get_str(k, "nonce"),
            app_version: kv::get_u32(k, "app_version"),
            last_result: kv::get_str(k, "last_result"),
            error: kv::get_str(k, "error"),
            keys: KeyState {
                epoch: kv::get_u32(k, "key_epoch"),
                revoked: kv::get_u32(k, "revoked_keys"),
                security_floor: kv::get_u32(k, "security_floor").min(255) as u8,
            },
            net: kv::get_bool(k, "net"),
            trial_started_ms: kv::get_u64(k, "trial_started_ms"),
        }
    }

    pub fn encode(&self) -> String {
        kv::encode(&self.to_kv())
    }

    pub fn parse(text: &str) -> State {
        State::from_kv(&kv::parse(text))
    }
}

/// What the player sends the updater (the `inbox/request` file).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Request {
    pub manifest: Vec<u8>,
    pub allow_downgrade: bool,
    pub key_epoch: Vec<u8>,
    pub source_url: String,
}

impl Request {
    pub fn encode(&self) -> String {
        let mut k = Kv::new();
        k.insert("manifest".into(), kv::hex(&self.manifest));
        k.insert("allow_downgrade".into(), if self.allow_downgrade { "1" } else { "0" }.into());
        k.insert("key_epoch".into(), kv::hex(&self.key_epoch));
        k.insert("source_url".into(), self.source_url.clone());
        kv::encode(&k)
    }

    pub fn parse(text: &str) -> Request {
        let k = kv::parse(text);
        Request {
            manifest: kv::unhex(&kv::get_str(&k, "manifest")).unwrap_or_default(),
            allow_downgrade: kv::get_bool(&k, "allow_downgrade"),
            key_epoch: kv::unhex(&kv::get_str(&k, "key_epoch")).unwrap_or_default(),
            source_url: kv::get_str(&k, "source_url"),
        }
    }
}

/// Only plain http(s) URLs, no whitespace (curl gets it as one argv element).
pub fn url_ok(u: &str) -> bool {
    (u.starts_with("https://") || u.starts_with("http://")) && u.len() < 2048 && !u.chars().any(|c| c.is_whitespace() || c.is_control())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_roundtrip() {
        let mut s = State { phase: Phase::Trial, ..Default::default() };
        s.manifest = Some([7u8; ENCODED_LEN]);
        s.toplevel = "/nix/store/x".into();
        s.keys = KeyState { epoch: 2, revoked: 1, security_floor: 3 };
        s.net = true;
        s.trial_started_ms = 123;
        let back = State::parse(&s.encode());
        assert_eq!(back, s);
        assert!(Phase::Downloading.busy() && !Phase::Failed.busy());
    }

    #[test]
    fn request_roundtrip_and_urls() {
        let r = Request { manifest: vec![1; 108], allow_downgrade: true, key_epoch: vec![], source_url: "http://127.0.0.1:18080/b".into() };
        assert_eq!(Request::parse(&r.encode()), r);
        assert!(url_ok("https://github.com/x"));
        assert!(!url_ok("file:///etc/shadow"));
        assert!(!url_ok("https://a b"));
    }
}
