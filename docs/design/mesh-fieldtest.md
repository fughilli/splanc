# Mesh radio field kit

Status: test tool (PR on `agent/fieldtest`). Companion to [mesh.md](mesh.md) §4 (the 802.11
backhaul: frames, rates, antennas, R0) and [mesh-pi-transport.md](mesh-pi-transport.md).

## Why

No fixture firmware runs the mesh yet: the netstack 802.11 backhaul is M3, after the M3a spike.
The questions the design leaves to measurement (§4.5 link budget and enclosures, §4.6 which PHY
rates, how much people walking costs, how far one hop reaches) can be answered now, on real
radios in a real room, with a kit that sends **the mesh's own frames** and logs everything it
hears.

The kit is **test-only and never ships**. It runs on the C6's vendor Wi-Fi stack (raw 802.11 TX,
promiscuous RX) as a stand-in for the netstack; the frame bytes are ours.

## Frames

Public Action (category 4, action 9), CID `0A 5C 4D` (mesh.md §4.1), then frame kind **`0xF1`
(field kit, diagnostic)**, not `0x01`: a real mesh node never mistakes a probe for an envelope.
The sender's MAC is replaced with a locally administered `0A:5C:4D:F1:<net>:<id>`
(`esp_wifi_set_mac`), so no Espressif OUI appears anywhere in our frames.

After the 6-byte prefix, a 28-byte header (version, type, net, src/dst id, rate, TX power,
channel, boot, phase, per-type and per-rate sequence, uptime, control epoch) and a body:

| Type | Sent | Body |
| --- | --- | --- |
| PROBE (1) | broadcast every `period` (200 ms ± 20 %), rate cycled per frame | padding to `len` (250 B) |
| UNI (2) | after each probe, to the next peer heard in the last 10 s; every peer gets every rate in turn | padding to `len` |
| SUM (3) | every window (2 s) | the node's window block (below), so a collector hears every node in-band |
| CTRL (4) | flooded: on change, 2 repeats, then every ~10 s | phase number + label, the laptop's unix time + relay age, kit-wide power/rate/period/mesh changes |
| MSUM (5) | every window, mesh mode | the mesh window block |

## What a node records

Per window (2 s) and per (peer, rate): broadcasts heard / expected (from per-rate sequence
gaps), RSSI mean/min/max/std, noise floor, unicasts heard / expected and duplicates, and **my
unicasts to that peer ACKed / not** (`esp_wifi_register_80211_tx_cb`'s `tx_status`, after the
MAC's retries). Flags: outage (a peer heard in the last minute sent nothing), TX power changed,
rate mismatch (the receiver's PHY saw another rate than the header claims), peer rebooted.
Plus one "self" entry per rate (sent, TX errors).

The window goes three ways: an append-only CRC'd block in the node's own flash (the default
table's `spiffs` partition, 1.375 MB, about 4 h at 6 peers × 2 rates; never wraps; a torn block
after a power cut is skipped), a base64 line on USB serial, and a SUM frame on air.

**Why flash as the primary store.** The warehouse has no Wi-Fi, nodes run on power banks and
move between arrangements, and a line-shaped arrangement means no single receiver hears
everybody. A node's own flash records everything it heard, survives power loss, needs no
infrastructure and is read once at the end over USB (`fieldkit.py pull`). The in-band SUM frames
give a live view at the collector and a second copy; a collector laptop adds per-frame RSSI for
its own links and the wall clock (CTRL frames carry the laptop's time, so every node's uptime maps
to wall time).

**Player boards.** The kit's app ends below 0x140000 and its log lives at 0x290000..0x3F0000: the
player OTA layout's littlefs (maps) at 0x160000 and NVS (Wi-Fi credentials) are not written. The
player app slot is overwritten: reflash the player afterwards.

## Mesh mode (stretch, test-only)

`mesh 1` (or `ctl mesh=1` from the collector) starts the **real M1 `splanc_mesh::Node`**
(swarm_net managed flooding) on the C6, over a raw-frame shim backhaul (`mesh_ffi.rs`): frame
kind `0x01`, the M1 link frame, MTU 250, the Pi bench's HMAC key, so it interoperates with
`pimesh node` on a Pi. Every node floods an app packet every second; the collector (`mping 1`)
floods a ping every 2 s that every node answers. 'M' window blocks record per-origin delivery and
hop counts; the collector logs round trips and hops each way. This is a stand-in for M3, not M3:
it runs on the vendor stack, without the M2 envelope.

## Host tools (`tools/fieldtest`)

- `fieldkit.py` (pyserial): `flash` (bundle + id + defaults + erase), `setup`, `scan` (APs per
  channel), `collect` (logs everything with the laptop's clock; type `phase N label [pwr=..]`
  to mark steps for the whole kit), `pull` (the node's flash log).
- `fieldwire.py`: decoder for blocks, windows, phases, collector lines (unit-tested).
- `analyze.py` (matplotlib): link matrices per phase (delivery, ACK, RSSI per rate), delivery
  vs RSSI per rate, RSSI vs tape distance, time series of walking phases, mesh flood
  matrices and ping RTTs, `REPORT.md` and `links.csv`.

## Rig dry run (2026-11-18, hitl-rig-1, 3 C6 DUTs, channel 11)

Recorded in the PR. The DUTs sit centimetres apart on one host, so the numbers say the kit works,
not how a room behaves: RSSI is −60 to +4 dBm, high enough to saturate OFDM receivers.
