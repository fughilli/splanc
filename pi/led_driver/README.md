# `pi/led_driver` — spi_ws281x FPGA framing (Python reference encoder)

`led_driver.fpga_spi` encodes per-LED colours into the `//fpga/spi_ws281x`
SPI framing (one STREAM transaction per frame, ports interleaved byte-by-byte,
rate-matched SPI clock via `matched_speed_hz`). It is pure (colours → bytes)
and unit-tested by `//pi/led_driver:led_driver_test`.

Its one consumer is the HITL harness (`//pi/hitl/harness:hitl_fpga_ws281x`),
which cross-checks the raw SPI the device emits against this reference.

## History

This package used to be the M1 Python pattern driver: an SK9822/APA102 SPI
driver with its own hue-code generator (`graycode.py`), a control socket for
the M2 server, and a vendored copy baked into the Pi image as the `apa102`
output path. The Pi now runs the Rust player (`//pi/player_rs`), and the hue
code has a single implementation — the Rust kernel `//firmware/pattern`, which
the players link, the phone runs as wasm and the Python dev backend
(`pi/server/server/codebook.py`) calls through its C ABI — so the Python driver
and its pattern code were removed.
