//! Output-thread frame pacing: an absolute-deadline schedule at `--fps`, gated
//! on the FPGA's `frame_done` line, with an automatic fallback to timed pacing
//! when the line never rises (unwired pin, old bitstream, no FPGA).
//!
//! Per frame the output thread (main.rs):
//!   1. renders the next frame (before any waiting, so the SPI handoff after
//!      the edge is just the ioctl);
//!   2. sleeps to the frame's absolute deadline (`Schedule`, `sleep_until_ns`);
//!   3. `Pacer::gate`: if `frame_done` is already HIGH go now, else wait for its
//!      rising edge for at most one period + margin;
//!   4. writes CSR + STREAM.
//! The deadline keeps the rate at `--fps` when the strip is shorter than the
//! period; the edge keeps a frame from starting before the FPGA has latched the
//! previous one (which would merge the two frames on the wire).
//!
//! Fallback: `fallback_after` consecutive timeouts switch the pacer to timed
//! mode (no edge waits, so an unwired board costs nothing per frame). In timed
//! mode it probes the line's event queue every `probe_every`; any queued edge
//! switches back to edge pacing. Transitions are logged through a rate limiter,
//! so a flapping wire can't spam the journal.

use std::io;
use std::time::Duration;

/// `CLOCK_MONOTONIC` in ns: the clock GPIO edge events are stamped with.
pub fn mono_ns() -> u64 {
    let mut ts = libc::timespec { tv_sec: 0, tv_nsec: 0 };
    // SAFETY: valid out-pointer; CLOCK_MONOTONIC always exists.
    unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut ts) };
    ts.tv_sec as u64 * 1_000_000_000 + ts.tv_nsec as u64
}

/// Sleep until an absolute `CLOCK_MONOTONIC` time (no drift from relative
/// sleeps; restarts on EINTR).
pub fn sleep_until_ns(t_ns: u64) {
    let ts = libc::timespec {
        tv_sec: (t_ns / 1_000_000_000) as _,
        tv_nsec: (t_ns % 1_000_000_000) as _,
    };
    loop {
        // SAFETY: valid timespec; no remaining-time out-pointer with TIMER_ABSTIME.
        let rc = unsafe {
            libc::clock_nanosleep(libc::CLOCK_MONOTONIC, libc::TIMER_ABSTIME, &ts, std::ptr::null_mut())
        };
        if rc != libc::EINTR {
            return;
        }
    }
}

/// The FPGA's `frame_done` line, as the pacer sees it. `gpio_cdev::EdgeLine` is
/// the real one; tests use a scripted fake.
pub trait FrameDone {
    /// Discard queued edge events; returns how many there were.
    fn drain(&mut self) -> io::Result<usize>;
    /// The line's current level.
    fn is_high(&mut self) -> io::Result<bool>;
    /// Block until a rising edge or `timeout`; `Some(edge timestamp, ns
    /// CLOCK_MONOTONIC)` on an edge.
    fn wait_rising(&mut self, timeout: Duration) -> io::Result<Option<u64>>;
}

/// What the gate decided for one frame.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Gate {
    /// `frame_done` was already HIGH: the FPGA is idle, send now.
    High,
    /// Waited for and got the rising edge (kernel timestamp).
    Edge { edge_ns: u64 },
    /// No edge within the timeout: sent on the timer.
    Timeout,
    /// Timed pacing (fallback mode, or no frame-done line): no wait.
    Timed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Edge,
    Timed,
}

/// Log at most once per `every_ns`, counting what was suppressed in between.
pub struct RateLimit {
    every_ns: u64,
    last_ns: Option<u64>,
    suppressed: u32,
}

impl RateLimit {
    pub fn new(every: Duration) -> Self {
        Self { every_ns: every.as_nanos() as u64, last_ns: None, suppressed: 0 }
    }

    /// Returns the message to emit (with a suppressed-count suffix), or None.
    pub fn check(&mut self, now_ns: u64, msg: &str) -> Option<String> {
        match self.last_ns {
            Some(last) if now_ns.saturating_sub(last) < self.every_ns => {
                self.suppressed += 1;
                None
            }
            _ => {
                self.last_ns = Some(now_ns);
                let s = if self.suppressed > 0 {
                    format!("{msg} ({} similar messages suppressed)", self.suppressed)
                } else {
                    msg.to_string()
                };
                self.suppressed = 0;
                Some(s)
            }
        }
    }
}

pub struct PacerConfig {
    /// Edge wait limit: one frame period + margin.
    pub timeout: Duration,
    /// Consecutive timeouts before switching to timed pacing.
    pub fallback_after: u32,
    /// How often timed mode looks for edges again.
    pub probe_every: Duration,
    /// Minimum interval between transition log lines.
    pub log_every: Duration,
}

impl PacerConfig {
    /// Defaults for a frame `period`: timeout = period + max(period/4, 1 ms).
    pub fn for_period(period: Duration) -> Self {
        Self {
            timeout: period + (period / 4).max(Duration::from_millis(1)),
            fallback_after: 3,
            probe_every: Duration::from_secs(1),
            log_every: Duration::from_secs(60),
        }
    }
}

pub struct Pacer {
    pub cfg: PacerConfig,
    pub mode: Mode,
    consecutive_timeouts: u32,
    last_probe_ns: u64,
    /// One limiter per transition, so a rate-limited fallback can't swallow
    /// the "resumed" line that follows it (and vice versa).
    log_fallback: RateLimit,
    log_resume: RateLimit,
    pub n_high: u64,
    pub n_edge: u64,
    pub n_timeout: u64,
    pub n_timed: u64,
    /// Human-readable line name for logs (e.g. "/dev/gpiochip0 line 22").
    pub line: String,
}

impl Pacer {
    pub fn new(cfg: PacerConfig, line: impl Into<String>) -> Self {
        let log_fallback = RateLimit::new(cfg.log_every);
        let log_resume = RateLimit::new(cfg.log_every);
        Self {
            cfg,
            mode: Mode::Edge,
            consecutive_timeouts: 0,
            last_probe_ns: 0,
            log_fallback,
            log_resume,
            n_high: 0,
            n_edge: 0,
            n_timeout: 0,
            n_timed: 0,
            line: line.into(),
        }
    }


    fn timed_out(&mut self, now_ns: u64, why: &str, out: &mut dyn FnMut(&str)) -> Gate {
        self.n_timeout += 1;
        self.consecutive_timeouts += 1;
        if self.consecutive_timeouts >= self.cfg.fallback_after {
            self.mode = Mode::Timed;
            self.last_probe_ns = now_ns;
            let msg = format!(
                "frame-done: {why} on {} for {} frames; falling back to timed pacing \
                 (re-checking every {:?})",
                self.line, self.consecutive_timeouts, self.cfg.probe_every
            );
            if let Some(m) = self.log_fallback.check(now_ns, &msg) {
                out(&m);
            }
        }
        Gate::Timeout
    }

    /// Gate one frame's SPI handoff. `now_ns` is the caller's monotonic time
    /// (only used for probing and log rate limiting). `out` receives log lines.
    pub fn gate<F: FrameDone + ?Sized>(
        &mut self,
        src: &mut F,
        now_ns: u64,
        out: &mut dyn FnMut(&str),
    ) -> Gate {
        if self.mode == Mode::Timed {
            if now_ns.saturating_sub(self.last_probe_ns) >= self.cfg.probe_every.as_nanos() as u64 {
                self.last_probe_ns = now_ns;
                if matches!(src.drain(), Ok(n) if n > 0) {
                    self.mode = Mode::Edge;
                    self.consecutive_timeouts = 0;
                    let msg = format!("frame-done: edges seen on {}; edge pacing resumed", self.line);
                    if let Some(m) = self.log_resume.check(now_ns, &msg) {
                        out(&m);
                    }
                }
            }
            self.n_timed += 1;
            return Gate::Timed;
        }
        // Stale edges (e.g. the rise we already went on via is_high) must not
        // satisfy this frame's wait; the level read below covers an edge that
        // lands between the drain and the read.
        if let Err(e) = src.drain() {
            return self.timed_out(now_ns, &format!("read error ({e})"), out);
        }
        match src.is_high() {
            Ok(true) => {
                self.consecutive_timeouts = 0;
                self.n_high += 1;
                return Gate::High;
            }
            Ok(false) => {}
            Err(e) => return self.timed_out(now_ns, &format!("read error ({e})"), out),
        }
        match src.wait_rising(self.cfg.timeout) {
            Ok(Some(edge_ns)) => {
                self.consecutive_timeouts = 0;
                self.n_edge += 1;
                Gate::Edge { edge_ns }
            }
            Ok(None) => self.timed_out(now_ns, "no rising edge", out),
            Err(e) => self.timed_out(now_ns, &format!("wait error ({e})"), out),
        }
    }
}

/// Absolute-deadline frame schedule.
pub struct Schedule {
    pub period_ns: u64,
    next_ns: u64,
}

impl Schedule {
    pub fn new(start_ns: u64, period: Duration) -> Self {
        Self { period_ns: period.as_nanos() as u64, next_ns: start_ns }
    }

    /// The current frame's deadline.
    pub fn deadline(&self) -> u64 {
        self.next_ns
    }

    /// Advance past a frame sent at `sent_ns`. A frame that went out late (the
    /// edge, or the system, held it past its slot) doesn't build up a debt of
    /// back-to-back frames: the next deadline is never earlier than `sent_ns`.
    pub fn advance(&mut self, sent_ns: u64) {
        self.next_ns = (self.next_ns + self.period_ns).max(sent_ns);
    }
}

/// min / p50 / p99 / max over a window of ns samples.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Summary {
    pub n: usize,
    pub min: u64,
    pub p50: u64,
    pub p99: u64,
    pub max: u64,
}

pub fn summarize(samples: &mut [u64]) -> Summary {
    if samples.is_empty() {
        return Summary::default();
    }
    samples.sort_unstable();
    let pick = |q: f64| samples[((samples.len() - 1) as f64 * q).round() as usize];
    Summary {
        n: samples.len(),
        min: samples[0],
        p50: pick(0.5),
        p99: pick(0.99),
        max: samples[samples.len() - 1],
    }
}

impl Summary {
    /// `name=min/p50/p99/max us`
    pub fn fmt_us(&self, name: &str) -> String {
        if self.n == 0 {
            return format!("{name}=-");
        }
        let us = |v: u64| v as f64 / 1000.0;
        format!(
            "{name}={:.1}/{:.1}/{:.1}/{:.1}",
            us(self.min),
            us(self.p50),
            us(self.p99),
            us(self.max)
        )
    }
}

/// Per-frame timing samples (ns) for the pacing report: `--pace-stats` windows
/// and the `--frames` bench summary.
#[derive(Default)]
pub struct PaceStats {
    /// Render (core + encode), before any wait.
    pub render: Vec<u64>,
    /// Timer wake-up lateness past the deadline (the cyclictest number).
    pub timer_late: Vec<u64>,
    /// Time in the gate (drain + level read + edge wait).
    pub gate: Vec<u64>,
    /// Kernel edge timestamp -> gate returns (IRQ-to-userspace), edges only.
    pub edge_to_wake: Vec<u64>,
    /// Gate returns -> SPI ioctl entry (userspace handoff).
    pub to_ioctl: Vec<u64>,
    /// CSR ioctl duration (split writes only): bounds ioctl entry -> CS assert.
    pub csr_ioctl: Vec<u64>,
    /// Whole SPI handoff (CSR + STREAM ioctls).
    pub spi: Vec<u64>,
    /// SPI ioctl entry to the next frame's SPI ioctl entry.
    pub period: Vec<u64>,
    /// Pipelined only: player lock hold per render (fresh frames).
    pub lock: Vec<u64>,
    /// Pipelined only: render done -> SPI ioctl entry (frame age at send).
    pub age: Vec<u64>,
    /// Pipelined only: player sampled (render start) -> SPI ioctl entry, i.e.
    /// the input -> light latency the pipeline adds to (every send).
    pub sample_to_spi: Vec<u64>,
}

impl PaceStats {
    pub fn clear(&mut self) {
        *self = Self::default();
    }

    pub fn report(&mut self) -> String {
        [
            summarize(&mut self.render).fmt_us("render"),
            summarize(&mut self.timer_late).fmt_us("timer_late"),
            summarize(&mut self.gate).fmt_us("gate"),
            summarize(&mut self.edge_to_wake).fmt_us("edge_to_wake"),
            summarize(&mut self.to_ioctl).fmt_us("wake_to_ioctl"),
            summarize(&mut self.csr_ioctl).fmt_us("csr_ioctl"),
            summarize(&mut self.spi).fmt_us("spi"),
            summarize(&mut self.period).fmt_us("period"),
        ]
        .into_iter()
        .chain(
            // Pipelined-only fields, omitted from the serial report.
            [("lock", &mut self.lock), ("age", &mut self.age), ("sample_to_spi", &mut self.sample_to_spi)]
                .into_iter()
                .filter(|(_, v)| !v.is_empty())
                .map(|(name, v)| summarize(v).fmt_us(name)),
        )
        .collect::<Vec<_>>()
        .join(" ")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    /// Scripted line: each `wait_rising` pops the next result.
    #[derive(Default)]
    struct Fake {
        high: VecDeque<bool>,
        waits: VecDeque<Option<u64>>,
        queued: usize,
        drains: usize,
        wait_calls: usize,
    }

    impl FrameDone for Fake {
        fn drain(&mut self) -> io::Result<usize> {
            self.drains += 1;
            Ok(std::mem::take(&mut self.queued))
        }
        fn is_high(&mut self) -> io::Result<bool> {
            Ok(self.high.pop_front().unwrap_or(false))
        }
        fn wait_rising(&mut self, _t: Duration) -> io::Result<Option<u64>> {
            self.wait_calls += 1;
            Ok(self.waits.pop_front().unwrap_or(None))
        }
    }

    fn pacer() -> Pacer {
        Pacer::new(PacerConfig::for_period(Duration::from_micros(8333)), "test line 22")
    }

    const MS: u64 = 1_000_000;

    #[test]
    fn timeout_is_period_plus_margin() {
        let p = Duration::from_micros(8333);
        let c = PacerConfig::for_period(p);
        assert_eq!(c.timeout, p + p / 4);
        // Short periods still get at least 1 ms of margin.
        let c = PacerConfig::for_period(Duration::from_micros(2000));
        assert_eq!(c.timeout, Duration::from_micros(3000));
    }

    #[test]
    fn high_line_goes_at_once_without_waiting() {
        let mut p = pacer();
        let mut f = Fake { high: [true].into(), ..Default::default() };
        let mut logs = vec![];
        assert_eq!(p.gate(&mut f, 0, &mut |m| logs.push(m.to_string())), Gate::High);
        assert_eq!(f.wait_calls, 0);
        assert_eq!(f.drains, 1, "stale edges are drained before the level read");
        assert!(logs.is_empty());
    }

    #[test]
    fn low_line_waits_for_the_edge() {
        let mut p = pacer();
        let mut f = Fake { waits: [Some(42)].into(), queued: 3, ..Default::default() };
        let mut logs = vec![];
        assert_eq!(p.gate(&mut f, 0, &mut |m| logs.push(m.to_string())), Gate::Edge { edge_ns: 42 });
        assert_eq!(f.queued, 0, "stale events were discarded first");
        assert_eq!(p.n_edge, 1);
    }

    #[test]
    fn unwired_pin_falls_back_after_three_timeouts_and_logs_once() {
        let mut p = pacer();
        let mut f = Fake::default(); // always LOW, never an edge
        let mut logs: Vec<String> = vec![];
        let mut t = 0;
        for i in 0..3 {
            assert_eq!(p.gate(&mut f, t, &mut |m| logs.push(m.to_string())), Gate::Timeout, "frame {i}");
            t += 10 * MS;
        }
        assert_eq!(p.mode, Mode::Timed);
        assert_eq!(logs.len(), 1, "{logs:?}");
        assert!(logs[0].contains("falling back to timed pacing"), "{}", logs[0]);
        // A long run in timed mode: no more waits, no more logs.
        let waits = f.wait_calls;
        for _ in 0..10_000 {
            assert_eq!(p.gate(&mut f, t, &mut |m| logs.push(m.to_string())), Gate::Timed);
            t += 8_333_333;
        }
        assert_eq!(f.wait_calls, waits, "timed mode never blocks on the line");
        assert_eq!(logs.len(), 1, "no log spam: {logs:?}");
        // It probed roughly once a second (83 s of frames).
        assert!((80..=90).contains(&(f.drains - 3)), "drains={}", f.drains);
    }

    #[test]
    fn timed_mode_resumes_edge_pacing_when_edges_appear() {
        let mut p = pacer();
        let mut f = Fake::default();
        let mut logs: Vec<String> = vec![];
        for _ in 0..3 {
            p.gate(&mut f, 0, &mut |m| logs.push(m.to_string()));
        }
        assert_eq!(p.mode, Mode::Timed);
        // Wire connected: edges queue up; the next probe (>= 1 s later) sees them.
        f.queued = 5;
        assert_eq!(p.gate(&mut f, 500 * MS, &mut |m| logs.push(m.to_string())), Gate::Timed);
        assert_eq!(p.mode, Mode::Timed, "no probe before probe_every");
        assert_eq!(p.gate(&mut f, 1_100 * MS, &mut |m| logs.push(m.to_string())), Gate::Timed);
        assert_eq!(p.mode, Mode::Edge);
        assert_eq!(logs.len(), 2);
        assert!(logs[1].contains("edge pacing resumed"));
        f.waits.push_back(Some(7));
        assert_eq!(p.gate(&mut f, 1_110 * MS, &mut |_| {}), Gate::Edge { edge_ns: 7 });
    }

    #[test]
    fn an_edge_resets_the_timeout_count() {
        let mut p = pacer();
        let mut f = Fake { waits: [None, None, Some(1), None, None].into(), ..Default::default() };
        for _ in 0..5 {
            p.gate(&mut f, 0, &mut |_| {});
        }
        assert_eq!(p.mode, Mode::Edge, "two misses, an edge, two misses: still edge-paced");
        assert_eq!(p.n_timeout, 4);
    }

    #[test]
    fn flapping_wire_logs_are_rate_limited() {
        let mut p = pacer();
        let mut f = Fake::default();
        let mut logs: Vec<String> = vec![];
        let mut t = 0;
        // Fall back, resume, fall back, ... every ~1 s for 30 s.
        for _ in 0..15 {
            for _ in 0..3 {
                p.gate(&mut f, t, &mut |m| logs.push(m.to_string()));
                t += 10 * MS;
            }
            t += 1_000 * MS;
            f.queued = 1;
            p.gate(&mut f, t, &mut |m| logs.push(m.to_string()));
        }
        // One fallback + one resume line per log interval, however it flaps.
        assert_eq!(logs.len(), 2, "{logs:?}");
        // After the log interval the next transition is logged with the count.
        for _ in 0..3 {
            p.gate(&mut f, t + 61_000 * MS, &mut |m| logs.push(m.to_string()));
        }
        assert_eq!(logs.len(), 3);
        assert!(logs[2].contains("suppressed"), "{}", logs[2]);
    }

    #[test]
    fn schedule_is_absolute_and_drops_debt() {
        let mut s = Schedule::new(1_000, Duration::from_nanos(100));
        assert_eq!(s.deadline(), 1_000);
        s.advance(1_010); // on time (10 ns of jitter doesn't drift the grid)
        assert_eq!(s.deadline(), 1_100);
        s.advance(1_105);
        assert_eq!(s.deadline(), 1_200);
        // Held 250 ns past its slot (edge-limited): no catch-up burst.
        s.advance(1_450);
        assert_eq!(s.deadline(), 1_450);
        s.advance(1_455);
        assert_eq!(s.deadline(), 1_550);
    }

    #[test]
    fn summary_percentiles() {
        let mut v: Vec<u64> = (1..=100).collect();
        let s = summarize(&mut v);
        assert_eq!((s.n, s.min, s.p50, s.p99, s.max), (100, 1, 51, 99, 100));
        assert_eq!(summarize(&mut []).n, 0);
        let s = Summary { n: 1, min: 1500, p50: 2000, p99: 2500, max: 3000 };
        assert_eq!(s.fmt_us("x"), "x=1.5/2.0/2.5/3.0");
    }

    #[test]
    fn mono_clock_advances_and_sleep_until_is_absolute() {
        let t0 = mono_ns();
        sleep_until_ns(t0 + 2 * MS);
        assert!(mono_ns() >= t0 + 2 * MS);
        // A deadline in the past returns at once.
        let t1 = mono_ns();
        sleep_until_ns(t0);
        assert!(mono_ns() - t1 < 50 * MS);
    }
}
