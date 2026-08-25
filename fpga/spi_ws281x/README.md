# spi_ws281x — streaming SPI → WS281x FPGA core

Translates an SPI byte stream into multiple WS281x (WS2812/NeoPixel) drive
signals. Unlike a frame-buffered design, it **streams**: as the SPI transfer
happens, the per-port drivers tick, so it needs only ~2 bytes of buffer per port
(no big block RAM). The number of active ports is **runtime-configurable** over
SPI (a small CSR bank), and `led_type` is reserved for future non-WS281x timings.

Built with [rules_fpga](https://github.com/fughilli/rules_fpga) (yosys / nextpnr /
apicula / Verilator), brought in via `git_override` in the root `MODULE.bazel`.

## Modules

- `spi_slave.v` — byte SPI slave (mode 0, MSB first), 2-FF input synchronizers.
- `spi_ctrl.v` — decodes the per-transaction opcode and routes bytes.
- `csr.v` — control registers (`num_ports`, `led_type`).
- `ws281x_stream.v` — round-robin demux + per-port double buffer + one lockstep
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

**Round-robin layout** is what makes streaming work with tiny buffers: the host
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

The firmware/Pi side that talks to this over SPI is not implemented yet.
