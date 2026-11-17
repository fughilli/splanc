# Mesh networking: one app connection manages every fixture

Status: design (this document). Nothing is implemented yet. Phase 1 (the
application backhaul) is the critical path for the radiolarians install.

## Owner's request

> "It's time to start building mesh networking :) We should support two mesh backhauls. One is
> UWB and the other is ESP-NOW style P2P. Since we have our custom C6 netstack, we should build
> ESP-NOW (or something like it) in the netstack. This mesh backhaul should enable distributing
> uniforms and effects programs, such that a single connection (BLE or WiFi) from the app can
> allow management of all devices in the mesh. The mesh networking needs to support assigning
> devices to groups and freezing membership, in addition to free association (devices arriving
> at an existing mesh and being automatically peered in)."

Follow-up directions from the owner, folded into this design:

1. The UWB mesh in `fughilli/indoor_localization` (the "swarm") is the basis. Splanc adopts its
   model, frame formats and transport. The 802.11 backhaul carries the same mesh layer.
2. Realtime localization (IMU + ranging fusion, as in indoor_localization) comes later.
3. BLE ranging on the C6 should be evaluated, including a self-built Channel Sounding-like
   ranging on top of our own radio work.
4. **Priority: the application backhaul ships first**, for the radiolarians deployment. Their
   fixtures are heavy and static, so the existing room localization is enough to provision the
   install. Ranging, fusion and channel sounding are later, independent tracks.
5. Owner answers: up to 6 radiolarians, each a P4 + C6 driving WLEDs over DDP; BLE → mesh for
   sites without Wi-Fi; three membership modes (open, closed, locked).
6. The swarm code is ported into Splanc (indoor_localization is public), not shared as a
   dependency.
7. Radiolarians details: WLEDs on the P4's Ethernet; fixtures a few metres apart in metal
   enclosures; they self-configure; admin over BLE, Wi-Fi or the bridge; per-device Wi-Fi OTA
   is enough; a closed mesh unlocked with a kiosk-style admin secret; any fixture is a gateway;
   Splanc's own frame format, no Espressif OUI.

## Contents

1. [Summary](#1-summary)
2. [What exists today](#2-what-exists-today)
3. [Architecture](#3-architecture)
4. [The 802.11 P2P backhaul in the netstack](#4-the-80211-p2p-backhaul-in-the-netstack)
5. [Protocol](#5-protocol)
6. [Time sync and apply_at across the mesh](#6-time-sync-and-apply_at-across-the-mesh)
7. [Membership, groups and security](#7-membership-groups-and-security)
8. [Gateway: one connection, the whole mesh](#8-gateway-one-connection-the-whole-mesh)
9. [App and bridge UX](#9-app-and-bridge-ux)
10. [The radiolarians deployment: sizing](#10-the-radiolarians-deployment-sizing)
11. [UWB backhaul (later)](#11-uwb-backhaul-later)
12. [Ranging and realtime localization (later)](#12-ranging-and-realtime-localization-later)
13. [Ranging over the C6's own radio (research track)](#13-ranging-over-the-c6s-own-radio-research-track)
14. [Testing](#14-testing)
15. [Staged PR plan](#15-staged-pr-plan)
16. [Risks](#16-risks)
17. [Open questions for the owner](#17-open-questions-for-the-owner)
18. [Sources](#18-sources)

## 1. Summary

- **One mesh layer, several backhauls.** The mesh layer is the swarm's `swarm_net` crate
  (`swarm/net` in indoor_localization): managed flooding with dedup and TTL, want-ack unicast,
  authenticated generation-numbered state, and a Deluge-style page protocol for blobs. Splanc
  adds a security envelope, membership and groups, and Splanc ports on top. Backhauls plug in
  under a small `Backhaul` trait.
- **Phase 1 backhaul: 802.11 vendor action frames in our netstack**, with Splanc's own framing
  (a Splanc CID, no Espressif OUI). The
  netstack already sends raw management frames (`ns_mac_send`) and receives every frame on the
  channel. Mesh frames share the AP's channel when associated, and a fixed mesh channel when
  not.
- **The gateway** is whichever fixture the app (or bridge) is connected to, over BLE or wss. It
  relays wrapped `ClientMessage`s to any member, group or the whole mesh, and aggregates acks
  and status.
- **Effects** (`.fxb`, at most 4 KiB, `FX_MAX_BYTES` in `firmware/player_app/ffi.rs`) travel as
  content-addressed blobs over the page protocol. Uniforms, brightness and crossfade travel as
  small flooded packets.
- **Mesh time** is disciplined from beacons. The app's `SetTimeBase` epoch is mapped into mesh
  time, so `apply_at_ms` (`docs/design/synced-show.md`) lands a relayed change on the same
  frame on every member.
- **Membership:** a mesh has an id, a key and an epoch, and one of three modes set from the
  app. **Open**: any Splanc device can follow the show (time, scenes, effects) as a guest, with
  no secret, but can never manage it. **Closed**: devices holding the site secret from
  provisioning join as members. **Locked**: only devices the owner approved; removal rotates
  the key. Groups target messages. Administration is unlocked per connection with a
  kiosk-style **admin secret** kept in the app and exportable to other admins.
- **BLE or Wi-Fi in.** Sites without Wi-Fi are first-class: the phone connects over BLE to any
  fixture, which gateways to a mesh running in a radio-up, no-AP mode.
- **Radiolarians** (up to 6 P4 + C6 fixtures driving WLEDs over DDP): the C6 front end is the
  mesh node and gateway, the P4 the endpoint.
- **Later tracks:** UWB (a hardware revision: no current Splanc board has UWB), ranging plus
  IMU fusion, and a research track on CS-like phase ranging using the C6's undocumented raw I/Q
  capture.

## 2. What exists today

### 2.1 Splanc

| Piece                       | Where                                                                                                      | What matters for the mesh                                                                                                                            |
| --------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Heapless 802.11 + BLE stack | `firmware/netstack/` (`DESIGN.md`), driven from `firmware/player_app/netstack_transport.cpp`               | Our own MAC TX (`ns_mac_send`, direct submission), our own RX ring (`ns_mac_rx_install`, `ns_mac_recv`); every frame on the channel reaches the ring |
| RX vector                   | `firmware/netstack/src/mac.rs` `RX_VECTOR_HDR = 92`                                                        | 92 bytes of hardware RX metadata precede each frame. We strip them today. RSSI and the RX timestamp are in there, not yet decoded                    |
| TX pacing                   | `tx_pace_before/after` in `netstack_transport.cpp`                                                         | No TX completion signal; frames are paced on worst-case airtime (#358)                                                                               |
| Channel handling            | `g_chan`, `scan_latch_ap`, `ChannelHop` in `firmware/player_app/wifi_scan.h` (channels 1–13, 120 ms dwell) | Background sweeps leave the channel for ~1.6 s                                                                                                       |
| Wi-Fi policy                | `kModeAuto/Fixed/Manual/Offline` in `wifi_scan.h`; `docs/design/wifi-rejoin-policy.md`                     | No "radio up, not associated" mode yet                                                                                                               |
| Coexistence                 | `firmware/netstack/src/coex.rs`, `coex_timer_cb`                                                           | BLE and Wi-Fi share one antenna; the arbiter lends the radio to BLE                                                                                  |
| BLE host                    | `firmware/blehost/blehost.cpp` (our host over the vendor controller's HCI)                                 | The app's BLE link to the gateway                                                                                                                    |
| Protocol                    | `shared/protocol/proto/ledmapper.proto` `ClientMessage` / `ServerMessage`                                  | Arms 99+ are free for mesh arms                                                                                                                      |
| Dispatch seam               | `lm_ws_dispatch` (`netstack_transport.h`) → `lm_player_handle` (`player_ffi.h`)                            | The gateway and members dispatch relayed messages through the same seam                                                                              |
| Scheduled changes           | `firmware/player/src/apply_queue.rs` (`SCHED`: 8 frames in 512 B on the C6)                                | `apply_at_ms` on `SetUniforms`, `SetEffect`, `SetCrossfade`, `SetBrightness`                                                                         |
| Time discipline             | `agent/src/timesync.ts` (`TimeDiscipline`, `DriftEstimator`)                                               | Bridge-side drift fit. Its method ports to the mesh                                                                                                  |
| Multi-socket limit          | `web/src/net/connectionRegistry.ts`                                                                        | The player serves TLS from two slots. The app holds one device at a time                                                                             |
| P4 front end                | `firmware/player_app/frontend_link.cpp`, `docs/design/p4-c6-split.md`                                      | The C6 already forwards player messages to another processor and waits for a reply. A gateway is the same pattern over the air                       |
| Device trust                | `web/src/net/deviceTrust.ts`, `agent/src/trust.ts`                                                         | TOFU pin of each device's P-256 certificate, keyed by MAC                                                                                            |
| Room localization           | `docs/design/multi-fixture-localization.md`, `web/src/geom/multiFixture.ts`                                | One phone capture places several fixtures; enough for static installs                                                                                |
| Heap                        | `docs/design/ram-budget.md`                                                                                | 24 KB floor at the 2048-LED max config; every KB of mesh state counts                                                                                |

### 2.2 indoor_localization (the swarm)

Read at `master` `5a906e78` (2026-11-10). The repo is the owner's. Its root `LICENSE` is GPL-3.0
because `libs/dw3000` derives from CircuitDigest's driver; `swarm/` is the owner's own code.

| Piece                 | Where                                                                                                                                              | Status                                                                     |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Spec                  | `docs/swarm-network.md` (Layers, Mesh packets, Authentication, Live settings, Firmware update), `docs/swarm-wire.md` (budgets)                     | Design + implementation, deployed on 4 boards                              |
| Wire format           | `swarm/proto/swarm_wire.proto` (`swarm.v1`): `LinkFrame`, `MeshPacket`, `Summary`, `Manifest`, `FwRequest`, `FwData`, settings `Bundle`/`Override` | Protobuf; worst cases asserted at compile time (`swarm/net/src/budget.rs`) |
| Mesh layer            | `swarm/net` (`swarm_net`, 4.2 k lines, `no_std`, no alloc)                                                                                         | ~50 host tests incl. golden vectors                                        |
| Radio + TDMA + DS-TWR | `apps/common/radio.cpp`, `protocol.h`, `libs/dw3000` (C++)                                                                                         | 5 ms slots, 6 per 30 ms superframe                                         |
| Fusion                | `swarm/core` (ESKF: `predict`, `update_range`, `update_aoa`, …), `swarm/core` `coop`                                                               | Sim 6–14 cm RMSE; hardware walks still tuning range bias and NLOS          |
| Hardware              | Classic ESP32 + Qorvo DWM3000 (DW3110), SPI at 8 MHz; MPU-6050 + QMC5883L                                                                          | No C6 port, no AoA (single antenna)                                        |

The parts Splanc adopts:

- **`MeshPacket`** header (≤ 24 B): origin u16, id u16, dest (absent = broadcast), hop_limit,
  hop_start, flags (want-ack, is-ack), attempt, port, payload (≤ 88 B on UWB).
- **Managed flooding** (`swarm/net/src/mesh.rs` `MeshConfig`): hop limit 3; dedup on
  (origin, id, attempt) over a 64-entry ring; relay after 0–3 of the node's own slots, sooner
  the weaker the RSSI; cancel a pending relay on overhearing it; want-ack unicast retried 3 times,
  1 s apart.
- **Generations and catch-up** ("Live settings"): every swarm-wide change carries a host
  generation; `Summary.generation` in each node's beacon lets a late joiner fetch what it missed.
- **Page protocol** (`swarm/net/src/update.rs`): 4 KB pages, 96 B chunks, NACK bitmaps to the
  most advanced neighbour, overheard-request suppression, the canary rule.
- **Seam**: `Net::on_mesh(t_us, bytes, rssi, flash)`, `Net::on_my_slot()`, `Net::poll(t_us)`,
  `Net::next_tx(t_us, out, flash) -> Option<(FrameKind, usize)>`, `Net::send(dest, port,
payload, want_ack)`, plus `trait Flash`. There is no radio trait yet. Splanc adds one (§3.2).

What does **not** carry over as is:

- The swarm authenticates only settings (4-byte truncated HMAC-SHA256) and firmware (ECDSA).
  Reports and acks are unauthenticated. Lights in someone's home need every control frame
  authenticated (§7.5).
- Membership is implicit (a node's slot is its rank among heard ids). There is no join, no
  groups, no modes (§7).
- Time sync is coarse (superframes align to the lowest id's POLL). Splanc needs ms-level shared
  time for `apply_at` (§6).
- The 88 B payload is a UWB budget. The 802.11 backhaul allows more (§5.2).

## 3. Architecture

```text
 app / bridge ──BLE or wss──▶ gateway fixture
                                  │  MeshSend{targets, ClientMessage bytes}
                                  ▼
 ┌─────────────────────────── firmware/mesh (Splanc) ─────────────────────────────┐
 │ ports: control · reply · status · membership · scene · blobs · time            │
 │ membership: mesh id, key epoch, members, groups, open / closed / locked        │
 │ security envelope: AES-128-CCM, per-source replay window                       │
 ├──────────────────────────── swarm_net (ported) ─────────────────────────────────┤
 │ MeshPacket flood + dedup + TTL · want-ack · generations · page protocol         │
 ├──────────────────────────── Backhaul trait ─────────────────────────────────────┤
 │ wifi_p2p (netstack action frames) │ ip (UDP on the LAN, later) │ uwb (later)    │
 └─────────────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼  each member: lm_player_handle (same as wss/BLE)
```

### 3.1 Where the code lives: port the swarm into Splanc

The owner's call: **port `swarm/net` and `swarm/proto` into Splanc** as Splanc code. No shared
repo, no Bazel dependency on indoor_localization (which is public now).

- **Where**: `firmware/mesh/swarm/` (the ported `swarm_net` crate, kept close to upstream) and
  `firmware/mesh/` (the Splanc layer on top: backhauls, envelope, membership, ports). The proto
  goes to `shared/protocol/proto/swarm_wire.proto` next to `ledmapper.proto`, generated with
  Splanc's existing protobuf tooling (micropb on firmware; pbview is already in `oss/pbview`).
- **Provenance**: a header comment in each ported file and a `firmware/mesh/swarm/PROVENANCE.md`
  naming the source (`fughilli/indoor_localization`, `swarm/net` and `swarm/proto` at
  `5a906e7823f2d1c13af30dfa2a3b1b887616d0f1`) and listing what Splanc changed.
- **License**: `swarm/` is the owner's own code, so it comes in under Splanc's AGPL-3.0. (Even
  taken as GPL-3.0 from the repo root, GPL-3.0 §13 allows combining it with AGPL-3.0 code.) The
  GPL-derived DW3000 driver (`libs/dw3000`) is not ported; a UWB driver is a later, separate
  question (§11).
- **From then on Splanc owns its copy.** Fixes worth sharing go back to indoor_localization by
  hand; the golden vectors (`swarm/proto/testdata`) come along so the wire format stays checkable
  against the swarm's.

Changes made while porting (M1 unless noted):

1. A `Backhaul`-friendly entry point: `on_rx(t_us, frame, RxMeta)` and a slot tick that a
   backhaul without TDMA can drive from a timer.
2. A per-instance `MAX_PAYLOAD` (88 on UWB, larger on 802.11; §5.2) instead of one constant.
3. Blob kinds on the page protocol: `Summary`/`FwRequest`/`FwData` gain a `kind` (firmware,
   effect) and a content id, so the same `Updater` serves effects (§5.5). This can wait for M6.
4. A hook for the security envelope (§7.5) around `LinkFrame`.
5. Builds for riscv32imac (C6) and the P4 target, plus the host tests, in Splanc's CI. The crate
   is already `no_std`; its crypto backend switches to Splanc's (the netstack's AES, mbedTLS for
   SHA-256 and P-256).

### 3.2 The backhaul seam

```rust
/// One radio (or link) that carries mesh frames. Implementations own framing,
/// channel, rate and pacing; the mesh layer sees opaque frames.
pub trait Backhaul {
    /// Largest mesh frame (after the security envelope) this backhaul carries.
    fn mtu(&self) -> usize;
    /// Queue a frame. `dst = None` broadcasts. Never blocks; Busy is back-pressure.
    fn send(&mut self, frame: &[u8], dst: Option<NodeId>) -> Result<(), Busy>;
    /// Next received frame, with its metadata.
    fn recv(&mut self, buf: &mut [u8]) -> Option<RxMeta>;
    /// Whether this node may transmit now (TDMA slot on UWB, always on 802.11).
    fn may_send(&self, now_us: i64) -> bool;
}

pub struct RxMeta {
    pub len: usize,
    pub rssi_dbm: i8,
    pub rx_us: i64,          // hardware RX timestamp on this node's clock
    pub src_mac: [u8; 6],    // link address, for unicast replies
    pub backhaul: BackhaulId,
}
```

The mesh layer drives `swarm_net` from these calls. On UWB, `on_my_slot` comes from the TDMA
schedule. On 802.11 there is no TDMA: a 5 ms virtual slot timer drives the relay delays, and
the MAC's CSMA handles collisions.

A node with two backhauls relays across them. The dedup ring makes that safe: a packet seen on
both is relayed once per backhaul at most.

### 3.3 Addressing

- **Node id**: u16, derived from the factory MAC like the swarm's `IdFromMac()`. Collisions are
  possible (16 bits of a 48-bit MAC). The gateway detects them from the members' full MACs in
  `MeshStatus` (§5.4) and the app reassigns one id, persisted on the device.
- **Device id** in the app stays the MAC (`welcome` MAC, `deviceTrust.ts`). The app maps MAC to
  node id from status reports.
- **Targets**: one node, a list of up to 8 nodes, a group (u8), or all.

## 4. The 802.11 P2P backhaul in the netstack

### 4.1 Frames: Splanc's own framing

The owner's call: **no Espressif OUI and no ESP-NOW framing.** Splanc defines its own frame.

**Options considered:**

| Option                                                                   | Receive filtering in our netstack                                          | While associated to an AP                                                                                                                                                                              | Other stacks                                                                                                                              | Verdict                                             |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| **Vendor-specific Action frame (category 127) with a Splanc identifier** | One compare: FC `0xd0`, category 127, 3-byte id, before any STA processing | Fine: a non-BSS management frame with wildcard A3, the same class of frame as ESP-NOW, NAN or vendor discovery; the AP ignores it. Category 127 is not a robust action, so PMF (802.11w) doesn't apply | Unknown ids are parsed and dropped silently; sniffers show "vendor-specific action"                                                       | **Chosen**                                          |
| Data frames to a Splanc group address, LLC/SNAP + an EtherType           | Same cost                                                                  | ToDS = FromDS = 0 data frames outside an IBSS are non-standard; some APs and wireless IDSs flag them as rogue ad-hoc traffic                                                                           | Stacks filtering by BSSID drop them; the only EtherTypes free to use are the IEEE "local experimental" 0x88B5/0x88B6, which aren't unique | No                                                  |
| Public Action (category 4), vendor-specific subtype                      | Same cost                                                                  | Fine                                                                                                                                                                                                   | Fine                                                                                                                                      | No gain over category 127, and it also needs an OUI |

**The identifier.** A vendor-specific action frame starts with an OUI or a **CID** (an IEEE
Company ID: 24 bits with the local, "X", bit set, so a CID never collides with any assigned OUI).

- **Ship with a registered CID.** IEEE RA sells CIDs for a modest fee; registering one before the
  first install is the clean answer (an open question for the owner, §17).
- **Until then**, use a CID-format placeholder (`0x0A 0x5C 0x4D`, local bit set): it cannot
  collide with an OUI-assigned company. A later CID swap is one constant plus a version bump.

```text
802.11 header (24 B)
  FC 0xd0 0x00 (Action), duration, A1 = ff:ff:ff:ff:ff:ff or the peer's MAC,
  A2 = own MAC, A3 = ff:ff:ff:ff:ff:ff (no BSS), sequence (our SeqCounter)
Action body
  category 127 (vendor-specific)
  Splanc CID (3 B)
  frame kind (1 B): 0x01 = mesh v1          (room for other Splanc frame kinds later)
  mesh envelope (§5.1)
FCS (hardware)
```

- **TX**: `ns_mac_send(frame, len, queue)` already submits unprotected management frames (Auth,
  Assoc use it). Mesh frames go through the same path, after `tx_pace_before()`, so they never
  arm on top of a frame still on air. Broadcast frames get no ACK; unicast frames to a peer's
  MAC get the peer's hardware auto-ACK (`mac_own_bssid` keeps own-MAC valid).
- **RX**: `netstack_loop` drains `ns_mac_recv`. A mesh frame is identified before the BSSID
  gate: `rx[0] == 0xd0`, category 127, the Splanc CID, kind 0x01, then the envelope magic. It is
  handed to the mesh layer and never to the STA path.
- **RX metadata**: decode RSSI and the RX timestamp from the 92-byte RX vector
  (`RX_VECTOR_HDR`). The layout is undocumented. Spike M3a finds the fields on silicon by
  comparing against the vendor `wifi_pkt_rx_ctrl_t` in promiscuous mode.
- **Rate**: start with 1 Mb/s DSSS for broadcast (robust, longest range) and measure 6 Mb/s
  OFDM. A 250-byte frame is ~2.2 ms at 1 Mb/s and ~0.4 ms at 6 Mb/s. The pacing formula in
  `tx_pace_after` must use the rate actually sent.
- **Size**: 802.11 allows management frames up to 2304 B. We start with 250 B bodies (short
  airtime at 1 Mb/s, fits every buffer on the path) and raise it only if measurements say it
  pays (M14).

### 4.2 Channels

The mesh needs every member on one channel. Our netstack has one radio, tuned to one channel.

| Situation                                                                  | Mesh channel                                     | What members do                                                                                                                                                                               |
| -------------------------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **AP-anchored** (the usual home/venue case): the gateway is on the site AP | The AP's channel                                 | Associated members are there already. Members that can't reach the AP camp on the channel the mesh beacons announce                                                                           |
| **AP-less** (no Wi-Fi at the site; app over BLE)                           | Chosen at mesh creation (1, 6 or 11, least busy) | Every member camps on it, radio up, not associated                                                                                                                                            |
| **Several APs on different channels** (an ESS)                             | The anchor AP's channel                          | Members prefer a BSSID on the mesh channel when latching (`scan_latch_ap`). A member that must use another channel is an IP **island**: reachable by IP, bridged by the IP backhaul (Phase 2) |
| **The AP changes channel** (auto-channel)                                  | Follows the AP                                   | Associated members rejoin (existing rejoin path) and flood a `ChannelMove` first if they can. Members that lose mesh beacons for 10 s sweep (`ChannelHop`) for mesh beacons                   |

Rules that keep effects running (`effects-must-keep-running`): a member never reboots to find the
mesh, and a sweep happens in place, like today's background rescan.

New Wi-Fi mode, **Phase 1**: **`kModeMesh`**, radio up, MAC awake, no association, fixed
channel. Sites without Wi-Fi depend on it (the phone reaches the mesh over BLE). Offline mode
stays fully radio-off.

Background sweeps take a member off-channel for ~1.6 s (13 channels × 120 ms). While mesh
peers are healthy, a member skips scheduled sweeps unless the rejoin policy needs one. Before
leaving it floods `Away{ms}`; relays don't count it missing, and on return it catches up through
generations (§5.3).

### 4.3 Coexistence with BLE

The BLE gateway (the app on BLE, the fixture relaying to the mesh) is a Phase 1 path: sites
without Wi-Fi have no other way in. So the gateway's one radio must serve a BLE connection and
the mesh channel at once.

How the C6 shares the radio today (`coex_timer_cb` in `netstack_transport.cpp`): while a BLE
central is connected, the MAC sleeps for a **±7 ms window around each predicted connection
event** and is awake (Wi-Fi) the rest of the time. Without a phase lock it gives BLE 4 ms in
every 16 ms. The budget that follows:

| BLE connection interval                            | BLE window | Wi-Fi (mesh) share at the gateway |
| -------------------------------------------------- | ---------- | --------------------------------- |
| 15 ms (the minimum the code phase-locks, 12 units) | 14 ms      | ~7 % (unusable)                   |
| 30 ms                                              | 14 ms      | ~53 %                             |
| 50 ms                                              | 14 ms      | ~72 %                             |
| 100 ms                                             | 14 ms      | ~86 %                             |

Rules for the BLE gateway:

- **Ask for a ≥ 50 ms connection interval** once the GATT session is up and the mesh is active
  (an L2CAP connection parameter update from the peripheral). Phones usually accept it. Control
  traffic from the app is small, so 50 ms costs it nothing visible; `apply_at` hides the extra
  latency.
- **Narrow the window.** ±7 ms is generous for a connection event that carries one or two
  packets (~1–3 ms of air). Measure, then try ±3 ms: at 50 ms that is ~88 % for the mesh.
- **Send mesh frames outside the BLE window.** The gateway knows the window (the same phase
  math as `coex_timer_cb`), so it queues mesh TX until the Wi-Fi phase. A relay waiting 0–3
  virtual slots of 5 ms fits between windows.
- **Only the gateway pays.** Other members have no BLE connection and listen full time. A
  broadcast the gateway misses during a BLE window is relayed by others; replies to the gateway
  are unicast, so the sender's MAC retries them (M3a checks that retries work on our TX path).
- Mesh traffic is light (§10.3), so it does not starve BLE.

On P4 + C6 boards the C6 front end owns BLE (`docs/design/p4-c6-split.md` §2.1) and has no
render task, so the gateway logic runs at full priority there.

### 4.4 Spike before committing (M3a)

Two C6s on a rig, with and without an AP:

1. Broadcast a vendor action frame from one netstack image; receive it on the other while that
   one is associated to the rig AP. Confirms the RX path and that the AP association survives.
2. Unicast with hardware ACK: check retries on a missed ACK, and whether the MAC retries
   management frames at all on the direct-submission path.
3. Decode RSSI and the RX timestamp from the RX vector.
4. Measure delivery while the gateway holds a BLE connection.

Exit: frames flow both ways in both cases with ≥ 95 % delivery at one hop, and the RX
timestamp is found.

### 4.5 Antennas and metal enclosures

The radiolarians sit a few metres apart with clear line of sight, but **inside metal
enclosures**, with people walking between them. A closed metal box is close to a Faraday cage:
a module's PCB antenna inside it can lose tens of dB, and the loss depends on seams, holes and
where the antenna sits. The same antenna serves the mesh and the phone's BLE link.

**Hardware options:**

| Option                                                                                                                           | Notes                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Module with a PCB antenna (ESP32-C6-WROOM-1, -MINI-1) inside the enclosure                                                       | Only works if the antenna faces a non-metal window (a plastic panel or cap) with the module's keep-out respected |
| **Module with a u.FL/IPEX connector** (ESP32-C6-WROOM-1U, -MINI-1U) and a pigtail to a bulkhead RP-SMA, a 2.4 GHz dipole outside | Predictable; +2–3 dBi antenna, minus ~0.5–1 dB of cable and connector loss. The usual answer for metal boxes     |
| A flat external antenna stuck to the outside, fed through a grommet                                                              | Less visible; check its gain pattern against the fixture's orientation                                           |

Which C6 module the radiolarians' P4 + C6 boards carry (PCB antenna or connector) is an open
question (§17). A board with only a PCB antenna and no connector needs a window or a board
change.

**Link budget at 2.4 GHz** (rough; the measurement below replaces it):

| Term                                    | Value                                                                                                                           |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| C6 TX power, 802.11b 1 Mb/s             | up to +21 dBm (datasheet); +18 dBm assumed                                                                                      |
| Antennas                                | +2 dBi each side (external dipoles), −1 dB cable each side                                                                      |
| Free-space path loss                    | 40 dB at 1 m, 54 dB at 5 m, 60 dB at 10 m                                                                                       |
| People between fixtures                 | 3–20 dB per body (shadowing at 2.4 GHz); budget 20 dB                                                                           |
| RX sensitivity, 1 Mb/s                  | about −98 dBm for this class of chip (confirm in the WROOM-1/1U datasheet's RX sensitivity table); about −90 dBm at 6 Mb/s OFDM |
| Received at 5 m with a body in the way  | 18 + 2 − 1 − 54 − 20 + 2 − 1 ≈ **−54 dBm**: ~40 dB of margin at 6 Mb/s                                                          |
| Same, PCB antenna in a closed metal box | the enclosure's loss comes straight off that margin: it may be 20–40 dB, so it must be measured                                 |

The phone's BLE link has the same geometry plus the phone's lower TX power (often 0 to +10 dBm),
so it is the weaker of the two links.

**Measure it in the real enclosure: an early, explicit task for the radiolarians (R0, §15).**
It needs no mesh code: stock firmware on the radiolarian's C6 is enough.

1. Two radiolarians (or one plus a reference C6 with a known antenna) at 1, 3 and 5 m, enclosures
   closed. Log the received RSSI both ways: a Wi-Fi beacon or probe from one, scanned by the
   other (the vendor scan reports RSSI), and the phone's view of the BLE advertisement (any BLE
   scanner app). Repeat with the enclosure open and with an external antenna if one is fitted.
2. Ten minutes with people walking between them: log the minimum and the 1st percentile.
3. Rotate each fixture through 4 orientations (the antenna pattern through the enclosure).
4. Pass: the 1st-percentile RSSI with people moving is at least 20 dB above the 6 Mb/s
   sensitivity (≥ −70 dBm), on the mesh link and on the phone's BLE link. If not, fit external
   antennas before the install.

Once the mesh runs, `MeshStatus` reports each member's best-neighbour RSSI and the app shows
it, so an installer sees a weak link on site. HITL can't reproduce the enclosure; the bench
measurement is the check.

## 5. Protocol

### 5.1 Envelope

Every mesh frame, on every backhaul:

| Field          | Size                | Notes                                                       |
| -------------- | ------------------- | ----------------------------------------------------------- |
| magic `"SM"`   | 2                   | Splanc mesh                                                 |
| version        | 1                   | 1. Unknown versions are dropped and counted                 |
| mesh id        | 4                   | Random at creation                                          |
| key epoch      | 1                   | Which mesh key (§7.5)                                       |
| source node id | 2                   | For the nonce and the replay window                         |
| frame counter  | 4                   | Per source, strictly increasing (§7.5)                      |
| ciphertext     | n                   | A `swarm.v1` `LinkFrame` (as on UWB), AES-128-CCM encrypted |
| MIC            | 8 (802.11), 4 (UWB) | CCM tag over the header and the ciphertext                  |

Overhead: 14 B + MIC. Join requests and guest hellos (§7.3) use the same envelope with epoch 0
and no encryption, and carry only join payloads. The open-mode follow stream uses a reserved
epoch and the public open key (§7.4).

### 5.2 MTU per backhaul

| Backhaul                           | Frame        | Envelope | MeshPacket header | App payload                                   |
| ---------------------------------- | ------------ | -------- | ----------------- | --------------------------------------------- |
| UWB (DW3000, standard PHR)         | 125 B        | 18 B     | 24 B              | ~80 B (the swarm's 88 less the envelope; §11) |
| 802.11 Splanc action frame         | 250 B        | 22 B     | 24 B              | **200 B** (LinkFrame tags take a few bytes)   |
| 802.11, larger bodies (later, M14) | up to 1400 B | 22 B     | 24 B              | ~1300 B                                       |
| IP / UDP (later)                   | 1400 B       | 22 B     | 24 B              | ~1300 B                                       |

A mixed mesh uses the smallest MTU of the backhauls in use; the mesh beacon advertises it.
Messages larger than the payload are fragmented at the port layer (like the swarm's
`BundleFragment`), not in the mesh layer.

### 5.3 Ports

`PORT_APP = 16` and up are the application's (`swarm/net/src/net.rs`). Splanc's:

| Port  | Name         | Flood                                                   | Payload                                                             |
| ----- | ------------ | ------------------------------------------------------- | ------------------------------------------------------------------- |
| 16    | `CONTROL`    | to targets (broadcast with a target filter, or unicast) | `MeshControl{op_id, targets, apply_at?, inner ClientMessage bytes}` |
| 17    | `REPLY`      | unicast to the gateway                                  | `MeshReply{op_id, status, small ServerMessage bytes}`               |
| 18    | `STATUS`     | broadcast, every 10 s and on change                     | `MeshStatus` (§5.4)                                                 |
| 19    | `MEMBERSHIP` | broadcast or unicast                                    | join, admit, assign groups, mode, rekey (§7)                        |
| 20    | `SCENE`      | broadcast                                               | per-group scene generation and its state (§5.6)                     |
| 21    | `TIME_BASE`  | broadcast                                               | the show epoch in mesh time (§6.3)                                  |
| 22–31 | reserved     |                                                         |                                                                     |

Link frame types beyond the swarm's (new `FrameType` values in the ported proto):

| Type     | Purpose                                                                                                             |
| -------- | ------------------------------------------------------------------------------------------------------------------- |
| `BEACON` | Every second: mesh id, channel, MTU, the swarm `Summary` (generations, blob progress), member count, mesh time (§6) |
| `BLOB_*` | The page protocol for blobs (generalised `FW_REQUEST`/`FW_DATA`/`FW_MANIFEST`, §5.5)                                |

Time beacons are not flooded through the managed flood (its random relay delay ruins
timestamps). Each node re-stamps and re-broadcasts the time in its own `BEACON` (§6.2).

### 5.4 What the mesh carries

Relayed control (`CONTROL` port), an allow-list of `ClientMessage` arms dispatched on members
through `lm_player_handle`, exactly as if they arrived over wss:

| Arm                                                                      | Size (typical) | Notes                                                                    |
| ------------------------------------------------------------------------ | -------------- | ------------------------------------------------------------------------ |
| `set_uniforms`                                                           | 20–150 B       | `seq` and `commit` work as today; `apply_at_ms` keeps its meaning (§6.3) |
| `set_effect`, `set_crossfade`, `set_brightness`                          | 10–30 B        | with `apply_at_ms`                                                       |
| `blend_keypoints`, `save_keypoint`, `delete_keypoint`                    | 20–200 B       |                                                                          |
| `set_device_name`, `set_fixture_pose`, `set_color_correction`, `set_fps` | 10–80 B        |                                                                          |
| `get_status`, `get_effect_uniforms`, `list_effects`, `list_keypoints`    | small          | the reply must fit one `REPLY` (§8.2)                                    |

Not relayed: mapping capture, `set_texture` (video), `fx_debug_*`, stored-map download, TLS
info, Wi-Fi policy for another member (dangerous over the mesh; per-device only), and OTA in
Phase 1. A member answers anything else with `error{unsupported_over_mesh}`.

`MeshStatus` (one packet, ~60 B): node id, full MAC, firmware version, uptime, active effect
content id per deck, brightness, scene generation per group, free and min heap, fps, the
parent it hears best (id + RSSI), time-sync error estimate, Wi-Fi state (associated / mesh-only),
the hash of its certificate (8 B prefix; full pin on request).

### 5.5 Effect programs: content-addressed blobs

1. The app sends `SubmitEffect` to the gateway as today (BLE uses `UploadChunk` reassembly).
2. The gateway stores it (existing path), computes `blob_id = SHA-256(fxb)[0..8]` and starts
   serving it on the page protocol (`swarm/net/src/update.rs`, generalised with a blob kind).
   A 4 KiB effect is **one page** of up to 43 chunks of 96 B (on 802.11, fewer and larger
   chunks fit one 200 B payload).
3. A `MeshControl{set_effect by blob_id, apply_at}` tells targets what to load. A target that
   lacks the blob requests its missing chunks (NACK bitmap) from the most advanced neighbour.
   It writes chunks into the effect store under `effect_id` (littlefs), not into RAM.
4. Once complete and the SHA-256 matches, the member loads it. A scheduled `set_effect`
   applies at its `apply_at`; one that arrives before the blob is complete is held until it
   completes (a late member then starts late, as on wss today).

The canary rule (serve only what you validated) maps to: serve only blobs whose hash checks.

### 5.6 Scene state and late joiners

The swarm's "late joiners catch up" rule, applied to looks. Each group has a **scene**: active
effect blob id per deck, committed uniforms, brightness, crossfade, with a generation the
gateway increments on every committed change. Members put `(group, generation)` pairs in their
`BEACON` summary. A member that hears a newer generation for one of its groups asks that
neighbour for the scene (a few packets) and applies it. A fixture powered on after the show
started is showing the room's look within seconds.

Live (uncommitted) moves such as a fader drag are not part of the scene; the final committed
value is.

### 5.7 Versioning

- Envelope `version` for the frame format; `LinkFrame.ver` for the swarm wire format.
- Mesh features are advertised in `welcome.features` (`mesh`, `mesh_gateway`) and in
  `MeshStatus`. The gateway does not send a member an arm its firmware version lacks.
- A member with an unknown envelope version is reported in the gateway's list as
  "incompatible", so the app can offer an update over a direct connection.

## 6. Time sync and apply_at across the mesh

### 6.1 Budget

`docs/design/synced-show.md` targets < 10 ms between fixtures. Across the mesh, the shares are:

| Source           | Target         | How                                                             |
| ---------------- | -------------- | --------------------------------------------------------------- |
| Mesh time offset | < 1 ms per hop | beacons, hardware RX timestamps                                 |
| Drift            | absorbed       | per-neighbour linear fit (the `DriftEstimator` method, in Rust) |
| Delivery spread  | hidden         | `apply_at` with a lead larger than the worst delivery           |
| Render phase     | one frame      | as today (not solved here)                                      |

### 6.2 Mesh time

- **Root**: the gateway that holds the app's session, or, without one, the lowest node id that
  has been up longest (stable across app reconnects; the root changes only when it disappears).
- Every `BEACON` carries the sender's estimate of mesh time at its TX instant (`t_mesh`) and its
  hop distance from the root.
- A receiver takes the hardware RX timestamp (`RxMeta.rx_us`, §4.1) and records the pair
  `(rx_us, t_mesh)`. It fits offset and rate against its best parent (fewest hops, then
  strongest RSSI) over a 5 min window, rejecting outliers by residual, like `TimeDiscipline`.
- Error per hop: the TX instant is the time just before `ns_mac_send`, so the queue and pacing
  delay add jitter. Each beacon carries the previous beacon's measured TX-to-air correction if
  the hardware exposes a TX timestamp (M3a looks for one). Expect tens of µs per hop.
- **AP-anchored bonus**: members associated to one AP all hear its beacons, whose TSF is a
  common clock (reference-broadcast sync). The fit can use AP beacons as extra observations.

### 6.3 Mapping the show clock

1. The app syncs with the gateway as today (`TimeSyncPing`/`Pong`, `web/src/net/clocksync.ts`)
   and sends the gateway `SetTimeBase{epoch_ms}` in the gateway's clock.
2. The gateway converts it to mesh time and floods `TIME_BASE{epoch_mesh_us, generation}`.
3. Each member converts mesh time to its own `millis()` and applies the epoch through the same
   internal path as `SetTimeBase`. The bridge's slews (≤ 2 ms steps) become new `TIME_BASE`
   generations, flooded the same way.
4. `apply_at_ms` is ms on that epoch, the same number on every member. So a relayed
   `SetUniforms{apply_at_ms}` lands on the same frame everywhere, unchanged.

Lead: `apply_at` must be later than the slowest delivery. One hop with relay delay is under
25 ms (0–3 virtual slots of 5 ms plus airtime); three hops under ~75 ms; a missed broadcast
plus one want-ack retry adds 1 s. The default lead stays the bridge's 150 ms for one or two
hops, and 300 ms when the target set is three hops out. A member that receives a change after
its `apply_at` applies it on arrival and counts it late (reported in `MeshStatus`).

## 7. Membership, groups and security

### 7.1 Three membership modes

The mode is a per-mesh setting the owner changes from the app at any time.

| Mode                            | Who can join                                                              | What a member gets                                                                         | Protection                                                              |
| ------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| **Open** (free association)     | Any Splanc device that is set to follow open meshes. No secret            | **Guest**: follows the mesh (time, scenes, effects, live uniforms). Cannot manage anything | Owner-signed state, a public "open" key for framing, rate limits (§7.4) |
| **Closed** (authenticated join) | A device that proves it holds the **site secret** (given at provisioning) | **Member**: controllable from the gateway, holds the mesh key                              | AES-CCM under the mesh key (§7.5)                                       |
| **Locked**                      | Only devices the owner approved, by device key                            | **Member**, on the allow-list                                                              | Mesh key; removal rotates it (§7.6)                                     |

Open mode runs **alongside** the closed traffic: the owner's members are still members under
the mesh key, and the mesh additionally publishes a follow stream that guests can read. Turning
open mode off stops the follow stream; guests fall away and members are untouched.

### 7.2 State on each device

Persisted in littlefs (one small file, written only on membership changes):

- mesh id, name, channel, mode, membership generation;
- members only: the mesh key and epoch, the previous key during a rotation (§7.6), the
  pairwise key from its join, and in locked mode the allow-list (≤ 64 device-key hashes);
- its own groups (≤ 8 ids);
- the **mesh owner public key** (P-256, §7.4), learned at join;
- a device setting, `mesh_follow`: `off` (default for a device already in a mesh) or `open`
  (follow any open mesh it hears; the setting a home-built fixture ships with).

### 7.3 Joining

| Path                | Modes          | How                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **App-provisioned** | all            | The app talks to the device directly (BLE Improv at setup, or wss/BLE later) and sends `MeshJoin{mesh id, key, epoch, channel, mode, groups, owner public key}` over the trusted link. In locked mode this is also the approval: the app adds the device's key hash to the allow-list                                                                                                                                                                                               |
| **Site secret**     | closed         | A device provisioned with the site secret hears the mesh beacon and broadcasts `JoinRequest{node id, MAC, device public key, firmware, proof}`, with `proof = HMAC(site_secret, "join" ‖ beacon nonce ‖ node id)`. The beacon nonce stops replays of an old proof. Any member checks the proof, wraps the mesh key for the newcomer (ECDH between the two devices' P-256 keys, the per-device TLS keys of `docs/design/per-device-cert.md`, then HKDF and AES-CCM) and announces it |
| **Approval**        | closed, locked | A device without the secret (or any device, when locked) sends a `JoinRequest` without proof. Members forward it to the gateway; the app shows "New fixture nearby: admit?" One tap admits it (and, when locked, adds it to the allow-list)                                                                                                                                                                                                                                         |
| **Follow**          | open           | A device with `mesh_follow = open` hears an open mesh's beacon and starts following. It sends a `GuestHello{node id, device public key hash, firmware}` so the owner sees it in the app. No key exchange                                                                                                                                                                                                                                                                            |

The site secret is a 32-byte value the app creates per installation and hands to every device
it provisions. The C6 has an ECC accelerator; even in software one ECDH per join is a one-off.

### 7.4 Open mode: what guests can and cannot do

The point of open mode: someone shows up with a fixture they built, it joins and starts doing
the coordinated effects. A guest must be able to follow the show, and must never be able to run
it.

**Guests can:**

- take mesh time and the show epoch (`TIME_BASE`), so they land on the same frames;
- follow the open groups' scenes: the effect (fetching the blob), committed uniforms,
  brightness, crossfade;
- follow live uniform moves (fader streams) on open groups;
- relay follow-stream frames (more coverage for other guests);
- send `GuestHello` and a small status every 30 s.

**Guests cannot:** send `CONTROL` to anyone, change membership or groups, originate scenes,
effects or time, act as a gateway for management, or read member-to-member traffic (it is
under the mesh key, which guests don't have).

**How the follow stream is protected.** Guests hold no secret, so a symmetric key can't prove
anything to them. Two layers:

1. **Framing under a public open key**, `K_open = HKDF(mesh id, "open")`, using the same
   envelope (§5.1) with a reserved epoch. It gives integrity against corruption, not
   authenticity: anyone can compute it.
2. **Owner signatures on what lasts.** At mesh creation the app generates a mesh owner key pair
   (P-256; the private key stays in the app and the bridge, the public key goes to every member
   and is in the beacon). Scene commits, effect blob ids and `TIME_BASE` generations on the
   follow stream carry an ECDSA signature from the app; the gateway only relays them. A guest
   verifies them against the owner key it learned when it first followed (trust on first use,
   shown in the app as "following <mesh name>").
3. **Live moves are unsigned** (a signature per fader frame is too costly). Guests accept them
   only for the signed scene's effect, only within each uniform's manifest range, and only up to
   the rate limit. A forger can wiggle a guest's sliders between commits; the next signed commit
   puts it back. Members never act on open-key frames.

**Abuse limits:**

| Limit                                 | Value                                                                                                                                                             |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Guests tracked                        | 16, in their own tables (dedup, replay, status), so guests can't evict members' entries                                                                           |
| Per-guest traffic relayed or answered | ≤ 5 frames/s and ≤ 1 KB/s; excess is dropped and counted                                                                                                          |
| What members relay from guests        | only `GuestHello` and guest status, one hop                                                                                                                       |
| Blob size a guest will fetch          | ≤ `FX_MAX_BYTES` (4 KiB), only for a signed blob id                                                                                                               |
| Follow stream rate (owner side)       | live moves coalesced to ≤ 15 Hz on the open key                                                                                                                   |
| Getting out                           | the owner switches the mesh to closed or locked (below); guests stop following within one beacon interval and fall back to their own effect after 10 s of silence |

The open groups are chosen by the owner (default: the "all" scene). A guest follows a group
named in the beacon; it does not join groups itself.

### 7.5 Frame protection (members)

- **AES-128-CCM** over every member frame (§5.1), keyed by `HKDF(mesh key, epoch, "frame")`.
  The C6's AES accelerator already runs our software CCMP (`firmware/netstack/src/ccmp.rs`,
  which is CCM); the mesh reuses it. Cost is a few AES blocks per frame.
- **Nonce**: mesh id ‖ source id ‖ epoch ‖ counter (13 B). Unique while counters never repeat.
- **Counter**: `boot_count << 20 | n`. `boot_count` is persisted once per boot (no per-frame
  flash writes); `n` counts frames this boot. A member that would exceed 2^20 frames in one
  boot bumps `boot_count` (one write).
- **Replay**: per source, the highest counter seen plus a 32-frame bitmap window. 64 sources
  × 12 B ≈ 0.8 KB. A counter below the window is dropped.
- **MIC**: 8 B on 802.11; 4 B on UWB, where every byte counts. The swarm argues 4 B is enough
  for settings (2^31 tries on average, one per frame on air).
- This replaces the swarm's per-message HMAC for Splanc traffic. Offering it back to the swarm
  would let it authenticate its reports and acks too.

### 7.6 Mode transitions and key rotation

| Transition                         | What happens                                                                                                                                    | Existing members                                     | Existing guests                                                                    |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------- |
| open → closed                      | Follow stream stops; beacons stop advertising open                                                                                              | unchanged                                            | stop following; the app lists them as "former guests" with "Admit" (approval path) |
| closed → locked                    | The app shows the current members as the proposed allow-list; the owner confirms or unticks some. Then a **key rotation** to the listed members | listed: unchanged; unticked: dropped by the rotation | n/a                                                                                |
| locked → closed                    | Allow-list dropped; site-secret joins accepted again. No rotation needed                                                                        | unchanged                                            | n/a                                                                                |
| closed or locked → open            | The follow stream starts on the open groups                                                                                                     | unchanged                                            | new guests may follow                                                              |
| remove a member (closed or locked) | Key rotation without it (in closed mode the site secret also needs rotating, or the device can rejoin; the app says so)                         | others: new key                                      | n/a                                                                                |

Key rotation:

1. The gateway (on the app's command) picks a new key and epoch.
2. It sends `Rekey{epoch, key}` to every remaining member, unicast with want-ack, wrapped with
   that member's pairwise key.
3. Members accept both epochs for 60 s, then only the new one.
4. A member that was off during the rotation hears beacons in an epoch it lacks and sends a
   `RekeyRequest` under its pairwise key; any member holding the new key answers, if the
   requester is still a member (on the allow-list when locked).

### 7.7 Groups

- Group ids are u8 (0 = none). Names live in the app and the hub config; members store ids only.
- `AssignGroups{node, groups}` (membership port, authenticated) sets a member's groups,
  persisted.
- A `MeshControl` with a group target is broadcast; members not in the group drop it after
  decrypting the header. Scenes are per group (§5.6). In open mode the owner marks which groups
  guests follow.
- The hub/app may also target an ad-hoc list (≤ 8 ids) without creating a group.

### 7.8 How this relates to device trust

- The app still pins each device's certificate by MAC (`deviceTrust.ts`, `trust.ts`). A member
  reports its certificate hash in `MeshStatus` and `JoinRequest`; the app pins it at first sight
  and warns on a change, as for a direct connection. In locked mode the allow-list entry is that
  same device key.
- The app-to-gateway leg is TLS or BLE as today. Gateway-to-member traffic is protected by the
  mesh key, not TLS. A member trusts the gateway because the gateway holds the mesh key.
- The mesh owner key is new: it lives with the app's site data (backed up with it,
  `web/src/store/backup.ts`) and is copied to the bridge when one manages the site.

### 7.9 Administration: a kiosk-style admin secret

The radiolarians' mesh is **closed** (the site secret admits members), and administering it is
**unlocked with an admin secret, the same way kiosk mode works**. Kiosk mode today
(`docs/design/kiosk-mode.md`):

- firmware: `firmware/player_app/kiosk_ffi.rs` (`lm_kiosk_gate` classifies every arm before
  any handler; `kiosk_unlock{secret}` unlocks only the connection that sent it, until it drops;
  `secret_eq` is constant time; a wrong secret locks unlocking out for 2 s), persisted in
  `/lfs/kiosk.cfg`;
- app: `web/src/halloween/kioskSecrets.ts` generates a 128-bit secret per device, keeps it in
  `localStorage` (`splanc.kioskSecrets.v1`), and `web/src/ui/screens/kioskSection.ts` offers
  "Copy owner secret"; the key is in the app backup (`web/src/store/backupFormat.ts`).

The mesh admin secret reuses all of it, with one difference: it is **per mesh, not per device**.

|                          | Kiosk                                 | Mesh admin                                                                                             |
| ------------------------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Scope                    | one device                            | every member of one mesh                                                                               |
| Generated                | by the app, 128-bit                   | by the app at mesh creation, 128-bit                                                                   |
| Kept                     | `localStorage`, keyed by MAC          | `localStorage` (`splanc.meshAdmin.v1`), keyed by mesh id; in the app backup                            |
| Shared with other admins | "Copy owner secret"                   | "Export admin secret": copy, QR code, or a file; "Import" on the other phone or into the bridge config |
| On the device            | the secret, plain, on flash           | a verifier and the derived admin key (below)                                                           |
| Unlock                   | `kiosk_unlock{secret}` per connection | `mesh_unlock{secret}` per connection, same lockout, same per-connection scope                          |
| Recovery                 | USB console `kiosk off`               | USB console `mesh admin reset` (clears the admin key on that device; the app re-provisions it)         |

**What a locked connection can do.** A connection to any fixture that has not sent
`mesh_unlock` gets read-only mesh access (`GetMesh`, status) and whatever the fixture's own
policy allows locally. `MeshSend`, membership, groups, mode changes and mesh-wide scenes need
an unlocked connection. If kiosk mode is on too, its gate runs first, unchanged.

**How the gateway proves admin commands to members.** The admin secret never crosses the mesh.

- Each member stores `K_admin = HKDF(admin secret, mesh id, "admin")`, delivered with the mesh
  key at join (wrapped, §7.3) and on rotation.
- The gateway checks `mesh_unlock` against its stored verifier. For an unlocked connection it
  adds an **admin tag** to every admin-class packet it originates: `HMAC-SHA256(K_admin,
envelope header ‖ payload)`, truncated to 8 B, inside the encrypted payload.
- Members check two things: the envelope MIC under the mesh key (any member could have sent the
  frame) and, on admin-class ports (`CONTROL`, `MEMBERSHIP`, `SCENE`, `TIME_BASE`), the admin tag
  (an unlocked gateway sent it). A member that holds the site secret but not the admin secret
  can follow and relay but cannot command.

**Threat model, honestly.** Like the kiosk secret, `K_admin` sits on every fixture's flash, so
someone who takes a fixture apart can extract it. That matches kiosk mode ("keeps visitors out;
does not resist an attacker with the board"). The upgrade path, if needed later, is asymmetric:
derive a P-256 key pair from the admin secret in the app, give members only the public key, and
sign admin packets (the open-mode owner key of §7.4 is that key). Same secret, no
re-provisioning.

**Self-configuring installs.** The radiolarians are plugged in and left to form their mesh:

1. Before shipping (or once on site), each fixture is provisioned from the app: the site secret,
   the mesh id, the admin key, and Wi-Fi credentials if the venue has Wi-Fi.
2. At power-up a fixture with a site secret looks for its mesh: it listens for the mesh's
   beacons on the venue AP's channel if it has one, otherwise on a channel derived from the mesh
   id (one of 1, 6, 11). No beacon within 5 s: it starts beaconing itself. Members find each
   other, the first one up becomes the time root, and scenes catch up by generation.
3. Nobody has to connect for the show to run: the last committed scene is persisted on each
   fixture and resumes at boot.
4. An admin connects to any fixture (BLE or Wi-Fi, app or bridge), unlocks with the admin
   secret, and manages the whole mesh through it.

## 8. Gateway: one connection, the whole mesh

### 8.1 New protocol arms

In `ledmapper.proto` (arm numbers from 99 up; the exact numbers are chosen in the PR):

```protobuf
message MeshTargets {
  repeated uint32 nodes = 1;   // empty and group == 0: all members
  uint32 group = 2;
  bool include_gateway = 3;    // dispatch locally too (default true for "all")
}

// ClientMessage arm: relay one ClientMessage to mesh members.
message MeshSend {
  uint32 op_id = 1;
  MeshTargets targets = 2;
  bytes inner = 3;             // an encoded ClientMessage from the allow-list (§5.4)
  bool want_reply = 4;         // collect per-member replies
  uint32 timeout_ms = 5;       // default 2000
}

// ServerMessage arm: the aggregated result of a MeshSend.
message MeshResult {
  uint32 op_id = 1;
  repeated uint32 acked = 2;
  repeated uint32 missing = 3; // no reply before the timeout
  repeated MeshMemberReply replies = 4;  // when want_reply: small replies only
}

// Membership and listing: GetMesh / MeshState (members, groups, mode, pending joins),
// CreateMesh, JoinMesh (direct), AdmitDevice, SetGroups, SetMeshMode, RotateMeshKey.
```

### 8.2 Behaviour

- **Fan-out**: the gateway checks the inner arm against the allow-list, dispatches locally if
  targeted (`lm_ws_dispatch`), and floods one `MeshControl`. One broadcast reaches every target;
  per-member unicast is only for a short explicit node list.
- **Replies**: each target sends `MeshReply` unicast to the gateway with the `op_id` and a
  status (ok, error code, or a small reply under 150 B). Large replies (`welcome`, effect
  uniforms of a big effect) are not relayed; the app uses `MeshStatus` and targeted `get_*`
  calls whose replies fit.
- **Aggregation**: the gateway collects replies for `timeout_ms` and returns one `MeshResult`.
  For live control (`seq` set, a fader stream) it does not wait: it acks the app on its own
  dispatch, like `ControlAck`, and reports stragglers in `MeshStatus`.
- **Listing**: the gateway keeps the latest `MeshStatus` of each member (64 × ~60 B ≈ 4 KB; on a
  C6 gateway this is the largest new RAM cost, so it may keep a compact 24 B subset instead).
  `GetMesh` returns it.
- **Any fixture is a gateway**: whichever one the app or bridge is connected to (owner's
  decision). There is no gateway role in the mesh itself; a fixture with no session is just a
  member, and two admins on two fixtures are two gateways at once.
- **P4 + C6 boards**: the C6 front end runs the mesh layer and forwards control for its own P4
  through the existing link (`frontend_link.cpp`), so a P4 fixture is a normal mesh member.

## 9. App and bridge UX

### 9.1 App

- **Device list**: members appear under the gateway: "via Lamp A · 2 hops · −61 dBm · seen
  3 s ago". Members are controllable like directly connected devices for everything in the
  allow-list. Features that need a direct link (mapping, video, debugger, OTA in Phase 1) show
  "connect directly".
- **Admin**: "Unlock" with the stored admin secret (automatic when this phone has it), "Export
  admin secret" (copy, QR, file) and "Import admin secret", as in the kiosk section.
- **Mesh screen** (Devices ▸ Mesh): mesh name, channel, mode (Open / Closed / Locked), members
  (status, firmware, heap, fps, time-sync error, last seen), pending join requests (Admit /
  Ignore), groups (create, rename, assign by multi-select), "Rotate key", "Leave mesh".
- **Targets**: the live-control and effect screens gain a target picker: this device, a group,
  all. `web/src/net/liveControl.ts` sends `MeshSend` instead of per-device sockets.
- **Setup**: "Create mesh" on the first fixture; every fixture provisioned afterwards (Improv)
  is joined with the site secret and the mesh key automatically. "Join this fixture" for one
  already set up.
- **Room**: room localization (`#/room`) is unchanged and enough for static installs. Its
  `group_capture` arming can later go over the mesh (one connection arms all), replacing the
  per-fixture connect-arm-disconnect fallback.

### 9.2 Bridge and agent

The radiolarians may run live shows from the bridge, so the bridge path is **Phase 1** (M8b).

- **How the bridge reaches a gateway in Phase 1.** Over IP, as today: the bridge opens one wss
  session to any fixture on the venue network (found by mDNS like any player), sends
  `mesh_unlock` with the imported admin secret, and addresses the others with `MeshSend`. At a
  site with no venue Wi-Fi the Pi bridge can host the Wi-Fi network the fixtures join (the
  mesh then runs on its channel). A bridge over BLE (BlueZ is already on the image for Improv)
  is possible later.
- `agent/src/hub.ts` gains a mesh route: a player reachable "via gateway G" is addressed with
  `MeshSend`. Tools (`set_uniforms`, `crossfade_to`, `set_brightness`, …) keep their signatures;
  `list_players` shows members with their gateway and hop count.
- The time discipline (`timesync.ts`) disciplines the gateway only; mesh time carries the rest
  (§6). `lead_ms` defaults follow §6.3.
- The bridge keeps one socket to the gateway instead of one per fixture, which also removes
  the two-TLS-slot pressure per device.

## 10. The radiolarians deployment: sizing

### 10.1 What we know

| Fact                                                                                                                           | Source                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| **Up to 6 fixtures**                                                                                                           | owner                                                                        |
| Each fixture is an **ESP32-P4 with its C6 front end** (over SDIO), **driving WLED controllers over DDP**                       | owner; `docs/design/p4-c6-split.md`, `docs/design/p4-ethernet-ddp.md` (#478) |
| Fixture: a dodecahedron of 12 pentagonal panels, LEDs on concentric rings (105 per panel), **1260 LEDs**, three strings of 420 | `solver/src/scenario.rs` `dodecahedron_leds`, issue #479                     |
| Heavy and static after install; room localization places them                                                                  | owner                                                                        |
| **Not every site has Wi-Fi**: the app must reach the mesh over BLE as well as Wi-Fi                                            | owner                                                                        |

### 10.2 What that means for the design

- **The C6 front end is the mesh node; the P4 is the endpoint.** The C6 runs the netstack, the
  mesh layer, BLE and the gateway. Relayed control for its own fixture goes to the P4 through
  the link exactly like a wss or GATT frame (`frontend_link.cpp`, the §2.2 arm table of the
  split design). Effect blobs are assembled on the C6 (it has RAM to spare: the split design
  expects +60–100 KB of free heap) and forwarded to the P4 as one `SubmitEffect`.
- **Time base across the link.** The P4 owns the renderer clock and the time base; the C6 owns
  mesh time. The C6 keeps a C6↔P4 clock offset (a `time_sync_ping` round trip over SDIO every
  few seconds: sub-ms, symmetric) and converts `TIME_BASE` into the P4's clock before
  forwarding `SetTimeBase`. `apply_at_ms` is in time-base ms and needs no conversion.
- **BLE → mesh is Phase 1** (sites without Wi-Fi), so `kModeMesh` (radio up, no AP) is Phase 1
  too, and the BLE coex rules of §4.3 apply to whichever fixture the phone is connected to.
- **The WLEDs are on the P4's Ethernet** (owner). `p4-ethernet-ddp.md` drives WLED boards over
  the P4's own RMII PHY, with the P4 as a DHCP server for an "LED network". DDP never touches
  the C6's radio, so the C6 is free to sit on the mesh channel, and no fixture has to host a
  Wi-Fi network for its LEDs.
- **RF**: fixtures a few metres apart, line of sight, people moving between them, inside metal
  enclosures. The enclosure is the risk; §4.5 has the antenna options, the link budget and the
  measurement (R0) to do before the install.
- **OTA**: per-device OTA over Wi-Fi (the existing path) is enough for Phase 1. OTA over the mesh
  stays Phase 2.

### 10.3 Traffic for 6 fixtures

All fixtures in one venue are most likely one hop from each other; the hop limit stays 3.

| Traffic                                               | Size                | Rate                 | Airtime at 1 Mb/s (1 TX + ≤ 1 relay)  |
| ----------------------------------------------------- | ------------------- | -------------------- | ------------------------------------- |
| Beacons                                               | ~80 B frame         | 1 Hz × 6             | ~0.6 % of the channel                 |
| Status                                                | ~110 B frame        | every 10 s × 6       | < 0.1 %                               |
| Uniform fader stream                                  | ~150 B frame        | 30 Hz while dragging | ~1.5 ms × 2 × 30 ≈ 9 % while dragging |
| One effect push (4 KiB, `FX_MAX_BYTES` on the P4 too) | ~21 frames of 200 B | once                 | ~50 ms per hop; < 0.2 s to all        |
| Scene catch-up                                        | 2–6 packets         | per late joiner      | negligible                            |

At 6 Mb/s OFDM all of this costs about a fifth. Six fixtures leave the channel nearly idle; the
limit is the BLE gateway's share (§4.3), not the mesh.

### 10.4 RAM

On the radiolarians' C6 front ends the mesh's ~7 KB static is not a concern (no render task, no
LED buffers). On a standalone C6 player it still matters at large LED configs:

| Item                                                              | Bytes                      |
| ----------------------------------------------------------------- | -------------------------- |
| `swarm_net` state (dedup rings, TX queue, page state, neighbours) | ~4 K                       |
| Replay table (64 members + 16 guests)                             | ~1 K                       |
| Membership + groups                                               | ~0.5 K                     |
| Frame buffers (one RX, one TX at 250 B)                           | ~0.5 K                     |
| Gateway member table (compact)                                    | ~1.5 K                     |
| **Total**                                                         | **~7.5 K** static, no heap |

The PR that adds the crate reports `size -A` against main, as `docs/design/ram-budget.md` asks.

### 10.5 Minimum set that ships radiolarians

From the PR plan (§15):

- **R0 first**: the link budget measured in the real enclosure (§4.5), so antennas are settled
  before anything else depends on them;
- the ported mesh crate and the Splanc layer (M1, M2);
- the 802.11 backhaul with **mesh-only mode** and AP-anchored mode (M3a, M3);
- the **BLE gateway** with the coex rules of §4.3 (M3b);
- mesh time and `apply_at` across the mesh (M4);
- the gateway: uniforms, effect, crossfade, brightness, status (M5);
- the **front-end integration**: the C6 front end as mesh node, the P4 as endpoint (M5b);
- effect blobs and scene catch-up (M6);
- closed membership with self-configuration (site secret) and the kiosk-style **admin secret**,
  groups (M7);
- the app's member list, target picker, mesh screen, admin secret export/import (M8);
- the **bridge** reaching the mesh through one gateway (M8b);
- a HITL gate with P4 + C6 boards where the rigs have them, C6 players otherwise (M9a).

Firmware updates use per-device OTA over Wi-Fi. Locked mode, open mode (M7b), key rotation, the
IP backhaul and OTA over the mesh can follow the first install.

## 11. UWB backhaul (later)

- **Hardware**: no current Splanc board has UWB. The C6 boards, `splanc-mini` and the P4 + C6
  design (`docs/design/p4-c6-split.md`) have no UWB radio.
- **Board change**: add a Qorvo DWM3000 module (DW3110; what the swarm uses) or a QM33120 (two
  antennas, PDoA/AoA) on SPI, with IRQ, RST and WAKE: about 6 GPIOs. On the C6 that competes
  with LED outputs and the IMU pins (6, 7, 21 in `docs/design/sensor-core.md`), so it is a new
  board revision (the atopile boards under `hardware/`). On P4 + C6 boards the UWB part could
  hang off the P4 instead.
- **Rates**: 6.8 Mb/s PHY, 125 B frames. The swarm's TDMA gives each node ~2.5 ms of spare
  airtime per 30 ms superframe (~6 frames); its design estimate is ~19 KB/s per hop for pages,
  and it moved a 450 KB image to 3 nodes in ~3.5 min. Enough for control and effects, slow for
  Splanc's 2 MB images.
- **Software**: the swarm's TDMA, DS-TWR and radio loop are C++ in `apps/common/radio.cpp`; the
  driver is GPL-derived. A Splanc UWB backhaul implements `Backhaul` (§3.2) with TDMA driving
  `may_send`, and needs a C6 port of the driver.
- **What it adds**: ranging between every pair at ~20 Hz (§12), a backhaul on a different band
  from Wi-Fi and BLE (no coex), and µs-level time sync from DS-TWR timestamps.

## 12. Ranging and realtime localization (later)

Not needed for radiolarians: their fixtures are static and the phone-based room localization
(`docs/design/multi-fixture-localization.md`) places them.

When moving fixtures matter:

- **Ranges** come from UWB DS-TWR (§11), or from the research track (§13).
- **Fusion** is `swarm_core`'s ESKF (`predict`, `update_range`, `update_aoa`, `update_gravity`,
  the `coop` rules). `docs/design/sensor-core.md` §2.2 found the full filter costs ~50 % of a C6
  at 100 Hz. Options: run it at a lower rate, run it on the P4, or run the position part on the
  bridge with ranges and attitude streamed from the fixtures. The attitude part already has a
  seam (`firmware/sensor/src/fusion.rs` `AttitudeFilter`).
- **Room frame**: fused positions update `FixturePose` (`set_fixture_pose`) so `led.room`
  effects follow a moving fixture; the room solver's result seeds the filter and anchors its
  frame.
- **Ranges as constraints**: even for static installs, inter-fixture ranges can check or refine
  the room solve (`web/src/geom/multiFixture.ts`) and catch a fixture that was moved.

## 13. Ranging over the C6's own radio (research track)

An independent track. Nothing in the mesh depends on it.

### 13.1 Stock BLE ranging on the C6: no

- Espressif's ESP-IDF v6.1 feature table for the ESP32-C6 controller lists **Channel Sounding:
  unsupported** and **AoA/AoD: unsupported**. The host stacks list Channel Sounding as
  experimental, but a host can't sound without a controller that supports it.
- What remains with the stock controller is RSSI: meter-level error indoors, worse with
  multipath and bodies. Usable for "which fixture is nearest", not for placement.
- Our BLE host (`firmware/blehost`) runs over the vendor controller's HCI, so it inherits these
  limits. The #166 bench work (memory note "amd-rig SDR BLE PHY RE") showed how far from-source
  BLE radio control is: the RF TX key is set in a timer ISR we could not trace, and from-source
  BLE transmission never radiated. A self-built BLE CS through the BLE controller is a dead end
  for now.

### 13.2 Wi-Fi FTM: a hardware RTT that our stack bypasses

The C6 supports 802.11mc FTM (initiator as a station, responder as an AP), with an erratum:
revisions v0.0 and v0.1 cannot be initiators (WIFI-9686). FTM is typically 1–2 m indoors. It
runs inside the vendor Wi-Fi stack, which our netstack replaces, so using it means either
reverse-engineering its fine timestamps or a vendor-stack ranging mode. Noted as a fallback,
not planned.

### 13.3 What a self-built CS needs

Bluetooth Channel Sounding has two measurements:

- **Phase-based ranging (PBR)**: the initiator sends an unmodulated tone on channel k; the
  reflector measures its phase, then sends a tone back that the initiator measures. The product
  of the two measurements cancels both LO phases, if each device's LO stays phase-continuous
  between its RX and TX on that channel. Stepping over up to 72 channels at 1 MHz (~78 MHz
  span) gives the distance from the slope of phase against frequency: unambiguous to ~150 m,
  with decimetre-level precision in line of sight.
- **Round-trip time (RTT)**: needs TX/RX timestamps at ns resolution. The C6's RX timestamp is
  in µs (300 m per tick), so RTT is out unless the FTM timestamp hardware is reverse-engineered.

So the question is whether the C6 can (a) emit a clean tone at 1 MHz steps, (b) capture
coherent I/Q of a received tone, and (c) keep LO phase across a TX/RX turnaround.

### 13.4 What the public reverse-engineering work gives us

- **Raw I/Q capture (RX)**: ESP-SDR (ESPARGOS, GPL-3.0) found an undocumented "dump engine" in
  the modem, used by Espressif's factory RF test (`librftest.a`, `adctrig`). It copies baseband
  samples into SRAM: signed 10-bit I and Q plus the gain index in each 32-bit word, at 80, 40 or
  16 MS/s, up to 16,380 samples (~205 µs at 80 MS/s). **The C6 is supported**: capture memory
  `0x40840000`, SRAM owner register `0x60095004`, dump control `0x600a9004`, lane select
  `0x600a9014` (their `main/targets/esp32c6/chip.h`). Tuning off the Wi-Fi grid goes through
  `phy_set_freq(mhz, offset_khz)`, so 1 MHz steps are possible. It needs the vendor PHY
  initialised, which our netstack already does before it takes over the MAC.
- **Tone TX**: the C6 PHY library has the RF-test tone functions (ESP-SDR calls
  `ram_stop_tx_tone`; the start counterpart is in the same library), and `espdr-tx` steers the
  PHY test tone in frequency and amplitude on the ESP32-S3 to transmit voice. ESPARGOS states
  that arbitrary, even phase-coherent, transmission is possible but does not publish it. I did
  not find public raw I/Q **write** for the C6; the owner mentions such work exists, so it is
  an open question (§17) where it lives and whether it covers the C6. A CW tone is all PBR
  needs, so the test tone may be enough.
- **Our own MAC/PHY work**: the netstack's register map (`firmware/netstack/src/regs.rs`) and
  the #166 bench (a C6 cabled to a HackRF One through 40 dB, with a demod oracle) are where the
  spikes run.

### 13.5 The real risks, after the I/Q path

With RX phase available, the risk moves to:

1. **Phase continuity across a turnaround.** PBR needs the LO phase on channel k to be the same
   when a device receives and when it transmits. ESP-SDR re-calibrates on each new frequency
   and waits 3 ms after selecting an LO. If the TX/RX switch re-locks the PLL or re-runs a
   calibration, the phase is random per step and PBR fails.
2. **LO and sample-clock coherence between two C6s.** Separate 40 MHz crystals (±10–40 ppm)
   give up to ~100 kHz of carrier offset at 2.4 GHz. Each step must estimate it from the
   captured tone (a 205 µs capture gives ~5 kHz bins; phase-slope refinement goes below) and
   the two devices' steps must be scheduled to µs-level (mesh time gives tens of µs).
3. **Capture length and step rate.** 16,380 samples per capture is enough for a tone. But each
   capture hands a whole SRAM block to the dump engine: ESP-SDR's C6 build reserves
   `0x40820000`–`0x40860000` (256 KB). A standalone C6 player has nowhere near that free. So
   on a C6 player this only works in a dedicated ranging mode, or on **P4 + C6 boards** where
   the C6 front end does not render and has the RAM.
4. **Hop latency.** With a 3 ms LO settle, 72 steps × 2 turnarounds is ~0.5 s per pair. Fine
   for static fixtures, too slow for tracking.
5. **The radio is shared** with the Wi-Fi link and BLE. A ranging session takes the radio
   off-channel; it must be scheduled like a background sweep.

### 13.6 Spikes

All on the amd-rig `c6-sdr` unit (memory note "amd-rig SDR BLE PHY RE": HackRF + C6 over
40 dB, reserved via `pi/hitl/harness/hitl_client.py`). The HackRF cannot inject into the C6's
RX at useful levels on that bench (found in #166), so S1's RX tests use a second C6 or a rewired
path.

| Spike   | Question                                                | Method                                                                                                                                   | Exit                                                   |
| ------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| **S1a** | Does the dump engine work in our image?                 | Port ESP-SDR's C6 capture into a bench-only image (`firmware/rangespike`, not the player). Capture known tones                           | Clean I/Q, measured noise and gain behaviour           |
| **S1b** | Can the C6 emit a stepped CW tone?                      | PHY test tone at 2402–2480 MHz in 1 MHz steps, observed on the HackRF                                                                    | Tone within ±50 kHz of plan, step time measured        |
| **S1c** | Is the LO phase continuous across TX→RX on one channel? | C6 transmits a tone, switches to RX and captures the HackRF's CW (or a second C6's); HackRF measures the C6 tone phase before the switch | Phase repeatable within 10° over 100 turnarounds       |
| **S2**  | Two-C6 PBR on a few channels                            | Two C6s through a splitter and coax of known lengths (0.5 m, 3 m) as ground truth; 5–10 channels; HackRF watches both tones              | Distance difference recovered within 20 cm             |
| **S3**  | Accuracy over the air                                   | Full 40–72 steps in a room vs a tape measure, and vs a DWM3000 pair from indoor_localization if available                                | Error, precision, time per pair, RAM cost; go or no-go |

Stop at the first failed exit. If S1c fails, the fallback is Wi-Fi CSI two-way phase on the
home channel (the C6 reports HE-LTF CSI through the vendor path) or RSSI, both much coarser.

## 14. Testing

### 14.1 Host simulation (Rust, no radio)

A `meshsim` crate in `firmware/mesh`:

- N nodes running the real `swarm_net` and the Splanc layer, over simulated backhauls: an
  802.11 model (CSMA with collisions, per-link loss and RSSI from a topology, 1 or 6 Mb/s
  airtime, BLE coex outages) and later a TDMA UWB model.
- Each node has a clock with ppm drift and an RX timestamp jitter model.
- Scenarios, as `rust_test`s:
  - flood delivery and latency on line, star and grid topologies up to 64 nodes and 3 hops;
  - `apply_at` skew: the frame at which each node applies a relayed change, < 2 ms across
    3 hops over a simulated hour;
  - effect blob to 32 nodes with 10 % loss; resume after a node restarts mid-transfer;
  - late joiner catches the scene; partition and heal;
  - closed join with and without the site secret; locked rejects unapproved devices; removal
    plus rekey; open guests follow signed scenes and cannot send control; a member
    offline during the rekey recovers;
  - replay and forgery attempts are dropped and counted.
- Golden vectors for the envelope, plus the swarm's own vectors ported with the code.

### 14.2 HITL

Rigs carry several C6s each (`pi/hitl`, multi-DUT reservations; see the memory notes on rig
USB power and shared-DUT gotchas).

| Test                 | DUTs                  | Checks                                                                                                                                                                                                         |
| -------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mesh_smoke`         | 2                     | M3a's exit criteria; associated and mesh-only                                                                                                                                                                  |
| `mesh_gateway`       | 4                     | App-side client (harness) on one DUT's wss: `MeshSend` set_uniforms to all, `MeshResult` acks all; group targeting; status listing                                                                             |
| `mesh_effect`        | 4                     | Push a `.fxb`, every member runs it (serial log + `get_status` via the mesh)                                                                                                                                   |
| `mesh_apply_at_skew` | 2 analyzer-tapped + 2 | Extends `pi/hitl/harness/hitl_time_base_skew.py`: tapped DUTs reached only via the mesh; p99 skew < 10 ms + one frame                                                                                          |
| `mesh_ble_gateway`   | 3                     | Same as `mesh_gateway` with the gateway on BLE (coex)                                                                                                                                                          |
| `mesh_join_admin`    | 4                     | Self-configured closed join; a locked connection can't send `MeshSend`; `mesh_unlock` then control; a member without the admin key can't command; wrong-secret lockout. Locked mode and open guests in Phase 2 |
| `mesh_multihop`      | 4                     | Forced topology (a test-only neighbour deny-list in firmware), 3 hops                                                                                                                                          |
| `mesh_soak`          | 4                     | 2 h, fader streams every 5 min, heap minimum and render fps unchanged                                                                                                                                          |

Every failure attaches each DUT's serial log (the HITL logging standard). The shared rig AP
(flock #228) means associated tests compete for airtime; mesh-only tests do not need the AP.

### 14.3 Metrics

Reported by members in `MeshStatus` and collected by HITL: delivery ratio per port, latency per
hop (p50, p99), late `apply_at` count, time-sync error estimate, relay count per packet, airtime
share, free and minimum heap, render fps.

## 15. Staged PR plan

Phase 1 is the radiolarians critical path. Each PR is small and reviewable; spikes gate the
ones that depend on unknown hardware behaviour.

### Phase 1: application backhaul (ships radiolarians)

| PR      | Content                                                                                                                                                                                                                      | Gate                            |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| **R0**  | Link budget in the real radiolarian enclosure (§4.5): RSSI both ways at 1/3/5 m, people walking between, 4 orientations, BLE to a phone; decide on external antennas. No code                                                | ≥ −70 dBm at the 1st percentile |
| **M0**  | This design                                                                                                                                                                                                                  | owner review                    |
| **M1**  | Port `swarm/net` + `swarm/proto` into `firmware/mesh/swarm/` with provenance (§3.1); the backhaul entry point, per-instance MTU, Splanc crypto backend; C6 + P4 + host builds and the swarm's tests and golden vectors in CI | ported tests pass               |
| **M2**  | `firmware/mesh`: `Backhaul` trait, envelope (AES-CCM via `ccmp.rs`, replay window), membership state, ports, `meshsim` with the first scenarios                                                                              | host tests only                 |
| **M3a** | Spike: vendor action frames TX/RX between two C6s (associated and not), RX vector RSSI + timestamp, unicast retries, BLE coex loss                                                                                           | §4.4 exit                       |
| **M3**  | `wifi_p2p` backhaul in the netstack transport; `kModeMesh` (radio up, no AP); channel rules (§4.2); mesh beacons; `mesh_smoke` HITL                                                                                          | M3a passed                      |
| **M3b** | BLE gateway: connection-interval request, narrowed coex window, mesh TX outside the BLE window (§4.3); `mesh_ble_gateway` HITL                                                                                               | Wi-Fi share ≥ 70 % with BLE up  |
| **M4**  | Mesh time (beacon fit) + `TIME_BASE` mapped to the existing time base; meshsim skew test; `mesh_apply_at_skew` HITL                                                                                                          | skew < 10 ms                    |
| **M5**  | Protocol arms (`MeshSend`, `MeshResult`, `GetMesh`/`MeshState`), gateway fan-out + aggregation, member dispatch allow-list, `MeshStatus`; `mesh_gateway` HITL                                                                |                                 |
| **M5b** | P4 + C6: the mesh on the C6 front end, relayed control forwarded over the link, C6↔P4 clock offset for `TIME_BASE`, effect blobs handed to the P4                                                                           | P4 + C6 bench run               |
| **M6**  | Blob kind on the page protocol + effect distribution + scenes and catch-up; `mesh_effect` HITL                                                                                                                               |                                 |
| **M7**  | Membership: closed mode (site secret, self-configuring formation, approval joins), the kiosk-style admin secret (`mesh_unlock`, admin tags, §7.9), groups; `mesh_join_admin` HITL                                            |                                 |
| **M8**  | App: member list via gateway, target picker in live control and effects, mesh screen, admin secret export/import (copy, QR, file, backup)                                                                                    | web unit tests + manual run     |
| **M8b** | Bridge: hub mesh route (`hub.ts`) through one gateway, admin secret in the bridge config, `list_players` via gateways                                                                                                        | agent tests + bench run         |
| **M9a** | HITL gate: the multi-DUT suite in CI (`mesh_*`)                                                                                                                                                                              |                                 |

### Phase 2: open mode, hardening and reach

| PR  | Content                                                                                                                                                                                      |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M7b | Open mode: owner key + signed scenes/blobs/time, the follow stream under the open key, guest tables and rate limits, `mesh_follow` device setting, guests in the app; `mesh_open_guest` HITL |
| M7c | Locked mode (allow-list by device key), closed ↔ locked transitions, key rotation on removal                                                                                                |
| M9b | Site-secret rotation; the asymmetric admin key upgrade (§7.9) if wanted                                                                                                                      |
| M10 | IP backhaul (UDP on the LAN) to bridge islands on other APs                                                                                                                                  |
| M12 | `group_capture` arming over the mesh (one connection arms the room)                                                                                                                          |
| M13 | OTA over the mesh (page protocol with the firmware kind; Splanc's manifest, `docs/design/ota.md`)                                                                                            |
| M14 | Larger 802.11 bodies (up to ~1400 B) if measurements justify them                                                                                                                            |

### Phase 3 and research (deferred, independent)

| Track | Content                                                                             |
| ----- | ----------------------------------------------------------------------------------- |
| U1    | UWB board revision (DWM3000 or QM33120) — needs the owner's hardware decision       |
| U2    | UWB backhaul (TDMA, DS-TWR) behind `Backhaul`; C6 driver port                       |
| L1    | Ranges into the room solver as constraints                                          |
| L2    | IMU + range fusion (`swarm_core`), placement of the filter (C6 rate, P4, or bridge) |
| R1–R3 | §13.6 spikes S1a–S3 on the amd-rig                                                  |

## 16. Risks

| Risk                                                                                                             | Impact                         | Mitigation                                                                          |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------- |
| Action-frame TX on our direct-submission path behaves differently from Auth/Assoc (rate, retries, no completion) | M3 slips                       | M3a spike first; pacing already exists                                              |
| RX vector timestamp not found or too coarse                                                                      | time sync worse                | fall back to loop-time stamping (jitter of the loop period) plus AP beacon TSF      |
| Mesh channel conflicts with multi-AP sites                                                                       | islands                        | prefer same-channel BSSIDs; IP backhaul (M10)                                       |
| Background sweeps make members deaf                                                                              | missed changes                 | skip sweeps while the mesh is healthy; `Away`; generation catch-up                  |
| BLE coex loses broadcasts at the gateway                                                                         | slower fan-out                 | relays and retries; HITL measures; a coex priority bump for mesh TX if needed       |
| C6 RAM at large LED configs                                                                                      | can't fit                      | ~7 KB static budget, measured in M2/M3; compact gateway table                       |
| The ported swarm code diverges from indoor_localization                                                          | fixes don't flow both ways     | provenance note; ported golden vectors; port fixes back by hand                     |
| Node-id collisions (u16 from MAC)                                                                                | misrouting                     | detect via full MAC in status; app reassigns                                        |
| Site secret leaks (a lost fixture holds it)                                                                      | closed mesh joinable           | lock the mesh after install; rotate the site secret from the app                    |
| Open mode abused (forged live moves, guest floods)                                                               | guests misbehave; airtime      | members ignore open-key frames; signed commits; guest rate limits; switch to closed |
| BLE gateway starves the mesh at short connection intervals                                                       | slow fan-out on BLE-only sites | ≥ 50 ms interval, narrowed coex window, TX outside it (§4.3)                        |
| Metal enclosures attenuate the mesh and the phone\'s BLE link                                                    | lost frames, BLE drops         | R0 measurement first; u.FL module + external antenna or a non-metal window (§4.5)   |
| The placeholder CID collides with a future CID assignee                                                          | foreign frames parsed as ours  | envelope magic + mesh id + MIC reject them; register a CID (Q4)                     |
| The research track fails (no phase continuity)                                                                   | no self-built ranging          | independent of the mesh; UWB remains the ranging path                               |

## 17. Open questions for the owner

Answered so far: fixture count (up to 6), board (P4 + C6, WLEDs on the P4's Ethernet over DDP),
BLE and Wi-Fi in, spacing and enclosures, self-configuration, OTA (per device for now), the
membership modes and the closed-plus-admin-secret model, any fixture as gateway, porting the
swarm code, and Splanc's own framing.

**Radiolarians:**

- **Q1.** Which C6 module is on their P4 + C6 boards: PCB antenna or u.FL/IPEX connector? Can
  the enclosures take a bulkhead antenna or a non-metal window? (R0 measures the rest.)
- **Q2.** Who provisions the site secret, mesh id and admin key: Splanc before shipping, or the
  customer from the app on site?
- **Q3.** Does the venue have Wi-Fi for the bridge, or should the Pi bridge host the network the
  fixtures join?

**Framing:**

- **Q4.** Register an IEEE CID for the Splanc frame identifier before the first install (a
  modest fee), or ship with the CID-format placeholder for now?

**Security and admission:**

- **Q5.** Is the kiosk-level threat model for the admin key acceptable (it sits on each
  fixture's flash, like the kiosk secret), with the asymmetric upgrade later if needed?
- **Q6.** Open mode as designed: guests follow signed scenes and effects, live moves are
  unsigned but bounded, guests can never manage. Is accepting unsigned live moves on guests
  acceptable, or should guests only follow signed commits (coarser, but unforgeable)?
- **Q7.** Should `mesh_follow = open` be the default for unprovisioned or home-built fixtures,
  so the "show up and join" magic needs no setup?

**UWB and ranging (later tracks):**

- **Q8.** UWB hardware: DWM3000 (what the swarm has, single antenna) or QM33120 (angle of
  arrival)? On the C6 board, the P4 + C6 board, or both?
- **Q9.** Which public raw I/Q **TX** work did you mean for the C6? I found raw I/Q RX (ESP-SDR,
  which supports the C6) and PHY test-tone TX (shown on the S3), but no public C6 I/Q write.
- **Q10.** Is the self-built ranging meant for P4 + C6 boards only? The dump engine needs a whole
  SRAM block, which a C6 player rendering effects does not have (a C6 front end may).

## 18. Sources

Splanc (files read): `firmware/netstack/DESIGN.md`, `firmware/netstack/src/{mac,coex,ccmp}.rs`,
`firmware/player_app/netstack_transport.cpp` (`tx_l2`, `tx_pace_*`, `netstack_loop`,
`scan_latch_ap`, `bgscan_*`), `firmware/player_app/wifi_scan.h`, `firmware/player_app/ffi.rs`
(`FX_MAX_BYTES`), `firmware/player_app/frontend_link.cpp`, `firmware/blehost/blehost.cpp`,
`shared/protocol/proto/ledmapper.proto`, `docs/design/{synced-show,ota,sensor-core,
multi-fixture-localization,p4-c6-split,ram-budget,hue-code-v2}.md`,
`web/src/net/{connectionRegistry,deviceTrust}.ts`, `agent/src/trust.ts`,
`solver/src/{scenario,regression_tests}.rs`, issue #479, `MODULE.bazel` (lighthouse, embedded).

indoor_localization @ `5a906e78`: `docs/swarm-network.md`, `docs/swarm-wire.md`,
`docs/uwb-landmarks.md`, `docs/uwb-sync-experiment.md`, `swarm/proto/swarm_wire.proto`,
`swarm/net/src/{mesh,net,update}.rs`, `swarm/net/BUILD.bazel`, `apps/common/{radio.cpp,
protocol.h,pins.h}`, `LICENSE`.

External:

- Espressif, ESP-IDF v6.1 ESP32-C6 "Major Feature Support Status" (controller: Channel
  Sounding and AoA/AoD unsupported):
  <https://docs.espressif.com/projects/esp-idf/en/release-v6.1/esp32c6/api-guides/ble/ble-feature-support-status.html>
- Espressif, ESP-IDF v6.1 ESP32-C6 "ESP Host Major Feature Support Status" (Channel Sounding
  experimental on the hosts):
  <https://docs.espressif.com/projects/esp-idf/en/release-v6.1/esp32c6/api-guides/ble/host-feature-support-status.html>
- Espressif, ESP32-C6 erratum WIFI-9686 (FTM initiator):
  <https://docs.espressif.com/projects/esp-chip-errata/en/latest/esp32c6/03-errata-description/esp32c6/wifi-ftm.html>
- Espressif, ESP32-C6 Wi-Fi security and roaming (FTM roles):
  <https://docs.espressif.com/projects/esp-idf/en/v6.0/esp32c6/api-guides/wifi-driver/security-and-roaming.html>
- ESPARGOS, ESP-SDR (raw I/Q capture, per-chip registers, C6 support):
  <https://github.com/ESPARGOS/esp-sdr>, <https://espargos.net/espsdr/>
- RTL-SDR.com, "Various Projects Independently Find Hidden SDR Capabilities in ESP32
  Microcontrollers" (espdr-tx test-tone TX on the S3):
  <https://www.rtl-sdr.com/various-projects-independently-find-hidden-sdr-capabilities-in-esp32-microcontrollers/>
- ESP32 open MAC project: <https://esp32-open-mac.be/posts/0005-the-road-ahead/>
- FTM accuracy survey (arXiv 2509.03901): <https://arxiv.org/pdf/2509.03901>
