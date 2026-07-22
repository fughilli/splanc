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
//! (topology segments, polylines): grow-by-doubling into a fresh region,
//! copy, and LEAK the old region (a bump arena cannot free). Worst-case
//! transient waste is ~2x the final size — acceptable for the small topology
//! lists; the big list (LED entries) is exactly pre-sized from the upload
//! header instead (`with_exact_capacity` + the store's led_count handling).

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
            let new_items = self.arena.alloc_uninit_slice::<T>(new_cap)?;
            new_items[..self.len].copy_from_slice(&self.items[..self.len]);
            self.items = new_items; // the old region is leaked (bump arena)
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
