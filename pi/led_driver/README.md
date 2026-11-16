# M1 — `pi/led_driver` (SK9822/APA102 hue-code pattern driver)

The real-time-priority process that owns the SPI bus and the **pattern clock**
(design doc §3, §6 M1). It runs a continuous hue-code cycle (§8.1) on the LED
strip and exposes a local Unix-socket control plane so M2 can start/stop the
pattern and read the pattern clock epoch.

It is the Pi image's `apa102` output path (`ledOutput = "apa102"` in
`pi/provisioning/nix/apps.nix`, or `SPLANC_LED_OUTPUT=apa102` at build time); the
`fpga` path runs the Rust player (`//pi/player_rs`) instead.

**This package has no copy of the colour code.** Every pattern frame is rendered
by the Rust hue-code kernel `//firmware/pattern` — the one implementation the
firmware players link and the phone runs as wasm — through its one Python
binding, `ledmapper_pattern` (`//firmware/pattern:pattern_py`, ctypes over the
kernel's C ABI, the same binding `pi/server/server/codebook.py` uses).
`led_driver.pattern.color_plan` asks the kernel for each frame's per-LED RGB;
this package only frames those colours for the wire and clocks them out.

## Run it

```sh
# On the Pi (real hardware), as led-driver.service:
bazelisk run //pi/led_driver:drive -- \
    --socket /run/ledmapper/control.sock --bus 0 --device 0 --speed-hz 8000000

# Hardware-free dry run (in-memory sink) + immediately light a 16-LED cycle:
bazelisk run //pi/led_driver:drive -- --dry-run --socket /tmp/control.sock --start 16
```

| Flag                 | Default                       | Meaning                                                  |
| -------------------- | ----------------------------- | -------------------------------------------------------- |
| `--socket`           | `/run/ledmapper/control.sock` | control socket M2 connects to                            |
| `--bus` / `--device` | `0` / `0`                     | `/dev/spidev<bus>.<device>`                              |
| `--speed-hz`         | `8_000_000`                   | SPI clock                                                |
| `--brightness`       | `31`                          | global 5-bit brightness (0..31)                          |
| `--dry-run`          | off                           | use an in-memory sink (no `spidev`) — for emulation / CI |
| `--start N`          | _none_                        | immediately start a default cycle for `N` LEDs (debug)   |

## The hue-code cycle (§8.1)

```text
[ ALL_ON: white ][ ALL_OFF: green ]        sync delimiter (self-clocking)
[ data 0 ] … [ data D-1 ]                  log2(symbols) code bits per frame
```

Every LED is lit every frame at constant brightness; the code (Gray data word,
SEC-DED by default) is carried by colour. The definition lives in
`firmware/pattern/src/lib.rs`. Here, `pattern.color_plan(code_params)` returns
the kernel's per-frame colour lists (after checking the code-book against the
kernel's own sizing), and `spi.frame_bytes_colors(colors)` encodes one frame to
SK9822/APA102 bytes.

## Control protocol (M1 ↔ M2)

Newline-delimited JSON over the Unix socket (`control.py`). M2 uses
`ControlClient`:

| Command                                                  | Reply                                                |
| -------------------------------------------------------- | ---------------------------------------------------- |
| `{"cmd":"start","codeParams":{…}}`                       | `{"ok":true,"patternClockEpoch":<ms>}`               |
| `{"cmd":"stop"}`                                         | `{"ok":true}`                                        |
| `{"cmd":"get_clock"}`                                    | `{"ok":true,"epoch":…,"bitPeriodMs":…,"cycleLen":…}` |
| `{"cmd":"set_debug","mode":"single","args":{"ledId":5}}` | `{"ok":true}`                                        |
| _invalid_                                                | `{"ok":false,"error":"…"}`                           |

The **`CodeParams` are computed by M2** (`pi/server/server/codebook.py`, the
authority) and handed to `start()`; M1's `default_code_params()` is a
CLI-only convenience for running without M2.

## Hardware abstraction & testing

The wire framing and frame loop are **pure** (colours → bytes), unit-tested
with a `RecordingSink`. `spidev` is imported lazily inside `SpidevSink`, so the
package imports and the whole suite runs off-Pi (and in the hermetic Bazel
sandbox). The driver loop takes injected `clock`/`sleep`, so it's driven
deterministically in tests with no wall-clock waits.

- `//pi/led_driver:led_driver_test` — SK9822/APA102 + FPGA framing, the driver
  loop (epoch + frame sequence + dark-on-exit + debug modes), the control-socket
  roundtrip, and `test_kernel_equivalence.py`: the driver's APA102 SPI buffers
  over full cycles equal the APA102 framing of the kernel's checked-in colour
  plan (`firmware/pattern/testdata/golden_secded16*.json`), and the whole-frame
  render equals the kernel's per-LED entry point at 2200 LEDs.

## In the Pi image

`//pi/led_driver:ledapp_bundle` packs this package, `ledmapper_protocol`, the
kernel binding and the kernel's Rust sources into `ledapp.tar`, handed to the
flake as sbc-deploy `build_data`. `apps.nix` compiles the kernel cdylib from
those sources with `rustc` (the same crate + ABI shim Bazel builds) and points
`$LEDMAPPER_PATTERN_LIB` at it; the build smoke-renders a frame. Nothing is
vendored under `pi/provisioning/nix`.

## Not yet done

- **Real-hardware cadence verification** (design doc §9 Phase 1 acceptance) needs
  a logic analyzer / high-FPS camera on a real strip — cannot be done in CI.
- **Real-time scheduling** (`SCHED_FIFO` / `CAP_SYS_NICE`) is configured by the
  M4 systemd unit, not in this code yet.
- Wire format targets SK9822 (zeros end frame); verify against the specific strip
  before bench testing (§13 "LED timing on a busy Pi").
