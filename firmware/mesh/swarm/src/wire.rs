// Ported from fughilli/indoor_localization swarm/net/src/wire.rs at 5a906e78 (Splanc owns this
// copy; firmware/mesh/swarm/PROVENANCE.md lists what changed).
//! swarm.v1 on the wire (firmware/mesh/swarm/docs/swarm-wire.md): zero-copy pbview views to decode (a received
//! buffer is validated once by `FooView::parse` and read in place) and one small encoder
//! function per message. Nothing allocates; there are no capacity tables: sizes are checked
//! against the budgets in code (and asserted by the worst-case tests).
//!
//! The rule the formats rely on (swarm_wire.proto): a signed or tagged thing is an envelope
//! `{body, tag}` whose tag covers the exact `body` bytes as transmitted. Code that receives
//! an envelope verifies the bytes the view hands out (`view.body()`) and stores or re-serves
//! the original buffer; it never decodes and re-encodes first (protobuf has no canonical
//! encoding).
//!
//! Encoders omit a field at its proto3 default (0 / empty), except `MeshPacket.dest`, which
//! has explicit presence (absent = broadcast, so node 0 is a valid destination). Fields are
//! written in field-number order.

use pbview::EncodeError;

pub use swarm_wire_rs::swarm::v1 as pb;

/// Largest registry key: ids stay below 2^14 so a `Setting` costs 10 bytes at most.
pub const MAX_KEY: u16 = 0x3FFF;

/// One setting for `bundle_body` / `override_body` / `settings_report`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SettingRec {
    pub key: u16,
    pub value: u32,
    /// SettingsReport only: 1 swarm layer, 2 device override; 0 (absent) otherwise.
    pub source: u8,
}

fn len(r: Result<usize, EncodeError>) -> Option<usize> {
    r.ok()
}

fn setting(s: &mut pb::SettingEnc<'_, '_>, r: &SettingRec) -> Result<(), EncodeError> {
    s.key(r.key as u32)?.value(r.value)?.source(r.source as u32)?;
    Ok(())
}

// ---- one encoder per message (pbview's typed builders; fields in field-number order,
// proto3 defaults skipped). Each returns the encoded length, None if `out` is too small or a
// bound of swarm_wire_bounds.txt is exceeded.

pub fn summary(running: u32, staged: u32, pages: u32, total: u32, generation: u32, out: &mut [u8]) -> Option<usize> {
    len(pb::SummaryEnc::encode(out, |m| {
        m.running(running)?.staged(staged)?.pages(pages)?.total(total)?.generation(generation)?;
        Ok(())
    }))
}

pub fn manifest_body(version: u32, size: u32, sha256: &[u8; 32], flags: u32, out: &mut [u8]) -> Option<usize> {
    len(pb::ManifestBodyEnc::encode(out, |m| {
        m.version(version)?.size(size)?.sha256(sha256)?.flags(flags)?;
        Ok(())
    }))
}

/// The envelope around `body` exactly as signed.
pub fn manifest(body: &[u8], signature: &[u8; 64], out: &mut [u8]) -> Option<usize> {
    len(pb::ManifestEnc::encode(out, |m| {
        m.body(body)?.signature(signature)?;
        Ok(())
    }))
}

pub fn fw_request(version: u32, page: u32, missing: u64, out: &mut [u8]) -> Option<usize> {
    len(pb::FwRequestEnc::encode(out, |m| {
        m.version(version)?.page(page)?.missing(missing)?;
        Ok(())
    }))
}

pub fn fw_data(version: u32, page: u32, chunk: u32, data: &[u8], out: &mut [u8]) -> Option<usize> {
    len(pb::FwDataEnc::encode(out, |m| {
        m.version(version)?.page(page)?.chunk(chunk)?.data(data)?;
        Ok(())
    }))
}

#[allow(clippy::too_many_arguments)]
pub fn mesh_packet(
    origin: u32,
    id: u32,
    dest: Option<u32>,
    hop_limit: u32,
    hop_start: u32,
    port: u32,
    flags: u32,
    attempt: u32,
    payload: &[u8],
    out: &mut [u8],
) -> Option<usize> {
    len(pb::MeshPacketEnc::encode(out, |m| {
        m.origin(origin)?.id(id)?;
        if let Some(d) = dest {
            m.dest(d)?;
        }
        m.hop_limit(hop_limit)?.hop_start(hop_start)?.port(port)?.flags(flags)?.attempt(attempt)?.payload(payload)?;
        Ok(())
    }))
}

pub fn ack(id: u32, out: &mut [u8]) -> Option<usize> {
    len(pb::AckEnc::encode(out, |m| {
        m.id(id)?;
        Ok(())
    }))
}

pub fn bundle_body(generation: u32, settings: &[SettingRec], out: &mut [u8]) -> Option<usize> {
    len(pb::BundleBodyEnc::encode(out, |m| {
        m.generation(generation)?;
        for r in settings {
            m.add_settings(|s| setting(s, r))?;
        }
        Ok(())
    }))
}

/// The Bundle envelope `{body, tag}`; `body` is the BundleBody exactly as tagged.
pub fn bundle(body: &[u8], tag: &[u8], out: &mut [u8]) -> Option<usize> {
    len(pb::BundleEnc::encode(out, |m| {
        m.body(body)?.tag(tag)?;
        Ok(())
    }))
}

/// The Override envelope `{body, tag}`.
pub fn override_(body: &[u8], tag: &[u8], out: &mut [u8]) -> Option<usize> {
    len(pb::OverrideEnc::encode(out, |m| {
        m.body(body)?.tag(tag)?;
        Ok(())
    }))
}

pub fn bundle_fragment(generation: u32, total_len: u32, offset: u32, data: &[u8], out: &mut [u8]) -> Option<usize> {
    len(pb::BundleFragmentEnc::encode(out, |m| {
        m.generation(generation)?.total_len(total_len)?.offset(offset)?.data(data)?;
        Ok(())
    }))
}

pub fn bundle_request(generation: u32, out: &mut [u8]) -> Option<usize> {
    len(pb::BundleRequestEnc::encode(out, |m| {
        m.generation(generation)?;
        Ok(())
    }))
}

pub fn override_body(kind: u32, seq: u32, settings: &[SettingRec], out: &mut [u8]) -> Option<usize> {
    len(pb::OverrideBodyEnc::encode(out, |m| {
        m.kind(kind as i32)?.seq(seq)?;
        for r in settings {
            m.add_settings(|s| setting(s, r))?;
        }
        Ok(())
    }))
}

pub fn settings_report(part: u32, parts: u32, generation: u32, override_seq: u32, settings: &[SettingRec], out: &mut [u8]) -> Option<usize> {
    len(pb::SettingsReportEnc::encode(out, |m| {
        m.part(part)?.parts(parts)?.generation(generation)?.override_seq(override_seq)?;
        for r in settings {
            m.add_settings(|s| setting(s, r))?;
        }
        Ok(())
    }))
}

// ---- varints for the staging flash framing (`varint(length) || Manifest`)

/// A varint at the start of `b`: (value, bytes used). None if it is not terminated within
/// five bytes (erased flash, 0xFF..., is never a valid length).
pub fn read_varint(b: &[u8]) -> Option<(u32, usize)> {
    let mut v = 0u64;
    for (i, &x) in b.iter().take(5).enumerate() {
        v |= ((x & 0x7F) as u64) << (7 * i);
        if x & 0x80 == 0 {
            return u32::try_from(v).ok().map(|v| (v, i + 1));
        }
    }
    None
}

/// Write a varint into `out`; its length.
pub fn write_varint(mut v: u32, out: &mut [u8]) -> usize {
    let mut i = 0;
    loop {
        let b = (v & 0x7F) as u8;
        v >>= 7;
        if v == 0 {
            out[i] = b;
            return i + 1;
        }
        out[i] = b | 0x80;
        i += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn varints_round_trip_and_erased_flash_is_not_a_length() {
        let mut b = [0u8; 5];
        for v in [0u32, 1, 127, 128, 300, 16383, 16384, u32::MAX] {
            let n = write_varint(v, &mut b);
            assert_eq!(read_varint(&b[..n]), Some((v, n)));
        }
        assert_eq!(read_varint(&[0xFF; 8]), None);
        assert_eq!(read_varint(&[0x80]), None);
    }
}
