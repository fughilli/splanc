# Set up a Splanc bridge on a Raspberry Pi

A **Splanc bridge** is a small always-on computer on your home network that connects your
Splanc fixtures to the Splanc cloud relay. With it, the app (or an AI agent) can reach your lights
from anywhere, not only from the same Wi-Fi. A Raspberry Pi works well as a bridge. It runs with no
keyboard or mouse, and it shows its pairing code and status on two screens:

- a TV or monitor plugged into its HDMI port;
- a small OLED add-on board (optional).

You flash a memory card, boot the Pi and run **one command**. The steps below take about 15
minutes, and most of that is waiting.

![The HDMI status page while the bridge waits to be paired](img/pi-bridge/hdmi-pairing.png)

## What you need

| Item                       | Notes                                                                                                                                                                                                                                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Raspberry Pi               | Pi 4 or Pi 5 recommended. A Pi 3B/3B+ or Pi Zero 2 W works too.                                                                                                                                                                                                                                               |
| Power supply               | The official supply for your model (USB-C 5 V 3 A for a Pi 4; 5 V 5 A for a Pi 5).                                                                                                                                                                                                                            |
| microSD card               | 8 GB or larger.                                                                                                                                                                                                                                                                                               |
| Network                    | Wi-Fi or Ethernet, on the **same network as your fixtures**.                                                                                                                                                                                                                                                  |
| HDMI screen (optional)     | Any TV or monitor. A Pi 4/5 needs a micro-HDMI cable; a Zero 2 W needs mini-HDMI.                                                                                                                                                                                                                             |
| OLED HAT (optional)        | **Waveshare 1.3inch OLED HAT** (128×64, SH1106, with a 5-way joystick and three keys; e.g. Amazon B07VCYTPRK). It plugs onto the Pi's 40-pin header, so it needs no wiring or soldering. A Zero 2 W needs a version with the header already soldered on ("WH"). Leave the HAT's factory SPI setting as it is. |
| A computer with an SD slot | To run Raspberry Pi Imager once.                                                                                                                                                                                                                                                                              |

You need at least one of the two screens to read the pairing code from the Pi itself. You can also
read it over SSH with `splanc-bridge status`.

## 1. Flash Raspberry Pi OS with Raspberry Pi Imager

1. Install **Raspberry Pi Imager** from <https://www.raspberrypi.com/software/> and open it.
2. **Choose Device**: pick your Pi model.
3. **Choose OS**: _Raspberry Pi OS (other)_ ▸ **Raspberry Pi OS Lite (64-bit)**. The bridge needs no
   desktop. The 32-bit Lite image works too, and a desktop image is also fine.
4. **Choose Storage**: pick your microSD card, then **Next**.
5. When asked _"Would you like to apply OS customisation settings?"_, choose **Edit Settings**. On
   the **General** tab:
   - **Set hostname**: `splanc-bridge`
   - **Set username and password**: choose your own.
   - **Configure wireless LAN**: your Wi-Fi name and password, and your **Wireless LAN country**.
     Skip this if you use Ethernet.
   - **Set locale settings**: your time zone.
6. On the **Services** tab, tick **Enable SSH** (password authentication is fine). Click **Save**,
   then **Yes** to apply the settings, then **Yes** to write the card.

## 2. Boot the Pi

If you have the OLED HAT, fit it onto the Pi's header first, with the Pi unplugged. Plug in the
HDMI screen if you use one. Then insert the card and connect power. The first boot takes a minute
or two, because the Pi expands the file system and joins your Wi-Fi.

## 3. Run the installer

From your computer, open a terminal and log in to the Pi. Use the username you set in Imager:

```sh
ssh yourname@splanc-bridge.local
```

On the Pi, run:

```sh
curl -fsSL https://splanc.io/bridge/install.sh | sudo sh
```

The installer:

- installs Node.js and the Splanc bridge, checking each download against its published checksum;
- installs the screen service;
- switches on the OLED HAT's SPI interface;
- starts everything.

When it finishes, it prints the bridge status, including the **pairing code**. From now on, the Pi
starts the bridge by itself every time it boots, even with no keyboard, screen or login. The
bridge finds your fixtures on the network by itself.

Installer options are passed after `sh -s --`. For example:

```sh
curl -fsSL https://splanc.io/bridge/install.sh | sudo sh -s -- --oled off
```

| Option                       | Effect                                                                                       |
| ---------------------------- | -------------------------------------------------------------------------------------------- |
| `--oled auto\|spi\|i2c\|off` | OLED HAT mode. `auto` is the default: it finds the HAT by itself. `off` skips the SPI setup. |
| `--relay URL`                | Use a different relay. By default, the bridge uses its built-in relay.                       |
| `--no-start`                 | Install without starting the services.                                                       |

## 4. Pair

Open the address shown under the code (or scan the QR code) on your phone, and enter the code. The
code expires after a few minutes. Press **KEY1** on the HAT, or run `splanc-bridge new-code`, to
get a fresh one.

## What the screens show

**HDMI**: a full-screen status page, which updates by itself. While a code is waiting to be used,
the page shows:

- the code, in large letters;
- a QR code of the pairing link;
- how long until the code expires.

After pairing, it shows how many clients are connected. Along the bottom are:

- **Fixtures**: the players the bridge found, with a green or red dot for online or not;
- **Paired clients**: how many apps are paired with this bridge;
- **Network**: the Pi's address, the relay and the bridge ID.

The page takes over console 8. With a keyboard plugged in, press <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>F1</kbd>
to get a login prompt, and <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>F8</kbd> to return to the status page.

![HDMI after pairing](img/pi-bridge/hdmi-paired.png)

**OLED HAT**: four pages, which rotate every 8 seconds:

1. **Home**: the state, the pairing code in large letters, the short pairing link, the time left
   and the number of clients.
2. **Scan to pair**: a QR code of the pairing link.
3. **Fixtures**: up to four players, with ● for online and × for offline.
4. **Network**: the IP address, the relay, the number of clients and the bridge ID.

![OLED pages](img/pi-bridge/oled-pages.png)

To protect the OLED from burn-in, it behaves as follows:

- the image moves by one pixel every minute;
- the screen dims after 2 minutes without a button press or a change;
- the screen turns off after 30 minutes, but only while no pairing code is showing.

Any key wakes it. That first press only wakes the screen and does nothing else.

### States

| Shown as           | Meaning                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------- |
| Waiting for bridge | The bridge service isn't running yet (or has stopped).                                                  |
| Starting           | The bridge is starting up.                                                                              |
| Offline            | The bridge can't reach the relay (no internet). Fixtures on your network still work from the local app. |
| Not paired         | No app is paired, and no code is showing. Press **KEY1** for a code.                                    |
| Ready to pair      | A pairing code is waiting to be used.                                                                   |
| Paired             | One or more apps are paired.                                                                            |
| Error              | The bridge reported a problem. The message is on screen; see `splanc-bridge logs` for details.          |

## OLED HAT buttons

| Button                       | Action                                                                                                                                                                     |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **KEY1**                     | Get a new pairing code.                                                                                                                                                    |
| **KEY2**                     | Identify fixtures (every fixture flashes so you can tell them apart).                                                                                                      |
| **KEY3**, held for 5 seconds | Revoke all clients. A progress bar fills while you hold. Then a confirm screen appears: press **KEY3** again to confirm. Any other key, or 10 seconds of waiting, cancels. |
| Joystick right / down        | Next page.                                                                                                                                                                 |
| Joystick left / up           | Previous page.                                                                                                                                                             |
| Joystick press               | Back to the home page.                                                                                                                                                     |

After a joystick press, the pages stop rotating for 30 seconds.

![Holding KEY3, the revoke confirm screen, a button result, and the paired home page](img/pi-bridge/oled-overlays.png)

## Managing the bridge

Log in over SSH and use `splanc-bridge`:

```sh
splanc-bridge status            # state, code, fixtures, clients
splanc-bridge new-code          # a fresh pairing code
splanc-bridge identify          # flash every fixture
splanc-bridge revoke-all        # unpair every client (asks first)
splanc-bridge logs              # recent logs; add -f to follow
sudo splanc-bridge restart
sudo splanc-bridge update       # install the latest release now
sudo splanc-bridge config       # edit settings, then restart
sudo splanc-bridge uninstall    # remove it (add --purge to also delete settings and pairing data)
```

**Updates are automatic.** Once a day, the bridge checks splanc.io for a new release. If there is
one, it downloads it, checks its checksum, installs it and restarts. The previous version is kept
on disk. To turn automatic updates off, set `SPLANC_AUTO_UPDATE=0` with `sudo splanc-bridge config`.

**Settings** are in `/etc/splanc-bridge/bridge.env`, and updates keep them. Your pairing data is in
`/var/lib/splanc-bridge`. The settings are:

- `SPLANC_RELAY`: the relay to use.
- `OLED`: the OLED HAT mode (`auto`, `spi`, `i2c` or `off`).
- `OLED_ROTATE`: `0`–`3`, in steps of 90°. Use `0` if the picture is upside down.
- `SPLANC_DISPLAY_HDMI`: `auto` or `off`.
- `SPLANC_AUTO_UPDATE`: `1` to update automatically, `0` not to.

## Troubleshooting

**`ssh: Could not resolve hostname splanc-bridge.local`**: wait another minute after the first
boot. If it still fails, find the Pi's IP address in your router's device list and use
`ssh yourname@<ip>`. If the Pi never shows up, check the Wi-Fi name, password and country you set
in Imager. The Pi 3B and Zero 2 W only use 2.4 GHz Wi-Fi.

**The installer says "Splanc X predates the Pi bridge"**: the newest Splanc release came out before
Pi bridge support was added. Try again after the next release.

**The HDMI screen shows a login prompt or stays black**:

1. Make sure the screen was plugged in when the Pi booted.
2. Press <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>F8</kbd> with a keyboard.
3. Check `splanc-bridge logs` for `HDMI framebuffer …`.
4. If the screen is plugged in after boot, or isn't detected, force a mode: add
   `video=HDMI-A-1:1920x1080@60D` to the end of the single line in `/boot/firmware/cmdline.txt`,
   then reboot.

**The OLED stays dark**: check that `ls /dev/spidev0.0` lists the device. If it doesn't, run
`sudo reboot` once; the SPI setting is in `/boot/firmware/config.txt`. Then check
`splanc-bridge logs` for `OLED HAT on spi`. If you changed the HAT's resistors to I2C, set
`OLED=i2c`.

**The OLED picture is upside down**: set `OLED_ROTATE=0`. The default is `2`.

**"Waiting for bridge" never goes away**: the bridge service isn't running. Run
`systemctl status splanc-bridge` and `splanc-bridge logs`.

**"Offline"**: the Pi has no internet access, or the relay is down. Your fixtures still work from
the app on the same Wi-Fi.

**No fixtures found**: the Pi must be on the same network as the fixtures. Guest Wi-Fi networks
often isolate devices from each other. Some mesh systems block the multicast traffic that discovery
uses. Try Ethernet, or put the Pi and the fixtures on the main network.

## What the installer changes

For the curious, or if you want to undo it by hand:

- `/opt/splanc-bridge/`: a pinned Node.js, the Splanc agent bundle (the current and the previous
  version), and a Python environment for the screens.
- Python packages: `luma.oled`, `luma.core` and `segno`, pinned by hash in
  `pi/bridge/display/requirements.lock`. Pillow, gpiozero, lgpio and spidev come from apt.
- systemd units: `splanc-bridge.service`, `splanc-display.service` and
  `splanc-bridge-update.timer`, all running as the `splanc` system user.
- `/etc/splanc-bridge/bridge.env` and `/usr/local/bin/splanc-bridge`.
- `/boot/firmware/config.txt`: `dtparam=spi=on`, plus pull-ups on the HAT's key pins
  (`gpio=6,19,5,26,13,21,20,16=pu`). The installer skips this with `--oled off`.

Developer notes (layout, tests, the bridge contract) are in
[`pi/bridge/README.md`](../pi/bridge/README.md).
