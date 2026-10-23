# spi_ws281x — streaming SPI → WS281x FPGA core

Translates an SPI byte stream into multiple WS281x (WS2812/NeoPixel) drive
signals. It **streams**: emission starts once every active port has `PREFILL`
bytes buffered (default 2), and the ports drive while the SPI transfer is still
arriving. Each port has an **elastic FIFO in block RAM** (default depth one full
frame, `MAX_LEDS × 3` bytes = 1659 B for the default 553 LEDs — one BSRAM per
port), so a host that clocks SPI faster than the strips drain can never overflow
it and never underflows it once started. The number of active ports is
**runtime-configurable** over SPI (a small CSR bank), and `led_type` is reserved
for future non-WS281x timings.

(Earlier revisions of this README said the core needs "only ~2 bytes of buffer
per port". That described the original double-buffer design; the current core
has the per-port BSRAM FIFOs above. The 2 bytes are now only the start-of-frame
prefill.)

Built with [rules_fpga](https://github.com/fughilli/rules_fpga) (yosys / nextpnr /
apicula / Verilator), brought in via `git_override` in the root `MODULE.bazel`.

## Modules

- `spi_slave.v` — byte SPI slave (mode 0, MSB first), 2-FF input synchronizers.
- `spi_ctrl.v` — decodes the per-transaction opcode and routes bytes.
- `csr.v` — control registers (`num_ports`, `led_type`).
- `ws281x_stream.v` — round-robin demux + per-port elastic BSRAM FIFO + one lockstep
  WS281x timing FSM driving all active ports.
- `spi_ws281x.v` — top wrapper (slave → ctrl → {csr, stream}).
- `tangnano9k_top.v` — Tang Nano 9K top: 27 MHz → Gowin `rPLL` → 54 MHz → core.

## SPI protocol

Each transaction begins on CS-low with a 1-byte opcode:

| opcode           | meaning                                                                                       |
| ---------------- | --------------------------------------------------------------------------------------------- |
| `0x01` WRITE_CSR | `addr` byte, then value byte(s) → `csr[addr]`, `csr[addr+1]`, …                               |
| `0x02` STREAM    | remaining bytes = round-robin pixel data (byte `i` → port `i mod num_ports`); CS-high latches |

CSR map: `0x00` = `num_ports` (1..MAX_PORTS), `0x01` = `led_type` (0 = WS2812).

**Round-robin layout** is what makes streaming work with bounded per-port buffers: the host
must deliver ≥ `num_ports` bytes per WS byte-time (one per port), i.e. SPI runs at
least `num_ports`× a single driver's byte rate. Send order:
`p0b0 p1b0 … p(N-1)b0 | p0b1 …`.

## Build / test / flash

```sh
bazel test  //fpga/spi_ws281x:all                     # Verilator: slave, core, full path
bazel build //fpga/spi_ws281x:spi_ws281x_tangnano9k   # -> .fs bitstream (rPLL + core)
bazel run   //fpga/spi_ws281x:spi_ws281x_tangnano9k_flash          # SRAM load
bazel run   //fpga/spi_ws281x:spi_ws281x_tangnano9k_flash -- -f    # persistent SPI flash
```

Waveforms (per rules_fpga): each `*_sim` also exposes `.trace` / `.surfer` /
`.wavepeek`, e.g. `bazel run //fpga/spi_ws281x:spi_ws281x_sim.wavepeek -- info`.

The Pi side that talks to this over SPI is `pi/player_rs` (`wire::FpgaCodec`,
`sink::SpidevSink`).

## FIFO sizing, SPI rate and gaps

With SPI delivering bytes `r ×` faster than the strips drain (`r = SPI bit rate /
(num_ports × 8 / byte_time)`, byte time ≈ 9.96 µs at 54 MHz incl. the 2-cycle
POP/LOAD), each port's FIFO peaks at about `frame_bytes × (1 − 1/r) + PREFILL`.

- **`r < 1` underruns.** A FIFO that empties mid-frame parks the line low in
  `S_WAIT` until a byte arrives. Short stalls stretch a bit; a stall longer than the
  WS latch (> 50 µs on WS2812B; some clones latch after ~6–9 µs) **splits the
  frame**.
- **Gaps are only dangerous at the start of a frame.** Once streaming at `r > 1`
  the FIFO builds a lead of `(1 − 1/r)` per byte sent, so a mid-frame SPI pause of
  hundreds of µs is absorbed. Right after the start the only slack is `PREFILL`
  bytes ≈ `PREFILL × 10 µs`. Raising `PREFILL` buys start-of-frame gap tolerance at
  zero resource cost (latency `+PREFILL × 10 µs`). Caveat: the FSM only starts a
  frame once every active port has `PREFILL` bytes _while CS is low_, so a frame
  shorter than `PREFILL` bytes per port never starts. Keep `PREFILL` ≤ the
  smallest frame, or add a "start on CS-end with data" condition (one LUT) first.
- `FIFO_DEPTH` (bytes per port, `0` = full frame) decouples the FIFO from
  `MAX_LEDS`, so a 1024-LED port fits one BSRAM (2048 B) as long as `r ≲ 3`.

## Internal-only 20-port variant (`tangnano9k_20p_top.v`, NOT for flashing)

For sign-off of a 20-output MAX before the WS pin map is chosen.
`//fpga/spi_ws281x:spi_ws281x_tangnano9k_20p`: 20 ports × 1024 LEDs, 2048 B FIFO per
port, 54 MHz core. It has **no WS output pins**: all 20 outputs are XOR-folded
into a registered bit on onboard `led[0]`, so every port's logic reaches a real
pin and survives synthesis/P&R (`tangnano9k_20p.cst` = clock + SPI + LEDs only).
**Do not flash it**: it has no pin map. The in-tree 8-pin `tangnano9k_top`
target is unchanged.

Place-and-route (yosys 0.55 + nextpnr-himbaechel 0.9, GW1NR-9C, `--freq` = core
clock; `scaling_report.sh`):

|           ports | LEDs/port |       FIFO B/port | core MHz |           LUT4 |            DFF |      ALU |     BSRAM |                             fmax MHz |
| --------------: | --------: | ----------------: | -------: | -------------: | -------------: | -------: | --------: | -----------------------------------: |
| 8 (in-tree top) |       553 |              1659 |       54 |      1269/8640 |       647/6480 |      686 |      8/26 |                                 74.7 |
|               8 |      1024 |              2048 |       54 |            972 |            647 |      696 |      8/26 |                                 88.7 |
|              16 |      1024 |              2048 |       54 |           1776 |           1159 |     1296 |     16/26 |                                 78.2 |
|          **20** |  **1024** |          **2048** |   **54** | **2145 (25%)** | **1415 (22%)** | **1614** | **20/26** |                             **83.1** |
|              20 |       553 |              1659 |       54 |           2522 |           1415 |     1614 |     20/26 |                                 76.7 |
|              20 |      1024 |              2048 |       81 |           2274 |           1415 |     1574 |     20/26 |                  70.7 — **fails 81** |
|              20 |      1024 | 3072 (full frame) |       54 |              — |              — |        — |  needs 40 | **does not place** (BSRAM exhausted) |

Per port: +64 DFF, ~+95 LUT4, +1 BSRAM — linear 8 → 16 → 20, so no port was
optimised away. fmax varies a few MHz run to run with placement; every 54 MHz
configuration closes with ≥ 20 MHz margin, but the core does **not** close at 81
MHz, so a faster SPI front end would need the slave on its own SCK clock domain,
not a faster core clock.

`spi_ws281x_20p_sim` (Verilator, SCK asynchronous to the core clock): 20 ports ×
1024 LEDs, every byte on every port bit-exact, every high pulse exactly T0H/T1H,
every bit period PERIOD (+2 at byte boundaries), `num_ports` write of 25 clamps
to 20, ports ≥ `num_ports` (13) never go high, no overflow. Sweeps (54 MHz core):

|           SCK MHz |                  r | result                                                           |              peak FIFO B |      stalls |
| ----------------: | -----------------: | ---------------------------------------------------------------- | -----------------------: | ----------: |
|    13.5 / 15 / 16 | 0.84 / 0.93 / 1.00 | **underrun** (bit gaps up to 3.2 / 2.0 / 1.3 µs)                 |                     7–10 | ~3000/frame |
|              16.7 |               1.04 | pass                                                             |                      120 |           0 |
|                18 |               1.12 | pass                                                             |                      333 |           0 |
| 20 / 24 / 26 / 27 |          1.25–1.68 | pass                                                             | 607 / 1018 / 1176 / 1246 |           0 |
|                30 |               1.87 | **fails** (SPI slave can't sample SCK at < 2 core clocks/period) |                        — |           — |

| SPI pause (SCK 18 MHz) | where                   | PREFILL | result                                   |
| ---------------------- | ----------------------- | ------: | ---------------------------------------- |
| 10 µs / 20 µs / 60 µs  | right after frame start |       2 | ok / 10 µs low / **50 µs low → latches** |
| 20 µs – 1 ms           | mid-frame / late        |       2 | absorbed (no stall)                      |
| 300 µs / 600 µs / 1 ms | right after frame start |      64 | ok / ok / **372 µs low → latches**       |

So for 20 ports the host must clock SPI between ~16.7 and ~27 MHz (≥ 16.06 Mbit/s
drain + margin; the 2-FF SPI slave at a 54 MHz core tops out between 27 and 30
MHz) and must not pause within `PREFILL × 10 µs` of a frame's start.

To pin it out: add `ws[19:0]` to the top, 20 `IO_LOC`s to a `.cst`, and drop the
XOR fold. Check Tang Nano 9K header I/O availability (the in-tree map uses pins
70–77, SPI 25–27, LEDs 10–16) before choosing.
