# LED Mapper — Raspberry Pi player: provisioning & wiring

This is the setup guide for the **Raspberry Pi 3 player image** (the `.img.zst`
attached to a `pi-v*` release). The Pi runs the LED Mapper player, which streams
pixels over SPI to a **Tang Nano 9K FPGA** (the `spi_ws281x` bitstream); the FPGA
fans the stream out to up to four **WS2812/WS281x** LED strips with exact,
jitter-free timing. The Pi flashes the FPGA itself on boot — no separate
programmer — so once it's wired and on Wi‑Fi it self-commissions.

Default player config (`nix/apps.nix`): output `fpga`, **4 ports × up to ~550
LEDs, 60 fps** (2200 LEDs total). Fewer/shorter strips are fine.

## 1. What you need

- Raspberry Pi 3 (Model B / B+) + a microSD card (≥ 4 GB).
- Tang Nano 9K FPGA board.
- A USB cable, **Pi USB → Tang Nano USB‑C** (the Tang's on-board USB‑JTAG; the Pi
  loads the bitstream over it on boot).
- 3–4 jumper wires for the SPI link (Pi ↔ Tang Nano), plus one data wire per strip.
- WS2812/WS2812B/SK6812 ("WS281x") LED strip(s).
- A **5 V power supply** sized for the LEDs (~60 mA/LED at full white) and,
  recommended, a **3.3 V→5 V level shifter** (e.g. 74AHCT125) per strip data line.

## 2. Flash the image

Download `ledmapper-pi3-<version>.img.zst` from the release, then either:

- **Raspberry Pi Imager** → "Use custom" → select the `.img.zst` → write; or
- Command line (replace `/dev/sdX` with your card — `dd` is unforgiving):

  ```sh
  zstd -dc ledmapper-pi3-<version>.img.zst | sudo dd of=/dev/sdX bs=4M status=progress conv=fsync
  ```

Insert the card into the Pi.

## 3. Wiring

### 3a. Pi ↔ Tang Nano 9K (SPI)

The player drives the FPGA over the Pi's hardware **SPI0** bus (`/dev/spidev0.0`).
Both sides are 3.3 V, so wire them directly — **no level shifter on the SPI link**.

| Signal | Pi (BCM / 40-pin header)   | Tang Nano 9K pin | FPGA net |
| ------ | -------------------------- | ---------------- | -------- |
| MOSI   | GPIO10 — physical pin 19   | **27**           | `mosi`   |
| SCLK   | GPIO11 — physical pin 23   | **26**           | `sck`    |
| CS     | GPIO8 (CE0) — physical 24  | **25**           | `ss`     |
| GND    | any GND — e.g. physical 20 | GND              | —        |

(MISO is unused — the strips are output-only.) The Tang Nano pin numbers are the
labels silk-screened on its headers; they match `fpga/spi_ws281x/tangnano9k.cst`.

### 3b. Tang Nano 9K ↔ LED strips (WS281x data)

The bitstream exposes eight data outputs `ws[0..7]`; the player uses the first
**four** by default. Wire each strip's **DIN** to the matching FPGA pin:

| Strip | Tang Nano 9K pin | FPGA net |
| ----- | ---------------- | -------- |
| 1     | **70**           | `ws[0]`  |
| 2     | **71**           | `ws[1]`  |
| 3     | **72**           | `ws[2]`  |
| 4     | **73**           | `ws[3]`  |

(Ports 5–8 are `ws[4..7]` on pins 74–77 if you raise `ledFpgaPorts`.)

**Level shift the data line.** The FPGA drives 3.3 V; WS281x strips expect ~5 V
logic. Short strips often work at 3.3 V, but for reliability run each `ws[n]`
through a 3.3 V→5 V buffer (74AHCT125) before the strip's DIN.

### 3c. Power & ground

- Power the **LED strips from the 5 V supply**, not the Pi — a full strip draws
  far more than the Pi can source.
- **Tie all grounds together:** Pi GND, Tang Nano GND, level-shifter GND, and the
  5 V supply GND must be common, or the data signal has no reference.
- Inject 5 V at both ends of long runs to avoid brown-out/color shift at the tail.

```text
              3.3 V SPI (direct)          3.3→5 V buffer
   Pi SPI0  ───────────────────►  Tang Nano 9K  ─ws[0..3]─►  [74AHCT125] ─►  WS281x DIN
   (GPIO10/11/8, GND)              (pins 27/26/25)                              │
                                                                    5 V PSU ───┴─ 5 V / GND
   (all grounds common; USB Pi→Tang carries JTAG for the boot-time bitstream load)
```

## 4. First boot

Power the Pi with the Tang Nano connected over USB and the strips wired. On boot
the Pi loads the `spi_ws281x` bitstream onto the FPGA (an `ExecStartPre` on the
`led-driver` service — see `nix/fpga.nix`) and starts streaming. The Tang Nano's
six on-board LEDs run a small frame-activity animation once pixels are flowing.

## 5. Wi‑Fi onboarding (Improv over Bluetooth)

The Pi advertises the **same Improv BLE service as the ESP32‑C6 firmware**, so it
onboards with the same clients (`nix/improv.nix`):

1. Open the LED Mapper web app on a Web-Bluetooth browser (desktop Chrome/Edge, or
   Chrome on Android).
2. **Add device → Bluetooth**, pick the Pi, and enter your Wi‑Fi SSID + password.
3. It hands the credentials to NetworkManager, joins, and reports its IP back —
   then appears as a controllable device in the app.

No keyboard, monitor, or config-file editing required.

## 6. Troubleshooting

- **No LEDs / wrong colors:** check the common ground first, then the data-line
  level shift, then that each strip's DIN is on the FPGA pin you expect
  (`ws[0]`=70…). Confirm strip direction (wire DIN, not DOUT).
- **FPGA didn't load:** the Tang Nano must be on the Pi's USB at boot; the Pi
  programs it via `openFPGALoader`. `journalctl -u led-driver` shows the load step.
- **More/fewer strips, longer runs, or different rate:** `ledFpgaPorts`,
  `ledStartLeds`, `ledFps` live in `nix/apps.nix`; rebuild the image to change them.
- **APA102 instead of WS281x:** flip `ledOutput` to `apa102` in `nix/apps.nix`
  (drives APA102/SK9822 clock+data over SPI directly, no FPGA).

---

## Developer reference — image build & live-deploy (sbc-deploy consumer)

Make a fresh Raspberry Pi field-ready and keep it updated with a **Bazel + Nix**
workflow. The tooling that used to live here (a bespoke `nixos-raspberrypi` flake,
hand-written NixOS modules, and shell wrappers) was extracted into the reusable
[**sbc-deploy**](https://github.com/fughilli/sbc-deploy) framework; this directory
is now a thin consumer of it. Release images are built by `.github/workflows/release.yaml`
on a `pi-v*` tag (`ledmapper_pi3.image_sd --no-write`).

### Targets

```sh
bazel run //pi/provisioning:ledmapper_pi3.keys          -- init                 # deploy SSH key (once)
bazel run //pi/provisioning:ledmapper_pi3.image_sd      -- --device /dev/sdX    # full image: base + app
bazel run //pi/provisioning:ledmapper_pi3.image_sd      -- --no-write           # just build the .img.zst
bazel run //pi/provisioning:ledmapper_pi3.image_sd_base -- --device /dev/sdX    # base image: networking only
bazel run //pi/provisioning:ledmapper_pi3.deploy_live   -- ledmapper.local      # push app to a running Pi
bazel run //pi/provisioning:ledmapper_pi3.ssh           -- ledmapper.local      # shell in (deploy key)
```

(`ledmapper.*` targets build the Pi 5 variant; the released fleet image is Pi 3 —
`ledmapper_pi3.*`.) On macOS, start the aarch64-linux builder first (see the
sbc-deploy README "Building on Apple Silicon"):

```sh
bazel run @sbc_deploy//:linux_builder      # leave running
bazel run @sbc_deploy//:cache              # optional: persistent binary cache
```

### Layout

```text
pi/provisioning/
  BUILD.bazel        # sbc_application(name = "ledmapper" / "ledmapper_pi3", …)
  nix/
    flake.nix        # sbc-deploy.lib.mkSbcProject { hostName = "ledmapper"; … }
    apps.nix         # services.sbcApps.{led-driver,led-server} + FPGA/LED config
    fpga.nix         # boot-time bitstream load (openFPGALoader ExecStartPre)
    improv.nix       # Improv-over-BLE Wi-Fi onboarding
  secrets/           # gitignored deploy key (generated by the keys target)
```

The framework provides the base system (mDNS `ledmapper.local`, key-only SSH with
the baked deploy key, firewall, NetworkManager) and the hardware SPI module; this
repo declares the applications, the FPGA/Improv modules, and the board.

### Integration points

Self-contained: sbc-deploy is fetched from GitHub, pinned on both sides.

- `//MODULE.bazel` — `bazel_dep(name = "sbc_deploy")` + `git_override` (pinned
  commit). Bazel side.
- `nix/flake.nix` + `nix/flake.lock` — `inputs.sbc-deploy` pinned to the same
  commit. Nix side.
- `//pi/provisioning:BUILD.bazel` — the `sbc_application` macro.

Bump both together: update the `git_override` commit in `//MODULE.bazel` and run
`nix flake update sbc-deploy` in `nix/`. To co-develop sbc-deploy locally without
pushing, use `bazel --override_module=sbc_deploy=/path` and
`nix … --override-input sbc-deploy path:/path/nix`.
