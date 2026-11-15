# Host player: Splanc on a Mac, driving WLED / DDP / Art-Net controllers

`//pi/player_rs:player_host` runs the Splanc player on a desktop host (macOS or
Linux) and drives LEDs through network pixel controllers instead of a Pi's SPI
bus. The controllers are treated as dumb pixel sinks. A WLED board in realtime
mode is the main target. Everything Splanc does is computed on the host: the
mapping patterns, LED counting and effect frames.

To the app it is one more fixture. You add it by address, map it with the phone
camera, and push effects to it. The session core is the same one the ESP32 and
the Pi players run. Effects run on the device's `fx_vm`, the same VM the browser
preview uses, so a fixture shows what the preview shows.

```text
 phone app ──wss──▶ player_host (Mac) ──UDP (DDP / Art-Net)──▶ WLED board ──▶ LEDs
                    session core + fx_vm
```

## Build and run

The repo's normal Bazel setup applies: Bazelisk, plus Nix for the toolchains,
which is what the `test-macos` CI job installs. The player needs nothing
Linux-only.

```sh
bazel build //pi/player_rs:player_host
bazel-bin/pi/player_rs/player_host --output ddp://wled-desk.local --leds 300 --name "Desk"
```

`bazel run //pi/player_rs:player_host -- --output … --leds …` works too.

| Flag              | Meaning                                                                                                                                                                                               |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--output SPEC`   | An output driver. Repeat it to split one strip across several controllers, in order. Default `null`.                                                                                                  |
| `--leds N`        | The strip length. Defaults to the outputs' `#N` counts added together.                                                                                                                                |
| `--fps F`         | The output frame rate. Default 40.                                                                                                                                                                    |
| `--name NAME`     | The device name the app shows. Default "Splanc Host".                                                                                                                                                 |
| `--serve-port P`  | The WSS port. Default 8443. Use a different port for each process.                                                                                                                                    |
| `--state-dir DIR` | Where the map and effect are saved (`""` keeps them in memory only). Default `~/Library/Application Support/Splanc/player_host/<port>` on macOS, `~/.local/state/splanc/player_host/<port>` on Linux. |
| `--start N`       | Show an N-LED mapping pattern at startup without the app, to check wiring.                                                                                                                            |

### Output specs (`pi/player_rs/src/output.rs`)

| Spec                                         | Wire                                                                                                                                                                                 |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ddp://host[:port]`                          | DDP to port 4048: 480 RGB pixels per packet, PUSH set on the last one. WLED takes it with no configuration.                                                                          |
| `artnet://host[:port][?universe=U][&sync=1]` | Art-Net ArtDmx to port 6454: 170 RGB pixels per universe, starting at universe `U` (a 15-bit port address). `sync=1` sends an ArtSync after each frame. Broadcast destinations work. |
| `null`                                       | Drops every frame, for timing the render loop with nothing attached.                                                                                                                 |

Add `#N` to give one output N pixels, for example
`--output ddp://a.local#300 --output ddp://b.local#150`. Outputs without a count
share the pixels left over. Unused pixels at the end of an output are sent dark.

Colour order: the player sends RGB. Set each strip's real colour order (GRB and
so on) in WLED. If you set a colour order in the app's hardware settings, it is
applied on top of that.

## WLED setup

1. Prefer wired Ethernet for the board. Mapping and effects stream on every
   frame, and Wi-Fi adds jitter.
2. In WLED, open **Config → LED Preferences** and set the LED count, GPIO and
   colour order for the strip.
3. Open **Config → Sync Interfaces → Realtime** and turn on _Receive UDP
   realtime_. DDP needs nothing else. For Art-Net, set _Type_ to Art-Net, set
   _Start universe_ to the same value as `?universe=`, and use the multi-RGB DMX
   mode.
4. The player keeps sending frames (black when idle), so WLED stays in realtime
   mode while the player runs. It falls back to its own effects after its
   realtime timeout once the player stops. If WLED also dims realtime data,
   check its realtime brightness setting (_Force max brightness_) so the app's
   brightness is the only one that applies.

## Using it from the app

1. Start `player_host`. It logs `add it in the app at wss://<this host>:8443`.
2. In the app, choose **Add device → Enter address** and enter
   `wss://<mac-hostname-or-ip>:8443`. The player uses a self-signed certificate,
   like the devices do. The app offers to trust it the first time (or open
   `https://<host>:8443` in the same browser and accept the warning); the page
   then confirms the certificate and shows the address to enter.
3. Map it the usual way: set the LED count, run the capture with the phone
   camera, and solve. The player shows the mapping patterns over DDP or Art-Net
   and reports back which frame it showed, as the devices do. Effects need the
   solved map on the player, so make sure the app uploads it.
4. Push effects from the Effects tab. The map and the active effect are saved to
   the state directory and come back after a restart.

## What is supported

The effects layer is `pi/player_rs/src/fx.rs`. These are served:

- Mapping and LED counting (the shared session core).
- `submit_map`, including sparse maps. Unmapped LEDs get positions interpolated
  from their neighbours, as on the device.
- `upload_chunk` reassembly. The app splits any frame over 4 KB this way.
- On one deck: `submit_effect`, `set_effect`, `set_uniforms` (with
  `control_ack`), `get_effect_uniforms` and `list_effects`.
- Output brightness.

Not served yet. The welcome's feature list leaves these out, so the app doesn't
offer them:

- Deck B and crossfades.
- Keypoints.
- Textures and video input.
- Topology (`led.seg` / `led.s` / `led.branch` read as "none").
- The stored-map dump back to the phone (`stored_map`).
- Per-fixture room poses (the room box is the map's own box).
- Perf reports, the FX debugger and OSC.

Uniform values are not saved. After a restart the effect starts from its
manifest defaults.

## Virtual LED wall: map a screen from the phone app

`//pi/player_rs:wall` turns a laptop screen into a fixture the installed phone
app adds by address, with no LED hardware:

```sh
bazel run //pi/player_rs:wall -- --leds 400
```

It runs `player_host` with no LED output (`--output null`) and has it serve the
built web app's virtual wall (`web/wall.html`) on its own WSS port
(`--web-root`). It prints the two URLs and a QR code:

1. **On the laptop**, open `https://localhost:8443/wall.html`, accept the
   certificate warning, and press **Fullscreen**. The wall idles (dim dots)
   until the phone starts mapping.
2. **On the phone**, in the Splanc app: **Device** tab → link icon (_Enter
   address manually_) → **Enter address** (the Wi-Fi fields can stay empty) →
   `wss://<laptop IP>:8443`. The app shows its "trust the certificate" card the
   first time, as for a real player; its popup lands on the player's trust page,
   which hands the app back. Scanning the printed QR code opens that trust page
   directly instead.
3. **Map it**: LED count = the `--leds` value, point the camera at the wall,
   capture and solve as usual.

How it works. The player is the real session core, so the phone sees an
ordinary fixture: `start_mapping` sets the code book and stamps the pattern
epoch on the player's clock. The wall page is a second client of the same
player. Loaded from the player's origin, it connects same-origin to
`wss://localhost:8443/ws` with the certificate the browser already accepted.
It syncs to the player clock (`time_sync`), polls `get_pattern` for the code
book and epoch, and renders every frame itself with the WASM hue-code kernel at
the display's refresh rate. Nothing is streamed over the network, so frame
timing is the browser's vsync on the player's clock, as on a real fixture.

Notes:

- A firewall prompt on the Mac must allow incoming connections for
  `player_host`. The phone and the laptop must be on the same network.
- The wall's own flags still work: `wall.html?cols=20&dot=0.5`, and
  `?url=wss://host:port/ws` points a wall page served elsewhere (e.g.
  `bazel run //web:serve`) at any control plane, as before.
- Only mapping is rendered: LED counting, effects and brightness from the app
  reach the player but do not show on the wall.
- Any `player_host` flag passes through (`--serve-port`, `--name`, …). Giving an
  `--output` drives real LEDs too, in step with the wall.
- Every Pi and host player now answers a plain `https://<player>/` with the
  trust page (it posts `ledmapper-cert-ok` back to the app's popup, like the
  netstack firmware) instead of an empty response.

Headless check: `bazel run //pi/player_rs:wall_smoke` starts the wall player,
opens the wall in headless Chromium and starts a mapping from a second client
(standing in for the phone). It checks that the canvas, sampled at every LED
centre, matches the kernel's colours for one frame of the cycle, and that this
frame is the one the player's clock has due.

## Testing

- Unit tests: `bazel test //pi/player_rs:player_rs_test`. These cover the DDP and
  Art-Net packet formats, output specs and pixel layout, and the effects layer
  end to end with a real compiled shader (map, chunked upload, uniforms,
  uniforms manifest, restore).
- Live smoke test, no hardware needed: `pi/player_rs/tools/smoke_host.py` (usage
  in its header). It runs the real binary, connects over real WSS and checks the
  DDP pixels that come out.

## Handoff: where this stands (2026-11-11)

It was written and tested in the Linux dev container, then run on a Mac:

- **Built on macOS.** `bazel build //pi/player_rs:player_host` and
  `bazel test //pi/player_rs:player_rs_test` pass. The smoke test has not been
  run on the Mac yet.
- **One WLED board, wired.** It drove a WLED 16.0.1 board with 1680 LEDs (4 × 420)
  over DDP on a wired interface: `--output ddp://<board> --leds 1680`. WLED
  switched to DDP realtime mode with no configuration beyond _Receive UDP
  realtime_.
- **The phone app.** The app connected over WSS after the browser accepted the
  certificate, and the setup was reported working. The first run hit Chrome's
  non-bypassable `ERR_SSL_KEY_USAGE_INCOMPATIBLE`, because the self-signed cert
  was built as a CA (key usage `keyCertSign` / `cRLSign` only). It is now an
  end-entity cert with `digitalSignature` (`server.rs`, `self_signed_config`).
  This fixes the Pi player too. After you accept the warning, the browser
  showed `ERR_EMPTY_RESPONSE`, because the player only answered WebSocket
  upgrades. It now serves the trust page there (see "Virtual LED wall").

Next steps:

1. Run the smoke test on the Mac.
2. Check that a full mapping capture decodes cleanly over the network. Network
   latency is the least tested part.
3. **Effects.** Push an effect from the library and compare it with the preview.
4. **Several boards.** Either run one `player_host` per board on different
   `--serve-port`s (each is its own fixture in the app), or split one fixture
   across boards with `#N` counts.
5. **Open choices.** Whether to add deck B and crossfades (port them from
   `firmware/player_app/ffi.rs`), sACN/E1.31 output, mDNS advertising so the app
   finds the player without typing an address, and a launchd plist so it starts
   at login.
