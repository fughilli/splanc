# pi/bridge: the Raspberry Pi "Splanc bridge" appliance

A Pi on the user's LAN runs `splanc-agent bridge` headless. Its pairing code and status appear on
HDMI and on a Waveshare 1.3" OLED HAT, and the HAT's keys drive the bridge. The end-user guide is
[docs/pi-bridge.md](../../docs/pi-bridge.md). This file covers how the appliance is built.

There are two ways onto a Pi, sharing the display service and the bridge contract below:

- **The SD image + flasher (primary, no terminal).** `image/` is a NixOS SD image per board, built
  and released by CI on `pi-bridge-v*` tags. `flasher/` is the **Splanc Bridge Flasher** desktop
  app that downloads it, takes the Wi-Fi settings and writes the card. See
  [The SD image](#the-sd-image) and [The flasher](#the-flasher).
- **`install.sh` on Raspberry Pi OS (power users).** One `curl | sudo sh` onto an existing Pi OS
  install. See [Delivery](#delivery).

```text
image/                      the NixOS SD image (flake.nix) — see "The SD image"
flasher/                    Splanc Bridge Flasher (Electron + Python sidecar) — see "The flasher"
install.sh                  the Pi OS installer (POSIX sh). Ships in the agent bundle, and on splanc.io
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

## The SD image

`image/flake.nix` builds one NixOS image per board (`image-pi5`, `image-pi4`, `image-pi3`,
`image-zero2w`) from nvmd/nixos-raspberrypi at the same pins as `pi/provisioning` and td-deploy
(through sbc-deploy, the commit `//MODULE.bazel` uses), so the RPi kernels built for those images
come from the fugstudio Cachix. It doesn't use sbc-deploy's `mkSbcSystem`, which bakes in a
live-deploy SSH key and tailscale; it takes the board modules and sbc-deploy's `sbc-base` (mDNS,
NetworkManager, lean firmware) and adds:

```text
image/nix/bridge.nix        the appliance: users, splanc-bridge / splanc-display services,
                            agent self-update timer, optional SSH, read-mostly tuning
image/nix/flash-config.nix  splanc-flash-config.service: applies the flasher's boot-partition files
image/nix/rpi.nix           Pi bits: SPI + I2C + key pull-ups in config.txt, gpiochip perms, image name
image/nix/lean.nix          size trims (no docs, rescue tools, nixpkgs source, ModemManager, gtk3)
image/nix/packages.nix      agent bundle (agent-pin.json), Python env (luma from requirements.lock,
                            lgpio from its sdist), fonts
image/nix/vm-test.nix       QEMU smoke test (generic aarch64 VM, same appliance modules)
image/splanc_image/         on-device Python: bootconfig.py (boot-partition settings),
                            selfupdate.py (verified agent bundle updates)
image/agent-pin.json        the agent bundle baked into the image (version, url, sha256)
```

- **First boot, every boot:** `splanc-flash-config` runs before NetworkManager and avahi. It
  sets the hostname and Wi-Fi country from `/boot/firmware/splanc-bridge.conf`, moves
  `system-connections/*.nmconnection` into NetworkManager (root, 0600) and deletes them from the
  FAT partition, writes the other settings to `/run/splanc-flash/bridge.env` for the services, and
  merges `authorized_keys` (sshd only starts if there are keys; there are no passwords).
- **The agent:** the image bakes the bundle named in `agent-pin.json` (a `firmware-v*` release
  asset, sha256-pinned). `splanc-agent-update.timer` (2 min after boot, then daily) runs
  `selfupdate.py` as the `splanc-update` user: it fetches `splanc.io/agent/latest.json`, checks the
  bundle's sha256, unpacks it safely (plain files under one top directory only) into
  `/var/lib/splanc-agent/agent/<ver>`, flips `current`, keeps the previous version and restarts the
  bridge. The bridge runs as `splanc` and can only read that directory. A bundle older than the
  bridge (no `bridge` command) puts an explanatory error on the screens until an update arrives.
- **State:** `/var/lib/splanc-bridge` (bridge identity `bridge.json`, hub config) and
  `/var/lib/splanc-agent` survive reboots; the journal is in RAM, `/tmp` is tmpfs and `/` is mounted
  `noatime`. A fully read-only root wasn't worth it: the first boot grows the root partition and
  registers the Nix store, so it would need an overlay.
- **OS updates:** by writing a newer `pi-bridge-v*` image (which resets the bridge identity, so
  agents pair again). An A/B or `nix copy`-based in-place update is future work.
- **Boards:** Pi 5 (bcm2712 kernel) and Pi 3 / Pi 4 / Zero 2 W (one shared bcm2711 kernel, so they
  cost one kernel build between them). All four ship; the Zero 2 W (512 MB) gets zram swap.

Build and test locally (aarch64 Linux with Nix; the images need a few GB of store):

```sh
nix build ./pi/bridge/image#image-pi5 -L          # result/sd-image/splanc-bridge-pi5.img
nix build ./pi/bridge/image#checks.aarch64-linux.vm -L   # needs the kvm system feature
# Without KVM: build the driver and run it outside the sandbox (QEMU falls back to TCG)
nix build ./pi/bridge/image#checks.aarch64-linux.vm.driver && ./result/bin/nixos-test-driver
```

The VM test copies out the HDMI page the display service rendered inside the VM (against a stub
bridge, with the relay from the flash-time settings):

![The HDMI page rendered in the image's QEMU smoke test](../../docs/img/pi-bridge/image-vm-hdmi.png)

CI (`.github/workflows/pi-bridge-image.yml`) builds every board on pushes to main that touch
`pi/bridge/**` (validation + Cachix warm-up), and on a `pi-bridge-v*` tag builds, measures
(closure top-25 + raw/compressed size, failing above 1 GB compressed), compresses with
`zstd -19` and attaches `splanc-bridge-<board>-<ver>.img.zst` + `.sha256` to the release, along with
the flasher installers. Agents decide when to cut a tag (the workflow header says how).

## The flasher

`flasher/` is adapted from td-deploy Studio's flasher (same author, MIT): an Electron window
(`electron/`) and a Python sidecar (`sidecar.py`, JSON lines over stdio) frozen with PyInstaller.

```text
flasher/splanc_flasher/releases.py  newest non-prerelease pi-bridge-v* release; download, sha256 check
                                    (the .sha256 asset, cross-checked with GitHub's digest), zstd unpack
flasher/splanc_flasher/disks.py     removable disks only (per-OS parsers of diskutil / Get-Disk / lsblk)
flasher/splanc_flasher/flash.py     re-check the disk, elevated write, then mount the boot partition as
                                    the user and write the settings
flasher/splanc_flasher/rawwrite.py  the privileged worker: write, read back + compare, progress file
flasher/splanc_flasher/elevate.py   osascript admin prompt / UAC PowerShell (offline -> write -> online
                                    + drive letter) / pkexec
flasher/splanc_flasher/bootfiles.py splanc-bridge.conf + the NetworkManager keyfile
flasher/packaging/                  PyInstaller spec, build_app.sh (macOS, Linux), build_app.ps1 (Windows)
flasher/tools/                      demo.js + screenshots.sh: the window in each state, for the docs
```

Safety: only removable media is ever listed (internal, virtual, system/boot, read-only disks and
disks holding a mounted system path are filtered out), the target is re-checked right before
writing, an image larger than the card is refused, disks over 256 GB need a second confirmation,
and the written card is read back and compared before the settings go on.

The keyfile writes the SSID as NetworkManager's byte list (`ssid=72;111;109;101;`), which is
unambiguous for every SSID (a plain `ssid=123` would be read as one byte), and escapes the PSK as a
GLib key-file string. The VM test feeds NetworkManager a profile the flasher rendered for an
SSID/PSK full of `;`, `\`, `#`, `=`, leading/trailing spaces and non-ASCII, and checks `nmcli`
reads them back exactly.

Run it from source (Python 3.14, or 3.11+ with `zstandard`, plus Node 22):

```sh
cd pi/bridge/flasher/electron && npm ci && npx electron .   # uses ../sidecar.py
```

Signing: none of the signing secrets exist yet, so macOS builds are ad-hoc signed and Windows
builds unsigned (users confirm once; docs/pi-bridge.md says how). To sign, add repository
secrets `MAC_CSC_LINK` + `MAC_CSC_KEY_PASSWORD` (Developer ID Application .p12, base64) and
`APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID` (notarization), and/or
`WIN_CSC_LINK` + `WIN_CSC_KEY_PASSWORD` (Authenticode .pfx, base64); the workflow picks them up.

## Development

```sh
bazel test //pi/bridge/...                                 # display, installer, image, flasher tests
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

| Covered                                                                                                                                                                                                                | How                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status parsing, watcher, button state machine (KEY1/2, KEY3 hold → confirm → revoke, paging, dim/sleep)                                                                                                                | `display_test` (pytest, fake clock and dispatcher)                                                                                                 |
| HDMI + OLED rendering of every state and overlay, at several framebuffer sizes                                                                                                                                         | `display_test`; PNGs go to the test's `outputs.zip`                                                                                                |
| Framebuffer ioctl parsing, RGB565/XRGB packing, stride, VT takeover                                                                                                                                                    | `display_test` (faked ioctls on a regular file)                                                                                                    |
| Buttons → socket → bridge → status → screens                                                                                                                                                                           | `display_test` end to end against `fake_bridge` (real AF_UNIX socket)                                                                              |
| luma.oled SH1106 over SPI with the gpiozero DC/RST adapter; gpiozero Buttons                                                                                                                                           | `test_luma_gpiozero.py` with gpiozero MockFactory and a fake spidev, on Bookworm's versions (Python 3.11, Pillow 9.4, gpiozero 2.0.1, cbor2 5.4.6) |
| Installer: install, upgrade, prune, settings kept, sha256/no-pi-bridge refusals, I2C, uninstall/purge                                                                                                                  | `installer_test` (fake root)                                                                                                                       |
| Real downloads: latest.json → bundle sha256, pinned Node tarball sha256, venv + hash-locked pip                                                                                                                        | manual dry run into a fake root, with the display then run against the fake bridge                                                                 |
| Image: boot-partition settings parsing/validation, keyfile move off the FAT partition, SSH key merge                                                                                                                   | `//pi/bridge/image:image_py_test`                                                                                                                  |
| Image: self-update (sha256, hostile tarballs, rollback by publishing an older version, pruning)                                                                                                                        | `//pi/bridge/image:image_py_test`                                                                                                                  |
| Image: boots; flash config applied; bridge on the baked bundle, then self-updated onto a newer one with the flash-time relay; NetworkManager reads the flasher's tricky keyfile exactly; HDMI page renders; CLI        | `checks.aarch64-linux.vm` (QEMU, generic aarch64; CI `vm-test` job)                                                                                |
| Image: every board evaluates and builds; config.txt has SPI/I2C/pull-ups; size budget                                                                                                                                  | CI `image` job (and `nix eval` locally)                                                                                                            |
| Flasher: disk filtering, raw write + read-back, progress protocol, elevation wrappers, keyfile/conf rendering round-tripped through the image's parser, release lookup, download + checksum + unpack, sidecar protocol | `//pi/bridge/flasher:flasher_test`; again on each OS before packaging                                                                              |
| Units                                                                                                                                                                                                                  | `systemd-analyze verify` with Bookworm's systemd 252 (clean), plus `security --offline`                                                            |
| Shell                                                                                                                                                                                                                  | shellcheck (prek)                                                                                                                                  |

Not yet verified on hardware:

- the physical SH1106 panel: orientation (`OLED_ROTATE=2` is derived from the scan-direction
  registers in Waveshare's driver), contrast and burn-in behaviour;
- key debounce on real switches;
- `/dev/fb0` scanout under KMS on a Pi 3/4/5;
- the VT 8 switch;
- apt on real Pi OS;
- the Pi 5 RP1 GPIO path;
- the SD image booting on real Pi 3/4/5/Zero 2 W hardware (CI builds it and the VM test runs the
  same appliance modules, but QEMU can't run the Pi firmware);
- the flasher writing a real card on macOS, Windows and Linux (the installers are built and their
  frozen sidecar is smoke-tested in CI; the elevated write paths are unit-tested only).
