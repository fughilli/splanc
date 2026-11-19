//! Key rotation on removal (design §7.6, revised): one admin-signed order, new keys sent once,
//! a 26-byte wrap per remaining member, acks and retries through the gateway.
//!
//! 1. The app (holding the admin secret) picks the new mesh key **and a new site secret**,
//!    and signs a [`RekeyOrder`]: the mesh id, the new epoch, a 16-byte commitment to the new
//!    keys, and the revocation list (device-key hashes of removed devices). It hands the order
//!    and the keys to its gateway over the app link.
//! 2. The gateway picks a transport key `K_t`, encrypts the new keys once under it
//!    ([`RekeyHead`], 185 B with the order), and wraps `K_t` for each member in its session
//!    roster under that member's pairwise key ([`RekeyWraps`], 26 B per member, 7 per
//!    packet). Members do AES only; the one ECDSA verify (the order) happens once.
//! 3. A member that has the head and its wrap unwraps `K_t`, decrypts, checks the commitment
//!    against the signed order, installs the new epoch (the old one stays accepted for 60 s,
//!    §7.6) and acks under its pairwise key ([`RekeyAck`]). The gateway re-sends the head and
//!    the wraps of members that have not acked, once a second.
//! 4. Members store the revocation list and refuse joins from revoked keys.
//!
//! Removed devices get no wrap. Spares that never joined and hold the old site secret can no
//! longer join by proof (the epoch-1 key and the proofs use the old secret): they need
//! re-provisioning with the new secret, or an approval join.

use ledmapper_netstack::ccmp::{ccm_open, ccm_seal};

use crate::admin::{GatewaySession, Sessions};
use crate::backhaul::NodeId;
use crate::crypto::{ct_eq, hmac, p256_verify_parts, Entropy, KeyHash, PublicKey};
use crate::codec::{R, W};

/// Revoked device keys a member keeps (the latest list; older entries rotate out).
pub const REVOKED_MAX: usize = 8;
/// Revocations one order carries.
pub const ORDER_REVOKED: usize = 4;
/// Wraps per packet (7 × 26 B + 7 B header fit a 192-byte payload).
pub const WRAPS_PER_PACKET: usize = 7;
/// The gateway re-sends the head and missing wraps this often.
pub const RETRY_US: i64 = 1_000_000;

pub const T_REKEY_HEAD: u8 = 0x50;
pub const T_REKEY_WRAPS: u8 = 0x51;
pub const T_REKEY_ACK: u8 = 0x52;

/// The device keys the admin removed.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Revocations {
    pub version: u16,
    n: u8,
    h: [KeyHash; REVOKED_MAX],
}

impl Revocations {
    pub const LEN: usize = 2 + 1 + REVOKED_MAX * 8;

    pub fn contains(&self, kh: &KeyHash) -> bool {
        self.h[..self.n as usize].iter().any(|h| ct_eq(h, kh))
    }

    /// Apply a newer signed list: its entries go in first, older ones are kept while room.
    pub fn apply(&mut self, version: u16, hashes: &[KeyHash]) {
        if version <= self.version && self.n > 0 {
            return;
        }
        let old = *self;
        *self = Revocations { version, n: 0, h: [[0; 8]; REVOKED_MAX] };
        for h in hashes.iter().chain(old.h[..old.n as usize].iter()) {
            if !self.contains(h) && (self.n as usize) < REVOKED_MAX {
                self.h[self.n as usize] = *h;
                self.n += 1;
            }
        }
    }

    pub fn len(&self) -> usize {
        self.n as usize
    }

    pub fn is_empty(&self) -> bool {
        self.n == 0
    }

    pub fn encode_into(&self, w: &mut W<'_>) {
        w.u16(self.version).u8(self.n);
        for h in &self.h {
            w.put(h);
        }
    }

    pub fn decode_from(r: &mut R<'_>) -> Option<Revocations> {
        let version = r.u16()?;
        let n = r.u8()?;
        if n as usize > REVOKED_MAX {
            return None;
        }
        let mut h = [[0u8; 8]; REVOKED_MAX];
        for x in h.iter_mut() {
            *x = r.arr()?;
        }
        Some(Revocations { version, n, h })
    }
}

/// The commitment to the new keys the order signs.
pub fn keys_hash(mesh_key: &[u8; 16], site_secret: &[u8; 32]) -> [u8; 16] {
    let h = hmac(b"SMkeys1", &[mesh_key, site_secret]);
    let mut o = [0u8; 16];
    o.copy_from_slice(&h[..16]);
    o
}

/// Signed by the admin key.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RekeyOrder {
    pub mesh_id: u32,
    pub epoch: u8,
    pub keys_hash: [u8; 16],
    pub rev_version: u16,
    pub revoked: [KeyHash; ORDER_REVOKED],
    pub n_revoked: u8,
    pub sig: [u8; 64],
}

impl RekeyOrder {
    pub const LEN: usize = 4 + 1 + 16 + 2 + 1 + ORDER_REVOKED * 8 + 64;

    fn signed<'a>(&self, b: &'a mut [u8; 64]) -> &'a [u8] {
        let mut w = W::new(b);
        w.put(b"SMrekey1").u32(self.mesh_id).u8(self.epoch).put(&self.keys_hash).u16(self.rev_version).u8(self.n_revoked);
        for h in &self.revoked {
            w.put(h);
        }
        let n = w.done().unwrap_or(0);
        &b[..n]
    }

    pub fn verify(&self, admin_key: &PublicKey) -> bool {
        let mut b = [0u8; 64];
        let m = self.signed(&mut b);
        p256_verify_parts(admin_key, &[m], &self.sig)
    }

    /// The app side: sign an order for these new keys and revocations.
    #[cfg(any(test, feature = "host"))]
    pub fn sign(
        signer: &crate::host_keys::AdminSigner,
        mesh_id: u32,
        epoch: u8,
        mesh_key: &[u8; 16],
        site_secret: &[u8; 32],
        rev_version: u16,
        revoked: &[KeyHash],
    ) -> RekeyOrder {
        let mut r = [[0u8; 8]; ORDER_REVOKED];
        let n = revoked.len().min(ORDER_REVOKED);
        r[..n].copy_from_slice(&revoked[..n]);
        let mut o = RekeyOrder { mesh_id, epoch, keys_hash: keys_hash(mesh_key, site_secret), rev_version, revoked: r, n_revoked: n as u8, sig: [0; 64] };
        let mut b = [0u8; 64];
        let m = o.signed(&mut b).to_vec();
        o.sig = signer.sign(&m);
        o
    }

    fn encode_into(&self, w: &mut W<'_>) {
        w.u32(self.mesh_id).u8(self.epoch).put(&self.keys_hash).u16(self.rev_version).u8(self.n_revoked);
        for h in &self.revoked {
            w.put(h);
        }
        w.put(&self.sig);
    }

    fn decode_from(r: &mut R<'_>) -> Option<RekeyOrder> {
        let mesh_id = r.u32()?;
        let epoch = r.u8()?;
        let keys_hash = r.arr()?;
        let rev_version = r.u16()?;
        let n_revoked = r.u8()?;
        let mut revoked = [[0u8; 8]; ORDER_REVOKED];
        for h in revoked.iter_mut() {
            *h = r.arr()?;
        }
        if n_revoked as usize > ORDER_REVOKED {
            return None;
        }
        Some(RekeyOrder { mesh_id, epoch, keys_hash, rev_version, revoked, n_revoked, sig: r.arr()? })
    }
}

const KEYS_PLAIN: usize = 16 + 32;
const KEYS_CT: usize = KEYS_PLAIN + 8;

/// The order and the new keys under `K_t`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RekeyHead {
    pub session: u32,
    pub order: RekeyOrder,
    pub nonce: u32,
    pub ct: [u8; KEYS_CT],
}

impl RekeyHead {
    pub const LEN: usize = 1 + 4 + RekeyOrder::LEN + 4 + KEYS_CT;
}

/// `K_t` wrapped per member.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RekeyWraps {
    pub session: u32,
    pub epoch: u8,
    pub n: u8,
    pub e: [(NodeId, [u8; 24]); WRAPS_PER_PACKET],
}

impl RekeyWraps {
    pub const fn len_for(n: usize) -> usize {
        1 + 4 + 1 + 1 + n * 26
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RekeyMsg {
    Head(RekeyHead),
    Wraps(RekeyWraps),
    /// Member → gateway, MAC'd under the pairwise key.
    Ack { session: u32, epoch: u8, node: NodeId, mac: [u8; 8] },
}

impl RekeyMsg {
    pub fn encode(&self, out: &mut [u8]) -> Option<usize> {
        let mut w = W::new(out);
        match self {
            RekeyMsg::Head(h) => {
                w.u8(T_REKEY_HEAD).u32(h.session);
                h.order.encode_into(&mut w);
                w.u32(h.nonce).put(&h.ct);
            }
            RekeyMsg::Wraps(x) => {
                w.u8(T_REKEY_WRAPS).u32(x.session).u8(x.epoch).u8(x.n);
                for (node, wr) in &x.e[..x.n as usize] {
                    w.u16(*node).put(wr);
                }
            }
            RekeyMsg::Ack { session, epoch, node, mac } => {
                w.u8(T_REKEY_ACK).u32(*session).u8(*epoch).u16(*node).put(mac);
            }
        }
        w.done()
    }

    pub fn decode(b: &[u8]) -> Option<RekeyMsg> {
        let mut r = R::new(b);
        let m = match r.u8()? {
            T_REKEY_HEAD => RekeyMsg::Head(RekeyHead { session: r.u32()?, order: RekeyOrder::decode_from(&mut r)?, nonce: r.u32()?, ct: r.arr()? }),
            T_REKEY_WRAPS => {
                let session = r.u32()?;
                let epoch = r.u8()?;
                let n = r.u8()?;
                if n as usize > WRAPS_PER_PACKET {
                    return None;
                }
                let mut e = [(0u16, [0u8; 24]); WRAPS_PER_PACKET];
                for x in e.iter_mut().take(n as usize) {
                    *x = (r.u16()?, r.arr()?);
                }
                RekeyMsg::Wraps(RekeyWraps { session, epoch, n, e })
            }
            T_REKEY_ACK => RekeyMsg::Ack { session: r.u32()?, epoch: r.u8()?, node: r.u16()?, mac: r.arr()? },
            _ => return None,
        };
        r.end()?;
        Some(m)
    }
}

fn keys_nonce(session: u32, epoch: u8, nonce: u32) -> [u8; 13] {
    let mut n = [0u8; 13];
    n[0] = 0x4B; // 'K'
    n[1..5].copy_from_slice(&session.to_be_bytes());
    n[5] = epoch;
    n[6..10].copy_from_slice(&nonce.to_be_bytes());
    n
}

fn wrap_nonce(session: u32, epoch: u8, node: NodeId, nonce: u32) -> [u8; 13] {
    let mut n = [0u8; 13];
    n[0] = 0x57; // 'W'
    n[1..5].copy_from_slice(&session.to_be_bytes());
    n[5] = epoch;
    n[6..8].copy_from_slice(&node.to_be_bytes());
    n[8..12].copy_from_slice(&nonce.to_be_bytes());
    n
}

fn ack_mac(k: &[u8; 16], session: u32, epoch: u8, node: NodeId) -> [u8; 8] {
    let h = hmac(k, &[b"SMrack1", &session.to_be_bytes(), &[epoch], &node.to_be_bytes()]);
    let mut m = [0u8; 8];
    m.copy_from_slice(&h[..8]);
    m
}

/// New keys a member installs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NewKeys {
    pub epoch: u8,
    pub mesh_key: [u8; 16],
    pub site_secret: [u8; 32],
    pub rev_version: u16,
    pub revoked: [KeyHash; ORDER_REVOKED],
    pub n_revoked: u8,
}

/// The gateway's side of one rotation.
pub struct Rekeyer {
    head: RekeyHead,
    k_t: [u8; 16],
    /// Roster nodes still to ack.
    pending: [Option<NodeId>; 64],
    next_us: i64,
    cursor: usize,
    head_sent: bool,
    pub started_us: i64,
    pub done_us: Option<i64>,
}

impl Rekeyer {
    /// Start a rotation for the session's roster. `order` is the app's signed order for
    /// `mesh_key`/`site_secret` (checked here too: a gateway relays only what it can verify).
    #[allow(clippy::too_many_arguments)]
    pub fn start<const N: usize>(
        now_us: i64,
        gs: &GatewaySession<N>,
        order: RekeyOrder,
        mesh_key: &[u8; 16],
        site_secret: &[u8; 32],
        admin_key: &PublicKey,
        exclude: &[NodeId],
        rng: &mut dyn Entropy,
    ) -> Option<Rekeyer> {
        if order.keys_hash != keys_hash(mesh_key, site_secret) || !order.verify(admin_key) {
            return None;
        }
        let mut k_t = [0u8; 16];
        rng.fill(&mut k_t);
        let nonce = rng.u32();
        let mut ct = [0u8; KEYS_CT];
        ct[..16].copy_from_slice(mesh_key);
        ct[16..48].copy_from_slice(site_secret);
        let session = gs.grant.session;
        ccm_seal::<8>(&k_t, &keys_nonce(session, order.epoch, nonce), &order.keys_hash, &mut ct, KEYS_PLAIN);
        let mut pending = [None; 64];
        for (p, e) in pending.iter_mut().zip(gs.roster().filter(|e| !exclude.contains(&e.node))) {
            *p = Some(e.node);
        }
        Some(Rekeyer { head: RekeyHead { session, order, nonce, ct }, k_t, pending, next_us: now_us, cursor: 0, head_sent: false, started_us: now_us, done_us: None })
    }

    pub fn epoch(&self) -> u8 {
        self.head.order.epoch
    }

    pub fn remaining(&self) -> usize {
        self.pending.iter().flatten().count()
    }

    /// The next packet to broadcast now (the head, then wrap packets for unacked members),
    /// or None until the next retry round.
    pub fn next_packet<const N: usize>(&mut self, now_us: i64, gs: &GatewaySession<N>, out: &mut [u8]) -> Option<usize> {
        if self.done_us.is_some() || now_us < self.next_us {
            return None;
        }
        if !self.head_sent {
            self.head_sent = true;
            return RekeyMsg::Head(self.head).encode(out);
        }
        let pend: [Option<NodeId>; 64] = self.pending;
        let todo: &[Option<NodeId>] = &pend;
        let mut w = RekeyWraps { session: self.head.session, epoch: self.head.order.epoch, n: 0, e: [(0, [0; 24]); WRAPS_PER_PACKET] };
        while self.cursor < todo.len() && (w.n as usize) < WRAPS_PER_PACKET {
            if let Some(node) = todo[self.cursor] {
                if let Some(e) = gs.entry(node) {
                    let mut x = [0u8; 24];
                    x[..16].copy_from_slice(&self.k_t);
                    ccm_seal::<8>(&e.key, &wrap_nonce(w.session, w.epoch, node, self.head.nonce), &self.head.order.keys_hash, &mut x, 16);
                    w.e[w.n as usize] = (node, x);
                    w.n += 1;
                }
            }
            self.cursor += 1;
        }
        if self.cursor >= todo.len() {
            // Round done: next round (head again, then the still-missing wraps) after a pause.
            self.cursor = 0;
            self.head_sent = false;
            self.next_us = now_us + RETRY_US;
        }
        if w.n == 0 {
            return None;
        }
        RekeyMsg::Wraps(w).encode(out)
    }

    /// A member's ack; true when everyone has acked.
    pub fn on_ack<const N: usize>(&mut self, now_us: i64, m: &RekeyMsg, gs: &GatewaySession<N>) -> bool {
        let RekeyMsg::Ack { session, epoch, node, mac } = *m else { return false };
        if session != self.head.session || epoch != self.head.order.epoch {
            return false;
        }
        let Some(e) = gs.entry(node) else { return false };
        if !ct_eq(&ack_mac(&e.key, session, epoch, node), &mac) {
            return false;
        }
        for p in self.pending.iter_mut() {
            if *p == Some(node) {
                *p = None;
            }
        }
        if self.remaining() == 0 && self.done_us.is_none() {
            self.done_us = Some(now_us);
        }
        self.done_us.is_some()
    }
}

/// A member's side: the head (order verified once) and its wrap, until both are in.
#[derive(Default)]
pub struct RekeyMember {
    head: Option<RekeyHead>,
    wrap: Option<(u32, u8, [u8; 24])>,
    /// The last epoch installed (to re-ack a retried round without redoing anything).
    done: Option<(u32, u8)>,
    pub bad: u32,
}

impl RekeyMember {
    /// A rekey packet for us. Returns the new keys once complete, and the ack to send.
    pub fn on_msg(
        &mut self,
        m: &RekeyMsg,
        from: NodeId,
        me: NodeId,
        mesh_id: u32,
        sessions: &Sessions,
        admin_key: Option<&PublicKey>,
    ) -> (Option<NewKeys>, Option<RekeyMsg>) {
        match m {
            RekeyMsg::Head(h) => {
                if sessions.get(h.session).filter(|s| s.gateway == from).is_none() {
                    return (None, None);
                }
                if self.done == Some((h.session, h.order.epoch)) {
                    // Already installed. Re-ack only if a re-sent wrap names us (the gateway
                    // missed our ack): 64 members re-acking every round is an ack storm.
                    return (None, None);
                }
                if self.head.is_some_and(|x| x.session == h.session && x.order.epoch == h.order.epoch) {
                    // Already verified.
                } else if h.order.mesh_id == mesh_id && admin_key.is_some_and(|k| h.order.verify(k)) {
                    self.head = Some(*h);
                } else {
                    self.bad += 1;
                    return (None, None);
                }
            }
            RekeyMsg::Wraps(w) => {
                if self.done == Some((w.session, w.epoch)) && w.e[..w.n as usize].iter().any(|(n, _)| *n == me) {
                    let Some(s) = sessions.get(w.session).filter(|s| s.gateway == from) else { return (None, None) };
                    return (None, Some(RekeyMsg::Ack { session: w.session, epoch: w.epoch, node: me, mac: ack_mac(&s.key, w.session, w.epoch, me) }));
                }
                if let Some((_, x)) = w.e[..w.n as usize].iter().find(|(n, _)| *n == me) {
                    if sessions.get(w.session).is_some_and(|s| s.gateway == from) {
                        self.wrap = Some((w.session, w.epoch, *x));
                    }
                }
            }
            RekeyMsg::Ack { .. } => return (None, None),
        }
        self.try_finish(me, sessions)
    }

    fn try_finish(&mut self, me: NodeId, sessions: &Sessions) -> (Option<NewKeys>, Option<RekeyMsg>) {
        let (Some(h), Some((ws, we, wr))) = (self.head, self.wrap) else { return (None, None) };
        if ws != h.session || we != h.order.epoch {
            return (None, None);
        }
        let Some(s) = sessions.get(h.session) else { return (None, None) };
        let mut x = wr;
        let ok = ccm_open::<8>(&s.key, &wrap_nonce(ws, we, me, h.nonce), &h.order.keys_hash, &mut x, 24).is_some();
        let mut k_t = [0u8; 16];
        k_t.copy_from_slice(&x[..16]);
        let mut ct = h.ct;
        let ok = ok && ccm_open::<8>(&k_t, &keys_nonce(h.session, h.order.epoch, h.nonce), &h.order.keys_hash, &mut ct, KEYS_CT).is_some();
        self.head = None;
        self.wrap = None;
        if !ok {
            self.bad += 1;
            return (None, None);
        }
        let mut mesh_key = [0u8; 16];
        mesh_key.copy_from_slice(&ct[..16]);
        let mut site_secret = [0u8; 32];
        site_secret.copy_from_slice(&ct[16..48]);
        if !ct_eq(&keys_hash(&mesh_key, &site_secret), &h.order.keys_hash) {
            self.bad += 1;
            return (None, None);
        }
        self.done = Some((h.session, h.order.epoch));
        let o = h.order;
        let keys = NewKeys { epoch: o.epoch, mesh_key, site_secret, rev_version: o.rev_version, revoked: o.revoked, n_revoked: o.n_revoked };
        let ack = RekeyMsg::Ack { session: h.session, epoch: o.epoch, node: me, mac: ack_mac(&s.key, h.session, o.epoch, me) };
        (Some(keys), Some(ack))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::admin::GatewaySession;
    use crate::crypto::DeviceKey;
    use crate::host_keys::{AdminSigner, HostKey, TestRng};

    const MESH: u32 = 0x0E5E_0001;

    #[test]
    fn rotation_reaches_the_remaining_members_only() {
        let admin = AdminSigner::from_secret(b"0123456789abcdef", MESH);
        let gw = HostKey::from_seed(1);
        let g = admin.grant(MESH, 7, 1, gw.public_key(), 1000);
        let mut gs = GatewaySession::<16>::new(g);
        let mut rng = TestRng(4);
        let ids: Vec<NodeId> = (2..=10).collect();
        let devs: Vec<HostKey> = ids.iter().map(|&i| HostKey::from_seed(i as u64)).collect();
        let mut sess: Vec<Sessions> = ids.iter().map(|_| Sessions::new()).collect();
        for ((s, d), &id) in sess.iter_mut().zip(&devs).zip(&ids) {
            let ack = s.on_grant(0, 0, &g, Some(&admin.public()), MESH, id, d, &mut rng).unwrap().unwrap();
            let (_, conf) = gs.on_ack(&ack, &gw, MESH, 1, 50).unwrap();
            s.on_confirm(1, &conf, id);
        }
        // Remove node 10: its key hash is revoked.
        let removed = crate::crypto::key_hash(&devs[8].public_key());
        let (mk, ss) = ([0x99u8; 16], [0x77u8; 32]);
        let order = RekeyOrder::sign(&admin, MESH, 2, &mk, &ss, 1, &[removed]);
        // A gateway refuses an order whose keys don't match its commitment.
        assert!(Rekeyer::start(0, &gs, order, &[0; 16], &ss, &admin.public(), &[10], &mut rng).is_none());
        let mut rk = Rekeyer::start(0, &gs, order, &mk, &ss, &admin.public(), &[10], &mut rng).unwrap();
        assert_eq!(rk.remaining(), 8);
        let mut packets = Vec::new();
        let mut b = [0u8; 256];
        while let Some(n) = rk.next_packet(0, &gs, &mut b) {
            packets.push(b[..n].to_vec());
        }
        assert_eq!(packets.len(), 3, "head + 2 wrap packets for 8 members");
        assert_eq!(packets[0].len(), RekeyHead::LEN);
        assert!(packets[0].len() <= 192);
        assert_eq!(packets[1].len(), RekeyWraps::len_for(7));
        let mut members: Vec<RekeyMember> = ids.iter().map(|_| RekeyMember::default()).collect();
        let mut got = 0;
        for (i, &id) in ids.iter().enumerate() {
            for p in &packets {
                let m = RekeyMsg::decode(p).unwrap();
                let (keys, ack) = members[i].on_msg(&m, 1, id, MESH, &sess[i], Some(&admin.public()));
                if let Some(k) = keys {
                    assert_eq!((k.epoch, k.mesh_key, k.site_secret), (2, mk, ss));
                    assert_eq!(k.revoked[0], removed);
                    got += 1;
                    rk.on_ack(5, &ack.unwrap(), &gs);
                }
            }
        }
        assert_eq!(got, 8, "node 10 has no wrap");
        assert_eq!(rk.done_us, Some(5));
        // Another member's pairwise key cannot open someone else's wrap.
        let m = RekeyMsg::decode(&packets[1]).unwrap();
        let RekeyMsg::Wraps(w) = m else { unreachable!() };
        let mut stolen = RekeyMember::default();
        stolen.on_msg(&RekeyMsg::decode(&packets[0]).unwrap(), 1, 3, MESH, &sess[0], Some(&admin.public()));
        let mut w2 = w;
        w2.e[0] = (2, w.e[1].1); // node 3's wrap relabelled for node 2, opened with node 2's key
        w2.n = 1;
        let (k, _) = stolen.on_msg(&RekeyMsg::Wraps(w2), 1, 2, MESH, &sess[0], Some(&admin.public()));
        assert!(k.is_none());
        // An order not signed by the admin key is ignored.
        let rogue = RekeyOrder::sign(&AdminSigner::from_secret(b"fedcba9876543210", MESH), MESH, 3, &mk, &ss, 2, &[]);
        let mut fresh = RekeyMember::default();
        let head = RekeyMsg::Head(RekeyHead { session: 7, order: rogue, nonce: 1, ct: [0; KEYS_CT] });
        assert_eq!(fresh.on_msg(&head, 1, 2, MESH, &sess[0], Some(&admin.public())), (None, None));
        assert_eq!(fresh.bad, 1);
    }

    #[test]
    fn revocations_keep_the_latest() {
        let mut r = Revocations::default();
        r.apply(1, &[[1; 8], [2; 8]]);
        r.apply(1, &[[3; 8]]);
        assert!(!r.contains(&[3; 8]), "same version ignored");
        r.apply(2, &[[3; 8]]);
        assert!(r.contains(&[1; 8]) && r.contains(&[3; 8]));
        for v in 3..20u16 {
            r.apply(v, &[[v as u8; 8]]);
        }
        assert_eq!(r.len(), REVOKED_MAX);
        assert!(r.contains(&[19; 8]) && !r.contains(&[1; 8]));
    }

    #[test]
    fn sizes() {
        assert_eq!(RekeyHead::LEN, 185);
        assert_eq!(RekeyWraps::len_for(7), 189);
        assert_eq!(RekeyWraps::len_for(1) - RekeyWraps::len_for(0), 26);
    }
}
