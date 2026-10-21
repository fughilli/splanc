# Per-device TLS identity (netstack player)

Every ESP32-C6 netstack player generates its **own** EC P-256 key and self-signed
certificate on first boot, persists both in littlefs, and serves wss:443 with them.
Clients pin each device's certificate by device id on first sight (trust on first use,
like SSH `known_hosts`).

## Why

Until this change every netstack image served one shared certificate (`CN=heapless`,
no SAN) whose **private key was in the open-source firmware**
(`netstack_transport.cpp`, `TLS_KEY`). Anyone could impersonate any device, and the
manifest's `tls.cert_sha256` pin was the same for every device, so it proved nothing.

## History: the vendor build already did this, and raced

The vendor (esp_https_server) build had per-device keys since FUG-90 (#67): a key
generated on first boot and kept in NVS, plus `reissue_cert_for_lan()` /
`ledmapper_selfsign`, which re-signed a cert with the **LAN IP in its SAN** after each
WiFi join (FUG-66, #41). That design hit several problems, all of which come from
re-issuing the cert at runtime:

| Problem | Cause | Vendor fix |
| --- | --- | --- |
| `:443` stayed down until reboot (`ESP_ERR_HTTPD_TASK` 0xb008) | Re-issue meant `httpd_ssl_stop()` then `wss_start()`. The old server task's 28 KB stack is freed asynchronously by the idle task, so the new task couldn't get a contiguous 28 KB block, even with 70 KB+ free. | `delay(200)` plus a retry from `loop()` |
| Browsers rejected the cert (`-0x7780`) | The first re-sign failed under early-boot heap pressure (~4.8 KB free) and left the SAN-less build-time cert in place. A later DHCP change also left a stale IP in the SAN. | `g_cert_ip` reconcile every 5 s |
| BLE link dropped mid-provisioning | The re-sign and soft-AP teardown blocked the core long enough to kill the central's link. | Deferred `sta_demote_pending` |
| Fragmented heap | boot cert → demote → wss restart churn | 05547ae9 (WIP): STA-only, start wss once |
| Rename stranded `:443` / rotated the cert | A rename re-issued (hostname SAN) and restarted the server. | Rename no longer re-issues. |
| Browsers re-prompted for trust | Every IP change made new cert bytes. | None |

The common cause was that the cert depended on runtime state (the IP and the
hostname), so it had to be replaced on a running server, at the moments when the heap
and the radio were busiest.

## Design

**Identity never changes at runtime.** The cert is a pure function of the key and the
immutable factory MAC:

- **CN** is the device id (the BT MAC, `AA:BB:CC:DD:EE:FF`), `O=splanc`.
- **SAN** is only `DNS:splanc-<last 6 hex of MAC>.local`. That is the host label the
  mDNS responder already advertises (`firmware/mdns` `host_label`). There is no IP SAN,
  so a DHCP change never needs a re-issue, and the pinned hash is stable for the
  device's life. A SAN exists at all because browsers ignore CN; a SAN-less cert was a
  hardening risk. Clients that connect by raw IP still meet a self-signed cert, which
  they must trust or pin either way; an IP SAN wouldn't remove that prompt (see the
  trust-UX notes).
- **Serial** is 128 random bits. With a fixed serial, Firefox hard-fails with no
  override (`SEC_ERROR_REUSED_ISSUER_AND_SERIAL`) when a factory reset gives the same
  issuer a new cert under the same serial.
- **Validity** runs 2025-01-01 to 2049-12-31. The device has no RTC, and validity is
  judged by the client's clock. Basic constraints are CA:false, key usage is
  `digitalSignature`, EKU is `serverAuth`.

**Generated before the radio carries traffic.** `setup()` calls
`device_cert_begin()` after `improv_ble_begin()` and before `netstack_setup()`:

- The BT controller is up, so `esp_fill_random` is a true RNG.
- The render task hasn't started.
- No WiFi association, DHCP lease or `:443` listener can exist yet. The earliest a
  client can connect is after BLE/serial provisioning, then association, the 4-way
  handshake and DHCP: seconds later.

So the vendor "listener started before keygen finished" race can't happen; the order
is structural. Keygen runs on loopTask, the same task as the TLS server, so the ECC,
MPI, SHA and AES peripherals are never shared with a concurrent handshake. (A
background task would also have raced the netstack's raw HW-AES CCMP path.)

**Gated listener.** As defence in depth, `netstack_loop` opens `:443` only once
`g_tls_setup` is true, meaning the identity is parsed into mbedtls and
`mbedtls_ssl_setup` succeeded. The state machine is in `device_cert_core.h` and is
host-tested:

```text
kBooting --stored blob valid--> kReady
         --missing/corrupt----> kGenerating (attempt now)
kGenerating --ok--> kReady (persisted = the write landed)
            --fail-> kGenerating, retry after 1, 2, 4 … 30 s
kReady --mbedtls rejects the parsed key/cert--> kGenerating
```

While not ready:

- `:443` is closed: SYNs go unanswered and no handshake ever starts.
- The mDNS TXT `tls=generating` is advertised.
- `get_tls_info` (over BLE as well as wss) answers `state: "generating"`.

A failed `mbedtls_ssl_setup` (a TLS-region allocation) is retried every second, so
`:443` can't be stranded closed until reboot.

**Persisted atomically.** The key DER, the cert DER and a CRC32 go in one blob,
`/lfs/tls_id.bin`. It is written through `fs_write_file`: temp file, then
fflush + fsync, then rename. littlefs rename is a single metadata commit (#198), so a
reset mid-write leaves the old file or the new one, never a torn one. A blob that fails
magic, version, length or CRC regenerates. With littlefs unavailable, the identity is
RAM-only for that boot (`persisted: false`, which clients don't treat as an attack).

**Factory reset.** A full erase regenerates the identity: `hitl-flash --erase-fs`
(esptool `--erase-all`), `esptool erase_flash`, or a littlefs reformat. So does
anything else that loses `/lfs/tls_id.bin`.

## Timing and memory (ESP32-C6, measured)

Measured on hitl-rig-2 (`bazel run //pi/hitl/harness:device_cert`):

- **First boot**: keygen + self-sign (HW ECC) = 82 ms; persist (littlefs write +
  fsync + rename of the 570 B blob) = 10 ms. The blob records the keygen time, so
  later boots log it too ("first-boot keygen+sign took 81 ms").
- **Later boots**: load + validate = 6 ms.

Both run once, in `setup()`, before WiFi. `netstack_setup()` alone spends about 1.2 s
on its RX sanity loop, so the device doesn't become usable noticeably later.

Memory:

- **Steady-state heap: unchanged.** The DER buffers (~0.9 KB) and the keygen
  temporaries are heap allocations that live only until the TLS server has parsed its
  own copies; then they are freed (the key bytes are zeroized). The parsed cert/key
  replace the parsed baked ones (same curve, ~60 B more DER for the SAN/EKU/KU
  extensions). The keygen temporaries come from the shared heap at the top of
  `setup()` (it's at its largest then) or, on a retry, from the TLS region (idle,
  since no handshake can run while not ready).
- **Static RAM: +184 B .bss** (179,952 → 180,136 B; .data unchanged): the state
  machine, the device id, the hash hex and the Rust side's `TlsInfo` copy.
- **IRAM: unchanged (99,704 B).** The writers are flash text: +26.8 KB `.flash.text`
  (X.509/PK/ASN.1 writers, ECP keygen), +1.3 KB rodata.
- **Stacks: unchanged pins.** `stack_bound_test`: the keygen path
  (`device_cert_begin`) is bounded at 4.4 KB. loopTask's worst case is still the TLS
  handshake path (8,816 B of the 14,336 B reserved). The `firmware/sysmode` cost model
  (`PINNED_WORST`, `IRAM_TEXT`) doesn't move: the identity adds no mode-dependent
  memory.

## Surfaces

- **`GET /.well-known/splanc.json`**: `tls: {cert_sha256, state, persisted}`.
- **`get_tls_info` → `TlsInfo{state, cert_sha256, persisted}`** (new ledmapper.v1
  arms 45/24, feature `tls_info`). It answers over the BLE player transport too, so a
  client learns readiness and the pin before wss exists.
- **mDNS TXT**: `tls=generating|ready`.
- **Serial log**:
  - `[tls] generated per-device identity in N ms …` on first boot;
  - `[tls] loaded per-device identity in N ms …` on later boots;
  - `TLS init: setup ok (per-device identity, sha256=…, persisted=1)`.

## Client trust model

**Agent bridge (Node, `agent/src/trust.ts`): cryptographic TOFU.**

- Whatever identifies a player (its /ws session's Welcome MAC, or a manifest's
  `device.id`), the bridge judges the fingerprint of the cert that very connection
  presented, never a claim about it.
- The first fingerprint for a device id is stored in `hub.json` `players[id].pin`.
  Later connections are pinned to it.
- A different cert for a known id is refused with an explanation. `list_players` shows
  `tls: CHANGED`, and `trust_player` (CLI `trust-player`) re-trusts it after the user
  confirms a factory reset.
- A manifest naming a cert other than the presented one is refused as interception.
- Pins are keyed by id, never by host: an IP can move between devices.

**Web app (`web/src/net/deviceTrust.ts`): advisory TOFU.** The browser owns the TLS
handshake and the per-certificate trust exception, so the app sees the hash the device
reports (`get_tls_info`), not the handshake's. That reliably detects a factory reset
or a different device under a known MAC, and the device sheet warns with a "trust the
new certificate" action. The cryptographic check in the browser is its own
per-certificate exception, which a changed cert re-triggers. The pins live in
localStorage (`ledmapper.certPins`).

**Upgrades from shared-cert firmware.** The first boot of the new image finds no
`/lfs/tls_id.bin` (the old image never wrote one) and generates. A client whose pin
for that id is the legacy shared hash
(`9a2b1729debfa516f1b3a5ade76df3a3332b97868ed667f89298ffc574a1d641`) re-pins silently;
no warning, because the shared key was public anyway. The hash is kept in sync in
`device_cert_core.h`, `trust.ts`, `deviceTrust.ts` and
`pi/hitl/harness/device_cert_core.py`.

## Tests

Host tests:

- `//firmware/player_app:device_cert_core_test`: blob round trip, every truncation,
  every flipped bit, the SAN label and the state machine (gating, backoff, wrap, a
  rejected install).
- `agent_surface` / `agent_manifest` (Rust): `TlsInfo`, the manifest `tls` block and
  the mDNS TXT key.
- `//agent:trust_test`: first sight; a factory reset refused, then re-trusted; legacy
  re-pin; manifest/presented mismatch; waiting for `tls=generating`.
- `//web:deviceTrust_test`.

Hardware:

- `bazel run //pi/hitl/harness:device_cert` (one DUT per run) covers erase-fs first
  boot, a connect storm from the instant of the lease, the manifest and `TlsInfo`, and
  a reboot that must load the same cert. `--compare` checks that two DUTs hold
  different certs.
- The e2e's manifest check now also asserts `tls.state == ready`, `persisted` and
  not-legacy on every hitl run.
