//! The real [`Sys`] on a Splanc MAX (NixOS on a Raspberry Pi). Tools come from
//! the unit's PATH (pi/provisioning/nix/ota.nix): curl, zstd, nix.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::unix::fs::symlink;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, SystemTime};

use splanc_ota::sha256::Sha256;

use crate::board::Board;
use crate::updater::Sys;

pub struct LinuxSys;

fn dir_of(p: &str) -> &str {
    Path::new(p).parent().and_then(|d| d.to_str()).unwrap_or("/")
}

fn fsync_dir(dir: &str) {
    if let Ok(d) = File::open(dir) {
        let _ = d.sync_all();
    }
}

fn run(cmd: &mut Command) -> Result<String, String> {
    let out = cmd.stdin(Stdio::null()).output().map_err(|e| format!("{:?}: {e}", cmd.get_program()))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let err = String::from_utf8_lossy(&out.stderr);
        Err(format!("{:?} exited {}: {}", cmd.get_program(), out.status, err.trim().lines().last().unwrap_or("")))
    }
}

impl Sys for LinuxSys {
    fn read(&self, path: &str) -> Option<Vec<u8>> {
        fs::read(path).ok()
    }

    fn read_head(&self, path: &str, n: usize) -> Option<Vec<u8>> {
        let mut f = File::open(path).ok()?;
        let mut buf = Vec::new();
        Read::take(&mut f, n as u64).read_to_end(&mut buf).ok()?;
        Some(buf)
    }

    fn write_atomic(&mut self, path: &str, data: &[u8]) -> Result<(), String> {
        let dir = dir_of(path);
        fs::create_dir_all(dir).map_err(|e| format!("{dir}: {e}"))?;
        let tmp = format!("{path}.tmp.{}", std::process::id());
        let mut f = File::create(&tmp).map_err(|e| format!("{tmp}: {e}"))?;
        f.write_all(data).and_then(|_| f.sync_all()).map_err(|e| format!("{tmp}: {e}"))?;
        drop(f);
        fs::rename(&tmp, path).map_err(|e| format!("{path}: {e}"))?;
        fsync_dir(dir);
        Ok(())
    }

    fn remove(&mut self, path: &str) {
        let p = Path::new(path);
        if p.is_dir() && !p.is_symlink() {
            let _ = fs::remove_dir_all(p);
        } else {
            let _ = fs::remove_file(p);
        }
        fsync_dir(dir_of(path));
    }

    fn exists(&self, path: &str) -> bool {
        Path::new(path).exists()
    }

    fn file_len(&self, path: &str) -> Option<u64> {
        fs::metadata(path).ok().map(|m| m.len())
    }

    fn rename(&mut self, from: &str, to: &str) -> Result<(), String> {
        fs::rename(from, to).map_err(|e| format!("{to}: {e}"))?;
        fsync_dir(dir_of(to));
        Ok(())
    }

    fn list(&self, dir: &str) -> Vec<String> {
        fs::read_dir(dir)
            .map(|rd| rd.filter_map(|e| e.ok()?.file_name().into_string().ok()).collect())
            .unwrap_or_default()
    }

    fn resolve(&self, path: &str) -> Option<String> {
        fs::canonicalize(path).ok()?.to_str().map(String::from)
    }

    fn copy_atomic(&mut self, src: &str, dst: &str) -> Result<(), String> {
        if Path::new(dst).exists() {
            return Ok(());
        }
        let tmp = format!("{dst}.tmp.{}", std::process::id());
        let _ = fs::remove_dir_all(&tmp);
        let _ = fs::remove_file(&tmp);
        fs::create_dir_all(dir_of(dst)).map_err(|e| e.to_string())?;
        // cp -r: a kernel/initrd file or a dtbs directory; then flush it all.
        run(Command::new("cp").args(["-rL", src, &tmp]))?;
        run(Command::new("sync").arg("-f").arg(&tmp)).ok();
        fs::rename(&tmp, dst).map_err(|e| format!("{dst}: {e}"))?;
        fsync_dir(dir_of(dst));
        Ok(())
    }

    fn download(&mut self, url: &str, dst: &str, size: u64, abort: &str) -> Result<(), String> {
        fs::create_dir_all(dir_of(dst)).map_err(|e| e.to_string())?;
        if self.file_len(dst) == Some(size) {
            return Ok(());
        }
        let resume = self.file_len(dst).unwrap_or(0) > 0;
        let mut cmd = Command::new("curl");
        cmd.args(["-fsSL", "--connect-timeout", "20", "--speed-limit", "1024", "--speed-time", "60"]);
        if resume {
            cmd.args(["-C", "-"]);
        }
        cmd.args(["-o", dst, url]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| format!("curl: {e}"))?;
        loop {
            if let Some(st) = child.try_wait().map_err(|e| e.to_string())? {
                // Flush what arrived, so a power cut keeps it for the resume.
                if let Ok(f) = OpenOptions::new().append(true).open(dst) {
                    let _ = f.sync_all();
                }
                if st.success() {
                    return Ok(());
                }
                let mut err = String::new();
                if let Some(mut e) = child.stderr.take() {
                    let _ = e.read_to_string(&mut err);
                }
                // 33: the server can't resume (no ranges) — start over next attempt.
                if st.code() == Some(33) {
                    let _ = fs::remove_file(dst);
                }
                return Err(format!("curl exit {}: {}", st.code().unwrap_or(-1), err.trim()));
            }
            if Path::new(abort).exists() {
                let _ = child.kill();
                let _ = child.wait();
                return Err("aborted".into());
            }
            if let Ok(f) = OpenOptions::new().append(true).open(dst) {
                let _ = f.sync_data();
            }
            std::thread::sleep(Duration::from_millis(1000));
        }
    }

    fn sha256_file(&self, path: &str) -> Option<[u8; 32]> {
        let mut f = File::open(path).ok()?;
        let mut h = Sha256::new();
        let mut buf = vec![0u8; 1 << 20];
        loop {
            let n = f.read(&mut buf).ok()?;
            if n == 0 {
                break;
            }
            h.update(&buf[..n]);
        }
        Some(h.finish())
    }

    fn import(&mut self, image: &str, offset: u64) -> Result<(), String> {
        let mut f = File::open(image).map_err(|e| format!("{image}: {e}"))?;
        f.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
        let mut zstd = Command::new("zstd")
            .args(["-dc", "-q"])
            .stdin(Stdio::from(f))
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("zstd: {e}"))?;
        let zout = zstd.stdout.take().ok_or("zstd stdout")?;
        let imp = Command::new("nix-store")
            .arg("--import")
            .stdin(Stdio::from(zout))
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .output()
            .map_err(|e| format!("nix-store: {e}"))?;
        let z = zstd.wait().map_err(|e| e.to_string())?;
        if !z.success() {
            let mut err = String::new();
            if let Some(mut e) = zstd.stderr.take() {
                let _ = e.read_to_string(&mut err);
            }
            return Err(format!("zstd exited {z}: {}", err.trim()));
        }
        if !imp.status.success() {
            return Err(format!("nix-store --import exited {}: {}", imp.status, String::from_utf8_lossy(&imp.stderr).trim()));
        }
        Ok(())
    }

    fn invalid_paths(&self, paths: &[String]) -> Result<Vec<String>, String> {
        if paths.is_empty() {
            return Ok(vec![]);
        }
        let out = run(Command::new("nix-store").arg("--check-validity").arg("--print-invalid").args(paths))?;
        Ok(out.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect())
    }

    fn gc_root(&mut self, link: &str, target: Option<&str>) {
        let _ = fs::remove_file(link);
        if let Some(t) = target {
            let tmp = format!("{link}.tmp.{}", std::process::id());
            let _ = fs::remove_file(&tmp);
            if symlink(t, &tmp).is_ok() {
                let _ = fs::rename(&tmp, link);
            }
        }
        fsync_dir(dir_of(link));
    }

    fn commit_system(&mut self, toplevel: &str) -> Result<(), String> {
        run(Command::new("nix-env").args(["-p", "/nix/var/nix/profiles/system", "--set", toplevel]))?;
        run(Command::new(format!("{toplevel}/bin/switch-to-configuration")).arg("boot"))?;
        run(&mut Command::new("sync")).ok();
        Ok(())
    }

    fn collect_garbage(&mut self) {
        // Keep the current and the previous generation (the rollback target of the
        // NEXT update's trial is whatever is current then; one more is a margin).
        let _ = run(Command::new("nix-env").args(["-p", "/nix/var/nix/profiles/system", "--delete-generations", "+2"]));
        let _ = run(Command::new("nix-store").arg("--gc"));
    }

    fn reboot(&mut self) {
        let _ = run(&mut Command::new("sync"));
        let _ = Command::new("systemctl").arg("reboot").status();
    }

    fn now_ms(&self) -> u64 {
        // CLOCK_BOOTTIME via /proc/uptime (seconds, two decimals).
        fs::read_to_string("/proc/uptime")
            .ok()
            .and_then(|s| s.split_whitespace().next()?.parse::<f64>().ok())
            .map(|s| (s * 1000.0) as u64)
            .unwrap_or(0)
    }

    fn sleep_ms(&mut self, ms: u64) {
        std::thread::sleep(Duration::from_millis(ms));
    }

    fn cmdline(&self) -> String {
        fs::read_to_string("/proc/cmdline").unwrap_or_default()
    }

    fn has_network(&self) -> bool {
        // A default route (IPv4) = joined and leased.
        fs::read_to_string("/proc/net/route")
            .map(|t| t.lines().skip(1).any(|l| l.split_whitespace().nth(1) == Some("00000000")))
            .unwrap_or(false)
    }

    fn hw_board(&self) -> Option<Board> {
        let model = fs::read_to_string("/proc/device-tree/model").ok()?;
        Board::from_model(&model)
    }

    fn system_version(&self, toplevel: &str) -> u32 {
        fs::read_to_string(format!("{toplevel}/etc/splanc-max/version"))
            .ok()
            .and_then(|v| splanc_ota::manifest::parse_version(v.trim()))
            .unwrap_or(0)
    }

    fn random_hex(&mut self) -> String {
        let mut b = [0u8; 8];
        if let Ok(mut f) = File::open("/dev/urandom") {
            let _ = f.read_exact(&mut b);
        }
        crate::kv::hex(&b)
    }

    fn age_ms(&self, path: &str) -> Option<u64> {
        let m = fs::metadata(path).ok()?.modified().ok()?;
        Some(SystemTime::now().duration_since(m).map(|d| d.as_millis() as u64).unwrap_or(0))
    }
}
