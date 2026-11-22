// Ported from fughilli/indoor_localization swarm/net/src/net.rs at 5a906e78 (Splanc owns this
// copy; firmware/mesh/swarm/PROVENANCE.md lists what changed).
//! One node's network stack: mesh + settings sync + firmware distribution,
//! wired together the way the firmware's radio task drives them. The radio
//! hands over every network frame it hears and, in its own TDMA slot, asks
//! for frames to send; everything else (which port goes where, what to
//! request, what to serve, what to report) happens here, so a whole swarm
//! of these can be tested on the host.

use crate::crypto::{HMAC_KEY_LEN, P256_PUBLIC_KEY_LEN};
use crate::manifest::{Manifest, MAX_ENCODED as MANIFEST_MAX};
use crate::mesh::{max_packet, EventOf, MeshConfig, MeshOf, MAX_PACKET, MAX_PAYLOAD};
use crate::settings::{self, Changes, Layer, Settings};
use crate::update::{self, Flash, Status, Summary, Updater, REQUEST_MAX, SUMMARY_MAX};
use crate::wire::{self, pb};

/// Mesh ports beyond the settings ones (settings.rs: 2, 3, 4); swarm_wire.proto `Port`.
pub const PORT_SETTINGS_GET: u8 = 5;
pub const PORT_SETTINGS_REPORT: u8 = 6;
/// Ports from here up are the firmware's own (delivered as AppPacket).
pub const PORT_APP: u8 = 16;

const _: () = {
    assert!(crate::mesh::PORT_ACK as i32 == pb::Port::Ack as i32);
    assert!(settings::PORT_BUNDLE_DATA as i32 == pb::Port::BundleData as i32);
    assert!(settings::PORT_BUNDLE_REQUEST as i32 == pb::Port::BundleRequest as i32);
    assert!(settings::PORT_OVERRIDE as i32 == pb::Port::Override as i32);
    assert!(PORT_SETTINGS_GET as i32 == pb::Port::SettingsGet as i32);
    assert!(PORT_SETTINGS_REPORT as i32 == pb::Port::SettingsReport as i32);
    assert!(PORT_APP as i32 == pb::Port::App as i32);
};

/// The Summary carried in every POLL (firmware progress + settings generation) is at most
/// this long: it is variable-length now.
pub const SUMMARY_LEN_MAX: usize = SUMMARY_MAX;

/// What kind of link frame `next_tx` produced.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FrameKind {
    /// A mesh packet; link-layer broadcast.
    Mesh,
    /// A firmware page request, link-layer unicast to `dest`.
    FwRequest { dest: u16 },
    /// A firmware data chunk; link-layer broadcast.
    FwData,
    /// Our signed manifest (the Manifest envelope, verbatim); link-layer broadcast, never
    /// relayed.
    FwManifest,
}

/// SettingsReport head: part 2 + parts 2 + generation 6 + override_seq 6; each entry is a
/// 12-byte Setting with `source` set, so 6 entries make 88.
const REPORT_HEAD: usize = 16;
const REPORT_ENTRY: usize = 12;
const REPORT_ENTRIES: usize = (MAX_PAYLOAD - REPORT_HEAD) / REPORT_ENTRY;
const _: () = assert!(REPORT_ENTRIES == 6);
pub const SOURCE_SWARM: u16 = 1;
pub const SOURCE_OVERRIDE: u16 = 2;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct NetChanges {
    pub settings: Changes,
    /// A verified, newer firmware image is staged.
    pub fw_ready: bool,
}

/// A packet for the firmware itself (port >= PORT_APP), or a settings
/// report for the host. Up to `P` payload bytes (the mesh's capacity).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AppPacketOf<const P: usize> {
    pub origin: u16,
    pub dest: u16,
    pub port: u8,
    pub hops: u8,
    pub rssi: f32,
    pub len: usize,
    pub payload: [u8; P],
}

/// The swarm's app packet (88-byte payload).
pub type AppPacket = AppPacketOf<MAX_PAYLOAD>;

// Splanc: 4 (upstream 8): the application drains it every tick (docs/design/mesh.md §10.3).
const APP_QUEUE: usize = 4;

/// One node's network stack over a mesh of payload capacity `P` (Splanc: a parameter so a
/// backhaul with a larger MTU carries larger app packets; the swarm's own traffic stays
/// within 88 bytes).
pub struct NetOf<const P: usize> {
    pub mesh: MeshOf<P>,
    pub settings: Settings,
    pub updater: Updater,
    changes: NetChanges,
    app: [Option<AppPacketOf<P>>; APP_QUEUE],
    /// Pending settings report: (to, next part).
    report: Option<(u16, u8)>,
}

/// The swarm's network stack (88-byte payloads, as upstream).
pub type Net = NetOf<MAX_PAYLOAD>;

impl<const P: usize> NetOf<P> {
    /// Splanc: the largest link payload `next_tx` can produce at this capacity
    /// ([`MAX_FRAME_PAYLOAD`] for the swarm's 88).
    pub const MAX_FRAME: usize = if max_packet(P) > MAX_FRAME_PAYLOAD { max_packet(P) } else { MAX_FRAME_PAYLOAD };

    pub fn new(me: u16, hmac_key: Option<[u8; HMAC_KEY_LEN]>, fw_key: [u8; P256_PUBLIC_KEY_LEN], running: u32, seed: u32) -> NetOf<P> {
        NetOf {
            mesh: MeshOf::new(me, MeshConfig::default(), seed),
            settings: Settings::new(me, hmac_key),
            updater: Updater::new(me, fw_key, running),
            changes: NetChanges::default(),
            app: [None; APP_QUEUE],
            report: None,
        }
    }

    pub fn me(&self) -> u16 {
        self.mesh.me
    }

    /// What changed since the last call (settings to apply/persist, an
    /// image ready to install).
    pub fn take_changes(&mut self) -> NetChanges {
        let c = self.changes;
        self.changes = NetChanges::default();
        c
    }

    pub fn next_app(&mut self) -> Option<AppPacketOf<P>> {
        let i = self.app.iter().position(|a| a.is_some())?;
        let a = self.app[i].take();
        // Keep arrival order.
        self.app[i..].rotate_left(1);
        a
    }

    /// This node's Summary: firmware progress + settings generation.
    pub fn own_summary(&self) -> Summary {
        Summary { generation: self.settings.generation(), ..self.updater.summary() }
    }

    /// The encoded Summary for a POLL: its bytes and length (at most SUMMARY_LEN_MAX).
    pub fn summary(&self) -> ([u8; SUMMARY_MAX], usize) {
        let mut b = [0u8; SUMMARY_MAX];
        let n = self.own_summary().encode(&mut b).unwrap();
        (b, n)
    }

    // ---- from the radio

    /// A neighbour's POLL summary.
    pub fn on_summary(&mut self, t_us: i64, from: u16, b: &[u8]) {
        let Some(s) = Summary::decode(b) else { return };
        // Splanc: the firmware image updater is host-only (feature `fw_update`) until OTA
        // over the mesh (Phase 2); the C6 never links it.
        #[cfg(feature = "fw_update")]
        self.updater.on_summary(t_us, from, s);
        // Splanc: swarm settings bundles are host-only (feature `swarm_settings`): the C6
        // firmware has no bundle key (membership is Splanc's), so it could accept none.
        #[cfg(feature = "swarm_settings")]
        if let Some(o) = self.settings.neighbour(t_us, from, s.generation) {
            self.mesh.send_with_hops(o.dest, o.port, &o.payload[..o.len], false, o.hop_limit);
        }
        let _ = (t_us, from, s);
    }

    pub fn on_mesh(&mut self, t_us: i64, bytes: &[u8], rssi: f32, flash: &mut dyn Flash) {
        self.mesh.on_rx(bytes, rssi);
        self.drain_mesh(t_us, flash);
    }

    pub fn on_fw_request(&mut self, t_us: i64, payload: &[u8]) {
        #[cfg(feature = "fw_update")]
        self.updater.on_request_at(t_us, payload);
        let _ = (t_us, payload);
    }

    /// A neighbour's manifest frame (link broadcast): adopted if signed, newer and it
    /// fits. Not relayed: a node that adopts it offers it on its own, once it runs and has
    /// validated the image (canary rule).
    pub fn on_fw_manifest(&mut self, payload: &[u8], flash: &mut dyn Flash) {
        #[cfg(feature = "fw_update")]
        {
            let Some(m) = Manifest::decode(payload) else { return };
            let was = self.updater.status();
            self.updater.offer(m, flash);
            self.note_fw(was);
        }
        let _ = (payload, flash);
    }

    pub fn on_fw_data(&mut self, t_us: i64, payload: &[u8], flash: &mut dyn Flash) {
        #[cfg(feature = "fw_update")]
        {
            let was = self.updater.status();
            self.updater.on_data(t_us, payload, flash);
            self.note_fw(was);
        }
        let _ = (t_us, payload, flash);
    }

    /// Start of this node's TDMA slot.
    pub fn on_my_slot(&mut self) {
        self.mesh.on_my_slot();
    }

    /// Housekeeping: retries, settings serving, reports.
    pub fn poll(&mut self, t_us: i64, flash: &mut dyn Flash) {
        self.mesh.poll(t_us);
        self.drain_mesh(t_us, flash);
        #[cfg(feature = "swarm_settings")]
        {
            while self.mesh.can_send() {
                let Some(o) = self.settings.next_outgoing() else { break };
                self.mesh.send_with_hops(o.dest, o.port, &o.payload[..o.len], false, o.hop_limit);
            }
            self.pump_report();
        }
    }

    /// Next frame for this node's slot: mesh first (control traffic is
    /// small and time-critical), then a manifest offer, our firmware request,
    /// then data we're serving. `out` should be MAX_FRAME_PAYLOAD bytes (Splanc: `Self::MAX_FRAME`
    /// for a larger capacity).
    pub fn next_tx(&mut self, t_us: i64, out: &mut [u8], flash: &mut dyn Flash) -> Option<(FrameKind, usize)> {
        if let Some(n) = self.mesh.next_tx(t_us, out) {
            return Some((FrameKind::Mesh, n));
        }
        #[cfg(not(feature = "fw_update"))]
        {
            let _ = flash;
            return None;
        }
        #[cfg(feature = "fw_update")]
        if out.len() >= MANIFEST_MAX {
            if let Some(m) = self.updater.manifest_offer(t_us) {
                let raw = m.raw();
                out[..raw.len()].copy_from_slice(raw);
                return Some((FrameKind::FwManifest, raw.len()));
            }
        }
        #[cfg(feature = "fw_update")]
        if out.len() >= REQUEST_MAX {
            if let Some((dest, req, n)) = self.updater.next_request(t_us) {
                out[..n].copy_from_slice(&req[..n]);
                return Some((FrameKind::FwRequest { dest }, n));
            }
        }
        #[cfg(feature = "fw_update")]
        return self.updater.next_data(out, flash).map(|n| (FrameKind::FwData, n));
    }

    // ---- from the host (node on USB)

    pub fn host_bundle(&mut self, b: &[u8]) -> bool {
        let c = self.settings.host_bundle(b);
        self.merge(c);
        c.swarm
    }

    pub fn local_override(&mut self, key: u16, value: Option<u32>) {
        let c = self.settings.local_override(key, value);
        self.merge(c);
    }

    /// A signed manifest (the serialized Manifest envelope, up to 114 bytes) from the
    /// host: adopt it. It isn't offered to the
    /// swarm until this node runs it and validates it (canary rule, see
    /// Updater::servable).
    pub fn host_manifest(&mut self, b: &[u8], flash: &mut dyn Flash) -> bool {
        let Some(m) = Manifest::decode(b) else { return false };
        if self.updater.manifest() == Some(m) {
            return true; // the host resuming an interrupted push
        }
        let was = self.updater.status();
        if !self.updater.offer(m, flash) {
            return false;
        }
        self.note_fw(was);
        true
    }

    pub fn host_chunk(&mut self, t_us: i64, page: u16, chunk: u8, data: &[u8], flash: &mut dyn Flash) {
        let was = self.updater.status();
        self.updater.host_chunk(t_us, page, chunk, data, flash);
        self.note_fw(was);
    }

    /// Queue a mesh packet the host built (e.g. a tagged override for
    /// another node, or a settings GET). Returns the packet id.
    pub fn send(&mut self, dest: u16, port: u8, payload: &[u8], want_ack: bool) -> Option<u16> {
        self.mesh.send(dest, port, payload, want_ack)
    }

    // ----

    fn drain_mesh(&mut self, _t_us: i64, _flash: &mut dyn Flash) {
        while let Some(e) = self.mesh.next_event() {
            let EventOf::Deliver { packet, rssi, hops } = e else { continue };
            let h = packet.header;
            let p = packet.payload();
            match h.port {
                #[cfg(feature = "swarm_settings")]
                settings::PORT_BUNDLE_DATA | settings::PORT_BUNDLE_REQUEST | settings::PORT_OVERRIDE => {
                    let c = self.settings.on_packet(h.dest, h.port, p);
                    self.merge(c);
                }
                #[cfg(feature = "swarm_settings")]
                PORT_SETTINGS_GET if h.dest == self.me() => self.report = Some((h.origin, 0)),
                #[cfg(not(feature = "swarm_settings"))]
                settings::PORT_BUNDLE_DATA | settings::PORT_BUNDLE_REQUEST | settings::PORT_OVERRIDE | PORT_SETTINGS_GET => {}
                port if port >= PORT_APP || port == PORT_SETTINGS_REPORT => {
                    let mut a = AppPacketOf {
                        origin: h.origin,
                        dest: h.dest,
                        port,
                        hops,
                        rssi,
                        len: p.len(),
                        payload: [0; P],
                    };
                    a.payload[..p.len()].copy_from_slice(p);
                    if let Some(slot) = self.app.iter().position(|x| x.is_none()) {
                        self.app[slot] = Some(a);
                    }
                }
                _ => {}
            }
        }
    }

    /// Queue report parts while the mesh outbox has room: SettingsReport messages, six
    /// settings (with `source`) at most per part.
    fn pump_report(&mut self) {
        while let Some((to, part)) = self.report {
            if !self.mesh.can_send() {
                return;
            }
            let entries = report_entries(&self.settings.swarm, &self.settings.overrides);
            let total = entries.1.max(1).div_ceil(REPORT_ENTRIES) as u8;
            let start = part as usize * REPORT_ENTRIES;
            let end = (start + REPORT_ENTRIES).min(entries.1);
            let mut recs = [wire::SettingRec { key: 0, value: 0, source: 0 }; REPORT_ENTRIES];
            for (i, &(key, source, value)) in entries.0[start..end].iter().enumerate() {
                recs[i] = wire::SettingRec { key, value, source: source as u8 };
            }
            let mut p = [0u8; MAX_PAYLOAD];
            let g = self.settings.generation();
            let seq = self.settings.override_seq;
            if let Some(n) = wire::settings_report(part as u32, total as u32, g, seq, &recs[..end - start], &mut p) {
                self.mesh.send(to, PORT_SETTINGS_REPORT, &p[..n], false);
            }
            self.report = if part + 1 < total { Some((to, part + 1)) } else { None };
        }
    }

    fn merge(&mut self, c: Changes) {
        self.changes.settings.swarm |= c.swarm;
        self.changes.settings.overrides |= c.overrides;
    }

    fn note_fw(&mut self, was: Status) {
        if self.updater.status() == Status::Ready && was != Status::Ready {
            self.changes.fw_ready = true;
        }
    }
}

/// (key, source, value) for both layers; overrides shadow nothing here (the host sees both).
fn report_entries(swarm: &Layer, overrides: &Layer) -> ([(u16, u16, u32); 2 * settings::MAX_KEYS], usize) {
    let mut out = [(0u16, 0u16, 0u32); 2 * settings::MAX_KEYS];
    let mut n = 0;
    for e in swarm.slice() {
        out[n] = (e.key, SOURCE_SWARM, e.value);
        n += 1;
    }
    for e in overrides.slice() {
        out[n] = (e.key, SOURCE_OVERRIDE, e.value);
        n += 1;
    }
    (out, n)
}

/// The largest link payload `next_tx` can produce (the manifest, 114 bytes).
pub const MAX_FRAME_PAYLOAD: usize = {
    let mut m = MAX_PACKET;
    if update::DATA_MAX > m {
        m = update::DATA_MAX;
    }
    if MANIFEST_MAX > m {
        m = MANIFEST_MAX;
    }
    if REQUEST_MAX > m {
        m = REQUEST_MAX;
    }
    m
};
const _: () = assert!(MAX_FRAME_PAYLOAD == 114);

#[cfg(test)]
// Splanc (clippy): the simulated air indexes sender and receivers by position.
#[allow(clippy::needless_range_loop)]
mod tests {
    use super::*;
    use crate::crypto::signing::p256_public_key;
    use crate::settings::{make_bundle, make_override, Entry, CMD_SET, MAX_BUNDLE, PORT_OVERRIDE};
    use crate::update::PAGE_SIZE;

    const HMAC: [u8; HMAC_KEY_LEN] = [5; HMAC_KEY_LEN];
    const FW_SECRET: [u8; 32] = [6; 32];

    struct RamFlash(Vec<u8>);
    impl Flash for RamFlash {
        fn capacity(&self) -> u32 {
            self.0.len() as u32
        }
        fn erase(&mut self, o: u32, l: u32) -> bool {
            self.0[o as usize..(o + l) as usize].fill(0xFF);
            true
        }
        fn write(&mut self, o: u32, d: &[u8]) -> bool {
            self.0[o as usize..o as usize + d.len()].copy_from_slice(d);
            true
        }
        fn read(&mut self, o: u32, b: &mut [u8]) -> bool {
            b.copy_from_slice(&self.0[o as usize..o as usize + b.len()]);
            true
        }
    }

    struct Node {
        net: Net,
        flash: RamFlash,
    }

    fn swarm(n: usize) -> Vec<Node> {
        (0..n)
            .map(|i| Node {
                net: Net::new(10 + i as u16, Some(HMAC), p256_public_key(&FW_SECRET), 1, 77 + i as u32),
                flash: RamFlash(vec![0xFF; 32 * PAGE_SIZE]),
            })
            .collect()
    }

    /// Everyone hears everyone; each node in its slot sends its POLL
    /// summary and up to 3 network frames.
    fn run(nodes: &mut [Node], superframes: usize) {
        let mut t = 0i64;
        for _ in 0..superframes {
            for i in 0..nodes.len() {
                t += 5_000;
                let me = nodes[i].net.me();
                let (s, sn) = nodes[i].net.summary();
                for j in 0..nodes.len() {
                    if j != i {
                        nodes[j].net.on_summary(t, me, &s[..sn]);
                    }
                }
                {
                    let Node { net, flash } = &mut nodes[i];
                    net.on_my_slot();
                    net.poll(t, flash);
                }
                for _ in 0..3 {
                    let mut buf = [0u8; MAX_FRAME_PAYLOAD];
                    let Node { net, flash } = &mut nodes[i];
                    let Some((kind, n)) = net.next_tx(t, &mut buf, flash) else { break };
                    for j in 0..nodes.len() {
                        if j == i {
                            continue;
                        }
                        let Node { net, flash } = &mut nodes[j];
                        match kind {
                            FrameKind::Mesh => net.on_mesh(t, &buf[..n], -70.0, flash),
                            FrameKind::FwData => net.on_fw_data(t, &buf[..n], flash),
                            FrameKind::FwManifest => net.on_fw_manifest(&buf[..n], flash),
                            FrameKind::FwRequest { dest } if dest == net.me() => net.on_fw_request(t, &buf[..n]),
                            FrameKind::FwRequest { .. } => {}
                        }
                    }
                }
            }
            for x in nodes.iter_mut() {
                let Node { net, flash } = x;
                net.poll(t, flash);
                // Simulated install of a ready image, then a healthy boot.
                if net.updater.status() == Status::Ready {
                    net.updater.running = net.updater.manifest().unwrap().version;
                    net.updater.set_validated(true);
                }
            }
        }
    }

    #[test]
    fn settings_bundle_override_and_report_end_to_end() {
        let mut nodes = swarm(4);
        let mut l = Layer::default();
        l.set(106, 7.0f32.to_bits());
        let mut b = [0u8; MAX_BUNDLE];
        let n = make_bundle(&l, 3, &HMAC, &mut b);
        assert!(nodes[0].net.host_bundle(&b[..n]));
        run(&mut nodes, 20);
        for x in nodes.iter_mut() {
            assert_eq!(x.net.settings.get(106), Some(7.0f32.to_bits()));
        }
        assert!(nodes[2].net.take_changes().settings.swarm);

        // The host (via node 0) overrides one setting on node 13 only.
        let (p, len) = make_override(13, CMD_SET, 1, &[Entry { key: 300, value: 0.2f32.to_bits() }], &HMAC).unwrap();
        nodes[0].net.send(13, PORT_OVERRIDE, &p[..len], true);
        run(&mut nodes, 20);
        assert_eq!(nodes[3].net.settings.get(300), Some(0.2f32.to_bits()));
        assert_eq!(nodes[2].net.settings.get(300), None);

        // ... and reads node 13's layers back.
        nodes[0].net.send(13, PORT_SETTINGS_GET, &[], false);
        run(&mut nodes, 20);
        let r = nodes[0].net.next_app().expect("report");
        assert_eq!((r.origin, r.port), (13, PORT_SETTINGS_REPORT));
        let v = pb::SettingsReportView::parse(&r.payload[..r.len]).unwrap();
        assert_eq!((v.part(), v.parts(), v.generation(), v.override_seq()), (0, 1, 3, 1));
        let got: Vec<(u32, u32, u32)> = v.settings().map(|s| (s.key(), s.value(), s.source())).collect();
        assert_eq!(got, vec![(106, 7.0f32.to_bits(), 1), (300, 0.2f32.to_bits(), 2)], "one swarm + one override entry");
    }

    #[test]
    fn firmware_enters_at_one_node_and_reaches_all() {
        let mut nodes = swarm(4);
        let img: Vec<u8> = (0..5 * PAGE_SIZE + 77).map(|i| (i % 253) as u8).collect();
        let mut m = Manifest::for_image(&img, 2, 0);
        m.sign(&FW_SECRET);
        {
            let Node { net, flash } = &mut nodes[0];
            assert!(net.host_manifest(m.raw(), flash));
            for (page, p) in img.chunks(PAGE_SIZE).enumerate() {
                for (c, d) in p.chunks(update::CHUNK).enumerate() {
                    net.host_chunk(0, page as u16, c as u8, d, flash);
                }
            }
            assert!(net.take_changes().fw_ready);
            // Install, boot healthy: now it may serve.
            net.updater.running = 2;
            net.updater.set_validated(true);
        }
        run(&mut nodes, 2000);
        for (i, x) in nodes.iter_mut().enumerate() {
            assert_eq!(x.net.updater.status(), Status::Serving, "node {}: {:?}", i, x.net.updater.summary());
        }
    }
}
