//! Per-source replay protection (design §7.5): for each sender, the highest 64-bit frame
//! counter seen, a 32-frame bitmap below it, and whether that sender is **synced** (its
//! counter came from an authenticated freshness exchange, not just a group-key frame).
//! 16 bytes per source, no heap.
//!
//! Replay protection does not depend on time. Check before decrypting
//! ([`ReplayTable::check`]: cheap, so a flood of replays costs no AES), commit only after the
//! MIC verifies ([`ReplayTable::commit`], so a forged frame cannot move the window).
//!
//! A receiver with no state for a sender (a fresh join, or its own reboot) learns the
//! sender's counter from a long header under the group key; such a source is **unsynced**,
//! and its security-relevant traffic is held until a freshness exchange syncs it
//! ([`crate::admin`]). High-water marks can be persisted occasionally ([`ReplayTable::export`])
//! and restored at boot ([`ReplayTable::restore`]) as a floor, so frames older than the last
//! save are refused even before a sync.
//!
//! A full table evicts the source heard least recently, only one idle for at least
//! [`EVICT_IDLE_S`]; otherwise the new source is refused (counted).

use crate::backhaul::NodeId;

/// Frames below the highest counter that are still accepted (once each).
pub const WINDOW: u64 = 32;
/// A source idle this long may be evicted for a new one.
pub const EVICT_IDLE_S: u16 = 60;

const FREE: NodeId = 0xFFFF; // the broadcast id never sends
const SYNCED: u16 = 0x8000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Entry {
    high: u64,
    /// Bit i: counter `high - 1 - i` was seen.
    seen: u32,
    src: NodeId,
    /// Bit 15: synced; bits 0..15: seconds (mod 2^15) when last accepted.
    flags: u16,
}

const EMPTY: Entry = Entry { high: 0, seen: 0, src: FREE, flags: 0 };
const _: () = assert!(core::mem::size_of::<Entry>() == 16);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReplayReject {
    /// This counter was already accepted.
    Duplicate,
    /// Below the window: too old to tell, so dropped.
    TooOld,
    /// A new source and no slot to give it.
    Full,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ReplayStats {
    pub duplicate: u32,
    pub too_old: u32,
    pub full: u32,
    pub evicted: u32,
}

/// What the table knows about one sender.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SourceState {
    pub high: u64,
    pub synced: bool,
}

pub struct ReplayTable<const N: usize> {
    e: [Entry; N],
    pub stats: ReplayStats,
}

impl<const N: usize> Default for ReplayTable<N> {
    fn default() -> Self {
        Self::new()
    }
}

fn secs(now_s: u32) -> u16 {
    (now_s & 0x7FFF) as u16
}

fn idle(e: &Entry, now_s: u32) -> u16 {
    secs(now_s).wrapping_sub(e.flags & 0x7FFF) & 0x7FFF
}

impl<const N: usize> ReplayTable<N> {
    pub const fn new() -> Self {
        ReplayTable { e: [EMPTY; N], stats: ReplayStats { duplicate: 0, too_old: 0, full: 0, evicted: 0 } }
    }

    fn find(&self, src: NodeId) -> Option<usize> {
        self.e.iter().position(|e| e.src == src)
    }

    /// The sender's state, if any (for reconstructing a short header's counter).
    pub fn state(&self, src: NodeId) -> Option<SourceState> {
        self.find(src).map(|i| SourceState { high: self.e[i].high, synced: self.e[i].flags & SYNCED != 0 })
    }

    fn verdict(e: &Entry, ctr: u64) -> Result<(), ReplayReject> {
        if ctr > e.high {
            return Ok(());
        }
        if ctr == e.high {
            return Err(ReplayReject::Duplicate);
        }
        let back = e.high - ctr;
        if back > WINDOW {
            return Err(ReplayReject::TooOld);
        }
        if e.seen & (1 << (back - 1)) != 0 {
            Err(ReplayReject::Duplicate)
        } else {
            Ok(())
        }
    }

    fn victim(&self, now_s: u32) -> Option<usize> {
        if let Some(i) = self.e.iter().position(|e| e.src == FREE) {
            return Some(i);
        }
        let (i, e) = self.e.iter().enumerate().max_by_key(|(_, e)| idle(e, now_s))?;
        (idle(e, now_s) >= EVICT_IDLE_S).then_some(i)
    }

    /// Would `ctr` from `src` be accepted? Does not change the table (and counts nothing).
    pub fn check(&self, src: NodeId, ctr: u64, now_s: u32) -> Result<(), ReplayReject> {
        match self.find(src) {
            Some(i) => Self::verdict(&self.e[i], ctr),
            None => self.victim(now_s).map(|_| ()).ok_or(ReplayReject::Full),
        }
    }

    /// Count a rejection from [`ReplayTable::check`].
    pub fn count(&mut self, r: ReplayReject) {
        match r {
            ReplayReject::Duplicate => self.stats.duplicate += 1,
            ReplayReject::TooOld => self.stats.too_old += 1,
            ReplayReject::Full => self.stats.full += 1,
        }
    }

    /// Record an authenticated frame. Re-checks, so a commit without a check is still safe.
    pub fn commit(&mut self, src: NodeId, ctr: u64, now_s: u32) -> Result<(), ReplayReject> {
        let i = match self.find(src) {
            Some(i) => i,
            None => {
                let i = self.victim(now_s).ok_or(ReplayReject::Full)?;
                if self.e[i].src != FREE {
                    self.stats.evicted += 1;
                }
                self.e[i] = Entry { high: ctr, seen: 0, src, flags: secs(now_s) };
                return Ok(());
            }
        };
        let e = &mut self.e[i];
        Self::verdict(e, ctr)?;
        if ctr > e.high {
            let shift = ctr - e.high;
            e.seen = if shift > WINDOW { 0 } else { (e.seen << (shift - 1) << 1) | (1 << (shift - 1)) };
            e.high = ctr;
        } else {
            e.seen |= 1 << (e.high - ctr - 1);
        }
        e.flags = (e.flags & SYNCED) | secs(now_s);
        Ok(())
    }

    /// A freshness exchange authenticated `src`'s current counter `ctr` (a pairwise MAC over
    /// our nonce): from now on only counters above what the exchange vouched for, or within
    /// the window below it, are fresh. Replaces anything a group-key frame claimed (an insider
    /// pushing a sender's counter ahead to starve it is undone here).
    pub fn sync(&mut self, src: NodeId, ctr: u64, now_s: u32) -> bool {
        let i = match self.find(src).or_else(|| self.victim(now_s)) {
            Some(i) => i,
            None => return false,
        };
        let keep = self.e[i].src == src && self.e[i].high <= ctr;
        let seen = if keep { self.e[i].seen } else { 0 };
        let high = if keep { self.e[i].high.max(ctr) } else { ctr };
        self.e[i] = Entry { high, seen, src, flags: SYNCED | secs(now_s) };
        true
    }

    /// The (source, high-water mark) pairs to persist occasionally.
    pub fn export(&self) -> impl Iterator<Item = (NodeId, u64)> + '_ {
        self.e.iter().filter(|e| e.src != FREE).map(|e| (e.src, e.high))
    }

    /// Restore a persisted mark at boot: unsynced, but nothing at or below it is fresh.
    pub fn restore(&mut self, src: NodeId, high: u64, now_s: u32) {
        if self.find(src).is_none() {
            if let Some(i) = self.victim(now_s) {
                self.e[i] = Entry { high, seen: u32::MAX, src, flags: secs(now_s) };
            }
        }
    }

    /// Forget every source.
    pub fn clear(&mut self) {
        self.e = [EMPTY; N];
    }

    pub fn len(&self) -> usize {
        self.e.iter().filter(|e| e.src != FREE).count()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn accept<const N: usize>(t: &mut ReplayTable<N>, src: NodeId, c: u64) -> Result<(), ReplayReject> {
        t.check(src, c, 0)?;
        t.commit(src, c, 0)
    }

    #[test]
    fn window_semantics() {
        let mut t = ReplayTable::<4>::new();
        assert_eq!(accept(&mut t, 1, 100), Ok(()));
        assert_eq!(accept(&mut t, 1, 100), Err(ReplayReject::Duplicate));
        assert_eq!(accept(&mut t, 1, 99), Ok(()));
        assert_eq!(accept(&mut t, 1, 100 - WINDOW), Ok(()));
        assert_eq!(accept(&mut t, 1, 100 - WINDOW - 1), Err(ReplayReject::TooOld));
        assert_eq!(accept(&mut t, 1, 105), Ok(()));
        assert_eq!(accept(&mut t, 1, 100), Err(ReplayReject::Duplicate));
        assert_eq!(accept(&mut t, 1, 101), Ok(()));
        // Across 2^32 the window is just arithmetic.
        let b = 1u64 << 32;
        assert_eq!(accept(&mut t, 2, b - 1), Ok(()));
        assert_eq!(accept(&mut t, 2, b + 1), Ok(()));
        assert_eq!(accept(&mut t, 2, b), Ok(()));
        assert_eq!(accept(&mut t, 2, b - 1), Err(ReplayReject::Duplicate));
        assert_eq!(t.state(2), Some(SourceState { high: b + 1, synced: false }));
    }

    #[test]
    fn full_table_evicts_only_idle_sources() {
        let mut t = ReplayTable::<2>::new();
        t.commit(1, 1, 0).unwrap();
        t.commit(2, 1, 10).unwrap();
        assert_eq!(t.commit(3, 1, 30), Err(ReplayReject::Full));
        assert_eq!(t.commit(3, 1, 60), Ok(()));
        assert_eq!(t.stats.evicted, 1);
        assert_eq!(t.check(2, 1, 60), Err(ReplayReject::Duplicate), "source 2 kept");
    }

    /// A sync replaces an insider-inflated counter and marks the source synced; a restored
    /// mark refuses everything at or below it.
    #[test]
    fn sync_and_restore() {
        let mut t = ReplayTable::<4>::new();
        // An insider's group-key frame claimed sender 5 is at 10^12.
        t.commit(5, 1_000_000_000_000, 0).unwrap();
        assert_eq!(t.check(5, 500, 0), Err(ReplayReject::TooOld), "the real sender is starved");
        assert!(t.sync(5, 480, 0));
        assert_eq!(t.state(5), Some(SourceState { high: 480, synced: true }));
        assert_eq!(accept(&mut t, 5, 500), Ok(()));
        assert!(t.state(5).unwrap().synced, "stays synced");
        let saved: Vec<_> = t.export().collect();
        let mut t2 = ReplayTable::<4>::new();
        for (s, h) in saved {
            t2.restore(s, h, 0);
        }
        assert_eq!(t2.check(5, 500, 0), Err(ReplayReject::Duplicate));
        assert_eq!(t2.check(5, 490, 0), Err(ReplayReject::Duplicate), "the whole window below the mark");
        assert_eq!(t2.check(5, 501, 0), Ok(()));
        assert!(!t2.state(5).unwrap().synced);
    }
}
