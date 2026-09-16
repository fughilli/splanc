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
  infra: `geom/pinhole` + `code/gray`).

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

  - macOS + linux-x86_64 use **nixpkgs' upstream** androidenv emulator.
  - **linux-aarch64** — nixpkgs (and dl.google.com's SDK channel) ship no aarch64-Linux
    emulator, so a **custom derivation** fetches Google's CI emulator (ci.android.com, the only
    source) and patches it exactly as `emulator.nix` does. ci.android.com serves it only via a
    _temporary signed_ URL and **garbage-collects old builds**, so a fixed-output derivation
    (pinned by content hash) resolves that URL at build time via the build API's
    `…/artifacts/<zip>/url?redirect=true` (anonymous access verified reachable). **Two fields
    must be pinned** in the nix file — a **current** `emulatorBuild` id + its `outputHash`; it
    ships UNSET (build `0`) and fails loudly until filled in. The build id must be read off the
    [emulator grid](https://ci.android.com/builds/branches/aosp-emu-master-dev/grid) **in a
    browser** — the build-list API is anonymously rate-limited/deprecated and the grid is
    JS-rendered — see the PIN MAINTENANCE note in the nix file.

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
`provisionBle`, `connectBle`, `startMapping`, `stopMapping`, `setHardwareConfig`,
`getHardwareConfig`, `setColorCorrection`; queries `appState`, `welcome`, `store`;
events `ready`, `state`, `milestone` (`mapping_started`/`result_ready`/`hardware_config_state`), `error`.

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

Verified end to end (in-container): smoke + connect + config over the app-driver, against
the mock and a real rig C6; the Android SDK/adb/emulator are wired into the build via Nix
(adb builds + runs on aarch64 here; the emulator builds on macOS/linux-x86_64 from upstream).
The custom linux-aarch64 emulator derivation is complete and its download endpoint
(ci.android.com's `getdownloadurl?redirect=true`) is verified anonymously reachable, but it is
**not yet pinned**: a current `aosp-emu-master-dev` build id + hash must be filled in (the id
has to be read off the grid in a browser — the build-list API is rate-limited/deprecated). It
ships UNSET and fails loudly until pinned. Remaining: pin a current aarch64 emulator build (or
just use an x86_64/macOS station, which needs no pin), boot the emulator + run the journeys on
a host with a hypervisor (Apple-silicon Mac or Linux + KVM), real BLE via Netsim/Bumble
(Android) + ImpossiBLE (iOS), the iOS station, and deepening the mapping journey (the
capture-screen lifecycle + synthetic camera through the solve — currently exercised at the
RPC-flow level).
