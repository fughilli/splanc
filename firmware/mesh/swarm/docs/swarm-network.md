# Swarm network: messages, live settings, firmware update

> Copied unchanged from fughilli/indoor_localization `docs/swarm-network.md` at `5a906e78` as the
> spec of the ported `swarm_net` (see `../PROVENANCE.md`). Paths here are upstream's; the
> Splanc mesh is `docs/design/mesh.md`.

Status: design, implementation in progress (session 6).

Tuning the fusion stack on hardware means changing parameters often and
firmware now and then, on nodes spread around a room or walking around in
someone's hand. Both go in through whichever node is on a computer and
travel over UWB to the rest:

- a **mesh message layer** (unicast + broadcast, Meshtastic-style managed
  flooding) carries small messages anywhere in the swarm;
- **live settings** ride on it: every tunable has a name, a default and a
  persisted value, and can be set for one device or the whole swarm without
  reflashing;
- **firmware update** uses it for the signed manifest, and a separate
  request-driven page protocol for the image itself.

## Layers

```text
 TDMA slot (5 ms, one per node)
 ├─ DS-TWR ranging exchange (POLL carries advert + summaries)   ~2.5 ms
 └─ rest of the slot: queued frames, highest priority first     ~2.5 ms
      1. mesh packets   (originated here or being relayed)
      2. firmware pages (FW_DATA, serving neighbours' requests)
```

A node transmits only in its own slot, so frames never collide; what's
scarce is each node's ~2.5 ms of spare airtime per 30 ms superframe (about
6 frames of 127 bytes). Flooding has to be economical.

### Mesh packets

A mesh packet is a `MeshPacket` protobuf message (`swarm/proto/swarm_wire.proto`; byte
budgets in [swarm-wire.md](swarm-wire.md)):

| Field                |                                                        |
| -------------------- | ------------------------------------------------------ |
| origin               | node that created the packet                           |
| id                   | per-origin counter; (origin, id) identifies the packet |
| dest                 | node id; absent for broadcast                          |
| hop_limit, hop_start | remaining and initial hop limit                        |
| flags                | bit 0 want-ack, bit 1 is-ack                           |
| attempt              | retry number of the origin's transmission              |
| port                 | which service: settings, report, ack, app …            |
| payload              | ≤ 88 bytes                                             |

**Managed flooding**, as in Meshtastic:

- Every node remembers the (origin, id) of recent packets and drops
  duplicates.
- A node relays a packet it hasn't seen before, if the hop limit allows,
  after a delay drawn from a window that's _shorter the weaker the signal it
  arrived on_. Nodes far from the sender (weak signal) extend coverage the
  most, so they go first.
- A node that overhears someone else relay the same packet while its own
  relay is still waiting cancels it. In a room where everyone hears
  everyone, a broadcast costs one transmission plus at most a relay or two,
  not one per node.
- With TDMA the "delay" is counted in the node's own slots: a relay waits
  0–3 of its slots, scaled by signal strength.

**Unicast** packets flood the same way, so they reach a node out of direct
range. The destination doesn't relay its own packets. With want-ack, the
destination answers with a small ack packet (flooded back). The origin tries
up to 3 times, 1 s apart, until it hears the ack.

Each retry carries an attempt number, and relays check for duplicates by
(origin, id, attempt). Without it, a relay that saw the first try would drop
the retry as a duplicate, and a copy lost two hops out could never be
replaced. The destination delivers each (origin, id) only once, and acks
every attempt, since a retry means its earlier ack was lost.

### Authentication

Settings and firmware change what a node does, so the swarm only accepts
them from the owner.

- **Settings** (frequent, small): a 4-byte tag, the first 4 bytes of
  HMAC-SHA256 over a domain byte and the message, with a 32-byte key shared
  by the swarm. A forger gets one guess per frame it transmits, about 2^31
  frames on average, and an increasing sequence number in each command stops
  replays. The key is provisioned to each node over USB and stored in its
  flash. It is never compiled into firmware, because images cross the air in
  the clear. A node without a key accepts no remote settings; the USB path
  always works, since physical access is trusted.
- **Firmware** (rare, high stakes): the manifest carries an ECDSA P-256
  signature. The public key is compiled in; the private key stays on the
  host. A node taken out of the room can't be used to sign firmware.
- **Reports and acks** are not authenticated.

**Crypto implementation.** `swarm/net/src/crypto.rs` is the one interface
(streaming SHA-256, HMAC-SHA256, P-256 verify). On the device it calls a
small C shim over ESP-IDF's MbedTLS, which uses the ESP32's SHA accelerator;
host tests and tools use RustCrypto. The firmware checks the RFC 4231 HMAC
vector and a P-256 known-answer signature at boot, so the two backends can't
drift silently.

Follow-up: build MbedTLS from source and use it everywhere, including the
host tests, with ESP-IDF relinked against it. The prebuilt arduino-esp32
libraries are compiled against IDF's MbedTLS fork. Its struct layouts depend
on IDF's mbedtls config, and its hardware acceleration lives in IDF's
replacement files. So this needs a config that matches IDF's and a port of
those files. The crypto interface above is where that swap goes.

## Live settings

Every tunable is a **setting** with a stable 16-bit id, a name, a type
(f32 / i32 / bool / vec3), a default, and a valid range. The registry lives
in the Rust node runtime next to the code that uses it (`NodeConfig`,
`CoopConfig`, estimator `Params`, plus per-device calibration: antenna
delay, magnetometer calibration, surveyed position). Applying a change takes
effect on the next update; nothing is restarted.

Each node resolves a setting from three layers:

1. a **device override**, set by a unicast command, for this node only;
2. the **swarm value**, set by a broadcast command, the same on every node;
3. the **compiled default**.

Clearing an override falls back to the swarm value. Both layers are stored
in LittleFS and loaded at boot.

**Late joiners catch up.** Every swarm-layer change carries the host's
increasing generation number. Each node puts its swarm-layer generation in
its POLL frames. A node that hears a neighbour with a newer generation asks
that neighbour for its swarm layer and copies it. This works the same way as
fetching firmware pages, but is a few packets at most. A node that was off
during a broadcast is therefore up to date within a second of rejoining.

From the host, `swarm_ctl.py` (and the swarm view) can list the registry
with current values, set or clear a setting on one node or all of them, and
read any node's settings back with a unicast request. The JSON names are the
registry names, such as `coop.mean_only_range_damping` and `range_sigma`.

## Firmware update

A new image enters the swarm through any one node on a computer, spreads
over UWB to every other node, and each node verifies and installs it itself.

### Goals

- **Any node is an entry point.** The node on USB takes the signed image
  from the host and becomes its first source.
- **Spread, don't unicast.** Every node that has part of the image serves it
  to neighbours, so nodes out of range of the entry node still get it, and
  the entry node isn't a bottleneck.
- **Nothing unsigned runs.** A node accepts chunks only for a manifest that
  passes an ECDSA P-256 signature check with the public key compiled into its
  firmware, and installs only an image whose SHA-256 matches that manifest.
- **A bad image can't strand a node.** A small, rarely changed _loader_ owns
  the boot, copies a verified staged image into the main bank, and if the
  main firmware fails to come up healthy, stays in charge: it joins the
  swarm by itself and accepts a replacement image over the air.
- **Ranging keeps working during an update**, at reduced rate.

### Flash layout (4 MB)

| Partition | Type          | Offset   | Size    | Contents                                            |
| --------- | ------------- | -------- | ------- | --------------------------------------------------- |
| nvs       | data/nvs      | 0x9000   | 20 KB   | (IDF internals)                                     |
| otadata   | data/ota      | 0xE000   | 8 KB    | boot selection + rollback state (IDF)               |
| loader    | app/factory   | 0x10000  | 640 KB  | the loader                                          |
| main      | app/ota_0     | 0xB0000  | 1280 KB | node firmware (fusion + ranging)                    |
| staging   | data/0x80     | 0x1F0000 | 1280 KB | incoming image; also what the node serves to others |
| lfs       | data/spiffs   | 0x330000 | 768 KB  | LittleFS: settings, update state                    |
| coredump  | data/coredump | 0x3F0000 | 64 KB   |                                                     |

The ROM and the stock ESP-IDF second-stage bootloader stay as they are. "Bootloader component"
in this design is the `loader` _app_: the IDF bootloader runs before any drivers exist and can't
drive the DW3000, so the piece that must be able to join the swarm has to be an application.

The prebuilt IDF bootloader has app rollback enabled
(`CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE`), which does the crash protection
for us. It boots `main` when otadata selects ota*0, and `loader` otherwise.
A freshly selected `main` boots in a \_pending verify* state; if it resets
before marking itself valid, the bootloader marks it aborted and boots the
loader instead.

### Boot flow

```text
loader (boots when otadata doesn't select a valid main):
  1. /lfs/update.json says "install"?  -> verify the staged image (manifest
     signature + SHA-256), erase main, copy, verify main, select ota_0
     (pending verify), clear the mark, restart. Power loss mid-copy: the
     mark is still set and the copy restarts.
  2. main present and not aborted, and not asked to stay?  -> select ota_0,
     restart.
  3. otherwise, recovery: join the swarm (TDMA, mesh, settings, firmware
     pages; no fusion), report "loader" in its summaries, and when a newer
     verified image completes, mark it "install" and go to 1.
main:
  - pending verify (a fresh install): arm the RTC watchdog for 30 s. It is
    independent of both cores, so a hang anywhere becomes a reset, and a
    reset of a pending image rolls back to the loader.
  - healthy (up 10 s, the radio task exchanging, the fusion task ticking) ->
    mark valid (cancel rollback), disarm the watchdog, and only now let the
    swarm have this image (canary rule, below).
  - a newer verified image completes -> mark "install", select the loader,
     restart.
  - "reboot to loader" (serial or mesh command, or BOOT/GPIO0 held at
     start) -> select the loader, restart.
```

### Image, manifest, signature

The host builds the node image as today, then a signing step produces a
**manifest** that fits in one UWB frame: a `Manifest` envelope `{body, signature}`
(up to 114 bytes). `body` is a serialized `ManifestBody`:

| Field   |                                                                                       |
| ------- | ------------------------------------------------------------------------------------- |
| version | monotonically increasing; nodes ignore older images                                   |
| size    | image bytes                                                                           |
| sha256  | 32 bytes, of the image                                                                |
| flags   | bit 0: loader image (reserved; keep 0, a set flag can push the manifest over a frame) |

and `signature` is ECDSA P-256 (r‖s, 64 bytes) over SHA-256 of the `body` bytes exactly as
the signer serialized them. Nodes keep and re-serve the envelope as received. Staging
sector 0 holds `varint(length) || Manifest`.

The image is verified by streaming SHA-256 over the staged bytes and
comparing with the signed digest. The private key never enters the repo
(default `~/.config/swarm/fw_signing_key`); the public key is compiled into
both loader and main.

### Distribution protocol

Pages are 4 KB (one flash sector), chunks 96 B (43 per page). Nodes fill
pages strictly in order, so a node's progress is a single number, its count
of complete pages: this is Deluge's design, which keeps the per-node state
tiny and lets it ride in every frame a node already sends.

New frame types, sent in the sender's own TDMA slot after its ranging
exchange (a slot is 5 ms; an exchange takes ~2.5 ms; the rest carries up to
~6 data frames):

- `FW_SUMMARY` (in every POLL/RESPONSE advert): `version`, `pages_complete`,
  `pages_total`. Zero cost to discover who needs what.
- The signed manifest travels in a link frame of its own (`FW_MANIFEST`,
  broadcast, never relayed); a node that hears a neighbour summary with an
  older version offers it again.
- `FW_REQUEST`: `version`, `page`, a 43-bit bitmap of chunks still missing.
  Sent by a node that is behind, addressed to the most advanced neighbour.
- `FW_DATA`: `version`, `page`, `chunk`, 96 data bytes. Broadcast, so every
  node that needs that page takes it.

Each node serves the lowest page any neighbour asked for, chunks in bitmap
order; nodes suppress requests they overhear from others for the same page.
At ~6 data frames per 30 ms superframe per serving node, one hop moves about
19 KB/s, so a ~450 KB image takes on the order of 30 s per hop with one
server.

The node on USB gets the image from the host over serial (`fw_push.py`:
manifest, then base64 chunks), stages it, and then serves it like any other
node.

### Canary rule

A node offers and serves only the image it runs _and_ has validated. A
staged image, an installed one that hasn't proven healthy yet, and anything
a loader holds are never handed out, and the host's manifest isn't flooded
either. An image that hangs or crashes therefore stops at the first node
that tries it: that node rolls back to its loader, and the rest of the swarm
never sees the image. It costs one boot (~10 s) per hop.

Tested on hardware (2026-10-20, board 7408):

- A hang image (`//apps/node:node_hang_esp32`) wedged at boot. The RTC
  watchdog reset it 30 s later, and the loader came up in recovery with main
  marked aborted.
- A crash image (`node_crash_esp32`) aborted, and the loader was in
  recovery 1.5 s later.
- Both times the other three nodes stayed on their image (0 chunks served),
  and a good image pushed into the waiting loader installed and spread
  normally.

### Spare slots

The ranging exchange fills most of a node's own slot. Slots beyond the
members' ranks carry network frames only, and go to the nodes that hold pages
a neighbour lacks, ordered by id. Every node derives that list from the same
POLL summaries. With 4 nodes the rank rule had starved the servers.

### Flash writes vs. the radio

ESP32 flash erase/write stalls instruction fetch from flash on both cores.
A sector erase (~40 ms) therefore costs a node a superframe or two of
ranging. Pages are erased one at a time, just before they're written, and
right after the node's own slot, so the stall lands in time it would spend
listening anyway.

## Code layout

- `swarm/fw` (Rust, no_std, host-tested): manifest encode/verify, page and
  chunk bookkeeping, request/serve decisions, the dissemination state
  machine. A host test runs N nodes with packet loss to completion.
- `apps/loader`: the loader app (Arduino/ESP32), sharing the radio and
  TDMA code with `apps/node`.
- `apps/node`: gains the update protocol, the boot-once handoff and the
  health mark.
- `swarm/tools/fw_sign.py`, `fw_push.py`: keygen/sign, push over serial.
- The swarm view shows each node's firmware version and update progress.
