# Mesh on a Raspberry Pi: the radio transport

Status: research + prototype (PR on `agent/mesh-m1`). Companion to
[mesh.md](mesh.md) (PR #516): §3.2 (the `Backhaul` seam), §4 (the 802.11 backhaul: vendor
action frames, channels, BLE coex), §5 (envelope, MTU), §10 and §15 (M10, the IP backhaul).
The Pi as a high-capacity custodian (RAM, storage) is modelled separately; this document is
only about how a Pi gets Splanc mesh frames on and off the air.

## 1. Summary

**Question.** How does a Pi (the bridge `pi/bridge`, the Pi player `pi/player_rs`, a HITL
rig) send and receive the mesh's 802.11 frames on the same channel as the C6s, ideally while
it stays associated to Wi-Fi, and with what latency, airtime and reliability?

**Answer, measured on two Pi 3B+ (CYW43455, stock firmware) on the HITL bench:**

1. **The Pi's own radio works, with stock firmware and no kernel change, through a door
   nobody uses.** The normal Linux path is closed twice. cfg80211 refuses any non-Public
   action frame from a station (`ENOTCONN`, measured), and brcmfmac refuses every action
   frame that is not P2P or GAS ("Unknown Frame", measured, and visible in the Pis' logs from
   wpa_supplicant's own frames). But brcmfmac exposes a vendor nl80211 command (`DCMD`) that
   runs any firmware iovar, and the firmware's `actframe` iovar sends our exact frame
   (category 127, Splanc CID) on any channel while associated. On receive, the stock firmware
   passes our frames up to an ordinary nl80211 registration. Measured with both Pis on the rig
   AP's channel: **~94 % broadcast delivery per hop, 99.5 % unicast round trips, ~14 ms
   round trip p50**, and two real `splanc_mesh::Node`s exchanging beacons and app traffic for
   30 s with the AP links unharmed. Costs: no RSSI (the driver drops it), no TX-ACK
   visibility, ~4–5 ms of host time per send (a synchronous SDIO iovar, ~300 frames/s max),
   **power save must be off** (with it on, the receiver caught 3 of 40), and the channel must
   be passed explicitly (channel 0 delivered 1–18 %).
2. **A USB ESP32-C6 as the radio coprocessor is the robust path for anything shipped.** It is
   byte-for-byte the C6 mesh radio (same netstack, same timing, RSSI and RX timestamps, real
   ACK/retry status), it does not depend on Broadcom firmware behaviour, and it frees the Pi's
   own Wi-Fi for the venue/bridge network. Cost: one $5–8 C6 board and a small bridge task on
   the C6 (M3's backhaul plus SLIP over USB-Serial/JTAG). The host side is in this PR.
3. **USB Wi-Fi adapters (mac80211)** work through monitor-mode injection and capture (radiotap
   gives RSSI and TSF; unicast frames are ACKed and retried by the hardware). nl80211
   management TX in managed mode works too, but **only for Public Action (category 4)**:
   cfg80211 blocks category 127 for every driver. Implemented here; not measured (no adapter
   on the bench, §6 lists what to buy).
4. **nexmon** is not worth it: monitor + injection on the 43455 needs a patched firmware we
   cannot redistribute, tied to exact firmware and kernel versions, with injection known to be
   flaky on that chip.
5. **BLE** stays what the design says: the app's way into a gateway. A Pi can be a BLE gateway
   (BlueZ GATT server) but BLE is not a mesh backhaul.
6. **The IP backhaul (M10)** works today between Pis: the same Splanc frames in UDP multicast,
   **200/200 delivered, 1.9 ms p50 round trip** between the two Pis over Ethernet. It is the
   right link between Pis and to any fixture reachable over IP, and the way a Pi bridges an
   island.

**Recommendation.** Ship Pis with **(a) the IP backhaul always** and **(b) a USB C6
coprocessor where the Pi must be on the air**. Keep **(c) brcmfmac `actframe`** as the
zero-hardware option for the bridge and benches (it works now, it is in this PR), with its
limits stated. Ask the owner (§8) whether to also change the frame to **Public Action vendor
(category 4, action 9)**: one more byte, and every mac80211 USB adapter could then use plain
nl80211 in managed mode, associated, without monitor mode.

## 2. Options

### 2.1 The Pi's own radio (brcmfmac)

All Pis with Wi-Fi use a Broadcom/Cypress (now Infineon) FullMAC chip behind brcmfmac:
BCM43438/CYW43438 (Pi 3B, Zero W), CYW43436 (Zero 2 W), CYW43455 (Pi 3B+, 4, 5, CM4). The
firmware runs the 802.11 MAC; Linux sees an Ethernet-like device plus control iovars. What a
host can do with management frames is what the driver forwards and what the firmware allows.

**TX through nl80211 (`NL80211_CMD_FRAME`).** Two gates, both closed for us:

- **cfg80211 (every driver).** `cfg80211_mlme_mgmt_tx` (net/wireless/mlme.c) checks every
  action frame whose category is not Public (4). On a station (`NL80211_IFTYPE_STATION`) it
  requires the interface to be connected *and* A3 (BSSID) *and* A1 (DA) to be its AP;
  otherwise `-ENOTCONN`. On a P2P-device or NAN interface it is `-EOPNOTSUPP`. Category 127
  to a peer or to broadcast is therefore refused by Linux itself, whatever the driver.
  Measured: `Socket not connected (os error 107)` for every category-127 frame.
- **brcmfmac (`brcmf_cfg80211_mgmt_tx` → `brcmf_p2p_send_action_frame`, p2p.c).** It
  classifies the action body: P2P public action (category 4, action 9, WFA OUI, type 9),
  GAS, or P2P action (category 127, WFA OUI 50:6F:9A, type 9). Anything else logs "Unknown
  Frame" and reports no-ACK without sending. Same code upstream and in the Raspberry Pi tree
  (rpi-6.12.y). Measured: category 4/9 with our CID passes cfg80211, then brcmfmac drops it
  (TX status: not acked; dmesg `Unknown Frame: category 0x4, action 0x9`). The Pis' own logs
  already showed wpa_supplicant's radio-measurement and WNM frames (categories 5, 10)
  dropped the same way.

**TX through the firmware's `actframe` iovar (what works).** brcmfmac registers one vendor
command, `BROADCOM_OUI`/`BRCMF_VNDR_CMDS_DCMD` (vendor.c), which passes a buffer straight to
`brcmf_fil_cmd_data_set/get`: any firmware ioctl or iovar, from userspace, with
`CAP_NET_ADMIN`. The firmware's `actframe` iovar (the one brcmfmac itself uses for P2P) takes
`brcmf_fil_af_params_le`: channel number, dwell time, BSSID, then DA, length, packet id and up
to 1800 bytes of action body. The firmware builds the 802.11 header (A1 = DA, A2 = own MAC,
A3 = the BSSID we pass: broadcast), picks the rate, and transmits. Off-channel, it switches,
sends, waits `dwell`, and returns. Nothing in this path looks at the category or OUI.

One handler quirk: `brcmf_cfg80211_vndr_cmds_dcmd_handler` passes the header's `len` (meant
as the reply length) as the length of the *set*, so `len` must cover the whole iovar buffer
(`radio::brcm_actframe_dcmd`).

**RX.** The firmware raises `BRCMF_E_ACTION_FRAME_RX` for action frames it does not consume.
The driver delivers them to any nl80211 registration on the interface
(`brcmf_p2p_notify_action_frame_rx`), after rebuilding the header: **A1 becomes our own MAC,
whatever it was**, A3 becomes the current BSSID, and **the signal is reported as 0** (no
RSSI). Measured: the stock 7.45.265 firmware does pass category-127 frames with our CID, both
broadcast and unicast, while associated.

**What this costs:**

| Item | Effect | Mitigation |
| --- | --- | --- |
| No RSSI on RX | The mesh's link quality per neighbour is blind | Report RSSI 0 = unknown; the Pi's neighbours still report theirs |
| No TX status | We cannot see ACK/no-ACK for unicast (the firmware's `E_ACTION_FRAME_COMPLETE` is consumed by the driver's P2P state machine) | The mesh layer's want-ack retries cover it (§5.3 of mesh.md) |
| ~4–5 ms per send, one frame in flight | The iovar is a synchronous SDIO round trip; back to back the firmware accepts ~320 frames/s and answers `EBADE` (busy) to the rest | `BrcmActframe` maps `EBADE` to back-pressure (`Busy`); §10.3's traffic is far below it |
| Channel 0 | Passing 0 ("current channel") to `actframe` delivered 1–18 % | `BrcmActframe::open` resolves 0 to the interface's channel number |
| Power save | With PS on (the default), the receiver missed 37 of 40 broadcasts | `iw dev wlan0 set power_save off` (NixOS: a udev rule or `networkmanager.wifi.powersave = false`) |
| A1 rewritten | Unicast vs broadcast lost on RX | Irrelevant: the link frame carries the destination |
| Off-channel TX | Leaves the AP channel for the frame + dwell | Only when the AP and the mesh are on different channels (§4.2's island case) |
| Unassociated ("mesh-only", §4.2) | brcmfmac has no "sit on channel N" without a BSS | Pi hosts the AP on the mesh channel (bridge, Q3), or chained remain-on-channel (untested, §6) |
| Unsupported interface | Broadcom could close the DCMD door in firmware or Infineon could drop the vendor command | Pin firmware in the Nix image (already done); the C6 coprocessor is the fallback |

**nexmon** (seemoo-lab) patches the firmware for monitor mode with radiotap and frame
injection. Supported chips: BCM43430A1 (Pi 3B/Zero W), BCM43455C0 (3B+/4/5, specific firmware
builds), BCM43436B0 (Zero 2 W). Costs: the patched firmware is derived from Cypress's
proprietary binary, whose licence allows redistribution of the unmodified file only, so every
image must patch its own firmware at build time; the patches are tied to one firmware build
and need a patched brcmfmac; injection on the 43455C0 has a history of breaking across
firmware updates; monitor mode and association do not coexist reliably. Since stock firmware
already sends and receives our frames through `actframe`, nexmon buys only RSSI and
timestamps, at a high maintenance cost. **Not recommended.**

### 2.2 USB Wi-Fi adapters (mac80211)

A SoftMAC adapter under mac80211 builds frames in Linux, so the host controls everything the
FullMAC firmware hides.

| Path | TX | RX | Associated at the same time | Notes |
| --- | --- | --- | --- | --- |
| **Monitor vif, radiotap injection** (`radio::Monitor`) | Any frame, any category; rate from radiotap; unicast ACKed and retried by the hardware unless `NOACK` | AF_PACKET with radiotap: RSSI, TSF, FCS flags | Yes on most mt76/ath9k drivers: add a monitor vif next to the managed one; it follows the managed channel | Needs `CAP_NET_RAW`; sees all traffic on the channel (filter cost in userspace, ~kHz of frames on a busy channel) |
| **nl80211 in managed mode** (`radio::Nl80211Mgmt`) | **Category 4 only** (cfg80211, §2.1); category 127 is `ENOTCONN` | Registration with a prefix match; RSSI in `NL80211_ATTR_RX_SIGNAL_DBM` | Yes, on-channel; off-channel through remain-on-channel | No monitor vif; mac80211 reports TX status (ACK) per frame |

Chipsets (mainline drivers on Raspberry Pi OS / NixOS kernels 6.6–6.12):

| Chip, driver | Bands | Injection | Pi notes | Example adapters |
| --- | --- | --- | --- | --- |
| **MT7612U**, mt76x2u | 2.4/5 | Solid; the Kali/Pi default | USB 3 but runs on USB 2; ~400 mA | Alfa AWUS036ACM |
| **MT7921AU**, mt7921u (≥ 5.18) | 2.4/5/6 | Works; newer driver, firmware blob | Needs ~500–600 mA: mind the Pi 5 USB budget (rig PoE HATs!) | Alfa AWUS036AXML, Netgear A8000 |
| **AR9271**, ath9k_htc | 2.4 | The most mature; open firmware | USB 2, low power, cheap; 802.11n 1x1 | Alfa AWUS036NHA, TP-Link TL-WN722N **v1 only** |
| MT7610U, mt76x0u | 2.4/5 | Good | Small, low power | Alfa AWUS036ACHM |
| RTL8812AU/8821CU, rtw88_usb (≥ 6.2) | 2.4/5 | Partial, driver-dependent | Avoid for this | many |
| rtl8xxxu (RTL8188/8192) | 2.4 | Poor/none | Avoid | many cheap dongles |

Reliability: with injection the adapter does CSMA and, for unicast, waits for the ACK and
retries (ath9k honours the radiotap retry count; mt76 uses its default). Broadcast is
unacknowledged as on the C6. This matches the design's assumptions (§4.1).

### 2.3 A USB-attached ESP32-C6 as the radio coprocessor

The C6 runs the netstack and the 802.11 backhaul from M3 exactly as a fixture does, and moves
whole Splanc 802.11 frames to and from the Pi over its built-in USB-Serial/JTAG CDC port (or
SPI on a header, later). The Pi runs the mesh layer (it has the RAM; custodian work stays on
the Pi), the C6 is a radio.

- **Reuse.** The C6 side is M3's `wifi_p2p` backhaul plus a small bridge task. No mesh state
  on the C6, so its RAM is irrelevant. It can stay associated to the venue AP (it is a normal
  netstack STA) or sit in `kModeMesh`.
- **Link.** USB-Serial/JTAG is full-speed USB (12 Mb/s) CDC; even a few hundred kB/s of
  usable throughput is several times the radio's 6 Mb/s OFDM payload rate for 250-byte frames,
  and far above the mesh's needs (§10.3). Added latency should be ~1 ms each way (1 ms USB
  frames plus host scheduling): to be measured in §6 step 2.
- **Framing** (`serial.rs`): SLIP messages, TX (frame), CHANNEL, RX (rssi, C6 timestamp,
  frame), TX_DONE (acked / not), HELLO (MAC). SLIP resynchronises after a reset, costs the C6
  nothing, and the host decoder is tested byte by byte.
- **What it fixes over brcmfmac:** RSSI and RX timestamps (the M3a RX vector), real TX status,
  the C6's own timing (which M4's time sync is built on), no dependence on Broadcom firmware,
  and the Pi's own Wi-Fi left free for the bridge's network (or AP).
- **Cost:** one C6 board (~$5 for a SuperMini, ~$8 for a DevKitC-1, $10 for a -1U with u.FL),
  a USB port, and ~150 lines on the C6. A rig already has C6s on USB; one could serve.

### 2.4 BLE

The design uses BLE for one thing: **the app's way into a gateway** (GATT; §4.3, §10.2), and
for Improv provisioning. It is not a mesh backhaul, and should not become one: a C6 would have
to scan, which takes radio time from Wi-Fi on every member.

For a Pi: BlueZ can run Splanc's GATT service, so a Pi can be a **BLE gateway** for a phone at a
site without Wi-Fi (the Pi's BT has its own coex with its Wi-Fi in the combo chip firmware).
And the bridge can reach a fixture gateway over BLE as a central (mesh.md §9.2 "later").
Neither needs anything from this transport work.

### 2.5 The IP backhaul (M10)

The same Splanc 802.11 frames, in UDP datagrams (`udp.rs`): multicast group 239.83.77.1, port
47811, for broadcast; the peer's address learned from its frames for unicast. Reusing the radio
frame keeps one codec, one peer table, one dedup path, and gives every node a link address
(its MAC) for free. MTU 1400 (mesh.md §5.2).

For Pis it is the first backhaul to turn on: Pis on the LAN mesh with each other at no radio
cost, and a Pi on the venue network bridges any IP-reachable fixture (the island case of
§4.2) with its radio backhaul. Deployment needs UDP 47811 open in the NixOS firewall (the Pi
images drop it today; measured) and multicast on the LAN (it does not cross the rig's routed
container network: use `udp::Fanout::Peers` there).

## 3. Category 127 or Public Action

The design chose category 127 (vendor-specific) and rejected Public Action as "no gain, also
needs an OUI". On Linux there is a gain: cfg80211 lets any interface send Public Action
frames, so **every mac80211 adapter can send and receive our frames through plain nl80211 in
managed mode, associated, without monitor mode** (and with per-frame TX status). Category
127 forces monitor-mode injection on those adapters. brcmfmac refuses both through nl80211,
and accepts both through `actframe`, so it does not decide it. The C6 netstack does not care.

| | Category 127 + CID | Category 4, action 9 + CID |
| --- | --- | --- |
| Body overhead | 5 B | 6 B |
| C6 RX filter | 1 compare | 1 compare |
| Linux mac80211 managed (nl80211) | Blocked by cfg80211 | Works, associated or not |
| Linux mac80211 monitor | Works | Works |
| brcmfmac `actframe` / nl80211 | Works / blocked | Works / blocked |
| Other stacks receiving it | Ignore unknown vendor | Public Action is parsed by every stack (GAS, DPP, NAN use 4/9 with the WFA OUI); unknown CIDs are dropped |

The prototype supports both (`frame::Category`). Decision for the owner (§8).

## 4. Measurements

Bench: two Raspberry Pi 3B+ DUTs on hitl-rig-1's LAN (`splanc-max-2` = pi-ledmapper-1,
`splanc-max-1` = pi-ledmapper-2), reserved through the HITL daemon for the runs. Rig hosts not
touched. Probe: `pimesh` (this PR), a static aarch64 binary copied to `/tmp`.

### 4.1 Radio inventory (DUT Pis; rig hosts not inventoried or touched)

| Host | Board | Wi-Fi chip, bus | Driver | Firmware | Interface modes | USB Wi-Fi |
| --- | --- | --- | --- | --- | --- | --- |
| splanc-max-2 (pi-ledmapper-1) | Pi 3 Model B Plus Rev 1.4 | CYW43455, SDIO 02D0:A9A6 | brcmfmac, kernel 6.12.87 aarch64 | `BCM4345/6 wl0: Aug 29 2023 version 7.45.265 (28bca26 CY) FWID 01-b677b91b` (cyfmac43455-sdio) | IBSS, managed, AP, P2P-client/GO/device; **no monitor** | none (FT2232 JTAG for the Tang only) |
| splanc-max-1 (pi-ledmapper-2) | Pi 3 Model B Plus Rev 1.4 | CYW43455, SDIO 02D0:A9A6 | same | same | same | none |

Both register Action (0xd0) RX for managed, both advertise the Broadcom DCMD vendor command
`(0x001018, 1)`, neither has `MGMT_TX_RANDOM_TA`. Normal state: max-2 associated to the home AP
on 5 GHz ch 40, max-1 to the rig AP on ch 1; Wi-Fi power save on.

### 4.2 Results

| # | Test | Result |
| --- | --- | --- |
| 1 | nl80211 `CMD_FRAME`, category 127, broadcast, associated | **Refused by cfg80211**: `ENOTCONN` ×3 |
| 2 | nl80211 `CMD_FRAME`, category 4/9 + CID | cfg80211 accepts; **brcmfmac drops**: TX status not-acked ×3, dmesg `Unknown Frame: category 0x4, action 0x9` |
| 3 | `actframe` across channels: sender on 5 GHz ch 40 (associated), off-channel to ch 1; receiver associated on ch 1, **power save on** | 3/40 received |
| 4 | Same, receiver power save **off** | **96/100** (dwell 0 and 30 ms alike) |
| 5 | Receiver on ch 40, sender on ch 1, sender not transmitting | 0/50 (expected: the radio is elsewhere) |
| 6 | Ping/pong across channels (sender off-channel each ping; pong unicast on ch 1) | 50/50 round trips; RTT p50 18.6 ms, p90 45 ms, p99 49 ms. The sender hears the pong only because the firmware lingers on ch 1 after its TX |
| 7 | Both on the rig AP (ch 1), PS off, `actframe` channel **0** (firmware default) | 36/200, then 1/200: **do not pass 0** (the backhaul now resolves the channel itself) |
| 8 | Same, explicit channel 1: broadcast 250 B at 20 Hz | **187/200 and 188/200** (93.5–94 %) each way |
| 9 | Unicast ping/pong, 64 B, 20 Hz | **199/200** round trips (99.5 %, the firmware ACKs and retries unicast); RTT p50 13.7 ms, p90 34 ms, p99 54 ms |
| 10 | Broadcast ping/pong, 250 B | 184/200 round trips (92 %, i.e. ~96 % each way); RTT p50 16 ms |
| 11 | Back-to-back 1000 × 250 B | 612 accepted in 1.92 s (~320 frames/s, ~80 KB/s); 388 `EBADE` (firmware busy: one action frame in flight); 561/612 received (92 %) |
| 12 | Paced 5 ms, 500 × 250 B | 500/500 accepted in 3.7 s; 474 received (95 %) |
| 13 | Two real `splanc_mesh::Node`s (ids 20, 21, plain M1 frames) on `WifiBackhaul<BrcmActframe>`, 30 s, beacons + an app broadcast every 100 ms each | app delivered 279/290 and 262/290 (the tail is in flight at the cut-off); `rx_rejected` 0, `tx_busy` 0; ~60 ms of airtime per node per 30 s |
| 14 | The rig AP link during 13 (ICMP to the AP from max-1) | 100/100, avg 9 ms (baseline before: 50/50, avg 16 ms): no visible harm |
| 15 | IP backhaul, UDP multicast over the Pis' Ethernet, 200 × 200 B ping/pong | **200/200**, RTT p50 1.86 ms, p90 2.1 ms, p99 2.7 ms (after opening UDP 47811 in the NixOS firewall, which drops it by default) |

What the numbers mean for the mesh:

- **Delivery.** ~94 % per broadcast hop and ~99.5 % per unicast exchange on brcmfmac, against
  M3a's ≥ 95 % one-hop target for the C6. Broadcast is a little under; the mesh's flood
  redundancy and want-ack retries cover the difference, and the C6 coprocessor or an adapter
  with RSSI-aware rates would do better. Measured with the rig's own traffic on the channel.
- **Latency.** One hop is ~7 ms each way (half a 13.7 ms round trip); ~4–5 ms of it is the
  synchronous iovar on the sender. Fine for control (`apply_at` hides it, mesh.md §6), not a
  timing reference: with no hardware RX timestamp, a brcmfmac Pi should not be the mesh's time
  source.
- **Airtime and rate.** The firmware picks the rate; ~300 frames/s is the host-side ceiling.
  §10.3's busiest case (a 30 Hz fader stream) is 10 % of that.
- **Association.** Never lost in any run, including off-channel TX from 5 GHz.

All runs held both Pis through the HITL daemon (dev class) and restored them afterwards: max-2
back on its home AP, power save back on, the temporary firewall rule removed, `/tmp` cleaned.

## 5. Prototype (this PR)

`//pi/mesh_radio` (crate `splanc_mesh_linux`, std, Linux, **no new crates**: the few libc
calls are declared in `sys.rs`; netlink is hand-rolled in `nl80211.rs`).

| File | What |
| --- | --- |
| `frame.rs` | The Splanc 802.11 action frame (§4.1), both categories; golden bytes the C6 must match; airtime model |
| `radiotap.rs` | TX header for injection; RX parse (TSF, RSSI, FCS) |
| `nl80211.rs` | Generic netlink: family lookup, `REGISTER_FRAME`, `FRAME`, TX status, vendor commands, wiphy capabilities |
| `radio.rs` | `RawRadio` + `Monitor` (AF_PACKET), `Nl80211Mgmt`, `BrcmActframe` (DCMD `actframe`) |
| `udp.rs` | `UdpRadio`: the IP backhaul |
| `serial.rs` | `SerialRadio`: the USB C6 coprocessor link (SLIP) |
| `wifi.rs` | `WifiBackhaul<R>`: the mesh's `Backhaul` over any radio: framing, NodeId → MAC learned from frames (envelope source, or the M1 link frame's), link-retry dedup, airtime budget (`max_duty`) for `may_send` |
| `bin/pimesh.rs` | `caps`, `send`, `listen`, `ping`, `pong`, `node` (a real `splanc_mesh::Node` on the radio) |

Tests (`bazel test //pi/mesh_radio:mesh_radio_test`, 14): frame and radiotap codecs, the
DCMD layout, netlink attributes, SLIP resync; real `splanc_mesh::Node`s over
`WifiBackhaul<UdpRadio>` on localhost sockets (broadcast, want-ack unicast, MAC learning);
the coprocessor link with a fake C6 relaying between two hosts over socket pairs; receive
filters (dedup, foreign category, own echo, unicast to others); airtime pacing.

**mac80211_hwsim** would test the monitor and nl80211 paths against the real cfg80211 and
mac80211 code. The dev container cannot load modules (no CAP_SYS_MODULE, no /lib/modules,
no KVM for a VM), so it is in the hardware plan instead (§6, step 4: a NixOS VM test on a
machine with KVM can run it in CI later).

Build for a Pi: `bazel build //pi/mesh_radio:pimesh_musl` (static aarch64, the player's musl
toolchain).

## 6. Hardware test plan

Done (§4): brcmfmac caps, nl80211 refusals, `actframe` TX/RX across and on channel,
ping/pong, IP backhaul.

Still to do, in order:

1. **Pi ↔ C6 interop** (needs M3 on a C6): a rig C6 DUT running the M3 backhaul and a Pi
   running `pimesh node --via brcm` on the rig AP's channel; both must count each other's
   beacons and app broadcasts. The golden frame in `frame.rs` is the contract.
2. **USB C6 coprocessor** (needs the C6 bridge task): one C6 SuperMini on a DUT Pi,
   `--via serial` (to be wired in `pimesh`), same checks, plus RSSI and TX status.
3. **USB adapter**: an MT7612U or AR9271 on a DUT Pi (power: the DUT Pis are on their own PSUs;
   rig-host Pi 5s have the 600 mA cap, so not there). `pimesh caps`, then `--via monitor`
   (add `mon0` next to `wlan0`) and `--via nl80211 --cat public`, associated; ping/pong and
   delivery vs the brcmfmac numbers; unicast with the peer powered off to see retries.
4. **mac80211_hwsim** on any Linux box with modules (`modprobe mac80211_hwsim radios=3`): the
   same `pimesh` commands across `wlan0..2`, as a CI-able NixOS VM test.
5. **brcmfmac unassociated**: chained `NL80211_CMD_REMAIN_ON_CHANNEL` on the P2P-device wdev
   (RX lands there, not on wlan0) as a "mesh-only" camp; and AP mode (hostapd) on the mesh
   channel for the bridge-hosts-the-network case (Q3).
6. **Pi 4/5 and Zero 2 W firmware**: repeat §4's brcmfmac matrix (the 43455 firmware on the
   Pi 5 and the 43436 on the Zero 2 W may differ).
7. **Soak**: 1 h of `pimesh node` traffic at §10.3's rates on the AP channel, watching the
   Pi's AP link (beacon loss, `iw station dump` tx_failed) and the C6 DUTs' HITL health.

Hardware to buy: 2 × ESP32-C6 SuperMini or DevKitC-1 (coprocessor; ~$5–8 each), 1 × Alfa
AWUS036ACM (MT7612U, ~$40), 1 × AR9271 adapter (AWUS036NHA or TL-WN722N v1, ~$15–30).

## 7. Running the mesh stack on Linux

The mesh crates are `no_std` and allocation-free, and build unchanged for the host (`:mesh`,
`:swarm_net` already are the host builds). A Pi node is `splanc_mesh::Node<WifiBackhaul<R>, P>`
with a large `P` on a Pi, driven from a loop or a tokio task every ≤ 5 ms (the virtual slot);
`WifiBackhaul::set_now` gets the same clock. Several backhauls (UDP + radio) need M2's
multi-backhaul relay (mesh.md §3.2, "a node with two backhauls relays across them"); until
then a Pi runs one `Node` per backhaul or bridges at the port layer.

Userspace/kernel split: everything here is userspace. Root or `CAP_NET_ADMIN` for the
brcmfmac vendor command and nl80211 registration; `CAP_NET_RAW` for monitor sockets; nothing
for UDP or the serial link. No kernel module, no libnl.

## 8. Decisions for the owner

1. **Pi radio strategy**: IP backhaul always; USB C6 coprocessor for Pis that must be on the
   air in shipped installs; brcmfmac `actframe` as the no-hardware path for the bridge and
   benches. Agree?
2. **Frame category**: keep 127, or switch to Public Action vendor (4/9) so mac80211 adapters
   work without monitor mode (§3)? Cheapest to decide before M3 ships.
3. **Pi power save**: turn Wi-Fi power save off on mesh Pis (bridge, player) in the Nix
   images. It costs ~0.1–0.3 W on a Pi.
4. **Bridge at Wi-Fi-less sites** (mesh.md Q3): if the Pi bridge hosts the AP, it hosts it on
   the mesh channel, which also solves the brcmfmac "unassociated" gap.
5. **Buy** the §6 hardware (about $100) so steps 2–3 can run on the DUT Pis.

## 9. Sources

- Linux v6.12 and raspberrypi/linux rpi-6.12.y: `net/wireless/mlme.c`
  (`cfg80211_mlme_mgmt_tx`), `drivers/net/wireless/broadcom/brcm80211/brcmfmac/`
  `cfg80211.c` (`brcmf_cfg80211_mgmt_tx`, `brcmf_txrx_stypes`), `p2p.c`
  (`brcmf_p2p_send_action_frame`, `brcmf_p2p_notify_action_frame_rx`), `vendor.c`/`vendor.h`
  (DCMD), `fwil_types.h` (`brcmf_fil_af_params_le`); `net/mac80211/offchannel.c`
  (`ieee80211_mgmt_tx`), `net/mac80211/rx.c`.
- seemoo-lab/nexmon (supported chips, firmware patching model).
- Raw notes and logs: `/workspace/.claude/pimesh/`.
