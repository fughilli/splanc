# HITL & tooling (`pi/hitl/`, `tools/`)

## Hardware-in-the-loop rigs (`pi/hitl/`)

The HITL infrastructure runs the firmware on real ESP32-C6 boards under `bazel
test`-style automation. A rig is a Raspberry Pi with one or more C6 boards over
USB, reserved through a FIFO queue and reached over Tailscale. A Go daemon + CLI
manage reservations; a Python harness drives the tests.

Suites include `e2e`, `map_upload`, `mapping_trigger`, `fx_bench` (the FX
performance benchmark that feeds {doc}`../docs/fx-vm-performance`), `rename_wss`,
and `video_stream`. The CI wiring and how to stand up your own rig are documented
in {doc}`../DEVELOPERS` (Hardware-in-the-loop testing).

## Host-side tools (`tools/`)

Dev, flash, and bench helpers that run on the machine with the board and radio:

- **`tools/flash_server.py`** — host-side ESP32 flasher + serial-log reader;
  shells out to `bazel` under `$BUILD_WORKSPACE_DIRECTORY` to run flash targets.
- **`tools/ble_onboard_server.py`** — Improv-BLE provisioning driver (SimpleBLE),
  the automated stand-in for the phone's Web Bluetooth onboarding.
- **`tools/browser_server.py`** — headless Chromium driver (Playwright) for
  exercising the player's `wss` + self-signed-cert flow end to end.
- **`tools/sim_studio/`** — an interactive solver-debugging web app: generate
  fixtures, fly a camera, and watch reconstruction converge against ground truth.
- **`tools/trace_server.py`** — a CV trace sink for offline detection debugging.
- **`tools/fx_profile/`** — the effects performance profiler.

```sh
bazel run //tools/sim_studio:serve      # solver-debugging UI on :8090
```

---

Sim Studio's own README (HTTP API, usage, tests):

```{include} ../tools/sim_studio/README.md
:heading-offset: 1
```
