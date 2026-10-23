//! The on-Pi updater's state machine (docs/design/max-ota.md "Flow" and "Power
//! loss"), over the [`Sys`] seam so every step and every cut point is host-tested
//! against a simulated Pi (tests/updater.rs) with a model of the U-Boot one-shot.
//!
//! ```text
//! request ──► Downloading ──► Importing ──► Staged ──reboot──► Trial ──healthy──► Committing ──► Idle "ok"
//!    │             │               │           │                 │
//!    └─refused─► Failed            └─► Failed  └─(trial never     └─deadline / reset / power cut
//!                                               came up)              ──► the old system, "rolled_back"
//! ```
//!
//! Invariant: until the new system has proven healthy, `extlinux.conf` (what
//! U-Boot boots by default, after any reset or power cut) still names the old
//! system. The new one is booted exactly once, through a one-shot flag U-Boot
//! clears *before* it loads the new kernel.

use splanc_ota::keyring;
use splanc_ota::manifest::Manifest;

use crate::board::{Board, TrialBoot};
use crate::extlinux::{self, BootFiles};
use crate::health::{self, Sample, Verdict};
use crate::image;
use crate::state::{url_ok, Phase, Request, State};
use crate::verify::{self, Device, Ring};

/// Everything the updater does to the machine. The Linux implementation is
/// [`crate::linux::LinuxSys`]; tests use a simulated Pi.
pub trait Sys {
    fn read(&self, path: &str) -> Option<Vec<u8>>;
    /// At most `n` bytes from the start of the file.
    fn read_head(&self, path: &str, n: usize) -> Option<Vec<u8>>;
    /// Temp file, fsync, rename, fsync the directory.
    fn write_atomic(&mut self, path: &str, data: &[u8]) -> Result<(), String>;
    fn remove(&mut self, path: &str);
    fn exists(&self, path: &str) -> bool;
    fn file_len(&self, path: &str) -> Option<u64>;
    fn rename(&mut self, from: &str, to: &str) -> Result<(), String>;
    /// Every file in `dir` (names only).
    fn list(&self, dir: &str) -> Vec<String>;
    /// `readlink -f`.
    fn resolve(&self, path: &str) -> Option<String>;
    /// Copy a store file or directory to `dst` atomically (copy to a temp name,
    /// then rename), unless `dst` already exists.
    fn copy_atomic(&mut self, src: &str, dst: &str) -> Result<(), String>;
    /// Fetch `url` into `dst`, resuming from its current length. Gives up early
    /// (Err("aborted")) when `abort` appears.
    fn download(&mut self, url: &str, dst: &str, size: u64, abort: &str) -> Result<(), String>;
    fn sha256_file(&self, path: &str) -> Option<[u8; 32]>;
    /// `zstd -dc < image[offset..] | nix-store --import`.
    fn import(&mut self, image: &str, offset: u64) -> Result<(), String>;
    /// The store paths among `paths` that are NOT valid.
    fn invalid_paths(&self, paths: &[String]) -> Result<Vec<String>, String>;
    /// Point a GC root (a symlink under /nix/var/nix/gcroots) at `target`, or
    /// remove it (`None`).
    fn gc_root(&mut self, link: &str, target: Option<&str>);
    /// Make `toplevel` the default: `nix-env -p …/system --set` +
    /// `switch-to-configuration boot` (regenerates extlinux.conf).
    fn commit_system(&mut self, toplevel: &str) -> Result<(), String>;
    /// Drop generations older than the previous one and collect garbage.
    fn collect_garbage(&mut self);
    fn reboot(&mut self);
    /// Milliseconds since boot (CLOCK_BOOTTIME: no RTC on a Pi, and NTP moves the
    /// wall clock after boot).
    fn now_ms(&self) -> u64;
    fn sleep_ms(&mut self, ms: u64);
    fn cmdline(&self) -> String;
    fn has_network(&self) -> bool;
    /// The hardware (from /proc/device-tree/model).
    fn hw_board(&self) -> Option<Board>;
    /// Manifest version of a system (`<toplevel>/etc/splanc-max/version`).
    fn system_version(&self, toplevel: &str) -> u32;
    fn random_hex(&mut self) -> String;
    /// Age of a file in ms (for the player's health file).
    fn age_ms(&self, path: &str) -> Option<u64>;
}

/// Where things live on the Pi.
#[derive(Clone, Debug)]
pub struct Layout {
    pub state_dir: String,
    /// Holds extlinux/ and nixos/ (on the root filesystem).
    pub boot_dir: String,
    /// The FAT firmware partition (holds config.txt, u-boot, the one-shot flag).
    pub fw_dir: String,
    pub booted: String,
    pub health: String,
    pub gcroot: String,
}

impl Default for Layout {
    fn default() -> Self {
        Layout {
            state_dir: "/var/lib/splanc-ota".into(),
            boot_dir: "/boot".into(),
            fw_dir: "/boot/firmware".into(),
            booted: "/run/booted-system".into(),
            health: "/run/ledmapper/health".into(),
            gcroot: "/nix/var/nix/gcroots/splanc-ota-trial".into(),
        }
    }
}

impl Layout {
    pub fn state(&self) -> String {
        format!("{}/state", self.state_dir)
    }
    pub fn request(&self) -> String {
        format!("{}/inbox/request", self.state_dir)
    }
    pub fn abort(&self) -> String {
        format!("{}/inbox/abort", self.state_dir)
    }
    pub fn dl_dir(&self) -> String {
        format!("{}/dl", self.state_dir)
    }
    pub fn part(&self, sha: &str) -> String {
        format!("{}/dl/{sha}.part", self.state_dir)
    }
    pub fn image(&self, sha: &str) -> String {
        format!("{}/dl/{sha}.img", self.state_dir)
    }
    pub fn extlinux(&self) -> String {
        format!("{}/extlinux/extlinux.conf", self.boot_dir)
    }
    pub fn trial_conf(&self) -> String {
        format!("{}/extlinux/splanc-trial.conf", self.boot_dir)
    }
    /// The one-shot flag U-Boot reads and clears (first byte '1' -> '0').
    pub fn flag(&self) -> String {
        format!("{}/splanc-trial", self.fw_dir)
    }
}

/// The release asset a version's image is fetched from (no `source_url`).
pub fn release_url(board: Board, version: u32) -> String {
    let v = format!("{}.{}.{}", version / 1_000_000, version / 1_000 % 1_000, version % 1_000);
    format!("https://github.com/fughilli/splanc/releases/download/firmware-v{v}/max-{}-{v}.nixclosure", board.name())
}

/// What the caller should do next.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Next {
    Nothing,
    /// The trial is staged (or the commit needs the new default booted): reboot.
    Reboot,
    /// The trial needs more health samples.
    Wait,
}

/// The string U-Boot's trial-capable bootcmd carries (pi/provisioning/nix/ota.nix);
/// a bootloader without it would silently ignore the flag.
pub const UBOOT_MARKER: &[u8] = b"splanc-trial";

pub struct Updater<'a, S: Sys> {
    pub sys: &'a mut S,
    pub lay: Layout,
    pub ring: &'static Ring,
    pub st: State,
}

impl<'a, S: Sys> Updater<'a, S> {
    pub fn load(sys: &'a mut S, lay: Layout, ring: &'static Ring) -> Self {
        let st = sys.read(&lay.state()).map(|b| State::parse(&String::from_utf8_lossy(&b))).unwrap_or_default();
        Updater { sys, lay, ring, st }
    }

    pub fn save(&mut self) {
        let text = self.st.encode();
        if let Err(e) = self.sys.write_atomic(&self.lay.state(), text.as_bytes()) {
            eprintln!("splanc-max-ota: can't persist the state: {e}");
        }
    }

    fn log(&self, msg: &str) {
        eprintln!("splanc-max-ota: [{}] {msg}", self.st.phase.name());
    }

    fn fail(&mut self, code: &str) {
        self.log(&format!("failed: {code}"));
        self.st.phase = Phase::Failed;
        self.st.error = code.to_string();
        self.save();
    }

    fn device(&self) -> Option<Device> {
        Some(Device { board: self.sys.hw_board()?, keys: self.st.keys, app_version: self.st.app_version })
    }

    /// Does the bootloader on the firmware partition honour the one-shot flag?
    pub fn bootloader_ok(&self) -> bool {
        let Some(board) = self.sys.hw_board() else {
            return false;
        };
        if board.trial_boot() != TrialBoot::UBoot {
            return false;
        }
        self.sys.list(&self.lay.fw_dir).iter().filter(|n| n.starts_with("u-boot") && n.ends_with(".bin")).any(|n| {
            self.sys
                .read(&format!("{}/{n}", self.lay.fw_dir))
                .is_some_and(|b| b.windows(UBOOT_MARKER.len()).any(|w| w == UBOOT_MARKER))
        })
    }

    // -- a request from the player (ota_begin) ---------------------------------------

    pub fn handle_request(&mut self, req: &Request) {
        let Some(mut dev) = self.device() else {
            return self.fail("wrong_board");
        };
        if !req.source_url.is_empty() && !url_ok(&req.source_url) {
            return self.fail("bad_url");
        }
        let same = self.st.manifest.as_ref().is_some_and(|m| m.as_slice() == req.manifest.as_slice());
        if self.st.phase.busy() {
            if same {
                self.log("already updating to this image");
                return;
            }
            if self.st.phase != Phase::Downloading {
                self.log("busy: a different update is past its download; request ignored");
                return;
            }
        }
        if !req.key_epoch.is_empty() {
            match verify::apply_epoch(&self.st.keys, &req.key_epoch, self.ring) {
                Ok(k) => {
                    self.st.keys = k;
                    dev.keys = k;
                }
                Err(e) => return self.fail(e.code()),
            }
        }
        let m = match verify::check_offer(&req.manifest, req.allow_downgrade, &dev, self.ring) {
            Ok(m) => m,
            Err(e) => return self.fail(e.code()),
        };
        if !self.bootloader_ok() {
            return self.fail("bootloader_unsupported");
        }
        // A new image: drop any other download, keep a resumable one of this image.
        let sha = crate::kv::hex(&m.sha256);
        for name in self.sys.list(&self.lay.dl_dir()) {
            if !name.starts_with(&sha) {
                let p = format!("{}/{name}", self.lay.dl_dir());
                self.sys.remove(&p);
            }
        }
        self.st.phase = Phase::Downloading;
        self.st.manifest = Some(m.encode());
        self.st.source_url = req.source_url.clone();
        self.st.error.clear();
        self.st.last_result.clear();
        self.st.toplevel.clear();
        self.save();
        self.log(&format!("accepted version {} ({} bytes)", m.version, m.size));
    }

    fn abort_requested(&mut self) -> bool {
        let p = self.lay.abort();
        if self.sys.exists(&p) {
            self.sys.remove(&p);
            return true;
        }
        false
    }

    /// Download -> verify -> import -> stage, as far as it goes. `Reboot` once staged.
    pub fn work(&mut self) -> Next {
        loop {
            if matches!(self.st.phase, Phase::Downloading | Phase::Importing) && self.abort_requested() {
                self.log("aborted");
                self.drop_download();
                self.st.phase = Phase::Idle;
                self.st.last_result = "aborted".into();
                self.save();
                return Next::Nothing;
            }
            match self.st.phase {
                Phase::Downloading => self.download_step(),
                Phase::Importing => self.import_step(),
                Phase::Staged => return Next::Reboot,
                _ => return Next::Nothing,
            }
        }
    }

    fn drop_download(&mut self) {
        let sha = self.st.sha_hex();
        if !sha.is_empty() {
            let (p, i) = (self.lay.part(&sha), self.lay.image(&sha));
            self.sys.remove(&p);
            self.sys.remove(&i);
        }
    }

    fn download_step(&mut self) {
        let Some(m) = self.st.manifest() else {
            return self.fail("no_session");
        };
        let Some(board) = self.sys.hw_board() else {
            return self.fail("wrong_board");
        };
        let sha = crate::kv::hex(&m.sha256);
        let (part, img) = (self.lay.part(&sha), self.lay.image(&sha));
        if !self.sys.exists(&img) {
            let url = if self.st.source_url.is_empty() { release_url(board, m.version) } else { self.st.source_url.clone() };
            let mut last = String::new();
            let mut ok = false;
            for attempt in 0..5u32 {
                if self.sys.file_len(&part).unwrap_or(0) > m.size as u64 {
                    self.sys.remove(&part);
                }
                match self.sys.download(&url, &part, m.size as u64, &self.lay.abort()) {
                    Ok(()) => {
                        ok = true;
                        break;
                    }
                    Err(e) if e == "aborted" => return, // work() sees the abort file next
                    Err(e) => {
                        self.log(&format!("download attempt {}: {e}", attempt + 1));
                        last = e;
                        self.sys.sleep_ms(2_000 << attempt);
                    }
                }
            }
            if !ok {
                return self.fail(&format!("download_failed: {last}"));
            }
            if self.sys.file_len(&part) != Some(m.size as u64) {
                self.sys.remove(&part);
                return self.fail("verify_failed");
            }
            if self.sys.sha256_file(&part) != Some(m.sha256) {
                self.sys.remove(&part);
                return self.fail("verify_failed");
            }
            if let Err(e) = self.sys.rename(&part, &img) {
                return self.fail(&format!("flash_error: {e}"));
            }
        }
        self.st.phase = Phase::Importing;
        self.save();
    }

    fn boot_files(&self, top: &str) -> Option<BootFiles> {
        let kernel = self.sys.resolve(&format!("{top}/kernel"))?;
        let initrd = self.sys.resolve(&format!("{top}/initrd"))?;
        let dtbs = self.sys.resolve(&format!("{top}/dtbs"));
        let params = String::from_utf8_lossy(&self.sys.read(&format!("{top}/kernel-params")).unwrap_or_default()).into_owned();
        if !self.sys.exists(&format!("{top}/init")) {
            return None;
        }
        Some(BootFiles { kernel, initrd, dtbs, params })
    }

    fn import_step(&mut self) {
        let Some(m) = self.st.manifest() else {
            return self.fail("no_session");
        };
        let board = self.sys.hw_board();
        let img = self.lay.image(&crate::kv::hex(&m.sha256));
        let Some(head) = self.sys.read_head(&img, image::MAX_HEADER) else {
            self.st.phase = Phase::Downloading; // the image went missing: fetch it again
            return self.save();
        };
        let h = match image::parse_header(&head) {
            Ok(h) => h,
            Err(e) => return self.fail(&format!("bad_image: {e}")),
        };
        if Some(h.board.as_str()) != board.map(|b| b.name()) || h.version != m.version {
            return self.fail("bad_image: header doesn't match the manifest");
        }
        match self.sys.invalid_paths(&h.base) {
            Ok(missing) if missing.is_empty() => {}
            Ok(_) => return self.fail("missing_base"),
            Err(e) => return self.fail(&format!("import_failed: {e}")),
        }
        if let Err(e) = self.sys.import(&img, h.len as u64) {
            return self.fail(&format!("import_failed: {e}"));
        }
        if !matches!(self.sys.invalid_paths(std::slice::from_ref(&h.toplevel)), Ok(v) if v.is_empty()) {
            return self.fail("import_failed: the system isn't in the store");
        }
        self.sys.gc_root(&self.lay.gcroot.clone(), Some(&h.toplevel));
        let Some(files) = self.boot_files(&h.toplevel) else {
            return self.fail("bad_image: no kernel/initrd/init");
        };
        let conf = String::from_utf8_lossy(&self.sys.read(&self.lay.extlinux()).unwrap_or_default()).into_owned();
        let fdt = extlinux::uses_fdt(&conf);
        for (src, name) in extlinux::boot_copies(&files, fdt) {
            let dst = format!("{}/nixos/{name}", self.lay.boot_dir);
            if let Err(e) = self.sys.copy_atomic(&src, &dst) {
                return self.fail(&format!("flash_error: {e}"));
            }
        }
        let label = format!("{}.{}.{}", m.version / 1_000_000, m.version / 1_000 % 1_000, m.version % 1_000);
        let trial = extlinux::trial_conf(&h.toplevel, &files, fdt, &label);
        if let Err(e) = self.sys.write_atomic(&self.lay.trial_conf(), trial.as_bytes()) {
            return self.fail(&format!("flash_error: {e}"));
        }
        self.st.toplevel = h.toplevel.clone();
        self.st.prev_toplevel = self.sys.resolve(&self.lay.booted).unwrap_or_default();
        self.st.nonce = self.sys.random_hex();
        self.st.net = self.sys.has_network();
        self.st.phase = Phase::Staged;
        self.st.last_result = "installed".into();
        self.save();
        // Last: arm the one-shot. Until this write lands, a reset boots the old system
        // and the boot reconcile re-stages (no flag with our nonce).
        let flag = format!("1 {}\n", self.st.nonce);
        if let Err(e) = self.sys.write_atomic(&self.lay.flag(), flag.as_bytes()) {
            self.cleanup_trial();
            return self.fail(&format!("flash_error: {e}"));
        }
        self.log(&format!("staged {} (trial entry + one-shot flag)", h.toplevel));
    }

    /// What the one-shot flag says now: Some(true) = armed with our nonce,
    /// Some(false) = consumed by U-Boot (our nonce), None = not ours / absent.
    fn flag_state(&self) -> Option<bool> {
        let b = self.sys.read(&self.lay.flag())?;
        let text = String::from_utf8_lossy(&b);
        let (head, nonce) = text.trim().split_once(' ')?;
        if self.st.nonce.is_empty() || nonce != self.st.nonce {
            return None;
        }
        match head {
            "1" => Some(true),
            "0" => Some(false),
            _ => None,
        }
    }

    fn cleanup_trial(&mut self) {
        let (conf, flag, root) = (self.lay.trial_conf(), self.lay.flag(), self.lay.gcroot.clone());
        self.sys.remove(&conf);
        self.sys.remove(&flag);
        self.sys.gc_root(&root, None);
    }

    fn rolled_back(&mut self, why: &str) {
        self.log(&format!("rolled back: {why}"));
        self.cleanup_trial();
        self.drop_download();
        self.st.phase = Phase::Idle;
        self.st.last_result = "rolled_back".into();
        self.st.error = why.to_string();
        self.st.toplevel.clear();
        self.save();
    }

    // -- every boot ---------------------------------------------------------------------

    /// Reconcile the state with what actually booted. Runs early in every boot,
    /// before the player starts.
    pub fn boot(&mut self) -> Next {
        let booted = self.sys.resolve(&self.lay.booted).unwrap_or_default();
        let trial_boot = self.sys.cmdline().split_whitespace().any(|w| w == extlinux::TRIAL_PARAM);
        self.st.app_version = self.sys.system_version(&booted);
        let on_new = !self.st.toplevel.is_empty() && booted == self.st.toplevel;
        let next = match self.st.phase {
            Phase::Staged if on_new && trial_boot => {
                self.st.phase = Phase::Trial;
                self.st.trial_started_ms = self.sys.now_ms();
                // U-Boot cleared the flag before loading this kernel; clear it here
                // too, so a bootloader whose write failed can't boot the trial twice.
                let consumed = format!("0 {}\n", self.st.nonce);
                let _ = self.sys.write_atomic(&self.lay.flag(), consumed.as_bytes());
                self.log(&format!("trial boot of {booted}"));
                Next::Nothing
            }
            Phase::Trial if on_new && trial_boot => {
                // A second trial boot: the one-shot didn't hold. Fall back for good.
                self.rolled_back("trial_repeated");
                Next::Reboot
            }
            Phase::Staged | Phase::Trial if on_new => {
                // The new system booted as the DEFAULT: the commit got as far as
                // switch-to-configuration before a reset. Finish it.
                self.finish_commit(&booted)
            }
            Phase::Staged => match self.flag_state() {
                // U-Boot consumed the flag and booted the trial, which never reached
                // this point (kernel panic, watchdog, power cut): the old system is back.
                Some(false) => {
                    self.rolled_back("trial_failed");
                    Next::Nothing
                }
                Some(true) => {
                    self.cleanup_trial();
                    self.fail("bootloader_unsupported");
                    Next::Nothing
                }
                // Cut before the flag was armed: stage it again (the import is idempotent).
                None => {
                    self.log("staging was interrupted; staging again");
                    self.st.phase = Phase::Importing;
                    Next::Nothing
                }
            },
            Phase::Trial => {
                self.rolled_back("trial_reset");
                Next::Nothing
            }
            Phase::Committing => self.finish_commit(&booted),
            _ => Next::Nothing,
        };
        self.save();
        next
    }

    fn finish_commit(&mut self, booted: &str) -> Next {
        let top = self.st.toplevel.clone();
        if let Err(e) = self.sys.commit_system(&top) {
            // Never loop: drop the update, stay on what booted.
            self.cleanup_trial();
            self.st.phase = Phase::Idle;
            self.st.last_result = "rolled_back".into();
            self.st.error = format!("commit_failed: {e}");
            self.st.toplevel.clear();
            return Next::Nothing;
        }
        self.committed();
        if booted != top {
            Next::Reboot // the default is the new system now; boot it
        } else {
            Next::Nothing
        }
    }

    fn committed(&mut self) {
        let m: Option<Manifest> = self.st.manifest();
        self.cleanup_trial();
        self.drop_download();
        if let Some(m) = m {
            self.st.keys = keyring::raise_floor(&self.st.keys, &m);
            self.st.app_version = m.version;
        }
        self.st.phase = Phase::Idle;
        self.st.last_result = "ok".into();
        self.st.error.clear();
        self.save();
        self.log(&format!("committed {}", self.st.toplevel));
        self.sys.collect_garbage();
    }

    // -- the trial's health check ------------------------------------------------------

    /// One health tick during the trial. `Wait` = call again in a couple of seconds.
    /// `first` is the trial's first fresh health sample: the caller keeps it across
    /// ticks (it reloads the updater, under the lock, every tick).
    pub fn health_tick(&mut self, first: &mut Option<Sample>) -> Next {
        if self.st.phase != Phase::Trial {
            return Next::Nothing;
        }
        let now = self.sys.now_ms();
        let sample = self.sys.read(&self.lay.health).map(|b| {
            let age = self.sys.age_ms(&self.lay.health).unwrap_or(u64::MAX);
            Sample::parse(&String::from_utf8_lossy(&b), now, age)
        });
        if let Some(s) = &sample {
            if first.is_none() && s.listening && s.age_ms <= health::STALE_MS {
                *first = Some(*s);
            }
        }
        match health::verdict(first.as_ref(), sample.as_ref(), self.st.net, self.sys.has_network()) {
            Verdict::Healthy => {
                self.st.phase = Phase::Committing;
                self.save();
                let top = self.st.toplevel.clone();
                match self.sys.commit_system(&top) {
                    Ok(()) => {
                        self.committed();
                        Next::Nothing
                    }
                    Err(e) => {
                        self.rolled_back(&format!("commit_failed: {e}"));
                        Next::Reboot
                    }
                }
            }
            Verdict::NotYet(why) => {
                if now.saturating_sub(self.st.trial_started_ms) > health::DEADLINE_MS {
                    self.rolled_back(&format!("unhealthy: {why}"));
                    return Next::Reboot;
                }
                Next::Wait
            }
        }
    }
}
