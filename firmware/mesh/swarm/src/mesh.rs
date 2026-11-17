// Ported from fughilli/indoor_localization swarm/net/src/mesh.rs at 5a906e78 (Splanc owns this
// copy; firmware/mesh/swarm/PROVENANCE.md lists what changed).
//! Mesh packets with Meshtastic-style managed flooding (firmware/mesh/swarm/docs/swarm-network.md
//! "Mesh packets"). Link-agnostic: the radio hands over every mesh frame it
//! hears (with its signal strength) and, in its own TDMA slot, asks for the
//! next frame to send.
//!
//! - Duplicates are dropped by (origin, id, attempt): an origin's retry is a
//!   new attempt that relays carry again, while the destination delivers each
//!   (origin, id) once (and re-acks repeats, in case its ack was lost).
//! - A packet is relayed (hop limit permitting) after a delay of 0..=window
//!   of this node's slots; the *weaker* the signal it arrived on, the sooner,
//!   since distant relays extend coverage most. Overhearing another node
//!   relay it first cancels ours.
//! - Unicast with want-ack: the destination answers with an ack packet; the
//!   origin retries until it hears it (or gives up).
//!
//! A packet on the air is a `MeshPacket` protobuf message (swarm_wire.proto): the origin's
//! retry number, hop limit and flags are separate fields, and a broadcast has no `dest`.

use crate::wire::{self, pb};

pub const BROADCAST: u16 = 0xFFFF;
/// The mesh payload: 125 - 10 link header - 24 MeshPacket header = 91, three bytes of
/// slack (firmware/mesh/swarm/docs/swarm-wire.md). This is the swarm's (UWB) payload and the
/// default capacity of a [`MeshOf`]; the swarm's own ports (settings, acks, reports) keep
/// their messages within it, so they fit every backhaul.
pub const MAX_PAYLOAD: usize = 88;
/// Longest encoded MeshPacket: header 24 (every id at full width, every small field set,
/// payload tag and length included) + payload.
pub const MAX_PACKET: usize = 24 + MAX_PAYLOAD;

/// Splanc: the largest payload capacity a [`MeshOf`] may be built with (an IP or ESP-NOW v2
/// sized backhaul; design §5.2). `MeshPacket.payload max_len` in swarm_wire_bounds.txt.
pub const PAYLOAD_CAP: usize = 1400;

/// Splanc: longest encoded MeshPacket for a payload capacity of `payload` bytes: the 24-byte
/// header, one more once the payload length needs a two-byte varint (128..=16383).
pub const fn max_packet(payload: usize) -> usize {
    if payload < 128 {
        24 + payload
    } else {
        25 + payload
    }
}
const _: () = assert!(max_packet(MAX_PAYLOAD) == MAX_PACKET);

pub const FLAG_WANT_ACK: u8 = 1 << 0;
pub const FLAG_IS_ACK: u8 = 1 << 1;
/// Largest hop limit / hop start / attempt and port: one-byte varints (the header budget).
pub const MAX_SMALL: u8 = 127;
/// Retry numbers stay below this (the origin sends at most 16 attempts).
const MAX_ATTEMPT: u8 = 15;

/// Port of ack packets (payload: `Ack`, the acked id).
pub const PORT_ACK: u8 = 0;

const SEEN_LEN: usize = 64;
const DELIVERED_LEN: usize = 32;
// Splanc: sized for the real traffic (docs/design/mesh.md §10.3: one fader stream, beacons,
// status; bulk is pull-based from flash), not 8 worst-case packets each (upstream). A
// high-capacity node (P4 + C6, Pi) gets depth from its custodian store instead (spill).
/// Relay slots (the most this instance holds; `relay_cap` may lower it at run time).
pub const RELAY_LEN: usize = 4;
/// Originated packets awaiting their send or ack.
pub const OUTBOX_LEN: usize = 4;
const EVENTS_LEN: usize = 4;

/// Splanc: relay priority classes, lowest first (`MeshConfig::priority`).
pub const PRIO_BULK: usize = 0;
pub const PRIO_NORMAL: usize = 1;
pub const PRIO_HIGH: usize = 2;
pub const PRIO_CLASSES: usize = 3;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MeshConfig {
    /// Hop limit given to packets this node originates.
    pub hop_limit: u8,
    /// Relay delay window, in this node's own slots.
    pub relay_window: u32,
    /// Signal strength (dBm) at/above which a relay waits the full window
    /// and at/below which it goes in the first slot.
    pub rssi_strong: f32,
    pub rssi_weak: f32,
    pub ack_timeout_us: i64,
    /// Transmissions of a want-ack packet before giving up.
    pub max_tries: u8,
    /// Splanc: ports 0..32 relayed at high priority (bit per port; acks always are).
    pub high_ports: u32,
    /// Splanc: ports at or above this are bulk (lowest priority). 255: none.
    pub bulk_from: u8,
    /// Splanc: slots added to a bulk packet's relay delay (negative: earlier). High-capacity
    /// nodes relay bulk first, so constrained ones hear it and cancel theirs.
    pub bulk_relay_bias: i8,
}

impl MeshConfig {
    /// The relay priority class of `port`.
    pub fn priority(&self, port: u8) -> usize {
        if port == PORT_ACK || (port < 32 && self.high_ports & (1 << port) != 0) {
            PRIO_HIGH
        } else if port >= self.bulk_from {
            PRIO_BULK
        } else {
            PRIO_NORMAL
        }
    }
}

impl Default for MeshConfig {
    fn default() -> MeshConfig {
        MeshConfig {
            hop_limit: 3,
            relay_window: 3,
            rssi_strong: -60.0,
            rssi_weak: -90.0,
            ack_timeout_us: 1_000_000,
            max_tries: 3,
            high_ports: 0,
            bulk_from: 255,
            bulk_relay_bias: 0,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Header {
    pub origin: u16,
    pub id: u16,
    pub dest: u16,
    pub hop_limit: u8,
    pub hop_start: u8,
    /// FLAG_* bits.
    pub flags: u8,
    /// Retry number of the origin's transmission (0..=15).
    pub attempt: u8,
    pub port: u8,
}

/// A mesh packet with room for `P` payload bytes (Splanc: the capacity is a parameter, so
/// each backhaul's mesh instance holds packets of its own size; upstream fixed it at 88).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PacketOf<const P: usize> {
    pub header: Header,
    pub len: u16,
    pub payload: [u8; P],
}

/// The swarm's packet: 88 payload bytes.
pub type Packet = PacketOf<MAX_PAYLOAD>;

impl<const P: usize> PacketOf<P> {
    pub fn new(header: Header, payload: &[u8]) -> Option<PacketOf<P>> {
        if payload.len() > P {
            return None;
        }
        let mut p = PacketOf { header, len: payload.len() as u16, payload: [0; P] };
        p.payload[..payload.len()].copy_from_slice(payload);
        Some(p)
    }

    pub fn payload(&self) -> &[u8] {
        &self.payload[..self.len as usize]
    }

    /// A MeshPacket. `dest` is absent on the wire for a broadcast; every other small field
    /// is omitted at 0 (proto3).
    pub fn encode(&self, out: &mut [u8]) -> Option<usize> {
        let h = &self.header;
        let dest = if h.dest == BROADCAST { None } else { Some(h.dest as u32) };
        wire::mesh_packet(
            h.origin as u32,
            h.id as u32,
            dest,
            h.hop_limit as u32,
            h.hop_start as u32,
            h.port as u32,
            h.flags as u32,
            h.attempt as u32,
            self.payload(),
            out,
        )
    }

    /// None for anything malformed, or with a field outside what this node produces
    /// (ids above 16 bits, small fields above 127, payload above the capacity `P`).
    pub fn decode(b: &[u8]) -> Option<PacketOf<P>> {
        let m = pb::MeshPacketView::parse(b).ok()?;
        let small = |v: u32| u8::try_from(v).ok().filter(|&v| v <= MAX_SMALL);
        let header = Header {
            origin: u16::try_from(m.origin()).ok()?,
            id: u16::try_from(m.id()).ok()?,
            dest: match m.dest() {
                Some(d) => u16::try_from(d).ok()?,
                None => BROADCAST,
            },
            hop_limit: small(m.hop_limit())?,
            hop_start: small(m.hop_start())?,
            flags: small(m.flags())?,
            attempt: small(m.attempt())?,
            port: small(m.port())?,
        };
        PacketOf::new(header, m.payload())
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum EventOf<const P: usize> {
    /// A packet for this node (unicast to it, or broadcast). `rssi` of the
    /// copy that arrived first; `hops` it took.
    Deliver { packet: PacketOf<P>, rssi: f32, hops: u8 },
    /// A want-ack packet this node sent was acknowledged.
    Acked { dest: u16, id: u16 },
    /// ... or ran out of tries.
    Failed { dest: u16, id: u16 },
}

/// The swarm's events (88-byte packets).
pub type Event = EventOf<MAX_PAYLOAD>;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MeshStats {
    pub originated: u32,
    pub delivered: u32,
    pub relayed: u32,
    /// Relays dropped because another node relayed first.
    pub relays_cancelled: u32,
    pub duplicates: u32,
    pub retries: u32,
    pub acked: u32,
    pub failed: u32,
    pub dropped_full: u32,
    /// Splanc: relays dropped for room, by priority class (the drop policy's record).
    pub dropped_by_prio: [u32; PRIO_CLASSES],
    /// Splanc: relays handed to the custodian store instead of dropped.
    pub spilled: u32,
    /// Splanc: the most relay / outbox slots ever in use at once.
    pub peak_relays: u8,
    pub peak_outbox: u8,
    /// Splanc: packets not sent or relayed because their payload exceeds this instance's
    /// `max_payload` (the backhaul MTU), though they fit its capacity.
    pub oversize: u32,
}

#[derive(Clone, Copy)]
pub struct Relay<const P: usize> {
    pub packet: PacketOf<P>,
    pub due_slot: u32,
    /// Insertion order (the drop policy evicts the oldest of the lowest class).
    seq: u32,
}

#[derive(Clone, Copy)]
struct Pending<const P: usize> {
    packet: PacketOf<P>,
    tries: u8,
    next_us: i64,
}

/// One node's mesh layer, holding packets of up to `P` payload bytes (its RAM scales with
/// `P`: about 32 packets are buffered). Splanc: `max_payload` lowers the limit at run time
/// to what the backhaul carries ([`MeshOf::set_max_payload`]).
pub struct MeshOf<const P: usize> {
    pub me: u16,
    pub cfg: MeshConfig,
    pub stats: MeshStats,
    max_payload: usize,
    next_id: u16,
    seen: [(u16, u16, u8); SEEN_LEN],
    seen_n: usize,
    seen_at: usize,
    delivered: [(u16, u16); DELIVERED_LEN],
    delivered_n: usize,
    delivered_at: usize,
    relays: [Option<Relay<P>>; RELAY_LEN],
    outbox: [Option<Pending<P>>; OUTBOX_LEN],
    events: [Option<EventOf<P>>; EVENTS_LEN],
    ev_head: usize,
    ev_len: usize,
    slot: u32,
    rng: u32,
    /// Splanc: run-time queue limits (≤ RELAY_LEN / OUTBOX_LEN).
    relay_cap: usize,
    outbox_cap: usize,
    /// Splanc: a high-capacity node keeps what the drop policy evicts here for its
    /// custodian store ([`MeshOf::take_spilled`]) instead of dropping it. Feature
    /// `custodian_spill` (off on firmware: the slot costs ~230 B on every C6 and the sweeps
    /// never used it; docs/design/mesh.md §10.6).
    #[cfg(feature = "custodian_spill")]
    pub spill: bool,
    #[cfg(feature = "custodian_spill")]
    spilled: Option<Relay<P>>,
    relay_seq: u32,
}

/// The swarm's mesh: 88-byte payloads.
pub type Mesh = MeshOf<MAX_PAYLOAD>;

impl<const P: usize> MeshOf<P> {
    /// The payload capacity, checked when an instance is built.
    const CAPACITY: usize = {
        assert!(P >= MAX_PAYLOAD, "the swarm's own ports need 88-byte payloads");
        assert!(P <= PAYLOAD_CAP, "MeshPacket.payload max_len (swarm_wire_bounds.txt)");
        P
    };

    /// `seed` varies the first packet id across reboots (so a rebooted node
    /// isn't taken for a duplicate of its old self).
    pub fn new(me: u16, cfg: MeshConfig, seed: u32) -> MeshOf<P> {
        MeshOf {
            me,
            cfg,
            stats: MeshStats::default(),
            max_payload: Self::CAPACITY,
            next_id: seed as u16,
            seen: [(0, 0, 0); SEEN_LEN],
            seen_n: 0,
            seen_at: 0,
            delivered: [(0, 0); DELIVERED_LEN],
            delivered_n: 0,
            delivered_at: 0,
            relays: [None; RELAY_LEN],
            outbox: [None; OUTBOX_LEN],
            events: [None; EVENTS_LEN],
            ev_head: 0,
            ev_len: 0,
            slot: 0,
            rng: seed | 1,
            relay_cap: RELAY_LEN,
            outbox_cap: OUTBOX_LEN,
            #[cfg(feature = "custodian_spill")]
            spill: false,
            #[cfg(feature = "custodian_spill")]
            spilled: None,
            relay_seq: 0,
        }
    }

    /// Splanc: the largest payload this instance sends or relays, clamped to `MAX_PAYLOAD..=P`
    /// (the swarm's own ports need 88). A backhaul with a smaller MTU than the capacity sets
    /// it; received packets up to `P` are still delivered.
    pub fn set_max_payload(&mut self, n: usize) {
        self.max_payload = n.clamp(MAX_PAYLOAD, P);
    }

    /// Splanc: limit the relay and outbox queues (a constrained node's budget).
    pub fn set_caps(&mut self, relays: usize, outbox: usize) {
        self.relay_cap = relays.clamp(1, RELAY_LEN);
        self.outbox_cap = outbox.clamp(1, OUTBOX_LEN);
    }

    /// Relay slots free (the credit a node advertises to its neighbours).
    pub fn relay_room(&self) -> usize {
        self.relay_cap.saturating_sub(self.relays.iter().filter(|r| r.is_some()).count())
    }

    /// Splanc: a relay the drop policy evicted, for the custodian store.
    #[cfg(feature = "custodian_spill")]
    pub fn take_spilled(&mut self) -> Option<Relay<P>> {
        self.spilled.take()
    }

    /// Splanc: put a stored relay back (due now); false if there is no room.
    #[cfg(feature = "custodian_spill")]
    pub fn requeue_relay(&mut self, r: Relay<P>) -> bool {
        let used = self.relays.iter().filter(|x| x.is_some()).count();
        let Some(i) = self.relays.iter().position(|x| x.is_none()).filter(|_| used < self.relay_cap) else { return false };
        self.relay_seq = self.relay_seq.wrapping_add(1);
        self.relays[i] = Some(Relay { due_slot: self.slot, seq: self.relay_seq, ..r });
        self.peak_relays_now();
        true
    }

    /// A free outbox slot within `outbox_cap`.
    fn outbox_slot(&self) -> Option<usize> {
        let used = self.outbox.iter().filter(|o| o.is_some()).count();
        self.outbox.iter().position(|o| o.is_none()).filter(|_| used < self.outbox_cap)
    }

    fn peak_relays_now(&mut self) {
        let n = self.relays.iter().filter(|r| r.is_some()).count() as u8;
        self.stats.peak_relays = self.stats.peak_relays.max(n);
        let o = self.outbox.iter().filter(|r| r.is_some()).count() as u8;
        self.stats.peak_outbox = self.stats.peak_outbox.max(o);
    }

    pub fn max_payload(&self) -> usize {
        self.max_payload
    }

    /// Queue a packet from this node. Returns its id, or None if the outbox
    /// is full or the payload too long.
    pub fn send(&mut self, dest: u16, port: u8, payload: &[u8], want_ack: bool) -> Option<u16> {
        self.send_with_hops(dest, port, payload, want_ack, self.cfg.hop_limit)
    }

    /// send() with an explicit hop limit; 0 keeps a packet to direct
    /// neighbours (local serving traffic that every hop redoes anyway).
    pub fn send_with_hops(&mut self, dest: u16, port: u8, payload: &[u8], want_ack: bool, hop_limit: u8) -> Option<u16> {
        if port > MAX_SMALL || hop_limit > MAX_SMALL {
            return None;
        }
        if payload.len() > self.max_payload {
            self.stats.oversize += 1;
            return None;
        }
        let slot = self.outbox_slot()?;
        self.next_id = self.next_id.wrapping_add(1);
        let id = self.next_id;
        let header = Header {
            origin: self.me,
            id,
            dest,
            hop_limit,
            hop_start: hop_limit,
            flags: if want_ack && dest != BROADCAST { FLAG_WANT_ACK } else { 0 },
            attempt: 0,
            port,
        };
        let packet = PacketOf::new(header, payload)?;
        self.outbox[slot] = Some(Pending { packet, tries: 0, next_us: i64::MIN });
        self.peak_relays_now();
        self.stats.originated += 1;
        Some(id)
    }

    /// Room in the outbox for another packet?
    pub fn can_send(&self) -> bool {
        self.outbox_slot().is_some()
    }

    /// A mesh frame heard off the air.
    pub fn on_rx(&mut self, bytes: &[u8], rssi: f32) {
        let Some(p) = PacketOf::<P>::decode(bytes) else { return };
        let h = p.header;
        if h.origin == self.me {
            return; // our own packet, relayed back
        }
        if self.is_seen(h.origin, h.id, h.attempt) {
            self.stats.duplicates += 1;
            // Someone else relayed it: ours is redundant.
            for r in self.relays.iter_mut() {
                if matches!(r, Some(r) if r.packet.header.origin == h.origin
                    && r.packet.header.id == h.id && r.packet.header.attempt == h.attempt)
                {
                    *r = None;
                    self.stats.relays_cancelled += 1;
                }
            }
            return;
        }
        self.remember(h.origin, h.id, h.attempt);
        let for_me = h.dest == self.me || h.dest == BROADCAST;
        if for_me {
            if h.flags & FLAG_IS_ACK != 0 && h.dest == self.me {
                if let Some(Ok(acked)) = pb::AckView::parse(p.payload()).ok().map(|a| u16::try_from(a.id())) {
                    self.ack_received(h.origin, acked);
                }
            } else {
                if !self.was_delivered(h.origin, h.id) {
                    self.mark_delivered(h.origin, h.id);
                    self.stats.delivered += 1;
                    self.push_event(EventOf::Deliver {
                        packet: p,
                        rssi,
                        hops: h.hop_start.saturating_sub(h.hop_limit),
                    });
                }
                // Ack every attempt: the origin retrying means it missed ours.
                if h.flags & FLAG_WANT_ACK != 0 && h.dest == self.me {
                    self.send_ack(h.origin, h.id);
                }
            }
        }
        if h.dest != self.me && h.hop_limit > 0 {
            if p.payload().len() > self.max_payload {
                self.stats.oversize += 1;
            } else {
                self.schedule_relay(p, rssi);
            }
        }
    }

    /// Call at the start of each of this node's TDMA slots.
    pub fn on_my_slot(&mut self) {
        self.slot = self.slot.wrapping_add(1);
    }

    /// The next frame to send in this slot, encoded into `out`; None when
    /// nothing is due. Relays go first: they're time-critical for coverage.
    pub fn next_tx(&mut self, t_us: i64, out: &mut [u8]) -> Option<usize> {
        let slot = self.slot;
        if let Some(i) = self
            .relays
            .iter()
            .position(|r| matches!(r, Some(r) if r.due_slot.wrapping_sub(slot) as i32 <= 0))
        {
            let r = self.relays[i].take().unwrap();
            self.stats.relayed += 1;
            return r.packet.encode(out);
        }
        for i in 0..OUTBOX_LEN {
            let Some(mut o) = self.outbox[i] else { continue };
            if o.next_us > t_us {
                continue;
            }
            o.packet.header.attempt = o.tries.min(MAX_ATTEMPT);
            let h = o.packet.header;
            self.remember(h.origin, h.id, h.attempt);
            let n = o.packet.encode(out);
            if o.tries > 0 {
                self.stats.retries += 1;
            }
            o.tries += 1;
            if o.packet.header.flags & FLAG_WANT_ACK != 0 {
                o.next_us = t_us + self.cfg.ack_timeout_us;
                self.outbox[i] = Some(o);
            } else {
                self.outbox[i] = None;
            }
            return n;
        }
        None
    }

    /// Expire want-ack packets that used up their tries. Call regularly.
    pub fn poll(&mut self, t_us: i64) {
        for i in 0..OUTBOX_LEN {
            let Some(o) = self.outbox[i] else { continue };
            if o.packet.header.flags & FLAG_WANT_ACK != 0 && o.tries >= self.cfg.max_tries && t_us >= o.next_us {
                self.outbox[i] = None;
                self.stats.failed += 1;
                let h = o.packet.header;
                self.push_event(EventOf::Failed { dest: h.dest, id: h.id });
            }
        }
    }

    pub fn next_event(&mut self) -> Option<EventOf<P>> {
        if self.ev_len == 0 {
            return None;
        }
        let e = self.events[self.ev_head].take();
        self.ev_head = (self.ev_head + 1) % EVENTS_LEN;
        self.ev_len -= 1;
        e
    }

    /// Anything queued to send (originated or relayed)?
    pub fn has_tx(&self, t_us: i64) -> bool {
        let slot = self.slot;
        self.relays.iter().flatten().any(|r| r.due_slot.wrapping_sub(slot) as i32 <= 0)
            || self.outbox.iter().flatten().any(|o| o.next_us <= t_us)
    }

    fn send_ack(&mut self, to: u16, id: u16) {
        let Some(slot) = self.outbox_slot() else {
            self.stats.dropped_full += 1;
            return;
        };
        self.next_id = self.next_id.wrapping_add(1);
        let header = Header {
            origin: self.me,
            id: self.next_id,
            dest: to,
            hop_limit: self.cfg.hop_limit,
            hop_start: self.cfg.hop_limit,
            flags: FLAG_IS_ACK,
            attempt: 0,
            port: PORT_ACK,
        };
        let mut body = [0u8; 8];
        let n = wire::ack(id as u32, &mut body).unwrap();
        let packet = PacketOf::new(header, &body[..n]).unwrap();
        self.outbox[slot] = Some(Pending { packet, tries: 0, next_us: i64::MIN });
        self.peak_relays_now();
    }

    fn ack_received(&mut self, from: u16, id: u16) {
        for i in 0..OUTBOX_LEN {
            if matches!(self.outbox[i], Some(o) if o.packet.header.dest == from && o.packet.header.id == id) {
                self.outbox[i] = None;
                self.stats.acked += 1;
                self.push_event(EventOf::Acked { dest: from, id });
            }
        }
    }

    fn schedule_relay(&mut self, mut p: PacketOf<P>, rssi: f32) {
        let prio = self.cfg.priority(p.header.port);
        let used = self.relays.iter().filter(|r| r.is_some()).count();
        let slot = match self.relays.iter().position(|r| r.is_none()).filter(|_| used < self.relay_cap) {
            Some(s) => s,
            None => {
                // Splanc drop policy: evict the oldest relay of the lowest class below this
                // one's (control, time and membership are never starved by bulk); if none
                // is lower, this one goes. A custodian spills instead of dropping.
                let victim = (0..RELAY_LEN)
                    .filter_map(|i| self.relays[i].map(|r| (i, self.cfg.priority(r.packet.header.port), r.seq)))
                    .filter(|&(_, vp, _)| vp < prio)
                    .min_by_key(|&(_, vp, seq)| (vp, seq));
                match victim {
                    Some((i, vp, _)) => {
                        let old = self.relays[i].take();
                        self.lose(old, vp);
                        i
                    }
                    None => {
                        p.header.hop_limit -= 1;
                        self.relay_seq = self.relay_seq.wrapping_add(1);
                        let r = Relay { packet: p, due_slot: self.slot, seq: self.relay_seq };
                        self.lose(Some(r), prio);
                        return;
                    }
                }
            }
        };
        p.header.hop_limit -= 1;
        let span = self.cfg.rssi_strong - self.cfg.rssi_weak;
        let frac = if span > 0.0 { ((rssi - self.cfg.rssi_weak) / span).clamp(0.0, 1.0) } else { 0.0 };
        // Strong signal -> later; plus a little jitter so equals don't tie.
        let base = (frac * self.cfg.relay_window as f32 + 0.5) as u32;
        let jitter = self.rand() % 2;
        let mut delay = (base + jitter).min(self.cfg.relay_window) as i32;
        if prio == PRIO_BULK {
            delay = (delay + self.cfg.bulk_relay_bias as i32).max(0);
        }
        self.relay_seq = self.relay_seq.wrapping_add(1);
        self.relays[slot] = Some(Relay { packet: p, due_slot: self.slot.wrapping_add(delay as u32), seq: self.relay_seq });
        self.peak_relays_now();
    }

    /// A relay with no room: spilled to the custodian (one slot, drained each tick) or dropped.
    /// High-priority traffic (live control, time, membership) is never spilled: relayed late
    /// it is worse than not at all (the sweep's 64-node runs: p99 1.9 s with it spilled).
    fn lose(&mut self, r: Option<Relay<P>>, prio: usize) {
        #[cfg(feature = "custodian_spill")]
        if self.spill && prio < PRIO_HIGH && self.spilled.is_none() {
            self.spilled = r;
            self.stats.spilled += 1;
            return;
        }
        let _ = r;
        self.stats.dropped_full += 1;
        self.stats.dropped_by_prio[prio] += 1;
    }

    fn is_seen(&self, origin: u16, id: u16, attempt: u8) -> bool {
        self.seen[..self.seen_n].iter().any(|&s| s == (origin, id, attempt))
    }

    fn remember(&mut self, origin: u16, id: u16, attempt: u8) {
        self.seen[self.seen_at] = (origin, id, attempt);
        self.seen_at = (self.seen_at + 1) % SEEN_LEN;
        self.seen_n = (self.seen_n + 1).min(SEEN_LEN);
    }

    fn was_delivered(&self, origin: u16, id: u16) -> bool {
        self.delivered[..self.delivered_n].iter().any(|&d| d == (origin, id))
    }

    fn mark_delivered(&mut self, origin: u16, id: u16) {
        self.delivered[self.delivered_at] = (origin, id);
        self.delivered_at = (self.delivered_at + 1) % DELIVERED_LEN;
        self.delivered_n = (self.delivered_n + 1).min(DELIVERED_LEN);
    }

    fn push_event(&mut self, e: EventOf<P>) {
        if self.ev_len == EVENTS_LEN {
            // Drop the oldest: a reader that falls behind loses history,
            // not the newest news.
            self.ev_head = (self.ev_head + 1) % EVENTS_LEN;
            self.ev_len -= 1;
            self.stats.dropped_full += 1;
        }
        let at = (self.ev_head + self.ev_len) % EVENTS_LEN;
        self.events[at] = Some(e);
        self.ev_len += 1;
    }

    fn rand(&mut self) -> u32 {
        // xorshift32
        let mut x = self.rng;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.rng = x;
        x
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A swarm on a TDMA schedule over a lossy, range-limited channel. Nodes
    /// take turns (one slot each per superframe) and send up to
    /// `frames_per_slot` frames in their slot.
    pub(crate) struct Net {
        pub nodes: Vec<Mesh>,
        /// links[i][j]: rssi if j hears i.
        pub links: Vec<Vec<Option<f32>>>,
        pub loss: f32,
        pub t_us: i64,
        pub airtime: u32,
        pub delivered: Vec<Vec<Event>>,
        rng: u64,
    }

    impl Net {
        pub fn new(n: usize, links: Vec<Vec<Option<f32>>>, loss: f32) -> Net {
            Net {
                nodes: (0..n).map(|i| Mesh::new(i as u16 + 1, MeshConfig::default(), 100 + i as u32)).collect(),
                links,
                loss,
                t_us: 0,
                airtime: 0,
                delivered: vec![Vec::new(); n],
                rng: 0x9E37_79B9_7F4A_7C15,
            }
        }

        /// Everyone hears everyone at `rssi`.
        pub fn full(n: usize, rssi: f32, loss: f32) -> Net {
            let links = (0..n).map(|i| (0..n).map(|j| if i == j { None } else { Some(rssi) }).collect()).collect();
            Net::new(n, links, loss)
        }

        /// A line: each node hears only its neighbours.
        pub fn line(n: usize, loss: f32) -> Net {
            let links = (0..n)
                .map(|i| (0..n).map(|j| if (i as i64 - j as i64).abs() == 1 { Some(-80.0) } else { None }).collect())
                .collect();
            Net::new(n, links, loss)
        }

        fn lost(&mut self) -> bool {
            self.rng ^= self.rng << 13;
            self.rng ^= self.rng >> 7;
            self.rng ^= self.rng << 17;
            ((self.rng >> 11) as f64 / (1u64 << 53) as f64) < self.loss as f64
        }

        pub fn superframe(&mut self, frames_per_slot: usize) {
            let n = self.nodes.len();
            for i in 0..n {
                self.t_us += 5_000;
                self.nodes[i].on_my_slot();
                for _ in 0..frames_per_slot {
                    let mut buf = [0u8; MAX_PACKET];
                    let t = self.t_us;
                    let Some(len) = self.nodes[i].next_tx(t, &mut buf) else { break };
                    self.airtime += 1;
                    for j in 0..n {
                        if let Some(rssi) = self.links[i][j] {
                            if !self.lost() {
                                self.nodes[j].on_rx(&buf[..len], rssi);
                            }
                        }
                    }
                }
            }
            for i in 0..n {
                let t = self.t_us;
                self.nodes[i].poll(t);
                while let Some(e) = self.nodes[i].next_event() {
                    self.delivered[i].push(e);
                }
            }
        }

        pub fn run(&mut self, superframes: usize) {
            for _ in 0..superframes {
                self.superframe(6);
            }
        }

        pub fn got(&self, i: usize, origin: u16, port: u8) -> usize {
            self.delivered[i]
                .iter()
                .filter(|e| matches!(e, Event::Deliver { packet, .. } if packet.header.origin == origin && packet.header.port == port))
                .count()
        }
    }

    #[test]
    fn packet_round_trips() {
        let h = Header { origin: 7, id: 300, dest: BROADCAST, hop_limit: 3, hop_start: 3, flags: FLAG_WANT_ACK, attempt: 2, port: 5 };
        let p = Packet::new(h, b"hello").unwrap();
        let mut buf = [0u8; MAX_PACKET];
        let n = p.encode(&mut buf).unwrap();
        assert_eq!(Packet::decode(&buf[..n]).unwrap(), p);
        assert!(Packet::new(h, &[0; MAX_PAYLOAD + 1]).is_none());
    }

    /// Everyone in range: a broadcast reaches all, once each, and the
    /// managed flood costs far fewer than one relay per node.
    #[test]
    fn broadcast_in_one_room_is_cheap() {
        let mut net = Net::full(8, -50.0, 0.0);
        net.nodes[0].send(BROADCAST, 9, b"set", false).unwrap();
        net.run(10);
        for i in 1..8 {
            assert_eq!(net.got(i, 1, 9), 1, "node {}", i);
        }
        assert!(net.airtime <= 3, "airtime {} frames", net.airtime);
    }

    /// A line of nodes: the flood carries a broadcast to the far end within
    /// the hop limit, and not past it.
    #[test]
    fn broadcast_crosses_hops_up_to_the_limit() {
        let mut net = Net::line(6, 0.0);
        net.nodes[0].send(BROADCAST, 9, b"x", false).unwrap();
        net.run(30);
        // Hop limit 3 = up to three relays: four hops out, no further.
        for i in 1..=4 {
            assert_eq!(net.got(i, 1, 9), 1, "node {}", i);
        }
        assert_eq!(net.got(5, 1, 9), 0);
    }

    /// Unicast with ack across a lossy multi-hop line: delivered once,
    /// acknowledged, and nobody else gets it.
    #[test]
    fn unicast_is_acked_across_hops_despite_loss() {
        let mut net = Net::line(4, 0.2);
        let id = net.nodes[0].send(4, 7, b"cfg", true).unwrap();
        net.run(200);
        assert_eq!(net.got(3, 1, 7), 1);
        for i in 1..3 {
            assert_eq!(net.got(i, 1, 7), 0, "node {} isn't the destination", i);
        }
        assert!(net.delivered[0].contains(&Event::Acked { dest: 4, id }), "{:?}", net.delivered[0]);
    }

    #[test]
    fn unicast_to_nobody_fails_after_retries() {
        let mut net = Net::full(3, -50.0, 0.0);
        let id = net.nodes[0].send(99, 7, b"?", true).unwrap();
        net.run(300);
        assert!(net.delivered[0].contains(&Event::Failed { dest: 99, id }));
        assert_eq!(net.nodes[0].stats.retries, 2);
    }

    #[test]
    fn weak_signal_relays_first() {
        let mut m = Mesh::new(1, MeshConfig::default(), 5);
        let h = Header { origin: 2, id: 1, dest: BROADCAST, hop_limit: 3, hop_start: 3, flags: 0, attempt: 0, port: 1 };
        let mut buf = [0u8; MAX_PACKET];
        let n = Packet::new(h, b"").unwrap().encode(&mut buf).unwrap();
        m.on_rx(&buf[..n], -95.0);
        m.on_my_slot();
        let mut out = [0u8; MAX_PACKET];
        assert!(m.next_tx(0, &mut out).is_some(), "weak link: relay in the first slot");

        let mut m = Mesh::new(1, MeshConfig::default(), 5);
        m.on_rx(&buf[..n], -40.0);
        m.on_my_slot();
        assert!(m.next_tx(0, &mut out).is_none(), "strong link: wait for farther nodes");
    }

    /// Splanc: capacity `P` sizes the buffers; `max_payload` (the backhaul MTU) bounds what
    /// this instance sends and relays, while anything up to `P` is still delivered.
    #[test]
    fn capacity_and_runtime_max_payload() {
        let mut a = MeshOf::<200>::new(1, MeshConfig::default(), 5);
        assert_eq!(a.max_payload(), 200);
        assert!(a.send(BROADCAST, 16, &[7; 200], false).is_some());
        let mut out = [0u8; max_packet(200)];
        let n = a.next_tx(0, &mut out).unwrap();
        assert!(n > 200 && n <= max_packet(200));

        // Delivered by another 200 instance with a 150-byte MTU, but not relayed.
        let mut b = MeshOf::<200>::new(2, MeshConfig::default(), 6);
        b.set_max_payload(150);
        assert_eq!(b.max_payload(), 150);
        b.on_rx(&out[..n], -95.0);
        assert!(matches!(b.next_event(), Some(EventOf::Deliver { packet, .. }) if packet.payload().len() == 200));
        b.on_my_slot();
        assert!(b.next_tx(0, &mut out).is_none(), "too big for this backhaul: not relayed");
        assert_eq!(b.stats.oversize, 1);
        assert!(b.send(BROADCAST, 16, &[0; 151], false).is_none());
        assert_eq!(b.stats.oversize, 2);
        assert!(b.send(BROADCAST, 16, &[0; 150], false).is_some());

        // The limit never drops below the swarm's own 88 or above the capacity.
        b.set_max_payload(10);
        assert_eq!(b.max_payload(), MAX_PAYLOAD);
        b.set_max_payload(10_000);
        assert_eq!(b.max_payload(), 200);

        // The swarm's 88-byte instance cannot hold it at all.
        let mut c = Mesh::new(3, MeshConfig::default(), 7);
        let mut big = [0u8; max_packet(200)];
        let p = PacketOf::<200>::new(Header { origin: 4, id: 1, dest: BROADCAST, hop_limit: 3, hop_start: 3, flags: 0, attempt: 0, port: 16 }, &[1; 120]).unwrap();
        let n = p.encode(&mut big).unwrap();
        c.on_rx(&big[..n], -70.0);
        assert!(c.next_event().is_none());
    }
}
