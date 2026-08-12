<p align="center">
  <img src="web/public/icons/splanc.svg" alt="splanc" width="440" />
</p>

<p align="center">
  <a href="https://github.com/fughilli/splanc/actions/workflows/test.yaml"><img
    src="https://github.com/fughilli/splanc/actions/workflows/test.yaml/badge.svg"
    alt="Test" /></a>
  <a href="https://github.com/fughilli/splanc/actions/workflows/hitl.yaml"><img
    src="https://github.com/fughilli/splanc/actions/workflows/hitl.yaml/badge.svg"
    alt="HITL tests" /></a>
  <a href="https://ledmapper.pages.dev"><img
    src="https://img.shields.io/badge/live%20app-ledmapper.pages.dev-084de7"
    alt="Live app" /></a>
  <a href="https://bazel.build"><img
    src="https://img.shields.io/badge/built%20with-Bazel-43a047"
    alt="Built with Bazel" /></a>
</p>

**Map every LED in an addressable-LED installation in 3D — with just a phone —
then design light effects that flow across the real geometry and play them live
on the controller.**

Mount your LEDs however you like (a sculpture, a ceiling, a sign, a tree), walk
around the lit fixture with your phone, and splanc recovers the `(x, y, z)`
position of every LED. Then you author effects in a browser editor and stream
them to the device, where they run across the fixture's true 3D shape instead of
a guessed layout.

No ARCore, no LiDAR, no depth sensor — capture runs in any modern phone browser
(rear camera + motion sensors), and a visual-inertial solver estimates the
camera path and the LED positions together.

<p align="center">
  <a href="https://youtu.be/JQkMB3vFYJg">
    <img src="https://img.youtube.com/vi/JQkMB3vFYJg/maxresdefault.jpg"
      alt="Watch the splanc intro video" width="640" />
  </a>
  <br />
  <em>▶ Watch the intro video</em>
</p>

## Getting started

The app is a PWA — nothing to install:

**→ <https://ledmapper.pages.dev>**

1. **Onboard your controller.** Starting from a brand-new ESP32-C6 dev board?
   Flash the firmware onto it straight from the PWA over USB (desktop
   Chrome/Edge via Web Serial, or Android Chrome via WebUSB) — no toolchain
   needed. Then put it on your WiFi over Bluetooth and connect to it on your LAN
   (you accept its self-signed certificate once).
2. **Capture a map.** Start a mapping session and walk a slow arc around the lit
   fixture until the live preview converges, then save the map.
3. **Clean it up.** In the mapping workspace, tidy the recovered topology
   (skeleton extraction, junction cleanup) and send the map to the device.
4. **Design effects.** Open the effects editor, pick or write an effect, preview
   it against your map, and send it to the controller to play for real.

## Hardware

- **Controller:** an **ESP32-C6** running the firmware in [`firmware/`](./firmware),
  or a **Raspberry Pi** (see [`pi/`](./pi)). The controller drives the LEDs, runs
  the effects VM, and serves the secure control channel.
- **LEDs:** addressable strips or pixels (SK9822 / APA102 / WS2812-family).
- **Capture device:** any phone with a rear camera and motion sensors
  (Android / Chrome is the primary target).

## How it works

1. **Blink code.** The controller drives the LEDs through a short, self-clocking
   color code that gives every LED a unique temporal signature.
2. **Capture.** You walk around the fixture with the phone. The camera decodes
   each LED's code frame-by-frame while the phone's motion sensors track its
   pose.
3. **Solve.** A visual-inertial bundle adjustment recovers each LED's 3D
   position (and the camera trajectory), metric-scaled and gravity-aligned.
4. **Topology.** The point cloud is turned into a skeleton — strands, segments,
   junctions and loops — so effects can address the fixture by its shape, not
   just its coordinates.
5. **Effects.** You write GLSL-ish shaders in the browser editor (per-LED
   position, segment, distance fields, textures), preview them live, and the
   compiler emits compact bytecode.
6. **Play.** The bytecode runs on the controller's effects VM, streamed over a
   secure WebSocket — so what you see in the editor is what lights up.

## Learn more

- **Contributing & building from source:** [`DEVELOPERS.md`](./DEVELOPERS.md)
- **Design & architecture:** [`led-mapper-design.md`](./led-mapper-design.md) —
  the durable spec — plus [`docs/`](./docs)
- **Project history / build log:** [`WORKLOG.md`](./WORKLOG.md)
