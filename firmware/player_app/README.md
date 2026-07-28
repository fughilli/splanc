# ESP32-C6 player app (bring-up build)

The LED Mapper player firmware: WiFi soft-AP, the R2 landing page over HTTP,
the `ledmapper.v1` player protocol over WebSocket, and FastLED strip output
rendering the counting/mapping patterns. The protocol brain is the
host-tested Rust stack (`ledmapper_player` session core, `ledmapper_pattern`
hue code, `ledmapper_arena`/`ledmapper_store` upload storage) behind a C ABI
(`player_ffi.h`); the C++ side owns WiFi, sockets, RFC 6455 framing
(`ws_codec.h`, host-tested byte-exactly) and the LED loop.

## Player onboarding (BLE, the primary flow)

The soft-AP + landing-page bounce CANNOT onboard a phone (bench finding
2026-07-12: a phone joined to the device's AP routes ALL traffic there, so
the hosted app never loads). The flow is inverted — **provision over BLE
from the hosted app**, using the Improv Wi-Fi BLE standard:

1. Open <https://ledmapper.pages.dev> on your NORMAL network (Chrome —
   Android or desktop; iOS Safari has no Web Bluetooth and keeps the
   manual `?url=` path).
2. Tap **Set up player (Bluetooth)** → pick "LEDMapper C6" in the chooser
   → enter your WiFi SSID + password.
3. The device stores the credentials (NVS), joins your LAN (AP+STA — the
   soft-AP stays up as the bench fallback), and answers over BLE with its
   address; the app reloads itself pointed at `ws://<device-ip>:81/ws`.
   Bad credentials: bounded Improv error, stored creds cleared, device
   stays re-provisionable.

Note the mixed-content rule still applies until Phase 4c: from the https
app, plain `ws://` is blocked — so after provisioning, TODAY's checks are
the probe/wall (below) against the device's LAN address. TLS/wss makes the
hosted-app path fully live.

## Flash + bench

```sh
bazelisk run -c opt //firmware/player_app:flash_esp32c6 -- --port /dev/ttyACM0
```

The image (~2.05 MB at `-c opt` with BLE) needs a large app slot;
`:flash_esp32c6` writes the 4 MB "huge app" layout (single 3 MB factory
app + nvs — fits the common 4 MB-flash C6 devkits).

### Flashing from the dev container

The container can't see the board's USB serial port, so run the host helper
(`//tools:flash_server`, stdlib-only) **on the host** and drive it over HTTP
from inside the container:

```sh
# on the host (in the repo checkout):
bazel run //tools:flash_server                # binds 0.0.0.0:8090
#   (or, without bazel:  python3 tools/flash_server.py)

# from the container (host = host.docker.internal or the docker gateway IP):
curl -N host.docker.internal:8090/flash       # build + flash, streams output
curl -N host.docker.internal:8090/logs        # tail the serial console (^C to stop)
curl    host.docker.internal:8090/ports       # list candidate serial devices
```

`/flash` runs `bazel run -c opt //firmware/player_app:flash_esp32c6 -- --port
<auto>` on the host; `/logs` opens the port and streams what the board prints
(`?seconds=N`, `?reset=1`, `?port=`, `?baud=`). A `/flash` preempts an active
`/logs` stream so they never fight over the port. Then:

1. Provision over BLE (above), or join the fallback AP: SSID `ledmapper`,
   password `ledmapper` (device is `192.168.4.1`; serial prints a
   heartbeat line every 5 s with AP + STA state).
2. Protocol bench, no phone required (from a laptop on the AP):

   ```sh
   bazelisk run //tools:player_probe -- ws://192.168.4.1:81/ws --leds 64
   ```

   It walks the whole CORE profile (hello → clock sync → start_mapping →
   counting → set_led_count → map + topology upload through the arena →
   playback probe → stop) and contract-checks every reply; with a strip on
   `LED_DATA_PIN` you should SEE the hue cycle, then the red/blue counting
   halves. The same probe passes against the Pi (`--profile pi --insecure`),
   so a failure is the firmware, not the tool.

3. Phone flow: the wall page over plain http can drive it
   (`?url=ws://192.168.4.1:81/ws`); the CAPTURE app cannot yet — it runs on
   an https origin and mixed content blocks `ws://` (see scope below).

## Deliberate bring-up scope (Phase 4c hardens these)

- **Plain `ws://` on port 81**, no TLS: the RFC 6455 codec + protocol
  bridge are the new machinery being proven; `wss://` via mbedtls (and with
  it, capture-app connectivity and the real landing-page flow) is Phase 4c.
  The landing page served at `/` already builds its bounce URL
  scheme/port-aware (`%%WS_PORT%%` baked to 81).
- **One WebSocket client at a time**; a new connection replaces the old.
- **One reassembly buffer (48 KB)** bounds the largest inbound message — a
  ~1024-LED `submit_map` is ~45 KB; bigger gets close code 1009. The arena
  (96 KB) then bounds what a decoded map+topology may occupy
  (`error{map_too_large}` beyond).
- **AP+STA**: the soft-AP stays up always (bench + re-provisioning
  reachability); STA joins the BLE-provisioned network. mDNS naming comes
  with M11.
- Memory: the generated protobuf links in the FIRMWARE capacity profile
  (control-traffic-sized; uploads bypass it through the arena decoder), so
  the envelope statics are ~2 KB instead of ~230 KB.

## Layout

```text
main.cpp        Arduino app: AP + HTTP + WS pump + FastLED render loop
led_config.h    strip wiring (NUM_LEDS + LED_DATA_PIN) — a LOCAL choice, not
                the vendored @embedded default (whose GPIO8 = onboard LED)
ws_codec.h      RFC 6455 server codec (own SHA-1/base64; ws_codec_test.cc)
improv_codec.h  Improv BLE packet codec (improv_codec_test.cc; same vectors
                as web/tests/improv.test.ts)
improv_ble.*    Improv GATT service (BLE provisioning)
ffi.rs          C ABI over the Rust player stack (tests/ffi.rs drives the
                full device flow through it on the host)
player_ffi.h    the C side of that ABI
```
