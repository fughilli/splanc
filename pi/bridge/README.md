# pi/bridge: the Raspberry Pi "Splanc bridge" appliance

A Pi on the user's LAN runs `splanc-agent bridge --relay <url>` headless. Its pairing code and
status appear on HDMI and on a Waveshare 1.3" OLED HAT, and the HAT's keys drive the bridge. The
end-user guide is [docs/pi-bridge.md](../../docs/pi-bridge.md). This file covers how the appliance
is built.

```text
install.sh                  the installer (POSIX sh). Ships in the agent bundle, and on splanc.io
bin/splanc-bridge           the on-Pi CLI (status/new-code/identify/revoke-all/logs/update/...)
bin/splanc-bridge-run       ExecStart of splanc-bridge.service (pinned Node + bundle)
systemd/                    splanc-bridge.service, splanc-display.service, update .service/.timer
display/splanc_display/     the screen service (Python)
  status.py                   status.json contract -> Status (lenient), file watcher
  control.py                  control.sock client
  ui.py                       OLED/button state machine (pages, KEY3 hold+confirm, dim/sleep)
  render_hdmi.py              1920x1080-grid status page, scaled to any framebuffer
  render_oled.py              128x64 1-bit pages + overlays
  fb.py                       /dev/fb0 writer (RGB565/XRGB8888, stride), VT 8 takeover
  hat.py                      SH1106 via luma.oled, gpiozero DC/RST adapter, keys, detection
  main.py                     the service loop (HDMI on its own thread)
  ctl.py                      CLI backend for status + commands
  fake_bridge.py              stand-in bridge for tests and demos
display/requirements.lock   hash-pinned pure wheels (luma.core, luma.oled, segno)
tests/                      pytest suite + installer_test.sh
tools/render_gallery.py     PNGs of every screen, for review and for the docs
```

## The bridge contract

The bridge is the agent bundle's `splanc-agent bridge`. This code depends only on this interface:

- **Status file:** `/run/splanc-bridge/status.json` (`SPLANC_BRIDGE_STATUS`), written atomically:

  ```json
  {"v":1,"state":"starting|offline|unpaired|pairing|paired|error","relay":"<url>",
   "bridge_id":"…","pairing":{"code":"ABCD-EFGH","expires_at":<unix s>,"url":"<redeem url>"}|null,
   "clients":<int>,"players":[{"name":"…","host":"…","ok":true}],"lan_ip":"…",
   "error":"…"|null,"updated_at":<unix s>}
  ```

- **Control:** `/run/splanc-bridge/control.sock` (`SPLANC_BRIDGE_CONTROL`). It takes
  newline-delimited JSON (`{"cmd":"new_pairing_code"}`, `{"cmd":"revoke_all"}` or
  `{"cmd":"identify"}`) and answers `{"ok":true,...}` or `{"ok":false,"error":"…"}`.

The display must keep running whatever the file says. Reads are lenient, so unknown states and
fields render instead of crashing. A missing file shows as "Waiting for bridge"; that is also
what happens when the bridge stops, because systemd removes its `RuntimeDirectory`. The pairing
code is shown only while `expires_at` is in the future.

## Delivery

- **Bundle:** `//agent:bundle` packs `:bundle_files` as `pi-bridge/` and copies `install.sh` to
  `site/bridge/install.sh`. splanc.io's `stage-agent.mjs` already copies `site/` verbatim, so
  `https://splanc.io/bridge/install.sh` appears with the first `firmware-v*` release that has
  this directory. splanc.io needs no change.
- **Installer:** fetches `https://splanc.io/agent/latest.json` and downloads the bundle it names,
  checking the sha256. It then installs `pi-bridge/` from inside that same verified bundle. The
  one-liner itself is only a bootstrap.
- **Node:** v22 LTS, pinned with in-script sha256s. Node 24 has no armv7l build, and v22 covers 32-bit
  Pi OS on a Zero 2 W or Pi 3. The architecture comes from `dpkg --print-architecture`, because a
  32-bit OS on a Pi 4/5 still reports `uname -m` = aarch64.
- **Python:** a venv with `--system-site-packages`.
  - From apt: compiled packages built for the board (`python3-pil`, `-cbor2`, `-smbus2`,
    `-spidev`, `-gpiozero`, `-lgpio`).
  - From the lockfile: the three pure wheels, with `pip --isolated --require-hashes --no-deps
--only-binary :all:`. `--isolated` skips Pi OS's piwheels index, whose rebuilt wheels have
    different hashes.
- **Updates:** `splanc-bridge-update.timer` runs daily and calls `splanc-bridge update --auto`.
  That downloads and verifies the new bundle, then runs _the new bundle's_ `install.sh --upgrade`,
  which keeps the settings and the previous version.
- **Pi 5:** GPIO goes through gpiozero (lgpio factory), including the DC/RST lines luma needs.
  `hat.GpioAdapter` replaces luma's default RPi.GPIO, which fails on the RP1. lgpio writes notify
  files in its working directory, so the unit sets `LG_WD`.

### Why no prebuilt SD image (yet)

A pi-gen image in Actions fits the free tier, because the repo is public and `ubuntu-24.04-arm`
runners exist. A Lite stage-2 build takes about 30–45 minutes per release and produces a release
asset of about 500 MB. But it still needs Imager's OS customisation for Wi-Fi and SSH, so the flow
stays "flash → boot", and it saves the user only the one command. It would also add a large asset
we can't boot-test in CI. The installer already supports image builds: with no running systemd
(chroot/pi-gen), it enables the units for next boot instead of starting them, so a later pi-gen
stage is just `install.sh --no-start`. Revisit if users find the SSH step a real hurdle.

## Development

```sh
bazel test //pi/bridge:all                                 # display_test + installer_test
bazel run //pi/bridge:render_gallery -- /tmp/gallery       # every screen as PNG
bazel run //pi/bridge:render_gallery -- --docs "$PWD/docs/img/pi-bridge"

# Live loop without a Pi: the fake bridge + the real service writing PNGs
cd pi/bridge/display
python3 -m splanc_display.fake_bridge --dir /tmp/fb --cycle 5 &
SPLANC_BRIDGE_STATUS=/tmp/fb/status.json SPLANC_BRIDGE_CONTROL=/tmp/fb/control.sock \
  python3 -m splanc_display.main --hdmi png:/tmp/fb/hdmi.png --oled png:/tmp/fb/oled.png

# On a Pi, before a release carries pi-bridge/: the published agent + this checkout's display
sudo sh pi/bridge/install.sh --source pi/bridge
```

`tests/test_luma_gpiozero.py` exercises the real luma.oled and gpiozero (mock pins). It is skipped
under Bazel, which has neither; run it in a venv that has the lockfile plus `gpiozero`, as below.

## What is tested where

| Covered                                                                                                 | How                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status parsing, watcher, button state machine (KEY1/2, KEY3 hold → confirm → revoke, paging, dim/sleep) | `display_test` (pytest, fake clock and dispatcher)                                                                                                 |
| HDMI + OLED rendering of every state and overlay, at several framebuffer sizes                          | `display_test`; PNGs go to the test's `outputs.zip`                                                                                                |
| Framebuffer ioctl parsing, RGB565/XRGB packing, stride, VT takeover                                     | `display_test` (faked ioctls on a regular file)                                                                                                    |
| Buttons → socket → bridge → status → screens                                                            | `display_test` end to end against `fake_bridge` (real AF_UNIX socket)                                                                              |
| luma.oled SH1106 over SPI with the gpiozero DC/RST adapter; gpiozero Buttons                            | `test_luma_gpiozero.py` with gpiozero MockFactory and a fake spidev, on Bookworm's versions (Python 3.11, Pillow 9.4, gpiozero 2.0.1, cbor2 5.4.6) |
| Installer: install, upgrade, prune, settings kept, sha256/no-pi-bridge refusals, I2C, uninstall/purge   | `installer_test` (fake root)                                                                                                                       |
| Real downloads: latest.json → bundle sha256, pinned Node tarball sha256, venv + hash-locked pip         | manual dry run into a fake root, with the display then run against the fake bridge                                                                 |
| Units                                                                                                   | `systemd-analyze verify` with Bookworm's systemd 252 (clean), plus `security --offline`                                                            |
| Shell                                                                                                   | shellcheck (prek)                                                                                                                                  |

Not yet verified on hardware:

- the physical SH1106 panel: orientation (`OLED_ROTATE=2` is derived from the scan-direction
  registers in Waveshare's driver), contrast and burn-in behaviour;
- key debounce on real switches;
- `/dev/fb0` scanout under KMS on a Pi 3/4/5;
- the VT 8 switch;
- apt on real Pi OS;
- the Pi 5 RP1 GPIO path.
