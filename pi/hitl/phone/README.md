# Phone-in-the-loop HITL station

Drive the web/PWA app through the basic user journeys — **scan/connect a device,
initiate mapping, configure gamma/hardware** — with a phone (emulator now; real phone
and gantry later) in the loop, over a WebSocket, against either a **mock** device or a
**real ESP32-C6** on the HITL rig. Journeys are declarative data, so new ones are JSON,
not code.

This exists to debug the pairing/connection/mapping flow end to end and, later, to
hill-climb the autoexposure / blob-detector tuner against a known physical fixture.

## Quickstart

```sh
# Device-free smoke: app-driver loop + virtual BLE, no backend (CI-friendly)
bazel run //pi/hitl/phone:phone_e2e -- --browser --journeys smoke

# Connect + config against a self-contained mock device (no rig)
bazel run //pi/hitl/phone:phone_e2e -- --browser --mock-device --journeys smoke,config

# Deep mapping: drive the REAL capture screen — synthetic camera → real detector →
# real decoder (mapping_capture), plus the real VIO solve with synthetic IMU (mapping_solve)
bazel run //pi/hitl/phone:phone_e2e -- --browser --mock-device --journeys mapping_capture,mapping_solve

# Connect + config against a REAL ESP32-C6 on the rig (reserve+flash+provision+forward)
HITL_OWNER=you bazel run //pi/hitl/phone:phone_e2e -- \
    --browser --reservation --hitl-server http://hitl-rig-2:8087 --journeys config
```

Lanes: `--browser` (headless Chromium, works today) · `--android` (emulator PWA, WIP).
Backends: `--mock-device` · `--reservation` (rig C6) · `--device-ws wss://…` (any reachable device).

## How it works

The app is loaded with `?driver=<ws-url>`; that guarded, dynamic-imported seam
(`web/src/driver/`, mirrors the shipped `?demo=` seam — zero production cost) connects
BACK to this station and turns our JSON commands into calls on the EXACT production
functions a user's taps invoke (`appState.connect`, `provisionViaBle`,
`client.startMapping/stopMapping/setHardwareConfig/setColorCorrection`, `router.navigate`),
streaming app-state transitions + milestones back. So we drive the real journeys and
assert on the app's real replies.

Hardware is substituted behind the same guard so journeys run with no radio / no camera:

- **Virtual BLE** (`web/src/net/virtualBle.ts`) — a software Improv peripheral answers
  the provisioning RPC in-app (swapped in at `requestImprovDevice`).
- **Synthetic camera** (`web/src/xr/syntheticCaptureSource.ts`) — renders the known
  fixture's LEDs projected on a camera arc, coloured with the real hue-code, into a
  reduced frame the real detector + decoder consume (reuses the `pipeline_synthetic`
  infra: `geom/pinhole` + `code/gray`). It also emits a **synthetic IMU** stream — body-frame
  angular velocity + specific force `Rᵀ·(a_world − g)` derived from the same pose arc (a port
  of the solver's own `synth.rs`), stamped in the frames' clock — so the real visual-**inertial**
  solver can recover scale. Two journeys drive the real `/capture` screen with this source:
  `mapping_capture` (`openCapture` + `awaitDecode`) asserts the real decoder recovers every LED
  id; `mapping_solve` (`openCapture` + `finishCapture`) runs the real on-device VIO solve and
  asserts a solved map (LED positions recovered, ≥ half the fixture) — both end to end through
  the app, not the mapping RPC. `finishCapture` is timeout-bounded so a bad solve fails cleanly
  rather than hanging. The solver deployment (`//solver:solver_web` — wasm + worker) is served at
  `/solver/` in this lane, as the Pi server does, so the on-device solve path can load.

Station pieces (`pi/hitl/phone/`): `driver_server.py` (WS control channel + async
driving API), `journey_runner.py` (runs the JSON journeys), `mock_device.py` (proto
`proto_wire` mock backend), `reservation_backend.py` (real rig C6), `launcher.py`
(headless Chromium / Android emulator), `phone_e2e.py` (the runner).

## Android lane (Nix-provided SDK)

The Android tools come from the Bazel-pinned nixpkgs — no manual Android SDK install:

- **`adb` / platform-tools** — `@android_tools` (`//pi/hitl/phone:adb`). Cross-platform;
  builds + runs on both aarch64 and x86-64.
- **Emulator + Google-APIs system image** — the `@android_emulator` composed SDK
  (`//pi/hitl/phone:android_emulator`), from `pi/hitl/phone/nix/android-emulator.nix`.
  Supported on **macOS (Intel + Apple Silicon)** and **Linux (x86_64 + aarch64)**:

  - macOS (Apple Silicon + Intel) + linux-x86_64 use **nixpkgs' upstream** androidenv emulator —
    **no pinning, nothing to maintain**. These are the stations to use.
  - **linux-aarch64 is discontinued upstream** (checked 2026-09). nixpkgs and dl.google.com ship
    no aarch64-Linux emulator; its only public source was Google's CI (`aosp-emu-master-dev`),
    which is now **frozen** — last green build `13278466` (2025-03-28), and even that build's zip
    has been garbage-collected (confirmed: the grid download 404s). No successor branch publishes
    a `linux_aarch64` target. So there is **nothing live to pin**. The custom derivation +
    fetch machinery remain in `android-emulator.nix` (verified reachable) in case Google
    republishes, but today an arm64-**Linux** station (Asahi / arm cloud) can only get the
    emulator by building it from source. **Just use a macOS or linux-x86_64 station instead.**

  The nix file picks a **native-ABI** system image per host (arm64-v8a on ARM, x86_64 on
  x86_64). Tagged `manual` (a multi-GB SDK download only this lane needs), so it stays out of
  `bazel build //...`; build it explicitly. **Acceleration needs the host hypervisor** —
  Hypervisor.framework on macOS, `/dev/kvm` on Linux.

On the station:

```sh
export ANDROID_SDK_ROOT="$(bazel build //pi/hitl/phone:android_emulator \
    --show_result=1 2>&1 | awk '/android_emulator/{print $NF}')/libexec/android-sdk"
bazel run //pi/hitl/phone:phone_e2e -- --android --mock-device --journeys smoke,config
```

`launcher.py` creates the AVD from the bundled system image, boots the emulator headless,
serves the built app, and opens it in the emulator's browser at
`http://10.0.2.2:<port>/?driver=…` (10.0.2.2 is the emulator's host-loopback alias; the
mock/rig device URL is rewritten to it too). Status: the Nix tools + lane are wired; adb
builds + runs on aarch64 here, and the emulator SDK builds on macOS/linux-x86_64 (this
aarch64-linux CI container has no upstream emulator, so its target is correctly skipped).
Booting the emulator + running the journeys is for a station with a hypervisor — an
Apple-silicon Mac, or a linux-x86_64 box with `/dev/kvm`.

## Real-BLE lane (Bumble software peripheral)

By default the driver swaps a virtual Improv/player peripheral in behind the guard (CI +
browser lane). The **real-BLE lane** instead has the app pair over the actual OS BLE stack with
a **software Improv peripheral** — the same GATT service a real ESP32-C6 advertises — so we
exercise real pairing/provisioning, not the app-seam mock.

- **`ble_peripheral.py`** — a [Bumble](https://github.com/google/bumble) Improv GATT server
  (`//pi/hitl/phone:ble_peripheral`). Mirrors `web/src/net/improv.ts` (UUIDs + wire) and the
  mock's behaviour: on a wifi-settings RPC it answers on RPC_RESULT with a redirect URL (e.g.
  the rig-forwarded C6 endpoint) and steps CURRENT_STATE → PROVISIONED, so real BLE
  provisioning hands off to a real device connection.
- **`ble_peripheral_test`** — a Bumble **central** drives the full Improv handshake against the
  peripheral over a Bumble LocalLink: two complete BLE stacks (LL/L2CAP/ATT/GATT), **no radio,
  no emulator**. Verified in-container (incl. MTU negotiation + the Improv error path), so the
  peripheral's protocol is proven without a hypervisor.
- **App toggle:** load the app with `?driver=…&ble=real` — the improv/bleTransport swap points
  fall through to real Web Bluetooth instead of the virtual mock (`driverUsesVirtualBle()`).
- **On a hypervisor station:** point the Android emulator at its Netsim controller and run
  `bazel run //pi/hitl/phone:ble_peripheral_server -- --transport android-netsim --redirect
http://<c6-ip>/`. The emulator's guest BLE stack then discovers the peripheral. (Other
  transports: `hci-socket:0` for a host BlueZ adapter, `tcp-client:HOST:PORT` for RootCanal.)

**Station-only spike (not verified here):** whether emulator-Chrome's Web Bluetooth _chooser_
can be driven under automation over Netsim is the remaining unknown (there's no user gesture in
a headless run) — it needs a hypervisor host to try, and may require Chrome
auto-accept-Bluetooth flags or a thin Capacitor-Android wrapper. The peripheral + protocol (the
hard, portable part) are done and CI-tested; the emulator boot + chooser is the station step.

## Journey format (`journeys/*.json`)

Declarative, Maestro-inspired but over our semantic protocol (not DOM selectors):

```json
{
  "name": "config",
  "inputs": { "gpio": 8, "colorOrder": "GRB" },
  "steps": [
    { "runFlow": "connect" },
    {
      "do": "setHardwareConfig",
      "with": { "channel": 0, "gpio": "${gpio}", "colorOrder": "${colorOrder}", "commit": true },
      "expect": { "channels": "nonempty" }
    },
    { "do": "setColorCorrection", "with": { "gamma": [2.2, 2.2, 2.2], "commit": true } }
  ]
}
```

- Step kinds: `{"do"|"query": <method>, "with": {...}, "expect": {...}, "as": name}`,
  `{"await": "connected"|"milestone:<name>"|"state:<s>"}`, `{"runFlow": "<journey>"}`.
- `${var}` interpolates from `inputs` + runtime context (`device_ws`, `ssid`, `led_count`);
  an exact `"${var}"` preserves the value's type.
- Expect DSL: `present` · `nonempty` · `{equals}` · `{contains}`, dotted paths into replies.

App-driver methods (`web/src/driver/harness.ts`): commands `navigate`, `connect`,
`provisionBle`, `connectBle`, `startMapping`, `stopMapping`, `openCapture`, `captureStats`,
`awaitDecode`, `finishCapture`, `setHardwareConfig`, `getHardwareConfig`, `setColorCorrection`;
queries `appState`, `welcome`, `store`; events `ready`, `state`, `milestone`
(`mapping_started`/`result_ready`/`decoded`/`map_solved`/`hardware_config_state`), `error`.

`startMapping`/`stopMapping` drive the mapping RPCs directly; the capture commands go a level
deeper against the REAL capture screen (it auto-runs the app's own start-mapping and feeds the
synthetic camera through the real detector + decoder): `openCapture` navigates to it,
`captureStats`/`awaitDecode` read live decode health and block until all LED ids are recovered
(returns `{ ids, total, tracks, observations }`), and `finishCapture` ends the sweep and runs
the VIO solve, returning `{ mapId, ledCount, solved }` (timeout-bounded — see the note above).

## BOM (MVP stations)

**Android station** — an **Apple-silicon Mac mini** (emulator via Hypervisor.framework) OR a
**Linux box with `/dev/kvm`** (≥16 GB RAM). Note: since the emulator runs on Apple silicon, the
Mac mini below can host **both** the Android and iOS lanes — one machine covers both stations.
| Item | Notes |
|---|---|
| Apple-silicon Mac mini **or** a Linux box (x86-64, or aarch64 with a pinned CI emulator) with a hypervisor (`/dev/kvm`) | runs the emulator + this station |
| Android SDK + emulator + system image + `adb` | **provided via Nix** — no ad-hoc install (below) |
| USB Bluetooth dongle (e.g. RTL8761/CSR 4.0+) | for the real-BLE tier (Netsim/Bumble ↔ host BlueZ) |
| 1× ESP32-C6 dev board (optional) | real device over RF; or use the shared rig |

**iOS station (later):**
| Item | Notes |
|---|---|
| Apple-silicon Mac mini | the only host that runs the iOS Simulator + `tools/ios_build_server.py` |
| USB Bluetooth dongle | for the ImpossiBLE → host-radio BLE bridge |
| 1× iPhone (cheapest supported) + USB-C cable | real-device BLE (the Simulator has none) |

**Shared:** access to the HITL rig (`$HITL_SERVER`) + ≥1 reservable ESP32-C6 for the
`--reservation` lane; the synthetic fixture is in-repo (`testdata/synthetic_y_junction.binpb`).

**Future — gantry / ambient-light rig (not MVP):** a motorized gantry or small arm to
swing a real phone around a physical known-map fixture (a rigid LED strip whose geometry
matches a `.binpb`), plus DMX/PWM-controllable light panels to sweep ambient level — to
close the sim-to-real gap (bloom, rolling shutter, sensor noise, ambient contrast) the
synthetic source can't, enabling the exposure/blob-tuner hill-climb.

## Status

Verified end to end (in-container): smoke + connect + config + mapping + **mapping_capture** +
**mapping_solve** over the app-driver, against the mock (and connect/config/mapping against a
real rig C6). `mapping_capture` drives the real capture screen + synthetic camera through the
real detector + decoder (all LED ids recovered); `mapping_solve` adds the synthetic IMU and
runs the real on-device VIO solve to a solved map (sub-pixel reprojection, full fixture
recovered). The Android SDK/adb/emulator are wired into the build via Nix
(adb builds + runs on aarch64 here; the emulator builds on macOS/linux-x86_64 from upstream).
The custom linux-aarch64 emulator derivation is complete and its download endpoint is verified
reachable, but the arm64-**Linux** emulator is **discontinued upstream** (the CI branch froze in
2025-03 and its artifacts are GC'd — nothing live to pin), so use a **macOS or linux-x86_64
station**, where the emulator comes from nixpkgs with no pin. The **real-BLE** peripheral
(Bumble Improv GATT) +
its real-GATT test are done and CI-tested in-container, and the app has the `?ble=real` toggle;
what's left there is the station-only spike (emulator boot + Netsim + the Web Bluetooth chooser
under automation). Remaining: on a **macOS or linux-x86_64 + KVM** station (arm64-Linux
emulator is discontinued upstream — no pin possible), boot the emulator + run the journeys,
then the emulator real-BLE spike over Netsim, then the iOS station (ImpossiBLE).
