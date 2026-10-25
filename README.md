<p align="center">
  <img src="web/public/icons/splanc.svg" alt="splanc" width="440" />
</p>

<p align="center">
  <a href="https://github.com/Studio-Fug/splanc/actions/workflows/test.yaml"><img
    src="https://github.com/Studio-Fug/splanc/actions/workflows/test.yaml/badge.svg?branch=main&event=push"
    alt="Test" /></a>
  <a href="https://github.com/Studio-Fug/splanc/actions/workflows/hitl.yaml"><img
    src="https://github.com/Studio-Fug/splanc/actions/workflows/hitl.yaml/badge.svg?branch=main&event=push"
    alt="HITL tests" /></a>
  <a href="https://splanc.grafana.net/public-dashboards/0ce888d9584940a6845438d376555b51"><img
    src="https://img.shields.io/badge/HITL%20status-Grafana-f46800?logo=grafana&logoColor=white"
    alt="HITL status" /></a>
  <a href="https://splanc.io/app"><img
    src="https://img.shields.io/badge/live%20app-splanc.io%2Fapp-084de7"
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

## Quickstart

**→ [The Splanc quickstart](./docs/quickstart.md)**: from a bare ESP32-C6
board to mapped, animated lights in a browser. The app is a PWA, nothing to
install: **<https://splanc.io/app>**.

1. **Wire it.** Any ESP32-C6 board (the C6 SuperMini is the reference), a
   WS2812/NeoPixel strip with its data on **GPIO20** (a second strip on
   GPIO14), and a 5 V supply for the strip with a common ground.
2. **Flash it.** Open the app in Chrome or Edge on a computer (or Chrome on
   Android; the iPhone app can't set up new hardware), tap **Flash new device
   (USB)**, then **Connect a board & flash**. No toolchain needed.
3. **Put it on Wi-Fi.** **Add device (Bluetooth)**: enter your Wi-Fi, pick the
   board, and accept its certificate once. From firmware 1.10.0 it remembers
   the network across reboots and updates.
4. **Map it.** **Maps ▸ + New**, then walk slowly around the lit fixture with
   your phone until the live preview converges. You get a 3D map of every LED.
5. **Play.** Pick or write an effect, perform in Show mode, bind MIDI knobs, or
   hand the lights to your AI agent (below).

## Ask an AI agent

Splanc players can also be driven by an AI agent. Tell an agent that has a shell
and Node.js 20 or later _"Use splanc.io to set the mood of the room"_. It reads
<https://splanc.io/AGENTS.md> and finds every Splanc fixture on your LAN. It
treats them as one room, with a shared room frame and clock, and can tweak the
running effect's knobs or write, preview and deploy a new effect.

To install it as an MCP server once:

```sh
claude mcp add splanc -- npx -y https://splanc.io/agent/splanc-agent.tgz
```

There is no LAN authentication, so anyone on your network can drive the lights.
See [`agent/README.md`](./agent/README.md).

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

- **Quickstart:** [`docs/quickstart.md`](./docs/quickstart.md) — wiring,
  flashing, Wi-Fi, mapping, effects and agents, one short section each
- **Using the app:** [`docs/user-guide.md`](./docs/user-guide.md) — a walkthrough of
  every feature (also an interactive tutorial in the app, from Settings ▸ Help)
- **Why it's built this way:** [the Splanc manifesto](./docs/manifesto.md):
  a microcontroller instead of Art-Net boxes, our own wireless stack, no heap,
  and model checking for an LED controller.
- **What's new:** [`docs/whats-new.md`](./docs/whats-new.md)
- **Contributing & building from source:** [`DEVELOPERS.md`](./DEVELOPERS.md)
- **Design & architecture:** [`led-mapper-design.md`](./led-mapper-design.md) —
  the durable spec — plus [`docs/`](./docs)
- **Project history / build log:** [`WORKLOG.md`](./WORKLOG.md)
