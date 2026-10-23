//! The player's health file for the MAX updater's trial check
//! (docs/design/max-ota.md "Health proof"; read by splanc_max_ota::health).
//!
//! Every 2 s: `listening=1` once the WSS listener is bound, `ticks` (frames the
//! render loop has pushed to SPI) and `up_ms`. The updater keeps a new system only
//! when this shows a listening player whose render loop is advancing.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

pub static LISTENING: AtomicBool = AtomicBool::new(false);
pub static TICKS: AtomicU64 = AtomicU64::new(0);

/// The file's contents now.
pub fn snapshot(up: Duration) -> String {
    format!(
        "listening={}\nticks={}\nup_ms={}\n",
        u8::from(LISTENING.load(Ordering::Relaxed)),
        TICKS.load(Ordering::Relaxed),
        up.as_millis()
    )
}

/// Rewrite `path` every 2 s (temp + rename, so a reader never sees half a file).
pub fn spawn_writer(path: PathBuf, epoch: Instant) {
    let _ = std::thread::Builder::new().name("health".into()).stack_size(256 * 1024).spawn(move || {
        let tmp = path.with_extension("tmp");
        loop {
            if std::fs::write(&tmp, snapshot(epoch.elapsed())).is_ok() {
                let _ = std::fs::rename(&tmp, &path);
            }
            std::thread::sleep(Duration::from_secs(2));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_format() {
        TICKS.fetch_add(3, Ordering::Relaxed);
        let s = snapshot(Duration::from_millis(1500));
        assert!(s.contains("ticks=") && s.contains("up_ms=1500\n") && s.starts_with("listening="));
    }
}
