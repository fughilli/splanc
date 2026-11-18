//! Containing an insider that floods forged live moves (design §7.9, Q25).
//!
//! Apply-then-verify ([`crate::tesla`]) bounds what a forged live move can do, but an insider
//! forging continuously keeps members verifying first, and at high rates crowds their verify
//! buffers. This module contains it in two layers, without letting one liar get an honest
//! fixture blocked:
//!
//! 1. **Local, trusting nobody** ([`LinkGuard`], every fixture). A fixture knows which
//!    neighbour handed it the first copy of each packet (the link-layer source) and how loud
//!    that neighbour usually is. After [`BLOCK_AFTER`] verified forgeries from one neighbour
//!    within [`COUNT_WINDOW_US`], it drops live packets from that neighbour for [`BLOCK_US`]. A
//!    forger that puts an honest neighbour's id on its frames is caught by the RSSI: frames
//!    under that id but outside its usual band ([`RSSI_BAND_DB`]) are blocked as a spoof, and
//!    the honest neighbour's own frames still pass. Only the fixture's own observations count.
//! 2. **Mesh-wide, by quorum** ([`Forensics`], the gateway). Fixtures report each forgery
//!    they verify ([`ForgeryReport`], MAC'd with their pairwise session key, rate-limited):
//!    which neighbour gave it to them, and whether that neighbour's RSSI fit. The gateway holds
//!    the chain, so it recomputes the tag: a report about a genuine packet is a provable lie
//!    and is dropped. A neighbour named as the first hop is a **suspect** for that forgery only
//!    if at least [`QUORUM_WITNESSES`] distinct fixtures name it, and its own report does not
//!    name a corroborated upstream (an honest relay that forwarded the forgery reports where it
//!    got it, and that node reports having it too). Suspect in [`QUORUM_CASES`] forgeries
//!    within [`SCORE_WINDOW_US`]: the gateway orders every member to drop that fixture's live
//!    packets for [`BLOCK_US`] and alerts the admin. Only the admin removes a fixture for good
//!    (rotation, §7.6).
//!
//! A forger that lies about its upstream names some neighbour each time; that neighbour,
//! being honest, either never had the packet (the claim is not corroborated) or names the
//! forger back (a cycle, which corroborates neither). The forger is a suspect in every
//! forgery, a framed neighbour only in the few it is named in.

use crate::backhaul::NodeId;
use crate::codec::{R, W};
use crate::crypto::{ct_eq, hmac};
use crate::tesla::TAG_LEN;

/// Verified forgeries from one neighbour, within the window, that block it locally; more
/// for a fixture's own tree parent, which forwards whatever reaches it: an honest relay
/// passing an injector's forgeries on blocks the injector itself after BLOCK_AFTER, before
/// its children reach this.
pub const BLOCK_AFTER: u8 = 3;
pub const BLOCK_AFTER_PARENT: u8 = 9;
pub const COUNT_WINDOW_US: i64 = 10_000_000;
/// How long a block (local or mesh-wide) lasts.
pub const BLOCK_US: i64 = 60_000_000;
/// A frame under a neighbour's id this far from its usual RSSI is not from it.
pub const RSSI_BAND_DB: i16 = 8;
/// Neighbours a fixture tracks.
pub const GUARD_N: usize = 12;

/// Distinct witnesses naming a suspect in one forgery, and forgeries it must be a suspect in.
pub const QUORUM_WITNESSES: u8 = 2;
pub const QUORUM_CASES: u8 = 3;
pub const SCORE_WINDOW_US: i64 = 30_000_000;
/// Reports of a forgery are judged this long after the first arrives (a relay's own report,
/// which clears it, may come after its children's).
pub const SETTLE_US: i64 = 1_000_000;
/// Forgeries and witnesses per forgery the gateway keeps; suspects it scores.
pub const CASES: usize = 6;
pub const WITNESSES: usize = 24;
pub const SUSPECTS: usize = 8;
/// Fixtures report only forgeries whose interval key falls in a 1 in `REPORT_SAMPLE` sample,
/// and the gateway (which holds the chain) accepts only those. Every member reports the same
/// forgeries (complete cases), airtime is bounded, the forger cannot avoid the sample (the key
/// is unknown when it forges), and nobody can flood the gateway's case table with reports
/// about unsampled packets.
pub const REPORT_SAMPLE: u8 = 8;

pub const T_FORGERY_REPORT: u8 = 0x46;
/// The body a report carries (the forged packet's ControlHeader ‖ inner), for the tag check.
pub const REPORT_BODY_MAX: usize = crate::tesla::BODY_MAX;

fn ms(now_us: i64) -> u32 {
    (now_us / 1000) as u32
}

fn before(a_ms: u32, b_ms: u32) -> bool {
    (b_ms.wrapping_sub(a_ms) as i32) > 0
}

#[derive(Clone, Copy, Debug, Default)]
struct Neighbour {
    src: NodeId,
    /// Usual RSSI (dBm × 4, EWMA over frames that fit the band, or the first 4).
    rssi_q: i16,
    frames: u16,
    forged: u8,
    forged_from_ms: u32,
    blocked_until_ms: u32,
    spoofs: u8,
    spoofs_from_ms: u32,
    spoof_blocked_until_ms: u32,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct GuardStats {
    pub blocks: u32,
    pub spoof_blocks: u32,
    pub dropped: u32,
    pub ordered: u32,
}

/// How a forgery was attributed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Attribution {
    /// From this neighbour (its RSSI fit).
    Neighbour(NodeId),
    /// Under this neighbour's id, but not at its RSSI: someone else.
    Spoof(NodeId),
}

/// A fixture's per-neighbour record of forgeries and blocks.
pub struct LinkGuard {
    n: [Option<Neighbour>; GUARD_N],
    pub stats: GuardStats,
}

impl Default for LinkGuard {
    fn default() -> Self {
        Self::new()
    }
}

impl LinkGuard {
    pub const fn new() -> LinkGuard {
        LinkGuard { n: [None; GUARD_N], stats: GuardStats { blocks: 0, spoof_blocks: 0, dropped: 0, ordered: 0 } }
    }

    /// The record for `src`, making room by evicting the least-heard neighbour that has no
    /// block in force and no forgery counted. None if every slot is protected.
    fn slot(&mut self, now_us: i64, src: NodeId) -> Option<&mut Neighbour> {
        let now = ms(now_us);
        let i = match self.n.iter().position(|e| e.is_some_and(|e| e.src == src)) {
            Some(i) => i,
            None => {
                let free = self.n.iter().position(|e| e.is_none());
                let i = free.or_else(|| {
                    (0..GUARD_N)
                        .filter(|&i| self.n[i].is_some_and(|e| e.forged == 0 && e.spoofs == 0 && !before(now, e.blocked_until_ms) && !before(now, e.spoof_blocked_until_ms)))
                        .min_by_key(|&i| self.n[i].map_or(0, |e| e.frames))
                })?;
                self.n[i] = Some(Neighbour { src, ..Neighbour::default() });
                i
            }
        };
        self.n[i].as_mut()
    }

    /// A frame from `src` at `rssi` dBm: learn its usual level.
    pub fn heard(&mut self, now_us: i64, src: NodeId, rssi_dbm: i16) {
        let Some(e) = self.slot(now_us, src) else { return };
        let q = rssi_dbm * 4;
        if e.frames < 4 {
            e.rssi_q = if e.frames == 0 { q } else { (e.rssi_q * e.frames as i16 + q) / (e.frames as i16 + 1) };
        } else if (q - e.rssi_q).abs() <= RSSI_BAND_DB * 4 {
            e.rssi_q += (q - e.rssi_q) / 8;
        }
        e.frames = e.frames.saturating_add(1);
    }

    /// Does a frame at `rssi` fit `src`'s usual level (unknown: yes)?
    pub fn consistent(&self, src: NodeId, rssi_dbm: i16) -> bool {
        self.n.iter().flatten().find(|e| e.src == src).is_none_or(|e| e.frames < 4 || (rssi_dbm * 4 - e.rssi_q).abs() <= RSSI_BAND_DB * 4)
    }

    /// A verified forgery whose first copy came from `src` at `rssi`: count it, and block
    /// after BLOCK_AFTER within the window.
    pub fn forged(&mut self, now_us: i64, src: NodeId, rssi_dbm: i16, is_parent: bool) -> Attribution {
        let limit = if is_parent { BLOCK_AFTER_PARENT } else { BLOCK_AFTER };
        let fits = self.consistent(src, rssi_dbm);
        let now = ms(now_us);
        let Some(e) = self.slot(now_us, src) else { return if fits { Attribution::Neighbour(src) } else { Attribution::Spoof(src) } };
        let (count, from, until) = if fits { (&mut e.forged, &mut e.forged_from_ms, &mut e.blocked_until_ms) } else { (&mut e.spoofs, &mut e.spoofs_from_ms, &mut e.spoof_blocked_until_ms) };
        if *count == 0 || now.wrapping_sub(*from) as i64 * 1000 > COUNT_WINDOW_US {
            *count = 0;
            *from = now;
        }
        *count = count.saturating_add(1);
        let mut blocked = false;
        if *count >= limit && !before(now, *until) {
            *until = now.wrapping_add((BLOCK_US / 1000) as u32);
            *count = 0;
            blocked = true;
        }
        if blocked {
            if fits {
                self.stats.blocks += 1;
            } else {
                self.stats.spoof_blocks += 1;
            }
        }
        if fits {
            Attribution::Neighbour(src)
        } else {
            Attribution::Spoof(src)
        }
    }

    /// The gateway's mesh-wide order: drop `src`'s live packets until `until_us`.
    pub fn order_block(&mut self, now_us: i64, src: NodeId, until_us: i64) {
        // An order always gets a slot: take the least-heard one if all are protected.
        if self.slot(now_us, src).is_none() {
            let i = (0..GUARD_N).min_by_key(|&i| self.n[i].map_or(0, |e| e.frames)).unwrap_or(0);
            self.n[i] = Some(Neighbour { src, ..Neighbour::default() });
        }
        if let Some(e) = self.slot(now_us, src) {
            // Everything under that id, whatever its RSSI (people walking past swing it).
            e.blocked_until_ms = ms(until_us.max(now_us));
            e.spoof_blocked_until_ms = e.blocked_until_ms;
        }
        self.stats.ordered += 1;
    }

    /// Accept a live packet whose first copy came from `src` at `rssi`?
    pub fn allow(&mut self, now_us: i64, src: NodeId, rssi_dbm: i16) -> bool {
        let now = ms(now_us);
        let fits = self.consistent(src, rssi_dbm);
        let ok = match self.n.iter().flatten().find(|e| e.src == src) {
            None => true,
            Some(e) => {
                if fits {
                    !before(now, e.blocked_until_ms)
                } else {
                    !before(now, e.spoof_blocked_until_ms)
                }
            }
        };
        if !ok {
            self.stats.dropped += 1;
        }
        ok
    }

    /// Is `src` blocked (as itself) at `now_us`?
    pub fn blocked(&self, now_us: i64, src: NodeId) -> bool {
        self.n.iter().flatten().find(|e| e.src == src).is_some_and(|e| before(ms(now_us), e.blocked_until_ms))
    }
}

/// A fixture's report of one verified forgery, MAC'd with its pairwise session key.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ForgeryReport {
    pub session: u32,
    pub reporter: NodeId,
    /// The neighbour the first copy came from, whether its RSSI fit, and whether it is the
    /// reporter's tree parent (it came down the tree: a forwarder's children are no witnesses
    /// to where the forgery started).
    pub first_hop: NodeId,
    pub consistent: bool,
    pub from_parent: bool,
    /// The forged packet: enough for the gateway to recompute its tag.
    pub interval: u16,
    pub seq: u64,
    pub port: u8,
    pub tag: [u8; TAG_LEN],
    pub len: u8,
    pub body: [u8; REPORT_BODY_MAX],
}

impl ForgeryReport {
    fn write(&self, w: &mut W<'_>) {
        w.u32(self.session).u16(self.reporter).u16(self.first_hop).u8(self.consistent as u8 | ((self.from_parent as u8) << 1)).u16(self.interval).put(&self.seq.to_be_bytes()).u8(self.port).put(&self.tag).u8(self.len).put(&self.body[..self.len as usize]);
    }

    pub fn mac(&self, pairwise: &[u8; 16]) -> [u8; 8] {
        let mut b = [0u8; 128];
        let n = {
            let mut w = W::new(&mut b);
            self.write(&mut w);
            w.done().unwrap_or(0)
        };
        let h = hmac(pairwise, &[b"SMfrep1", &b[..n]]);
        let mut m = [0u8; 8];
        m.copy_from_slice(&h[..8]);
        m
    }

    pub fn encode(&self, pairwise: &[u8; 16], out: &mut [u8]) -> Option<usize> {
        let mac = self.mac(pairwise);
        let mut w = W::new(out);
        w.u8(T_FORGERY_REPORT);
        self.write(&mut w);
        w.put(&mac).done()
    }

    /// Decode, and check the MAC with `key_of(reporter)` (the gateway's roster key).
    pub fn decode(b: &[u8], key_of: impl Fn(NodeId) -> Option<[u8; 16]>) -> Option<ForgeryReport> {
        let mut r = R::new(b);
        if r.u8()? != T_FORGERY_REPORT {
            return None;
        }
        let (session, reporter, first_hop, flags) = (r.u32()?, r.u16()?, r.u16()?, r.u8()?);
        let mut f = ForgeryReport { session, reporter, first_hop, consistent: flags & 1 != 0, from_parent: flags & 2 != 0, interval: r.u16()?, seq: u64::from_be_bytes(r.arr()?), port: r.u8()?, tag: r.arr()?, len: 0, body: [0; REPORT_BODY_MAX] };
        let len = r.u8()? as usize;
        if len > REPORT_BODY_MAX {
            return None;
        }
        f.body[..len].copy_from_slice(r.take(len)?);
        f.len = len as u8;
        let mac: [u8; 8] = r.arr()?;
        r.end()?;
        let k = key_of(f.reporter)?;
        ct_eq(&f.mac(&k), &mac).then_some(f)
    }
}

/// Is a forgery from the interval whose chain key is `key` in the report sample?
pub fn sampled(key: &[u8; crate::tesla::KEY_LEN]) -> bool {
    key[0] % REPORT_SAMPLE == 0
}

/// Should this fixture report a forgery it verified? Only sampled ones; and a fixture whose
/// first copy came from its parent reports only if it is a relay itself (to account for
/// forwarding it: its children may name it), since a parent-to-child copy is no evidence.
pub fn should_report(key: &[u8; crate::tesla::KEY_LEN], from_parent: bool, is_relay: bool) -> bool {
    sampled(key) && (!from_parent || is_relay)
}

#[derive(Clone, Copy, Debug, Default)]
struct Witness {
    reporter: NodeId,
    first_hop: NodeId,
    consistent: bool,
    from_parent: bool,
}

#[derive(Clone, Copy, Debug)]
struct Case {
    interval: u16,
    tag: [u8; TAG_LEN],
    first_us: i64,
    judged: bool,
    w: [Option<Witness>; WITNESSES],
}

#[derive(Clone, Copy, Debug, Default)]
struct Score {
    node: NodeId,
    cases: u8,
    first_us: i64,
    blocked_until_us: i64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ForensicsStats {
    pub reports: u32,
    /// Reports about genuine packets (provable lies), and about unsampled forgeries, dropped.
    pub lies: u32,
    pub unsampled: u32,
    pub cases: u32,
    pub suspicions: u32,
    pub blocks: u32,
}

/// What the gateway decided.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    /// Order every member to drop `node`'s live packets until `until_us`, and alert the admin.
    Block { node: NodeId, until_us: i64 },
}

/// The gateway's correlation of forgery reports.
pub struct Forensics {
    me: NodeId,
    cases: [Option<Case>; CASES],
    next: u8,
    scores: [Option<Score>; SUSPECTS],
    pub stats: ForensicsStats,
}

impl Forensics {
    pub const fn new(me: NodeId) -> Forensics {
        Forensics { me, cases: [None; CASES], next: 0, scores: [None; SUSPECTS], stats: ForensicsStats { reports: 0, lies: 0, unsampled: 0, cases: 0, suspicions: 0, blocks: 0 } }
    }

    /// A report, MAC already checked. `genuine`: the gateway recomputed the tag and it is one
    /// of its own (the reporter lies). `sampled`: the interval's key is in the report sample
    /// ([`sampled`], from the gateway's own chain).
    pub fn report(&mut self, now_us: i64, r: &ForgeryReport, genuine: bool, sampled: bool) {
        self.stats.reports += 1;
        if genuine {
            self.stats.lies += 1;
            return;
        }
        if !sampled {
            self.stats.unsampled += 1;
            return;
        }
        let i = match self.cases.iter().position(|c| c.is_some_and(|c| c.interval == r.interval && c.tag == r.tag)) {
            Some(i) => i,
            None => {
                let i = self.next as usize % CASES;
                self.next = self.next.wrapping_add(1);
                self.cases[i] = Some(Case { interval: r.interval, tag: r.tag, first_us: now_us, judged: false, w: [None; WITNESSES] });
                self.stats.cases += 1;
                i
            }
        };
        let c = self.cases[i].as_mut().expect("case");
        if c.w.iter().flatten().any(|w| w.reporter == r.reporter) {
            return;
        }
        let new = Witness { reporter: r.reporter, first_hop: r.first_hop, consistent: r.consistent, from_parent: r.from_parent };
        let ws = c.w;
        let slot = c.w.iter().position(|w| w.is_none()).or_else(|| {
            // Full: replace a redundant witness, one nobody names and whose first hop already
            // has more than a quorum of witnesses besides it.
            (0..WITNESSES).find(|&i| {
                ws[i].is_some_and(|w| {
                    let named = ws.iter().flatten().any(|x| x.first_hop == w.reporter);
                    let others = ws.iter().flatten().filter(|x| x.first_hop == w.first_hop && x.reporter != w.reporter).count();
                    !named && others > QUORUM_WITNESSES as usize
                })
            })
        });
        if let Some(i) = slot {
            c.w[i] = Some(new);
        }
    }

    /// Judge settled forgeries; returns a block when a suspect reaches the quorum.
    pub fn tick(&mut self, now_us: i64) -> Option<Verdict> {
        let mut out = None;
        for ci in 0..CASES {
            let Some(c) = self.cases[ci] else { continue };
            if c.judged || now_us - c.first_us < SETTLE_US {
                continue;
            }
            self.cases[ci].as_mut().expect("case").judged = true;
            let ws: [Option<Witness>; WITNESSES] = c.w;
            let mut done: [NodeId; WITNESSES] = [0; WITNESSES];
            let mut nd = 0;
            // A side witness: the first copy came from a neighbour at its usual RSSI that is
            // not the witness's parent.
            let side = |w: &Witness| w.consistent && !w.from_parent;
            for s in ws.iter().flatten().filter(|w| side(w)).map(|w| w.first_hop) {
                if done[..nd].contains(&s) || s == self.me {
                    continue;
                }
                done[nd] = s;
                nd += 1;
                let witnesses = ws.iter().flatten().filter(|w| side(w) && w.first_hop == s && w.reporter != s).count();
                // Its own account clears it if the upstream it names was seen sending the
                // forgery by someone else, and following the upstream claims from there never
                // leads back to it. An honest relay names its true source (the chain ends at
                // the injector, or loops among others). An injector naming a downstream relay
                // is led back to itself; naming a node that never sent it, no one saw that.
                let cleared = ws.iter().flatten().find(|w| w.reporter == s).is_some_and(|own| {
                    let u = own.first_hop;
                    let seen = ws.iter().flatten().any(|w| side(w) && w.first_hop == u && w.reporter != s && w.reporter != u);
                    u != self.me && u != s && seen && !Self::leads_back(&ws, u, s)
                });
                if cleared || witnesses < QUORUM_WITNESSES as usize {
                    continue;
                }
                self.stats.suspicions += 1;
                if let Some(v) = self.suspect(now_us, s) {
                    out = Some(v);
                }
            }
        }
        out
    }

    /// Following upstream claims from `from`, do we reach `to`?
    fn leads_back(ws: &[Option<Witness>; WITNESSES], from: NodeId, to: NodeId) -> bool {
        let mut at = from;
        for _ in 0..WITNESSES {
            match ws.iter().flatten().find(|w| w.reporter == at) {
                Some(w) if w.first_hop == to => return true,
                Some(w) => at = w.first_hop,
                None => return false,
            }
        }
        false
    }

    fn suspect(&mut self, now_us: i64, node: NodeId) -> Option<Verdict> {
        let i = match self.scores.iter().position(|s| s.is_some_and(|s| s.node == node)) {
            Some(i) => i,
            None => {
                let i = self.scores.iter().position(|s| s.is_none()).unwrap_or_else(|| (0..SUSPECTS).min_by_key(|&i| self.scores[i].map_or(0, |s| s.first_us)).unwrap_or(0));
                self.scores[i] = Some(Score { node, cases: 0, first_us: now_us, blocked_until_us: 0 });
                i
            }
        };
        let s = self.scores[i].as_mut().expect("score");
        if now_us - s.first_us > SCORE_WINDOW_US {
            s.cases = 0;
            s.first_us = now_us;
        }
        s.cases = s.cases.saturating_add(1);
        if s.cases >= QUORUM_CASES && now_us >= s.blocked_until_us {
            s.blocked_until_us = now_us + BLOCK_US;
            s.cases = 0;
            self.stats.blocks += 1;
            return Some(Verdict::Block { node, until_us: now_us + BLOCK_US });
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GW: NodeId = 1;

    fn rep(reporter: NodeId, first_hop: NodeId, interval: u16) -> ForgeryReport {
        // 20 and 21 are relay 10's children.
        let from_parent = matches!((reporter, first_hop), (20, 10) | (21, 10));
        ForgeryReport { session: 1, reporter, first_hop, consistent: true, from_parent, interval, seq: 9, port: 24, tag: [interval as u8; TAG_LEN], len: 0, body: [0; REPORT_BODY_MAX] }
    }

    /// The forger X = 50 injects; its neighbours 10, 11, 12 hear it first-hand; relay 10
    /// forwards to its children 20, 21 (who name 10). Honest 10 reports "from 50". X says
    /// nothing. After three forgeries X is blocked; relay 10 never.
    #[test]
    fn the_injector_is_blocked_and_its_honest_relay_is_not() {
        let mut f = Forensics::new(GW);
        let mut t = 0;
        let mut verdicts = Vec::new();
        for k in 0..3u16 {
            for (r, h) in [(10, 50), (11, 50), (12, 50), (20, 10), (21, 10)] {
                f.report(t, &rep(r, h, 100 + k), false, true);
            }
            t += 1_100_000;
            verdicts.extend(f.tick(t));
        }
        assert_eq!(verdicts, vec![Verdict::Block { node: 50, until_us: t + BLOCK_US }]);
    }

    /// X lies, naming a different honest neighbour as its upstream each time. Honest
    /// neighbours never had the packet before X (no report naming an upstream for it) or
    /// name X back: X stays a suspect; each framed neighbour is never one (it has only X's
    /// word, below the witness quorum).
    #[test]
    fn a_forger_naming_neighbours_as_its_source_is_still_caught() {
        let mut f = Forensics::new(GW);
        let mut t = 0;
        let mut v = Vec::new();
        for k in 0..3u16 {
            let framed = 11 + k; // 11, 12, 13 in turn
            f.report(t, &rep(50, framed, 200 + k), false, true);
            for (r, h) in [(11, 50), (12, 50), (13, 50), (14, 50)] {
                f.report(t, &rep(r, h, 200 + k), false, true);
            }
            t += 1_100_000;
            v.extend(f.tick(t));
        }
        assert_eq!(v, vec![Verdict::Block { node: 50, until_us: t + BLOCK_US }]);
    }

    /// One liar (30) fabricates forgeries naming honest 12 as their first hop: one witness per
    /// forgery, below the quorum, never a block. Reports about genuine packets count as lies.
    /// A chain of honest relays (40 got it from 10, 10 from the injector 50): 40 is named
    /// by its own side witnesses but is cleared by its account; only 50 is blocked.
    #[test]
    fn a_chain_of_honest_relays_is_cleared() {
        let mut f = Forensics::new(GW);
        let mut t = 0;
        let mut v = Vec::new();
        for k in 0..3u16 {
            for (r, h) in [(10, 50), (11, 50), (12, 50), (40, 10), (13, 10), (41, 40), (42, 40)] {
                f.report(t, &rep(r, h, 600 + k), false, true);
            }
            t += 1_100_000;
            v.extend(f.tick(t));
        }
        assert_eq!(v, vec![Verdict::Block { node: 50, until_us: t + BLOCK_US }]);
    }

    #[test]
    fn one_liar_cannot_frame_an_honest_fixture() {
        let mut f = Forensics::new(GW);
        let mut t = 0;
        for k in 0..20u16 {
            f.report(t, &rep(30, 12, 300 + k), false, true);
            f.report(t, &rep(30, 12, 300 + k), true, true);
            f.report(t, &rep(31, 12, 300 + k), false, false);
            t += 1_100_000;
            assert_eq!(f.tick(t), None);
        }
        assert_eq!((f.stats.lies, f.stats.unsampled), (20, 20));
        assert_eq!(f.stats.blocks, 0);
    }

    /// The forger names a relay that did forward its forgery (10, whose children 20 and 21
    /// name it). The relay's own report names the forger back: the forger is not cleared.
    #[test]
    fn naming_a_relay_that_forwarded_it_does_not_clear_the_forger() {
        let mut f = Forensics::new(GW);
        let mut t = 0;
        let mut v = Vec::new();
        for k in 0..3u16 {
            for (r, h) in [(50, 10), (10, 50), (11, 50), (12, 50), (20, 10), (21, 10)] {
                f.report(t, &rep(r, h, 500 + k), false, true);
            }
            t += 1_100_000;
            v.extend(f.tick(t));
        }
        assert_eq!(v, vec![Verdict::Block { node: 50, until_us: t + BLOCK_US }]);
    }

    /// A crowded neighbourhood (more neighbours than slots) never evicts a block.
    #[test]
    fn a_block_survives_a_crowded_neighbourhood() {
        let mut g = LinkGuard::new();
        g.order_block(0, 77, BLOCK_US);
        for k in 0..200u16 {
            g.heard(1_000, 100 + k % 40, -70);
        }
        assert!(!g.allow(2_000, 77, -60));
    }

    #[test]
    fn the_report_sample_is_one_key_in_eight() {
        let n = (0..=255u8).filter(|&b| sampled(&[b; 16])).count();
        assert_eq!(n, 32);
    }

    /// Two colluders together reach the witness quorum: they can get an honest fixture a
    /// temporary block (not removal: the admin decides that). The residual (§7.9).
    #[test]
    fn two_colluders_can_get_a_temporary_block_only() {
        let mut f = Forensics::new(GW);
        let mut t = 0;
        let mut v = Vec::new();
        for k in 0..3u16 {
            f.report(t, &rep(30, 12, 400 + k), false, true);
            f.report(t, &rep(31, 12, 400 + k), false, true);
            t += 1_100_000;
            v.extend(f.tick(t));
        }
        assert_eq!(v.len(), 1);
    }

    #[test]
    fn the_guard_blocks_a_neighbour_after_three_and_a_spoof_by_rssi() {
        let mut g = LinkGuard::new();
        for _ in 0..10 {
            g.heard(0, 7, -60);
            g.heard(0, 8, -75);
        }
        let t = 1_000_000;
        assert_eq!(g.forged(t, 7, -61, false), Attribution::Neighbour(7));
        g.forged(t + 10_000, 7, -60, false);
        assert!(g.allow(t + 20_000, 7, -60));
        g.forged(t + 20_000, 7, -59, false);
        assert!(!g.allow(t + 30_000, 7, -60));
        assert!(g.allow(t + BLOCK_US + 30_000, 7, -60));
        // Frames under 8's id at -55 dBm (8 is usually -75): a spoof. Blocked as a spoof after
        // three; 8's own frames (at -75) still pass.
        for k in 0..3 {
            assert_eq!(g.forged(t + k * 1000, 8, -55, false), Attribution::Spoof(8));
        }
        assert!(!g.allow(t + 5_000, 8, -55));
        assert!(g.allow(t + 5_000, 8, -74));
        assert_eq!((g.stats.blocks, g.stats.spoof_blocks), (1, 1));
        // A parent needs BLOCK_AFTER_PARENT.
        for _ in 0..10 {
            g.heard(0, 9, -50);
        }
        for k in 0..8 {
            g.forged(t + k * 1000, 9, -50, true);
        }
        assert!(g.allow(t + 9_000, 9, -50));
        g.forged(t + 9_000, 9, -50, true);
        assert!(!g.allow(t + 10_000, 9, -50));
    }

    #[test]
    fn a_report_roundtrips_and_its_mac_binds_the_reporter() {
        let mut r = rep(10, 50, 7);
        r.len = 5;
        r.body[..5].copy_from_slice(b"hello");
        let k = [3u8; 16];
        let mut b = [0u8; 160];
        let n = r.encode(&k, &mut b).unwrap();
        assert_eq!(ForgeryReport::decode(&b[..n], |_| Some(k)), Some(r));
        assert_eq!(ForgeryReport::decode(&b[..n], |_| Some([4; 16])), None);
    }
}
