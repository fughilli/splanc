//! Which Splanc MAX board an image is for (docs/design/max-ota.md "One artifact
//! per board").
//!
//! Every board needs its own kernel, firmware and device tree, so each one gets its
//! own artifact, and the board travels in the signed manifest: bits 24..31 of
//! `flags` (bits 8..15 are the key id and 16..23 the security version, as on the
//! C6). The MAX trusts the C6's signing keys (docs/design/max-ota.md "Signing"),
//! so this signed field is the WHOLE separation: a C6 image (board 0) is refused
//! here as `wrong_board`, and the C6 refuses any board but 0 (splanc_ota
//! `session::check_offer`).

use splanc_ota::keyring;
use splanc_ota::manifest;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Board {
    Pi3 = 1,
    Pi4 = 2,
    Pi5 = 3,
    Zero2W = 4,
}

pub const ALL: [Board; 4] = [Board::Pi3, Board::Pi4, Board::Pi5, Board::Zero2W];

impl Board {
    pub fn id(self) -> u8 {
        self as u8
    }

    pub fn from_id(id: u8) -> Option<Board> {
        ALL.into_iter().find(|b| b.id() == id)
    }

    /// The short name in asset names (`max-pi3-1.10.0.nixclosure`) and OtaStatus.board.
    pub fn name(self) -> &'static str {
        match self {
            Board::Pi3 => "pi3",
            Board::Pi4 => "pi4",
            Board::Pi5 => "pi5",
            Board::Zero2W => "zero2w",
        }
    }

    pub fn from_name(s: &str) -> Option<Board> {
        ALL.into_iter().find(|b| b.name() == s.trim())
    }

    /// The nixos-raspberrypi board the image is built for (sbc-deploy's `board`).
    pub fn sbc_board(self) -> &'static str {
        match self {
            Board::Pi3 => "raspberry-pi-3",
            Board::Pi4 => "raspberry-pi-4",
            Board::Pi5 => "raspberry-pi-5",
            Board::Zero2W => "raspberry-pi-02",
        }
    }

    /// From the hardware's `/proc/device-tree/model` (e.g. "Raspberry Pi 3 Model B
    /// Plus Rev 1.3"), the same identity sbc-deploy's brick guard checks.
    pub fn from_model(model: &str) -> Option<Board> {
        let m = model.trim_end_matches('\0').trim();
        let has = |p: &str| m.starts_with(p);
        if has("Raspberry Pi Zero 2") {
            Some(Board::Zero2W)
        } else if has("Raspberry Pi 3") || has("Raspberry Pi Compute Module 3") {
            Some(Board::Pi3)
        } else if has("Raspberry Pi 4") || has("Raspberry Pi 400") || has("Raspberry Pi Compute Module 4") {
            Some(Board::Pi4)
        } else if has("Raspberry Pi 5") || has("Raspberry Pi 500") || has("Raspberry Pi Compute Module 5") {
            Some(Board::Pi5)
        } else {
            None
        }
    }

    /// Whether the updater can boot a new system once and fall back by itself
    /// (docs/design/max-ota.md "Trial boot"). U-Boot boards take the one-shot
    /// `splanc-trial` flag; the Pi 5 boots its kernel straight from the firmware
    /// (no U-Boot) and needs the firmware's tryboot instead, which isn't wired yet.
    pub fn trial_boot(self) -> TrialBoot {
        match self {
            Board::Pi3 | Board::Pi4 | Board::Zero2W => TrialBoot::UBoot,
            Board::Pi5 => TrialBoot::Unsupported,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrialBoot {
    UBoot,
    Unsupported,
}

/// The board id in a manifest's flags (bits 24..31; 0 = not a MAX image).
pub fn board_id(flags: u32) -> u8 {
    manifest::board(flags)
}

/// flags for a MAX manifest: key id, security version and board.
pub fn flags(key_id: u8, security_version: u8, board: Board) -> u32 {
    keyring::flags(key_id, security_version) | ((board.id() as u32) << manifest::BOARD_SHIFT)
}
