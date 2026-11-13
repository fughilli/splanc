//! The render loop's output stage: open the sink (spidev), keep it open, and
//! re-open it with backoff whenever it is missing or a write fails.
//!
//! Rendering is never disabled for good (owner rule: effects keep running). On a
//! cold boot the player can start before `/dev/spidev0.0` exists or before the
//! Tang Nano has enumerated (hitl-rig-1, 2026-11-12: the player logged "spidev
//! open failed — render loop disabled" and served WSS all day without driving a
//! single LED). Instead the output sits in [`State::Pending`], retrying the open
//! with a doubling backoff (0.5 s .. 5 s), and rendering resumes the moment it
//! opens. The WSS server is unaffected throughout.
//!
//! Pure and clock-free: the caller sleeps the returned delays, so the policy is
//! unit-tested with a fake opener. While pending, the player advertises the
//! [`OUTPUT_PENDING`] welcome feature so a client (the HITL harness) can fail
//! fast with a clear message instead of waiting on a silent wire.

use crate::render::Sink;
use std::time::Duration;

/// Welcome feature string advertised while the output is NOT driving LEDs.
pub const OUTPUT_PENDING: &str = "output_pending";

/// Doubling retry delay: `initial`, `2*initial`, … capped at `max`.
#[derive(Clone, Debug, PartialEq)]
pub struct Backoff {
    initial: Duration,
    max: Duration,
    next: Duration,
}

impl Backoff {
    pub fn new(initial: Duration, max: Duration) -> Self {
        Self { initial, max, next: initial }
    }

    /// The player's policy: 0.5 s doubling to 5 s.
    pub fn player_default() -> Self {
        Self::new(Duration::from_millis(500), Duration::from_secs(5))
    }

    /// The delay to wait before the next attempt (and advance the schedule).
    pub fn next_delay(&mut self) -> Duration {
        let d = self.next;
        self.next = (self.next * 2).min(self.max);
        d
    }

    /// Back to `initial` (after a successful open).
    pub fn reset(&mut self) {
        self.next = self.initial;
    }
}

/// Whether the output is driving LEDs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    Pending,
    Ready,
}

/// What one [`Output::ensure_open`] / [`Output::write_frame`] call did.
#[derive(Debug, PartialEq)]
pub enum Event {
    /// The sink is open and the frame (if any) was written.
    Ready,
    /// The sink just opened (Pending -> Ready). `retries` = failed opens before it.
    Opened { retries: u32 },
    /// Not open; wait `delay` and call again. `log` carries the error the first
    /// time the output enters Pending and whenever the error changes — so the
    /// journal gets one line per state change, not one per retry.
    Wait { delay: Duration, log: Option<String> },
}

/// The output stage over an opener `O` producing sinks `S`.
pub struct Output<S, O> {
    open: O,
    sink: Option<S>,
    backoff: Backoff,
    retries: u32,
    last_err: Option<String>,
}

impl<S: Sink, O: FnMut() -> std::io::Result<S>> Output<S, O> {
    pub fn new(open: O, backoff: Backoff) -> Self {
        Self { open, sink: None, backoff, retries: 0, last_err: None }
    }

    pub fn state(&self) -> State {
        if self.sink.is_some() {
            State::Ready
        } else {
            State::Pending
        }
    }

    fn fail(&mut self, err: String) -> Event {
        let log = (self.last_err.as_deref() != Some(err.as_str())).then(|| err.clone());
        self.last_err = Some(err);
        self.retries += 1;
        Event::Wait { delay: self.backoff.next_delay(), log }
    }

    /// Open the sink if it isn't open. `Ready`/`Opened` mean the caller may
    /// render + [`write_frame`](Self::write_frame) now; `Wait` means sleep.
    pub fn ensure_open(&mut self) -> Event {
        if self.sink.is_some() {
            return Event::Ready;
        }
        match (self.open)() {
            Ok(s) => {
                // The backoff + logged error reset only after a frame is
                // WRITTEN: a sink that opens but rejects every write (spidev.bufsiz
                // too small) must keep backing off and log once, not hot-loop.
                self.sink = Some(s);
                let retries = std::mem::take(&mut self.retries);
                Event::Opened { retries }
            }
            Err(e) => self.fail(format!("open failed: {e}")),
        }
    }

    /// Write one frame (all `bufs`, in order). A failed write drops the sink
    /// (Ready -> Pending) so the next [`ensure_open`](Self::ensure_open) re-opens
    /// it after the backoff — a write error never parks the output for good.
    pub fn write_frame(&mut self, bufs: &[&[u8]]) -> Event {
        let Some(sink) = self.sink.as_mut() else {
            return self.ensure_open();
        };
        for b in bufs {
            if let Err(e) = sink.write(b) {
                self.sink = None;
                return self.fail(format!("write of {} B failed: {e}", b.len()));
            }
        }
        self.backoff.reset();
        self.last_err = None;
        Event::Ready
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::io;
    use std::rc::Rc;

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    #[test]
    fn backoff_doubles_to_the_cap_and_resets() {
        let mut b = Backoff::player_default();
        let got: Vec<_> = (0..6).map(|_| b.next_delay()).collect();
        assert_eq!(got, [ms(500), ms(1000), ms(2000), ms(4000), ms(5000), ms(5000)]);
        b.reset();
        assert_eq!(b.next_delay(), ms(500));
    }

    /// A sink that fails writes while `fail` is set; records good writes.
    struct FakeSink {
        fail: Rc<RefCell<bool>>,
        writes: Rc<RefCell<Vec<Vec<u8>>>>,
    }
    impl Sink for FakeSink {
        fn write(&mut self, d: &[u8]) -> io::Result<()> {
            if *self.fail.borrow() {
                return Err(io::Error::from_raw_os_error(90)); // EMSGSIZE
            }
            self.writes.borrow_mut().push(d.to_vec());
            Ok(())
        }
    }

    struct Rig {
        present: Rc<RefCell<bool>>,
        fail: Rc<RefCell<bool>>,
        writes: Rc<RefCell<Vec<Vec<u8>>>>,
        opens: Rc<RefCell<u32>>,
    }

    fn rig() -> (Rig, Output<FakeSink, impl FnMut() -> io::Result<FakeSink>>) {
        let r = Rig {
            present: Rc::new(RefCell::new(false)),
            fail: Rc::new(RefCell::new(false)),
            writes: Rc::default(),
            opens: Rc::default(),
        };
        let (p, f, w, o) = (r.present.clone(), r.fail.clone(), r.writes.clone(), r.opens.clone());
        let out = Output::new(
            move || {
                *o.borrow_mut() += 1;
                if *p.borrow() {
                    Ok(FakeSink { fail: f.clone(), writes: w.clone() })
                } else {
                    Err(io::Error::from(io::ErrorKind::NotFound))
                }
            },
            Backoff::player_default(),
        );
        (r, out)
    }

    #[test]
    fn missing_device_retries_with_backoff_then_renders_once_it_appears() {
        let (r, mut out) = rig();
        assert_eq!(out.state(), State::Pending);
        // First failure is logged; repeats of the same error are not.
        let Event::Wait { delay, log } = out.ensure_open() else { panic!() };
        assert_eq!(delay, ms(500));
        assert!(log.unwrap().contains("open failed"));
        for want in [1000, 2000, 4000, 5000, 5000] {
            assert_eq!(out.ensure_open(), Event::Wait { delay: ms(want), log: None });
        }
        // Writing while pending just retries the open (nothing reaches a sink).
        assert!(matches!(out.write_frame(&[b"x"]), Event::Wait { log: None, .. }));
        assert_eq!(*r.opens.borrow(), 7);
        // The device enumerates: the next attempt opens and rendering starts.
        *r.present.borrow_mut() = true;
        assert_eq!(out.ensure_open(), Event::Opened { retries: 7 });
        assert_eq!(out.state(), State::Ready);
        assert_eq!(out.write_frame(&[b"cfg", b"stream"]), Event::Ready);
        assert_eq!(*r.writes.borrow(), vec![b"cfg".to_vec(), b"stream".to_vec()]);
        // Already open: no further opens.
        assert_eq!(out.ensure_open(), Event::Ready);
        assert_eq!(*r.opens.borrow(), 8);
    }

    #[test]
    fn write_failure_reopens_and_backs_off_until_a_frame_lands() {
        let (r, mut out) = rig();
        *r.present.borrow_mut() = true;
        assert_eq!(out.ensure_open(), Event::Opened { retries: 0 });
        *r.fail.borrow_mut() = true;
        // The failed write drops the sink and logs once.
        let Event::Wait { delay, log } = out.write_frame(&[b"abcd"]) else { panic!() };
        assert_eq!(delay, ms(500));
        assert!(log.unwrap().contains("write of 4 B failed"));
        assert_eq!(out.state(), State::Pending);
        // Re-open succeeds, but the write still fails: same error, not re-logged,
        // and the backoff keeps growing (no hot loop on a persistent EMSGSIZE).
        assert_eq!(out.ensure_open(), Event::Opened { retries: 1 });
        assert_eq!(out.write_frame(&[b"abcd"]), Event::Wait { delay: ms(1000), log: None });
        // Once writes succeed again rendering resumes, and the backoff resets.
        *r.fail.borrow_mut() = false;
        assert!(matches!(out.ensure_open(), Event::Opened { .. }));
        assert_eq!(out.write_frame(&[b"ok"]), Event::Ready);
        assert_eq!(*r.writes.borrow(), vec![b"ok".to_vec()]);
        *r.fail.borrow_mut() = true;
        assert!(matches!(out.write_frame(&[b"x"]), Event::Wait { delay, log: Some(_) } if delay == ms(500)));
    }

    #[test]
    fn a_changed_error_is_logged_again() {
        let (r, mut out) = rig();
        assert!(matches!(out.ensure_open(), Event::Wait { log: Some(_), .. }));
        assert!(matches!(out.ensure_open(), Event::Wait { log: None, .. }));
        *r.present.borrow_mut() = true;
        *r.fail.borrow_mut() = true;
        out.ensure_open();
        assert!(matches!(out.write_frame(&[b"x"]), Event::Wait { log: Some(_), .. }));
    }
}
