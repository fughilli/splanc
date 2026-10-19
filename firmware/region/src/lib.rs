//! Fragmentation-free memory regions for the firmware (docs/design/memory-regions.md).
//!
//! The shared IDF heap is first-fit over variable-size blocks: its worst case
//! depends on the allocation HISTORY, not just the live set, so "will the TLS
//! handshake fit?" has no static answer. Everything here is the opposite:
//!
//! - [`Pool`]: N slots of one type. Alloc/free are O(1) bitmap ops, any free
//!   slot satisfies any request, so the worst case is exactly N live objects —
//!   fragmentation is impossible by construction. [`Slot`] is the RAII handle.
//! - [`Slab`]: three byte size classes (each a `Pool` of 16-byte-aligned
//!   blocks) for C callers that `malloc` variable sizes (vendor blobs, mbedTLS).
//!   Its worst case is the declared class counts.
//! - [`ModeRegion`]: ONE storage reused by mutually exclusive variants (BLE
//!   provisioning vs. a wss session, map upload vs. an effect, ...). Its size
//!   is `max(variants)` (a union of them) — the mutex expressed as a budget —
//!   and `enter` takes
//!   `&mut self`, so the borrow checker proves nothing from the previous
//!   variant is still reachable when the memory is reused. Exiting runs a
//!   leak check (every pool back to full) and records the result.
//!
//! No allocation path panics: exhaustion is a deterministic [`PoolFull`] /
//! `None`, so a refused request degrades to a protocol error, never a crash.
//! Pools use `Cell`s (single owner task, like `ledmapper_arena`); a static
//! shared across tasks needs an outer lock.

#![no_std]

use core::cell::{Cell, UnsafeCell};
use core::marker::PhantomData;
use core::mem::{align_of, size_of, MaybeUninit};
use core::ops::{Deref, DerefMut};
use core::ptr::NonNull;

/// The pool is full; the value that didn't fit is handed back.
#[derive(Debug, PartialEq, Eq)]
pub struct PoolFull<T>(pub T);

/// `N` fixed slots of `T` (N <= 64: one bitmap word).
pub struct Pool<T, const N: usize> {
    slots: [UnsafeCell<MaybeUninit<T>>; N],
    /// Bit i set = slot i is free.
    free: Cell<u64>,
    /// Low-water mark of the free count since construction (sizing evidence).
    min_free: Cell<u8>,
}

impl<T, const N: usize> Pool<T, N> {
    const ALL_FREE: u64 = {
        assert!(N > 0 && N <= 64, "Pool supports 1..=64 slots");
        if N == 64 {
            u64::MAX
        } else {
            (1u64 << N) - 1
        }
    };

    #[allow(clippy::new_without_default)]
    pub const fn new() -> Self {
        Pool {
            // SAFETY-free: an array of uninitialized cells needs no init.
            slots: [const { UnsafeCell::new(MaybeUninit::uninit()) }; N],
            free: Cell::new(Self::ALL_FREE),
            min_free: Cell::new(N as u8),
        }
    }

    pub const fn capacity(&self) -> usize {
        N
    }

    pub fn free_count(&self) -> usize {
        self.free.get().count_ones() as usize
    }

    pub fn min_free(&self) -> usize {
        self.min_free.get() as usize
    }

    /// Every slot is free again (the leak check a mode exit runs).
    pub fn is_full_free(&self) -> bool {
        self.free.get() == Self::ALL_FREE
    }

    fn take_index(&self) -> Option<usize> {
        let f = self.free.get();
        if f == 0 {
            return None;
        }
        let i = f.trailing_zeros() as usize;
        self.free.set(f & !(1u64 << i));
        let n = f.count_ones() as u8 - 1;
        if n < self.min_free.get() {
            self.min_free.set(n);
        }
        Some(i)
    }

    fn put_index(&self, i: usize) {
        debug_assert!(i < N && self.free.get() & (1u64 << i) == 0, "double free");
        self.free.set(self.free.get() | (1u64 << i));
    }

    /// Move `v` into a free slot. `Err(PoolFull(v))` when all N are live.
    pub fn alloc(&self, v: T) -> Result<Slot<'_, T, N>, PoolFull<T>> {
        let Some(idx) = self.take_index() else {
            return Err(PoolFull(v));
        };
        // SAFETY: idx was free, so no Slot or raw pointer refers to it; we are
        // its only accessor until put_index.
        unsafe { (*self.slots[idx].get()).write(v) };
        Ok(Slot { pool: self, idx })
    }

    /// Raw, UNINITIALIZED slot for a C caller (the Slab). The caller owns it
    /// until [`Pool::free_raw`].
    pub fn alloc_raw(&self) -> Option<NonNull<T>> {
        let idx = self.take_index()?;
        // SAFETY: in-bounds element of our own array; never null.
        Some(unsafe { NonNull::new_unchecked(self.slots[idx].get().cast::<T>()) })
    }

    /// Whether `p` points at the START of one of this pool's slots; its index.
    pub fn index_of(&self, p: *const u8) -> Option<usize> {
        let base = self.slots.as_ptr() as usize;
        let off = (p as usize).checked_sub(base)?;
        let stride = size_of::<UnsafeCell<MaybeUninit<T>>>();
        if stride == 0 || off % stride != 0 || off / stride >= N {
            return None;
        }
        Some(off / stride)
    }

    /// Return a raw slot (no destructor runs: raw slots hold plain bytes).
    ///
    /// # Safety
    /// `p` came from [`Pool::alloc_raw`] on THIS pool and is not used again.
    pub unsafe fn free_raw(&self, p: NonNull<T>) {
        if let Some(i) = self.index_of(p.as_ptr().cast()) {
            self.put_index(i);
        }
    }
}

/// RAII handle to a live pool slot; dropping it drops the value and frees the
/// slot. Its lifetime is the pool borrow, so it cannot outlive the pool.
pub struct Slot<'p, T, const N: usize> {
    pool: &'p Pool<T, N>,
    idx: usize,
}

impl<T, const N: usize> Deref for Slot<'_, T, N> {
    type Target = T;
    fn deref(&self) -> &T {
        // SAFETY: the slot is initialized and owned by this handle.
        unsafe { (*self.pool.slots[self.idx].get()).assume_init_ref() }
    }
}

impl<T, const N: usize> DerefMut for Slot<'_, T, N> {
    fn deref_mut(&mut self) -> &mut T {
        // SAFETY: as above; &mut self makes the access exclusive.
        unsafe { (*self.pool.slots[self.idx].get()).assume_init_mut() }
    }
}

impl<T, const N: usize> Drop for Slot<'_, T, N> {
    fn drop(&mut self) {
        // SAFETY: initialized + owned; after this the index is free again.
        unsafe { (*self.pool.slots[self.idx].get()).assume_init_drop() };
        self.pool.put_index(self.idx);
    }
}

/// A 16-byte-aligned block of `K` bytes (malloc's alignment contract on RV32
/// IDF is 4; 16 also covers `max_align_t` users like mbedTLS bignums).
#[repr(C, align(16))]
pub struct Block<const K: usize>(pub [u8; K]);

/// Three-class byte slab for variable-size C allocations. Requests take the
/// smallest class that fits and fall back to larger classes; the worst case is
/// the declared counts, independent of request order (no fragmentation).
pub struct Slab<
    const S0: usize,
    const N0: usize,
    const S1: usize,
    const N1: usize,
    const S2: usize,
    const N2: usize,
> {
    c0: Pool<Block<S0>, N0>,
    c1: Pool<Block<S1>, N1>,
    c2: Pool<Block<S2>, N2>,
    /// Requests refused (too large, or every fitting class exhausted).
    refused: Cell<u32>,
}

impl<const S0: usize, const N0: usize, const S1: usize, const N1: usize, const S2: usize, const N2: usize>
    Slab<S0, N0, S1, N1, S2, N2>
{
    const CHECK: () = assert!(
        S0 > 0 && S0 < S1 && S1 < S2 && S0 % 16 == 0 && S1 % 16 == 0 && S2 % 16 == 0,
        "slab classes must be increasing multiples of 16"
    );
    /// Total bytes of block storage (the slab's whole worst case).
    pub const BYTES: usize = S0 * N0 + S1 * N1 + S2 * N2;

    #[allow(clippy::new_without_default)]
    pub const fn new() -> Self {
        #[allow(clippy::let_unit_value)]
        let () = Self::CHECK;
        Slab { c0: Pool::new(), c1: Pool::new(), c2: Pool::new(), refused: Cell::new(0) }
    }

    /// malloc(n): `None` if `n` exceeds the largest class or no fitting class
    /// has a free block. Never panics.
    pub fn alloc(&self, n: usize) -> Option<NonNull<u8>> {
        let p = if n <= S0 { self.c0.alloc_raw().map(NonNull::cast) } else { None };
        let p = p.or_else(|| if n <= S1 { self.c1.alloc_raw().map(NonNull::cast) } else { None });
        let p = p.or_else(|| if n <= S2 { self.c2.alloc_raw().map(NonNull::cast) } else { None });
        if p.is_none() {
            self.refused.set(self.refused.get().saturating_add(1));
        }
        p
    }

    /// free(p), routed by address range. Returns false if `p` isn't one of this
    /// slab's blocks (a foreign pointer — the caller's routing bug).
    ///
    /// # Safety
    /// `p` came from [`Slab::alloc`] on this slab and is not used again.
    pub unsafe fn free(&self, p: NonNull<u8>) -> bool {
        if self.c0.index_of(p.as_ptr()).is_some() {
            self.c0.free_raw(p.cast());
        } else if self.c1.index_of(p.as_ptr()).is_some() {
            self.c1.free_raw(p.cast());
        } else if self.c2.index_of(p.as_ptr()).is_some() {
            self.c2.free_raw(p.cast());
        } else {
            return false;
        }
        true
    }

    /// Does `p` belong to this slab (for a malloc-wrap that routes frees)?
    pub fn owns(&self, p: *const u8) -> bool {
        self.c0.index_of(p).is_some() || self.c1.index_of(p).is_some() || self.c2.index_of(p).is_some()
    }

    /// Blocks still handed out (0 = nothing leaked).
    pub fn live(&self) -> usize {
        (N0 - self.c0.free_count()) + (N1 - self.c1.free_count()) + (N2 - self.c2.free_count())
    }

    /// Per-class low-water free counts (size each class from these).
    pub fn min_free(&self) -> [usize; 3] {
        [self.c0.min_free(), self.c1.min_free(), self.c2.min_free()]
    }

    pub fn refused(&self) -> u32 {
        self.refused.get()
    }
}

/// A mutually exclusive variant that can live in a [`ModeRegion`].
pub trait Variant: Sized {
    /// Objects still allocated when the variant exits (forgotten slots, slab
    /// blocks a C caller never freed). Called by the guard's exit; 0 = clean.
    fn leaked(&self) -> usize {
        0
    }
}

/// How the last variant left the region.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitStatus {
    /// No variant has exited yet.
    None,
    Clean,
    /// This many objects were still allocated at exit — a leak that would have
    /// become heap fragmentation on the shared heap.
    Leaked(usize),
}

/// Storage shared by mutually exclusive variants, one at a time. `S` is the
/// storage type — normally a `#[repr(C)] union` of the variants (each wrapped
/// in `ManuallyDrop`), so `size_of::<S>()` is exactly `max(variants)`: the
/// mutex IS the budget, and a state holding two variants at once cannot be
/// represented. `S` is never read or dropped as an `S`; it only sizes/aligns.
pub struct ModeRegion<S> {
    store: UnsafeCell<MaybeUninit<S>>,
    last_exit: ExitStatus,
    leaks_total: u32,
}

impl<S> ModeRegion<S> {
    #[allow(clippy::new_without_default)]
    pub const fn new() -> Self {
        ModeRegion { store: UnsafeCell::new(MaybeUninit::uninit()), last_exit: ExitStatus::None, leaks_total: 0 }
    }

    /// Byte budget every variant must fit.
    pub const fn capacity() -> usize {
        size_of::<S>()
    }

    pub fn last_exit(&self) -> ExitStatus {
        self.last_exit
    }

    /// Exits that leaked, since construction.
    pub fn leaks_total(&self) -> u32 {
        self.leaks_total
    }

    /// Construct `V` in the region and return its guard. `&mut self` means no
    /// guard (and so no object borrowed from one) of the previous variant can
    /// still exist. `V` must fit `S`: checked at compile time.
    pub fn enter<V: Variant>(&mut self, init: impl FnOnce() -> V) -> Guard<'_, V, S> {
        const { assert!(size_of::<V>() <= size_of::<S>(), "variant exceeds its ModeRegion budget") };
        const { assert!(align_of::<V>() <= align_of::<S>(), "variant over-aligned for its ModeRegion") };
        let p = self.store.get().cast::<V>();
        // SAFETY: the storage is aligned and sized for V (asserted above); the
        // previous variant (if any) was dropped by its guard, and &mut self
        // excludes any other reference into the storage.
        unsafe { p.write(init()) };
        Guard { region: self, _v: PhantomData }
    }
}

/// The live variant. Everything allocated from it borrows the guard, so it is
/// gone before the guard drops — and the guard must drop before the region
/// can `enter` anything else.
pub struct Guard<'r, V: Variant, S> {
    region: &'r mut ModeRegion<S>,
    _v: PhantomData<V>,
}

impl<V: Variant, S> Guard<'_, V, S> {
    fn ptr(&self) -> *mut V {
        self.region.store.get().cast::<V>()
    }
}

impl<V: Variant, S> Deref for Guard<'_, V, S> {
    type Target = V;
    fn deref(&self) -> &V {
        // SAFETY: initialized by enter, dropped only by this guard's Drop.
        unsafe { &*self.ptr() }
    }
}

impl<V: Variant, S> DerefMut for Guard<'_, V, S> {
    fn deref_mut(&mut self) -> &mut V {
        // SAFETY: as above; &mut self is exclusive.
        unsafe { &mut *self.ptr() }
    }
}

impl<V: Variant, S> Drop for Guard<'_, V, S> {
    fn drop(&mut self) {
        let p = self.ptr();
        // SAFETY: still initialized (Drop runs once); no borrow of it outlives
        // the guard, so reading the leak count then dropping in place is sound.
        let leaked = unsafe { (*p).leaked() };
        unsafe { p.drop_in_place() };
        self.region.last_exit = if leaked == 0 { ExitStatus::Clean } else { ExitStatus::Leaked(leaked) };
        if leaked != 0 {
            self.region.leaks_total = self.region.leaks_total.saturating_add(1);
        }
    }
}

/// The borrow checker rejects switching variants while a slot from the old
/// one is alive — the mutex is a compile-time fact:
///
/// ```compile_fail
/// use ledmapper_region::{ModeRegion, Pool, Variant};
/// struct Prov { bufs: Pool<[u8; 64], 4> }
/// impl Variant for Prov {}
/// struct Wss;
/// impl Variant for Wss {}
/// let mut r = ModeRegion::<[u64; 64]>::new();
/// let g = r.enter(|| Prov { bufs: Pool::new() });
/// let held = g.bufs.alloc([0; 64]).ok().unwrap();
/// let _w = r.enter(|| Wss); // ERROR: `r` is still borrowed by `g` / `held`
/// drop(held);
/// ```
///
/// Exiting first (dropping the slot, then the guard) compiles:
///
/// ```
/// use ledmapper_region::{ExitStatus, ModeRegion, Pool, Variant};
/// struct Prov { bufs: Pool<[u8; 64], 4> }
/// impl Variant for Prov {
///     fn leaked(&self) -> usize { 4 - self.bufs.free_count() }
/// }
/// struct Wss;
/// impl Variant for Wss {}
/// let mut r = ModeRegion::<[u64; 64]>::new();
/// {
///     let g = r.enter(|| Prov { bufs: Pool::new() });
///     let held = g.bufs.alloc([0; 64]).ok().unwrap();
///     drop(held);
/// }
/// assert_eq!(r.last_exit(), ExitStatus::Clean);
/// let _w = r.enter(|| Wss);
/// ```
pub mod mutex_is_compile_time {}

#[cfg(test)]
mod tests {
    use super::*;
    use core::cell::Cell as StdCell;

    #[test]
    fn pool_alloc_free_and_exhaustion_are_exact() {
        let p: Pool<u32, 3> = Pool::new();
        let a = p.alloc(1).unwrap();
        let b = p.alloc(2).unwrap();
        let c = p.alloc(3).unwrap();
        assert_eq!(p.free_count(), 0);
        assert_eq!(p.alloc(4).err(), Some(PoolFull(4)), "full pool hands the value back");
        assert_eq!((*a, *b, *c), (1, 2, 3));
        drop(b);
        assert_eq!(p.free_count(), 1);
        let d = p.alloc(5).unwrap();
        assert_eq!(*d, 5, "a freed slot is reused regardless of order");
        assert_eq!(p.min_free(), 0);
        drop((a, c, d));
        assert!(p.is_full_free());
    }

    #[test]
    fn slots_never_alias() {
        let p: Pool<[u8; 8], 64> = Pool::new();
        let mut held = [const { None }; 64];
        for (i, h) in held.iter_mut().enumerate() {
            *h = Some(p.alloc([i as u8; 8]).unwrap());
        }
        for (i, h) in held.iter().enumerate() {
            assert_eq!(h.as_ref().unwrap()[0], i as u8);
        }
        let mut addrs: [usize; 64] = [0; 64];
        for (a, h) in addrs.iter_mut().zip(held.iter()) {
            *a = &**h.as_ref().unwrap() as *const _ as usize;
        }
        addrs.sort_unstable();
        assert!(addrs.windows(2).all(|w| w[1] - w[0] >= 8));
    }

    #[test]
    fn slot_drop_runs_the_destructor() {
        struct D<'a>(&'a StdCell<u32>);
        impl Drop for D<'_> {
            fn drop(&mut self) {
                self.0.set(self.0.get() + 1);
            }
        }
        let n = StdCell::new(0);
        let p: Pool<D, 2> = Pool::new();
        drop(p.alloc(D(&n)).ok().unwrap());
        assert_eq!(n.get(), 1);
    }

    #[test]
    fn slab_classes_route_and_bound() {
        let s: Slab<32, 2, 128, 1, 1024, 1> = Slab::new();
        assert_eq!(Slab::<32, 2, 128, 1, 1024, 1>::BYTES, 32 * 2 + 128 + 1024);
        let a = s.alloc(10).unwrap();
        let b = s.alloc(32).unwrap();
        // Class 0 is now full: a small request falls back to class 1, then 2.
        let c = s.alloc(1).unwrap();
        let d = s.alloc(1).unwrap();
        assert!(s.alloc(1).is_none(), "every class exhausted");
        assert!(s.alloc(4096).is_none(), "larger than the largest class");
        assert_eq!(s.refused(), 2);
        for p in [a, b, c, d] {
            assert_eq!(p.as_ptr() as usize % 16, 0, "malloc alignment");
            assert!(s.owns(p.as_ptr()));
        }
        assert_eq!(s.live(), 4);
        unsafe {
            for p in [a, b, c, d] {
                assert!(s.free(p));
            }
            let mut x = 0u8;
            assert!(!s.free(NonNull::from(&mut x)), "foreign pointer is refused");
        }
        assert_eq!(s.live(), 0);
        assert_eq!(s.min_free(), [0, 0, 0]);
    }

    struct Prov {
        bufs: Pool<[u8; 64], 4>,
    }
    impl Variant for Prov {
        fn leaked(&self) -> usize {
            4 - self.bufs.free_count()
        }
    }
    struct Wss {
        rec: [u8; 300],
    }
    impl Variant for Wss {}

    /// The storage IS the mutex: one union, sized max(variants).
    #[allow(dead_code)]
    #[repr(C)]
    union RadioStore {
        prov: core::mem::ManuallyDrop<Prov>,
        wss: core::mem::ManuallyDrop<Wss>,
    }

    #[test]
    fn mode_region_reuses_storage_and_checks_leaks() {
        let max = core::cmp::max(size_of::<Prov>(), size_of::<Wss>());
        assert_eq!(ModeRegion::<RadioStore>::capacity(), max.next_multiple_of(align_of::<RadioStore>()));
        let mut r = ModeRegion::<RadioStore>::new();
        let prov_addr;
        {
            let g = r.enter(|| Prov { bufs: Pool::new() });
            prov_addr = &*g as *const Prov as usize;
            let s = g.bufs.alloc([1; 64]).ok().unwrap();
            drop(s);
        }
        assert_eq!(r.last_exit(), ExitStatus::Clean);
        {
            let mut g = r.enter(|| Wss { rec: [0; 300] });
            assert_eq!(&*g as *const Wss as usize, prov_addr, "same storage, next variant");
            g.rec[299] = 7;
        }
        {
            let g = r.enter(|| Prov { bufs: Pool::new() });
            // A forgotten slot (or a C caller that never freed) is a leak.
            core::mem::forget(g.bufs.alloc([2; 64]).ok().unwrap());
        }
        assert_eq!(r.last_exit(), ExitStatus::Leaked(1));
        assert_eq!(r.leaks_total(), 1);
    }
}

// Kani proofs (bounded model checking of the unsafe slot bookkeeping). Not in
// the Bazel build: run `cargo kani` from firmware/region (see README.md).
#[cfg(kani)]
mod proofs {
    use super::*;

    /// For any sequence of up to 6 alloc/free ops on a 4-slot pool: live slots
    /// never alias, alloc succeeds iff a slot is free, and the free count is
    /// conserved (free + live == N).
    #[kani::proof]
    #[kani::unwind(8)]
    fn pool_bookkeeping() {
        let p: Pool<u8, 4> = Pool::new();
        let mut live: [Option<NonNull<u8>>; 4] = [None; 4];
        let mut n_live = 0usize;
        for _ in 0..6 {
            if kani::any() {
                let had_free = p.free_count() > 0;
                match p.alloc_raw() {
                    Some(ptr) => {
                        assert!(had_free);
                        for q in live.iter().flatten() {
                            assert!(*q != ptr, "aliased slot");
                        }
                        let k = live.iter().position(|x| x.is_none()).unwrap();
                        live[k] = Some(ptr);
                        n_live += 1;
                    }
                    None => assert!(!had_free),
                }
            } else {
                let k: usize = kani::any();
                kani::assume(k < 4);
                if let Some(ptr) = live[k].take() {
                    unsafe { p.free_raw(ptr) };
                    n_live -= 1;
                }
            }
            assert_eq!(p.free_count() + n_live, 4);
            assert!(p.min_free() <= p.free_count());
        }
    }

    /// A slab never hands out a block smaller than requested, and frees route
    /// back to the class they came from.
    #[kani::proof]
    #[kani::unwind(4)]
    fn slab_fits_and_routes() {
        let s: Slab<16, 1, 32, 1, 64, 1> = Slab::new();
        let n: usize = kani::any();
        kani::assume(n <= 80);
        match s.alloc(n) {
            Some(p) => {
                assert!(n <= 64);
                let class = if s.c0.index_of(p.as_ptr()).is_some() {
                    16
                } else if s.c1.index_of(p.as_ptr()).is_some() {
                    32
                } else {
                    64
                };
                assert!(n <= class);
                assert!(unsafe { s.free(p) });
                assert_eq!(s.live(), 0);
            }
            None => assert!(n > 64),
        }
    }
}
