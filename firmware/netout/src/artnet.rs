//! Art-Net ArtDmx / ArtSync packets, byte for byte the Mac host player's
//! (`pi/player_rs/src/output.rs`): one universe carries 170 RGB pixels (510 of
//! its 512 channels), universes count up from the output's first one, and an
//! optional ArtSync after each frame tells sync-aware receivers to show it.

/// Pixels per universe.
pub const PX_PER_UNIVERSE: usize = 170;
/// ArtDmx header bytes before the DMX data.
pub const HEADER_LEN: usize = 18;
/// The largest ArtDmx packet (510 data bytes).
pub const MAX_PACKET: usize = HEADER_LEN + PX_PER_UNIVERSE * 3;
/// An ArtSync packet's length.
pub const SYNC_LEN: usize = 14;

const ID: &[u8; 8] = b"Art-Net\0";
const OP_DMX: u16 = 0x5000;
const OP_SYNC: u16 = 0x5200;
const PROT_VER: u16 = 14;

/// Universes (packets) a frame of `data_len` RGB bytes takes.
pub fn packet_count(data_len: usize) -> usize {
    data_len.div_ceil(PX_PER_UNIVERSE * 3)
}

/// The next sequence number after `seq`: 1..=255 (0 disables reordering at the
/// receiver, so it is never used).
pub fn next_seq(seq: u8) -> u8 {
    seq % 255 + 1
}

/// Write ArtDmx packet `index` (universe `first_universe + index`, wrapping at
/// 15 bits) of the frame `data` into `out`; returns its length, or None if
/// `index` is past the frame or `out` is short.
pub fn packet(
    data: &[u8],
    index: usize,
    first_universe: u16,
    seq: u8,
    out: &mut [u8],
) -> Option<usize> {
    if index >= packet_count(data.len()) {
        return None;
    }
    let per = PX_PER_UNIVERSE * 3;
    let chunk = &data[index * per..((index + 1) * per).min(data.len())];
    // The DMX length must be even and at least 2.
    let dmx_len = (chunk.len() + (chunk.len() & 1)).max(2);
    let len = HEADER_LEN + dmx_len;
    let out = out.get_mut(..len)?;
    let addr = first_universe.wrapping_add(index as u16) & 0x7FFF;
    out[..8].copy_from_slice(ID);
    out[8..10].copy_from_slice(&OP_DMX.to_le_bytes());
    out[10..12].copy_from_slice(&PROT_VER.to_be_bytes());
    out[12] = seq;
    out[13] = 0; // physical input port (informational)
    out[14] = (addr & 0xFF) as u8; // SubUni
    out[15] = (addr >> 8) as u8; // Net
    out[16..18].copy_from_slice(&(dmx_len as u16).to_be_bytes());
    out[HEADER_LEN..HEADER_LEN + chunk.len()].copy_from_slice(chunk);
    out[HEADER_LEN + chunk.len()..].fill(0);
    Some(len)
}

/// Write an ArtSync packet into `out`; returns its length, or None if short.
pub fn sync(out: &mut [u8]) -> Option<usize> {
    let out = out.get_mut(..SYNC_LEN)?;
    out[..8].copy_from_slice(ID);
    out[8..10].copy_from_slice(&OP_SYNC.to_le_bytes());
    out[10..12].copy_from_slice(&PROT_VER.to_be_bytes());
    out[12] = 0; // Aux1
    out[13] = 0; // Aux2
    Some(SYNC_LEN)
}
