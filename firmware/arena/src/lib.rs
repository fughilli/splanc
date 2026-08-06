//! Bump-allocator arena for the firmware players (Phase 3 of
//! docs/esp32-led-mapping-plan.md).
//!
//! The variable-size uploads (LED map, topology) land HERE instead of in
//! fixed-capacity heapless fields: one statically-placed byte buffer, a bump
//! cursor, deterministic [`ArenaFull`] on exhaustion (never a panic, never a
//! heap), and checkpoint/rollback so a failed upload releases everything it
//! consumed.
//!
//! Borrow discipline (what makes the unsafe sound):
//! - `alloc_*` takes `&self` (interior mutability via a `Cell` cursor) and
//!   hands out disjoint regions, so a decode can hold many live allocations;
//! - `reset*` takes `&mut self`, so the borrow checker proves no allocation
//!   from before the reset is still reachable when the memory is reused.
//!
//! [`ArenaVec`] is the growable companion for lists with no length header
//! (topology segments, polylines): grow-by-doubling capacity. When the vec
//! still owns the arena tail — the common case, a list built without an
//! interleaving allocation — it extends its region IN PLACE with a cursor
//! bump ([`Arena::try_grow_tail_in_place`]): no copy, no leak. Only when a
//! later allocation sits after it does growth fall back to allocating a fresh
//! region and LEAKING the old one (a bump arena cannot free). This keeps a
//! whole map+topology decode inside the firmware's tight 16 KB arena
//! (FUG-74): the big topology lists (associations, per-segment polylines) are
//! each built at the tail, so they cost their live size, not ~2x churn. The
//! big LED list is exactly pre-sized from the upload header instead
//! (`with_exact_capacity` + the store's led_count handling).

#![no_std]

use core::cell::Cell;
use core::marker::PhantomData;
use core::mem::{align_of, size_of, MaybeUninit};

/// Deterministic out-of-memory: the request does not fit the arena.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ArenaFull;

/// A rollback point (the bump cursor at `checkpoint()` time).
#[derive(Debug, Clone, Copy)]
pub struct Checkpoint(usize);

pub struct Arena<'m> {
    base: *mut u8,
    cap: usize,
    used: Cell<usize>,
    // Logically owns the borrowed buffer for 'm.
    _mem: PhantomData<&'m mut [u8]>,
}

impl<'m> Arena<'m> {
    pub fn new(buf: &'m mut [u8]) -> Self {
        Arena {
            base: buf.as_mut_ptr(),
            cap: buf.len(),
            used: Cell::new(0),
            _mem: PhantomData,
        }
    }

    pub fn capacity(&self) -> usize {
        self.cap
    }

    pub fn used(&self) -> usize {
        self.used.get()
    }

    pub fn checkpoint(&self) -> Checkpoint {
        Checkpoint(self.used.get())
    }

    /// Roll back to `cp`, releasing everything allocated after it. `&mut
    /// self` guarantees no allocation handed out since then is still live.
    pub fn reset_to(&mut self, cp: Checkpoint) {
        debug_assert!(cp.0 <= self.used.get());
        self.used.set(cp.0);
    }

    pub fn reset(&mut self) {
        self.used.set(0);
    }

    fn alloc_raw(&self, size: usize, align: usize) -> Result<*mut u8, ArenaFull> {
        debug_assert!(align.is_power_of_two());
        let cur = self.used.get();
        // Align the cursor within the buffer (base alignment included).
        let addr = self.base as usize + cur;
        let pad = addr.wrapping_neg() & (align - 1);
        let start = cur.checked_add(pad).ok_or(ArenaFull)?;
        let end = start.checked_add(size).ok_or(ArenaFull)?;
        if end > self.cap {
            return Err(ArenaFull);
        }
        self.used.set(end);
        // SAFETY: start+size <= cap, so the region is inside the borrowed
        // buffer; the bump cursor never hands the same region out twice.
        Ok(unsafe { self.base.add(start) })
    }

    /// Allocate an uninitialized slice of `n` `T`s. The returned lifetime is
    /// the `&self` borrow: allocations cannot outlive the arena borrow, and
    /// `reset*` (needing `&mut self`) cannot run while any are live.
    #[allow(clippy::mut_from_ref)] // disjoint regions; see module docs
    pub fn alloc_uninit_slice<T>(&self, n: usize) -> Result<&mut [MaybeUninit<T>], ArenaFull> {
        let size = size_of::<T>().checked_mul(n).ok_or(ArenaFull)?;
        let ptr = self.alloc_raw(size, align_of::<T>())?;
        // SAFETY: freshly carved, aligned, sized for n Ts; MaybeUninit needs
        // no initialization.
        Ok(unsafe { core::slice::from_raw_parts_mut(ptr.cast::<MaybeUninit<T>>(), n) })
    }

    /// Grow `cur` to `new_len` `T`s WITHOUT copying or leaking — but only when
    /// `cur` is the arena's most-recent allocation (its end sits exactly on the
    /// bump cursor). In that case the extra capacity is contiguous free space
    /// right after it, so extending is a cursor bump: the base pointer, and
    /// therefore the already-written prefix, is untouched. Returns `None` when
    /// `cur` is not at the tail (a later allocation sits after it) or the growth
    /// doesn't fit — the caller then falls back to realloc-and-copy.
    ///
    /// This is what keeps a topology decode inside the tight 16 KB arena: the
    /// big repeated lists (associations, per-segment polylines) are each built
    /// at the tail, so they grow in place with zero grow-and-leak churn instead
    /// of doubling into ~2x transient waste (FUG-74).
    #[allow(clippy::mut_from_ref)] // extends one region in place; see module docs
    pub fn try_grow_tail_in_place<T>(
        &self,
        cur: &mut [MaybeUninit<T>],
        new_len: usize,
    ) -> Option<&mut [MaybeUninit<T>]> {
        let cur_cap = cur.len();
        if cur_cap == 0 || new_len <= cur_cap {
            return None;
        }
        let base = cur.as_mut_ptr();
        // Is `cur` the last thing allocated? Its end must land on the cursor.
        let start = (base as usize).checked_sub(self.base as usize)?;
        let end = start.checked_add(cur_cap.checked_mul(size_of::<T>())?)?;
        if end != self.used.get() {
            return None; // something was allocated after `cur`; can't extend it
        }
        // Extend to new_len: the region stays T-aligned (start is aligned and
        // size_of::<T>() is a multiple of align_of::<T>()), and it's contiguous.
        let new_size = start.checked_add(new_len.checked_mul(size_of::<T>())?)?;
        if new_size > self.cap {
            return None; // doesn't fit — caller reports ArenaFull via fallback
        }
        self.used.set(new_size);
        // SAFETY: [start, new_size) is inside the buffer; the bytes past the old
        // end were free (end == prior cursor) so nothing else aliases them, and
        // `cur`'s &mut is consumed by this call, so the extended &mut is unique.
        Some(unsafe { core::slice::from_raw_parts_mut(base, new_len) })
    }
}

// SAFETY: the raw base pointer is only a borrow of the 'm buffer.
unsafe impl Send for Arena<'_> {}

/// Growable arena-backed vector of `Copy` items; see the module docs for the
/// grow-and-leak strategy and when to prefer `with_exact_capacity`.
pub struct ArenaVec<'a, 'm, T: Copy> {
    arena: &'a Arena<'m>,
    items: &'a mut [MaybeUninit<T>],
    len: usize,
    /// Exactly-sized vectors refuse to grow: exceeding the pre-declared
    /// capacity is a protocol violation, not an allocation event.
    exact: bool,
}

impl<'a, 'm, T: Copy> ArenaVec<'a, 'm, T> {
    pub fn new(arena: &'a Arena<'m>) -> Self {
        ArenaVec {
            arena,
            items: &mut [],
            len: 0,
            exact: false,
        }
    }

    /// Pre-size exactly (e.g. from an upload header); pushes beyond `n`
    /// fail with `ArenaFull` instead of growing.
    pub fn with_exact_capacity(arena: &'a Arena<'m>, n: usize) -> Result<Self, ArenaFull> {
        Ok(ArenaVec {
            arena,
            items: arena.alloc_uninit_slice(n)?,
            len: 0,
            exact: true,
        })
    }

    pub fn len(&self) -> usize {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    pub fn capacity(&self) -> usize {
        self.items.len()
    }

    pub fn push(&mut self, value: T) -> Result<(), ArenaFull> {
        if self.len == self.items.len() {
            if self.exact {
                return Err(ArenaFull);
            }
            let new_cap = (self.items.len() * 2).max(8);
            // Grow in place when we still own the arena tail (the common case:
            // a list built without an interleaving allocation) — no copy, no
            // leak. Only when a later allocation sits after us do we fall back
            // to realloc-and-copy, leaking the old region (bump arena).
            match self.arena.try_grow_tail_in_place::<T>(self.items, new_cap) {
                Some(grown) => self.items = grown,
                None => {
                    let new_items = self.arena.alloc_uninit_slice::<T>(new_cap)?;
                    new_items[..self.len].copy_from_slice(&self.items[..self.len]);
                    self.items = new_items;
                }
            }
        }
        self.items[self.len].write(value);
        self.len += 1;
        Ok(())
    }

    pub fn as_slice(&self) -> &[T] {
        // SAFETY: items[..len] were all written by push.
        unsafe { &*(core::ptr::from_ref(&self.items[..self.len]) as *const [T]) }
    }

    /// Finish building: the initialized prefix, borrowing the arena.
    pub fn into_slice(self) -> &'a [T] {
        // SAFETY: as in as_slice; the region lives as long as the arena
        // borrow 'a and is never handed out again by the bump allocator.
        unsafe { &*(core::ptr::from_ref(&self.items[..self.len]) as *const [T]) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allocations_are_disjoint_and_aligned() {
        let mut buf = [0u8; 256];
        let arena = Arena::new(&mut buf);
        let a = arena.alloc_uninit_slice::<u8>(3).unwrap();
        let b = arena.alloc_uninit_slice::<u64>(2).unwrap();
        a[0].write(1);
        b[0].write(2);
        assert_eq!(b.as_ptr() as usize % align_of::<u64>(), 0);
        let a_range = a.as_ptr() as usize..a.as_ptr() as usize + 3;
        assert!(!a_range.contains(&(b.as_ptr() as usize)));
    }

    #[test]
    fn oom_is_deterministic_and_total() {
        let mut buf = [0u8; 64];
        let arena = Arena::new(&mut buf);
        assert!(arena.alloc_uninit_slice::<u8>(64).is_ok());
        assert_eq!(arena.alloc_uninit_slice::<u8>(1).err(), Some(ArenaFull));
        // The failed request consumed nothing.
        assert_eq!(arena.used(), 64);
    }

    #[test]
    fn checkpoint_rolls_back_a_failed_transaction() {
        let mut buf = [0u8; 64];
        let mut arena = Arena::new(&mut buf);
        arena.alloc_uninit_slice::<u8>(16).unwrap();
        let cp = arena.checkpoint();
        arena.alloc_uninit_slice::<u8>(32).unwrap();
        assert_eq!(arena.alloc_uninit_slice::<u8>(32).err(), Some(ArenaFull));
        arena.reset_to(cp);
        assert_eq!(arena.used(), 16);
        assert!(arena.alloc_uninit_slice::<u8>(48).is_ok());
    }

    #[test]
    fn vec_grows_and_yields_the_pushed_values() {
        let mut buf = [0u8; 4096];
        let arena = Arena::new(&mut buf);
        let mut v = ArenaVec::<u32>::new(&arena);
        for i in 0..100u32 {
            v.push(i).unwrap();
        }
        assert_eq!(v.len(), 100);
        assert!(v.as_slice().iter().copied().eq(0..100));
        let s = v.into_slice();
        assert_eq!(s[99], 99);
    }

    #[test]
    fn exact_capacity_refuses_to_grow() {
        let mut buf = [0u8; 4096];
        let arena = Arena::new(&mut buf);
        let mut v = ArenaVec::<u32>::with_exact_capacity(&arena, 4).unwrap();
        for i in 0..4u32 {
            v.push(i).unwrap();
        }
        let used = arena.used();
        assert_eq!(v.push(4), Err(ArenaFull));
        assert_eq!(arena.used(), used, "refused push must not allocate");
    }

    #[test]
    fn tail_vec_grows_in_place_without_churn() {
        // A vec that owns the arena tail grows by extending the SAME region:
        // no realloc, no leak. `used` tracks exactly the final capacity, and
        // the base pointer never moves across a grow.
        let mut buf = [0u8; 4096];
        let arena = Arena::new(&mut buf);
        let mut v = ArenaVec::<u32>::new(&arena);
        v.push(0).unwrap();
        let base = v.as_slice().as_ptr();
        for i in 1..200u32 {
            v.push(i).unwrap();
        }
        // 200 items round up to a 256 capacity; in place that is the ONLY
        // region ever allocated, so used == 256*4 with zero doubling waste.
        assert_eq!(arena.used(), 256 * core::mem::size_of::<u32>());
        assert_eq!(v.as_slice().as_ptr(), base, "in-place growth must not move");
        assert!(v.as_slice().iter().copied().eq(0..200));
    }

    #[test]
    fn interleaved_vec_falls_back_to_realloc() {
        // When another allocation sits AFTER a vec, it can't extend in place, so
        // it reallocs-and-leaks — but the data stays correct. `b` pins the tail
        // away from `a`, forcing `a`'s growth onto the realloc path.
        let mut buf = [0u8; 8192];
        let arena = Arena::new(&mut buf);
        let mut a = ArenaVec::<u32>::new(&arena);
        a.push(0).unwrap(); // a: region #1 (cap 8) at the tail
        let _pin = arena.alloc_uninit_slice::<u32>(1).unwrap(); // now a is NOT tail
        for i in 1..8u32 {
            a.push(i).unwrap(); // fills cap 8 without growing
        }
        let before = arena.used();
        a.push(8).unwrap(); // grow: must realloc (leak old), not extend in place
        assert!(arena.used() > before + core::mem::size_of::<u32>());
        assert!(a.as_slice().iter().copied().eq(0..9));
    }

    #[test]
    fn try_grow_in_place_refuses_a_non_tail_region() {
        let mut buf = [0u8; 256];
        let arena = Arena::new(&mut buf);
        let first = arena.alloc_uninit_slice::<u32>(4).unwrap();
        let _after = arena.alloc_uninit_slice::<u32>(1).unwrap();
        // `first` is no longer at the tail → in-place growth is refused.
        assert!(arena.try_grow_tail_in_place::<u32>(first, 8).is_none());
    }

    #[test]
    fn try_grow_in_place_refuses_when_it_would_overflow() {
        let mut buf = [0u8; 32];
        let arena = Arena::new(&mut buf);
        let tail = arena.alloc_uninit_slice::<u32>(4).unwrap(); // 16 B, at tail
        // Growing to 16 (64 B) exceeds the 32 B arena → None (caller → ArenaFull).
        assert!(arena.try_grow_tail_in_place::<u32>(tail, 16).is_none());
        assert_eq!(arena.used(), 16, "a refused grow must not move the cursor");
    }

    #[test]
    fn interleaved_vecs_stay_consistent() {
        let mut buf = [0u8; 8192];
        let arena = Arena::new(&mut buf);
        let mut a = ArenaVec::<u32>::new(&arena);
        let mut b = ArenaVec::<[f32; 3]>::new(&arena);
        for i in 0..50u32 {
            a.push(i).unwrap();
            b.push([i as f32, 0.0, -(i as f32)]).unwrap();
        }
        assert!(a.as_slice().iter().copied().eq(0..50));
        assert_eq!(b.as_slice()[49][2], -49.0);
    }
}
