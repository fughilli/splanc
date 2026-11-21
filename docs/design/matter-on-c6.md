# Matter on the lamp's ESP32-C6 (port spike, D-189)

Status: spike. This doc has measured numbers and a recommendation. No Matter code is
in the player yet. Owner decision D-189: *"Start a port spike now"* and *"We should be
able to fit this."* The smart-home study (`docs/design/smart-home-integrations.md`
§3, PR #582) said Matter does not fit today's C6 image. This doc tests that claim by
measuring instead of estimating.

**The answer in one paragraph.** It can fit, but not by adding Espressif's SDK.
Today's image (main with the mesh in) has **68 KB** left under the `layout_test`
gate. The C++ CHIP SDK (esp-matter) adds about **500 KB** of flash for a
size-optimised light (§3). A Rust Matter stack (`rs-matter`, no_std, a 4 KB heap)
needs about **400 KB** for the same light, BLE commissioning included (§4). That is
about 360 KB once our mbedTLS replaces its RustCrypto. Today's image also still links
about **185–235 KB of code it never runs** (§2.2). The largest piece is the whole
lwIP stack, 130 KB, which the netstack replaced. Cutting that dead code (two weeks,
and worth doing anyway), adding IPv6 to the netstack (about 15 KB), and trimming
rs-matter to what one lamp needs brings Matter into the existing 2.25 MB app slot.
If the trim falls short, there is a second lever: a one-time partition move that
gives the app slot 192 KB of the loader's space. **Recommendation: (b), rs-matter on
the netstack, in five milestones, about 6–8 weeks (§6).** Option (a), CHIP next to
the netstack, is 375–455 KB over even after the cuts. It also needs a second IP
stack demuxing our MAC. Option (c), a separate Matter image, cannot fit a third app
slot in 4 MB, and a lamp in Matter mode would not run effects. A PoC (§7) flashed a
stock esp-matter light to a rig-2 C6, commissioned it from this container and drove
On/Off and Level. That run measured the heap profile of a Matter session on this
chip.

## 1. What was measured, and how

| Thing | How |
| --- | --- |
| Our image today | `-c opt` `//firmware/player_app:esp32c6_netstack` at main `b5564b58f` (2026-11-21: #569's size diet and mesh M2–M5 in). Flash attributed to source files through the ELF's DWARF line info (`nm -S -l`). Symbols without debug info are the vendor blobs plus our Rust. |
| A Matter light built with the CHIP SDK | Espressif's esp-matter `light` example: esp-matter `release/v1.5` (`2563685`), connectedhomeip `9c2a636`, ESP-IDF v5.5.5 (esp-matter v1.5's pin; our prebuilt SDK is v5.5.4). Built for `esp32c6` with the size-optimised config below. |
| Its heap at runtime | the same image on a rig-2 C6. Free, minimum and largest block are printed every 5 s through boot, Wi-Fi join, commissioning and on/off traffic (§7). |
| A Matter stack in Rust | `rs-matter` (`project-chip/rs-matter` `4e4105a`, v0.4.1). Its `bloat-check` binary is an On/Off light with Wi-Fi network commissioning, BTP (BLE commissioning), the built-in mDNS responder, PASE and the CASE responder, crypto by RustCrypto. Built for `riscv32imac-unknown-none-elf` with `opt-level = "z"` and fat LTO, on esp-hal + esp-rtos. |

The scripts are committed in `tools/matter_spike/`. `build_light.sh` and the
`*.defaults` overlays build the esp-matter light, and `esp_matter_light.patch` adds
its heap/IP line and the On/Off/Level hooks. `attribute_flash.py` does the DWARF
attribution. `run_poc.py`, `ctrl.py`, `rig_relay.py` and `local_relay.py` are the
HITL PoC. The raw logs stay on the dev container (`/workspace/.claude/mattersp/`).

The size-optimised esp-matter config (`tools/matter_spike/opt.defaults`) applies every option in
esp-matter's `docs/en/optimizations.rst` that does not change behaviour, plus `-Os`:

```
CONFIG_COMPILER_OPTIMIZATION_SIZE=y              CONFIG_ENABLE_CHIP_SHELL=n
CONFIG_ENABLE_OTA_REQUESTOR=n                    CONFIG_NEWLIB_NANO_FORMAT=y
CONFIG_ESP_MATTER_MAX_DYNAMIC_ENDPOINT_COUNT=2   CONFIG_ESP_MATTER_MAX_DEVICE_TYPE_COUNT=2
NimBLE: 1 connection, peripheral only, no security / 5.0 / bonds, small msys pools
CONFIG_USE_BLE_ONLY_FOR_COMMISSIONING=y          event-log buffers 256 B
FreeRTOS, ringbuf and heap functions in flash; SPI flash driver from ROM
task stacks: main 3 KB, esp_timer 2 KB, CHIP 6 KB; log level WARN
```

The example's `sdkconfig.defaults` already compiles out about 110 unused clusters.

## 2. Our image today

### 2.1 Budget

| | Bytes | Notes |
| --- | ---: | --- |
| `app` slot (`firmware/loader/partitions_ota.csv`) | 2,359,296 | `0x240000` at `0x1C0000` |
| `layout_test` gate (slot − 64 KB) | 2,293,760 | the headroom `docs/design/ota.md` promises |
| **app image at main** (`esp32c6_netstack.bin`) | **2,224,096** | mesh M2–M5 in |
| **left under the gate** | **69,664** | 68 KB |
| static SRAM (`_heap_start` − `0x40800000`) | 331,472 | IRAM 100.6 KB, `.data` 71.4 KB, `.bss` 159.4 KB |
| free heap, running, mesh off / on | 93,112 / 49,292 | `docs/design/mesh-m5.md` (rig-1) |
| minimum free heap, 2048-LED max config | 29,676 | `docs/design/ram-budget.md`; the floor is 24 KB |

The 4 MB flash is fixed: every C6 we ship and every rig DUT is an ESP32-C6FH4.

### 2.2 What is in the 2.2 MB (and what never runs)

Flash (`.flash.text` + `.flash.rodata` + IRAM text) by source, from DWARF:

| Component | KB | Runs on the netstack image? |
| --- | ---: | --- |
| vendor blobs (Wi-Fi/PHY `libpp`/`libnet80211`/`libphy`, BLE controller) + all our Rust | 1,156 | yes |
| mbedTLS (from source since #569) | 151 | yes (TLS, OTA signature) |
| **lwIP + `esp_netif`** (tcp/udp/ip4/ip6/nd6/mld6/dhcp/dhcpserver/NAPT/sockets/**PPP 20 KB**) | **127** | **no**: `esp_netif_init()` is never called (`netstack_transport.cpp:1831`) |
| our C++ (`firmware/player_app`) | 112 | yes |
| `wpa_supplicant` (common, rsn, `src/ap`, `esp_supplicant`, crypto) | 61 | mostly no: the netstack does its own 4-way handshake (`netstack/src/wpa.rs`) and AP role |
| IDF drivers, FreeRTOS, NVS, littlefs, HAL | ~210 | yes |
| `.eh_frame` (unwind tables) | 40 | only for C++ exceptions and IDF panic backtraces |
| `espcoredump` | 9 | no: the coredump partition was dropped (ota.md) |
| Arduino `Network` + `WiFi` libraries | 12 | no: leftover `WiFi.*` calls (below); the boot scan uses `esp_wifi_scan_*` directly |
| `network_provisioning` | 3 | no |

Why lwIP is still linked: the linker map of the main build (`--linkopt=-Wl,-Map`)
shows four ways in:

- the Arduino `Network` library (`NetworkManager.o`, `NetworkInterface.o`), reached
  from the `WiFi.*` calls in `main.cpp` that the `LM_NETSTACK` gates do not cover
  (lines 1477, 3384, 3939–4143);
- `esp_wifi`'s `wifi_default.c` (the default STA/AP netif handlers);
- mbedTLS's `net_sockets.c` (`MBEDTLS_NET_C`, the BSD-socket BIO, which we never use:
  our TLS runs over the netstack's BIO);
- the Arduino core's `esp32-hal-time.c` (`configTime` / SNTP takes the tcpip core
  lock).

With `--gc-sections`, the linker keeps every function that is reachable, even if it
never runs.

**The cuts, with their size:**

| Cut | Saves (est.) | Effort | Risk |
| --- | ---: | --- | --- |
| C1. Cut those four references in the netstack build (gate the `WiFi.*` calls, `MBEDTLS_NET_C` off, stub the default Wi-Fi netif handlers and the SNTP lock), so lwIP, `esp_netif`, PPP and the Arduino `Network`/`WiFi` libraries stop linking | 130–140 KB | 2–3 days | low: the netstack never calls them. Check that the boot scan still runs: it uses `esp_wifi_scan_*`, not `WiFi.scan*` |
| C2. Drop the `wpa_supplicant` parts the netstack does not use (`src/ap`, WPS/EAP, `esp_supplicant` glue) | 30–45 KB | 2–3 days | medium: `esp_wifi_init` registers supplicant callbacks, so some must stay as stubs. Needs the Wi-Fi HITL lane (join, rekey, commercial AP) |
| C3. `espcoredump`, `network_provisioning` out of the link | 12 KB | ½ day | low |
| C4. No unwind tables for our own code: `-fno-asynchronous-unwind-tables` for `firmware/player_app` C++, `-C force-unwind-tables=no` for the Rust (`panic = abort`) | 10–20 KB of the 40 KB `.eh_frame` | 1 day | low. The prebuilt SDK keeps C++ exceptions on (`CONFIG_COMPILER_CXX_EXCEPTIONS=y`) and its own tables. `CONFIG_ESP_SYSTEM_USE_EH_FRAME` is already off, so panic backtraces do not use them |
| **Total** | **185–235 KB** | **about 2 weeks** | |

These cuts are worth making anyway. They also give the mesh and the next features
room. With them, the image has about **255–300 KB** under the gate.

## 3. A Matter light built with the CHIP SDK (esp-matter), measured

Image: **1,614,656 B** (`light.bin`, the size-optimised config of §1, with Wi-Fi
station credentials compiled in for the PoC). For comparison, Espressif's own table
for the default light example is 1.48 MB on an ESP32-C3 (esp-matter `6a77422`).

| | Bytes |
| --- | ---: |
| flash code + data (`.text` + `.rodata`) | 1,487,670 |
| static D/IRAM (`.text` 112,350 + `.data` 14,568 + `.bss` 64,216) | 191,134 |

The largest archives (`idf.py size-components`; "flash" = code + constants):

| Archive | Flash | Static RAM | On our image? |
| --- | ---: | ---: | --- |
| `libCHIP.a` (connectedhomeip: messaging, PASE/CASE, IM, credentials, platform) | 278,644 | 20,302 | new |
| `libesp_matter.a` (esp-matter's data model, clusters, glue) | 166,298 | 21,291 | new |
| `libble_app.a` + `libbt.a` (BLE controller + NimBLE host) | 214,818 + 56,075 | 27,387 | controller yes; NimBLE host new (we have our own host) |
| `libnet80211.a`, `libpp.a`, `libphy.a`, `libwpa_supplicant.a` (Wi-Fi) | 282,681 | 72,998 | yes |
| `liblwip.a` + `libesp_netif.a` | 96,327 | 2,651 | linked but dead today; Matter would make it live |
| `libmbedcrypto.a` + `libmbedx509.a` | 84,892 | 422 | yes (our from-source mbedTLS) |

The size tool puts another 120,703 B of merged `.rodata` under `libesp_app_format.a`.
That is string and constant data from all archives, mostly CHIP's (log formats, cluster
metadata). **What Matter itself adds through the CHIP SDK is about 445 KB of code
(CHIP + esp-matter) plus 40–60 KB of that merged constant data, so about 500 KB**,
before a platform layer for our netstack. It also needs about 41 KB of static RAM for
CHIP and esp-matter.

Runtime heap on a rig-2 C6 (the PoC, §7): free / minimum free / largest block, from
the image's own 5 s heap line (`heap_caps_*`, 8-bit capable internal RAM):

| Moment | Free | Minimum so far | Largest block |
| --- | ---: | ---: | ---: |
| boot, commissioning window open, BLE advertising | 230,112 | 229,852 | 212,992 |
| joined the AP (DHCP lease) | 228,400 | 221,712 | 212,992 |
| commissioning complete (PASE + CASE done) | 224,664 | 218,504 | 204,800 |
| BLE released after commissioning | 253,844 | 218,504 | 204,800 |
| steady, commissioned, after On/Off/Level traffic | 253,844 | 218,504 | 204,800 |

So on this chip a Matter light's **runtime heap is small**. Commissioning (SPAKE2+,
then the CASE sigma exchange with P-256 ECDH/ECDSA, the NOC chain and the fabric
write) dips about **10 KB** below idle. A commissioned, idle node holds about 7 KB of
heap beyond its static RAM once BLE is released. The real RAM cost of CHIP is
static: about 41 KB of `.bss`/`.data` (CHIP + esp-matter), plus lwIP's, plus the CHIP
task's 6 KB stack.

## 4. A Matter light in Rust (rs-matter), measured

`bloat-check` (`riscv32imac-unknown-none-elf`, `opt-level = "z"`, fat LTO,
`sha2`/`aes` compact soft backends):

| Section | Bytes |
| --- | ---: |
| `.text` | 389,296 |
| `.rodata` | 45,280 |
| `.data` + `.rwtext` + `.trap` | 7,612 |
| **flash total** | **442,188** |
| `.bss` | 71,004 |

Flash by crate (symbol sizes, demangled):

| Crates | KB | Notes |
| --- | ---: | --- |
| `rs-matter-im`, `-dm`, `-dm-core`, `-im-core` (interaction model, data model) | 101 | Read/Write/Invoke/Subscribe, the root endpoint's clusters |
| `rs-matter-transport` (MRP, sessions, exchanges, BTP, mDNS) | 29 | BTP ≈ 12 KB, mDNS ≈ 19 KB of the symbols that name them |
| `rs-matter-dm-clusters` (generated cluster codecs) | 23 | |
| `rs-matter-sc` (PASE, CASE) | 20 | |
| `rs-matter-cert`, `-tlv`, `-crypto`, `-utils`, `-node*`, `-pairing` | 33 | Matter certificates in TLV, TLV codec |
| `embassy-futures` + `core` (async select/join glue, formatting) | 52 | |
| RustCrypto (`p256`, `primeorder`, `crypto-bigint`, `der`, `x509-cert`, `aes`, `ccm`, `sha2`, `hmac`, `hkdf`, `pbkdf2`) | 42 | replaceable by our mbedTLS (`rs-matter-crypto` has an mbedTLS backend) |
| `qrcodegen` (setup QR printed to the log) | 7 | not needed on the lamp |
| esp-hal, esp-rtos, embassy-executor, defmt/RTT | 35 | **not** part of the cost on our image: we bring FreeRTOS and our own drivers |
| C runtime, unattributed | 40 | |

So the Matter stack itself costs about **400 KB** of flash: 442 KB minus the 35 KB
platform and the 7 KB QR code. With RustCrypto swapped for our mbedTLS it is about
**360 KB**, plus the glue to the netstack (§5.2, about 15 KB).

RAM: `.bss` is 71 KB, but the Matter state is the 51 KB `MatterStack` cell: 5 fabrics
(the spec minimum), sessions, exchanges, the 1,583-byte RX/TX buffers, subscriptions,
3 Wi-Fi networks, BTP. The async tasks' futures add about 12 KB, and a 4 KB heap
covers rs-matter's small `alloc` use. The defaults are sized for a hub-class node.
Measured: building with `max-fabrics-2` plus 2 ACL entries/subjects/targets
instead of 5/4/4/3 shrinks `.bss` from 71,004 B to **61,524 B** (`MatterStack`
51,088 → 41,864 B), with the same flash. Fewer exchanges per session, fewer
subscriptions and IM buffers, one Wi-Fi network and no BTP (on-network
commissioning) should bring the Matter state to an estimated **30–40 KB** (not
measured). CASE needs about 2 KB of stack for P-256 on top. The spec
requires 5 fabrics for certification, so a certified lamp keeps 5 (§8).

## 5. The three ways to put Matter on the lamp

### 5.1 (a) The CHIP SDK on lwIP, next to the netstack

What it takes:

- lwIP has to run again, fed by **our** MAC. The netstack owns the RX ring and does its
  own MLME and WPA (`radio_bringup`, `netstack_transport.cpp:1820`). The vendor Wi-Fi
  driver never associates, so `esp_netif`'s Wi-Fi glue has nothing to attach to. We
  would write a custom lwIP `netif`: `linkoutput` into the netstack's `tx_l2`, and an
  RX demux in `handle_l3` that hands IPv6 frames and UDP 5540 to lwIP. Two IP stacks
  then share one MAC address, and ARP/ND, DHCP and mDNS have to agree on who answers.
- The CHIP ESP32 platform layer assumes `esp_wifi` events, `esp_netif`, the default
  event loop and NVS. It needs a new CHIP platform for us (connectivity manager,
  network commissioning driver, KVS), as an "external platform" (`ext_plat`).
- esp-matter v1.5 builds against IDF v5.5.5 with its own sdkconfig. Our IDF is the
  prebuilt Arduino SDK v5.5.4 with a frozen sdkconfig. CHIP would have to be built
  against that frozen config, by hand, outside esp-matter's CMake.
- Size: CHIP + esp-matter ≈ 500 KB (§3), plus a platform layer (≈ 20 KB, est.), plus
  NimBLE's host (56 KB) if BLE commissioning uses it, or a BTP port to our host. lwIP
  stays live, so cut C1 is not available. With C2–C4 (52–77 KB) there are 120–145 KB
  under the gate: **short by about 375–455 KB**.
- RAM: 41 KB static for CHIP and esp-matter, plus lwIP's pools and the tcpip task
  (the ~20–25 KB of vendor heap that #266 removed), plus the runtime heap in §7.

**Verdict: does not fit, and it is the most fragile of the three.** It brings back
the vendor heap the RAM audits removed. It also adds a second, unaudited stack in
front of the radio.

### 5.2 (b) A Matter server on our own stack (rs-matter + IPv6 in the netstack)

What the netstack has today: IPv4, ARP, DHCP, UDP (DHCP, OSC on 9000, mDNS on 5353),
our TCP, TLS and wss, a single-service mDNS responder (`firmware/mdns`) and a
heapless BLE host with a fixed GATT server (`firmware/netstack/src/gatt.rs`,
`gap.rs`). What Matter adds:

| Piece | Where | Size (est.) | Notes |
| --- | --- | ---: | --- |
| IPv6 RX/TX: EtherType `0x86DD` in `handle_l3`, next-header walk, ICMPv6 checksum | netstack_transport + a small Rust crate | 3 KB | today `handle_l3` drops anything that is not `0x08xx` (line 1134) |
| Link-local `fe80::/64` from the MAC (EUI-64), DAD (one NS) | | 1 KB | |
| Neighbour Discovery: answer NS for our addresses, send NS / learn from NA, a 4-entry neighbour cache like the IPv4 one | | 3 KB | |
| SLAAC from Router Advertisements (ULA / global /64) | | 2 KB | link-local is enough on one LAN; Apple and Google hubs prefer a ULA |
| MLDv2 reports for `ff02::fb` and our solicited-node groups | | 1 KB | needed so APs with multicast snooping forward mDNS |
| UDP over IPv6 (mandatory checksum) to a Matter mailbox, like the OSC one | | 1 KB | |
| mDNS: `_matterc._udp` (commissionable, with `_L`/`_S`/`_CM` subtypes) and `_matter._tcp` (operational), AAAA records, over IPv6 | rs-matter's built-in responder on 5353, or `firmware/mdns` generalised to several services | 0 (in rs-matter) | |
| CHIPoBLE: one more GATT service (C1/C2/C3 characteristics) on the heapless host, mapped to rs-matter's `Btp` | `gatt.rs` + glue | 2 KB | optional: on-network commissioning needs no BLE (§8) |
| An executor: rs-matter is async. One FreeRTOS task polls its futures (a small `block_on` with a waker per mailbox) | `firmware/player_app` | 1 KB | |
| Persistence: fabrics, ACLs and counters in NVS (the `KvBlobStore` trait) | | 1 KB | |
| The data model: root endpoint + endpoint 1 Dimmable Light (On/Off, Level Control, Identify, Groups, Scenes minimal), wired to the power machine (§9) | | in rs-matter | |
| **Total glue** | | **about 15 KB** | |

Two netstack rules this has to respect:

- **Group-addressed TX while wss is live drops the wss session**
  (`netstack_transport.cpp:808`). The mDNS announcements and MLD reports are
  multicast. Today mDNS answers unicast when a wss session is up. Matter needs the
  same rule: unicast (QU) answers during a session, announcements only between
  sessions. Better still, find and fix the root cause in the TX path. That is a
  prerequisite, and it needs its own HITL gate.
- **The Rust toolchain.** rs-matter needs Rust ≥ 1.92. `MODULE.bazel` pins 1.85.0 for
  the C6, so the toolchain has to move up. That touches every Rust crate, so it is a
  PR of its own with the full HITL lane.

Size: 360 KB (rs-matter with the mbedTLS backend) + 15 KB glue = **about 375 KB**.
After the §2.2 cuts there are 255–300 KB left. So it is short by about 75–120 KB. The
gap closes in one of these ways (owner decision §10):

1. **Trim rs-matter to what one lamp needs**: no QR code (7 KB), no Wi-Fi network
   commissioning cluster when Improv owns credentials (on-network commissioning
   only), no BTP when there is no BLE commissioning (12 KB), the IM features a light
   never uses (events, timed requests on non-lock clusters, the Groups key cluster
   beyond the mandatory stubs). Estimated 40–70 KB. Some of this needs upstream
   feature flags; rs-matter is small enough to carry patches.
2. **Grow the app slot.** The loader was 1,300,704 B in its 1,376,256 B slot at
   v1.14.1. It is the same netstack build without the player, so it also links the
   dead lwIP. With #569 and C1–C4 it should drop to about 1.0–1.1 MB (est.). Moving
   the loader/littlefs/app boundaries by 192 KB needs a one-time partition-table
   migration. The loader can do it the way it already
   migrated littlefs (`docs/design/ota.md` "Migration"), but it is the riskiest step
   in this plan.
3. **Build Matter as an opt-in feature** at first: "Matter" images for lamps that
   want it, with one of the bigger features left out (see the decision).

RAM: 30–40 KB of Matter state, trimmed (§4). The running image has 93 KB free with
the mesh off and 49 KB with the mesh on. **Matter and the mesh do not both fit at the
2048-LED max config** (29.7 KB minimum today). Matter's state can share the mesh's
arena: both are heap blocks that are allocated when the feature is switched on (the
mode-union design in the RAM audit). Or the two features can be exclusive at max
LEDs (owner decision §10).

The PoC (§3, §7) shows that commissioning itself is cheap on this chip: PASE + CASE
dipped the heap about 10 KB below idle, which fits inside the TLS region's budget
(P-256 is already there for TLS). Even so, Matter commissioning should not overlap a
fresh TLS handshake at the 2048-LED config. In the PoC, releasing NimBLE after
commissioning returned 29 KB (224,664 → 253,844 B free). Our heapless BLE host holds
much less, so that lever is smaller on the netstack.

**Verdict: fits, with the §2.2 cuts plus one of the three gap closers.** It is a
sizeable port, but every piece sits on code we already own and test.

### 5.3 (c) A separate Matter-mode image (OTA slot / partition)

- **No room for a third slot.** 4 MB = 64 KB (boot/table/nvs/otadata) + 1,344 KB
  loader + 384 KB littlefs + 2,304 KB app. A Matter image of 1.6 MB
  (§3) needs its own slot. The only way to get one is to drop littlefs (the map and
  effects) or the loader (OTA recovery).
- **A Matter image in the app slot instead** (the user picks "Splanc" or "Matter"
  firmware, and the loader switches between them): a lamp in Matter mode has no
  effects, no app control and no mesh, just a dimmable white light. That breaks
  "effects keep running" and the product.
- **What (c) is good for: this spike's PoC.** A stock esp-matter light in the app
  slot proves commissioning and the heap profile on our exact chip (§7). It is also
  a fallback if (b) slips: a factory-test or certification-lab image.

**Verdict: not a product path, but the right tool to measure with.**

## 6. Recommendation and timeline: (b)

| Milestone | What | Gate | Effort |
| --- | --- | --- | --- |
| M0 size diet | §2.2 C1–C4 | `layout_test`, full HITL lane, Wi-Fi join/rekey on a commercial AP | 2 weeks |
| M1 IPv6 | link-local + SLAAC, ND, MLD, ICMPv6 echo, UDP/IPv6, `ping6` from the rig; fix or gate group-addressed TX during wss | new HITL gate `ipv6_basics` (DUT answers NS/ping6, keeps wss through MLD and mDNS) | 1–1.5 weeks |
| M2 rs-matter in the image | Rust 1.92+ toolchain bump (own PR); rs-matter via crate_universe with the mbedTLS backend; executor task; NVS store; root endpoint + On/Off light; on-network commissioning | chip-tool / the CHIP python controller commissions a rig DUT and toggles it (§7's harness, as a HITL test) | 2 weeks |
| M3 the lamp's clusters | On/Off + Level + Identify mapped onto lamp power (§9); attribute reports on `power_state` changes; BLE commissioning (CHIPoBLE on the heapless host) if decision 3 (§10) asks for it | HITL: Matter toggles and dims while the app's wss session stays up, effects keep running; touch-tap reports arrive as subscription reports | 1–1.5 weeks |
| M4 ecosystems + certification prep | Apple Home, Home Assistant, Alexa on a real home network (IPv6 multicast through a real AP); DAC/PAI provisioning per lamp (per-device certs already exist, `docs/design/per-device-cert.md`); Test Harness pre-runs | manual + one HITL smoke | 1–2 weeks |

**Total: about 6–8 weeks**, with M0 useful on its own.

Why not the bridge alone? It already exists (PR #600, matter.js in the Splanc
bridge, Phase 1 of the study). It stays the fastest way to get Matter for lamps that
have a bridge, and the mapping in §9 is the same, so a lamp acts the same either way.
On-lamp Matter is what a lamp without a bridge needs, and certification ("Works with
Google Home") needs the device itself to be Matter.

## 7. PoC: a Matter light on a rig-2 C6, commissioned from the container

**Result: PASS.** A size-optimised esp-matter light (§3, 1,614,656 B) was flashed to
a rig-2 C6 (`c6-10ffcc`, reservation `4df2f2c50f5f3c0c`, 2026-11-21). It was
commissioned **on-network** from this dev container and then driven:

```
[poc] DUT ip 10.42.0.87
ctrl: PASE ok 0.3s
ctrl: COMMISSIONED node 0x1234 in 3.0s
ctrl: On -> OnOff = True
ctrl: Off -> OnOff = False
ctrl: Toggle -> OnOff = True
ctrl: MoveToLevel(64) -> CurrentLevel = 64
ctrl: BasicInformation: VendorName 'TEST_VENDOR', ProductName 'TEST_PRODUCT', SoftwareVersionString '1.0'
```

and on the DUT's serial console (the hooks sit where `set_power` / `set_brightness`
would be called, §9):

```
10:51:28.439Z I (30605) app_main: Commissioning complete
10:51:29.640Z [mattersp] CurrentLevel=1        <- Off: the Lighting feature moves the level to its minimum
10:51:29.640Z [mattersp] OnOff=0
10:51:30.642Z I (32665) app_main: BLE deinitialized and memory reclaimed
10:51:30.842Z [mattersp] OnOff=1
10:51:31.042Z [mattersp] CurrentLevel=64
```

(The first `On` changed nothing: the light boots on.)

How it was wired, because the rig network makes Matter hard:

- **Controller:** connectedhomeip's Python controller (`home-assistant-chip-core`
  2025.7, the same C++ commissioner as chip-tool, prebuilt for linux-aarch64). It
  uses the test PAA roots from connectedhomeip. A chip-tool build would have been an
  hour of CPU on a loaded box for the same code path.
- **No multicast to the DUT:** the reservation container reaches the rig AP's LAN
  routed, not bridged (`hitl-rig2-multicast` notes), and this container is one more
  hop away. Matter UDP was relayed: controller → local UDP relay → `ssh -L` TCP → a
  UDP relay in the reservation container (stdlib Python) → DUT:5540. PASE went to
  the relay's address (`EstablishPASESessionIP`). For CASE, the commissioner's
  operational discovery (`<compressed-fabric-id>-<node-id>._matter._tcp`) was
  answered by a local python-zeroconf record that points at the relay. In a home,
  both happen by mDNS on the LAN.
- **Wi-Fi credentials:** compiled in (`CONFIG_DEFAULT_WIFI_SSID/PASSWORD`, the
  rig's provisioning AP), so the DUT was on the network before commissioning. That
  is the lamp's situation after Improv (§8).
- **Rig quirk found on the way:** the rig AP did not answer 802.11 auth for a freshly
  reflashed DUT's factory MAC (three runs on two DUTs: `auth -> init` after 1 s,
  forever). The netstack already works around this with a random MAC fallback
  (`docs/design/ota.md`, the reset-mid-transfer row). The PoC image uses a random
  locally administered MAC and joined at once.

Tools: `tools/matter_spike/` (`run_poc.py`, `ctrl.py`, `rig_relay.py`,
`local_relay.py`, and `esp_matter_light.patch` with the random-MAC workaround). The
full logs (DUT serial, controller, both relays) are in
`/workspace/.claude/mattersp/poc/run7/` on the dev container.

The PoC is option (c)'s image. It proves the protocol path, the chip's crypto timing
(PASE 0.3 s, the whole commissioning 3.0 s through the relay) and the heap profile.
It is not the shipping integration.

## 8. Commissioning without BLE

The lamp is already on Wi-Fi after Improv. Matter allows **on-network commissioning**:
the device advertises `_matterc._udp` with the commissioning window open, and the
QR / manual code says `DiscoveryCapabilities = OnNetwork`. That saves CHIPoBLE
(≈ 14 KB with BTP) and keeps one owner for the Wi-Fi credentials (Improv; the
"fresh join" rule). The catch: Apple Home and Google Home support on-network
commissioning, but their programmes may expect BLE for Wi-Fi devices that are not yet
on a network (not verified). A lamp that is always onboarded through the Splanc app is
always on the network first. Needs checking against each ecosystem's current rules
(M4).

## 9. Mapping On/Off and Level onto lamp power

The lamp-power work (branch `agent/lamp-touch-power`, `docs/design/lamp-power.md`
there; protocol arms `set_power` 130, `get_power` 131, `set_power_config` 132, push
`power_state` 70) is the seam. On-lamp Matter calls the same state machine
(`firmware/power`, `Machine::request`) that `set_power` does, with a new request
source `MATTER`. It uses the same mapping as the bridge (PR #600,
`agent/src/bridge/matter.ts`), so a lamp behaves the same through either path.

| Matter | Lamp | Notes |
| --- | --- | --- |
| OnOff `On` / `Off` / `Toggle` | `Request { on, instant: false, duration_ms: 0, source: MATTER }` | plays the configured ON/OFF transition (FADE or EFFECT); a reversal mid-transition stays smooth |
| OnOff attribute `OnOff` | `PowerState.on` (the target) | reported on every `power_state` change, touch taps included |
| `OnWithTimedOff`, `OnTime`, `OffWaitTime` (Lighting feature) | a timer in the Matter glue that issues an `Off` request | the light device type requires the Lighting feature |
| `OffWithEffect` | `Off` with the configured OFF transition | Matter's dying-light/fade variants all map to our transition |
| `StartUpOnOff` (null / 0 / 1 / 2) | `PowerConfig.boot` (0 last / 2 off / 1 on; 2 = toggle has no equivalent, so reject it with CONSTRAINT_ERROR or add it to the boot enum) | persisted by the power config, not by Matter |
| Level `CurrentLevel` 1..254 | `set_brightness(level / 254)` | `levelOf` / `brightnessOf` exactly as `matter.ts` |
| `MoveToLevel(transitionTime)` | `set_brightness` now; `transitionTime` (1/10 s) ignored at first | a brightness ramp in the render path is a small follow-up |
| `MoveToLevelWithOnOff` to the minimum | `Off`; from off to a level: `On` then the level | the "with on/off" commands drive power |
| `OnOffTransitionTime`, `OnTransitionTime`, `OffTransitionTime` | `PowerTransition.duration_ms` (× 100) for the ON / OFF transition | |
| `OnLevel` (nullable) | the brightness to turn on at (null = the previous) | |
| `Move` / `Step` / `Stop` | slider gestures: integrate in the glue, then `set_brightness` | |
| Identify `Identify(time)` | brightness dips for `time` seconds, then the brightness is restored: what the agent's `identify_player` does from the client side (`agent/src/session.ts`), done in the glue | the firmware has no identify arm today |

Reports: every `power_state` the lamp pushes (`lm_power_push_due` /
`lm_power_build_push`) also marks the Matter attributes dirty, so subscriptions get
touch taps and app changes within one report interval.

## 10. Owner decisions

1. **Go ahead with M0 (the size diet) now?** It frees about 185–235 KB with no Matter
   code. Options: *yes (recommended)* / after the mesh settles / no.
2. **How to close the last 75–120 KB for Matter** (§5.2). Options: *trim rs-matter to a
   lamp's needs (recommended first)* / grow the app slot with a one-time partition
   migration / ship Matter as an opt-in image.
3. **Commissioning transport.** Options: *on-network only at first, BLE (CHIPoBLE) in
   M3 if an ecosystem needs it (recommended)* / BLE from the start.
4. **Matter + mesh at the 2048-LED max config.** Options: *one shared arena for the
   two feature states (recommended)* / mutually exclusive at max LEDs / cap LEDs when
   both are on.
5. **Fabric count.** Options: *5 (the spec minimum, needed for certification;
   recommended)* / 2–3 for an uncertified first release (saves RAM).
6. **Rust toolchain bump to ≥ 1.92** for the whole firmware (needed by rs-matter).
   Options: *yes, as its own PR before M2 (recommended)* / pin an older rs-matter
   release that builds with 1.85, if one exists (not checked).

## 11. Risks and open questions

- rs-matter is young (v0.4.1) and not certified. How much of the Matter test harness
  it passes needs checking before M2. Budget time for conformance fixes.
- IPv6 multicast through home APs (snooping, multicast-to-unicast) is where Matter
  devices fail in the field. M4 has to test on real APs, not only the rig's
  hostapd.
- The group-addressed-TX rule (§5.2) has to be root-caused, not worked around.
- Our CHIP numbers (§3) come from IDF v5.5.5 + esp-matter v1.5 with their own
  sdkconfig, not our frozen v5.5.4 SDK. The difference is small next to the gap.
