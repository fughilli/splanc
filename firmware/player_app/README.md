# ESP32-C6 player app (bring-up build)

The LED Mapper player firmware: WiFi soft-AP, the R2 landing page over HTTP,
the `ledmapper.v1` player protocol over WebSocket, and FastLED strip output
rendering the counting/mapping patterns. The protocol brain is the
host-tested Rust stack (`ledmapper_player` session core, `ledmapper_pattern`
hue code, `ledmapper_arena`/`ledmapper_store` upload storage) behind a C ABI
(`player_ffi.h`); the C++ side owns WiFi, sockets, RFC 6455 framing
(`ws_codec.h`, host-tested byte-exactly) and the LED loop.

## Flash + bench

```sh
bazelisk run -c opt //firmware/player_app:flash_esp32c6 -- --port /dev/ttyACM0
```

The image needs the single-app partition layout (~1.5 MB at `-c opt` >
default.csv's 1.25 MB slot); `:flash_esp32c6` already writes the `no_ota`
table (2 MB app0). Then:

1. Join the AP: SSID `ledmapper`, password `ledmapper` (device is
   `192.168.4.1`; serial prints a heartbeat line every 5 s).
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
- **Soft-AP only**; joining an existing network (STA) + mDNS is config
  work that arrives with the provisioning story (M1/M11).
- Memory: the generated protobuf links in the FIRMWARE capacity profile
  (control-traffic-sized; uploads bypass it through the arena decoder), so
  the envelope statics are ~2 KB instead of ~230 KB.

## Layout

```text
main.cpp        Arduino app: AP + HTTP + WS pump + FastLED render loop
ws_codec.h      RFC 6455 server codec (own SHA-1/base64; ws_codec_test.cc)
ffi.rs          C ABI over the Rust player stack (tests/ffi.rs drives the
                full device flow through it on the host)
player_ffi.h    the C side of that ABI
```
