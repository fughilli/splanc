//! Membership messages (design §7.3, §7.6, §7.7): fixed-layout, big-endian, first byte the
//! message type. Splanc's own; nothing here is swarm.v1 or ESP-NOW.
//!
//! | Type | Message        | Carried as                                        | Bytes |
//! | ---- | -------------- | ------------------------------------------------- | ----- |
//! | 0x01 | `Advert`       | plain envelope (epoch 0), broadcast, every beacon | 15    |
//! | 0x02 | `JoinRequest`  | plain, broadcast, one hop                         | 105   |
//! | 0x03 | `JoinAccept`   | plain, broadcast, one hop (keys wrapped)          | 164   |
//! | 0x04 | `GuestHello`   | plain, broadcast, one hop                         | 15    |
//! | 0x10 | `Admit`        | `MEMBERSHIP` port, admin session command                   | 11    |
//! | 0x11 | `AssignGroups` | `MEMBERSHIP` port, admin session command                   | ≤ 12  |
//! | 0x12 | `SetMode`      | `MEMBERSHIP` port, admin session command                   | 6     |
//! | 0x13 | `AllowListAdd` | `MEMBERSHIP` port, admin session command                   | ≤ 162 |
//! | 0x15 | `Eject`        | `MEMBERSHIP` port, admin session command                   | 11    |
//! | 0x20 | `PendingJoin`  | `STATUS` port (a member tells gateways)           | 23    |
//!
//! Plain messages never enter the flood (members do not relay them), so an outsider cannot
//! use the mesh to amplify anything; the one thing that crosses hops for a joiner is the
//! `PendingJoin` a member sends under the mesh key.

use crate::backhaul::NodeId;
use crate::crypto::{KeyHash, PublicKey};
use crate::groups::Groups;
use crate::membership::Mode;

pub use crate::codec::{R, W};

// The largest plain message, in its envelope, fits the 802.11 frame budget (§4.1).
const _: () = assert!(crate::envelope::HEADER_LEN + JoinAccept::LEN <= 250);

pub const T_ADVERT: u8 = 0x01;
pub const T_JOIN_REQUEST: u8 = 0x02;
pub const T_JOIN_ACCEPT: u8 = 0x03;
pub const T_GUEST_HELLO: u8 = 0x04;
pub const T_ADMIT: u8 = 0x10;
pub const T_ASSIGN_GROUPS: u8 = 0x11;
pub const T_SET_MODE: u8 = 0x12;
pub const T_ALLOW_LIST_ADD: u8 = 0x13;
/// Reserved for key rotation (§7.6, M7c): `Rekey{epoch, wrapped key}`, `RekeyRequest`.
pub const T_REKEY: u8 = 0x14;
pub const T_EJECT: u8 = 0x15;
pub const T_PENDING_JOIN: u8 = 0x20;
/// A tiny flood at the maximum hop limit, once a minute per node: how far the mesh reaches
/// (the adaptive hop limit's discovery, §10.6). `STATUS` port, body is just this byte.
pub const T_PROBE: u8 = 0x22;

/// A node's queue capacity class (design §10.6): what it can hold for others.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[repr(u8)]
pub enum Class {
    /// A standalone C6: small queues, forwards promptly, drops bulk first under pressure.
    #[default]
    C6 = 0,
    /// A P4 + C6 fixture: deep queues on the P4 (over SDIO), a custodian for bulk.
    P4 = 1,
    /// A Raspberry Pi: effectively unlimited RAM; a custodian and bulk source; may bridge
    /// islands over IP (M10).
    Pi = 2,
}

impl Class {
    pub const fn from_u8(v: u8) -> Option<Class> {
        match v {
            0 => Some(Class::C6),
            1 => Some(Class::P4),
            2 => Some(Class::Pi),
            _ => None,
        }
    }

    pub const fn custodian(self) -> bool {
        !matches!(self, Class::C6)
    }
}

/// What a node advertises about its queues: its class and its current relay credit (free
/// relay slots; a custodian paces bulk toward neighbours with little credit).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct Capacity {
    pub class: Class,
    pub credit: u8,
}

/// The public part of a member's beacon (§5.3 BEACON: mesh id and epoch are the envelope
/// header's). Joiners and guests read it without a key.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Advert {
    pub epoch: u8,
    pub mode: Mode,
    /// The join challenge: a site-secret proof must name a nonce the advert's sender issued
    /// recently (§7.3 "beacon nonce").
    pub nonce: u32,
    pub members: u8,
    pub mtu: u16,
    pub channel: u8,
    pub capacity: Capacity,
    /// The sender's estimate of the mesh diameter in hops (adaptive hop limit, §10.6).
    pub diameter: u8,
}

impl Advert {
    pub const LEN: usize = 14;
    pub fn encode(&self, out: &mut [u8]) -> Option<usize> {
        W::new(out)
            .u8(T_ADVERT)
            .u8(self.epoch)
            .u8(self.mode as u8)
            .u32(self.nonce)
            .u8(self.members)
            .u16(self.mtu)
            .u8(self.channel)
            .u8(self.capacity.class as u8)
            .u8(self.capacity.credit)
            .u8(self.diameter)
            .done()
    }
    pub fn decode(b: &[u8]) -> Option<Advert> {
        let mut r = R::new(b);
        (r.u8()? == T_ADVERT).then_some(())?;
        let a = Advert {
            epoch: r.u8()?,
            mode: Mode::from_u8(r.u8()?)?,
            nonce: r.u32()?,
            members: r.u8()?,
            mtu: r.u16()?,
            channel: r.u8()?,
            capacity: Capacity { class: Class::from_u8(r.u8()?)?, credit: r.u8()? },
            diameter: r.u8()?,
        };
        r.end()?;
        Some(a)
    }
}

/// A device asking to join (§7.3). With a site-secret `proof` (closed/open), the advert's
/// sender admits it at once; without one (or in locked mode) it waits for approval.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct JoinRequest {
    pub node: NodeId,
    pub mac: [u8; 6],
    pub public_key: PublicKey,
    pub firmware: u32,
    /// The joiner's own nonce: makes each request's key wrap unique.
    pub req_nonce: u32,
    /// The member whose advert this answers (it checks the proof and answers).
    pub advert_from: NodeId,
    pub advert_nonce: u32,
    /// `HMAC(site secret, "SMjoin1" ‖ mesh id ‖ advert nonce ‖ node ‖ key hash)[..16]`.
    pub proof: Option<[u8; 16]>,
}

impl JoinRequest {
    pub const LEN: usize = 105;
    pub fn encode(&self, out: &mut [u8]) -> Option<usize> {
        let mut w = W::new(out);
        w.u8(T_JOIN_REQUEST).u16(self.node).put(&self.mac).put(&self.public_key).u32(self.firmware).u32(self.req_nonce);
        w.u16(self.advert_from).u32(self.advert_nonce).u8(self.proof.is_some() as u8).put(&self.proof.unwrap_or([0; 16]));
        w.done()
    }
    pub fn decode(b: &[u8]) -> Option<JoinRequest> {
        let mut r = R::new(b);
        (r.u8()? == T_JOIN_REQUEST).then_some(())?;
        let node = r.u16()?;
        let mac = r.arr()?;
        let public_key = r.arr()?;
        let firmware = r.u32()?;
        let req_nonce = r.u32()?;
        let advert_from = r.u16()?;
        let advert_nonce = r.u32()?;
        let has = r.u8()?;
        let proof: [u8; 16] = r.arr()?;
        r.end()?;
        Some(JoinRequest { node, mac, public_key, firmware, req_nonce, advert_from, advert_nonce, proof: (has == 1).then_some(proof) })
    }
}

/// What a joiner gets, wrapped (§7.3): the mesh key and, if the admitting member has it, the
/// admin public key (authenticated by the wrap, so a joiner cannot be handed a fake one).
pub const WRAPPED_PLAIN: usize = 16 + 65 + 1;
pub const WRAP_TAG: usize = 8;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct JoinAccept {
    pub joiner: NodeId,
    /// The admitting member's public key (the joiner's ECDH peer).
    pub public_key: PublicKey,
    pub epoch: u8,
    pub mode: Mode,
    /// Echoes the request's nonce.
    pub req_nonce: u32,
    /// AES-CCM(wrap key, mesh key ‖ admin public key ‖ has admin) ‖ tag.
    pub wrapped: [u8; WRAPPED_PLAIN + WRAP_TAG],
}

impl JoinAccept {
    pub const LEN: usize = 164;
    pub fn encode(&self, out: &mut [u8]) -> Option<usize> {
        let mut w = W::new(out);
        w.u8(T_JOIN_ACCEPT).u16(self.joiner).put(&self.public_key).u8(self.epoch).u8(self.mode as u8).u32(self.req_nonce);
        w.put(&self.wrapped).done()
    }
    pub fn decode(b: &[u8]) -> Option<JoinAccept> {
        let mut r = R::new(b);
        (r.u8()? == T_JOIN_ACCEPT).then_some(())?;
        let a = JoinAccept {
            joiner: r.u16()?,
            public_key: r.arr()?,
            epoch: r.u8()?,
            mode: Mode::from_u8(r.u8()?)?,
            req_nonce: r.u32()?,
            wrapped: r.arr()?,
        };
        r.end()?;
        Some(a)
    }
}

#[cfg(feature = "open_mode")]
/// A guest following an open mesh says hello (§7.3 Follow), so the owner sees it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GuestHello {
    pub node: NodeId,
    pub key_hash: KeyHash,
    pub firmware: u32,
}

#[cfg(feature = "open_mode")]
impl GuestHello {
    pub const LEN: usize = 15;
    pub fn encode(&self, out: &mut [u8]) -> Option<usize> {
        W::new(out).u8(T_GUEST_HELLO).u16(self.node).put(&self.key_hash).u32(self.firmware).done()
    }
    pub fn decode(b: &[u8]) -> Option<GuestHello> {
        let mut r = R::new(b);
        (r.u8()? == T_GUEST_HELLO).then_some(())?;
        let g = GuestHello { node: r.u16()?, key_hash: r.arr()?, firmware: r.u32()? };
        r.end()?;
        Some(g)
    }
}

/// Admin commands on the `MEMBERSHIP` port (the admin framing is around these).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Command {
    /// Admit a pending device (approval path); in locked mode also adds it to the allow-list.
    Admit { node: NodeId, key_hash: KeyHash },
    /// Set a member's groups (persisted on it).
    AssignGroups { node: NodeId, groups: Groups },
    /// Change the mesh mode (§7.6). `generation` orders concurrent changes.
    SetMode { mode: Mode, generation: u32 },
    /// Add device-key hashes to the allow-list (the closed → locked proposal, §7.6).
    AllowListAdd { hashes: [KeyHash; Command::ALLOW_BATCH], n: u8 },
    /// The admin ejects one member (mesh M7, the seam for issue #571): the fixture with this
    /// node id and device-key hash leaves the mesh (drops its mesh state; the firmware turns
    /// the mesh off so the fixture can be connected to directly). Not a removal: the others
    /// keep their keys (a removal is a rotation, §7.6).
    Eject { node: NodeId, key_hash: KeyHash },
}

impl Command {
    pub const ALLOW_BATCH: usize = 20;

    pub fn encode(&self, out: &mut [u8]) -> Option<usize> {
        let mut w = W::new(out);
        match self {
            Command::Admit { node, key_hash } => w.u8(T_ADMIT).u16(*node).put(key_hash),
            Command::Eject { node, key_hash } => w.u8(T_EJECT).u16(*node).put(key_hash),
            Command::AssignGroups { node, groups } => w.u8(T_ASSIGN_GROUPS).u16(*node).u8(groups.len() as u8).put(groups.as_slice()),
            Command::SetMode { mode, generation } => w.u8(T_SET_MODE).u8(*mode as u8).u32(*generation),
            Command::AllowListAdd { hashes, n } => {
                w.u8(T_ALLOW_LIST_ADD).u8(*n);
                for h in &hashes[..*n as usize] {
                    w.put(h);
                }
                &mut w
            }
        };
        w.done()
    }

    pub fn decode(b: &[u8]) -> Option<Command> {
        let mut r = R::new(b);
        let c = match r.u8()? {
            T_ADMIT => Command::Admit { node: r.u16()?, key_hash: r.arr()? },
            T_EJECT => Command::Eject { node: r.u16()?, key_hash: r.arr()? },
            T_ASSIGN_GROUPS => {
                let node = r.u16()?;
                let n = r.u8()? as usize;
                if n > Groups::MAX {
                    return None;
                }
                Command::AssignGroups { node, groups: Groups::from_slice(r.take(n)?) }
            }
            T_SET_MODE => Command::SetMode { mode: Mode::from_u8(r.u8()?)?, generation: r.u32()? },
            T_ALLOW_LIST_ADD => {
                let n = r.u8()?;
                if n as usize > Self::ALLOW_BATCH {
                    return None;
                }
                let mut hashes = [[0u8; 8]; Self::ALLOW_BATCH];
                for h in hashes.iter_mut().take(n as usize) {
                    *h = r.arr()?;
                }
                Command::AllowListAdd { hashes, n }
            }
            _ => return None,
        };
        r.end()?;
        Some(c)
    }
}

/// A join a member heard and could not admit by itself, for the gateways (and the app's
/// "New fixture nearby: admit?").
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PendingJoin {
    pub node: NodeId,
    pub mac: [u8; 6],
    pub key_hash: KeyHash,
    pub firmware: u32,
    /// The member that heard it (and will send the JoinAccept once admitted).
    pub heard_by: NodeId,
}

impl PendingJoin {
    pub const LEN: usize = 23;
    pub fn encode(&self, out: &mut [u8]) -> Option<usize> {
        W::new(out).u8(T_PENDING_JOIN).u16(self.node).put(&self.mac).put(&self.key_hash).u32(self.firmware).u16(self.heard_by).done()
    }
    pub fn decode(b: &[u8]) -> Option<PendingJoin> {
        let mut r = R::new(b);
        (r.u8()? == T_PENDING_JOIN).then_some(())?;
        let p = PendingJoin { node: r.u16()?, mac: r.arr()?, key_hash: r.arr()?, firmware: r.u32()?, heard_by: r.u16()? };
        r.end()?;
        Some(p)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rt<T: PartialEq + core::fmt::Debug + Copy>(v: T, len: usize, enc: impl Fn(&T, &mut [u8]) -> Option<usize>, dec: impl Fn(&[u8]) -> Option<T>) {
        let mut b = [0u8; 256];
        let n = enc(&v, &mut b).unwrap();
        assert_eq!(n, len, "{v:?}");
        assert_eq!(dec(&b[..n]), Some(v));
        // Truncated and over-long are refused; a short buffer does not encode.
        assert_eq!(dec(&b[..n - 1]), None);
        assert_eq!(dec(&b[..n + 1]), None);
        assert_eq!(enc(&v, &mut b[..n - 1]), None);
    }

    #[test]
    fn roundtrips_at_the_documented_sizes() {
        rt(
            Advert { epoch: 3, mode: Mode::Locked, nonce: 0xdead_beef, members: 6, mtu: 250, channel: 6, capacity: Capacity { class: Class::Pi, credit: 3 }, diameter: 4 },
            Advert::LEN,
            Advert::encode,
            Advert::decode,
        );
        let jr = JoinRequest {
            node: 7,
            mac: [1, 2, 3, 4, 5, 6],
            public_key: [4; 65],
            firmware: 0x0107_0000,
            req_nonce: 9,
            advert_from: 3,
            advert_nonce: 77,
            proof: Some([0xaa; 16]),
        };
        rt(jr, JoinRequest::LEN, JoinRequest::encode, JoinRequest::decode);
        rt(JoinRequest { proof: None, ..jr }, JoinRequest::LEN, JoinRequest::encode, JoinRequest::decode);
        rt(
            JoinAccept { joiner: 7, public_key: [4; 65], epoch: 2, mode: Mode::Closed, req_nonce: 9, wrapped: [0x5a; 90] },
            JoinAccept::LEN,
            JoinAccept::encode,
            JoinAccept::decode,
        );
        #[cfg(feature = "open_mode")]
        rt(GuestHello { node: 9, key_hash: [1; 8], firmware: 3 }, GuestHello::LEN, GuestHello::encode, GuestHello::decode);
        rt(PendingJoin { node: 9, mac: [0; 6], key_hash: [1; 8], firmware: 3, heard_by: 2 }, PendingJoin::LEN, PendingJoin::encode, PendingJoin::decode);
        rt(Command::Admit { node: 7, key_hash: [3; 8] }, 11, Command::encode, Command::decode);
        rt(Command::Eject { node: 7, key_hash: [3; 8] }, 11, Command::encode, Command::decode);
        rt(Command::AssignGroups { node: 7, groups: Groups::from_slice(&[1, 2, 9]) }, 7, Command::encode, Command::decode);
        rt(Command::SetMode { mode: Mode::Open, generation: 4 }, 6, Command::encode, Command::decode);
        let mut hashes = [[0u8; 8]; Command::ALLOW_BATCH];
        hashes[1] = [7; 8];
        rt(Command::AllowListAdd { hashes, n: 2 }, 2 + 16, Command::encode, Command::decode);
    }

    #[test]
    fn rejects_garbage() {
        assert_eq!(Advert::decode(&[T_ADVERT, 1, 9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), None, "bad mode");
        assert_eq!(Command::decode(&[0x7f]), None);
        assert_eq!(Command::decode(&[T_ASSIGN_GROUPS, 0, 1, 9]), None, "more groups than allowed");
        assert_eq!(Command::decode(&[T_ALLOW_LIST_ADD, 21]), None);
        assert_eq!(Command::decode(&[]), None);
    }
}
