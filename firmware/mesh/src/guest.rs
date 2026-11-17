//! Open mode (design §7.4), modelled far enough for M7b to slot in: the members' guest table
//! with its abuse limits, and the guest's own follow state machine.
//!
//! What is real here: guests have their own table (16), so they cannot evict members' replay
//! or dedup entries; each guest is held to ≤ 5 frames/s and ≤ 1 KB/s (excess dropped and
//! counted); a guest follows an open mesh it hears when its `mesh_follow` setting is `open`,
//! stops within one advert when the mesh closes, and falls back to its own effect after 10 s
//! of silence. What is a stub (M7b): the follow stream itself, the owner-signed scenes, blob
//! ids and time it carries ([`crate::ports::Router`] refuses guest traffic as unsigned), and
//! relaying guest status.

use crate::backhaul::NodeId;
use crate::crypto::KeyHash;
use crate::envelope::{self, Header};
use crate::membership::{Follow, Mode};
use crate::msg::{Advert, GuestHello};

/// Guests a member tracks (§7.4).
pub const GUESTS: usize = 16;
/// Per-guest limits (§7.4).
pub const GUEST_FRAMES_PER_S: u32 = 5;
pub const GUEST_BYTES_PER_S: u32 = 1024;
/// A guest idle this long may be replaced by a new one.
pub const GUEST_IDLE_US: i64 = 60_000_000;
/// A guest falls back to its own effect after this much silence from the mesh.
pub const FOLLOW_SILENCE_US: i64 = 10_000_000;
/// A guest says hello this often.
pub const HELLO_EVERY_US: i64 = 30_000_000;

/// A token bucket: `rate` per second, bursting to `rate`. 8 bytes: millis of a token and a
/// wrapping millisecond timestamp (the guest table is 16 of these pairs; §10.4 budget).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Bucket {
    milli: u32,
    last_ms: u32,
}

fn ms(now_us: i64) -> u32 {
    (now_us / 1000) as u32
}

impl Bucket {
    pub fn full(rate: u32, now_us: i64) -> Bucket {
        Bucket { milli: rate * 1000, last_ms: ms(now_us) }
    }

    /// Take `n` tokens at `rate`/s if there are enough.
    pub fn take(&mut self, now_us: i64, rate: u32, n: u32) -> bool {
        let now = ms(now_us);
        let dt = now.wrapping_sub(self.last_ms).min(10_000);
        self.milli = self.milli.saturating_add(dt * rate).min(rate * 1000);
        self.last_ms = now;
        if self.milli >= n * 1000 {
            self.milli -= n * 1000;
            true
        } else {
            false
        }
    }
}

const FREE: NodeId = 0xFFFF;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GuestEntry {
    pub node: NodeId,
    pub key_hash: KeyHash,
    pub firmware: u32,
    last_ms: u32,
    frames: Bucket,
    bytes: Bucket,
}

const EMPTY: GuestEntry = GuestEntry { node: FREE, key_hash: [0; 8], firmware: 0, last_ms: 0, frames: Bucket { milli: 0, last_ms: 0 }, bytes: Bucket { milli: 0, last_ms: 0 } };

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct GuestStats {
    pub hellos: u32,
    /// Over a guest's frame or byte rate.
    pub rate_limited: u32,
    /// No slot for a new guest.
    pub table_full: u32,
}

/// The members' guest table (36 B per guest).
pub struct GuestTable<const N: usize> {
    e: [GuestEntry; N],
    pub stats: GuestStats,
}

impl<const N: usize> Default for GuestTable<N> {
    fn default() -> Self {
        Self::new()
    }
}

impl<const N: usize> GuestTable<N> {
    pub const fn new() -> Self {
        GuestTable { e: [EMPTY; N], stats: GuestStats { hellos: 0, rate_limited: 0, table_full: 0 } }
    }

    /// Account one frame of `len` bytes from guest `node`; false if it is over its limits
    /// (drop it) or there is no room for a new guest.
    pub fn admit_frame(&mut self, now_us: i64, node: NodeId, len: usize) -> bool {
        let Some(g) = self.e.iter_mut().find(|g| g.node == node && node != FREE) else {
            return false;
        };
        let ok = g.frames.take(now_us, GUEST_FRAMES_PER_S, 1) && g.bytes.take(now_us, GUEST_BYTES_PER_S, len as u32);
        if ok {
            g.last_ms = ms(now_us);
        } else {
            self.stats.rate_limited += 1;
        }
        ok
    }

    /// A `GuestHello`: track the guest (rate-limited like any guest frame). True if the
    /// hello is accepted (the gateway lists the guest).
    pub fn hello(&mut self, now_us: i64, h: &GuestHello, len: usize) -> bool {
        if !self.e.iter().any(|g| g.node == h.node) {
            let now = ms(now_us);
            let slot = self.e.iter().position(|g| g.node == FREE).or_else(|| {
                let (i, g) = self.e.iter().enumerate().max_by_key(|(_, g)| now.wrapping_sub(g.last_ms))?;
                (now.wrapping_sub(g.last_ms) as i64 * 1000 >= GUEST_IDLE_US).then_some(i)
            });
            let Some(slot) = slot else {
                self.stats.table_full += 1;
                return false;
            };
            self.e[slot] = GuestEntry {
                node: h.node,
                key_hash: h.key_hash,
                firmware: h.firmware,
                last_ms: now,
                frames: Bucket::full(GUEST_FRAMES_PER_S, now_us),
                bytes: Bucket::full(GUEST_BYTES_PER_S, now_us),
            };
        }
        if !self.admit_frame(now_us, h.node, len) {
            return false;
        }
        self.stats.hellos += 1;
        true
    }

    pub fn iter(&self) -> impl Iterator<Item = &GuestEntry> {
        self.e.iter().filter(|g| g.node != FREE)
    }

    /// The mesh closed (§7.6 open → closed): the app lists them as "former guests".
    pub fn clear(&mut self) {
        self.e = [EMPTY; N];
    }
}

/// A guest's view: which open mesh it follows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FollowState {
    /// Running its own effect.
    Idle,
    /// Following an open mesh (trust on first use of its owner key, M7b).
    Following { mesh_id: u32, since_us: i64, last_heard_us: i64, hello_us: Option<i64> },
}

/// What the follower wants done.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FollowEvent {
    None,
    /// Started following: install `K_open` for this mesh id.
    Started { mesh_id: u32, open_key: [u8; 16] },
    /// Stopped (the mesh closed, or silence): back to its own effect.
    Stopped,
    /// Send this `GuestHello` (plain, one hop).
    Hello(GuestHello),
}

pub struct Follower {
    pub setting: Follow,
    pub state: FollowState,
    pub node: NodeId,
    pub key_hash: KeyHash,
    pub firmware: u32,
}

impl Follower {
    pub fn new(setting: Follow, node: NodeId, key_hash: KeyHash, firmware: u32) -> Follower {
        Follower { setting, state: FollowState::Idle, node, key_hash, firmware }
    }

    /// A plain advert heard (from any mesh).
    pub fn on_advert(&mut self, now_us: i64, h: &Header, a: &Advert) -> FollowEvent {
        if self.setting != Follow::Open {
            return FollowEvent::None;
        }
        match self.state {
            FollowState::Idle if a.mode == Mode::Open => {
                self.state = FollowState::Following { mesh_id: h.mesh_id, since_us: now_us, last_heard_us: now_us, hello_us: None };
                FollowEvent::Started { mesh_id: h.mesh_id, open_key: envelope::open_key(h.mesh_id) }
            }
            FollowState::Following { mesh_id, since_us, hello_us, .. } if mesh_id == h.mesh_id => {
                if a.mode != Mode::Open {
                    self.state = FollowState::Idle;
                    return FollowEvent::Stopped;
                }
                self.state = FollowState::Following { mesh_id, since_us, last_heard_us: now_us, hello_us };
                FollowEvent::None
            }
            _ => FollowEvent::None,
        }
    }

    /// Timers: silence fallback, hellos.
    pub fn poll(&mut self, now_us: i64) -> FollowEvent {
        let FollowState::Following { mesh_id, since_us, last_heard_us, hello_us } = self.state else {
            return FollowEvent::None;
        };
        if now_us - last_heard_us >= FOLLOW_SILENCE_US {
            self.state = FollowState::Idle;
            return FollowEvent::Stopped;
        }
        if hello_us.is_none_or(|t| now_us - t >= HELLO_EVERY_US) {
            self.state = FollowState::Following { mesh_id, since_us, last_heard_us, hello_us: Some(now_us) };
            return FollowEvent::Hello(GuestHello { node: self.node, key_hash: self.key_hash, firmware: self.firmware });
        }
        FollowEvent::None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hello(node: NodeId) -> GuestHello {
        GuestHello { node, key_hash: [node as u8; 8], firmware: 1 }
    }

    #[test]
    fn bucket_refills_at_its_rate() {
        let mut b = Bucket::full(5, 0);
        for _ in 0..5 {
            assert!(b.take(0, 5, 1));
        }
        assert!(!b.take(0, 5, 1));
        assert!(!b.take(100_000, 5, 1), "0.5 of a frame after 100 ms");
        assert!(b.take(200_000, 5, 1), "one frame per 200 ms");
    }

    #[test]
    fn guests_are_rate_limited_and_bounded() {
        let mut t = GuestTable::<2>::new();
        assert!(t.hello(0, &hello(1), 15));
        for _ in 0..4 {
            assert!(t.admit_frame(0, 1, 15));
        }
        assert!(!t.admit_frame(0, 1, 15), "6th frame in one second");
        assert!(t.admit_frame(1_000_000, 1, 15));
        // Bytes: a 1 KB burst, then nothing until it refills.
        assert!(t.hello(0, &hello(2), 15));
        assert!(t.admit_frame(500_000, 2, 1000));
        assert!(!t.admit_frame(500_000, 2, 100));
        assert_eq!(t.stats.rate_limited, 2);
        // Full: a third guest waits until one has been idle a minute.
        assert!(!t.hello(10_000_000, &hello(3), 15));
        assert_eq!(t.stats.table_full, 1);
        assert!(t.hello(61_000_001, &hello(3), 15));
        assert_eq!(t.iter().count(), 2);
        // Unknown guests' frames are not admitted.
        assert!(!t.admit_frame(0, 99, 1));
    }

    #[test]
    fn follower_lifecycle() {
        let h = Header { mesh_id: 9, epoch: 0, src: 1, counter: 0, long: false };
        let open = Advert { epoch: 1, mode: Mode::Open, nonce: 1, members: 3, mtu: 250, channel: 6, capacity: Default::default(), diameter: 1 };
        let mut f = Follower::new(Follow::Off, 50, [5; 8], 1);
        assert_eq!(f.on_advert(0, &h, &open), FollowEvent::None, "mesh_follow off");
        f.setting = Follow::Open;
        assert_eq!(f.on_advert(0, &h, &Advert { mode: Mode::Closed, ..open }), FollowEvent::None, "closed meshes are not followed");
        assert_eq!(f.on_advert(0, &h, &open), FollowEvent::Started { mesh_id: 9, open_key: envelope::open_key(9) });
        assert!(matches!(f.poll(1), FollowEvent::Hello(g) if g.node == 50));
        assert_eq!(f.poll(2), FollowEvent::None);
        // Another open mesh does not steal it.
        assert_eq!(f.on_advert(3, &Header { mesh_id: 10, ..h }, &open), FollowEvent::None);
        // The owner closes the mesh: it stops at the next advert.
        assert_eq!(f.on_advert(1_000_000, &h, &Advert { mode: Mode::Closed, ..open }), FollowEvent::Stopped);
        assert_eq!(f.state, FollowState::Idle);
        // Silence: back to its own effect after 10 s.
        f.on_advert(2_000_000, &h, &open);
        assert_eq!(f.poll(2_000_000 + FOLLOW_SILENCE_US - 1), FollowEvent::Hello(GuestHello { node: 50, key_hash: [5; 8], firmware: 1 }));
        assert_eq!(f.poll(2_000_000 + FOLLOW_SILENCE_US), FollowEvent::Stopped);
    }
}
