//! Has the trial system proven itself? (docs/design/max-ota.md "Health proof")
//!
//! The player writes `/run/ledmapper/health` every couple of seconds:
//! `listening=1` once its WSS listener is bound, `ticks=N` (render frames pushed
//! to the FPGA's SPI) and `up_ms` (its own uptime). The trial is kept only when,
//! before the deadline, the player has been up for [`MIN_UP_MS`], is listening,
//! its render loop is advancing, and — if the old system had a network when it
//! staged the update — the new one has one too. An AP that is down at that moment
//! fails the trial (the device falls back and the update can be retried); a new
//! system that can't reach the network must not be kept, because nothing could
//! reach it to fix it.

use crate::kv;

pub const MIN_UP_MS: u64 = 20_000;
/// From the start of the trial boot's reconcile to the verdict. The player starts
/// only after the FPGA is (re)flashed with the new bitstream (tens of seconds).
pub const DEADLINE_MS: u64 = 300_000;
/// The health file is rewritten every ~2 s; older than this = the player is gone.
pub const STALE_MS: u64 = 10_000;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Sample {
    /// When the updater read it (ms, monotonic or wall — consistent per run).
    pub at_ms: u64,
    /// Age of the file when read.
    pub age_ms: u64,
    pub listening: bool,
    pub ticks: u64,
    pub up_ms: u64,
}

impl Sample {
    pub fn parse(text: &str, at_ms: u64, age_ms: u64) -> Sample {
        let k = kv::parse(text);
        Sample { at_ms, age_ms, listening: kv::get_bool(&k, "listening"), ticks: kv::get_u64(&k, "ticks"), up_ms: kv::get_u64(&k, "up_ms") }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    Healthy,
    NotYet(&'static str),
}

/// `first` and `now` are two fresh samples at least 5 s apart (the updater keeps
/// the oldest fresh one as `first`).
pub fn verdict(first: Option<&Sample>, now: Option<&Sample>, net_required: bool, has_net: bool) -> Verdict {
    let Some(now) = now else {
        return Verdict::NotYet("no health file");
    };
    if now.age_ms > STALE_MS {
        return Verdict::NotYet("health file stale");
    }
    if !now.listening {
        return Verdict::NotYet("not listening");
    }
    if now.up_ms < MIN_UP_MS {
        return Verdict::NotYet("up too briefly");
    }
    let Some(first) = first else {
        return Verdict::NotYet("one sample");
    };
    if now.at_ms < first.at_ms + 5_000 {
        return Verdict::NotYet("samples too close");
    }
    if now.ticks <= first.ticks || now.up_ms <= first.up_ms {
        return Verdict::NotYet("render loop not advancing");
    }
    if net_required && !has_net {
        return Verdict::NotYet("no network");
    }
    Verdict::Healthy
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(at: u64, ticks: u64, up: u64) -> Sample {
        Sample { at_ms: at, age_ms: 1000, listening: true, ticks, up_ms: up }
    }

    #[test]
    fn verdicts() {
        let a = s(0, 10, 21_000);
        let b = s(6_000, 400, 27_000);
        assert_eq!(verdict(Some(&a), Some(&b), true, true), Verdict::Healthy);
        assert_eq!(verdict(Some(&a), Some(&b), true, false), Verdict::NotYet("no network"));
        assert_eq!(verdict(Some(&a), Some(&b), false, false), Verdict::Healthy);
        assert_eq!(verdict(None, None, false, true), Verdict::NotYet("no health file"));
        assert_eq!(verdict(Some(&a), Some(&s(6_000, 10, 27_000)), false, true), Verdict::NotYet("render loop not advancing"));
        assert_eq!(verdict(Some(&a), Some(&s(3_000, 99, 24_000)), false, true), Verdict::NotYet("samples too close"));
        assert_eq!(verdict(Some(&a), Some(&s(6_000, 99, 5_000)), false, true), Verdict::NotYet("up too briefly"));
        let stale = Sample { age_ms: 60_000, ..b };
        assert_eq!(verdict(Some(&a), Some(&stale), false, true), Verdict::NotYet("health file stale"));
        let deaf = Sample { listening: false, ..b };
        assert_eq!(verdict(Some(&a), Some(&deaf), false, true), Verdict::NotYet("not listening"));
        let p = Sample::parse("listening=1\nticks=5\nup_ms=30000\n", 1, 2);
        assert!(p.listening && p.ticks == 5 && p.up_ms == 30_000);
    }
}
