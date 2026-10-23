//! `splanc-max-ota` — the root half of Splanc MAX updates (docs/design/max-ota.md).
//!
//!   splanc-max-ota boot     early in every boot: reconcile the state with what booted
//!                           (enter the trial, notice a rollback, finish a commit)
//!   splanc-max-ota apply    take the player's request (inbox/request), then download,
//!                           verify, import and stage; reboots into the trial
//!   splanc-max-ota health   during a trial: wait for the player to prove healthy,
//!                           then commit; past the deadline, roll back (reboot)
//!   splanc-max-ota status   print the state file
//!   splanc-max-ota check --manifest F [--board pi3] [--allow-downgrade]
//!                           would this manifest be accepted here? (exit 0 = yes)

use std::fs;
use std::path::Path;
use std::process::ExitCode;
use std::time::Duration;

use splanc_max_ota::linux::LinuxSys;
use splanc_max_ota::state::Request;
use splanc_max_ota::updater::{Layout, Next, Sys, Updater};
use splanc_max_ota::{board::Board, verify};

/// One updater at a time (boot, apply and health are separate units).
struct Lock(String);

impl Lock {
    fn take(dir: &str) -> Lock {
        let path = format!("{dir}/lock");
        let _ = fs::create_dir_all(dir);
        loop {
            match fs::OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(mut f) => {
                    use std::io::Write;
                    let _ = write!(f, "{}", std::process::id());
                    return Lock(path);
                }
                Err(_) => {
                    let pid = fs::read_to_string(&path).unwrap_or_default();
                    let alive = !pid.trim().is_empty() && Path::new(&format!("/proc/{}", pid.trim())).exists();
                    if !alive {
                        let _ = fs::remove_file(&path);
                        continue;
                    }
                    std::thread::sleep(Duration::from_millis(500));
                }
            }
        }
    }
}

impl Drop for Lock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn reboot_soon(sys: &mut LinuxSys, why: &str) {
    eprintln!("splanc-max-ota: rebooting ({why})");
    // Give the player a moment to tell its client (ota_status INSTALLED).
    sys.sleep_ms(3_000);
    sys.reboot();
}

fn opt(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1).cloned())
}

fn run() -> Result<(), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let lay = Layout::default();
    let cmd = args.first().map(String::as_str).unwrap_or("");
    let mut sys = LinuxSys;
    match cmd {
        "boot" => {
            let _l = Lock::take(&lay.state_dir);
            let mut u = Updater::load(&mut sys, lay.clone(), splanc_max_ota::ring());
            let next = u.boot();
            drop(u);
            if next == Next::Reboot {
                reboot_soon(&mut sys, "the healthy update is now the default");
            }
            Ok(())
        }
        "apply" => {
            let _l = Lock::take(&lay.state_dir);
            let mut u = Updater::load(&mut sys, lay.clone(), splanc_max_ota::ring());
            let req_path = lay.request();
            if let Some(b) = u.sys.read(&req_path) {
                u.sys.remove(&req_path);
                u.handle_request(&Request::parse(&String::from_utf8_lossy(&b)));
            }
            let next = u.work();
            drop(u);
            if next == Next::Reboot {
                reboot_soon(&mut sys, "booting the new system once (trial)");
            }
            Ok(())
        }
        "health" => {
            let mut first = None;
            loop {
            let next = {
                let _l = Lock::take(&lay.state_dir);
                let mut u = Updater::load(&mut sys, lay.clone(), splanc_max_ota::ring());
                u.health_tick(&mut first)
            };
            match next {
                Next::Wait => std::thread::sleep(Duration::from_secs(2)),
                Next::Reboot => {
                    reboot_soon(&mut sys, "the trial didn't prove healthy; back to the old system");
                    return Ok(());
                }
                Next::Nothing => return Ok(()),
            }
            }
        }
        "status" => {
            print!("{}", fs::read_to_string(lay.state()).unwrap_or_default());
            Ok(())
        }
        "check" => {
            let f = opt(&args, "--manifest").ok_or("--manifest F")?;
            let m = fs::read(&f).map_err(|e| format!("{f}: {e}"))?;
            let board = match opt(&args, "--board") {
                Some(b) => Board::from_name(&b).ok_or("unknown --board")?,
                None => sys.hw_board().ok_or("unknown hardware; pass --board")?,
            };
            let dev = verify::Device { board, keys: Default::default(), app_version: 0 };
            let ok = verify::check_offer(&m, args.iter().any(|a| a == "--allow-downgrade"), &dev, splanc_max_ota::ring())
                .map_err(|e| e.code().to_string())?;
            println!("ok version={} size={} board={}", ok.version, ok.size, board.name());
            Ok(())
        }
        _ => Err("usage: splanc-max-ota boot|apply|health|status|check".into()),
    }
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("splanc-max-ota: {e}");
            ExitCode::FAILURE
        }
    }
}
