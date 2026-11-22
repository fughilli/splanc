//! Zero-initialized storage for firmware `static mut`s (see `BUILD.bazel`).
//!
//! `static mut X: Option<T> = None` is placed in `.data` (flash + RAM) whenever
//! `Option<T>` uses a niche inside `T` (a `bool` or enum byte holding an invalid
//! value for `None`), because the initializer then has a non-zero byte. On the
//! C6 player that cost ~10 KB of flash for a handful of statics.
//! [`BssOption`] stores its tag beside `T` instead, so [`BssOption::NONE`] is
//! all-zero bytes and the static goes to `.bss`. The API mirrors the subset of
//! `Option` the firmware uses.

#![no_std]

use core::mem::MaybeUninit;

/// An `Option<T>` whose empty state is all-zero bytes (so a static holding one
/// is zero-initialized: `.bss`, not `.data`).
pub struct BssOption<T> {
    val: MaybeUninit<T>,
    some: bool,
}

impl<T> BssOption<T> {
    /// The empty value: every byte zero (padding included, via `zeroed`).
    pub const NONE: Self = BssOption { val: MaybeUninit::zeroed(), some: false };

    #[inline(always)]
    pub const fn is_some(&self) -> bool {
        self.some
    }

    #[inline(always)]
    pub const fn is_none(&self) -> bool {
        !self.some
    }

    #[inline(always)]
    pub fn as_ref(&self) -> Option<&T> {
        if self.some {
            // SAFETY: `some` is set only after `val` was written.
            Some(unsafe { self.val.assume_init_ref() })
        } else {
            None
        }
    }

    #[inline(always)]
    pub fn as_mut(&mut self) -> Option<&mut T> {
        if self.some {
            // SAFETY: `some` is set only after `val` was written.
            Some(unsafe { self.val.assume_init_mut() })
        } else {
            None
        }
    }

    /// Store `v` (dropping any previous value), like `*opt = Some(v)`; returns it.
    #[inline]
    pub fn set(&mut self, v: T) -> &mut T {
        self.clear();
        self.val.write(v);
        self.some = true;
        // SAFETY: just written.
        unsafe { self.val.assume_init_mut() }
    }

    /// Like `Option::insert`: store `v` (dropping any previous value) and return it.
    #[inline]
    pub fn insert(&mut self, v: T) -> &mut T {
        self.set(v)
    }

    /// Like `Option::get_or_insert_with`.
    #[inline(always)]
    pub fn get_or_insert_with<F: FnOnce() -> T>(&mut self, f: F) -> &mut T {
        if !self.some {
            self.val.write(f());
            self.some = true;
        }
        // SAFETY: `some` is set, so `val` holds a live `T`.
        unsafe { self.val.assume_init_mut() }
    }

    /// Drop the value, if any, like `*opt = None`.
    #[inline]
    pub fn clear(&mut self) {
        if self.some {
            self.some = false;
            // SAFETY: `some` was set, so `val` holds a live `T`.
            unsafe { self.val.assume_init_drop() };
        }
    }

    /// Move the value out, leaving it empty, like `Option::take`.
    #[inline]
    pub fn take(&mut self) -> Option<T> {
        if self.some {
            self.some = false;
            // SAFETY: `some` was set; clearing it hands ownership to the caller.
            Some(unsafe { self.val.assume_init_read() })
        } else {
            None
        }
    }
}

impl<T> Drop for BssOption<T> {
    fn drop(&mut self) {
        self.clear();
    }
}

impl<T> Default for BssOption<T> {
    fn default() -> Self {
        Self::NONE
    }
}

impl<T> From<Option<T>> for BssOption<T> {
    fn from(o: Option<T>) -> Self {
        let mut b = Self::NONE;
        if let Some(v) = o {
            b.set(v);
        }
        b
    }
}

#[cfg(test)]
mod tests {
    extern crate std;
    use super::*;
    use std::rc::Rc;

    #[derive(Debug, PartialEq)]
    struct Niche {
        a: u8,
        flag: bool, // gives Option<Niche> a niche: None is flag == 2
    }

    // Byte image of a value (volatile: no const-folding of the static's contents).
    // The test types have no padding (align 1), so every byte is initialized.
    fn bytes_of<T>(v: &T) -> std::vec::Vec<u8> {
        let p = v as *const T as *const u8;
        (0..core::mem::size_of::<T>()).map(|i| unsafe { p.add(i).read_volatile() }).collect()
    }

    #[test]
    fn none_is_all_zero_bytes() {
        static NONE: BssOption<Niche> = BssOption::NONE;
        assert!(bytes_of(&NONE).iter().all(|&b| b == 0));
        // ... which is exactly what plain Option is not.
        static OPT: Option<Niche> = None;
        assert!(bytes_of(&OPT).iter().any(|&b| b != 0));
    }

    #[test]
    fn option_semantics() {
        let mut o: BssOption<Niche> = BssOption::NONE;
        assert!(o.is_none());
        assert_eq!(o.as_ref(), None);
        assert_eq!(o.as_mut(), None);
        o.set(Niche { a: 7, flag: true });
        assert_eq!(core::mem::size_of::<BssOption<Niche>>(), 3); // no padding
        assert!(o.is_some());
        assert_eq!(o.as_ref(), Some(&Niche { a: 7, flag: true }));
        o.as_mut().unwrap().a = 9;
        assert_eq!(o.as_ref().unwrap().a, 9);
        assert_eq!(o.take(), Some(Niche { a: 9, flag: true }));
        assert!(o.is_none());
        assert_eq!(o.take(), None);
        assert_eq!(*o.get_or_insert_with(|| Niche { a: 1, flag: false }), Niche { a: 1, flag: false });
        assert_eq!(o.get_or_insert_with(|| Niche { a: 2, flag: true }).a, 1); // kept
        assert_eq!(o.insert(Niche { a: 3, flag: true }).a, 3);
        let b: BssOption<u8> = Some(3).into();
        assert_eq!(b.as_ref(), Some(&3));
    }

    #[test]
    fn set_clear_and_drop_release_the_value() {
        let rc = Rc::new(());
        let mut o = BssOption::NONE;
        o.set(rc.clone());
        assert_eq!(Rc::strong_count(&rc), 2);
        o.set(rc.clone()); // replaces: the old clone is dropped
        assert_eq!(Rc::strong_count(&rc), 2);
        o.clear();
        assert_eq!(Rc::strong_count(&rc), 1);
        o.clear(); // idempotent
        o.set(rc.clone());
        drop(o);
        assert_eq!(Rc::strong_count(&rc), 1);
    }
}
