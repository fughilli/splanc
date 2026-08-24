# The HW-crypto TX seam (WiFi-MAC inline CCMP encrypt)

Status: **open**. HW inline _decrypt_ works; HW inline _encrypt_ is not reachable
from our heapless direct-submission TX path. This documents the seam — where the
from-source driver meets the vendor blob — what was reverse-engineered, everything
that was tried, and the chosen way forward, so it can be revisited later.

Last updated: 2026-08-24. Branch `claude/heapless-netstack`. Relevant commits:
`22fdaafb`, `4281f42e`, `3fbfb906` (and the diagnostics/sniffer added around them).

## TL;DR

- Goal: a fully heapless, from-source ESP32-C6 WiFi stack (MAC/MLME/WPA2/CCMP in
  our own Rust/C++), using the **WiFi MAC's dedicated inline CCMP engine** for
  crypto so the AES acceleration is on the datapath.
- **RX (decrypt) works** on silicon with our own key install + the vendor
  `hal_crypto_enable`. **TX (encrypt) does not**: a protected frame we submit via
  our own lldesc/PLCP0 DMA path is _silently dropped before transmission_ (0 on
  the air, verified with an over-the-air sniffer).
- Root cause (reverse-engineered from `libpp.a`, confirmed on silicon): the MAC
  only runs the TX-crypto engine for frames that flow through the **vendor TX
  submitter `ppTxPkt` → `ppProcTxSecFrame`**, which requires a non-NULL
  station/node pointer at `esf_buf+0x2c` (built by the vendor association
  machinery). Our direct submission never engages the TX-crypto engine at all.
- Decision (owner): keep the MAC inline engine and bridge TX through `ppTxPkt`
  with a **minimal, statically-constructed `esf_buf` + node struct** — partial,
  contained vendor coupling for the final TX hand-off only. Our MLME / 4-way /
  key derivation stay in source. (Reversal of the `ppTxPkt` ABI + `esf_buf`/node
  layout was in progress when this was written.)
- Fallback that works today: all-software CCMP (crypto engine OFF). Verified
  end-to-end: 4-way → DHCP lease → ping → TCP.

## What the seam is

Our driver owns everything up to the frame bytes: PHY bring-up (vendor blob),
continuous STA RX without promiscuous, auth/assoc, the WPA2-PSK 4-way handshake,
PTK/GTK derivation, and CCMP encap/decap logic. For crypto we want the MAC's
inline engine (key table at `0x600A_5800`, control at `0x600A_4800..4818`) rather
than software AES.

The seam is the **TX submission boundary**:

```text
  our MLME/CCMP  ─────────────────────────────►  bytes on the air
                        │
        (A) our path:   ns_mac_send → TxRing (tx.rs) → lldesc + PLCP0 arm
        (B) vendor path: ppTxPkt → ppProcTxSecFrame → lmacTxFrame → PLCP0 arm
```

- Path (A) transmits **non-secure** frames perfectly (probe/auth/assoc/EAPOL and
  arbitrary data all go out and are ACKed). It is what M1/M2/M3 were built on.
- Path (A) with a **protected** frame does **not** engage the TX-crypto engine:
  the frame is dropped pre-TX. Only path (B) runs TX-encrypt.

So the seam question is: can we get inline TX-encrypt while keeping (A), or must
we bridge to (B)?

## Reverse-engineering findings (from `libpp.a`)

All in `/workspace/esp32-reverse` (objects in `targets/esp32c6/`, Ghidra decomp in
`out/pp/decomp/*.c`, `out/net80211/decomp/*.c`). Disassembled with
`riscv32-esp-elf-objdump` (rv32imac). Four RE passes.

1. **`desc.word0 bit29 (0x20000000)` is the FTM (Fine Timing Measurement)
   timestamp bit, NOT a "secure" flag.** `lmacTxFrame` gates `wDev_ftm_set_t1t4`
   on it. We had been setting it as the encrypt trigger; that made the HW attempt
   FTM on a data frame and drop it. (`tx.rs` `TX_SEC` is now `0` with a note.)

2. **The encrypt indicator is the 802.11 Protected FrameControl bit**, propagated
   by `ppTxProtoProc` (`ppTxProtoProc@00010286.c`) into an `esf_buf` flag — there
   is **no manual descriptor crypto bit** to set. Key selection is address-based:
   the HW matches the outgoing frame's **addr1 (RA)** against a per-slot MAC in
   the key table (RX matches addr2/TA). Our slot 4 (MAC = BSSID) is a correct
   pairwise PTK and is picked automatically — _if the frame reaches the engine_.

3. **The drop gate.** `ppProcTxSecFrame@00014136.c` (called by `ppTxPkt`) returns
   1 (→ `ppTxPkt` recycles/drops the frame) when the frame is protected AND
   `*(esf_buf + 0x2c) == 0`. `esf_buf+0x2c` is the **station/node ("rc-sched")
   pointer**, also consumed by `rcGetSched(*(esf+0x2c), *(esf+0x34))` and
   `lmacSetTxFrame` (which reads `node+0x86`, checks `== 1`). It is _not_ an
   "authorized/assoc" flag; it is the node object the vendor builds during
   association. This is the exact coupling our heapless MLME skips.

4. **`ic_set_sta_auth_flag` is a dead no-op** on this build (`wDev_SetAuthed` is a
   bare `ret`). Do not chase it.

5. **No per-TX crypto register write exists.** The whole crypto block
   (`0x600A_4800/4804/4810/4814`, key table `0x600A_5800+slot*0x28`) is one-time
   setup, shared for RX and TX, address-keyed. `hal_crypto_enable(vif, alg, …)`
   for CCMP writes `0x4800`(vif0)/`0x4804`(vif1)=`0x80030103`, `0x4810 |=
0x3FFFC0`, and the valid bit `0x4814 |= (1<<slot)`. This is exactly our
   working RX-decrypt state.

6. **`ic_set_vif(vif,0,mac,type,p5,0)` tears down crypto** — its `param_6==0` path
   tail-calls `ic_disable_crypto(vif,0)` → `hal_crypto_disable` (resets
   `0x4800→0x30000`, clears the valid bit). Our continuous-RX bring-up calls
   `ic_set_vif(0,0,OUR_MAC,0,0)`; this is only safe because key install runs
   _after_ it. Do not re-invoke `ic_set_vif(...,0)` after key install, or pass a
   non-zero `param_6` to skip the teardown.

## Feasibility of the vendor-`ppTxPkt` bridge

All required functions are **exported `T` symbols in `libpp.a`** (so callable from
firmware, same as the `wDev_Insert_KeyEntry` / `ic_set_vif` / `hal_crypto_enable`
we already call):

- Submit: `ppTxPkt`, `ppProcTxSecFrame`, `ppTxProtoProc`, `lmacSetTxFrame`,
  `lmacTxFrame`, `rcGetSched`, `ppMapTxQueue`, `ppFetchTxQFirstAvail`,
  `ppDequeueTxQ`, `ppEnqueueTxDone`, `ppCalTxopDur`.
- Buffers: `esf_buf_alloc`, `esf_buf_alloc_dynamic`, `esf_buf_setup`,
  `esf_buf_setup_static`, `esf_buf_free_static`, `esf_buf_recycle`. So there is a
  **vendor esf_buf pool** (initialized by our existing `esp_wifi_start`) — we can
  allocate a real, correctly-initialized `esf_buf` and only fill in our frame +
  node pointer, rather than hand-building the struct.

Planned integration (pending the ABI reversal):

1. `esf_buf_alloc(...)` a TX buffer; copy in our protected QoS frame (24/26-byte
   header w/ Protected bit + 8-byte CCMP header + cleartext payload).
2. Point `esf_buf+0x2c` at a **static minimal node struct** with `node+0x86 = 1`
   and whatever MAC/keyidx/AC fields the TX/rate path reads (being reversed).
3. Set the AC/queue + length fields, then call `ppTxPkt`.
4. Keep HW decrypt on the RX side (already working) → full inline-crypto datapath.

The remaining unknowns (in flight): exact `ppTxPkt` signature, the full `esf_buf`
field layout, the minimal node-struct fields, and any global lmac/queue state our
bring-up must initialize first.

## Everything tried on the direct path (all verified 0-on-air)

Each was flashed to a DUT (rig-3) and checked with an over-the-air sniffer on an
adjacent rig; none put a protected frame on the air:

- Descriptor `bit29` set (the FTM bug — actively harmful).
- Descriptor `bit29` removed; rely on the Protected FC bit + enabled engine.
- Crypto arming variants: `0x4804 |= bit31`, `0x4810 = 0x3FFFC0`, vs the vendor
  steady-state `0x4804=0x30000 / 0x4810=0`; and calling `hal_crypto_enable`
  directly (its atomic sequence) vs raw register pokes.
- Key config: forced vendor `0x086c` word1 vs the natural `wDev` `0x0970`; slot 4
  vs also slot 0; PN replay words zeroed. (Slot 4 confirmed a valid pairwise PTK.)
- Frame format: non-QoS (24-byte hdr) vs QoS (26-byte hdr); CCMP header pre-filled
  (SW PN + keyid 0x20) with the 8-byte MIC reserved in-buffer vs. length=size+8.
- Descriptor length: `size` vs `size+8` (MIC); PLCP1 length ± the 8-byte MIC.
- The 8-byte hardware TX-header extra fields (`byte2` seq nibble, `bytes4-5` frag
  headroom) that `ppProcTxSecFrame` fills.
- Submission via `ns_mac_send` (normal) vs `ns_mac_send_sec` (secure descriptor).

Result in every case: `ppProcTxSecFrame`'s gate isn't even in our path, and the
raw MAC engine does not encrypt/emit a directly-submitted protected frame — it is
dropped before transmission.

### The misleading TX status

`0x600A_54E8` low-16 decodes via `lmacProcessTxComplete`'s jump table:
`(status>>12)&0xf` → 0 = `lmacProcessTxSuccess`, 4 = `lmacProcessTxError` (inner
code 4 = `lmacProcessAckTimeout`), etc. We saw `0x4010` (ack-timeout) after secure
sends and briefly believed the frame was transmitted-then-unACKed. It was **stale**
— latched from a transmitted-but-unACKed _bogus_ probe on the same queue; the
dropped secure frames write no fresh completion status. The over-the-air sniffer
(below) is the source of truth: the secure frames are simply never emitted. The
genuine crypto-reject code `0xC0` (`lmacProcessTxseckiderr`) was never seen either.

## Diagnostic tooling (kept for the revisit)

- **`examples/wifi_hw_rx_test.cpp`** — a channel-6 promiscuous sniffer (v2):
  unfiltered (`WIFI_PROMIS_FILTER_MASK_ALL`, incl FCS-fail), matches our OUI
  `02:0c:6a` in any address field, logs FC / protected bit / rate / payload, and
  flags AP Deauth/Disassoc + reason. Flash it to a _second_ adjacent rig to watch
  the DUT-under-test's TX. It reliably catches our non-secure frames; that it
  catches _zero_ protected frames is the proof of the pre-TX drop.
- **`ns_tx_desc_word0()`** (FFI) + **`TxRing::desc_word0()`** — read back the TX
  descriptor after the HW processed it.
- **`dump_txstat()`** in `wifi_sta_own.cpp` — dumps the queue-0 status block
  (`0x54E0/E4/E8/EC/F0/F4/B8/BC`).

### HITL recipe (learned the hard way)

- Rigs **reflash a baseline image on reservation teardown**, so a released DUT
  reverts and a released sniffer is wiped. To watch TX: hold the sniffer's lease
  (`hitl flash --keep --id <id>`), or run the sniffer flash in the background and
  boot the DUT fresh so its 4-way EAPOL happens under the sniffer's watch.
- Use a **unique `/tmp` bundle name per flash** — the flasher scps to
  `/tmp/<basename>` and collides across concurrent users.
- CLI: `bazel cquery --output=files //pi/hitl/cmd/hitl:hitl`. Rigs:
  rig-3 = AP + DUT (`http://hitl-rig-3:8087`), rig-2/rig-1 = sniffer.

## Alternatives (if the `ppTxPkt` bridge is later unwanted)

- **Standalone AES-128 peripheral** driving `ccmp.rs`: our CCMP logic (nonce/AAD/
  CTR/CBC-MAC) calls the C6's dedicated AES engine for the block ops. HW-
  accelerated, fully in-source, no vendor coupling, both directions. This is the
  cleanest "HW crypto, heapless, from source" — the WiFi-MAC inline engine is
  effectively decrypt-only for a from-source driver.
- **All-software CCMP** (current fallback, crypto engine OFF): proven reliable,
  4-way → DHCP → ping → TCP. mbedtls already uses the HW AES engine for the TLS
  layer above this.
