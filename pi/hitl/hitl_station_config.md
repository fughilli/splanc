# HITL station configuration

A snapshot of the physical HITL bench: the reservation rigs, the DUTs wired to
each, the shared FX2 logic-analyzer taps, and the addresses/MACs the tooling
depends on. This is **live-hardware state**, not something the build reproduces —
keep it in sync when boards are added, moved, or re-cabled.

Last verified: 2026-09-01.

## Rigs

Three reservation rigs, each a Raspberry Pi running `hitl-managerd`, on the
tailnet under tag `tag:splanc-hitl`. Reachable as `<rig>` (tailnet) or
`<rig>.local` (LAN). Deploy with `bazel run //pi/hitl:update -- <rig>`.

| Rig          | Board            | Tailnet IP       | FX2 analyzer                | BT dongle (RTL8851BU) | Provisioning AP                               |
| ------------ | ---------------- | ---------------- | --------------------------- | --------------------- | --------------------------------------------- |
| `hitl-rig-1` | Raspberry Pi 5   | `100.99.64.43`   | **yes** — taps splanc-max-2 | yes (`0bda:b851`)     | ssid `hitl-rig-1`, psk `hitl-rig-1-provision` |
| `hitl-rig-2` | Raspberry Pi 5   | `100.107.245.18` | **yes** — taps its two C6s  | yes (`0bda:b851`)     | ssid `hitl-rig-2`, psk `hitl-rig-2-provision` |
| `hitl-rig-3` | Raspberry Pi 3B+ | `100.85.115.53`  | no                          | yes (`0bda:b851`)     | ssid `hitl-rig-3`, psk `hitl-rig-3-provision` |

Notes:

- **FX2 analyzer** is a Saleae-clone FX2 (`0925:3881`) on the rig's USB. The daemon
  ships sigrok on every image and **self-gates on the FX2 being present at
  runtime** (`analyzer.FX2Present`) — there is no build-time analyzer flag. The
  legacy `SBC_ANALYZER` value in `/var/lib/sbc/profile` is **vestigial**: rig-1's
  says `0` but it has an FX2 and the analyzer is live.
- **BT dongle** is the RTL8851BU (Realtek `0bda:b851` after CD-ROM modeswitch).
  All rigs carry one; the daemon always prefers a USB BLE controller at runtime
  (`--ble-adapter usb`, falls back to onboard) because the Pi 5 onboard controller
  is marginal for LE. No `SBC_BT_DONGLE` flag.
- All three rigs run the same daemon build (identical hermetic store path).

## DUTs

### ESP32-C6 (USB)

Auto-discovered from `/dev/serial/by-id/*`; the DUT name is `c6-<serial-suffix>`,
sku `esp32c6`. Each advertises Improv-over-BLE as `Led Widget <suffix>`; the BLE
MAC is the board's base MAC + 2 and is read from serial at flash time (not static
config). An FX2-tapped C6 additionally advertises `logic-analyzer-led-strip`.

| Rig   | DUT         | FX2 tap (channel)   |
| ----- | ----------- | ------------------- |
| rig-1 | `c6-123170` | — (not tapped)      |
| rig-1 | `c6-2ce684` | — (not tapped)      |
| rig-2 | `c6-003f08` | **D6** (ws2812)     |
| rig-2 | `c6-fa0324` | **D7** (ws2812)     |
| rig-3 | `c6-117d10` | — (no FX2 on rig-3) |
| rig-3 | `c6-fa3304` | — (no FX2 on rig-3) |

### LED-Mapper Pis (network DUTs, LAN-attached to rig-1)

Raspberry Pi 3B+ boards running the unified Rust player, reached over the LAN
(`kind: network`, pin-only). Registered on **rig-1** via
`/var/lib/hitl/network-duts.json`. SSH uses the _LED-Mapper_ deploy key
(`pi/provisioning/secrets/deploy_key`), not the rig key.

| DUT              | Host         | Addr                 | BLE MAC             | Tang Nano 9K (FPGA)          | FX2 tap                                | Caps                                                               |
| ---------------- | ------------ | -------------------- | ------------------- | ---------------------------- | -------------------------------------- | ------------------------------------------------------------------ |
| `pi-ledmapper-1` | splanc-max-2 | `splanc-max-2.local` | `B8:27:EB:64:D2:20` | **yes** (FT2232 `0403:6010`) | D0/D2/D4/D6 (LED 0–3) + D1/D3/D5 (SPI) | improv, led-strip, spi-fpga, **logic-analyzer-led-strip**, wss-app |
| `pi-ledmapper-2` | splanc-max-1 | `splanc-max-1.local` | `B8:27:EB:63:E8:18` | **no** (not attached)        | —                                      | improv, led-strip, spi-fpga, wss-app                               |

Notes:

- **splanc-max-2** is the FPGA test rig: a Tang Nano 9K is wired on SPI, and the
  rig-1 FX2 taps **both** ends of the chain — all four FPGA LED outputs **and** the
  SPI wire feeding the Tang. The physical wiring (8-channel FX2, per the
  `fpga_ws281x` harness defaults):

  | FX2 channel | Signal                    |
  | ----------- | ------------------------- |
  | D0          | FPGA LED output channel 0 |
  | D2          | FPGA LED output channel 1 |
  | D4          | FPGA LED output channel 2 |
  | D6          | FPGA LED output channel 3 |
  | D1          | SPI MOSI (Pi → FPGA)      |
  | D3          | SPI CLK                   |
  | D5          | SPI CS                    |
  | D7          | (spare)                   |

  It's the only DUT that satisfies `fpga_ws281x` (needs `spi-fpga` + `led-strip` +
  `logic-analyzer-led-strip`). The persisted channel map only records `D0`
  (ws2812) — enough to grant the `logic-analyzer-led-strip` cap; the harness drives
  the full topology above via `--ws-channels D0,D2,D4,D6` / `--spi-channels`
  (`clk=D3,mosi=D1,cs=D5`) at capture time, decoding the LED outputs as `ws2812`
  and the SPI wire as `spi-raw`.

  **Why splanc-max-2 advertises no `logic-analyzer-spi` cap (and the SPI wire tap
  is unused):** the FX2/fx2lafw samples at 24 MHz, but the player drives the SPI at
  6.4 MHz — only ~3.75 samples/bit, below the ~4 samples/bit sigrok needs for a
  clean SPI decode. So the raw-SPI STREAM cross-check is **gated off by default**
  (`--check-spi-stream`), the persisted channel map leaves the SPI channels out,
  and the daemon never derives `logic-analyzer-spi` for splanc-max-2. The WS2812
  outputs (well within the FX2's rate) are decoded instead and prove the FPGA
  received the correct SPI stream. Re-enable once the tap is sample-rate-aware —
  lower the test SPI clock, or use a faster analyzer.

- **splanc-max-1 has no Tang attached right now.** It still advertises `spi-fpga`
  because that cap comes from the `led-mapper-pi` SKU (the whole Pi fleet is
  modelled as FPGA-capable), but with no FPGA it can only serve `improv` / `wss`
  work. It exists mainly to give `improv_e2e_led-mapper-pi` a second Pi so it no
  longer contends with `fpga_ws281x` for splanc-max-2. **TODO:** attach a Tang, or
  make the FPGA a genuinely per-DUT capability (seed override) so a Tang-less Pi
  doesn't advertise `spi-fpga`.
- Both Pi BLE MACs are the RPi3 onboard controller (`B8:27:EB` OUI). These are the
  values seeded as `HITL_DUT_BLE_MAC` and used to pin Improv provisioning to the
  right Pi — keep them accurate (a stale/swapped MAC cross-provisions the wrong
  board once both Pis are up).

## Re-seeding the network Pis

`network-duts.json` is runtime state under `/var/lib/hitl` — wiped on a rig
reflash. Re-apply with (from a tailnet host):

```sh
bazel run //pi/hitl:seed_network_dut -- hitl-rig-1 \
    --name pi-ledmapper-1 --addr splanc-max-2.local \
    --sku led-mapper-pi --ble-mac B8:27:EB:64:D2:20
bazel run //pi/hitl:seed_network_dut -- hitl-rig-1 \
    --name pi-ledmapper-2 --addr splanc-max-1.local \
    --sku led-mapper-pi --ble-mac B8:27:EB:63:E8:18
```

The daemon ingests the file within a few seconds (no restart). Use the `.local`
address (the daemon resolves it host-side via nss-mdns before injecting the IP
into the reservation container).

## FX2 analyzer channel maps

Persisted per rig at `/var/lib/hitl/analyzer-channel-map.json` (editable at
runtime via `//pi/hitl/harness:map_la`). Determines which DUTs advertise a
`logic-analyzer-*` capability and how a capture decodes.

- **rig-1**: `pi-ledmapper-1 → D0 (ws2812)`; default `D6 (ws2812)`. This is only
  the persisted default (enough for the `logic-analyzer-led-strip` cap) — the
  physical FX2 taps splanc-max-2 on all four LED outputs (D0/D2/D4/D6) plus the SPI
  wire (mosi=D1, clk=D3, cs=D5); the `fpga_ws281x` harness selects those per capture
  (see the LED-Mapper Pi notes above).
- **rig-2**: `c6-003f08 → D6 (ws2812)`, `c6-fa0324 → D7 (ws2812)`.
- **rig-3**: none (no FX2).

The capability is granular by the tapped signal: a `ws2812` tap yields
`logic-analyzer-led-strip`, an `spi`/`spi-raw` tap yields `logic-analyzer-spi`.
