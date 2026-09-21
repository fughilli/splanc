# The PWA (`web/`)

A framework-free, multi-page Progressive Web App — hand-rolled DOM with a hash
router, built with Vite and TypeScript. It is both halves of the user-facing
product: the phone **capture app** that maps a fixture, and the **effects
editor** that authors and previews effects against that map.

Three HTML entry points (`web/vite.config.ts`):

- **`index.html`** — the phone app (capture, calibrate, maps, device onboarding).
- **`effects.html`** — a standalone effects workspace.
- **`wall.html`** — a virtual LED-wall test fixture you can point a phone at to
  exercise the whole live pipeline with no hardware.

Two Rust wasm bundles (the fx compiler and the fx VM) are served alongside and
loaded at runtime, plus the solver wasm worker.

## Key areas of `web/src/`

- **App shell (`ui/app/`)** — `shell.ts` (app bar + `Maps / Effects / Device`
  tabs), `router.ts` (hash routes, mounts/unmounts heavy GL views), `state.ts`
  (global `appState`), and PWA install / service-worker glue.
- **UI kit & screens (`ui/kit/`, `ui/screens/`)** — design tokens, shared
  components, and one module per surface; `ui/mapview.ts` is the shared WebGL LED
  renderer.
- **Capture / CV pipeline** — `xr/` (rear-camera + DeviceMotion IMU), `cv/`
  (`detect` → `ccl` → `tracker` → `decoder` → `pipeline`), `code/` (the Gray-code
  cyclic hue code + FEC + pattern-clock timing), `geom/` (pinhole projection,
  Procrustes fit), `topology/` (skeletonize the solved cloud), and `solver/`
  (phone-side placement/solve).
- **Effects (`effects/`, `fx/`)** — the editor (compiler worker, uniform / MIDI /
  video panels), `effects/ai/` (AI generation), and `fx/preview.ts` (`FxPreview`,
  the exact device VM in-browser over a map's LED positions).
- **Networking (`net/`) & protocol (`gen/`)** — `client.ts` (the wss control
  client), `proto.ts` (the protobuf boundary), `improv.ts` (BLE Wi-Fi
  onboarding), `textureCodec.ts` (video streaming), plus clock sync.
- **`midi/`, `flash/`, `store/`, `color/`** — Web MIDI mapping, in-browser ESP32
  flashing (esptool-js over Web Serial / WebUSB), localStorage persistence, and
  color correction.

## Build & run

```sh
# Serve the real app + control plane over HTTPS, plus the virtual wall:
bazel run //web:serve            # https://0.0.0.0:8443  (/ and /wall.html)

# Production bundle and unit tests:
bazel build //web:dist
bazel test  //web:unit_tests
```

See {doc}`../DEVELOPERS` for the no-hardware pipeline walkthrough and
{doc}`../EFFECTS` for the effects editor internals.

---

The web app's own README (layout, hosting, virtual-wall sync, trace debugging):

```{include} ../web/README.md
:heading-offset: 1
```
