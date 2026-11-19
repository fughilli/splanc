// Ported from fughilli/indoor_localization swarm/net/src/update.rs at 5a906e78 (Splanc owns this
// copy; firmware/mesh/swarm/PROVENANCE.md lists what changed).
//! Firmware image distribution (firmware/mesh/swarm/docs/swarm-network.md "Distribution
//! protocol"): Deluge-style, page by page. A node fills its staging area's
//! pages strictly in order, so its progress is one number it advertises in
//! every POLL; a node that's behind asks the most advanced neighbour for the
//! chunks it's missing in its current page, and that neighbour broadcasts
//! them, so everyone else on the same page gets them too.
//!
//! Staging layout: sector 0 holds `varint(length) || Manifest` (the signed
//! manifest envelope, stored exactly as it was received; erased flash reads
//! as "no manifest"); the image starts at offset PAGE_SIZE. The firmware
//! provides the flash (a raw partition).
//!
//! Messages (swarm_wire.proto): `Summary` rides every POLL, `FwRequest` is a
//! link unicast to the server, `FwData` a link broadcast, and the manifest is
//! offered in a link frame of its own (net.rs FrameKind::FwManifest).

use crate::crypto::{Sha256, P256_PUBLIC_KEY_LEN};
use crate::manifest::{Manifest, STAGED_MAX};
use crate::wire::{self, pb};

pub const PAGE_SIZE: usize = 4096;
pub const CHUNK: usize = 96;
pub const CHUNKS_PER_PAGE: usize = PAGE_SIZE.div_ceil(CHUNK);
const IMAGE_OFFSET: u32 = PAGE_SIZE as u32;
const NEIGHBOURS: usize = 16;
/// Splanc: custodians a requester prefers as page servers.
pub const PREFERRED: usize = 4;
const SERVE_SLOTS: usize = 4;

/// Longest encoded FwRequest: version 6 + page 4 (a u16 page) + missing bitmap 9. (With
/// pages below 16384, i.e. images up to 64 MB, it is 18.)
pub const REQUEST_MAX: usize = 19;
/// Longest encoded FwData: version 6 + page 4 + chunk 2 + data (2 + CHUNK). (109 with
/// pages below 16384.)
pub const DATA_MAX: usize = 6 + 4 + 2 + 2 + CHUNK;
/// Longest encoded Summary: running 6 + staged 6 + pages 4 + total 4 + generation 6.
pub const SUMMARY_MAX: usize = 26;

/// The staging partition, as the firmware exposes it.
pub trait Flash {
    fn capacity(&self) -> u32;
    /// Erase whole sectors (PAGE_SIZE-aligned).
    fn erase(&mut self, offset: u32, len: u32) -> bool;
    fn write(&mut self, offset: u32, data: &[u8]) -> bool;
    fn read(&mut self, offset: u32, buf: &mut [u8]) -> bool;
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Summary {
    /// Firmware version this node runs (0: flashed by hand, unversioned).
    pub running: u32,
    /// Version of the staged image (0: none).
    pub staged: u32,
    pub pages: u16,
    pub total: u16,
    /// Swarm settings generation (net.rs fills it; the Updater leaves 0).
    pub generation: u32,
}

impl Summary {
    pub fn encode(&self, out: &mut [u8]) -> Option<usize> {
        wire::summary(self.running, self.staged, self.pages as u32, self.total as u32, self.generation, out)
    }

    pub fn decode(b: &[u8]) -> Option<Summary> {
        let m = pb::SummaryView::parse(b).ok()?;
        Some(Summary {
            running: m.running(),
            staged: m.staged(),
            pages: u16::try_from(m.pages()).ok()?,
            total: u16::try_from(m.total()).ok()?,
            generation: m.generation(),
        })
    }

    pub fn complete(&self) -> bool {
        self.staged != 0 && self.pages == self.total
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    /// No newer image known.
    Idle,
    /// Collecting `version`.
    Receiving,
    /// A verified image newer than the running firmware is staged: install.
    Ready,
    /// The staged image is what's running (or older): serve it only.
    Serving,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct UpdateStats {
    pub manifests_accepted: u32,
    pub rejected_signature: u32,
    pub chunks_written: u32,
    pub chunks_duplicate: u32,
    pub pages_completed: u32,
    pub requests_sent: u32,
    pub chunks_served: u32,
    pub verify_failed: u32,
    pub flash_errors: u32,
}

#[derive(Clone, Copy)]
struct Neighbour {
    id: u16,
    summary: Summary,
    last_us: i64,
}

#[derive(Clone, Copy)]
struct Serve {
    page: u16,
    missing: u64,
}

pub struct Updater {
    pub me: u16,
    public_key: [u8; P256_PUBLIC_KEY_LEN],
    pub running: u32,
    manifest: Option<Manifest>,
    pages_done: u16,
    page_have: u64,
    page_erased: bool,
    verified: bool,
    /// The firmware running here has proven healthy (the shell says so once
    /// it has run long enough). Canary rule: a node offers and serves only
    /// the image it is running *and* has validated, so an image that can't
    /// boot never leaves the first node that tries it.
    validated: bool,
    neighbours: [Option<Neighbour>; NEIGHBOURS],
    /// Splanc: high-capacity neighbours (P4 + C6, Pi custodians) to ask first.
    preferred: [u16; PREFERRED],
    serve: [Option<Serve>; SERVE_SLOTS],
    last_request_us: i64,
    last_data_us: i64,
    /// Someone near us runs or holds an older version: offer our manifest.
    offer_pending: bool,
    last_offer_us: i64,
    /// When a page was last queued for serving (request or push), by page,
    /// for the push fallback's rate limit.
    last_queued_us: [(u16, i64); SERVE_SLOTS],
    pub stats: UpdateStats,
    /// Re-request when no useful data arrived for this long.
    pub request_quiet_us: i64,
    pub offer_period_us: i64,
    /// Push fallback: a neighbour whose summary shows it behind on our image,
    /// with nothing queued for its page in this long, gets the whole page
    /// unasked. Requests stay the fast path; this covers a requester whose
    /// requests can't get out (e.g. older firmware with no spare airtime).
    pub push_after_us: i64,
}

impl Updater {
    pub fn new(me: u16, public_key: [u8; P256_PUBLIC_KEY_LEN], running: u32) -> Updater {
        Updater {
            me,
            public_key,
            running,
            manifest: None,
            pages_done: 0,
            page_have: 0,
            page_erased: false,
            verified: false,
            validated: false,
            neighbours: [None; NEIGHBOURS],
            preferred: [0xFFFF; PREFERRED],
            serve: [None; SERVE_SLOTS],
            last_request_us: i64::MIN / 2,
            last_data_us: i64::MIN / 2,
            offer_pending: false,
            last_offer_us: i64::MIN / 2,
            last_queued_us: [(u16::MAX, i64::MIN / 2); SERVE_SLOTS],
            stats: UpdateStats::default(),
            request_quiet_us: 100_000,
            offer_period_us: 1_000_000,
            push_after_us: 1_500_000,
        }
    }

    pub fn manifest(&self) -> Option<Manifest> {
        self.manifest
    }

    /// The running firmware is healthy (main, after its health checks).
    pub fn set_validated(&mut self, validated: bool) {
        self.validated = validated;
        if validated {
            self.offer_pending = true;
        }
    }

    /// May this node hand out its staged image? Only one it runs and has
    /// validated (see `validated`).
    pub fn servable(&self) -> bool {
        self.validated && self.verified && self.manifest.is_some_and(|m| m.version == self.running)
    }

    fn total_pages(&self) -> u16 {
        self.manifest.map_or(0, |m| (m.size as usize).div_ceil(PAGE_SIZE) as u16)
    }

    pub fn summary(&self) -> Summary {
        Summary {
            running: self.running,
            staged: self.manifest.map_or(0, |m| m.version),
            pages: self.pages_done,
            total: self.total_pages(),
            generation: 0,
        }
    }

    pub fn status(&self) -> Status {
        match self.manifest {
            None => Status::Idle,
            Some(_) if !self.verified => Status::Receiving,
            Some(m) if m.version > self.running => Status::Ready,
            Some(_) => Status::Serving,
        }
    }

    /// At boot: pick up a staged image (signature + full hash check).
    /// A partial one restarts from page 0 (progress isn't persisted).
    pub fn boot(&mut self, flash: &mut dyn Flash) {
        let mut hdr = [0u8; STAGED_MAX];
        if !flash.read(0, &mut hdr) {
            return;
        }
        let Some(m) = Manifest::decode_staged(&hdr) else { return };
        if !self.acceptable_size(&m, flash) || !m.verify(&self.public_key) {
            return;
        }
        self.manifest = Some(m);
        self.pages_done = self.total_pages();
        if self.verify_image(flash) {
            self.verified = true;
        } else {
            self.restart_image();
        }
    }

    /// A signed manifest (from the host or the mesh). Adopts it if newer
    /// than both what runs and what's staged. Returns true if adopted.
    pub fn offer(&mut self, m: Manifest, flash: &mut dyn Flash) -> bool {
        if self.manifest == Some(m) {
            return false; // already ours (host re-offers resume through host_offer)
        }
        let staged = self.manifest.map_or(0, |s| s.version);
        if m.version <= self.running || m.version <= staged {
            return false;
        }
        if !self.acceptable_size(&m, flash) {
            return false;
        }
        if !m.verify(&self.public_key) {
            self.stats.rejected_signature += 1;
            return false;
        }
        let mut staged = [0u8; STAGED_MAX];
        let n = m.encode_staged(&mut staged);
        let ok = flash.erase(0, PAGE_SIZE as u32) && flash.write(0, &staged[..n]);
        if !ok {
            self.stats.flash_errors += 1;
            return false;
        }
        self.manifest = Some(m);
        self.verified = false;
        self.serve = [None; SERVE_SLOTS];
        self.restart_image();
        self.stats.manifests_accepted += 1;
        self.offer_pending = true; // tell the neighbourhood
        true
    }

    /// A neighbour's summary (from its POLL frame).
    pub fn on_summary(&mut self, t_us: i64, id: u16, s: Summary) {
        let slot = self
            .neighbours
            .iter()
            .position(|n| matches!(n, Some(n) if n.id == id))
            .or_else(|| self.neighbours.iter().position(|n| n.is_none()))
            .or_else(|| {
                // Replace the stalest.
                (0..NEIGHBOURS).min_by_key(|&i| self.neighbours[i].map_or(i64::MIN, |n| n.last_us))
            });
        if let Some(i) = slot {
            self.neighbours[i] = Some(Neighbour { id, summary: s, last_us: t_us });
        }
        if let Some(m) = self.manifest {
            if s.running < m.version && s.staged < m.version {
                self.offer_pending = true;
            }
            if self.servable() && s.staged == m.version && s.pages < self.pages_done && s.running < m.version {
                let page = s.pages;
                let recent = self
                    .last_queued_us
                    .iter()
                    .any(|&(p, at)| p == page && t_us - at < self.push_after_us);
                if !recent {
                    let missing = self.page_mask(page);
                    self.queue(t_us, page, missing);
                }
            }
        }
    }

    /// Serve `missing` chunks of `page` (merging with what's queued).
    fn queue(&mut self, t_us: i64, page: u16, missing: u64) {
        let oldest = (0..SERVE_SLOTS).min_by_key(|&i| self.last_queued_us[i].1).unwrap();
        let at = self.last_queued_us.iter().position(|&(p, _)| p == page).unwrap_or(oldest);
        self.last_queued_us[at] = (page, t_us);
        if let Some(sv) = self.serve.iter_mut().flatten().find(|sv| sv.page == page) {
            sv.missing |= missing;
            return;
        }
        if let Some(slot) = self.serve.iter().position(|sv| sv.is_none()) {
            self.serve[slot] = Some(Serve { page, missing });
        }
    }

    /// Our manifest, if a neighbour needs to hear about it (rate-limited).
    /// Sent as a link broadcast frame of its own (FrameKind::FwManifest).
    pub fn manifest_offer(&mut self, t_us: i64) -> Option<Manifest> {
        if !self.offer_pending || t_us - self.last_offer_us < self.offer_period_us || !self.servable() {
            return None;
        }
        self.offer_pending = false;
        self.last_offer_us = t_us;
        self.manifest
    }

    /// A request for chunks of a page, addressed to us.
    pub fn on_request_at(&mut self, t_us: i64, p: &[u8]) {
        let Ok(r) = pb::FwRequestView::parse(p) else { return };
        let Ok(page) = u16::try_from(r.page()) else { return };
        let missing = r.missing() & self.page_mask(page);
        let Some(m) = self.manifest else { return };
        if !self.servable() || r.version() != m.version || page >= self.pages_done || missing == 0 {
            return;
        }
        self.queue(t_us, page, missing);
    }

    /// A data chunk heard off the air (broadcast).
    pub fn on_data(&mut self, t_us: i64, p: &[u8], flash: &mut dyn Flash) {
        let Ok(d) = pb::FwDataView::parse(p) else { return };
        let (Ok(page), Ok(chunk)) = (u16::try_from(d.page()), u8::try_from(d.chunk())) else { return };
        self.chunk(t_us, d.version(), page, chunk as usize, d.data(), flash);
    }

    fn chunk(&mut self, t_us: i64, version: u32, page: u16, chunk: usize, data: &[u8], flash: &mut dyn Flash) {
        let Some(m) = self.manifest else { return };
        if self.verified || version != m.version || page != self.pages_done || chunk >= CHUNKS_PER_PAGE {
            return;
        }
        if data.len() != self.chunk_len(page, chunk) {
            return;
        }
        let bit = 1u64 << chunk;
        if self.page_have & bit != 0 {
            self.stats.chunks_duplicate += 1;
            return;
        }
        let page_off = IMAGE_OFFSET + page as u32 * PAGE_SIZE as u32;
        if !self.page_erased {
            if !flash.erase(page_off, PAGE_SIZE as u32) {
                self.stats.flash_errors += 1;
                return;
            }
            self.page_erased = true;
        }
        if !flash.write(page_off + (chunk * CHUNK) as u32, data) {
            self.stats.flash_errors += 1;
            return;
        }
        self.page_have |= bit;
        self.last_data_us = t_us;
        self.stats.chunks_written += 1;
        if self.page_have == self.page_mask(page) {
            self.pages_done += 1;
            self.page_have = 0;
            self.page_erased = false;
            self.stats.pages_completed += 1;
            // Neighbours on this page may ask us now; a fresh page means a
            // fresh request right away.
            self.last_data_us = i64::MIN / 2;
            if self.pages_done == self.total_pages() {
                if self.verify_image(flash) {
                    self.verified = true;
                    self.offer_pending = true;
                } else {
                    self.stats.verify_failed += 1;
                    self.restart_image();
                }
            }
        }
    }

    /// Host path (node on USB): write a chunk directly, in any order the
    /// host likes as long as pages go in sequence.
    pub fn host_chunk(&mut self, t_us: i64, page: u16, chunk: u8, data: &[u8], flash: &mut dyn Flash) {
        let Some(m) = self.manifest else { return };
        self.chunk(t_us, m.version, page, chunk as usize, &data[..data.len().min(CHUNK)], flash);
    }

    /// Splanc: the custodians to ask first (from their adverts' capacity class).
    pub fn set_preferred(&mut self, ids: &[u16]) {
        self.preferred = [0xFFFF; PREFERRED];
        for (p, &id) in self.preferred.iter_mut().zip(ids) {
            *p = id;
        }
    }

    /// Our next request, if we're behind a neighbour and nothing useful has
    /// arrived for a while: (destination, encoded FwRequest, its length).
    pub fn next_request(&mut self, t_us: i64) -> Option<(u16, [u8; REQUEST_MAX], usize)> {
        let m = self.manifest?;
        if self.verified
            || t_us - self.last_data_us < self.request_quiet_us
            || t_us - self.last_request_us < self.request_quiet_us
        {
            return None;
        }
        // The most advanced live neighbour with our version that has the
        // page we need.
        let server = self
            .neighbours
            .iter()
            .flatten()
            .filter(|n| t_us - n.last_us < 2_000_000 && n.summary.staged == m.version && n.summary.pages > self.pages_done)
            // Splanc: among those, a custodian first (it holds the retransmissions, so
            // constrained neighbours don't have to).
            .max_by_key(|n| (self.preferred.contains(&n.id), n.summary.pages))?;
        self.last_request_us = t_us;
        self.stats.requests_sent += 1;
        let missing = self.page_mask(self.pages_done) & !self.page_have;
        let mut p = [0u8; REQUEST_MAX];
        let n = wire::fw_request(m.version, self.pages_done as u32, missing, &mut p)?;
        Some((server.id, p, n))
    }

    /// Next chunk to broadcast while serving requests: an encoded FwData into `out`
    /// (DATA_MAX bytes is always enough).
    pub fn next_data(&mut self, out: &mut [u8], flash: &mut dyn Flash) -> Option<usize> {
        let m = self.manifest?;
        if out.len() < DATA_MAX {
            return None;
        }
        // Lowest page first: everyone needs it before the next.
        let i = (0..SERVE_SLOTS).filter(|&i| self.serve[i].is_some()).min_by_key(|&i| self.serve[i].unwrap().page)?;
        let mut s = self.serve[i].unwrap();
        let chunk = s.missing.trailing_zeros() as usize;
        s.missing &= !(1u64 << chunk);
        self.serve[i] = if s.missing == 0 { None } else { Some(s) };
        let len = self.chunk_len(s.page, chunk);
        let mut data = [0u8; CHUNK];
        let off = IMAGE_OFFSET + s.page as u32 * PAGE_SIZE as u32 + (chunk * CHUNK) as u32;
        if !flash.read(off, &mut data[..len]) {
            self.stats.flash_errors += 1;
            return None;
        }
        self.stats.chunks_served += 1;
        wire::fw_data(m.version, s.page as u32, chunk as u32, &data[..len], out)
    }

    /// Neighbours heard recently: (id, summary, last heard).
    pub fn neighbours(&self) -> impl Iterator<Item = (u16, Summary, i64)> + '_ {
        self.neighbours.iter().flatten().map(|n| (n.id, n.summary, n.last_us))
    }

    /// Anything to serve?
    pub fn serving(&self) -> bool {
        self.serve.iter().any(|s| s.is_some())
    }

    /// Stream the staged image through SHA-256 and compare with the
    /// manifest (also what the loader runs before installing).
    pub fn verify_image(&self, flash: &mut dyn Flash) -> bool {
        let Some(m) = self.manifest else { return false };
        let mut h = Sha256::new();
        let mut buf = [0u8; 256];
        let mut off = 0usize;
        while off < m.size as usize {
            let n = (m.size as usize - off).min(buf.len());
            if !flash.read(IMAGE_OFFSET + off as u32, &mut buf[..n]) {
                return false;
            }
            h.update(&buf[..n]);
            off += n;
        }
        h.finish() == m.sha256
    }

    fn restart_image(&mut self) {
        self.pages_done = 0;
        self.page_have = 0;
        self.page_erased = false;
        self.verified = false;
    }

    fn acceptable_size(&self, m: &Manifest, flash: &dyn Flash) -> bool {
        m.size > 0 && IMAGE_OFFSET as u64 + m.size as u64 <= flash.capacity() as u64
    }

    /// Bytes in `chunk` of `page` (the image's last page/chunk are short).
    fn chunk_len(&self, page: u16, chunk: usize) -> usize {
        let size = self.manifest.map_or(0, |m| m.size as usize);
        let start = page as usize * PAGE_SIZE + chunk * CHUNK;
        let page_end = ((page as usize + 1) * PAGE_SIZE).min(size);
        if start >= page_end {
            0
        } else {
            (page_end - start).min(CHUNK)
        }
    }

    /// Bits for the chunks that exist in `page`.
    fn page_mask(&self, page: u16) -> u64 {
        let size = self.manifest.map_or(0, |m| m.size as usize);
        let in_page = size.saturating_sub(page as usize * PAGE_SIZE).min(PAGE_SIZE);
        let n = in_page.div_ceil(CHUNK);
        if n >= 64 {
            u64::MAX
        } else {
            (1u64 << n) - 1
        }
    }
}

#[cfg(test)]
// Splanc (clippy): the simulated air indexes sender and receivers by position.
#[allow(clippy::needless_range_loop)]
mod tests {
    use super::*;
    use crate::crypto::signing::p256_public_key as public_key;

    const SEED: [u8; 32] = [3; 32];

    pub(crate) struct RamFlash {
        pub mem: Vec<u8>,
        pub erases: u32,
    }

    impl RamFlash {
        pub fn new(size: usize) -> RamFlash {
            RamFlash { mem: vec![0xFF; size], erases: 0 }
        }
    }

    impl Flash for RamFlash {
        fn capacity(&self) -> u32 {
            self.mem.len() as u32
        }
        fn erase(&mut self, offset: u32, len: u32) -> bool {
            assert_eq!(offset as usize % PAGE_SIZE, 0, "unaligned erase");
            self.mem[offset as usize..(offset + len) as usize].fill(0xFF);
            self.erases += 1;
            true
        }
        fn write(&mut self, offset: u32, data: &[u8]) -> bool {
            for (i, &b) in data.iter().enumerate() {
                let at = offset as usize + i;
                // NOR flash: writes only clear bits.
                assert_eq!(self.mem[at] & b, b, "write to unerased flash at {}", at);
                self.mem[at] = b;
            }
            true
        }
        fn read(&mut self, offset: u32, buf: &mut [u8]) -> bool {
            buf.copy_from_slice(&self.mem[offset as usize..offset as usize + buf.len()]);
            true
        }
    }

    fn image(len: usize) -> Vec<u8> {
        (0..len).map(|i| (i * 31 % 251) as u8).collect()
    }

    fn signed(img: &[u8], version: u32) -> Manifest {
        let mut m = Manifest::for_image(img, version, 0);
        m.sign(&SEED);
        m
    }

    struct Node {
        u: Updater,
        flash: RamFlash,
    }

    /// Nodes on a TDMA schedule: each, in its slot, sends a request if due,
    /// then up to `budget` data chunks; links lose frames at `loss`.
    fn run(nodes: &mut [Node], links: &dyn Fn(usize, usize) -> bool, loss: f64, superframes: usize, budget: usize) -> usize {
        let mut rng = 0x1234_5678_9ABC_DEF0u64;
        let mut lost = move || {
            rng ^= rng << 13;
            rng ^= rng >> 7;
            rng ^= rng << 17;
            ((rng >> 11) as f64 / (1u64 << 53) as f64) < loss
        };
        let n = nodes.len();
        let mut t = 0i64;
        for sf in 0..superframes {
            for i in 0..n {
                t += 5_000;
                // POLL: summary to everyone in range.
                let s = nodes[i].u.summary();
                let me = nodes[i].u.me;
                for j in 0..n {
                    if j != i && links(i, j) && !lost() {
                        nodes[j].u.on_summary(t, me, s);
                    }
                }
                // Manifest offers (as a local mesh broadcast).
                if let Some(m) = nodes[i].u.manifest_offer(t) {
                    for j in 0..n {
                        if j != i && links(i, j) && !lost() {
                            let Node { u, flash } = &mut nodes[j];
                            u.offer(m, flash);
                        }
                    }
                }
                if let Some((dest, req, rn)) = nodes[i].u.next_request(t) {
                    if let Some(j) = nodes.iter().position(|x| x.u.me == dest) {
                        if links(i, j) && !lost() {
                            nodes[j].u.on_request_at(t, &req[..rn]);
                        }
                    }
                }
                for _ in 0..budget {
                    let mut out = [0u8; DATA_MAX];
                    let Node { u, flash } = &mut nodes[i];
                    let Some(len) = u.next_data(&mut out, flash) else { break };
                    for j in 0..n {
                        if j != i && links(i, j) && !lost() {
                            let Node { u, flash } = &mut nodes[j];
                            u.on_data(t, &out[..len], flash);
                        }
                    }
                }
            }
            // Simulated install: a node with a verified newer image reboots
            // into it and, healthy, validates it (then it may serve).
            for x in nodes.iter_mut() {
                if x.u.status() == Status::Ready {
                    x.u.running = x.u.manifest().unwrap().version;
                    x.u.set_validated(true);
                }
            }
            if nodes.iter().all(|x| x.u.status() == Status::Serving) {
                return sf + 1;
            }
        }
        superframes
    }

    fn swarm(n: usize, running: u32) -> Vec<Node> {
        let pk = public_key(&SEED);
        (0..n).map(|i| Node { u: Updater::new(i as u16 + 1, pk, running), flash: RamFlash::new(64 * PAGE_SIZE) }).collect()
    }

    fn inject(node: &mut Node, img: &[u8], m: Manifest) {
        assert!(node.u.offer(m, &mut node.flash));
        for (page, p) in img.chunks(PAGE_SIZE).enumerate() {
            for (c, d) in p.chunks(CHUNK).enumerate() {
                node.u.host_chunk(0, page as u16, c as u8, d, &mut node.flash);
            }
        }
        assert_eq!(node.u.status(), Status::Ready);
        // It installs and runs it healthy before serving anyone.
        node.u.running = m.version;
        node.u.set_validated(true);
    }

    #[test]
    fn one_room_with_loss_gets_the_whole_image() {
        let img = image(10 * PAGE_SIZE + 1234);
        let m = signed(&img, 2);
        let mut nodes = swarm(4, 1);
        inject(&mut nodes[0], &img, m);
        let sf = run(&mut nodes, &|_, _| true, 0.1, 3000, 6);
        for (i, x) in nodes.iter_mut().enumerate() {
            assert_eq!(x.u.status(), Status::Serving, "node {} at {:?}", i, x.u.summary());
            assert_eq!(&x.flash.mem[PAGE_SIZE..PAGE_SIZE + img.len()], &img[..]);
        }
        // ~11 pages x 43 chunks at 6/slot with 10% loss: well under 10 s.
        assert!(sf < 400, "took {} superframes", sf);
    }

    /// A line: the image spreads hop by hop, each node serving the next.
    #[test]
    fn image_crosses_hops() {
        let img = image(3 * PAGE_SIZE + 10);
        let m = signed(&img, 9);
        let mut nodes = swarm(4, 1);
        inject(&mut nodes[0], &img, m);
        run(&mut nodes, &|i, j| (i as i64 - j as i64).abs() == 1, 0.05, 3000, 6);
        for x in nodes.iter() {
            assert_eq!(x.u.status(), Status::Serving);
        }
    }

    /// A receiver whose requests never get through (older firmware without
    /// spare airtime) still completes, from its summaries alone.
    #[test]
    fn summaries_alone_pull_the_image_through() {
        let img = image(4 * PAGE_SIZE + 500);
        let m = signed(&img, 4);
        let mut nodes = swarm(2, 1);
        inject(&mut nodes[0], &img, m);
        // Node 1 learns of the image; its requests are dropped (links only
        // carry 0 -> 1 for requests: run() addresses requests to j, so cut
        // the 1 -> 0 direction entirely except summaries via a flag).
        let mut t = 0i64;
        let pk = public_key(&SEED);
        let _ = pk;
        let mut rng = 7u64;
        for _ in 0..4000 {
            t += 30_000;
            let s1 = nodes[1].u.summary();
            nodes[0].u.on_summary(t, 2, s1);
            let s0 = nodes[0].u.summary();
            nodes[1].u.on_summary(t, 1, s0);
            if let Some(mf) = nodes[0].u.manifest_offer(t) {
                let Node { u, flash } = &mut nodes[1];
                u.offer(mf, flash);
            }
            let _ = nodes[1].u.next_request(t); // never delivered
            for _ in 0..16 {
                let mut out = [0u8; DATA_MAX];
                let Node { u, flash } = &mut nodes[0];
                let Some(len) = u.next_data(&mut out, flash) else { break };
                rng ^= rng << 13;
                rng ^= rng >> 7;
                rng ^= rng << 17;
                if rng % 10 == 0 {
                    continue; // 10% loss
                }
                let Node { u, flash } = &mut nodes[1];
                u.on_data(t, &out[..len], flash);
            }
            if nodes[1].u.status() == Status::Ready {
                break;
            }
        }
        assert_eq!(nodes[1].u.status(), Status::Ready, "{:?}", nodes[1].u.summary());
    }

    /// Canary: a node that staged (or even installed) an image it hasn't
    /// validated serves nothing; the image stays put.
    #[test]
    fn unvalidated_images_do_not_spread() {
        let img = image(2 * PAGE_SIZE);
        let m = signed(&img, 5);
        let mut nodes = swarm(2, 1);
        {
            let Node { u, flash } = &mut nodes[0];
            assert!(u.offer(m, flash));
        }
        for (page, p) in img.chunks(PAGE_SIZE).enumerate() {
            for (c, d) in p.chunks(CHUNK).enumerate() {
                let Node { u, flash } = &mut nodes[0];
                u.host_chunk(0, page as u16, c as u8, d, flash);
            }
        }
        // Staged and verified, installed (running = 5), but not validated:
        // e.g. it hangs or crashes before its health check.
        nodes[0].u.running = 5;
        run(&mut nodes, &|_, _| true, 0.0, 200, 6);
        assert_eq!(nodes[1].u.summary().staged, 0, "never offered");
        assert_eq!(nodes[0].u.stats.chunks_served, 0);
        nodes[0].u.set_validated(true);
        run(&mut nodes, &|_, _| true, 0.0, 2000, 6);
        assert_eq!(nodes[1].u.manifest(), Some(m), "spreads once validated");
    }

    #[test]
    fn rejects_unsigned_old_and_oversized_images() {
        let pk = public_key(&SEED);
        let mut u = Updater::new(1, pk, 5);
        let mut f = RamFlash::new(8 * PAGE_SIZE);
        let img = image(100);
        assert!(!u.offer(signed(&img, 5), &mut f), "not newer than running");
        let mut forged = Manifest::for_image(&img, 6, 0);
        forged.sign(&[4; 32]);
        assert!(!u.offer(forged, &mut f), "wrong key");
        assert!(!u.offer(signed(&image(8 * PAGE_SIZE), 6), &mut f), "doesn't fit");
        assert!(u.offer(signed(&img, 6), &mut f));
        assert!(!u.offer(signed(&img, 6), &mut f), "already staged");
    }

    #[test]
    fn corrupted_image_is_redone_and_boot_resumes_complete_image() {
        let pk = public_key(&SEED);
        let img = image(2 * PAGE_SIZE);
        let m = signed(&img, 2);
        let mut u = Updater::new(1, pk, 1);
        let mut f = RamFlash::new(8 * PAGE_SIZE);
        u.offer(m, &mut f);
        let mut bad = img.clone();
        bad[5000] ^= 0xFF;
        for (page, p) in bad.chunks(PAGE_SIZE).enumerate() {
            for (c, d) in p.chunks(CHUNK).enumerate() {
                u.host_chunk(0, page as u16, c as u8, d, &mut f);
            }
        }
        assert_eq!(u.status(), Status::Receiving);
        assert_eq!(u.stats.verify_failed, 1);
        assert_eq!(u.summary().pages, 0);
        for (page, p) in img.chunks(PAGE_SIZE).enumerate() {
            for (c, d) in p.chunks(CHUNK).enumerate() {
                u.host_chunk(0, page as u16, c as u8, d, &mut f);
            }
        }
        assert_eq!(u.status(), Status::Ready);

        // Reboot: the staged image is found and verified again.
        let mut again = Updater::new(1, pk, 1);
        again.boot(&mut f);
        assert_eq!(again.status(), Status::Ready);
        // After installing it, the same image is only served.
        let mut installed = Updater::new(1, pk, 2);
        installed.boot(&mut f);
        assert_eq!(installed.status(), Status::Serving);
    }

    /// Sector 0 holds `varint(length) || Manifest` exactly as received; erased flash is no manifest.
    #[test]
    fn staging_sector_holds_the_length_prefixed_envelope() {
        let pk = public_key(&SEED);
        let mut f = RamFlash::new(8 * PAGE_SIZE);
        let mut u = Updater::new(1, pk, 1);
        u.boot(&mut f);
        assert_eq!(u.status(), Status::Idle, "erased flash");
        let m = signed(&image(100), 2);
        assert!(u.offer(Manifest::decode(m.raw()).unwrap(), &mut f));
        assert_eq!(f.mem[0] as usize, m.raw().len());
        assert_eq!(&f.mem[1..1 + m.raw().len()], m.raw());
        assert!(f.mem[1 + m.raw().len()..PAGE_SIZE].iter().all(|&b| b == 0xFF));
    }

    #[test]
    fn summary_round_trips() {
        let s = Summary { running: 3, staged: 4, pages: 5, total: 6, generation: 300 };
        let mut b = [0u8; SUMMARY_MAX];
        let n = s.encode(&mut b).unwrap();
        assert_eq!(Summary::decode(&b[..n]), Some(s));
        assert_eq!(CHUNKS_PER_PAGE, 43);
    }
}
