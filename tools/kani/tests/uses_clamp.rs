//! Kani harnesses that reach into a dependency (//tools/kani/tests:clamp).
#![no_std]

/// Scale a value by a factor, saturating to a byte.
pub fn scale(x: u32, k: u32) -> u8 {
    clamp::clamp8(x.saturating_mul(k))
}

#[cfg(kani)]
mod proofs {
    #[kani::proof]
    fn clamp_is_identity_below_256() {
        let x: u32 = kani::any();
        kani::assume(x < 256);
        assert_eq!(clamp::clamp8(x) as u32, x);
    }

    #[kani::proof]
    fn scale_saturates_instead_of_wrapping() {
        let x: u32 = kani::any();
        let k: u32 = kani::any();
        let s = super::scale(x, k) as u64;
        assert!(s == 255 || s == x as u64 * k as u64);
    }
}
