# Splanc quickstart

From a bare ESP32-C6 board and an LED strip to mapped, animated lights, using
only a browser. No toolchain and no command line are needed until you add an AI
agent. Each step below links to the full docs.

Current releases: firmware `firmware-v1.10.0`, app `app-v1.10.0`, Pi bridge
`pi-bridge-v1.0.1` ([releases](https://github.com/fughilli/splanc/releases)).

## 1. What you need

| Item                      | Notes                                                                                                                                                                                                                                                 |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An **ESP32-C6** board     | The firmware's pin choices are made for the **ESP32-C6 SuperMini**. The released image is a 4 MB-flash ESP32-C6 build, so other common C6 dev boards should work too, as long as GPIO20 is broken out.                                                |
| A **WS2812-family** strip | WS281x / NeoPixel-style, one data wire. Up to 512 LEDs per board.                                                                                                                                                                                     |
| A **5 V power supply**    | Sized for your strip.                                                                                                                                                                                                                                 |
| A **USB-C data cable**    | Data-capable, not charge-only. You flash the board with it.                                                                                                                                                                                           |
| A **computer or phone**   | To flash: **desktop Chrome or Edge** (Web Serial), or **Chrome on Android** (WebUSB). iPhone and iPad can't flash. To set up Wi-Fi over Bluetooth: Chrome on desktop or Android. To map and play: any modern phone browser, iPhone (Safari) included. |
| A Raspberry Pi (optional) | Only for the [cloud bridge](#7-bring-your-ai-agent) (Pi 5 or 4 recommended; Pi 3 and Zero 2 W work).                                                                                                                                                  |

## 2. Wire it

```text
ESP32-C6 GPIO20  ──────────────▶  strip DIN      (channel 1)
ESP32-C6 GPIO14  ──────────────▶  2nd strip DIN  (channel 2, optional)
ESP32-C6 GND     ──────┬───────   strip GND
5 V supply −     ──────┘
5 V supply +     ──────────────▶  strip 5V
```

- **Data → GPIO20.** A second strip (or the second half of a long one) goes on
  **GPIO14**; the two channels clock out in parallel.
- **Common ground**: the board, the strip and the supply share GND.
- **Power the strip from the supply**, not from the board.
- Pins are configurable later in the app (the device's ⋮ menu ▸ **Hardware**). Avoid the
  C6's strapping pins (4/5/8/9/15), USB-JTAG (12/13) and, on the SuperMini,
  18/19 (its internal flash).

Source: [`firmware/player_app/led_config.h`](../firmware/player_app/led_config.h).

## 3. Flash the firmware

1. Plug the board in over USB and open **<https://splanc.io/app>** in desktop
   Chrome/Edge (or Chrome on Android).
2. On the **Set up your device** screen tap the chip icon, **Flash new device
   (USB)**. Later, it's in the device sheet as **Flash firmware (USB)**.
3. Leave **Firmware source** on **GitHub releases**. The newest release is
   picked for you (**Heapless netstack — firmware-v1.10.0**).
4. Tap **Connect a board & flash**, pick the board in the browser's port
   chooser, and keep it plugged in until **✓ Flashed successfully**.

Board not listed? Tap **Try without vendor filter**, and try another cable.
More: [Flashing firmware](user-guide.md#flashing-firmware).

## 4. Put it on Wi-Fi

1. Tap the Bluetooth icon, **Add device (Bluetooth)**.
2. Enter your Wi-Fi name and password (the eye button shows the password), tap
   **Scan for device**, and pick the board in the Bluetooth chooser.
3. The board joins your Wi-Fi and the app connects to it. The first time, your
   browser asks you to trust the device's own security certificate; accept it
   once.

From firmware 1.10.0 the board **saves its Wi-Fi** once it has joined, so it
rejoins by itself after a power cut, a reset or a firmware update. A board on an
older release needs one last provision after updating.

No Bluetooth in your browser (iPhone Safari)? Set up the board once from Chrome
on a desktop or Android phone, then use **Enter address manually** on the
iPhone. More: [Connecting a device](user-guide.md#connecting-a-device).

## 5. Map it

1. Check the basics in the device's ⋮ menu ▸ **Hardware** (the device sheet
   opens from the status pill at the top): the LED count on each channel,
   and **Check color order** if red doesn't look red.
2. In **Maps**, tap **+ New**, confirm the **Number of LEDs on the fixture**, and
   tap **Start mapping**.
3. Frame the fixture and **walk slowly around it**. Views from several angles
   let the solver triangulate depth. Keep going until the live preview looks
   complete, then tap **Stop & finish**.
4. LEDs behind a diffuser? Turn on **Diffuse capture** on the capture screen.
   It lights every Nth LED per phase (the **Stride length**, default 4, set in
   **Hardware**) so neighbouring spots don't bleed together.

You get a **3D map** of every LED, in metres with +Y up, plus a topology
skeleton (strands, junctions, loops). Tidy it in the mapping workspace, send
it to the device, or export it to TouchDesigner or Chromatik. More:
[Mapping a fixture](user-guide.md#mapping-a-fixture-with-the-camera).

## 6. Play

- **Effects**: pick one in the **Effects** tab, or write your own in the editor.
  The preview runs the same VM as the firmware, so what you see is what the
  fixture does. Push it to the device. ([Effects engine](../EFFECTS.md))
- **Show mode**: the **Effects** tab's ⋯ menu, **Show mode (cue +
  crossfade)**, gives you two decks with a crossfader. **⋯ ▸ Live via bridge**
  drives every fixture on your bridge from one phone.
- **MIDI**: **Settings ▸ MIDI** names your controller's knobs. Bind them to an
  effect's uniforms in the editor.
- **Effects AI**: describe a change and the editor's assistant drafts it. Use
  your own API key (Anthropic, OpenAI, Gemini, ...), a local server (Ollama, LM
  Studio, llama.cpp), or a model that runs in the browser.

## 7. Bring your AI agent

**On your own computer** (Claude Code, Codex, Cursor, ...: anything with a shell
and Node.js 20 or later on the same LAN as the lights). Add the Splanc MCP server
(stdio):

```sh
claude mcp add splanc -- npx -y https://splanc.io/agent/splanc-agent.tgz
```

For other MCP clients, use the command `npx` with the args
`["-y", "https://splanc.io/agent/splanc-agent.tgz"]` over stdio. Or just tell
the agent _"Use splanc.io to set the mood of the room"_: it reads
<https://splanc.io/AGENTS.md> and finds every fixture on your LAN. There is no
LAN authentication, so anyone on your network can drive the lights. More:
[`agent/README.md`](../agent/README.md).

**From the cloud** (claude.ai, ChatGPT, Claude Code on the web):

1. Set up a **Splanc bridge**. Write a microSD card with the **Splanc Bridge
   Flasher** (from the `pi-bridge-v…` release), boot the Pi, and it shows
   **Ready to pair** with a code like `ABCD-EFGH`.
   ([Pi bridge guide](pi-bridge.md))
2. Add the custom connector **`https://splanc.pages.dev/mcp`** in your agent.
   In Claude, go to Settings → Connectors → Add custom connector. When it asks
   you to sign in, type the pairing code.
   ([Cloud agent guide](guides/cloud-agent.md), or
   [run your own relay with Tailscale](guides/relay-tailscale.md))

## 8. Optional extras

- **Motion sensor**: wire an **MPU-6050** (e.g. a GY-521) to **SDA GPIO6,
  SCL GPIO7**, with INT on **GPIO21** (optional). The player finds it at boot,
  and effects react through uniforms such as `imu_gravity`, `imu_shake` and
  `imu_tap`. Try `agent/skill/examples/imu_tilt.fx`.
  ([sensor-core.md](design/sensor-core.md))
- **Several fixtures and rooms**: add more boards. An agent treats them as
  rooms, with a shared room frame and clock, and **Live via bridge** drives
  them all from the app.
- **Colour correction**: per-device gamma and white balance
  (the device's ⋮ menu ▸ **Gamma**).

## 9. Troubleshooting

1. **Flashing finds no board**: use a data-capable USB cable, tap **Try without
   vendor filter**, and use desktop Chrome/Edge or Android Chrome (iOS can't
   flash).
2. **No Bluetooth option**: your browser has no Web Bluetooth (iPhone, Firefox).
   Provision from Chrome on desktop or Android, then connect by address.
3. **The app can't reach the device after Wi-Fi setup**: accept the device's
   certificate when the browser asks (once per device). A certificate-changed
   warning is expected only after a factory reset: tap **I reset it — trust the
   new certificate**.
4. **Colours are wrong**: the device's ⋮ menu ▸ **Hardware** ▸ **Check color order**, then tap
   the swatch that matches what the strip shows.
5. **A map comes out wrong or empty**: walk slower and cover more angles, and
   try **Diffuse capture** for diffused fixtures. Turn on **Settings ▸ Behavior
   ▸ Developer ▸ Enable Debug Settings** to save a capture bundle you can attach
   to a bug report.

Bridge problems (code expired, no players listed) are covered in the
[cloud agent](guides/cloud-agent.md#troubleshooting) and
[Pi bridge](pi-bridge.md#troubleshooting) guides.

**Get help**: open an issue on
[GitHub](https://github.com/fughilli/splanc/issues), or ask on the
[Splanc Discord](https://discord.gg/wqY9pHavnD). The full walkthrough of every
screen is the [user guide](user-guide.md); recent changes are in
[What's new](whats-new.md).
