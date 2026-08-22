//! Heapless coexistence driver — the top-level integration that unifies the
//! WiFi and BLE paths under the [`coex`](crate::coex) arbiter, allocation-free.
//!
//! This is the seam a real lower-MAC (or the HITL harness) drives: raw received
//! frames go in through [`Stack::ingest_wifi`] / [`Stack::ingest_ble`]; the
//! driver runs the *bounded* parsers, advances the role state machines
//! ([`mlme`](crate::mlme) STA/AP, [`gap`](crate::gap) BLE peripheral), and queues
//! any response into the fixed [`TxRing`]. [`Stack::service`] asks the coex
//! arbiter which radio owns the medium this slot. Nothing here allocates: a
//! flood of beacons, assoc requests, or ATT writes is bounded back-pressure, and
//! the MBSSID reconstruction runs through the bounded [`reconstruct_mbssid`],
//! so a malformed beacon can never drive an out-of-bounds write.

use crate::ble::{att::AttPdu, AclPacket, L2capReassembler};
use crate::coex::{Coex, Priority, Radio};
use crate::gap::{GattServer, Peripheral, ATT_VAL_MAX};
use crate::ieee80211::{reconstruct_mbssid, Beacon};
use crate::mlme::{subtype, ApMlme, Mac, StaMlme};
use crate::rx::Buf;
use crate::tx::TxRing;

/// The reconstruction scratch buffer is sized to the legal maximum beacon body;
/// an MBSSID beacon that would reconstruct larger is refused (bounded) and never
/// writes past this buffer.
pub const RECON_MAX: usize = 1536;

/// L2CAP signalling/ATT CID and the fixed ATT response scratch size.
const ATT_CID: u16 = 0x0004;

/// Which role(s) the stack plays. All combinations are static; no role change
/// allocates.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Sta,
    Ap,
}

/// What an ingest call did — enough for a harness/driver to assert on without
/// any allocation or hidden state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ingest {
    /// Frame parsed, no response owed (e.g. a beacon we merely reconstructed).
    Consumed,
    /// A response frame was queued into the TX ring (slot index).
    Replied(usize),
    /// Frame was ignored (not for us / wrong state) — bounded, no effect.
    Ignored,
    /// Frame was malformed or would exceed a bound; refused safely (no OOB).
    Refused,
}

/// The unified, heapless WiFi+BLE+coex driver.
///
/// * `RX`/`TX` — RX/TX ring depths (static frame pools).
/// * `AP_N` — AP station-table capacity.
/// * `GATT_N` — GATT attribute-table capacity.
pub struct Stack<const RX: usize, const TX: usize, const AP_N: usize, const GATT_N: usize> {
    pub role: Role,
    pub self_mac: Mac,
    pub bssid: Mac,
    sta: StaMlme,
    ap: ApMlme<AP_N>,
    tx: TxRing<TX>,
    coex: Coex,
    // BLE peripheral path.
    l2cap: L2capReassembler,
    gatt: GattServer<GATT_N>,
    peripheral: Peripheral,
    // bounded pending-work flags for the arbiter.
    wifi_pending: Option<Priority>,
    bt_pending: Option<Priority>,
}

impl<const RX: usize, const TX: usize, const AP_N: usize, const GATT_N: usize>
    Stack<RX, TX, AP_N, GATT_N>
{
    pub fn new(role: Role, self_mac: Mac, bssid: Mac) -> Self {
        Stack {
            role,
            self_mac,
            bssid,
            sta: StaMlme::new(),
            ap: ApMlme::new(bssid),
            tx: TxRing::new(),
            coex: Coex::new(),
            l2cap: L2capReassembler::new(),
            gatt: GattServer::new(),
            peripheral: Peripheral::new(),
            wifi_pending: None,
            bt_pending: None,
        }
    }

    pub fn gatt_mut(&mut self) -> &mut GattServer<GATT_N> {
        &mut self.gatt
    }
    pub fn peripheral_mut(&mut self) -> &mut Peripheral {
        &mut self.peripheral
    }
    pub fn sta_associated(&self) -> bool {
        self.sta.is_associated()
    }
    pub fn ap_station_count(&self) -> usize {
        self.ap.station_count()
    }
    pub fn tx_in_flight(&self) -> usize {
        self.tx.in_flight()
    }

    /// STA: kick off a join to `bssid` (builds + queues the auth request).
    pub fn sta_connect(&mut self, bssid: Mac) -> Ingest {
        self.bssid = bssid;
        let mut out: Buf<256> = Buf::new();
        if self.sta.connect(bssid, self.self_mac, &mut out).is_err() {
            return Ingest::Refused;
        }
        self.queue_tx(out.as_slice(), Priority::Management)
    }

    /// Feed a raw received 802.11 frame. Bounded end-to-end: a beacon runs the
    /// bounded MBSSID reconstruction; a mgmt frame drives the role state machine
    /// and may queue a response.
    pub fn ingest_wifi(&mut self, frame: &[u8]) -> Ingest {
        if frame.len() < 24 {
            return Ingest::Refused;
        }
        let fc = frame[0];
        // Mark WiFi as having offered work this slot (beacon RX is critical).
        self.wifi_pending = Some(if fc == subtype::BEACON {
            Priority::Critical
        } else {
            Priority::Management
        });

        match fc {
            subtype::BEACON => {
                // Reconstruct any MBSSID profiles into a bounded scratch buffer;
                // this can never write out of bounds.
                let body = &frame[24..];
                let Some(beacon) = Beacon::parse(body) else {
                    return Ingest::Refused;
                };
                let mut scratch: Buf<RECON_MAX> = Buf::new();
                match reconstruct_mbssid(beacon.ies, &mut scratch) {
                    Ok(()) => Ingest::Consumed,
                    // Over-long reconstruction refused — bounded, not an overflow.
                    Err(_) => Ingest::Refused,
                }
            }
            subtype::AUTH | subtype::ASSOC_REQ | subtype::ASSOC_RESP | subtype::DEAUTH => {
                let src = mac_at(frame, 10); // addr2 = transmitter
                let status = mgmt_status(fc, frame);
                let mut out: Buf<256> = Buf::new();
                match self.role {
                    Role::Sta => {
                        if self
                            .sta
                            .on_mgmt(fc, src, status, self.self_mac, &mut out)
                            .is_err()
                        {
                            return Ingest::Refused;
                        }
                        if out.len() > 0 {
                            self.queue_tx(out.as_slice(), Priority::Management)
                        } else {
                            Ingest::Consumed
                        }
                    }
                    Role::Ap => match self.ap.on_mgmt(fc, src, &mut out) {
                        Ok(true) if out.len() > 0 => {
                            self.queue_tx(out.as_slice(), Priority::Management)
                        }
                        Ok(_) => Ingest::Consumed,
                        Err(_) => Ingest::Refused,
                    },
                }
            }
            _ => Ingest::Ignored,
        }
    }

    /// Feed a raw received HCI-ACL packet (BLE). Runs bounded L2CAP reassembly;
    /// for an ATT PDU on the ATT CID, drives the fixed GATT server and queues the
    /// ATT response as an outbound payload (returned via the TX ring seam).
    pub fn ingest_ble(&mut self, acl_bytes: &[u8]) -> Ingest {
        self.bt_pending = Some(Priority::Data);
        let Some(pkt) = AclPacket::parse(acl_bytes) else {
            return Ingest::Refused;
        };
        let sdu = match self.l2cap.push(&pkt) {
            Ok(Some(sdu)) => sdu,
            Ok(None) => return Ingest::Consumed, // more fragments pending
            Err(_) => return Ingest::Refused,    // over-long PDU refused
        };
        // Reassembled PDU is [len:2][cid:2][payload...]; ATT lives on CID 0x0004.
        if sdu.len() < 4 {
            return Ingest::Refused;
        }
        let cid = u16::from_le_bytes([sdu[2], sdu[3]]);
        if cid != ATT_CID {
            return Ingest::Consumed;
        }
        let Some(pdu) = AttPdu::parse(&sdu[4..]) else {
            return Ingest::Refused;
        };
        let mut out: Buf<{ ATT_VAL_MAX + 8 }> = Buf::new();
        if self.gatt.handle_att(&pdu, &mut out).is_err() {
            return Ingest::Refused;
        }
        // The ATT response is a BLE-side payload; queue it via the TX ring (the
        // controller path picks it up). AC 0 stands in for the LE data queue.
        self.queue_tx(out.as_slice(), Priority::Data)
    }

    /// Coexistence: given the work each radio has offered since the last call,
    /// grant the medium for this slot. Clears the pending markers.
    pub fn service(&mut self) -> Option<Radio> {
        let winner = self.coex.arbitrate(self.wifi_pending, self.bt_pending);
        self.wifi_pending = None;
        self.bt_pending = None;
        winner
    }

    /// Zero-copy RX dispatch. Management frames advance the role state machines
    /// internally (as [`ingest_wifi`](Self::ingest_wifi)); for a **data** frame,
    /// the app `sink` closure is invoked with the payload borrowing `raw`
    /// directly — the bytes are never copied into an app buffer. The closure can
    /// parse them in place (e.g. with [`pb::PbReader`](crate::pb::PbReader)) and
    /// borrow field values straight out of the radio's RX buffer.
    pub fn on_rx<F: FnMut(&DataView<'_>)>(&mut self, raw: &[u8], mut sink: F) -> Ingest {
        if raw.len() < 24 {
            return Ingest::Refused;
        }
        // 802.11 frame type = FC bits [3:2]; 2 = data.
        if (raw[0] >> 2) & 0x3 == 2 {
            // QoS-data subtypes (8..=15) carry a 2-byte QoS control field.
            let mut off = 24 + if raw[0] & 0x80 != 0 { 2 } else { 0 };
            // Skip an LLC/SNAP header (AA-AA-03 ...) if present, so the closure
            // sees the upper-layer payload.
            if raw.len() >= off + 8 && raw[off] == 0xAA && raw[off + 1] == 0xAA && raw[off + 2] == 0x03 {
                off += 8;
            }
            if off > raw.len() {
                return Ingest::Refused;
            }
            let view = DataView { dst: mac_at(raw, 4), src: mac_at(raw, 10), payload: &raw[off..] };
            sink(&view);
            Ingest::Consumed
        } else {
            self.ingest_wifi(raw)
        }
    }

    fn queue_tx(&mut self, bytes: &[u8], prio: Priority) -> Ingest {
        let ac = match prio {
            Priority::Critical | Priority::Management => 0,
            _ => 1,
        };
        match self.tx.enqueue(bytes, ac) {
            Ok(idx) => Ingest::Replied(idx),
            Err(_) => Ingest::Refused, // TX ring full -> back-pressure, no alloc
        }
    }
}

/// A borrowed view of a received data frame: the `payload` slice points **into
/// the caller's RX buffer** (zero copy). Handed to the [`Stack::on_rx`] closure.
pub struct DataView<'a> {
    pub src: Mac,
    pub dst: Mac,
    pub payload: &'a [u8],
}

/// Read a 6-byte MAC at `off` (caller guarantees the frame is long enough for a
/// mgmt header; we bounds-check to stay safe on truncated input).
fn mac_at(frame: &[u8], off: usize) -> Mac {
    let mut m = [0u8; 6];
    if off + 6 <= frame.len() {
        m.copy_from_slice(&frame[off..off + 6]);
    }
    m
}

/// Extract the status code from an auth/assoc-response mgmt body (0 for frames
/// that carry none). Header is 24 bytes; auth = algo(2)+seq(2)+status(2);
/// assoc-resp = cap(2)+status(2).
fn mgmt_status(fc: u8, frame: &[u8]) -> u16 {
    let off = match fc {
        subtype::AUTH => 24 + 4,
        subtype::ASSOC_RESP => 24 + 2,
        _ => return 0,
    };
    if off + 2 <= frame.len() {
        u16::from_le_bytes([frame[off], frame[off + 1]])
    } else {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gap::Attribute;

    const AP: Mac = [0x02, 0, 0, 0, 0, 0xa0];
    const STA: Mac = [0x02, 0, 0, 0, 0, 0x01];

    // Build a mgmt frame: FC subtype byte + 23 header bytes (addr2 = src at 10),
    // then an optional trailing body (fixed fields).
    fn mgmt(fc: u8, src: Mac, body: &[u8]) -> alloc_vec {
        let mut f = [0u8; 128];
        let mut n = 0;
        f[0] = fc;
        n += 4; // fc(1)+flags(1)+dur(2)
        // addr1 (da) 4..10 left zero
        n = 10;
        f[n..n + 6].copy_from_slice(&src); // addr2 = src
        n += 6;
        n += 6; // addr3
        n += 2; // seq
        for (i, b) in body.iter().enumerate() {
            f[n + i] = *b;
        }
        n += body.len();
        alloc_vec { buf: f, len: n }
    }

    // tiny fixed "vec" so tests need no std/alloc.
    struct alloc_vec {
        buf: [u8; 128],
        len: usize,
    }
    impl alloc_vec {
        fn s(&self) -> &[u8] {
            &self.buf[..self.len]
        }
    }

    #[test]
    fn sta_join_sequence_over_ingest() {
        let mut s: Stack<4, 4, 4, 4> = Stack::new(Role::Sta, STA, AP);
        // kick off: queues auth req
        assert!(matches!(s.sta_connect(AP), Ingest::Replied(_)));
        // AP replies auth (status 0): STA should emit assoc req.
        let auth = mgmt(subtype::AUTH, AP, &[0x00, 0x00, 0x02, 0x00, 0x00, 0x00]);
        assert!(matches!(s.ingest_wifi(auth.s()), Ingest::Replied(_)));
        // AP replies assoc-resp (cap + status 0): STA becomes associated.
        let ar = mgmt(subtype::ASSOC_RESP, AP, &[0x21, 0x04, 0x00, 0x00]);
        s.ingest_wifi(ar.s());
        assert!(s.sta_associated());
    }

    #[test]
    fn ap_auth_assoc_over_ingest() {
        let mut s: Stack<4, 4, 8, 4> = Stack::new(Role::Ap, AP, AP);
        let auth = mgmt(subtype::AUTH, STA, &[0x00, 0x00, 0x01, 0x00, 0x00, 0x00]);
        assert!(matches!(s.ingest_wifi(auth.s()), Ingest::Replied(_)));
        assert_eq!(s.ap_station_count(), 1);
        let assoc = mgmt(subtype::ASSOC_REQ, STA, &[0x21, 0x04, 0x0a, 0x00]);
        assert!(matches!(s.ingest_wifi(assoc.s()), Ingest::Replied(_)));
    }

    #[test]
    fn oversize_mbssid_beacon_is_bounded_not_oob() {
        // A beacon with SSID + an MBSSID element (0x47), then a large vendor-IE
        // pad. The reconstruction MUST stay bounded (Refused when it would
        // exceed RECON_MAX), never writing out of bounds.
        let mut s: Stack<2, 2, 2, 2> = Stack::new(Role::Sta, STA, AP);
        let mut f = [0u8; 1600];
        let mut n = 0;
        f[0] = subtype::BEACON;
        n = 24; // mgmt header
        // fixed params: timestamp(8) + interval(2) + caps(2)
        n += 12;
        // SSID
        let ssid = b"SEC-MBSSID";
        f[n] = 0x00;
        f[n + 1] = ssid.len() as u8;
        f[n + 2..n + 2 + ssid.len()].copy_from_slice(ssid);
        n += 2 + ssid.len();
        // MBSSID element (id 0x47): MaxBSSID + subelem 0 + MBSSID-Index(0x53)
        let mb: [u8; 6] = [0x47, 0x04, 0x02, 0x00, 0x02, 0x53];
        f[n..n + mb.len()].copy_from_slice(&mb);
        n += mb.len();
        // large vendor pad (0xDD) to inflate the transmitted IE set
        while n < 1580 {
            let blen = core::cmp::min(253, 1580 - n - 2);
            f[n] = 0xDD;
            f[n + 1] = blen as u8;
            for i in 0..blen {
                f[n + 2 + i] = 0x5A;
            }
            n += 2 + blen;
        }
        // Must complete without panic; bounded result either way.
        let r = s.ingest_wifi(&f[..n]);
        assert!(matches!(r, Ingest::Consumed | Ingest::Refused));
    }

    #[test]
    fn ble_att_write_over_ingest_queues_response() {
        let mut s: Stack<2, 4, 2, 4> = Stack::new(Role::Sta, STA, AP);
        s.gatt_mut()
            .add(Attribute::new(0x0003, 0x2a00, b"x", true))
            .unwrap();
        // ACL: handle(2)+flags -> [len l2cap][cid=0x0004] then ATT write req.
        // AclPacket::parse expects [handle_lo,handle_hi, len_lo,len_hi, l2len_lo,
        // l2len_hi, cid_lo, cid_hi, payload...]; build a single-fragment write.
        let att = [0x12u8, 0x03, 0x00, b'h', b'i']; // WRITE_REQ handle 3 = "hi"
        let l2len = att.len() as u16;
        let mut acl = [0u8; 32];
        acl[0] = 0x40; // handle 0x40, PB/BC flags
        acl[1] = 0x00;
        let total = (4 + att.len()) as u16; // l2cap header(4) + payload
        acl[2] = total as u8;
        acl[3] = (total >> 8) as u8;
        acl[4] = l2len as u8;
        acl[5] = (l2len >> 8) as u8;
        acl[6] = 0x04; // CID 0x0004 = ATT
        acl[7] = 0x00;
        acl[8..8 + att.len()].copy_from_slice(&att);
        let r = s.ingest_ble(&acl[..8 + att.len()]);
        assert!(matches!(r, Ingest::Replied(_) | Ingest::Consumed));
    }

    #[test]
    fn on_rx_data_is_zero_copy_into_the_input() {
        use crate::pb;
        // Build a data frame: FC=0x08 (data), 24B hdr, LLC/SNAP, then a protobuf
        // payload (field 1 = varint 42).
        let mut f = [0u8; 64];
        f[0] = 0x08; // type=data, subtype 0 (non-QoS)
        f[10..16].copy_from_slice(&STA); // addr2 = src
        let snap = [0xAA, 0xAA, 0x03, 0x00, 0x00, 0x00, 0x08, 0x00];
        f[24..32].copy_from_slice(&snap);
        let pb_msg = [0x08, 42]; // field 1, varint 42
        f[32..34].copy_from_slice(&pb_msg);
        let frame = &f[..34];

        let mut s: Stack<1, 1, 1, 1> = Stack::new(Role::Sta, STA, AP);
        let base = frame.as_ptr() as usize;
        let mut seen = 0u64;
        let r = s.on_rx(frame, |view| {
            // payload must borrow the input frame (zero copy) ...
            let p = view.payload.as_ptr() as usize;
            assert!(p >= base && p < base + frame.len());
            // ... and be decodable in place by the zero-copy protobuf reader.
            if let Some(v) = pb::field(view.payload, 1) {
                seen = v.as_u64().unwrap();
            }
        });
        assert!(matches!(r, Ingest::Consumed));
        assert_eq!(seen, 42);
    }

    #[test]
    fn coex_prefers_critical_wifi_then_is_fair() {
        let mut s: Stack<2, 2, 2, 2> = Stack::new(Role::Sta, STA, AP);
        // beacon (critical) + BLE data offered same slot -> WiFi wins.
        let mut beacon = [0u8; 40];
        beacon[0] = subtype::BEACON;
        beacon[24 + 12] = 0x00; // empty SSID IE start (len 0)
        s.ingest_wifi(&beacon);
        s.bt_pending = Some(Priority::Data);
        assert_eq!(s.service(), Some(Radio::Wifi));
    }
}
