//! Scheduled control changes (`apply_at_ms` on set_uniforms / set_effect /
//! set_crossfade / set_brightness; docs/design/synced-show.md "Scheduled
//! changes"). A hub sends every fixture the same apply time on the shared
//! effect time base; each device holds the raw `ClientMessage` frame here and
//! the render task applies it at the first frame boundary at/after its due
//! time, so a room changes on the same frame instead of spread over Wi-Fi
//! latency.
//!
//! Static, bounded and allocation-free: at most `N` frames whose bytes share one
//! `BYTES` pool. Entries stay sorted by due time; equal due times keep their
//! arrival order. Nothing is ever dropped — a control change is state, not a
//! video frame: when the queue is full the earliest entries are handed back to
//! be applied early ([`ApplyQueue::push`]), and a frame that can never fit is
//! applied at once after everything due before it.

/// One queued frame: its due time (device clock ms) and where its bytes sit in
/// the pool.
#[derive(Clone, Copy)]
struct Ent {
    due: i64,
    off: u16,
    len: u16,
}

/// A bounded, due-time-ordered queue of raw protocol frames.
pub struct ApplyQueue<const N: usize, const BYTES: usize> {
    ents: [Ent; N],
    len: usize,
    pool: [u8; BYTES],
    used: usize,
}

impl<const N: usize, const BYTES: usize> Default for ApplyQueue<N, BYTES> {
    fn default() -> Self {
        Self::new()
    }
}

impl<const N: usize, const BYTES: usize> ApplyQueue<N, BYTES> {
    pub const fn new() -> Self {
        ApplyQueue { ents: [Ent { due: 0, off: 0, len: 0 }; N], len: 0, pool: [0; BYTES], used: 0 }
    }

    /// Frames waiting.
    pub fn len(&self) -> usize {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// The earliest due time waiting (None: empty).
    pub fn next_due(&self) -> Option<i64> {
        (self.len > 0).then(|| self.ents[0].due)
    }

    /// Forget everything waiting.
    pub fn clear(&mut self) {
        self.len = 0;
        self.used = 0;
    }

    /// Move every due time by `delta` ms (the device clock stepped; the time
    /// base moved with it).
    pub fn shift(&mut self, delta: i64) {
        for e in &mut self.ents[..self.len] {
            e.due = e.due.saturating_add(delta);
        }
    }

    /// Queue `frame` until `due`. Returns how many frames `apply` was called with:
    /// when the queue (or its byte pool) is full, the earliest entries are applied
    /// now — early, but in order and never lost — until the new one fits. A frame
    /// larger than the whole pool is applied at once, right after every entry due
    /// no later than it. `apply` gets the raw frames in due order.
    pub fn push(&mut self, due: i64, frame: &[u8], mut apply: impl FnMut(&[u8])) -> usize {
        let mut applied = 0;
        if frame.len() > BYTES || frame.len() > u16::MAX as usize || N == 0 {
            applied += self.pop_due(due, &mut apply);
            apply(frame);
            return applied + 1;
        }
        while self.len == N || self.used + frame.len() > BYTES {
            self.pop_front(&mut apply);
            applied += 1;
        }
        let off = self.used;
        self.pool[off..off + frame.len()].copy_from_slice(frame);
        self.used += frame.len();
        // After every entry due no later than this one (arrival order on ties).
        let at = self.ents[..self.len].iter().position(|e| e.due > due).unwrap_or(self.len);
        self.ents.copy_within(at..self.len, at + 1);
        self.ents[at] = Ent { due, off: off as u16, len: frame.len() as u16 };
        self.len += 1;
        applied
    }

    /// Apply (and remove) every entry due at or before `now`, in order. Returns
    /// how many were applied.
    pub fn pop_due(&mut self, now: i64, mut apply: impl FnMut(&[u8])) -> usize {
        let mut n = 0;
        while self.len > 0 && self.ents[0].due <= now {
            self.pop_front(&mut apply);
            n += 1;
        }
        n
    }

    /// Apply + remove the earliest entry (the queue is non-empty).
    fn pop_front(&mut self, apply: &mut impl FnMut(&[u8])) {
        let e = self.ents[0];
        let (off, len) = (e.off as usize, e.len as usize);
        apply(&self.pool[off..off + len]);
        // Close the gap in the pool; later bytes slide down.
        self.pool.copy_within(off + len..self.used, off);
        self.used -= len;
        self.ents.copy_within(1..self.len, 0);
        self.len -= 1;
        for x in &mut self.ents[..self.len] {
            if x.off as usize > off {
                x.off -= len as u16;
            }
        }
    }
}

/// How far ahead a scheduled change may be (ms). Further out is taken for a clock
/// or epoch mismatch (e.g. a stale time base) and applied on arrival rather than
/// leaving the fixture stuck on the old look.
pub const APPLY_AT_MAX_AHEAD_MS: i64 = 10_000;

/// The device-clock due time of a change scheduled for `apply_at_ms` on the time
/// base `epoch_ms`, or None to apply it now: unscheduled, no time base, already
/// due at `now_ms`, or implausibly far ahead.
pub fn apply_due(apply_at_ms: Option<u32>, epoch_ms: Option<i64>, now_ms: i64) -> Option<i64> {
    let due = epoch_ms?.saturating_add(apply_at_ms? as i64);
    (due > now_ms && due - now_ms <= APPLY_AT_MAX_AHEAD_MS).then_some(due)
}
