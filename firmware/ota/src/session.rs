//! The receive side of an update: one image streamed into the app slot in
//! order, stop-and-wait, resumable across a dropped connection or a power cut
//! (docs/design/ota.md "Transfer").
//!
//! Pure bookkeeping — the caller owns the flash. Each chunk is planned
//! ([`Session::plan`]: which sectors to erase, where to write), the caller does
//! the flash operations, then commits ([`Session::commit`]), which says when the
//! progress must be persisted. Progress is one number, the next byte wanted (as
//! in the swarm's page counter), so the resume record is the manifest plus an
//! offset.
//!
//! Power-loss rule: a sector is only ever written after it was erased in this
//! session, and the persisted offset only ever names bytes that were written
//! before it was persisted. Resuming restarts at the persisted offset rounded
//! down to a sector, re-erasing that sector, so a half-programmed sector can't
//! survive into the image. The final word is still the full read-back SHA-256
//! against the signed manifest.

use crate::image::{self, ImageError};
use crate::manifest::{Manifest, ENCODED_LEN, FLAG_LOADER};

pub const SECTOR: u32 = 4096;
/// Largest `ota_chunk.data`: one sector, and what fits the netstack's 6 KiB WS
/// receive buffer with the envelope.
pub const MAX_CHUNK: u32 = 4096;
/// Persist progress at most this often (NVS wear: ~32 writes per 2 MB image).
pub const PERSIST_EVERY: u32 = 64 * 1024;
/// The resume record: the manifest, then the offset (u32 LE).
pub const RESUME_LEN: usize = ENCODED_LEN + 4;

/// What the receiver checks an offer against.
#[derive(Clone, Copy, Debug)]
pub struct Target {
    /// Bytes in the app slot.
    pub slot_size: u32,
    /// `esp_chip_id_t` of this chip.
    pub chip: u16,
    /// Manifest version of the app in the slot (0 = unknown, e.g. USB-flashed:
    /// any version is accepted).
    pub installed_version: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    BadManifest,
    BadSignature,
    /// FLAG_LOADER images are reserved (no loader self-update yet).
    LoaderImage,
    TooLarge,
    Downgrade,
    NoSession,
    OutOfOrder { want: u32 },
    BadChunk,
    Overflow,
    Image(ImageError),
    Incomplete,
    VerifyFailed,
    Flash,
}

impl Refusal {
    /// The machine code carried in `ota_status.error`.
    pub fn code(&self) -> &'static str {
        match self {
            Refusal::BadManifest => "bad_manifest",
            Refusal::BadSignature => "bad_signature",
            Refusal::LoaderImage => "loader_image",
            Refusal::TooLarge => "too_large",
            Refusal::Downgrade => "downgrade",
            Refusal::NoSession => "no_session",
            Refusal::OutOfOrder { .. } => "out_of_order",
            Refusal::BadChunk => "bad_chunk",
            Refusal::Overflow => "overflow",
            Refusal::Image(e) => e.code(),
            Refusal::Incomplete => "incomplete",
            Refusal::VerifyFailed => "verify_failed",
            Refusal::Flash => "flash_error",
        }
    }
}

/// Check an offer before anything is touched: signature (checked by the caller,
/// passed in), the reserved loader flag, size, and version order. Shared by
/// the app (which checks before rebooting into the loader, so a bad manifest
/// costs no reboot) and the loader (which is authoritative).
pub fn check_offer(m: &Manifest, signature_ok: bool, t: &Target, allow_downgrade: bool) -> Result<(), Refusal> {
    if !signature_ok {
        return Err(Refusal::BadSignature);
    }
    if m.flags & FLAG_LOADER != 0 {
        return Err(Refusal::LoaderImage);
    }
    if m.size == 0 {
        return Err(Refusal::BadManifest);
    }
    if m.size > t.slot_size {
        return Err(Refusal::TooLarge);
    }
    if t.installed_version != 0 && m.version < t.installed_version && !allow_downgrade {
        return Err(Refusal::Downgrade);
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Resume {
    pub manifest: Manifest,
    pub offset: u32,
}

impl Resume {
    pub fn encode(&self) -> [u8; RESUME_LEN] {
        let mut b = [0u8; RESUME_LEN];
        b[..ENCODED_LEN].copy_from_slice(&self.manifest.encode());
        b[ENCODED_LEN..].copy_from_slice(&self.offset.to_le_bytes());
        b
    }

    pub fn decode(b: &[u8]) -> Option<Resume> {
        if b.len() != RESUME_LEN {
            return None;
        }
        let manifest = Manifest::decode(&b[..ENCODED_LEN])?;
        let o = &b[ENCODED_LEN..];
        let offset = u32::from_le_bytes([o[0], o[1], o[2], o[3]]);
        (offset <= manifest.size).then_some(Resume { manifest, offset })
    }
}

/// Flash work for one chunk, in order: erase, then write.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Plan {
    /// Sector-aligned (offset, len) to erase first, if any.
    pub erase: Option<(u32, u32)>,
    pub write_at: u32,
    pub len: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Session {
    pub manifest: Manifest,
    next: u32,
    erased: u32,
    persisted: u32,
}

const fn align_down(x: u32) -> u32 {
    x / SECTOR * SECTOR
}

const fn align_up(x: u32) -> u32 {
    x.div_ceil(SECTOR) * SECTOR
}

impl Session {
    /// Start (or resume) receiving `m`. `resume` is the persisted record, if
    /// any: it's used only when it names this exact manifest.
    pub fn begin(
        m: Manifest,
        signature_ok: bool,
        t: &Target,
        allow_downgrade: bool,
        resume: Option<&Resume>,
    ) -> Result<Session, Refusal> {
        check_offer(&m, signature_ok, t, allow_downgrade)?;
        let next = match resume {
            Some(r) if r.manifest == m => {
                if r.offset >= m.size {
                    m.size
                } else {
                    align_down(r.offset)
                }
            }
            _ => 0,
        };
        Ok(Session { manifest: m, next, erased: align_down(next), persisted: next })
    }

    /// The next byte wanted (= bytes received and durably written).
    pub fn offset(&self) -> u32 {
        self.next
    }

    pub fn size(&self) -> u32 {
        self.manifest.size
    }

    pub fn complete(&self) -> bool {
        self.next == self.manifest.size
    }

    /// The resume record for the current progress.
    pub fn resume(&self) -> Resume {
        Resume { manifest: self.manifest, offset: self.persisted }
    }

    /// Plan the flash work for a chunk at `offset`. `chip` is checked against
    /// the image header in the chunk at offset 0.
    pub fn plan(&self, offset: u32, data: &[u8], chip: u16) -> Result<Plan, Refusal> {
        if offset != self.next {
            return Err(Refusal::OutOfOrder { want: self.next });
        }
        let len = data.len() as u32;
        if len == 0 || len > MAX_CHUNK {
            return Err(Refusal::BadChunk);
        }
        let end = offset.checked_add(len).ok_or(Refusal::Overflow)?;
        if end > self.manifest.size {
            return Err(Refusal::Overflow);
        }
        if offset == 0 {
            image::check_header(data, chip).map_err(Refusal::Image)?;
        }
        let erase_end = align_up(end);
        let erase = (erase_end > self.erased).then(|| (self.erased, erase_end - self.erased));
        Ok(Plan { erase, write_at: offset, len })
    }

    /// The flash work for `p` succeeded. Returns the offset to persist now
    /// (every [`PERSIST_EVERY`] bytes, and at the end), if any.
    pub fn commit(&mut self, p: &Plan) -> Option<u32> {
        if let Some((s, l)) = p.erase {
            self.erased = s + l;
        }
        self.next = p.write_at + p.len;
        if self.next == self.manifest.size || self.next / PERSIST_EVERY > self.persisted / PERSIST_EVERY {
            self.persisted = self.next;
            return Some(self.next);
        }
        None
    }

    /// Ready to verify and install?
    pub fn finish(&self) -> Result<(), Refusal> {
        if self.complete() {
            Ok(())
        } else {
            Err(Refusal::Incomplete)
        }
    }
}
