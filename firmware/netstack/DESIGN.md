# Heapless WiFi + BLE + coexistence stack — design

A `no_std`, allocation-free network stack for the ESP32-C6: 802.11 (STA/AP MLME
plus RX/TX), BLE (HCI/L2CAP/ATT/GATT and the GAP peripheral role), a static
WiFi/BT coexistence arbiter, and a small bounded HTTP server for the AP role. All
memory is fixed and sized at compile time; the protocol parsers are bounded by
their input.

## Goals and principles

1. **Zero allocation after init.** Every buffer, pool, and table is `static` and
   sized at compile time. `#![no_std]`, no `alloc`. The RX / parse / reassembly
   path never allocates.
2. **Capacity-typed buffers.** Every buffer is a `Buf<const N: usize>` whose
   capacity is part of its type. Appends are bounds-checked and return
   `Err(Overflow)` rather than overrunning — the write API _is_ the bounds check.
3. **Bounded parsers.** IE / TLV / PDU iterators are total functions over a byte
   slice: each step is bounded by the remaining length, with no pointer
   arithmetic past the end. Malformed input yields `Err`/`None`, never an
   out-of-bounds read.
4. **Fixed pools, back-pressure not overflow.** RX and TX frames land in fixed
   rings of `MAX_FRAME`-sized slots; exhaustion drops or refuses frames (bounded,
   observable), it never corrupts or grows the heap.
5. **Static tables.** The AP station table and the GATT attribute table are fixed
   arrays, so an association flood or a burst of ATT requests is bounded
   back-pressure, not memory growth.
6. **Deterministic memory.** Total RAM is a compile-time constant — the sum of
   the pools — with no fragmentation. It can be audited with `size`.

## Module layout

| Module        | Role                                                               |
| ------------- | ------------------------------------------------------------------ |
| `rx`          | Core primitives: `Buf<N>`, `IeReader`, `MAX_FRAME`.                |
| `ieee80211`   | 802.11 RX parse: beacon/IE parsing, MBSSID reconstruction, defrag. |
| `mac`         | Static RX descriptor ring + frame dispatch over `regs::mac`.       |
| `tx`          | Static TX buffer pool over the per-queue TXQ registers.            |
| `mlme`        | STA and AP management state machines (auth/assoc).                 |
| `ble`         | HCI-ACL / L2CAP reassembly and ATT PDU parsing.                    |
| `gap`         | BLE peripheral: GAP advertising + a fixed GATT server.             |
| `coex`        | Static WiFi/BT priority arbiter with bounded anti-starvation.      |
| `http`        | Bounded HTTP/1.1 request parse + response builder (AP role).       |
| `stack`       | Top-level integration of the WiFi and BLE paths under `coex`.      |
| `regs`        | ESP32-C6 MAC/PHY register map and low-level access primitives.     |
| `phy`, `lmac` | PHY and lower-MAC hardware bring-up (in progress).                 |

### The RX/parse path

```text
radio DMA ─▶ [fixed RX slot ring: N × MaxFrame]
                    │  (no alloc; drop-on-full)
                    ▼
             IeReader<'a>  (bounded iterator over the frame's IE bytes)
                    │
                    ▼
   per-feature parse into fixed structs (BeaconInfo, MbssidProfile, …)
                    │  reconstruction writes into a Buf<MAX_FRAME>,
                    ▼  every append checked → Err(Overflow) instead of overrun
             deliver / scan-list (fixed-capacity)
```

The MBSSID reconstruction reads the transmitted IEs and the non-transmitted
profile through bounded `IeReader`s and appends each element into a
`Buf<MAX_FRAME>` via `buf.push_ie(id, body)?`. That call returns `Err(Overflow)`
the instant the total would exceed the buffer, so the capacity bound is enforced
by the type rather than by a hand-written check.

## Coexistence

Both radios share one antenna. Each presents a priority
(critical > management > data > idle); the arbiter grants the medium to the
higher priority and applies a bounded starvation boost, so a steady
high-priority stream on one radio cannot lock the other out for more than
`STARVE_LIMIT` slots. The arbiter is a small fixed-state machine — no heap, no
unbounded state.

## Validation

The protocol logic is host-tested: each module carries unit tests for its
bounded parsers, role state machines, ring back-pressure, and the coexistence
arbiter (including oversized-input and table-full cases that must return
`Err`/refuse rather than overrun).

The stack is also exercised on-target through three example roles under
`examples/`, each driven end-to-end through the real `stack::Stack` seam as
RISC-V code on an ESP32-C6:

- **BLE peripheral** (`ble_peripheral`) — advertise, then handle an ATT write to
  a characteristic and confirm the stored value.
- **STA client** (`sta_client`) — connect, receive AUTH, receive ASSOC_RESP, and
  reach the Associated state.
- **AP webserver** (`ap_webserver`) — accept a station (AUTH → ASSOC_REQ), then
  serve `GET /` with a bounded HTTP 200.

Each example reports a simple pass/fail result over the serial console.
