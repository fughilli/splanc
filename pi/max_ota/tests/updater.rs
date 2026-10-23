//! The MAX updater against a simulated Raspberry Pi (docs/design/max-ota.md
//! "Testing"): a filesystem, a Nix store, a web server, a model of U-Boot's
//! one-shot trial boot and of NixOS's extlinux builder, and POWER CUTS at every
//! mutating step. Each scenario drives the same `Updater` the Pi runs.

use std::collections::{BTreeMap, BTreeSet};
use std::panic::{catch_unwind, AssertUnwindSafe};

use p256::ecdsa::signature::Signer;
use p256::ecdsa::{Signature, SigningKey};
use splanc_max_ota::board::{self, Board};
use splanc_max_ota::extlinux;
use splanc_max_ota::image;
use splanc_max_ota::state::{Phase, Request, State};
use splanc_max_ota::updater::{release_url, Layout, Next, Sys, Updater, UBOOT_MARKER};
use splanc_max_ota::verify;
use splanc_ota::keyring;
use splanc_ota::manifest::Manifest;
use splanc_ota::sha256::sha256;

const OLD: &str = "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-nixos-system-ledmapper-old";
const NEW: &str = "/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-nixos-system-ledmapper-new";
const DEP: &str = "/nix/store/cccccccccccccccccccccccccccccccc-player-new";
const CUT: &str = "POWER CUT";

#[derive(Clone)]
struct SysInfo {
    version: u32,
    /// The kernel reaches userspace (false: panics at boot, every time).
    boots: bool,
    /// The player comes up and reports healthy.
    healthy: bool,
}

#[derive(Clone)]
struct Pi {
    files: BTreeMap<String, Vec<u8>>,
    links: BTreeMap<String, String>,
    store: BTreeSet<String>,
    systems: BTreeMap<String, SysInfo>,
    web: BTreeMap<String, Vec<u8>>,
    booted: String,
    cmdline: String,
    boot_at: u64,
    now: u64,
    net: bool,
    board: Board,
    profile: String,
    ops: u64,
    cut_at: Option<u64>,
    dl_fail: u32,
    reboots: u32,
    ticks: u64,
}

fn lay() -> Layout {
    Layout::default()
}

fn kernel_of(top: &str) -> String {
    format!("{}-linux/Image", &top[..43])
}

fn initrd_of(top: &str) -> String {
    format!("{}-initrd/initrd", &top[..43])
}

fn extlinux_default(top: &str) -> String {
    format!(
        "DEFAULT nixos-default\nTIMEOUT 10\nLABEL nixos-default\n  MENU LABEL NixOS - Default\n  LINUX ../nixos/{}\n  INITRD ../nixos/{}\n  APPEND init={top}/init loglevel=4\n",
        extlinux::clean_name(&kernel_of(top)),
        extlinux::clean_name(&initrd_of(top)),
    )
}

impl Pi {
    fn new() -> Pi {
        let mut pi = Pi {
            files: BTreeMap::new(),
            links: BTreeMap::new(),
            store: BTreeSet::new(),
            systems: BTreeMap::new(),
            web: BTreeMap::new(),
            booted: String::new(),
            cmdline: String::new(),
            boot_at: 0,
            now: 1_000,
            net: true,
            board: Board::Pi3,
            profile: OLD.into(),
            ops: 0,
            cut_at: None,
            dl_fail: 0,
            reboots: 0,
            ticks: 0,
        };
        pi.systems.insert(OLD.into(), SysInfo { version: 1_009_000, boots: true, healthy: true });
        pi.add_to_store(OLD);
        pi.files.insert("/boot/firmware/u-boot-rpi3.bin".into(), [b"\x00uboot bootcmd ".as_slice(), UBOOT_MARKER, b" ..."].concat());
        pi.files.insert(lay().extlinux(), extlinux_default(OLD).into_bytes());
        for f in [kernel_of(OLD), initrd_of(OLD)] {
            pi.files.insert(format!("/boot/nixos/{}", extlinux::clean_name(&f)), b"k".to_vec());
        }
        assert!(pi.power_on());
        pi
    }

    fn tick(&mut self) {
        self.ops += 1;
        if self.cut_at == Some(self.ops) {
            panic!("{CUT}");
        }
    }

    /// A store path became valid: a system's files appear with it.
    fn add_to_store(&mut self, p: &str) {
        self.store.insert(p.to_string());
        if let Some(info) = self.systems.get(p).cloned() {
            self.files.insert(format!("{p}/init"), b"#!init".to_vec());
            self.files.insert(format!("{p}/kernel-params"), b"loglevel=4".to_vec());
            let v = format!("{}.{}.{}", info.version / 1_000_000, info.version / 1000 % 1000, info.version % 1000);
            self.files.insert(format!("{p}/etc/splanc-max/version"), v.into_bytes());
            self.files.insert(kernel_of(p), b"kernel".to_vec());
            self.files.insert(initrd_of(p), b"initrd".to_vec());
            self.links.insert(format!("{p}/kernel"), kernel_of(p));
            self.links.insert(format!("{p}/initrd"), initrd_of(p));
        }
    }

    /// U-Boot (pi/provisioning/nix/ota.nix bootcmd) then the kernel: Some(true) =
    /// the system reached userspace; false = it panicked (the caller powers on again).
    fn power_on(&mut self) -> bool {
        self.files.retain(|k, _| !k.starts_with("/run/"));
        self.reboots += 1;
        let uboot_ok = self.files.values().any(|v| v.windows(UBOOT_MARKER.len()).any(|w| w == UBOOT_MARKER));
        let mut conf = self.files.get(&lay().extlinux()).cloned().unwrap_or_default();
        let flag = lay().flag();
        if uboot_ok && self.files.get(&flag).is_some_and(|f| f.first() == Some(&b'1')) {
            self.files.get_mut(&flag).unwrap()[0] = b'0'; // fatwrite, before the kernel loads
            if let Some(t) = self.files.get(&lay().trial_conf()) {
                if self.entry_ok(t) {
                    conf = t.clone();
                }
            }
        }
        if !self.entry_ok(&conf) {
            conf = self.files.get(&lay().extlinux()).cloned().unwrap_or_default();
        }
        let text = String::from_utf8(conf).unwrap();
        let append = text.lines().find_map(|l| l.trim().strip_prefix("APPEND ")).expect("an entry").to_string();
        let top = append.split_whitespace().next().unwrap().trim_start_matches("init=").trim_end_matches("/init").to_string();
        assert!(self.store.contains(&top), "U-Boot booted {top}, which isn't in the store");
        self.booted = top.clone();
        self.cmdline = append;
        self.links.insert(lay().booted, top.clone());
        self.now += 30_000;
        self.boot_at = self.now;
        self.systems.get(&top).map(|s| s.boots).unwrap_or(false)
    }

    /// Would U-Boot's sysboot load this conf (its kernel and initrd present)?
    fn entry_ok(&self, conf: &[u8]) -> bool {
        let text = String::from_utf8_lossy(conf);
        ["LINUX ", "INITRD "].iter().all(|k| {
            text.lines()
                .find_map(|l| l.trim().strip_prefix(k))
                .is_some_and(|f| self.files.contains_key(&format!("/boot/extlinux/{f}").replace("/extlinux/../", "/")))
        })
    }

    fn player_writes_health(&mut self) {
        let Some(info) = self.systems.get(&self.booted) else { return };
        if !info.healthy {
            return;
        }
        self.ticks += 60;
        let up = self.now.saturating_sub(self.boot_at);
        let h = format!("listening=1\nticks={}\nup_ms={up}\n", self.ticks);
        self.files.insert(lay().health, h.into_bytes());
    }
}

impl Sys for Pi {
    fn read(&self, p: &str) -> Option<Vec<u8>> {
        self.files.get(p).cloned()
    }
    fn read_head(&self, p: &str, n: usize) -> Option<Vec<u8>> {
        self.files.get(p).map(|b| b[..b.len().min(n)].to_vec())
    }
    fn write_atomic(&mut self, p: &str, d: &[u8]) -> Result<(), String> {
        self.tick();
        self.files.insert(p.into(), d.to_vec());
        Ok(())
    }
    fn remove(&mut self, p: &str) {
        if self.files.contains_key(p) || self.links.contains_key(p) {
            self.tick();
        }
        self.files.remove(p);
        self.links.remove(p);
    }
    fn exists(&self, p: &str) -> bool {
        self.files.contains_key(p) || self.links.contains_key(p)
    }
    fn file_len(&self, p: &str) -> Option<u64> {
        self.files.get(p).map(|b| b.len() as u64)
    }
    fn rename(&mut self, a: &str, b: &str) -> Result<(), String> {
        self.tick();
        let v = self.files.remove(a).ok_or("no such file")?;
        self.files.insert(b.into(), v);
        Ok(())
    }
    fn list(&self, dir: &str) -> Vec<String> {
        let pre = format!("{dir}/");
        self.files.keys().filter_map(|k| k.strip_prefix(&pre)).filter(|k| !k.contains('/')).map(String::from).collect()
    }
    fn resolve(&self, p: &str) -> Option<String> {
        if let Some(t) = self.links.get(p) {
            return Some(t.clone());
        }
        if self.store.contains(p) || self.files.contains_key(p) {
            return Some(p.into());
        }
        None
    }
    fn copy_atomic(&mut self, src: &str, dst: &str) -> Result<(), String> {
        if self.files.contains_key(dst) {
            return Ok(());
        }
        let v = self.files.get(src).cloned().ok_or(format!("no {src}"))?;
        self.tick();
        self.files.insert(dst.into(), v);
        Ok(())
    }
    fn download(&mut self, url: &str, dst: &str, size: u64, _abort: &str) -> Result<(), String> {
        let body = self.web.get(url).cloned().ok_or("404")?;
        let have = self.files.get(dst).map(|b| b.len()).unwrap_or(0);
        if have as u64 == size {
            return Ok(());
        }
        let rest = &body[have.min(body.len())..];
        let third = (rest.len() / 3).max(1);
        for (i, chunk) in rest.chunks(third).enumerate() {
            if self.dl_fail > 0 && i == 1 {
                self.dl_fail -= 1;
                return Err("connection reset".into());
            }
            self.tick();
            self.files.entry(dst.into()).or_default().extend_from_slice(chunk);
        }
        Ok(())
    }
    fn sha256_file(&self, p: &str) -> Option<[u8; 32]> {
        self.files.get(p).map(|b| sha256(b))
    }
    fn import(&mut self, img: &str, off: u64) -> Result<(), String> {
        let b = self.files.get(img).cloned().ok_or("no image")?;
        let payload = String::from_utf8(b[off as usize..].to_vec()).map_err(|_| "not a fake payload")?;
        let mut lines = payload.lines();
        if lines.next() != Some("FAKE-EXPORT") {
            return Err("zstd: unknown frame descriptor".into());
        }
        for p in lines {
            if !self.store.contains(p) {
                self.tick();
                self.add_to_store(p);
            }
        }
        Ok(())
    }
    fn invalid_paths(&self, paths: &[String]) -> Result<Vec<String>, String> {
        Ok(paths.iter().filter(|p| !self.store.contains(*p)).cloned().collect())
    }
    fn gc_root(&mut self, link: &str, target: Option<&str>) {
        self.tick();
        match target {
            Some(t) => {
                self.links.insert(link.into(), t.into());
            }
            None => {
                self.links.remove(link);
            }
        }
    }
    fn commit_system(&mut self, top: &str) -> Result<(), String> {
        self.tick();
        self.profile = top.into();
        // switch-to-configuration boot: copy boot files, rewrite extlinux.conf
        // atomically, drop boot files no generation uses.
        for f in [kernel_of(top), initrd_of(top)] {
            let dst = format!("/boot/nixos/{}", extlinux::clean_name(&f));
            let v = self.files.get(&f).cloned().ok_or("kernel missing")?;
            self.tick();
            self.files.insert(dst, v);
        }
        self.tick();
        self.files.insert(lay().extlinux(), extlinux_default(top).into_bytes());
        let keep: BTreeSet<String> = [top, self.booted.as_str()]
            .iter()
            .flat_map(|t| [kernel_of(t), initrd_of(t)])
            .map(|f| format!("/boot/nixos/{}", extlinux::clean_name(&f)))
            .collect();
        let stale: Vec<String> = self.files.keys().filter(|k| k.starts_with("/boot/nixos/") && !keep.contains(*k)).cloned().collect();
        for k in stale {
            self.tick();
            self.files.remove(&k);
        }
        Ok(())
    }
    fn collect_garbage(&mut self) {}
    fn reboot(&mut self) {}
    fn now_ms(&self) -> u64 {
        self.now
    }
    fn sleep_ms(&mut self, ms: u64) {
        self.now += ms;
    }
    fn cmdline(&self) -> String {
        self.cmdline.clone()
    }
    fn has_network(&self) -> bool {
        self.net
    }
    fn hw_board(&self) -> Option<Board> {
        Some(self.board)
    }
    fn system_version(&self, top: &str) -> u32 {
        self.files
            .get(&format!("{top}/etc/splanc-max/version"))
            .and_then(|v| splanc_ota::manifest::parse_version(std::str::from_utf8(v).ok()?))
            .unwrap_or(0)
    }
    fn random_hex(&mut self) -> String {
        format!("{:016x}", self.ops * 7919 + 1)
    }
    fn age_ms(&self, p: &str) -> Option<u64> {
        self.files.get(p).map(|_| 500)
    }
}

// -- signing (the TEST key: firmware/ota/keys/test_max.key, id 3) -----------------------

fn test_key() -> SigningKey {
    let rel = std::env::var("MAX_TEST_KEY").expect("MAX_TEST_KEY");
    let base = std::env::var("RUNFILES_DIR").or_else(|_| std::env::var("TEST_SRCDIR")).unwrap_or_default();
    let path = [format!("{base}/_main/{rel}"), rel.clone()].into_iter().find(|p| std::path::Path::new(p).exists()).expect("key file");
    let text: String = std::fs::read_to_string(path).unwrap().lines().filter(|l| !l.starts_with('#')).collect();
    let b: Vec<u8> = (0..64).step_by(2).map(|i| u8::from_str_radix(&text.trim()[i..i + 2], 16).unwrap()).collect();
    SigningKey::from_slice(&b).unwrap()
}

fn sign(version: u32, image: &[u8], flags: u32) -> Vec<u8> {
    let mut m = Manifest::unsigned(version, image.len() as u32, sha256(image), flags);
    let sig: Signature = test_key().sign(&m.signed_bytes());
    m.signature.copy_from_slice(&sig.to_bytes());
    m.encode().to_vec()
}

fn new_image(version: u32) -> Vec<u8> {
    let mut img = image::encode_header("pi3", version, NEW, &[]);
    img.extend_from_slice(format!("FAKE-EXPORT\n{DEP}\n{NEW}\n").as_bytes());
    img
}

const V_NEW: u32 = 1_010_000;

/// A Pi on the old system, with the new one published (signed, on the "release").
fn setup(new: SysInfo) -> (Pi, Vec<u8>) {
    let mut pi = Pi::new();
    pi.systems.insert(NEW.into(), new);
    let img = new_image(V_NEW);
    pi.web.insert(release_url(Board::Pi3, V_NEW), img.clone());
    let man = sign(V_NEW, &img, board::flags(3, 0, Board::Pi3));
    (pi, man)
}

fn ok_new() -> SysInfo {
    SysInfo { version: V_NEW, boots: true, healthy: true }
}

fn req(man: &[u8]) -> Request {
    Request { manifest: man.to_vec(), ..Default::default() }
}

fn state(pi: &Pi) -> State {
    State::parse(&String::from_utf8_lossy(&pi.files[&lay().state()]))
}

fn ring() -> &'static verify::Ring {
    splanc_max_ota::ring()
}

/// What systemd does at boot and after a request: boot reconcile, then the apply
/// service (resumes a download), then the health service during a trial. Returns
/// once nothing is left to do; reboots (and panicking kernels) loop.
fn run_services(pi: &mut Pi, request: Option<&Request>) {
    let mut pending = request.cloned();
    for _round in 0..20 {
        let mut first = None;
        let mut u = Updater::load(pi, lay(), ring());
        if u.boot() == Next::Reboot {
            drop(u);
            while !pi.power_on() {}
            continue;
        }
        if let Some(r) = pending.take() {
            u.handle_request(&r);
        }
        if u.work() == Next::Reboot {
            drop(u);
            while !pi.power_on() {}
            continue;
        }
        if u.st.phase == Phase::Trial {
            drop(u);
            // Like the health unit: the updater is reloaded (under the lock) every
            // tick; only the trial's first health sample carries over.
            loop {
                pi.player_writes_health();
                let mut u = Updater::load(pi, lay(), ring());
                match u.health_tick(&mut first) {
                    Next::Wait => pi.now += 2_000,
                    Next::Reboot => break,
                    Next::Nothing => return,
                }
            }
            while !pi.power_on() {}
            continue;
        }
        return;
    }
    panic!("the services never settled");
}

// -- scenarios ------------------------------------------------------------------------------

#[test]
fn update_ok() {
    let (mut pi, man) = setup(ok_new());
    run_services(&mut pi, Some(&req(&man)));
    let st = state(&pi);
    assert_eq!(pi.booted, NEW);
    assert_eq!(st.phase, Phase::Idle);
    assert_eq!(st.last_result, "ok", "{st:?}");
    assert_eq!(st.app_version, V_NEW);
    // The new system is the default now; the trial is gone.
    assert!(String::from_utf8_lossy(&pi.files[&lay().extlinux()]).contains(&format!("init={NEW}/init")));
    assert!(!pi.files.contains_key(&lay().trial_conf()));
    assert!(!pi.files.contains_key(&lay().flag()));
    assert!(!pi.cmdline.contains(extlinux::TRIAL_PARAM) || pi.reboots == 2);
    assert!(pi.files.keys().all(|k| !k.starts_with("/var/lib/splanc-ota/dl/")), "download dropped");
}

#[test]
fn bad_signature_is_refused_before_any_download() {
    let (mut pi, mut man) = setup(ok_new());
    man[44 + 7] ^= 1;
    run_services(&mut pi, Some(&req(&man)));
    let st = state(&pi);
    assert_eq!((st.phase, st.error.as_str()), (Phase::Failed, "bad_signature"));
    assert_eq!(pi.booted, OLD);
    assert!(pi.files.keys().all(|k| !k.contains("/dl/")));
}

#[test]
fn refusals() {
    let (pi0, _) = setup(ok_new());
    let img = new_image(V_NEW);
    let cases: Vec<(Vec<u8>, &str)> = vec![
        (sign(V_NEW, &img, board::flags(3, 0, Board::Pi5)), "wrong_board"),
        (sign(V_NEW, &img, keyring::flags(3, 0)), "wrong_board"), // a C6-style manifest (board 0)
        (sign(V_NEW, &img, board::flags(0, 0, Board::Pi3)), "unknown_key"), // the loader ring's id: never trusted
        (sign(1_000_000, &img, board::flags(3, 0, Board::Pi3)), "downgrade"),
        (vec![0; 50], "bad_manifest"),
    ];
    for (man, code) in cases {
        let mut pi = pi0.clone();
        run_services(&mut pi, Some(&req(&man)));
        assert_eq!(state(&pi).error, code);
        assert_eq!(pi.booted, OLD);
    }
    // A Pi 5 has no trial boot yet: refused before anything is fetched.
    let mut pi = pi0.clone();
    pi.board = Board::Pi5;
    run_services(&mut pi, Some(&req(&sign(V_NEW, &img, board::flags(3, 0, Board::Pi5)))));
    assert_eq!(state(&pi).error, "bootloader_unsupported");
    // Nor on a Pi whose U-Boot doesn't know the flag (pi-v1.0.0's).
    let mut pi = pi0.clone();
    pi.files.insert("/boot/firmware/u-boot-rpi3.bin".into(), b"stock u-boot".to_vec());
    run_services(&mut pi, Some(&req(&sign(V_NEW, &img, board::flags(3, 0, Board::Pi3)))));
    assert_eq!(state(&pi).error, "bootloader_unsupported");
    // A source URL that isn't http(s).
    let mut pi = pi0;
    let r = Request { source_url: "file:///etc/shadow".into(), ..req(&sign(V_NEW, &img, board::flags(3, 0, Board::Pi3))) };
    run_services(&mut pi, Some(&r));
    assert_eq!(state(&pi).error, "bad_url");
}

#[test]
fn security_floor_and_downgrade_flag() {
    let (mut pi, _) = setup(ok_new());
    let img = new_image(V_NEW);
    pi.web.insert(release_url(Board::Pi3, V_NEW), img.clone());
    // Security version 2 installs and raises the floor...
    run_services(&mut pi, Some(&req(&sign(V_NEW, &img, board::flags(3, 2, Board::Pi3)))));
    assert_eq!(state(&pi).last_result, "ok");
    assert_eq!(state(&pi).keys.security_floor, 2);
    // ...so an older-security image is refused even with allow_downgrade.
    let old_img = new_image(1_009_500);
    let r = Request { allow_downgrade: true, ..req(&sign(1_009_500, &old_img, board::flags(3, 1, Board::Pi3))) };
    run_services(&mut pi, Some(&r));
    assert_eq!(state(&pi).error, "security_floor");
}

#[test]
fn unhealthy_trial_rolls_back() {
    let (mut pi, man) = setup(SysInfo { version: V_NEW, boots: true, healthy: false });
    run_services(&mut pi, Some(&req(&man)));
    let st = state(&pi);
    assert_eq!(pi.booted, OLD, "back on the old system");
    assert_eq!(st.last_result, "rolled_back");
    assert!(st.error.starts_with("unhealthy"), "{}", st.error);
    assert_eq!(st.app_version, 1_009_000);
    assert!(String::from_utf8_lossy(&pi.files[&lay().extlinux()]).contains(&format!("init={OLD}/init")));
    assert!(!pi.files.contains_key(&lay().trial_conf()));
}

#[test]
fn trial_kernel_panic_rolls_back() {
    let (mut pi, man) = setup(SysInfo { version: V_NEW, boots: false, healthy: false });
    run_services(&mut pi, Some(&req(&man)));
    let st = state(&pi);
    assert_eq!(pi.booted, OLD);
    assert_eq!((st.last_result.as_str(), st.error.as_str()), ("rolled_back", "trial_failed"));
}

#[test]
fn no_network_on_the_new_system_rolls_back() {
    let (mut pi, man) = setup(ok_new());
    // Staged with a network; the trial boots without one.
    let mut u = Updater::load(&mut pi, lay(), ring());
    u.handle_request(&req(&man));
    assert_eq!(u.work(), Next::Reboot);
    drop(u);
    assert!(pi.power_on());
    pi.net = false;
    run_services(&mut pi, None);
    pi.net = true;
    let st = state(&pi);
    assert_eq!(pi.booted, OLD);
    assert_eq!(st.error, "unhealthy: no network");
}

#[test]
fn download_resumes_after_network_errors() {
    let (mut pi, man) = setup(ok_new());
    pi.dl_fail = 2;
    run_services(&mut pi, Some(&req(&man)));
    assert_eq!(state(&pi).last_result, "ok");
}

#[test]
fn delta_needs_its_base() {
    let (mut pi, _) = setup(ok_new());
    let base = vec!["/nix/store/dddddddddddddddddddddddddddddddd-glibc".to_string()];
    let mut img = image::encode_header("pi3", V_NEW, NEW, &base);
    img.extend_from_slice(format!("FAKE-EXPORT\n{DEP}\n{NEW}\n").as_bytes());
    pi.web.insert("http://lan/delta".into(), img.clone());
    let r = Request { source_url: "http://lan/delta".into(), ..req(&sign(V_NEW, &img, board::flags(3, 0, Board::Pi3))) };
    run_services(&mut pi, Some(&r));
    assert_eq!(state(&pi).error, "missing_base");
    // With the base present, the same delta installs.
    pi.store.insert(base[0].clone());
    run_services(&mut pi, Some(&r));
    assert_eq!(state(&pi).last_result, "ok");
    assert_eq!(pi.booted, NEW);
}

#[test]
fn tampered_image_is_refused() {
    let (mut pi, man) = setup(ok_new());
    let url = release_url(Board::Pi3, V_NEW);
    pi.web.get_mut(&url).unwrap()[30] ^= 1;
    run_services(&mut pi, Some(&req(&man)));
    let st = state(&pi);
    assert_eq!(st.error, "verify_failed");
    assert!(!pi.store.contains(NEW), "nothing imported");
}

#[test]
fn key_epoch_revokes_a_key() {
    // A record signed by key 3 can't revoke key 3 (its own signer): refused, and the
    // update with it is refused too — a bad epoch must never be ignored silently.
    let (mut pi, man) = setup(ok_new());
    let mut rec = keyring::EpochRecord { epoch: 1, revoked: 1 << 3, signer: 3, signature: [0; 64] };
    let sig: Signature = test_key().sign(&rec.signed_bytes());
    rec.signature.copy_from_slice(&sig.to_bytes());
    let r = Request { key_epoch: rec.encode().to_vec(), ..req(&man) };
    run_services(&mut pi, Some(&r));
    assert_eq!(state(&pi).error, "bad_revocation");
    // An epoch that revokes nothing new is applied and the update proceeds.
    let mut rec = keyring::EpochRecord { epoch: 1, revoked: 1 << 5, signer: 3, signature: [0; 64] };
    let sig: Signature = test_key().sign(&rec.signed_bytes());
    rec.signature.copy_from_slice(&sig.to_bytes());
    let r = Request { key_epoch: rec.encode().to_vec(), ..req(&man) };
    run_services(&mut pi, Some(&r));
    let st = state(&pi);
    assert_eq!((st.last_result.as_str(), st.keys.epoch, st.keys.revoked), ("ok", 1, 1 << 5));
}

#[test]
fn a_c6_key_epoch_is_ignored() {
    // The C6's key-epoch.bin (signed by its backup key, id 1) isn't for the MAX ring:
    // ignored, the update proceeds and the MAX key state is unchanged.
    let (mut pi, man) = setup(ok_new());
    let mut rec = keyring::EpochRecord { epoch: 9, revoked: 1, signer: 1, signature: [0; 64] };
    let sig: Signature = test_key().sign(&rec.signed_bytes());
    rec.signature.copy_from_slice(&sig.to_bytes());
    let r = Request { key_epoch: rec.encode().to_vec(), ..req(&man) };
    run_services(&mut pi, Some(&r));
    let st = state(&pi);
    assert_eq!((st.last_result.as_str(), st.keys.epoch, st.keys.revoked), ("ok", 0, 0));
}

/// The power-cut sweep: cut at EVERY mutating step of a whole update (request to
/// commit), then power on and let the services run. Whatever the cut point, the Pi
/// boots a complete system, never a half-written one, and converges: on the new
/// system with it committed, or on the old one with extlinux.conf still naming it.
#[test]
fn power_cut_at_every_step_recovers() {
    let (base, man) = setup(ok_new());
    // Count the steps of an uninterrupted run.
    let mut clean = base.clone();
    let start = clean.ops;
    run_services(&mut clean, Some(&req(&man)));
    let steps = clean.ops - start;
    assert!(steps > 15, "only {steps} steps?");
    let mut outcomes: BTreeMap<String, u32> = BTreeMap::new();
    for cut in 1..=steps {
        let mut pi = base.clone();
        pi.cut_at = Some(pi.ops + cut);
        let r = catch_unwind(AssertUnwindSafe(|| run_services(&mut pi, Some(&req(&man)))));
        let cut_hit = match &r {
            Err(e) => e.downcast_ref::<String>().is_some_and(|s| s == CUT) || e.downcast_ref::<&str>() == Some(&CUT),
            Ok(()) => false,
        };
        assert!(cut_hit || r.is_ok(), "cut {cut}: unexpected panic");
        pi.cut_at = None;
        // Power returns. (The client that asked may retry; here nobody does.)
        while !pi.power_on() {}
        run_services(&mut pi, None);
        let st = state(&pi);
        let conf = String::from_utf8_lossy(&pi.files[&lay().extlinux()]).into_owned();
        assert!(pi.booted == OLD || pi.booted == NEW, "cut {cut}: booted {}", pi.booted);
        if pi.booted == NEW {
            assert_eq!(st.last_result, "ok", "cut {cut}: on the new system but {st:?}");
            assert!(conf.contains(&format!("init={NEW}/init")), "cut {cut}: new system not the default");
        } else {
            assert!(conf.contains(&format!("init={OLD}/init")), "cut {cut}: old system no longer the default");
            assert!(!st.phase.busy() || st.phase == Phase::Downloading, "cut {cut}: stuck in {:?}", st.phase);
        }
        *outcomes.entry(format!("{}:{}", if pi.booted == NEW { "new" } else { "old" }, st.last_result)).or_default() += 1;
        // A retry from the client always gets it to the new system.
        if pi.booted == OLD {
            run_services(&mut pi, Some(&req(&man)));
            assert_eq!((pi.booted.as_str(), state(&pi).last_result.as_str()), (NEW, "ok"), "cut {cut}: retry");
        }
    }
    eprintln!("power-cut outcomes over {steps} cut points: {outcomes:?}");
}
