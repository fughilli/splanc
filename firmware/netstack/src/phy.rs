//! WiFi PHY / RF bring-up.
//!
//! The PHY comes up in stages, each building on the last:
//!
//! 1. **Bus primitives** — `regs::pbus` (force-mode + banked readback, done) and
//!    `regs::i2c_rf` (read done; write not yet implemented). Nothing above works
//!    until these are in place.
//! 2. **PLL / bias bring-up** — program the BBPLL and analog bias.
//! 3. **Baseband / AGC init** — load the baseband and automatic-gain-control
//!    register defaults.
//! 4. **Channel programming** — set the operating channel and filters.
//! 5. **Calibration** — RX / TX / analog calibration; the largest and most
//!    sequence-sensitive step.
//! 6. **CCA / TX enable** — clear-channel assessment and transmit enable.
//!
//! Stages 2-6 are not yet implemented.

/// PHY bring-up entry point. Not yet implemented: it requires the PLL/bias,
/// baseband, and calibration sequences to be in place first.
pub fn init() {
    unimplemented!("PHY init: bring-up sequence not yet implemented")
}

/// Program the operating channel. Not yet implemented: it depends on the
/// channel-programming and calibration stages.
pub fn set_channel(_chan: u8) {
    unimplemented!("set_channel: channel programming not yet implemented")
}
