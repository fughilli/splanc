//! The OTA arms on a Splanc MAX (docs/design/max-ota.md "Transport").
//!
//! The same messages the C6 answers (ledmapper.proto 70..75 / ota_status 32), so
//! the web app's "Update over Wi-Fi", the agent's `update_firmware` and the bridge
//! drive a MAX with one dispatch: a MAX advertises the welcome feature
//! `ota_pull` and reports `ota_status.board`, and it PULLS its image instead of
//! taking ota_chunks.
//!
//! The player is unprivileged (user `ledmapper`), so it never installs anything:
//! it checks an offer (the same `splanc_max_ota::verify` the updater runs, for a
//! quick refusal), drops it in the root updater's inbox (`inbox/request`, which a
//! systemd path unit turns into `splanc-max-ota apply`) and answers status from the
//! updater's state file. The updater checks everything again and is the authority.

use std::fs;
use std::path::{Path, PathBuf};

use splanc_max_ota::board::Board;
use splanc_max_ota::state::{url_ok, Phase, Request, State};
use splanc_max_ota::verify::{self, Device};
use splanc_ota::manifest::Manifest;
use splanc_ota::wire::{self, ClientArm, Mode, Status};

/// ClientMessage oneof field numbers of the OTA arms (ota_begin .. ota_reboot).
const OTA_ARMS: std::ops::RangeInclusive<u64> = 70..=75;

pub struct Ota {
    /// The updater's state directory (state, inbox/, dl/).
    pub dir: PathBuf,
    /// The hardware (None: not a Raspberry Pi we know — every offer is refused).
    pub board: Option<Board>,
    /// The running system's version file (`<system>/etc/splanc-max/version`).
    pub version_file: PathBuf,
}

impl Ota {
    pub fn on_this_pi() -> Ota {
        let model = fs::read_to_string("/proc/device-tree/model").unwrap_or_default();
        Ota {
            dir: PathBuf::from("/var/lib/splanc-ota"),
            board: Board::from_model(&model),
            version_file: PathBuf::from("/run/current-system/etc/splanc-max/version"),
        }
    }

    fn state(&self) -> State {
        State::parse(&fs::read_to_string(self.dir.join("state")).unwrap_or_default())
    }

    fn pending(&self) -> Option<Request> {
        fs::read_to_string(self.dir.join("inbox/request")).ok().map(|t| Request::parse(&t))
    }

    fn fw_version(&self) -> String {
        fs::read_to_string(&self.version_file).map(|v| v.trim().to_string()).unwrap_or_default()
    }

    /// Whether `frame` is one of the OTA arms (peeks the envelope's first tag).
    pub fn is_ota_frame(frame: &[u8]) -> bool {
        let mut v = 0u64;
        for (i, b) in frame.iter().take(10).enumerate() {
            v |= ((b & 0x7f) as u64) << (7 * i);
            if b & 0x80 == 0 {
                return v & 7 == 2 && OTA_ARMS.contains(&(v >> 3));
            }
        }
        false
    }

    /// Answer one OTA frame: the encoded ServerMessage. Zero-copy, with the
    /// loader's hand-coded codec (splanc_ota::wire): the host profile's by-value
    /// ClientMessage/ServerMessage are far too big for a worker stack.
    pub fn handle(&self, frame: &[u8]) -> Option<Vec<u8>> {
        let reply = match wire::decode_client(frame).ok()? {
            ClientArm::GetOtaStatus => self.status(None),
            ClientArm::OtaBegin { manifest, allow_downgrade, key_epoch, source_url } => self.begin(Request {
                manifest: manifest.to_vec(),
                allow_downgrade,
                key_epoch: key_epoch.to_vec(),
                source_url: String::from_utf8_lossy(source_url).into_owned(),
            }),
            ClientArm::OtaAbort => {
                let _ = write_atomic(&self.dir.join("inbox/abort"), b"1\n");
                let _ = fs::remove_file(self.dir.join("inbox/request"));
                self.status(None)
            }
            ClientArm::OtaChunk { .. } | ClientArm::OtaFinish => self.status(Some("pull_only")),
            ClientArm::OtaReboot { .. } => self.status(Some("unsupported")),
            _ => return None,
        };
        reply.encode()
    }

    fn refuse(&self, code: &str) -> Reply {
        self.status(Some(code))
    }

    fn begin(&self, req: Request) -> Reply {
        let st = self.state();
        let Some(board) = self.board else {
            return self.refuse("wrong_board");
        };
        let same = st.manifest.as_ref().is_some_and(|m| m.as_slice() == req.manifest.as_slice());
        if st.phase.busy() && !(same || st.phase == Phase::Downloading) {
            return self.refuse("busy");
        }
        if !req.source_url.is_empty() && !url_ok(&req.source_url) {
            return self.refuse("bad_url");
        }
        let mut keys = st.keys;
        if !req.key_epoch.is_empty() {
            match verify::apply_epoch(&keys, &req.key_epoch, splanc_max_ota::ring()) {
                Ok(k) => keys = k,
                Err(e) => return self.refuse(e.code()),
            }
        }
        let dev = Device { board, keys, app_version: st.app_version };
        if let Err(e) = verify::check_offer(&req.manifest, req.allow_downgrade, &dev, splanc_max_ota::ring()) {
            return self.refuse(e.code());
        }
        if let Err(e) = write_atomic(&self.dir.join("inbox/request"), req.encode().as_bytes()) {
            eprintln!("player_rs: ota: can't reach the updater's inbox: {e}");
            return self.refuse("updater_unavailable");
        }
        self.status(None)
    }

    /// The device's update status from the updater's state (and a request it hasn't
    /// picked up yet). `refusal` = this reply refuses a request.
    pub fn status(&self, refusal: Option<&str>) -> Reply {
        use wire::State as S;
        let st = self.state();
        let (state, manifest) = match (refusal, self.pending()) {
            (Some(_), _) => (S::Failed, st.manifest()),
            (None, Some(req)) => (S::Downloading, Manifest::decode(&req.manifest)),
            (None, None) => (
                match st.phase {
                    Phase::Downloading => S::Downloading,
                    Phase::Importing => S::Verifying,
                    Phase::Staged => S::Installed,
                    Phase::Failed => S::Failed,
                    Phase::Idle | Phase::Trial | Phase::Committing => S::Idle,
                },
                st.manifest(),
            ),
        };
        let mut r = Reply { state, ..Default::default() };
        if let Some(m) = manifest {
            r.version = m.version;
            r.size = m.size;
            r.offset = match state {
                S::Verifying | S::Installed => m.size,
                S::Downloading if st.phase == Phase::Downloading && st.manifest() == Some(m) => {
                    let sha = splanc_max_ota::kv::hex(&m.sha256);
                    let dl = self.dir.join("dl");
                    if dl.join(format!("{sha}.img")).exists() {
                        m.size
                    } else {
                        fs::metadata(dl.join(format!("{sha}.part"))).map(|x| x.len().min(m.size as u64) as u32).unwrap_or(0)
                    }
                }
                _ => 0,
            };
        }
        r.error = match refusal {
            Some(c) => c.to_string(),
            None if matches!(state, S::Failed | S::Idle) => st.error.clone(),
            None => String::new(),
        };
        r.app_version = st.app_version;
        r.app_fw_version = self.fw_version();
        r.last_result = st.last_result.clone();
        r.key_epoch = st.keys.epoch;
        r.revoked_keys = st.keys.revoked;
        r.security_floor = st.keys.security_floor as u32;
        r.board = self.board.map(|b| b.name()).unwrap_or("");
        r
    }
}

/// An `ota_status` reply (owned; encoded through splanc_ota::wire::Status).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Reply {
    pub state: wire::State,
    pub version: u32,
    pub size: u32,
    pub offset: u32,
    pub error: String,
    pub app_version: u32,
    pub app_fw_version: String,
    pub last_result: String,
    pub key_epoch: u32,
    pub revoked_keys: u32,
    pub security_floor: u32,
    pub board: &'static str,
}

impl Default for Reply {
    fn default() -> Self {
        Reply {
            state: wire::State::Idle,
            version: 0,
            size: 0,
            offset: 0,
            error: String::new(),
            app_version: 0,
            app_fw_version: String::new(),
            last_result: String::new(),
            key_epoch: 0,
            revoked_keys: 0,
            security_floor: 0,
            board: "",
        }
    }
}

impl Reply {
    pub fn encode(&self) -> Option<Vec<u8>> {
        let s = Status {
            mode: Mode::App as u8,
            state: self.state as u8,
            version: self.version,
            size: self.size,
            offset: self.offset,
            error: &self.error,
            app_version: self.app_version,
            app_fw_version: &self.app_fw_version,
            last_result: &self.last_result,
            key_epoch: self.key_epoch,
            revoked_keys: self.revoked_keys,
            security_floor: self.security_floor,
            board: self.board,
            max_chunk: 0, // pull: no ota_chunks
            ..Default::default()
        };
        let mut out = vec![0u8; 1024];
        let n = wire::encode_status(&s, &mut out)?;
        out.truncate(n);
        Some(out)
    }
}

/// Temp file + rename in the same directory (the inbox is group-writable by the
/// player; the updater reads it as root).
fn write_atomic(path: &Path, data: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension(format!("tmp.{}", std::process::id()));
    fs::write(&tmp, data)?;
    fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ledmapper_pb::ledmapper_::v1_ as pb;
    use micropb::{MessageDecode, MessageEncode, PbEncoder};
    use pb::ClientMessage_::Msg as CMsg;
    use pb::ServerMessage_::Msg as SMsg;

    // The generated host bindings are big by value: keep them off the test stack.
    fn frame(msg: CMsg) -> Vec<u8> {
        let env = Box::new(pb::ClientMessage { r#msg: Some(msg) });
        let mut enc = PbEncoder::new(micropb::heapless::Vec::<u8, 512>::new());
        env.encode(&mut enc).unwrap();
        enc.into_writer().to_vec()
    }

    fn reply(b: &[u8]) -> Box<pb::OtaStatus> {
        let mut m = Box::<pb::ServerMessage>::default();
        m.decode_from_bytes(b).unwrap();
        match m.r#msg.take() {
            Some(SMsg::OtaStatus(s)) => Box::new(s),
            other => panic!("{other:?}"),
        }
    }

    fn ota(tag: &str) -> Ota {
        let dir = PathBuf::from(std::env::var("TEST_TMPDIR").unwrap_or("/tmp".into())).join(format!("ota-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("inbox")).unwrap();
        Ota { version_file: dir.join("version"), dir, board: Some(Board::Pi3) }
    }

    #[test]
    fn peeks_ota_arms_only() {
        assert!(Ota::is_ota_frame(&frame(CMsg::GetOtaStatus(Default::default()))));
        assert!(Ota::is_ota_frame(&frame(CMsg::OtaAbort(Default::default()))));
        assert!(!Ota::is_ota_frame(&frame(CMsg::Hello(Default::default()))));
        assert!(!Ota::is_ota_frame(&[]));
    }

    #[test]
    fn status_reports_a_pull_device() {
        let o = ota("status");
        fs::write(&o.version_file, "1.10.0\n").unwrap();
        let st = State { app_version: 1_010_000, last_result: "ok".into(), ..Default::default() };
        fs::write(o.dir.join("state"), st.encode()).unwrap();
        let s = reply(&o.handle(&frame(CMsg::GetOtaStatus(Default::default()))).unwrap());
        assert_eq!(s.r#mode, pb::OtaStatus_::Mode::App);
        assert_eq!(s.r#state, pb::OtaStatus_::State::Idle);
        assert_eq!(s.r#board.as_str(), "pi3");
        assert_eq!(s.r#app_version, 1_010_000);
        assert_eq!(s.r#app_fw_version.as_str(), "1.10.0");
        assert_eq!(s.r#last_result.as_str(), "ok");
        assert_eq!(s.r#max_chunk, 0);
        let c = reply(&o.handle(&frame(CMsg::OtaFinish(Default::default()))).unwrap());
        assert_eq!((c.r#state, c.r#error.as_str()), (pb::OtaStatus_::State::Failed, "pull_only"));
    }

    #[test]
    fn begin_refuses_a_bad_manifest_and_writes_nothing() {
        let o = ota("refuse");
        let mut b = pb::OtaBegin::default();
        b.r#manifest.extend_from_slice(&[0u8; 108]).unwrap();
        let s = reply(&o.handle(&frame(CMsg::OtaBegin(b))).unwrap());
        assert_eq!(s.r#state, pb::OtaStatus_::State::Failed);
        assert_eq!(s.r#error.as_str(), "bad_manifest"); // size 0
        assert!(!o.dir.join("inbox/request").exists());
    }

    #[test]
    fn a_pending_request_reads_as_downloading() {
        let o = ota("pending");
        let mut man = [0u8; 108];
        man[0..4].copy_from_slice(&1_010_000u32.to_le_bytes());
        man[4..8].copy_from_slice(&1234u32.to_le_bytes());
        let req = Request { manifest: man.to_vec(), ..Default::default() };
        fs::write(o.dir.join("inbox/request"), req.encode()).unwrap();
        let s = o.status(None);
        assert_eq!(s.state, wire::State::Downloading);
        assert_eq!((s.version, s.size, s.offset), (1_010_000, 1234, 0));
        // ota_abort withdraws it.
        let a = reply(&o.handle(&frame(CMsg::OtaAbort(Default::default()))).unwrap());
        assert_eq!(a.r#state, pb::OtaStatus_::State::Idle);
        assert!(o.dir.join("inbox/abort").exists());
    }

    #[test]
    fn downloading_reports_bytes_fetched() {
        let o = ota("dl");
        let mut man = [0u8; 108];
        man[0..4].copy_from_slice(&7u32.to_le_bytes());
        man[4..8].copy_from_slice(&100u32.to_le_bytes());
        man[8] = 0xab;
        let st = State { phase: Phase::Downloading, manifest: Some(man), ..Default::default() };
        fs::write(o.dir.join("state"), st.encode()).unwrap();
        fs::create_dir_all(o.dir.join("dl")).unwrap();
        let sha = splanc_max_ota::kv::hex(&man[8..40]);
        fs::write(o.dir.join(format!("dl/{sha}.part")), [0u8; 40]).unwrap();
        let s = o.status(None);
        assert_eq!((s.state, s.offset, s.size), (wire::State::Downloading, 40, 100));
    }

    #[test]
    fn welcome_advertises_ota_pull() {
        // main.rs declares these on the core; the core splices them into welcome.
        let mut p = ledmapper_player::Player::new("pi-0001", 8);
        p.set_features(&["ota", "ota_pull"], 0);
        assert_eq!(p.features(), &["ota", "ota_pull"]);
    }
}
