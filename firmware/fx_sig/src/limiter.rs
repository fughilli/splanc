//! Backoff on failed signature verifications.
//!
//! A 4-byte tag is forged with probability 2^-32 per guess, so what keeps a
//! forgery impractical is the guess *rate*. After [`FREE_FAILS`] consecutive
//! bad tags, each further attempt must wait `BASE_MS * 2^(n - FREE_FAILS)`,
//! capped at [`MAX_MS`]. At the cap an attacker gets one guess a minute: an
//! expected 2^31 minutes (~4,000 years) to land one forgery.
//!
//! One limiter is **device-wide**, not per connection, so opening new sessions
//! doesn't reset it. The consecutive-failure count is persisted (NVS) by the
//! caller whenever it changes, and restored at boot with the backoff re-armed,
//! so a reboot doesn't reset it either. Writes happen once per failure (bounded
//! by the backoff itself) and once on the first success after failures.
//!
//! The cost of a device-wide limiter: someone flooding bad tags delays
//! legitimate native loads. Those effects keep running on the VM meanwhile
//! (effects never stop), so the attack degrades speed, not function.

use crate::Reject;

/// Consecutive failures allowed before any backoff (developer mistakes).
pub const FREE_FAILS: u32 = 3;
/// First backoff step.
pub const BASE_MS: u64 = 500;
/// Backoff cap.
pub const MAX_MS: u64 = 60_000;

/// Delay required after `fails` consecutive failures.
pub fn backoff_ms(fails: u32) -> u64 {
    if fails < FREE_FAILS {
        return 0;
    }
    let step = fails - FREE_FAILS;
    if step >= 17 {
        return MAX_MS;
    }
    (BASE_MS << step).min(MAX_MS)
}

#[derive(Clone, Debug, Default)]
pub struct Limiter {
    consecutive: u32,
    until_ms: u64,
    dirty: bool,
    /// Failures since boot (status/logging; not persisted).
    pub boot_fails: u32,
}

impl Limiter {
    /// Restore from the persisted consecutive-failure count at boot (`now_ms`
    /// = the boot clock), re-arming the backoff it implies.
    pub fn restore(persisted: u32, now_ms: u64) -> Self {
        Limiter {
            consecutive: persisted,
            until_ms: now_ms + backoff_ms(persisted),
            dirty: false,
            boot_fails: 0,
        }
    }

    /// May a verification run now?
    pub fn check(&self, now_ms: u64) -> Result<(), Reject> {
        if now_ms < self.until_ms {
            let wait = (self.until_ms - now_ms).min(u32::MAX as u64) as u32;
            return Err(Reject::RateLimited { retry_ms: wait });
        }
        Ok(())
    }

    /// Record a failed tag at `now_ms`.
    pub fn fail(&mut self, now_ms: u64) {
        self.consecutive = self.consecutive.saturating_add(1);
        self.boot_fails = self.boot_fails.saturating_add(1);
        self.until_ms = now_ms + backoff_ms(self.consecutive);
        self.dirty = true;
    }

    /// Record a good tag: clears the streak (one persisted write if it was set).
    pub fn success(&mut self) {
        if self.consecutive != 0 {
            self.consecutive = 0;
            self.dirty = true;
        }
        self.until_ms = 0;
    }

    /// The value to persist.
    pub fn persisted(&self) -> u32 {
        self.consecutive
    }

    /// Whether [`Limiter::persisted`] changed since the last call.
    pub fn take_dirty(&mut self) -> bool {
        core::mem::take(&mut self.dirty)
    }
}
