# M1 — `pi/led_driver` (SK9822/APA102 Gray-code pattern driver)

The real-time-priority process that owns the SPI bus and the **pattern clock**
(design doc §3, §6 M1). It runs a continuous Gray-code cycle (§8.1) on the LED
strip and exposes a local Unix-socket control plane so M2 can start/stop the
pattern and read the pattern clock epoch.

## Run it

```sh
# On the Pi (real hardware), as led-driver.service:
bazelisk run //pi/led_driver:drive -- \
    --socket /run/ledmapper/control.sock --bus 0 --device 0 --speed-hz 8000000

# Hardware-free dry run (in-memory sink) + immediately light a 16-LED cycle:
bazelisk run //pi/led_driver:drive -- --dry-run --socket /tmp/control.sock --start 16
```

| Flag | Default | Meaning |
| ---- | ------- | ------- |
| `--socket` | `/run/ledmapper/control.sock` | control socket M2 connects to |
| `--bus` / `--device` | `0` / `0` | `/dev/spidev<bus>.<device>` |
| `--speed-hz` | `8_000_000` | SPI clock |
| `--brightness` | `31` | global 5-bit brightness (0..31) |
| `--dry-run` | off | use an in-memory sink (no `spidev`) — for emulation / CI |
| `--start N` | _none_ | immediately start a default cycle for `N` LEDs (debug) |

## The Gray-code cycle (§8.1)

```
[ ALL_ON ][ ALL_OFF ]            sync delimiter (self-clocking)
[ bit 0  ][ bit 1 ] … [ bit B-1 ]   LED i lit iff bit b of gray(i) is set
```

`B = ceil(log2(ledCount))`, `cycleFrames = 2 + B`. Each frame is held for
`bitPeriodMs`. Gray coding means a single misread bit mislabels to an *adjacent*
LED, not a random one. `frame_plan(code_params)` returns the per-frame on-sets;
`frame_bytes(on_set, n)` encodes one frame to SK9822/APA102 bytes.

## Control protocol (M1 ↔ M2)

Newline-delimited JSON over the Unix socket (`control.py`). M2 uses
`ControlClient`:

| Command | Reply |
| ------- | ----- |
| `{"cmd":"start","codeParams":{…}}` | `{"ok":true,"patternClockEpoch":<ms>}` |
| `{"cmd":"stop"}` | `{"ok":true}` |
| `{"cmd":"get_clock"}` | `{"ok":true,"epoch":…,"bitPeriodMs":…,"cycleLen":…}` |
| `{"cmd":"set_debug","mode":"single","args":{"ledId":5}}` | `{"ok":true}` |
| _invalid_ | `{"ok":false,"error":"…"}` |

The **`CodeParams` are computed by M2** (`pi/server/server/codebook.py`, the
authority) and handed to `start()`; M1's `default_code_params()` is a
CLI-only convenience for running without M2.

## Hardware abstraction & testing

The wire framing and cycle logic are **pure** (an on-set → bytes), unit-tested
with a `RecordingSink`. `spidev` is imported lazily inside `SpidevSink`, so the
package imports and the whole suite runs off-Pi (and in the hermetic Bazel
sandbox). The driver loop takes injected `clock`/`sleep`, so it's driven
deterministically in tests with no wall-clock waits.

- `//pi/led_driver:led_driver_test` — Gray-code/frame-plan, SK9822/APA102
  framing, the driver loop (epoch + frame sequence + dark-on-exit + debug
  modes), and the control-socket roundtrip.

## Not yet done

- **Real-hardware cadence verification** (design doc §9 Phase 1 acceptance) needs
  a logic analyzer / high-FPS camera on a real strip — cannot be done in CI.
- **Real-time scheduling** (`SCHED_FIFO` / `CAP_SYS_NICE`) is configured by the
  M4 systemd unit, not in this code yet.
- Wire format targets SK9822 (zeros end frame); verify against the specific strip
  before bench testing (§13 "LED timing on a busy Pi").
