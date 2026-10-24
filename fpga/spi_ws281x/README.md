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

CSR map: `0x00` = `num_ports` (1..MAX_PORTS), `0x01` = `led_type`, which selects the
latch (reset LOW) length: 0 = `RESET_NS` (classic WS2812/WS2812B, > 50 µs; the
Tang Nano top uses 80 µs), 1 = `RESET_ALT_NS` (default 300 µs, for
WS2812B-V5 / SK6812-class parts that need ≥ 280 µs).

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
  zero resource cost (latency `+PREFILL × 10 µs`). A frame shorter than `PREFILL`
  bytes per port still starts: once CS ends with data buffered, the FSM emits
  it.
- `FIFO_DEPTH` (bytes per port, `0` = full frame) decouples the FIFO from
  `MAX_LEDS`, so a 1024-LED port fits one BSRAM (2048 B) as long as `r ≲ 3`.

## Back-to-back frames (120 fps) and self-instrumentation

- **Latch-safe FIFO.** Bytes of the next frame that arrive during the current
  frame's latch wait in the FIFO and emit right after it. The FIFOs are flushed
  only at the end of a latch with no new STREAM in progress, and the round-robin
  demux realigns at every STREAM start. Before this, the end-of-latch flush
  silently dropped such bytes. A next CS landing a few µs early (pacing jitter at
  a 120 fps cadence) lost the first bytes per port: found by
  `spi_ws281x_120fps_sim` at 268 LEDs, 300 µs latch.
- **Pacing is still the host's job.** A frame that starts while the previous one
  is still _emitting_ joins it and loses the latch between them (asserted in
  `spi_ws281x_120fps_sim` phase D). Frame period ≥ `3L × 9.963 µs` (+ ~40 µs
  prefill latency) + latch. At 120 fps that is ≤ 274 LEDs/port at an 80 µs latch
  and ≤ 267 at 300 µs. Double-buffered FIFO banks would remove the constraint:
  two 810 B banks fit one 2048 B BSRAM at 270 LEDs.
- **`STATS = 1`** (on in the 20-port top) adds outputs, cumulative since reset:

  - `underrun`: a strobe whenever a FIFO runs dry mid-frame;
  - `underruns`: a saturating total;
  - `port_underruns`: per-port 8-bit counts;
  - `min_fill`: the lowest active-FIFO level seen while streaming;
  - `max_byte_gap`: the longest byte-to-byte interval with CS low, in core
    clocks. Subtract one byte (`8 × f_clk / f_SCK`) to get the host's pause.

  The SPI slave has no MISO, so there's no read-back yet. The 20-port top shows a
  sticky underrun flag stretched to 100 ms on `led[1]`, which any analyzer rate
  (or a human) can see, and folds the counters into the kept XOR. A CSR
  read-back over MISO (needs a pin) is the production follow-up. With it, the
  player could report underruns.

## Measured Pi 3 SPI continuity (rig-1, `pi-ledmapper-1`, #369 image)

`//pi/hitl/harness:spi_continuity` ran 2026-10-24 with SCK 6.17–6.24 MHz (the
4-port player; ≈ 3.9 samples per cycle at the FX2's 24 MS/s, the valid region),
pauses counted when CLK is held ≥ 1 µs:

- **391 STREAM transfers, 3.2 KB → 61 KB** (1,080 → 20,480 LEDs), each a single
  CS-low spidev transfer.
- **Zero pauses ≥ 1 µs inside any transfer**, so no stall and no latch, against
  both the PREFILL = 2 threshold (20 µs) and PREFILL = 64 (640 µs).
- The only gaps are the CS-high gap between the player's per-frame CSR write and
  its STREAM: 5–100 µs, growing with frame size. Those are outside the frame.
- Assumption, not tested here: intra-transfer pauses are a DMA/software
  property, independent of SCK. The player's SCK is fixed by `--fpga-ports`, so
  3.2 vs 6.4 MHz couldn't be compared. At 20 ports the SCK (~24 MHz) is beyond
  the analyzer; there the core's `STATS` (underruns, `max_byte_gap`) is the
  check.
- Rig wiring: CS is **D1** and MOSI **D5** (the station doc had them swapped;
  fixed).

## Internal-only 20-port variant (`tangnano9k_20p_top.v`, NOT for flashing)

For sign-off of a 20-output MAX before the WS pin map is chosen.
`//fpga/spi_ws281x:spi_ws281x_tangnano9k_20p`: 20 ports × 1024 LEDs, 2048 B FIFO per
port, 54 MHz core. It has **no WS output pins**: all 20 outputs are XOR-folded
into a registered bit on onboard `led[0]` (with the STATS counters; `led[1]` =
underrun flag), so every port's logic reaches a real
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
