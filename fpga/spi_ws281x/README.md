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
- `tangnano9k_top.v` — Tang Nano 9K top: 27 MHz → Gowin `rPLL` → 54 MHz → core
  (8 ports, pins 70–77).
- `tangnano9k_20p_top.v` + `tangnano9k_20p.cst` — the 20-port Splanc MAX top
  (20 pinned ports, 1024 LEDs/port, plus the `frame_done` pacing output).

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
bazel build //fpga/spi_ws281x:spi_ws281x_tangnano9k_20p  # 20-port MAX top (+ frame_done)
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
  two 810 B banks fit one 2048 B BSRAM at 270 LEDs. The `frame_done` output
  (below) tells the host exactly when it may start.
- **`STATS = 1`** (on in the 20-port top) adds outputs, cumulative since reset:

  - `underrun`: a strobe whenever a FIFO runs dry mid-frame;
  - `underruns`: a saturating total;
  - `port_underruns`: per-port 8-bit counts;
  - `min_fill`: the lowest active-FIFO level seen while streaming;
  - `max_byte_gap`: the longest byte-to-byte interval with CS low, in core
    clocks. Subtract one byte (`8 × f_clk / f_SCK`) to get the host's pause.

  The SPI slave has no MISO, so there's no read-back yet. The 20-port top shows a
  sticky underrun flag stretched to 100 ms on `led[1]`, which any analyzer rate
  (or a human) can see. Its counters have no path to a pin, so synthesis drops
  them there. A CSR read-back over MISO (needs a pin) is the production
  follow-up. With it, the player could report underruns.

## 120 fps strip cap: 260 LEDs per port

The 120 fps mode is capped at **260 LEDs per port** (owner decision), below the
theoretical 274 (80 µs latch) / 267 (300 µs latch). The wire sets the budget:
one WS bit is 67 core clocks = 1.2407 µs at 54 MHz, a byte 8 bits + 2 clocks of
POP/LOAD = 9.963 µs, an LED 29.89 µs.

| LEDs/port | emission | + prefill ~40 µs + latch 80 µs | + latch 300 µs | slack in 8.333 ms (80 / 300 µs) |
| --------: | -------: | -----------------------------: | -------------: | ------------------------------: |
|       274 |  8.19 ms |                        8.31 ms |     (> period) |                      ~20 µs / — |
|       267 |  7.98 ms |                        8.10 ms |        8.32 ms |                ~230 µs / ~15 µs |
|   **260** |  7.77 ms |                    **7.89 ms** |    **8.11 ms** |           **~440 µs / ~220 µs** |

At the cap the host keeps ≥ 220 µs per period at either latch for the
frame-done wake-up, the per-frame CSR write and scheduling jitter. At the limit
it would have ~15 µs, which Linux can't guarantee. The player enforces the cap
(`pi/player_rs` `wire::check_frame_rate`: above 60 fps, at most
`MAX_LEDS_PER_PORT_120FPS` = 260 LEDs per port; nothing above 120 fps).

## Frame-done pacing (`frame_done`)

`spi_ws281x` / `ws281x_stream` output `frame_done`, a registered level:

- **HIGH**: every active port has shifted out its frame **and** the latch
  (`RESET_NS` or `RESET_ALT_NS`, per `led_type`) has elapsed, and no STREAM is in
  progress. It rises 2 core clocks after the latch ends and is HIGH after reset.
- **LOW** from the start of the next STREAM (one byte after CS-low, when the
  opcode decodes). WRITE_CSR transactions leave it HIGH, so the per-frame
  `num_ports` write doesn't disturb it.
- If a STREAM started during the latch (latch-safe FIFO), it stays LOW: that
  frame starts at once.

On the 20-port top it drives pin **28**, wired to **Pi GPIO 22** (header pin
15). Both are 3.3 V (bank 2 is LVCMOS33), so it's a direct wire. **Confirmed
by the owner (2026-10-26)**: a dedicated GPIO, not in-band SPI status (no MISO
yet, and a status read costs a transfer per poll) and not FPGA double-buffering
(20/26 BSRAM used, no room for the general case).

**Wiring** (Pi 3/4/5 40-pin header ↔ Tang Nano 9K, whose header holes are
silk-labelled with the FPGA pin number):

| signal       | Tang Nano 9K       | Pi header            | notes                          |
| ------------ | ------------------ | -------------------- | ------------------------------ |
| `frame_done` | pin **28**         | pin **15** (GPIO 22) | optional 330 Ω series resistor |
| ground       | any header **GND** | pin **14** (or 20)   | run it beside the signal wire  |

The Pi requests the line with its pull-down, so an unwired GPIO 22 reads LOW
and never produces an edge. A wired Tang running gateware without `frame_done`
(the 8-port top) holds pin 28 HIGH (measured 2026-10-28). The gate then always
reads HIGH, which is effectively timed pacing.

### Pi side (`pi/player_rs`, pacing.rs / gpio_cdev.rs / rt.rs)

Rendering runs on its own thread, one frame ahead (see "Pipelined render"
below; `--pipeline off` restores the serial loop, which renders before step 1).
The output thread, per frame:

1. Sleeps to the frame's **absolute deadline** at `--fps`
   (`clock_nanosleep(TIMER_ABSTIME)`), so a short strip doesn't run faster than
   asked.
2. **Gates on `frame_done`**: it drains stale edge events and reads the level.
   If the line is HIGH it goes at once; otherwise it waits (`ppoll` on the GPIO
   v2 line-request fd) for the rising edge, for at most one period + max(¼
   period, 1 ms).
3. Takes the newest completed frame from the triple buffer (one atomic swap)
   and sends CSR + STREAM as **one `SPI_IOC_MESSAGE(2)`**: one syscall, CS
   deasserted between the two transfers (`cs_change`). `--spi-split` restores
   two writes.

- **Fallback:** 3 consecutive timeouts switch to **timed pacing**, with no edge
  waits, so an unwired board loses nothing per frame. Timed mode checks the
  line's event queue once a second and resumes edge pacing when edges appear.
  Each transition logs one line, rate-limited to one per minute per kind, with
  a count of suppressed repeats. On an unwired bench, the whole log is one line
  at start-up.
- **GPIO access:** raw GPIO uAPI v2 ioctls (`libc`). libgpiod is C and can't link
  into the static-musl player, and three ioctls didn't justify a new crate.
- **Chip selection:** `--frame-done-chip auto` picks the chip labelled
  `pinctrl-bcm2835` / `-bcm2711` / `-rp1`. The header's GPIO 22 is then the same
  on every Pi, including the Pi 5's gpiochip4 → 0 renumbering in 6.6.47.
- **Flags:** `--frame-done-gpio 22` (default; `none` disables it).
- **Kernel timestamps:** each edge event carries the kernel's IRQ-time
  `CLOCK_MONOTONIC` stamp. `--pace-stats S` reports `edge_to_wake` (IRQ → thread
  running) directly once wired.

**Userspace real-time.** No kernel driver and no PREEMPT_RT, by owner decision.

- **Output thread** (`--rt on`, default): `SCHED_FIFO` **45**, pinned to the
  last CPU (`--rt-cpu`). That is below the threaded IRQ handlers (FIFO 50) and
  the SPI pump it blocks on, and above everything else.
- **Memory:** `mlockall(MCL_CURRENT|MCL_FUTURE)`, only when it can't later trip
  RLIMIT_MEMLOCK. Otherwise a capped limit would fail the 8 MiB tokio stack
  mmaps.
- **SPI message pump:** the `spi0` kthread goes to `SCHED_FIFO` **46**, set by
  `chrt` in the unit's root `ExecStartPre`. The kthread is named after the
  controller device: `spi0` on the Pi 3/4 (spi-bcm2835) and on the Pi 5 (RP1
  DesignWare SPI). Since ~6.0 an uncontended `spi_sync` runs in the caller's
  context anyway.
- **systemd unit** (`apps.nix`): the player runs as `ledmapper` with ambient
  `CAP_SYS_NICE` + `CAP_IPC_LOCK` and `LimitMEMLOCK=infinity`, not as root. It
  no longer uses sbc-deploy's `realtime = true`, which put the **whole
  process** (WSS server and render pool too) at FIFO 50.
- **Optional:** `isolateOutputCpu` in `apps.nix` (default off) adds
  `isolcpus=3 irqaffinity=0-2`. It changes only the command line, not the
  kernel.

Verilator (`spi_ws281x_120fps_sim`): `frame_done` is never HIGH while any port
drives HIGH, and every rising edge comes ≥ one latch (and < latch + one bit +
8 clocks) after the last WS falling edge, in every phase. Phase E paces 20 ×
260 LEDs on the edge plus a modelled 100 µs host wake-up: 8/8 frames clean,
one edge per frame, periods **7.99 ms** (80 µs latch) and **8.21 ms** (300 µs),
both within 8.333 ms.

## Measured output-thread latency (rig-1, `pi-ledmapper-2`, 2026-10-26)

**Bench:**

- Pi 3B+, kernel 6.12.87 (`PREEMPT_VOLUNTARY`, `HZ=250`), schedutil governor.
- The production image, with the player service stopped and the bench binary
  run by hand.
- **The frame-done wire isn't fitted on this bench**, so every run is timed
  pacing after the one-line fallback.
- The STREAM is 20 ports × 66 LEDs (3,961 B), the largest that fits the default
  `spidev.bufsiz` 4096 as one CSR + STREAM message. MAX images set 65536 (#369).
- SCK is requested at 24 MHz, `--fps 120`.
- Each run is 7,200 frames (60 s), or 21,600 (180 s) when loaded, after 120
  warm-up frames.
- Load: 4 busy loops, plus a pipe copy, plus a page-cache reader (all
  SCHED_OTHER).
- Measured with `player --frames N`, Pi-side `CLOCK_MONOTONIC` stamps. µs as
  p50 / p99 / max:

| RT (`--rt`)                               | load   | timer wake late    | wake → SPI ioctl | CSR+STREAM ioctl    | frame period (min / p50 / p99 / max) |
| ----------------------------------------- | ------ | ------------------ | ---------------- | ------------------- | ------------------------------------ |
| off                                       | idle   | 84 / 91 / 256      | 0.2 / 0.2 / 6    | 1529 / 1565 / 1658  | 8163 / 8333 / 8344 / 8506            |
| **on**                                    | idle   | 29 / 35 / 71       | 0.2 / 0.2 / 6    | 1523 / 1571 / 1607  | 8292 / 8333 / 8347 / 8376            |
| off                                       | loaded | 146 / 4318 / 10303 | 0.2 / 0.6 / 51   | 1677 / 5686 / 12942 | 2066 / 8334 / 12327 / 18496          |
| **on**                                    | loaded | 83 / 236 / 622     | 0.2 / 0.6 / 24   | 1677 / 1997 / 2754  | 7785 / 8334 / 8470 / 8887            |
| **on**, load on CPUs 0–2 (≈ `isolcpus=3`) | loaded | 31 / 78 / 220      | 0.2 / 0.5 / 8    | 1595 / 1734 / 2728  | 8161 / 8334 / 8375 / 8515            |

What each column is:

- **Timer wake late:** how far past the absolute deadline the output thread
  runs (the cyclictest number, measured in the player's own thread).
- **Wake → SPI ioctl:** userspace handoff only. Render happens before the wait.
- **CSR+STREAM ioctl:** the whole combined transfer. The 3,961 B on the wire
  take ~1.52 ms at the Pi 3's ~20.8 MHz effective SCK.
- **Ioctl entry → CS assert:** not separable Pi-side. Its upper bound is the
  3-byte CSR ioctl in `--spi-split` runs (loaded): **46 / 183 / 317 µs with RT**,
  48 / 216 / 4,486 µs without.

Findings:

- **The RT settings are what keep 120 fps under load.** Without them, a busy CPU
  pushes the p99 period to 12.3 ms (frames slip a whole period) and the worst
  to 18.5 ms. With them, p99 is 8.47 ms and the worst 8.89 ms.
- **Idle, RT cuts timer wake-up by ~3×** (84 → 29 µs p50). An RT thread has no
  timer slack, while SCHED_OTHER gets 50 µs.
- **What's left under load is the kernel, not the player.** It's the
  non-preemptible kernel sections of the other tasks on CPU 3
  (`PREEMPT_VOLUNTARY`). Keeping them off CPU 3, as `isolcpus=3` would, cuts
  the worst wake from 622 to 220 µs. The userspace handoff is ≤ 24 µs worst
  case.
- **Edge → CS estimate (not measured; needs the wire):** GPIO IRQ → wake, plus
  wake → ioctl, plus ioctl → CS. The GPIO wake path (hard IRQ stamps the
  edge, the cdev's IRQ thread at FIFO 50 wakes the poller) should track the
  timer wake path plus one thread hop. Under load with RT, the estimate is about
  **0.25 + 0.001 + ≤ 0.18 ≈ 0.4 ms p99, ≤ ~1 ms worst**. With CPU 3 kept clear,
  about 0.25 ms p99.
  - That is around the 260-LED cap's 220–440 µs slack. With frame-done pacing a
    late wake **can't merge frames**: it only stretches that one period (8.33 →
    ~8.9 ms worst case).
- **Render time drops from 1.9 to 1.05 ms per frame with RT on** (mapping
  pattern, 1,320 LEDs). schedutil runs the CPU at its maximum frequency while
  an RT task is runnable. Render still happens on the output thread today: at
  20 × 260 that is ~4 ms of each 8.33 ms period at full clock. The planned
  triple-buffered render thread / GPU tier (#368 §11) moves it off.
- **Privilege model** (checked with `systemd-run` as `ledmapper`):
  - with ambient `CAP_SYS_NICE` + `CAP_IPC_LOCK`: FIFO 45, CPU 3 and mlockall
    all apply;
  - with no capabilities: each step logs one line and the player carries on
    (FIFO 45 → SCHED_OTHER, unlocked).
- **Fallback is quiet:** an unwired GPIO 22 costs three ~10 ms waits at start-up
  and one log line. With `--frame-done-gpio none` there are no waits at all.
- **spidev `bufsiz` and the combined message:** spidev rounds each transfer to
  `ARCH_DMA_MINALIGN` (128 B on arm64) before checking `bufsiz`. A 4,084 B
  CSR + STREAM pair therefore fails at 4096. The sink switches to two writes on
  the first `EMSGSIZE` and logs once. At MAX's 65536, every 20 × 1024 frame
  fits.

**Follow-up once the wire is fitted** (pin 28 → GPIO 22, plus ground):

1. Flash the 20-port bitstream (`:spi_ws281x_tangnano9k_20p_flash`) on an image
   with `spidev.bufsiz=65536` (#369).
2. Run `player --no-serve --fpga-ports 20 --start 5200 --fps 120 --frames 7200`
   (with `--rt on` and `--rt off`) and check the summary:
   - `edge` / `high` > 0 and `timeout=0`;
   - **`edge_to_wake`** is the measured IRQ → thread number;
   - `period` shows whether the 260-LED frames hold 8.33 ms.
3. On an analyzer, put pin 28 and CS on two channels (24 MS/s = 42 ns resolution).
   The interval from the rising frame-done edge to the next falling CS is the
   true edge → CS latency, which the Pi-side estimate above stands in for.

## Measured frame-done edge pacing (rig-1, `pi-ledmapper-1`, 2026-10-28)

**Bench:**

- `pi-ledmapper-1` (splanc-max-2, Pi 3B+, 6.12.87, `spidev.bufsiz` 65536, #369
  image). The wire is fitted: Tang pin 28 → GPIO 22, plus GND.
- The 20-port top was loaded into the Tang's **SRAM** for the run, then the
  deployed bitstream was restored. The service was stopped for the run.
- Player at `-c opt`, `--rt on`, spi0 pump at FIFO 46.
- Load is the same mix as the 2026-10-26 runs. µs, as min / p50 / p99 / max.
- The rig FX2 taps `frame_done` on **D7** and CS on **D1**.

| run                                  | load   | gates high / edge / timeout / timed | `edge_to_wake`        | frame period (min / p50 / p99 / max) |
| ------------------------------------ | ------ | ----------------------------------- | --------------------- | ------------------------------------ |
| 20 × 260 @ 120, edge                 | idle   | 6488 / 712 / 0 / 0                  | 21 / 27 / 49 / 73     | 7941 / 10362 / 11402 / 11889         |
| 20 × 260 @ 120, edge                 | loaded | 6440 / 760 / 0 / 0                  | 50 / 135 / 342 / 529  | 8005 / 10666 / 11350 / 12080         |
| 20 × 260 @ 120, timed (`none`)       | loaded | n/a                                 | n/a                   | 6815 / 10643 / 11198 / 14789         |
| 2 × 660 @ 60, every frame on an edge | idle   | 1 / 3599 / 0 / 0                    | 21 / 62 / 105 / 147   | 19909 / 19956 / 20015 / 20114        |
| 2 × 660 @ 60, every frame on an edge | loaded | 1 / 3599 / 0 / 0                    | 62 / 159 / 377 / 1281 | 19979 / 20111 / 20454 / 21210        |
| 20 × 66 @ 120, edge                  | idle   | 3600 / 0 / 0 / 0                    | n/a (never waits)     | 8108 / 8333 / 8352 / 8529            |
| 20 × 66 @ 120, edge                  | loaded | 3600 / 0 / 0 / 0                    | n/a (never waits)     | 7894 / 8335 / 8548 / 8762            |

The timed-mode reference is the 2026-10-26 loaded RT row: period 8334 / 8470 /
8887, timer wake 83 / 236 / 622.

**Logic analyzer**, `frame_done` rise → the next CS fall (that frame's
CSR + STREAM message):

- **2 × 660 @ 60, 200 frames:** 130 / 142 / 168 / 171 µs (min / p50 / p99 /
  max), all under 200 µs. One `frame_done` rise per frame, period 20.00 ms. That
  is the pure edge → wake → ioctl → CS chain.
- **20 × 260 @ 120, 293 frames:** p50 2.5 ms. This is render time, not wake
  latency: the next frame is still rendering when the edge arrives (below).
- **Inside the FPGA:** CS fall → `frame_done` fall takes 14–18 µs. `frame_done`
  is LOW for 7.866 ms at 260 LEDs (780 × 9.963 µs + the 80 µs latch), as
  modelled.

Findings:

- **The wire works and the fallback never fires:** 0 timeouts and 0 timed
  frames in every wired run. Edge → userspace is 27 µs p50 and 73 µs worst
  idle, and 135 / 342 / 529 µs loaded. Only the forced run, which waited on
  every one of 3,600 edges under load, saw a 1.28 ms worst case.
- **Overruns:** no period goes over 1.5× the nominal in any run at 20 × 66 or
  2 × 660.
- **20 × 260 @ 120 doesn't reach 120 fps on the Pi 3. The cap is the output
  thread, not the FPGA or the wire.** It runs at ~96 fps (10.4 ms) edge or
  timed, because the thread is serial:
  - render: 4.6 ms (mapping pattern, 5,200 LEDs);
  - SPI: 5.7 ms (15,601 B at 24 MHz);
  - together 10.3 ms, against the 8.33 ms period.
    The FPGA finishes in 7.87 ms. Moving render off the output thread leaves
    5.7 ms of SPI per 8.33 ms frame, which fits: done, see "Pipelined render"
    below (120.0 fps).
- **Gate cost when wired:** the drain and level read take 13–31 µs p50 per
  frame, against < 2 µs unwired. That is small next to the slack.
- **An old (8-port) bitstream holds pin 28 HIGH.** The pin is unused there, and
  GPIO 22 reads HIGH even with the Pi's pull-down. On D7 it stays HIGH. So a
  wired board running the old gateware gates "high" every frame, which is
  effectively timed pacing with no fallback log line. That's harmless, but
  "unconfigured reads LOW" above holds only for an unwired GPIO 22.

## Pipelined render (rig-1, `pi-ledmapper-1`, 2026-10-28)

The output thread no longer renders. A render thread renders frame N+1 while
the output thread sends frame N (`pi/player_rs` pipeline.rs, triple.rs):

- **Handoff:** a lock-free single-producer / single-consumer **triple buffer**
  (one `AtomicU8` = the middle slot's index + a FRESH bit). The render thread
  writes its back slot and publishes it; the output thread, right after the
  frame-done gate, takes the newest published slot. Neither side waits or
  touches the other's slot, so a frame being written is never sent (no
  tearing). The slots' vectors are reused and the encoder writes in place
  (`FpgaCodec::frame_into`, byte-identical to `frame`), so steady state
  allocates nothing.
- **Clock:** the output thread keeps it (absolute deadline + frame-done gate,
  as above). The render thread follows the output's deadline grid one frame
  ahead: the frame for deadline D starts rendering at D − period and samples
  the player for time D. Before starting, it waits (100 µs polls, at most half
  a period) until the output has taken the previous frame; otherwise a late
  output would get D+1's frame at D and then repeat it.
- **Lag beats cut-out:** if no new frame is ready, the output **re-sends the
  last one** on the normal frame-done clock (never black, never a stalled
  output; logged at most once a minute). After an overrun the render re-aims
  at the next deadline it can still make.
- **Player lock:** the render thread samples the player under its lock, then
  encodes outside it. The output thread never takes the lock: "frame shown"
  reports go to the render thread through a lock-free mailbox, and
  `record_frame_shown` now carries the real SPI time, not the deadline.
- **Threads:** render `SCHED_FIFO` **40** (below the output's 45, so a long
  render can't delay a frame-done wake), pinned to the CPU below the output's
  (CPU 2 on the Pi 3; 0–1 stay with the WSS server and IRQs). Both threads
  have explicit 4 MiB stacks (static musl defaults to 128 KiB). Flags:
  `--pipeline on|off` (default on), `--render-prio`, `--render-cpu auto|none|N`.

**Bench:** same rig, wire, load mix and method as the edge-pacing runs above:
20-port top in SRAM, service stopped, 3,600 frames per run (1,800 at 60 fps),
`--rt on`, spi0 at FIFO 46, mapping pattern as the render load. `off` is
the #370 serial loop in the same binary. fps = 1 / p50 period; µs.

| config                               | load   | pipeline |       fps | period min / p50 / p99 / max  | fresh / repeat | render p50 / p99 / max | CPU % (output / render / process) |
| ------------------------------------ | ------ | -------- | --------: | ----------------------------- | -------------- | ---------------------- | --------------------------------- |
| 20 × 260 @ 120, edge                 | idle   | off      |      93.7 | 7941 / 10671 / 11688 / 12199  | n/a            | 4911 / 5924 / 6426     | 44.5 / – / 44.5                   |
| 20 × 260 @ 120, edge                 | idle   | **on**   | **120.0** | 8304 / 8333 / 8351 / 8362     | 3480 / 0       | 4204 / 6331 / 7070     | 0.9 / 49.1 / 50.0                 |
| 20 × 260 @ 120, edge                 | loaded | off      |      91.0 | 8018 / 10989 / 11592 / 16577  | n/a            | 5042 / 5586 / 6035     | 44.7 / – / 44.7                   |
| 20 × 260 @ 120, edge                 | loaded | **on**   | **120.0** | 8016 / 8333 / 8442 / 9341     | 3480 / 0       | 4177 / 4359 / 4546     | 3.5 / 45.5 / 49.0                 |
| 20 × 260 @ 120, timed                | idle   | off      |      93.8 | 6688 / 10663 / 12228 / 15164  | n/a            | 4913 / 6473 / 9385     | 45.2 / – / 45.2                   |
| 20 × 260 @ 120, timed                | idle   | **on**   | **120.0** | 8118 / 8333 / 8351 / 8544     | 3480 / 0       | 4328 / 6793 / 7865     | 0.8 / 49.9 / 50.7                 |
| 20 × 260 @ 120, timed                | loaded | off      |      90.2 | 6857 / 11089 / 11632 / 12224  | n/a            | 5129 / 5599 / 6045     | 45.6 / – / 45.6                   |
| 20 × 260 @ 120, timed                | loaded | **on**   | **120.0** | 7508 / 8334 / 8464 / 9036     | 3480 / 0       | 4184 / 4340 / 6277     | 3.3 / 45.9 / 49.3                 |
| 20 × 66 @ 120, edge                  | idle   | off      |     120.0 | 8241 / 8333 / 8383 / 8429     | n/a            | 1116 / 1529 / 2226     | 13.8 / – / 13.8                   |
| 20 × 66 @ 120, edge                  | idle   | on       |     120.0 | 8303 / 8333 / 8347 / 8373     | 3480 / 0       | 1620 / 1669 / 1881     | 1.1 / 17.6 / 18.7                 |
| 20 × 66 @ 120, edge                  | loaded | off      |     120.0 | 7911 / 8334 / 8508 / 8744     | n/a            | 1223 / 1736 / 2070     | 17.3 / – / 17.3                   |
| 20 × 66 @ 120, edge                  | loaded | on       |     120.0 | 7641 / 8336 / 8484 / 9021     | 3480 / 0       | 823 / 952 / 1137       | 3.3 / 9.9 / 13.1                  |
| 2 × 660 @ 60, every frame on an edge | idle   | off      |      50.1 | 19910 / 19952 / 20007 / 20070 | n/a            | 1933 / 2058 / 2112     | 8.9 / – / 8.9                     |
| 2 × 660 @ 60, every frame on an edge | idle   | on       |      50.2 | 19875 / 19922 / 19966 / 19998 | 1680 / 0       | 1520 / 1646 / 1733     | 0.6 / 8.2 / 8.8                   |
| 2 × 660 @ 60, every frame on an edge | loaded | off      |      49.8 | 19986 / 20084 / 20351 / 21259 | n/a            | 1146 / 1533 / 1693     | 6.9 / – / 6.9                     |
| 2 × 660 @ 60, every frame on an edge | loaded | on       |      49.7 | 19979 / 20101 / 20486 / 21084 | 1680 / 0       | 821 / 946 / 1172       | 1.6 / 4.0 / 5.5                   |

(2 × 660 is wire-bound by design: 19.9 ms per frame, so ~50 fps either way.
Its edge → wake with the pipeline: 44 / 72 / 91 µs idle, 154 / 361 / 1041 µs
loaded (p50 / p99 / max), unchanged from the serial loop.)

**Logic analyzer,** 20 × 260 @ 120 idle, 2 s captures of D7 (`frame_done`)
and D1 (CS):

- **Pipelined:** 240 `frame_done` rises = **120.0 fps on the wire**, rise
  period 8.300 / 8.333 / 8.382 ms (min / p50 / max), 0 CS periods > 1.5×.
  `frame_done` rise → CS fall is 406 / 438 / 475 / 484 µs (min / p50 / p99 /
  max): the FPGA now finishes 0.44 ms before the 8.33 ms deadline, so the
  deadline, not the edge, starts each frame.
- **Serial:** 192 rises = 96.0 fps, rise period 7.94–12.21 ms.

**Latency.** The frame's content is sampled for the deadline it is sent at
(output timer lateness 13 / 21 / 35 µs p50 / p99 / max, idle), so animation timing on the strip is
unchanged. What grows is input → light: the player is sampled one period
before the frame goes out.

- **Player sampled → SPI start (`sample_to_spi`):** 8.23 / 8.25 / 8.34 ms idle
  and 8.24 / 8.37 / 9.25 ms loaded (p50 / p99 / max) at 20 × 260. The serial
  loop sampled ~4.9 ms (its render time) before the SPI start, so the pipeline
  adds **~3.3 ms p50, bounded by one period (8.33 ms)**. Then, as before, the
  FPGA takes 7.87 ms to shift out a 260-LED frame.
- **Render done → SPI start (`age`):** 4.0 / 8.0 / 8.0 ms idle.

**Jitter (frame period p99 − p50):** 18 µs idle, 109 µs loaded at 20 × 260
pipelined (worst period 9.34 ms loaded). The serial loop alternated between
8 ms and 12 ms periods.

**CPU:** the output thread drops from ~45 % of a core to ~1 % (3.5 % loaded).
The render thread takes ~45–50 % of CPU 2 at 20 × 260 @ 120. Per frame that is
~4.2 ms, against ~4.75 ms serial; the process total grows only because 26 %
more frames are rendered.

Findings:

- **0 repeats and 0 skips** in every pipelined run, idle and loaded. The only
  "render late" line per run comes from the start-up frames before the first
  render, which the summary drops.
- **Render headroom at 20 × 260 is thin:** p99 6.3–6.8 ms and worst 7.9 ms idle
  against the 8.33 ms period. Rendering is slower idle than loaded (p99 6.3 vs
  4.4 ms), which looks like the CPU clock dropping between renders. If a render
  does overrun, the last frame is re-sent (lag, not cut-out).
- **The player lock is held for nearly the whole render** (`lock` ≈ render
  time: `pattern_color` per LED is the cost, encoding is ~60 µs), so a WSS
  request can wait up to ~4–7 ms at 20 × 260. The RT output thread never takes
  the lock.
- **An earlier build** let the render publish D+1's frame before a late output
  took D's (25 skip/repeat pairs per 3,480 frames at 20 × 66 loaded); the
  consume-wait above removed them.

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

## 20-port MAX top (`tangnano9k_20p_top.v`, `tangnano9k_20p.cst`)

`//fpga/spi_ws281x:spi_ws281x_tangnano9k_20p` (flash:
`:spi_ws281x_tangnano9k_20p_flash`): 20 ports × 1024 LEDs, 2048 B FIFO per port,
54 MHz core, STATS underrun flag on `led[1]`, `led[0]` lit while streaming,
`frame_done` on a pin. Board: **Tang Nano 9K** (GW1NR-LV9QN88PC6/I5, the device
in `@rules_fpga//fpga/platforms:tangnano9k`). The 8-port `tangnano9k_top` is
unchanged.

|         port |    pin | pad (bank)        | notes                                                     |
| -----------: | -----: | ----------------- | --------------------------------------------------------- |
|          0–7 |  70–77 | IOT41B…IOT37A (1) | as the 8-port top; 70–75 also go to the HDMI connector    |
|            8 |     40 | IOB33B (2)        |                                                           |
|            9 |     35 | IOB29A (2)        | GCLKT_4 clock-capable input, plain I/O here               |
|           10 |     41 | IOB41A (2)        |                                                           |
|           11 |     42 | IOB41B (2)        |                                                           |
|           12 |     51 | IOR17B (1)        | GCLKC_3, the pair of `clk27` (52); single-ended, fine     |
|           13 |     53 | IOR15B (1)        | dual-purpose DOUT / WE_N                                  |
|           14 |     54 | IOR15A (1)        | dual-purpose DIN / CLKHOLD_N                              |
|           15 |     55 | IOR14B (1)        | dual-purpose SSPI_CS_N / D0                               |
|           16 |     56 | IOR14A (1)        | dual-purpose SO / D1                                      |
|           17 |     57 | IOR13A (1)        | dual-purpose FASTRD_N / D3                                |
|           18 |     68 | IOT42B (1)        | also HDMI (TMDS clock pair)                               |
|           19 |     69 | IOT42A (1)        | also HDMI (TMDS clock pair)                               |
| `frame_done` | **28** | IOB11B (2)        | **confirmed** → Pi GPIO 22 (header 15); next to MOSI (27) |

Checks (pads and banks from the apicula GW1NR-9C QN88P chipdb):

- **No conflicts**: none of the 13 pins is the clock (52), SPI (25–27), an
  onboard LED (10, 11, 13–16), a button (3, 4) or the config flash (MSPI 59–62).
- **Bank voltage**: every WS pin and `frame_done` is in bank 1 or 2, the same
  banks as the 8-port WS outputs (70–77, bank 1) and the SPI inputs (25–27, bank
  2), which already run LVCMOS33 on the rig. Bank 3 (onboard LEDs, buttons,
  79–86; 1.8 V per Sipeed's board docs) is not used for any port. The owner's
  order needed no change.
- **Dual-purpose pins 53–57** belong to the SSPI / CPU / MSPI configuration
  interfaces. The bitstream sets them to user I/O: nextpnr `--vopt sspi_as_gpio`
  and gowin_pack `--sspi_as_gpio --cpu_as_gpio --mspi_as_gpio` (rules_fpga gains
  `nextpnr_opts` / `packer_opts` through `//patches:rules_fpga-extra-tool-opts.patch`).
  The board configures from its flash over MSPI and the design leaves 59–62
  unconstrained. The flags do change the packed configuration fuses. Whether
  each pin toggles is **untested on hardware**: bring-up should check ports
  13–17 first.
- **Board sharing**: 68–75 also run to the HDMI connector, and per the Sipeed
  pinout most of these pins are also on the 40-pin RGB-LCD FPC. Leave both
  unconnected on a MAX unit.

Place-and-route of the pinned design (yosys 0.55 + nextpnr-himbaechel 0.9,
GW1NR-9C, `--freq` = core clock; `scaling_report.sh`, which uses the 20-port cst
minus the unused ports' lines for smaller counts; 2026-10-26):

|                        ports | LEDs/port |       FIFO B/port | core MHz |                LUT4 |                 DFF |      ALU |     BSRAM |        IOB |                                          fmax MHz |
| ---------------------------: | --------: | ----------------: | -------: | ------------------: | ------------------: | -------: | --------: | ---------: | ------------------------------------------------: |
| 8 (in-tree `tangnano9k_top`) |       553 |              1659 |       54 |                1178 |                 658 |      698 |      8/26 |         18 |                                              85.6 |
|                            8 |      1024 |              2048 |       54 |                1185 |                 681 |      712 |      8/26 |         19 |                                              83.4 |
|                           16 |      1024 |              2048 |       54 |                1923 |                1193 |     1322 |     16/26 |         27 |                                              73.3 |
|                 **20 (MAX)** |  **1024** |          **2048** |   **54** | **2354/8640 (27%)** | **1449/6480 (22%)** | **1634** | **20/26** | **31/274** |                                          **75.4** |
|                           20 |       553 |              1659 |       54 |                2681 |                1449 |     1640 |     20/26 |         31 |                                              78.4 |
|                           20 |      1024 |              2048 |       81 |                2175 |                1450 |     1634 |     20/26 |         31 |                                72.8, **fails 81** |
|                           20 |      1024 | 3072 (full frame) |       54 |                   — |                   — |        — |  needs 40 |          — | **does not place** (BSRAM exhausted; earlier run) |

The MAX row is the Bazel bitstream. Its timing: worst setup slack 5.25 ns at the
18.52 ns period. The critical path is 13.27 ns (7.54 logic, 5.72 routing), from the
`num_ports` CSR through a FIFO count compare to the FSM / underrun register. The
SPI inputs go through 2-FF synchronizers (asynchronous, not timed) and the WS
outputs are registered. Per port: +64 DFF, ~+95–110 LUT4, +1 BSRAM, so no port
is optimised away. fmax varies a few MHz run to run with placement. Every 54 MHz
configuration closes with ≥ 19 MHz margin, but the core does **not** close at
81 MHz, so a faster SPI front end would need the slave on its own SCK clock
domain, not a faster core clock. (The earlier internal-only variant XOR-folded
the outputs and the STATS counters onto one LED pin: 3,086 LUT4 / 1,671 DFF /
60.8 MHz with STATS. With real pins and no counter read-back, synthesis drops
the counters.)

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
