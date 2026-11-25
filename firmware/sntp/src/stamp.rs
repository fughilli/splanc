//! The hardware RX timestamp on the monotonic clock.
//!
//! The C6 MAC stamps every received frame (the RX vector's 1 MHz counter) at
//! the radio; the loop task reaps it some time later. The counter runs a fixed
//! offset from `esp_timer` (unknown, not drifting measurably over seconds), so
//! `reap − stamp` is that offset plus the frame's reap lag, and its minimum
//! over the frames of a short window is the offset plus the smallest lag (a
//! frame reaped promptly). A frame's arrival is then
//!
//! ```text
//! arrival = reap − ((reap − stamp) − min_lag)
//! ```
//!
//! [`RxFloor`] keeps that minimum while an SNTP request is out (beacons alone
//! give ~10 frames a second), so the reply's T4 is the radio's, not the loop's
//! (a TLS record or a flash write in the loop can delay the reap by tens of
//! ms). The same rule as the mesh's M3 fallback (`splanc_mesh::wifi_p2p::RxClock`).

/// A frame whose mapped lag exceeds this is not corrected (its stamp is
/// implausible), µs.
pub const MAX_CORRECTION_US: i64 = 200_000;

/// The reap-lag floor over one window.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RxFloor {
    min_lag: Option<i32>,
    frames: u32,
}

impl RxFloor {
    pub const fn new() -> Self {
        RxFloor {
            min_lag: None,
            frames: 0,
        }
    }

    /// Starts a new window (forgets the floor).
    pub fn reset(&mut self) {
        *self = RxFloor::new();
    }

    /// Wrap-safe lag of a frame: the 32-bit difference.
    fn lag(reap_us: i64, hw_us: u32) -> i32 {
        (reap_us as u32).wrapping_sub(hw_us) as i32
    }

    /// A frame reaped at `reap_us` (mono) with RX-vector stamp `hw_us`.
    pub fn note(&mut self, reap_us: i64, hw_us: u32) {
        let l = Self::lag(reap_us, hw_us);
        self.min_lag = Some(self.min_lag.map_or(l, |m| m.min(l)));
        self.frames = self.frames.saturating_add(1);
    }

    /// Frames seen this window.
    pub fn frames(&self) -> u32 {
        self.frames
    }

    /// The arrival (mono µs) of a frame reaped at `reap_us` with stamp `hw_us`
    /// (already [`note`](Self::note)d). `reap_us` itself when there is no floor
    /// or the correction is implausible.
    pub fn arrival(&self, reap_us: i64, hw_us: u32) -> i64 {
        let Some(m) = self.min_lag else {
            return reap_us;
        };
        let c = Self::lag(reap_us, hw_us) as i64 - m as i64;
        if (0..=MAX_CORRECTION_US).contains(&c) {
            reap_us - c
        } else {
            reap_us
        }
    }
}
