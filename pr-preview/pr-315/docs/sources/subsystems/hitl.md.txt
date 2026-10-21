# HITL & tooling (`pi/hitl/`, `tools/`)

## Hardware-in-the-loop rigs (`pi/hitl/`)

The HITL infrastructure runs the firmware on real ESP32-C6 boards under `bazel
test`-style automation. A rig is a Raspberry Pi with one or more C6 boards over
USB, reserved through a FIFO queue and reached over Tailscale. A Go daemon + CLI
manage reservations; a Python harness drives the tests.

Suites include:

- `e2e_netstack`: flash, BLE provisioning, wss and the agent manifest check.
- `map_upload`, `mapping_trigger` and `rename_wss`.
- `fx_bench`: the FX performance benchmark that feeds
  {doc}`../docs/fx-vm-performance`.
- `video_stream`.
- `loaded_tls_netstack`: TLS handshakes on a heap loaded with a map and an
  effect.
- `ram_audit`, described below.
- `time_base_skew`: inter-fixture skew under one shared epoch, captured on both
  analyzer-tapped DUTs in one capture.
- The real-phone journeys: Android on `amd-rig`, iOS on the Mac mini.

Every failure ships the DUT's serial log as a CI artifact. The CI wiring and how
to stand up your own rig are documented in {doc}`../DEVELOPERS`
(Hardware-in-the-loop testing).

### Memory auditing over JTAG (`ram_audit`)

`//pi/hitl/harness:ram_audit` drives the field worst case: BLE provisioning,
then the first wss handshake with BLE still up, then a 512-LED map, a texture
effect and loaded handshakes. Meanwhile `ram_watch.tcl` polls every heap's
free bytes over the C6's system bus, **without halting** the core. At each new
low it halts just long enough to dump HP + LP SRAM and the registers, so the
last dump is the RAM image at the minimum watermark. At the end of the run it
also reads the heap census (`LM_HEAP_CENSUS`, with
`--//firmware/player_app:heap_census_enabled`) and the sysmode counters
(`LM_MODE`). The DUT never reports metrics over the network.

- **`--hang`** adds `hang_watch.tcl`. It polls FreeRTOS's tick count, and if
  the tick stops for 3 s it halts the core, records the registers and a PC
  trail, dumps SRAM, and **leaves the core halted** so the watchdog can't erase
  the evidence.
- **Gotcha: never halt during the Wi-Fi join.** A dump halts the core for
  ~46 s, and a halt in the DHCP window ends in a TG0 watchdog reset after
  resume, which looks exactly like a firmware hang. Dumps are therefore armed
  only after provisioning (the harness touches `/tmp/ram_watch.arm`); the
  minimum comes later, at the first wss handshake.

### Observability

Rigs push their metrics to Grafana Cloud through Alloy. This covers the Pi
rigs, the Android bench `amd-rig` (both daemons, `:8087` and `:8088`) and the
iPhone bench `mac-mini` (a launchd Alloy agent). The dashboards are code in
`pi/hitl/observability/dashboards/` and are synced by
`.github/workflows/grafana-dashboards.yaml`, which warns loudly if its Grafana
credentials are missing. See `pi/hitl/observability/README.md`.

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
