//! Framerate autoscaler (FUG-82): keep effects at a *consistent* FPS by picking
//! a target from a fixed ladder and adapting it to the effect's real per-frame
//! cost on this device.
//!
//! The player runs `.fxb` shader effects whose per-frame cost (update + per-LED
//! shade + the FastLED strip write) varies wildly with the program and the LED
//! count, in soft-float on the C6. A fixed frame period therefore either wastes
//! headroom (cheap effect) or starves the WiFi/BLE tasks and stutters (heavy
//! effect). This controller closes the loop:
//!
//! - **Ladder.** Targets live on a 5-fps grid from [`LADDER_MIN_FPS`] to
//!   [`MAX_FPS`] (5..80). Discrete steps make the cadence legible to the app and
//!   damp oscillation vs. a continuous controller.
//! - **5% headroom.** A frame is *missed* when its measured cost exceeds
//!   [`HEADROOM_PCT`]% of the current target's period — i.e. we want at least
//!   5% of every frame period left for the other threads.
//! - **x/N window.** Over a sliding window of [`WINDOW_N`] frames, if more than
//!   [`miss_limit`](FpsController::miss_limit) frames were missed, drop one
//!   rung. A clean window whose worst frame still fits the *next* rung's
//!   headroom budget steps up one rung.
//! - **Lag, never park.** The autoscaler's lowest target is the floor
//!   ([`MIN_FPS`] = 25 fps for a strip of up to 512 LEDs, proportionally lower
//!   for a longer one — see [`floor_fps_for`]). An effect that can't hold even
//!   the floor (or a user-pinned rate) is NOT stopped: it keeps rendering as
//!   fast as it can, and the controller reports it as
//!   [`lagging`](FpsController::lagging) with the rate it really achieves
//!   ([`current_fps`](FpsController::current_fps)). A slow effect lags; it is
//!   never blanked or parked for being slow. (Before, a failing floor window
//!   "aborted" and the player parked the effect — on a fixture that looked like
//!   the show cutting out.)
//! - **Override.** The app can pin an exact target with [`set_target`]; the
//!   controller stops autoscaling and holds that rung (lagging, not parked, if
//!   the effect can't keep it).
//! - **Wire ceiling.** The WS2812 wire itself bounds the rate: 24 bits at
//!   ~833 kHz is [`WIRE_NS_PER_LED`] = 28.8 µs per LED, plus the latch low, on the
//!   LONGEST channel (the two channels clock out in parallel). The caller reports
//!   that floor with [`set_wire_us`](FpsController::set_wire_us); the ladder never
//!   climbs (and a pin never lands) above the highest rung whose headroom budget
//!   still holds one wire frame, and a frame that is slow ONLY because the wire is
//!   is not the effect's fault — it never counts as a miss.
//! - **Bounded render duty cycle.** What keeps the device responsive under a
//!   slow effect is the sleep between frames, not parking: a frame within its
//!   period sleeps the rest of it (≥ 5% of the wall clock, [`min_yield_ms`]); a
//!   frame that overran its period sleeps at least [`overrun_yield_ms`] — a
//!   [`MIN_SLICE_MS`] slice and ≥ (100 − [`RENDER_DUTY_PCT`])% of the wall clock —
//!   so the network loop, the IMU sampler and TLS are always serviced between
//!   frames, however heavy the effect.
//!
//! Pure, `no_std`, zero-dependency, integer-only (no hardware f64 on the C6) so
//! it unit-tests on the host and compiles unchanged for the device.

#![no_std]

/// The autoscaler's floor, in FPS, for a strip of up to [`FLOOR_REF_LEDS`] LEDs:
/// the lowest rung it targets. An effect that can't hold it runs as fast as it
/// can (lagging) — it is never parked. A longer strip's floor scales down with
/// its length ([`floor_fps_for`]) — shading 2048 LEDs at 10 fps is the same
/// per-LED throughput as 512 at 40 — so a big fixture gets a steady slower
/// cadence for heavy effects.
pub const MIN_FPS: u32 = 25;
/// Strip length the [`MIN_FPS`] floor is defined for (the LED cap before 1024
/// LEDs per channel): the floor holds 25 x 512 = 12,800 shaded LEDs/s.
pub const FLOOR_REF_LEDS: u32 = 512;
/// The ladder's bottom rung: the lowest floor a long strip can scale down to.
pub const LADDER_MIN_FPS: u32 = 5;
/// Above the ceiling there is nothing to gain from a faster strip write than
/// the eye resolves.
pub const MAX_FPS: u32 = 80;
/// Ladder step. Rungs are LADDER_MIN_FPS, LADDER_MIN_FPS+STEP, ..., MAX_FPS.
pub const FPS_STEP: u32 = 5;

/// The autoscaler floor for a strip of `leds` shaded LEDs: [`MIN_FPS`] up to
/// [`FLOOR_REF_LEDS`], then the rung (rounded down) that keeps the same shaded
/// LEDs per second, never below [`LADDER_MIN_FPS`] (1024 LEDs -> 10 fps,
/// 2048 -> 5 fps).
#[inline]
pub fn floor_fps_for(leds: u32) -> u32 {
    if leds <= FLOOR_REF_LEDS {
        return MIN_FPS;
    }
    let f = (MIN_FPS * FLOOR_REF_LEDS) / leds;
    ((f / FPS_STEP) * FPS_STEP).max(LADDER_MIN_FPS)
}
/// WS2812 wire time per LED, in ns: 24 bits x 1.2 µs. Both C6 backends clock
/// each bit as three 400 ns samples (0.4/0.8 µs high, 1.2 µs period — inside the
/// WS2812 1.25 µs ± 600 ns window), so this is 28.8 µs, a hair under the
/// nominal 800 kHz's 30 µs.
pub const WIRE_NS_PER_LED: u32 = 28_800;
/// The latch (reset) low after a frame's last bit before the strip shows it:
/// WS2812B-V5 and later need >= 280 µs (the original WS2812 50 µs).
pub const LATCH_US: u32 = 300;
/// Measured transmit spans jitter a little over the ideal wire time (DMA
/// set-up, the transmit task's wake-up): a frame within this of the wire floor
/// is the wire's cost, not the effect's.
pub const WIRE_SLACK_US: u32 = 1_000;

/// Wire time of one frame whose longest channel carries `leds` LEDs (channels
/// clock out in parallel), including the latch. 0 LEDs = no wire floor.
#[inline]
pub fn wire_frame_us(leds: u32) -> u32 {
    if leds == 0 {
        0
    } else {
        ((leds as u64 * WIRE_NS_PER_LED as u64) / 1000) as u32 + LATCH_US
    }
}

/// Number of rungs on the ladder (5,10,...,80 = 16).
pub const LADDER_LEN: u32 = (MAX_FPS - LADDER_MIN_FPS) / FPS_STEP + 1;

/// A frame "misses" when its cost exceeds this percent of the target period —
/// i.e. we insist on (100 - this)% = 5% headroom for the other tasks.
pub const HEADROOM_PCT: u32 = 95;

/// The most of the wall clock a frame that overran its period may take: such a
/// frame then sleeps ≥ (100 − this)% ([`overrun_yield_ms`]). 80% render / 20%
/// for the network loop, the IMU sampler and TLS — under a heavy effect that
/// used to win ~95% of the CPU the IMU fell from 100 Hz to ~11 Hz with FIFO
/// overflows (PixieLamp bootloop log).
pub const RENDER_DUTY_PCT: u32 = 80;
/// The shortest sleep after a frame that overran its period, in ms: a slice
/// long enough for the lower/equal-priority tasks to run a full pass (the
/// netstack RX drain + TLS pump, an I2C FIFO read) whatever the frame cost.
pub const MIN_SLICE_MS: u32 = 4;

/// Frames per evaluation window. ~1 s at 30 fps: long enough that one stray
/// WiFi/BLE IRQ stealing a frame doesn't trigger a step, short enough to react
/// within a second.
pub const WINDOW_N: u32 = 30;

/// Default starting rung: 30 fps (the historical fixed rate). The controller
/// climbs from here when there is headroom, so a fresh effect never opens with
/// a visible stutter while it finds its ceiling.
pub const DEFAULT_FPS: u32 = 30;

/// FPS of ladder index `i` (0 = LADDER_MIN_FPS). Saturates at the ceiling.
#[inline]
pub fn fps_at(idx: u32) -> u32 {
    let f = LADDER_MIN_FPS + idx.min(LADDER_LEN - 1) * FPS_STEP;
    if f > MAX_FPS {
        MAX_FPS
    } else {
        f
    }
}

/// Ladder index whose rung is closest to `fps`, clamped to
/// [LADDER_MIN_FPS, MAX_FPS]. A user override that isn't exactly on the grid
/// snaps to the nearest rung.
#[inline]
pub fn idx_for_fps(fps: u32) -> u32 {
    let clamped = fps.clamp(LADDER_MIN_FPS, MAX_FPS);
    // Round to the nearest step rather than truncating.
    ((clamped - LADDER_MIN_FPS) + FPS_STEP / 2) / FPS_STEP
}

/// Target-period in microseconds for `fps` (integer; 80 fps = 12_500 µs).
#[inline]
pub fn period_us(fps: u32) -> u32 {
    if fps == 0 {
        return 1_000_000;
    }
    1_000_000 / fps
}

/// The controller's decision after a frame: how long to sleep before the next
/// one. (There is no "stop" decision: a slow effect lags, it is never parked.)
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Decision {
    /// Milliseconds to sleep before rendering the next frame (period − work),
    /// so the *interval* between frame starts tracks the target period. Always
    /// at least 1 ms so the render task yields, and at least
    /// [`overrun_yield_ms`] after a frame that overran its period.
    pub delay_ms: u32,
}

/// Framerate autoscaler state. One instance drives the active effect; reset it
/// when the effect changes so a new program starts its own search.
#[derive(Clone, Copy, Debug)]
pub struct FpsController {
    /// Current ladder index (autoscaled, or held at the pinned rung).
    idx: u32,
    /// User-pinned target FPS (snapped to a rung), or 0 for autoscale.
    pinned_fps: u32,
    /// Frames counted in the current window.
    win_frames: u32,
    /// Frames in the current window that missed the headroom budget.
    win_missed: u32,
    /// Worst (largest) frame cost seen this window, in µs — gates step-up.
    win_max_cost_us: u32,
    /// Sum of this window's frame intervals (cost + the sleep after it), in µs.
    win_interval_us: u32,
    /// The rate the last closed window really ran at (0 = no window yet).
    achieved_fps: u32,
    /// The last window failed at the floor / pinned rung: the effect runs as
    /// fast as it can, below the target. Cleared by a window that holds.
    lagging: bool,
    /// The WS2812 wire floor of the frames being shown, in µs (0 = unknown /
    /// none): a hardware property of the strip lengths, so it survives reset.
    wire_us: u32,
    /// LEDs each frame shades (0 = unknown): sets the floor
    /// ([`floor_fps_for`]). Survives reset, like the wire floor.
    leds: u32,
}

impl Default for FpsController {
    fn default() -> Self {
        Self::new()
    }
}

impl FpsController {
    pub const fn new() -> Self {
        FpsController {
            idx: (DEFAULT_FPS - LADDER_MIN_FPS) / FPS_STEP,
            pinned_fps: 0,
            win_frames: 0,
            win_missed: 0,
            win_max_cost_us: 0,
            win_interval_us: 0,
            achieved_fps: 0,
            lagging: false,
            wire_us: 0,
            leds: 0,
        }
    }

    /// Reset to a fresh search (new effect loaded / (de)activated). A user pin
    /// is preserved — the app's chosen rate should survive an effect reload —
    /// but the window and the lag state clear so the new program starts clean.
    pub fn reset(&mut self) {
        self.idx = self.clamp_idx(if self.pinned_fps != 0 {
            idx_for_fps(self.pinned_fps)
        } else {
            (DEFAULT_FPS - LADDER_MIN_FPS) / FPS_STEP
        });
        self.clear_window();
        self.achieved_fps = 0;
        self.lagging = false;
    }

    fn clear_window(&mut self) {
        self.win_frames = 0;
        self.win_missed = 0;
        self.win_max_cost_us = 0;
        self.win_interval_us = 0;
    }

    /// The ladder rung the controller targets now (the cadence it paces to).
    pub fn rung_fps(&self) -> u32 {
        fps_at(self.idx)
    }

    /// The rate the effect runs at now: the rung while it holds it, the rate it
    /// really achieves (below the rung) while [`lagging`](Self::lagging).
    pub fn current_fps(&self) -> u32 {
        let rung = self.rung_fps();
        if self.lagging && self.achieved_fps > 0 {
            self.achieved_fps.min(rung)
        } else {
            rung
        }
    }

    /// The measured rate of the last closed window (0 before the first one).
    pub fn achieved_fps(&self) -> u32 {
        self.achieved_fps
    }

    /// True while the effect can't hold even the floor (or the pinned rate)
    /// and is running as fast as it can below it. Advisory only: nothing is
    /// stopped.
    pub fn lagging(&self) -> bool {
        self.lagging
    }

    /// Report the wire floor of the frames being shown ([`wire_frame_us`] of the
    /// longest channel). Cheap; the render loop calls it every frame. A rung
    /// above the new ceiling (a strip just grew) is clamped down immediately.
    pub fn set_wire_us(&mut self, us: u32) {
        if us == self.wire_us {
            return;
        }
        self.wire_us = us;
        let ceil = self.ceiling_idx();
        if self.is_pinned() {
            // A pin tracks the wire both ways: held at the ceiling while the strip
            // is too long for it, back on the asked rung once it isn't.
            self.idx = self.clamp_idx(idx_for_fps(self.pinned_fps));
        } else if self.idx > ceil {
            self.idx = ceil;
        }
    }

    /// Report how many LEDs each frame shades: a strip past [`FLOOR_REF_LEDS`]
    /// lowers the floor ([`floor_fps_for`]), so its heavy effects step down to a
    /// steady slower rung. A rung below a risen floor (the strip got shorter) is
    /// lifted to it.
    pub fn set_leds(&mut self, leds: u32) {
        if leds == self.leds {
            return;
        }
        self.leds = leds;
        if self.is_pinned() {
            self.idx = self.clamp_idx(idx_for_fps(self.pinned_fps));
        } else {
            let lift = self.floor_idx().min(self.ceiling_idx());
            if self.idx < lift {
                self.idx = lift;
            }
        }
    }

    /// The autoscaler floor for the reported strip ([`MIN_FPS`] until one is):
    /// the lowest rung it targets; below it an effect lags, it isn't parked.
    pub fn min_fps(&self) -> u32 {
        floor_fps_for(self.leds)
    }

    /// `i` held to [floor, ceiling]; the wire ceiling wins when it is the lower.
    fn clamp_idx(&self, i: u32) -> u32 {
        i.max(self.floor_idx()).min(self.ceiling_idx())
    }

    /// Ladder index of [`min_fps`](Self::min_fps).
    fn floor_idx(&self) -> u32 {
        idx_for_fps(self.min_fps())
    }

    /// The wire floor last reported via [`set_wire_us`](Self::set_wire_us).
    pub fn wire_us(&self) -> u32 {
        self.wire_us
    }

    /// The highest ladder index the wire allows: the fastest rung whose headroom
    /// budget still fits one wire frame (the floor when even it doesn't — the
    /// wire then sets the rate and the effect isn't blamed for it).
    pub fn ceiling_idx(&self) -> u32 {
        let mut i = LADDER_LEN - 1;
        while i > 0 && headroom_budget_us(period_us(fps_at(i))) < self.wire_us {
            i -= 1;
        }
        i
    }

    /// The fastest rate this strip's wire allows ([`MAX_FPS`] when unbounded).
    pub fn max_fps(&self) -> u32 {
        fps_at(self.ceiling_idx())
    }

    /// True when the wire alone can't fit even the current rung's budget.
    fn wire_bound(&self) -> bool {
        self.wire_us > headroom_budget_us(period_us(self.rung_fps()))
    }

    /// User-pinned FPS (0 = autoscale).
    pub fn pinned_fps(&self) -> u32 {
        self.pinned_fps
    }

    /// True while the app has pinned a fixed rate.
    pub fn is_pinned(&self) -> bool {
        self.pinned_fps != 0
    }

    /// Miss threshold: drop a rung when a window has *more than* this many
    /// missed frames. x/N = a quarter of the window (rounded down).
    pub fn miss_limit(&self) -> u32 {
        WINDOW_N / 4
    }

    /// Pin the target to `fps` (snapped to the ladder), or pass 0 to return to
    /// autoscale. Clears the window + lag state so the new mode starts fresh;
    /// an autoscale hand-back keeps the current rung as its starting point.
    pub fn set_target(&mut self, fps: u32) {
        if fps == 0 {
            self.pinned_fps = 0;
        } else {
            let idx = idx_for_fps(fps);
            self.pinned_fps = fps_at(idx);
            // A pin above the wire ceiling runs at the ceiling (no strip can be
            // driven faster than its wire), one below the floor at the floor; the
            // pin itself is kept as asked.
            self.idx = self.clamp_idx(idx);
        }
        self.clear_window();
        self.lagging = false;
    }

    /// Account for one rendered frame whose measured cost (update + shade +
    /// show) was `cost_us`, and return how long to sleep before the next one.
    ///
    /// The window drives the rung: on the N-th frame we drop if too many missed,
    /// or step up if the window was clean and the next rung would still fit. A
    /// floor/pinned failure marks the effect lagging (it keeps running). The
    /// returned delay is period−work so the frame *interval* holds the target,
    /// not work+period — and never less than the bounded-duty-cycle yield.
    pub fn on_frame(&mut self, cost_us: u32) -> Decision {
        let period = period_us(self.rung_fps());
        let headroom_budget = headroom_budget_us(period);

        self.win_frames += 1;
        // A frame no slower than the wire floor is the wire's cost: only when the
        // wire alone overruns this rung (the ceiling is the floor rung) does that
        // matter, and then it isn't a miss — the effect can't fix the wire.
        let miss_over = if self.wire_bound() {
            headroom_budget.max(self.wire_us.saturating_add(WIRE_SLACK_US))
        } else {
            headroom_budget
        };
        if cost_us > miss_over {
            self.win_missed += 1;
        }
        if cost_us > self.win_max_cost_us {
            self.win_max_cost_us = cost_us;
        }

        // Sleep = period − work already spent this frame, so successive frame
        // starts land one period apart regardless of how long the frame took.
        // Round to whole ms (the render task's vTaskDelay is ms-granular) and
        // never sleep less than the minimum yield (≥1 ms and ≥5% of the wall
        // clock — see min_yield_ms). A frame that overran its period instead
        // sleeps the bounded-duty-cycle slice (overrun_yield_ms): the effect lags,
        // the rest of the device keeps being serviced.
        let delay_ms = if cost_us > period {
            overrun_yield_ms(cost_us)
        } else {
            let remaining_us = period - cost_us;
            ((remaining_us + 500) / 1000).max(min_yield_ms(cost_us))
        };
        self.win_interval_us = self
            .win_interval_us
            .saturating_add(cost_us.saturating_add(delay_ms.saturating_mul(1000)));

        if self.win_frames >= WINDOW_N {
            self.evaluate_window();
        }

        Decision { delay_ms }
    }

    /// Close the current window: decide whether to drop, hold or step up, and
    /// whether the effect is lagging, then reset the window counters.
    fn evaluate_window(&mut self) {
        let missed = self.win_missed;
        let max_cost = self.win_max_cost_us;
        let over_limit = missed > self.miss_limit();
        if self.win_interval_us > 0 {
            // Rounded frames-per-second of the window just closed.
            let us = self.win_interval_us as u64;
            self.achieved_fps = ((self.win_frames as u64 * 1_000_000 + us / 2) / us) as u32;
        }

        if over_limit {
            // Too many missed frames at this rung.
            if self.idx <= self.floor_idx() || self.is_pinned() {
                // Already at the floor, or the app pinned this rate: hold the rung
                // and let the effect run as fast as it can below it. Lagging is
                // reported, never acted on — the show goes on.
                self.lagging = true;
            } else {
                // Back off one rung and try again.
                self.idx -= 1;
            }
        } else {
            self.lagging = false;
            if !self.is_pinned() && missed == 0 && self.idx < self.ceiling_idx() {
                // Clean window and room to climb: step up only if the worst frame
                // we saw would still leave 5% headroom at the FASTER rung, so we
                // don't immediately bounce back down.
                let next_period = period_us(fps_at(self.idx + 1));
                if max_cost <= headroom_budget_us(next_period) {
                    self.idx += 1;
                }
            }
        }

        self.clear_window();
    }
}

/// The shortest sleep after an in-period frame that cost `cost_us`: at least
/// 1 ms, and at least `cost × (100 − HEADROOM_PCT) / HEADROOM_PCT` (rounded up)
/// so the render task — which outranks or ties every other task — always cedes
/// ≥ 5% of the wall clock.
#[inline]
pub fn min_yield_ms(cost_us: u32) -> u32 {
    let free_us = (cost_us as u64 * (100 - HEADROOM_PCT) as u64).div_ceil(HEADROOM_PCT as u64);
    (free_us.div_ceil(1000) as u32).max(1)
}

/// The sleep after a frame that overran its period (a lagging effect, or one
/// the window hasn't stepped down yet): at least [`MIN_SLICE_MS`], and at least
/// `cost × (100 − RENDER_DUTY_PCT) / RENDER_DUTY_PCT` (rounded up), so a slow
/// effect takes at most [`RENDER_DUTY_PCT`]% of the wall clock and the network
/// loop, sensors and TLS always get a real slice between its frames.
#[inline]
pub fn overrun_yield_ms(cost_us: u32) -> u32 {
    let free_us =
        (cost_us as u64 * (100 - RENDER_DUTY_PCT) as u64).div_ceil(RENDER_DUTY_PCT as u64);
    (free_us.div_ceil(1000) as u32).max(MIN_SLICE_MS)
}

/// The per-frame cost ceiling that still leaves the required headroom.
#[inline]
fn headroom_budget_us(period_us: u32) -> u32 {
    // period * HEADROOM_PCT / 100, computed in u64 to avoid overflow (period is
    // ≤ 1_000_000 for the 1-fps floor, so u32 would actually be fine, but keep
    // it robust).
    ((period_us as u64 * HEADROOM_PCT as u64) / 100) as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    // Cost (µs) that lands exactly at the headroom budget for `fps` (the
    // largest cost that is NOT a miss), and one microsecond over it (a miss).
    fn budget(fps: u32) -> u32 {
        headroom_budget_us(period_us(fps))
    }
    fn just_missing(fps: u32) -> u32 {
        budget(fps) + 1
    }
    fn comfortable(_fps: u32) -> u32 {
        // Well under budget so even the faster rung's budget is satisfied.
        period_us(MAX_FPS) / 3
    }

    #[test]
    fn ladder_maps_indices_and_fps() {
        assert_eq!(LADDER_LEN, 16);
        assert_eq!(fps_at(0), 5);
        assert_eq!(fps_at(4), 25);
        assert_eq!(fps_at(5), 30);
        assert_eq!(fps_at(15), 80);
        assert_eq!(fps_at(99), 80); // saturates
        assert_eq!(idx_for_fps(5), 0);
        assert_eq!(idx_for_fps(25), 4);
        assert_eq!(idx_for_fps(80), 15);
        assert_eq!(idx_for_fps(1), 0); // clamps up to the ladder bottom
        assert_eq!(idx_for_fps(200), 15); // clamps down to the ceiling
        assert_eq!(idx_for_fps(58), idx_for_fps(60)); // snaps to nearest rung
        assert_eq!(fps_at(idx_for_fps(58)), 60);
    }

    #[test]
    fn starts_at_default_rung() {
        let c = FpsController::new();
        assert_eq!(c.current_fps(), DEFAULT_FPS);
        assert!(!c.is_pinned());
    }

    #[test]
    fn holds_target_when_frames_are_cheap() {
        let mut c = FpsController::new();
        // Cheap enough for 30 but not for 35 (so it holds, doesn't climb).
        let cost = budget(30);
        for _ in 0..WINDOW_N {
            c.on_frame(cost);
        }
        assert_eq!(c.current_fps(), 30);
        assert!(!c.lagging());
    }

    #[test]
    fn climbs_when_there_is_headroom() {
        let mut c = FpsController::new();
        let cheap = comfortable(80);
        // Each clean window should bump one rung until it reaches the ceiling.
        for _ in 0..(LADDER_LEN * WINDOW_N) {
            c.on_frame(cheap);
        }
        assert_eq!(c.current_fps(), MAX_FPS);
    }

    #[test]
    fn does_not_climb_if_next_rung_would_miss() {
        let mut c = FpsController::new();
        // Fits 30's budget with zero misses, but exceeds 35's budget — so a
        // clean window must NOT step up (it would immediately drop back).
        let cost = budget(35) + 1; // a miss at 35, comfortable at 30
        assert!(cost <= budget(30));
        for _ in 0..(WINDOW_N * 3) {
            c.on_frame(cost);
        }
        assert_eq!(c.current_fps(), 30);
    }

    #[test]
    fn drops_a_rung_when_too_many_missed() {
        let mut c = FpsController::new();
        c.set_target(0); // autoscale
        // Force it up to a high rung first with cheap frames.
        for _ in 0..(LADDER_LEN * WINDOW_N) {
            c.on_frame(comfortable(80));
        }
        assert_eq!(c.current_fps(), MAX_FPS);
        // Now every frame misses the top rung's budget -> it should step down.
        let start = c.current_fps();
        for _ in 0..WINDOW_N {
            c.on_frame(just_missing(start));
        }
        assert!(c.current_fps() < start);
    }

    #[test]
    fn tolerates_a_few_misses_under_the_limit() {
        let mut c = FpsController::new();
        // miss_limit misses in a window (not MORE than the limit) must NOT drop.
        let limit = c.miss_limit();
        for i in 0..WINDOW_N {
            let cost = if i < limit {
                just_missing(30)
            } else {
                budget(30)
            };
            c.on_frame(cost);
        }
        assert_eq!(c.current_fps(), 30);
    }

    #[test]
    fn lags_at_the_floor_instead_of_parking() {
        let mut c = FpsController::new();
        // Every frame blows even 25 fps (110 ms: the PixieLamp effect, ~9 fps).
        let cost = 110_000;
        for _ in 0..(LADDER_LEN * WINDOW_N * 2) {
            let d = c.on_frame(cost);
            assert!(d.delay_ms >= MIN_SLICE_MS);
        }
        // The rung holds the floor; the effect runs flat out below it, reported
        // as lagging with the rate it really achieves — never stopped.
        assert_eq!(c.rung_fps(), MIN_FPS);
        assert!(c.lagging());
        let interval = cost + overrun_yield_ms(cost) * 1000;
        let want = (1_000_000 + interval / 2) / interval;
        assert_eq!(c.achieved_fps(), want);
        assert_eq!(c.current_fps(), want, "reports the achieved rate while lagging");
        assert!(c.current_fps() >= 7, "{} fps", c.current_fps());
        // The effect gets lighter: a holding window clears the lag.
        for _ in 0..WINDOW_N {
            c.on_frame(budget(MIN_FPS));
        }
        assert!(!c.lagging());
        assert_eq!(c.current_fps(), MIN_FPS);
    }

    #[test]
    fn a_lagging_effect_still_yields_a_bounded_slice_every_frame() {
        // Render duty under overload is at most RENDER_DUTY_PCT, with at least a
        // MIN_SLICE_MS sleep, whatever the frame costs.
        for cost in [40_001u32, 50_000, 110_000, 130_000, 500_000, 2_000_000] {
            let y = overrun_yield_ms(cost) * 1000;
            assert!(y >= MIN_SLICE_MS * 1000);
            assert!(
                (cost as u64) * 100 <= (cost as u64 + y as u64) * RENDER_DUTY_PCT as u64,
                "{cost}: render took more than {RENDER_DUTY_PCT}%"
            );
        }
        let mut c = FpsController::new();
        assert_eq!(c.on_frame(110_000).delay_ms, overrun_yield_ms(110_000));
        assert_eq!(overrun_yield_ms(110_000), 28);
        assert_eq!(overrun_yield_ms(1_000), MIN_SLICE_MS);
    }

    #[test]
    fn pinned_target_does_not_autoscale() {
        let mut c = FpsController::new();
        c.set_target(60);
        assert_eq!(c.current_fps(), 60);
        assert!(c.is_pinned());
        // Cheap frames: a free autoscaler would climb, a pin must stay at 60.
        for _ in 0..(WINDOW_N * 4) {
            c.on_frame(comfortable(80));
        }
        assert_eq!(c.current_fps(), 60);
    }

    #[test]
    fn an_unholdable_pin_lags_and_keeps_the_pin() {
        let mut c = FpsController::new();
        c.set_target(75);
        for _ in 0..(WINDOW_N * 2) {
            c.on_frame(just_missing(75));
        }
        assert!(c.lagging(), "a pinned rate it can't hit lags, it isn't dropped or parked");
        assert_eq!(c.rung_fps(), 75); // stayed pinned, didn't step down
        assert!(c.current_fps() < 75 && c.current_fps() > 0);
        // A new pin starts clean.
        c.set_target(30);
        assert!(!c.lagging());
    }

    #[test]
    fn unpin_returns_to_autoscale_from_current_rung() {
        let mut c = FpsController::new();
        c.set_target(50);
        assert!(c.is_pinned());
        c.set_target(0);
        assert!(!c.is_pinned());
        assert_eq!(c.current_fps(), 50); // keeps the rung as the new start point
    }

    #[test]
    fn delay_is_period_minus_work() {
        let mut c = FpsController::new(); // 30 fps -> ~33_333 µs period
        let d = c.on_frame(10_000); // 10 ms of work
        // remaining ≈ 23_333 µs -> 23 ms.
        assert_eq!(d.delay_ms, 23);
        // A frame that overran the period yields the bounded-duty slice:
        // 38.3 ms of work -> ceil(38.3 × 20/80) = 10 ms.
        let d2 = c.on_frame(period_us(30) + 5_000);
        assert_eq!(d2.delay_ms, 10);
    }

    #[test]
    fn min_yield_keeps_five_percent_for_the_network() {
        assert_eq!(min_yield_ms(0), 1);
        assert_eq!(min_yield_ms(10_000), 1); // 0.53 ms -> 1 ms floor
        assert_eq!(min_yield_ms(130_000), 7); // the heaviest fx_bench program
        for cost in [1_000u32, 33_000, 40_000, 130_000, 1_000_000] {
            let y = min_yield_ms(cost) * 1000;
            assert!(y * 100 >= (cost + y) * (100 - HEADROOM_PCT), "{cost}: yield {y} µs < 5%");
        }
        // An in-budget frame's period−work sleep already exceeds it.
        let mut c = FpsController::new();
        assert_eq!(c.on_frame(budget(30)).delay_ms, 2);
    }

    #[test]
    fn reset_clears_the_lag() {
        let mut c = FpsController::new();
        for _ in 0..(LADDER_LEN * WINDOW_N) {
            c.on_frame(period_us(MIN_FPS) * 3);
        }
        assert!(c.lagging());
        c.reset();
        assert!(!c.lagging());
        assert_eq!(c.achieved_fps(), 0);
        assert_eq!(c.current_fps(), DEFAULT_FPS);
    }

    #[test]
    fn reset_preserves_pin_but_clears_window() {
        let mut c = FpsController::new();
        c.set_target(45);
        // Accumulate some misses, then reset.
        c.on_frame(just_missing(45));
        c.reset();
        assert_eq!(c.current_fps(), 45); // pin preserved
        assert!(c.is_pinned());
        assert!(!c.lagging());
    }

    // -- wire ceiling (WS2812: 28.8 µs/LED on the longest channel) -------------

    #[test]
    fn wire_frame_time_is_30us_per_led_plus_latch() {
        assert_eq!(wire_frame_us(0), 0);
        assert_eq!(wire_frame_us(1), 28 + LATCH_US);
        assert_eq!(wire_frame_us(512), 14_745 + LATCH_US);
        assert_eq!(wire_frame_us(1024), 29_491 + LATCH_US);
    }

    #[test]
    fn ceiling_is_the_fastest_rung_one_wire_frame_fits() {
        let mut c = FpsController::new();
        assert_eq!(c.max_fps(), MAX_FPS, "no wire floor reported = unbounded");
        // The documented floor table (docs/user-guide.md "Hardware limits").
        for (leds, fps) in [
            (150, 80),
            (300, 80),
            (400, 80),
            (450, 70),
            (512, 60),
            (600, 50),
            (768, 40),
            (900, 35),
            (1024, 30),
        ] {
            c.set_wire_us(wire_frame_us(leds));
            assert_eq!(c.max_fps(), fps, "{leds} LEDs");
            // ...and the rung above really wouldn't fit one wire frame.
            if fps < MAX_FPS {
                assert!(headroom_budget_us(period_us(fps + FPS_STEP)) < wire_frame_us(leds));
            }
        }
    }

    #[test]
    fn never_climbs_above_the_wire_ceiling() {
        let mut c = FpsController::new();
        // 29.8 ms -> 30 fps ceiling.
        c.set_wire_us(wire_frame_us(1024));
        // A trivially cheap effect: the CPU alone would climb to MAX_FPS.
        for _ in 0..(WINDOW_N * 20) {
            c.on_frame(500);
        }
        assert_eq!(c.current_fps(), 30);
    }

    #[test]
    fn a_growing_strip_clamps_the_rung_at_once() {
        let mut c = FpsController::new();
        for _ in 0..(WINDOW_N * 20) {
            c.on_frame(500);
        }
        assert_eq!(c.current_fps(), MAX_FPS);
        c.set_wire_us(wire_frame_us(768));
        assert_eq!(
            c.current_fps(),
            40,
            "clamped on the report, not a window later"
        );
        c.set_wire_us(wire_frame_us(100));
        assert_eq!(
            c.current_fps(),
            40,
            "a shrink doesn't jump; the window climbs"
        );
    }

    #[test]
    fn a_pin_above_the_ceiling_runs_at_the_ceiling_without_lagging() {
        let mut c = FpsController::new();
        c.set_wire_us(wire_frame_us(1024));
        c.set_target(60);
        assert_eq!(c.pinned_fps(), 60, "the pin is kept as asked");
        assert_eq!(c.current_fps(), 30, "but runs at the wire ceiling");
        // Frames cost what the wire costs: never a miss, never lagging.
        for _ in 0..(WINDOW_N * 4) {
            c.on_frame(wire_frame_us(1024) + 200);
        }
        assert!(!c.lagging());
        assert_eq!(c.current_fps(), 30);
        // The strip gets shorter: the pin is honoured again.
        c.set_wire_us(wire_frame_us(256));
        assert_eq!(c.current_fps(), 60);
    }

    #[test]
    fn the_floor_scales_down_with_the_strip() {
        assert_eq!(floor_fps_for(0), MIN_FPS);
        assert_eq!(floor_fps_for(512), MIN_FPS);
        assert_eq!(floor_fps_for(600), 20);
        assert_eq!(floor_fps_for(1024), 10);
        assert_eq!(floor_fps_for(2048), LADDER_MIN_FPS);
        assert_eq!(floor_fps_for(100_000), LADDER_MIN_FPS);
    }

    #[test]
    fn a_heavy_effect_on_a_long_strip_steps_down_to_a_steady_rung() {
        // 2048 LEDs at ~3.6k cycles each (a plasma) = ~46 ms of shading: under
        // the 25 fps floor (38 ms budget) on a 512-LED strip it lags instead.
        let mut c = FpsController::new();
        c.set_wire_us(wire_frame_us(1024)); // two parallel 1024-LED channels
        c.set_leds(2048);
        assert_eq!(c.min_fps(), 5);
        let cost = 46_000;
        for _ in 0..(WINDOW_N * 12) {
            c.on_frame(cost);
        }
        assert!(!c.lagging(), "a long strip's floor is lower");
        assert_eq!(c.current_fps(), 20, "the fastest rung that fits 46 ms");
        // The same cost on a reference-length strip is under its floor: it keeps
        // running, lagging at what it achieves (46 ms + the 12 ms slice ≈ 17 fps).
        let mut c = FpsController::new();
        c.set_leds(512);
        for _ in 0..(WINDOW_N * 12) {
            c.on_frame(cost);
        }
        assert!(c.lagging());
        assert_eq!(c.rung_fps(), MIN_FPS);
        assert_eq!(c.current_fps(), 17);
    }

    #[test]
    fn a_shorter_strip_lifts_the_rung_to_its_floor() {
        let mut c = FpsController::new();
        c.set_leds(2048);
        for _ in 0..(WINDOW_N * 12) {
            c.on_frame(120_000); // ~8 fps of work
        }
        assert_eq!(c.current_fps(), 5);
        c.set_leds(256);
        assert_eq!(c.current_fps(), MIN_FPS, "back on the short strip's floor");
    }

    #[test]
    fn a_wire_bound_floor_flags_lag_only_beyond_the_wire() {
        let mut c = FpsController::new();
        // A wire longer than even the 25-fps budget (38 ms) under the reference
        // floor (no strip length reported, so the floor stays 25 fps): the wire
        // ceiling (40.6 ms fits 20 fps) wins over the floor.
        let wire = wire_frame_us(1400);
        c.set_wire_us(wire);
        assert_eq!(c.min_fps(), MIN_FPS);
        assert_eq!(c.current_fps(), 20);
        for _ in 0..(WINDOW_N * 4) {
            c.on_frame(wire + 300);
        }
        assert!(!c.lagging(), "the wire's own cost is never the effect lagging");
        for _ in 0..WINDOW_N {
            c.on_frame(wire + 10 * WIRE_SLACK_US);
        }
        assert!(
            c.lagging(),
            "an effect slower than the wire lags at the floor (and keeps running)"
        );
    }

    #[test]
    fn reset_keeps_the_wire_ceiling() {
        let mut c = FpsController::new();
        c.set_wire_us(wire_frame_us(1024));
        c.reset();
        assert_eq!(c.wire_us(), wire_frame_us(1024));
        assert_eq!(c.current_fps(), 30);
    }
}
