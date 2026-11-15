//! DDP (Distributed Display Protocol) packets, the format WLED and most pixel
//! bridges take natively on UDP 4048. Byte for byte the format of the Mac host
//! player (`pi/player_rs/src/output.rs`): a 10-byte header, up to 1440 data
//! bytes (480 RGB pixels) per packet, PUSH on the last so the receiver shows
//! the frame at once.

pub const HEADER_LEN: usize = 10;
/// Data bytes per packet (WLED's limit): 480 RGB pixels.
pub const MAX_DATA: usize = 1440;
/// The largest packet.
pub const MAX_PACKET: usize = HEADER_LEN + MAX_DATA;

const VER1: u8 = 0x40;
const PUSH: u8 = 0x01;
/// Data type: RGB, 8 bits per channel.
const TYPE_RGB8: u8 = 0x0B;
/// Destination id 1: the default output device.
const ID_DISPLAY: u8 = 0x01;

/// Packets one frame of `data_len` bytes takes (none for an empty frame, as on
/// the host player).
pub fn packet_count(data_len: usize) -> usize {
    data_len.div_ceil(MAX_DATA)
}

/// The next sequence number after `seq`: 1..=15 (0 means "unsequenced" to
/// receivers, so it is never used).
pub fn next_seq(seq: u8) -> u8 {
    seq % 15 + 1
}

/// Write packet `index` of a frame whose RGB bytes are `data` into `out`;
/// returns its length, or None if `index` is past the frame or `out` is short.
pub fn packet(data: &[u8], index: usize, seq: u8, out: &mut [u8]) -> Option<usize> {
    let count = packet_count(data.len());
    if index >= count {
        return None;
    }
    let offset = index * MAX_DATA;
    let chunk = &data[offset.min(data.len())..(offset + MAX_DATA).min(data.len())];
    let len = HEADER_LEN + chunk.len();
    let out = out.get_mut(..len)?;
    out[0] = VER1 | if index + 1 == count { PUSH } else { 0 };
    out[1] = seq & 0x0F;
    out[2] = TYPE_RGB8;
    out[3] = ID_DISPLAY;
    out[4..8].copy_from_slice(&(offset as u32).to_be_bytes());
    out[8..10].copy_from_slice(&(chunk.len() as u16).to_be_bytes());
    out[HEADER_LEN..].copy_from_slice(chunk);
    Some(len)
}
