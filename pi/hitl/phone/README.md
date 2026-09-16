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

**Android station (build first — cleaner virtual BLE, no Apple signing):**
| Item | Notes |
|---|---|
| Linux mini-PC (x86-64, ≥16 GB RAM, KVM) | runs the Android emulator + this station |
| Android SDK + emulator + a system-image AVD, `adb` | the `--android` lane |
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

Verified end to end: smoke + connect + config over the app-driver, against the mock
(in-container) and a real rig C6. Remaining: Android emulator lane, real BLE via
Netsim/Bumble (Android) + ImpossiBLE (iOS), the iOS station, and deepening the mapping
journey (the capture-screen lifecycle + synthetic camera through the solve — currently
exercised at the RPC-flow level).
