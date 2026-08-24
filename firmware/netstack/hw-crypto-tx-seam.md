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
  with a **vendor-allocated `esf_buf` + a minimal, statically-built TRC context**
  — partial, contained vendor coupling for the final TX hand-off only. Our MLME /
  4-way / key derivation stay in source. The full `ppTxPkt` ABI, `esf_buf` layout,
  and the minimal TRC struct are reversed and recorded below — this is
  implementable; it was left as documented-not-built per the owner's "revisit
  later" call.
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
   `*(esf_buf + 0x2c) == 0`, also consumed by `rcGetSched(*(esf+0x2c), *(esf+0x34))`
   and `lmacSetTxFrame` (which reads `+0x86`, checks `== 1`). It is _not_ an
   "authorized/assoc" flag. **`esf_buf+0x2c` is the TRC (Tx Rate Control) context,
   NOT the association node** (final RE below) — which is what makes a
   statically-built minimal struct viable rather than needing vendor association
   state. This is the coupling our direct-submission path skips.

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

## The `ppTxPkt` bridge ABI (reversed)

Full reversal from `libpp.a` / `libnet80211.a` (decomp under
`/workspace/esp32-reverse/out/{pp,net80211}/decomp/`). **Key correction to earlier
notes: `esf_buf+0x2c` is the TRC (Tx Rate Control) context, a ~0x90-byte struct —
NOT the `ieee80211_node`.** That is what makes a statically-built minimal struct
viable: we do not need the vendor association node, only a mostly-zeroed TRC.

### `ppTxPkt` signature and flow

```c
bool ppTxPkt(esf_buf_t *eb /*a0*/, int do_arm /*a1*/);
```

`eb` is the sole data input (queue, TRC, frame, flags all live inside it);
`do_arm=1` also pushes the HW queue / signals the pp task (`ic_tx_pkt` uses `1`).
Flow (`ppTxPkt@00014358.c`): `ic_interface_enabled(txdesc.w4>>19 & 1)` — drop if
the interface bit is clear → `ppTxProtoProc(eb)` (sets txdesc word0 data/mgmt bits
from the real FC byte) → `ppProcTxSecFrame(eb)` (**sets `txdesc.word0 |= 0x20000000`
= inline-CCMP-encrypt when `eb+0x2c != 0` and the Protected FC path is taken**;
returns 1 → frame dropped/recycled) → `rcGetSched(eb+0x2c, eb+0x34)` (no-op if
`eb+0x2c==0`) → `ppMapTxQueue(eb)` (AC/TID → HW queue into txdesc w4[23:20]) → link
into `_pTxRx` pending list, stamp `txdesc+0x18 = *0x600AD000` (MAC timer) → if
`do_arm` and `lmacIsIdle(queue)`, submit / signal the pp task (actual HW arm is in
`lmacTxFrame → lmacSetTxFrame` off the pp task).

Note `txdesc.word0 |= 0x20000000` here (the esf txdesc's encrypt indicator) is a
_different word_ from the raw lldesc bit29=FTM in §RE-1 — the confusion between the
esf `txdesc` and the HW `lldesc` is exactly what made bit29 look like "secure".

### `esf_buf` layout (header 0x90B, embedded 0x48B HW txdesc at +0x48, frame at +0x90)

Fields the TX path reads/writes (from `esf_buf_alloc@0001024a.c` + the helpers):

- **+0x04** `*hdr` ptr — `[0].word0` gets bit 0x20000000 on encrypt; `[1]` = frame data ptr.
- **+0x10** payload base — `= eb+0x90` (dynamic); copy the frame here.
- **+0x14** `hdrlen` u16 — 802.11 header len (0x18 non-QoS / 0x1a QoS).
- **+0x16** `payloadlen` u16 — body length; `ProcTxSecFrame` uses `(payloadlen+hdrlen)-8`.
- **+0x1a** `pool_type` u8 — 1 = data-TX pool.
- **+0x24** `qos_flags` u16 — bit13 (0x2000) = "QoS/CCMP 8 bytes inserted".
- **+0x2c** `trc` ptr — rate-control ctx (see below); must be non-NULL to encrypt.
- **+0x30** `next` ptr — pending-list link (ppTxPkt owns).
- **+0x34** `txdesc` ptr — embedded HW desc at `eb+0x48`.
- **+0x48** `hw_txdesc` — word0 ctrl (bit3 data, bit0x20000000 encrypt, bit0x8000
  hdr-present); word1 low-nibble=frametype, bits[7:4]=queue-class; word4 bit19=if-id,
  bits[23:20]=HW queue; +0x18 timestamp; +0x30/31 rate.

### The TRC context at `+0x2c` (~0x90B) — minimal fields to clear the gate

Written normally by `ieee80211_set_tx_desc` via `ic_get_trc`; readers on the TX
path: `rcGetSched` (`+0x0c` flags, `+0x08/09` fixed-rate, `+0x64/68/6c` sched-table
ptrs, `+0x86` phymode), `ppProcTxSecFrame` (`+0x82` u16 length budget), `ppMapTxQueue`
(`+0x0c` bit7, `+0x84` index), **`lmacSetTxFrame` (`+0x86 == 1` — the gate)**. A
statically-allocated, mostly-zeroed 0x90 struct suffices:

```c
uint8_t trc[0x90] = {0};
*(uint16_t*)(trc+0x0c) = 0x80;          // bit7 = no adaptive rate ctrl (fixed sched, queue 7)
*(void**)   (trc+0x64) = &BasicOFDMSched;   // sched-table ptrs (resolve libpp symbols;
*(void**)   (trc+0x68) = &BasicOFDMSched;   //   or &DAT_00012cb0 BasicSched / rc11BSchedTbl)
*(void**)   (trc+0x6c) = &BasicOFDMSched;
*(uint16_t*)(trc+0x82) = 0x600;         // generous length budget (>= frame)
trc[0x84] = 0;                          // index
trc[0x85] = 0;                          // interface (0 = STA)
trc[0x86] = 1;                          // *** REQUIRED gate ***
// +0x21..0x26 = peer MAC (BSSID) only needed if routing completion through vendor
```

Load-bearing minimum: `+0x86=1`, non-null `+0x2c`, and valid sched-table pointers
at `+0x64/68/6c` so `rcGetSched` doesn't fault. `rcUpdateTxDone` (completion) reads
more fields but can be skipped if we own TX completion ourselves.

### Allocation + call sequence

Use the vendor pool (`esp_wifi_start` initializes it) rather than hand-building:

```c
esf_buf_t *eb = ic_ebuf_alloc(&trc, 1 /*data-TX pool*/, hdrlen + bodylen);
if (!eb) return; // pool full = bounded back-pressure
memcpy(*(void**)((char*)eb + 0x10), frame, hdrlen + bodylen); // Protected QoS + CCMP hdr + cleartext
*(uint16_t*)((char*)eb + 0x14) = hdrlen;
*(uint16_t*)((char*)eb + 0x16) = bodylen;
*(void**)   ((char*)eb + 0x2c) = &trc;
*(uint16_t*)((char*)eb + 0x24) |= 0x2000; // if the QoS/CCMP 8 bytes were inserted
ppTxPkt(eb, /*do_arm=*/1);
```

For a fully-heapless variant, mirror the static FG pool wiring (`esf_buf_setup_static`,
`type=10`): one 0x90 header + one 0x48 txdesc, `eb+0x34=&desc`, `eb+0x10=payload`,
`eb+0x0c=1` (refcnt), `eb+0x1a=type`, rest zero, and own the completion (skip
`esf_buf_recycle`).

### Global state ppTxPkt needs (verify our bring-up has it)

`_pTxRx` (lmac TX/RX ctrl block), `_our_instances_ptr` (per-queue instances),
`_g_osi_funcs_p` + `_g_intr_lock_mux`/`_g_wifi_global_lock` (OS-shim locks/queues,
**required**), `_xphyQueue` + `pp_sig_cnt[]` (pp-task signalling), the esf_buf pools
(`esf_buf_setup`), the TRC subsystem (`rcAttach`/`trc_init` from `lmacInit`), and the
interface-enabled bit (`ic_interface_enabled(if)==1`). All of these are set up by the
vendor `lmacInit`/`esp_wifi_start` we already run — the open risk is whether our
custom continuous-RX bring-up leaves the **interface-enabled bit** and `_pTxRx`
per-queue list heads in the state `ppTxPkt` expects. That is the first thing to
check when implementing.

### Why this should encrypt

(a) the frame carries the real 802.11 Protected FC bit → `ppTxProtoProc` classifies
it and `ppProcTxSecFrame` sets `txdesc.word0 |= 0x20000000`; (b) `eb+0x2c` (TRC) is
non-null with `+0x86==1` so `lmacSetTxFrame` accepts + arms it. The HW then selects
key slot 4 (MAC==BSSID) from the frame addresses — the same slot our decrypt path
already validated.

Decomp index (under `/workspace/esp32-reverse/out/`): `pp/decomp/{ppTxPkt@00014358,
ppProcTxSecFrame@00014136, ppTxProtoProc@00010286, ppMapTxQueue@00013f50,
lmacSetTxFrame@00010182, lmacTxFrame@00010cae, lmacInit@00010426, rcGetSched@00011e72,
rcUpdateTxDone@00010f72, esf_buf_alloc@0001024a, ic_ebuf_alloc@00010222,
esf_buf_setup@00010700, esf_buf_setup_static@000105bc, ic_set_trc@000105d2,
rc_enable_trc@0001277a, trc_init@000124ca}.c`; `net80211/decomp/{ieee80211_output_process@000142ae,
ieee80211_encap_esfbuf@00013bf0, ieee80211_set_tx_desc@00013880}.c`.

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
