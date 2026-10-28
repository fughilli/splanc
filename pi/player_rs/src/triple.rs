//! Lock-free single-producer / single-consumer triple buffer: the handoff
//! between the render thread and the output thread.
//!
//! Three slots: the writer owns one (`back`), the reader owns one (`front`),
//! and the third (`middle`) holds the newest published value. One `AtomicU8`
//! holds the middle slot's index plus a FRESH bit.
//!   * `Writer::publish` swaps its back slot into the middle (FRESH set) and
//!     takes the old middle as its next back slot.
//!   * `Reader::update` takes the middle slot only if it is FRESH, handing its
//!     old front back as the new middle.
//! Neither side ever waits, allocates or touches a slot the other owns, so the
//! reader can never see a buffer that is being written (no tearing), and
//! always gets the newest completed value. When nothing new has been published
//! the reader keeps its front slot, so the output re-sends the last frame.

use std::cell::UnsafeCell;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Arc;

const INDEX: u8 = 0b011;
const FRESH: u8 = 0b100;

struct Shared<T> {
    slots: [UnsafeCell<T>; 3],
    middle: AtomicU8,
}

// SAFETY: each slot is only ever accessed by the side that owns its index; the
// index handoff goes through `middle` with AcqRel ordering, which orders the
// writer's slot writes before the reader's reads.
unsafe impl<T: Send> Sync for Shared<T> {}

/// The producing half (the render thread).
pub struct Writer<T> {
    shared: Arc<Shared<T>>,
    back: u8,
}

/// The consuming half (the output thread).
pub struct Reader<T> {
    shared: Arc<Shared<T>>,
    front: u8,
}

/// A triple buffer whose slots start as `init` (the reader's initial front is
/// `init[0]`, treated as already consumed).
pub fn triple<T: Send>(init: [T; 3]) -> (Writer<T>, Reader<T>) {
    let [a, b, c] = init;
    let shared = Arc::new(Shared {
        slots: [UnsafeCell::new(a), UnsafeCell::new(b), UnsafeCell::new(c)],
        middle: AtomicU8::new(1),
    });
    (
        Writer { shared: shared.clone(), back: 2 },
        Reader { shared, front: 0 },
    )
}

impl<T> Writer<T> {
    /// The slot being written; never visible to the reader until `publish`.
    pub fn back(&mut self) -> &mut T {
        // SAFETY: `back` is owned exclusively by this writer (see module doc).
        unsafe { &mut *self.shared.slots[self.back as usize].get() }
    }

    /// Publish the back slot as the newest value. Returns true when the value
    /// it replaces was never read (the reader fell behind; that frame was
    /// skipped in favour of this newer one).
    pub fn publish(&mut self) -> bool {
        let old = self.shared.middle.swap(self.back | FRESH, Ordering::AcqRel);
        self.back = old & INDEX;
        old & FRESH != 0
    }

    /// Whether the last published value is still waiting for the reader.
    pub fn pending(&self) -> bool {
        self.shared.middle.load(Ordering::Acquire) & FRESH != 0
    }
}

impl<T> Reader<T> {
    /// Take the newest published value, if there is one the reader hasn't
    /// seen. Returns false (front unchanged: re-send it) otherwise.
    pub fn update(&mut self) -> bool {
        if self.shared.middle.load(Ordering::Relaxed) & FRESH == 0 {
            return false;
        }
        let old = self.shared.middle.swap(self.front, Ordering::AcqRel);
        self.front = old & INDEX;
        true
    }

    /// The reader's current value (the newest it has taken).
    pub fn front(&self) -> &T {
        // SAFETY: `front` is owned exclusively by this reader.
        unsafe { &*self.shared.slots[self.front as usize].get() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reader_sees_newest_and_repeats_when_nothing_new() {
        let (mut w, mut r) = triple([0u32, 0, 0]);
        assert!(!r.update(), "nothing published yet");
        assert_eq!(*r.front(), 0);
        *w.back() = 1;
        assert!(!w.publish());
        assert!(w.pending());
        assert!(r.update());
        assert!(!w.pending());
        assert_eq!(*r.front(), 1);
        assert!(!r.update(), "same frame again: keep (re-send) it");
        assert_eq!(*r.front(), 1);
        // Two publishes before a read: the reader gets the newer one; the
        // writer is told the older one was skipped.
        *w.back() = 2;
        assert!(!w.publish());
        *w.back() = 3;
        assert!(w.publish(), "2 was never read");
        assert!(r.update());
        assert_eq!(*r.front(), 3);
    }

    #[test]
    fn slots_never_alias() {
        let (mut w, mut r) = triple([0u8, 0, 0]);
        for i in 0..50u8 {
            *w.back() = i;
            w.publish();
            if i % 3 == 0 {
                r.update();
            }
            let (b, f) = (w.back, r.front);
            let m = w.shared.middle.load(Ordering::Relaxed) & INDEX;
            assert!(b != f && b != m && f != m, "back {b} front {f} middle {m}");
        }
    }

    /// Writer fills a whole buffer with one counter value; the reader checks
    /// every buffer it takes is uniform (never torn) and the counter only
    /// moves forward.
    #[test]
    fn no_tearing_under_contention() {
        const N: usize = 4096;
        const FRAMES: u64 = 20_000;
        let (mut w, mut r) = triple([vec![0u64; N], vec![0u64; N], vec![0u64; N]]);
        let writer = std::thread::spawn(move || {
            for v in 1..=FRAMES {
                w.back().iter_mut().for_each(|x| *x = v);
                w.publish();
            }
        });
        let mut last = 0u64;
        let mut taken = 0u64;
        while last < FRAMES {
            if r.update() {
                let f = r.front();
                let v = f[0];
                assert!(f.iter().all(|&x| x == v), "torn buffer");
                assert!(v > last, "went backwards: {v} after {last}");
                last = v;
                taken += 1;
            }
        }
        writer.join().unwrap();
        assert!(taken >= 1);
    }
}
