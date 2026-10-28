# Set up a Splanc bridge on a Raspberry Pi

A **Splanc bridge** is a small always-on computer on your home network that connects your
Splanc fixtures to the Splanc cloud relay. With it, the app (or an AI agent in the cloud) can
reach your lights from anywhere, not only from the same Wi-Fi. A Raspberry Pi makes a good bridge.
It runs with no keyboard or mouse, and it shows its pairing code and status on two screens:

- a TV or monitor plugged into its HDMI port;
- a small OLED add-on board (optional).

Setting one up takes about 10 minutes and **no terminal**: the **Splanc Bridge Flasher** app
downloads the Splanc bridge system, asks for your Wi-Fi, and writes it all to a microSD card. You
put the card in the Pi, power it on, and read the pairing code off its screen.

![The HDMI status page while the bridge waits to be paired](img/pi-bridge/hdmi-pairing.png)

## What you need

| Item                       | Notes                                                                                                                                                                                                                                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Raspberry Pi               | **Pi 5** or **Pi 4** (or Pi 400) recommended. A Pi 3 (B, B+, A+) or Pi Zero 2 W works too.                                                                                                                                                                                                                    |
| Power supply               | The official supply for your model (USB-C 5 V 3 A for a Pi 4; 5 V 5 A for a Pi 5).                                                                                                                                                                                                                            |
| microSD card               | 4 GB or larger. Everything on it is erased.                                                                                                                                                                                                                                                                   |
| Network                    | Wi-Fi or Ethernet, on the **same network as your fixtures**. A Pi 3 or Zero 2 W only sees 2.4 GHz Wi-Fi.                                                                                                                                                                                                      |
| HDMI screen (optional)     | Any TV or monitor. A Pi 4/5 needs a micro-HDMI cable; a Zero 2 W needs mini-HDMI.                                                                                                                                                                                                                             |
| OLED HAT (optional)        | **Waveshare 1.3inch OLED HAT** (128×64, SH1106, with a 5-way joystick and three keys; e.g. Amazon B07VCYTPRK). It plugs onto the Pi's 40-pin header, so it needs no wiring or soldering. A Zero 2 W needs a version with the header already soldered on ("WH"). Leave the HAT's factory SPI setting as it is. |
| A computer with an SD slot | A Mac, Windows PC or Linux PC (a USB card reader is fine), to run the Splanc Bridge Flasher.                                                                                                                                                                                                                  |

You need at least one of the two screens to read the pairing code from the Pi.

## 1. Get the Splanc Bridge Flasher

Download it from the newest **Splanc bridge** release on
[the releases page](https://github.com/fughilli/splanc/releases) (the releases named "Splanc
bridge …", tagged `pi-bridge-v…`):

| Your computer               | File                                                    |
| --------------------------- | ------------------------------------------------------- |
| Mac with Apple silicon (M…) | `Splanc-Bridge-Flasher-<version>-mac-arm64.dmg`         |
| Mac with an Intel processor | `Splanc-Bridge-Flasher-<version>-mac-x64.dmg`           |
| Windows                     | `Splanc-Bridge-Flasher-<version>-win-x64.exe`           |
| Linux                       | `Splanc-Bridge-Flasher-<version>-linux-x86_64.AppImage` |

The app isn't code-signed yet, so the first time you open it your computer asks you to confirm:

- **macOS:** open the `.dmg` and drag **Splanc Bridge Flasher** into **Applications**. Open it;
  macOS says it "cannot be opened" or "could not verify" it. Click **Done** (or **OK**), open
  **System Settings ▸ Privacy & Security**, scroll down to the message about Splanc Bridge
  Flasher and click **Open Anyway**, then **Open**. You only do this once.
- **Windows:** run the `.exe`. If **Windows protected your PC** appears, click **More info**, then
  **Run anyway**. It installs for your user and opens.
- **Linux:** in your file manager, right-click the `.AppImage` ▸ **Properties** ▸ **Permissions**,
  tick **Allow executing file as program**, then double-click it.

## 2. Write the card

Put the microSD card in your computer and open the flasher.

1. **Pi**: choose your Raspberry Pi model. The flasher always offers the newest Splanc bridge
   release.

   ![Choosing the Pi model](img/pi-bridge/flasher-board.png)

2. **WiFi**: type your Wi-Fi name and password, and check the **WiFi country** (it sets which
   channels the Pi may use). Tick **Hidden network** if your network doesn't broadcast its name,
   or **No WiFi** if you'll plug in an Ethernet cable. You can also give the Pi a name; it then
   shows up on your network as `<name>.local` (the default is `splanc-bridge.local`).

   ![Wi-Fi and name](img/pi-bridge/flasher-wifi.png)

   The Wi-Fi details go only onto the card. On its first boot the Pi moves the password into its
   own protected storage and deletes it from the card.

3. **SD card**: pick your card. Only removable disks are listed, never your computer's own
   drive, and the flasher asks again if a disk looks too big to be an SD card. Click
   **Erase and write**, confirm, and enter your computer's password when it asks (writing a card
   needs it).

   ![Choosing the card](img/pi-bridge/flasher-card.png)

4. The flasher downloads the image (about 450 MB, checked against its published checksum),
   writes the card, **reads it back to check every byte**, and saves your Wi-Fi settings onto it.
   This takes a few minutes. Keep the card in until it says it's ready.

   ![Writing](img/pi-bridge/flasher-write.png)

   ![Done](img/pi-bridge/flasher-done.png)

On Windows, a message may offer to format a drive on the card: choose **Cancel**. That drive is
the Pi's system partition, which Windows can't read.

## 3. Boot the Pi

With the Pi unplugged, fit the OLED HAT onto its header if you have one, and plug in the HDMI
screen if you use one. Insert the card and connect power. In about a minute the screens show
**Ready to pair** with a code like `ABCD-EFGH`. (The first boot takes a little longer: the Pi
grows its file system to fill the card.)

The bridge starts by itself every time the Pi powers on. It finds your fixtures on the network by
itself.

## 4. Pair

To use the bridge from a cloud AI agent (Claude, ChatGPT, …), follow
[Use Splanc from a cloud agent](guides/cloud-agent.md): you give the agent the relay address and,
when it asks you to sign in, type the code from the Pi's screen.

The code expires after a few minutes. Press **KEY1** on the HAT for a fresh one.

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
| Error              | The bridge reported a problem; the message is on screen.                                                |

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

## Updates

- **The Splanc software updates itself.** About two minutes after it boots and then once a day,
  the Pi checks splanc.io for a new Splanc release. If there is one, it downloads it, checks its
  checksum, switches to it and restarts the bridge. Your pairings are kept. The previous version
  stays on the card too.
- **The Pi's operating system** is updated by writing the card again with the flasher when a new
  Splanc bridge release comes out. Writing the card starts fresh, so you pair your agents again
  afterwards. (An in-place system update is planned.)

## Changing settings later

Put the card in your computer: its boot partition (it may be called `FIRMWARE` or `bootfs`) has a
file **`splanc-bridge.conf`** you can edit with any text editor. The Pi reads it every time it
boots.

| Setting                    | What it does                                                          |
| -------------------------- | --------------------------------------------------------------------- |
| `HOSTNAME=splanc-bridge`   | The Pi's name on your network (`<name>.local`).                       |
| `WIFI_COUNTRY=US`          | Two-letter country code for Wi-Fi channels.                           |
| `SPLANC_RELAY=`            | The relay to use (empty: Splanc's).                                   |
| `OLED=auto`                | The OLED HAT: `auto`, `spi`, `i2c` or `off`.                          |
| `OLED_ROTATE=2`            | `0`–`3`, in steps of 90°. Use `0` if the OLED picture is upside down. |
| `SPLANC_DISPLAY_HDMI=auto` | The HDMI status page: `auto` or `off`.                                |
| `SPLANC_AUTO_UPDATE=1`     | `0` turns the daily Splanc updates off.                               |

To join a different Wi-Fi network, write the card again with the flasher (and pair again).

## Troubleshooting

**The card doesn't appear in the flasher**: make sure it's inserted all the way and shows up on
your computer. Card readers built into some laptops count as internal on macOS; use a USB card
reader instead.

**macOS: "macOS blocked raw disk access"**: open **System Settings ▸ Privacy & Security ▸ Full
Disk Access**, turn on **Splanc Bridge Flasher** (add it with **+** from Applications if it isn't
listed), quit and reopen the flasher, and write again.

**"What was read back from the card differs from the image"**: the card or the card reader is
faulty, or the card is a counterfeit that reports more space than it has. Try another card.

**The download fails or is "damaged"**: check your internet connection and try again. The
flasher refuses any image whose checksum doesn't match the published one.

**The Pi never shows up on the network / stays "Offline"**: check the Wi-Fi name and password
(they are case-sensitive) and the country, and that a Pi 3 or Zero 2 W is near a 2.4 GHz network.
Write the card again with the right details. Ethernet always works without settings.

**The HDMI screen stays black or shows a login prompt**: make sure the screen was plugged in when
the Pi booted (or reboot it with the screen connected).

**The OLED stays dark or the picture is upside down**: check the HAT is seated on all 40 pins;
for an upside-down picture set `OLED_ROTATE=0` in `splanc-bridge.conf`. If you changed the HAT's
resistors to I2C, set `OLED=i2c`.

**The screen says "has no bridge yet. Checking for an update…"**: the card has a Splanc release
from before the cloud bridge existed. Leave the Pi connected to the internet: it updates itself
within a few minutes, then shows a pairing code.

**No fixtures found**: the Pi must be on the same network as the fixtures. Guest Wi-Fi networks
often isolate devices from each other, and some mesh systems block the multicast traffic that
discovery uses. Try Ethernet, or put the Pi and the fixtures on the main network.

## For power users

### SSH

The bridge image has no password login at all. To log in, paste your SSH public key into the
flasher's **Advanced ▸ SSH public key** box (or put it in `authorized_keys` on the card's boot
partition). Then `ssh root@splanc-bridge.local` works, and `splanc-bridge status`, `new-code`,
`identify`, `revoke-all`, `logs`, `update`, `restart` and `version` are available.

### Install on Raspberry Pi OS instead

If you'd rather keep a Raspberry Pi OS install you manage yourself, the same bridge and screens
install with one command. Flash **Raspberry Pi OS Lite (64-bit)** with Raspberry Pi Imager
(**Edit Settings**: hostname `splanc-bridge`, your user and Wi-Fi, and **Enable SSH**), boot it,
then from your computer:

```sh
ssh yourname@splanc-bridge.local
curl -fsSL https://splanc.io/bridge/install.sh | sudo sh
```

The installer installs a pinned Node.js and the Splanc bridge (checking each download against its
published checksum) and the screen service, switches on the OLED HAT's SPI interface and starts
everything. Options go after `sh -s --`:

| Option                       | Effect                                                                                       |
| ---------------------------- | -------------------------------------------------------------------------------------------- |
| `--oled auto\|spi\|i2c\|off` | OLED HAT mode. `auto` is the default: it finds the HAT by itself. `off` skips the SPI setup. |
| `--relay URL`                | Use a different relay. By default, the bridge uses its built-in relay.                       |
| `--no-start`                 | Install without starting the services.                                                       |

Manage it over SSH:

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

Updates are automatic (daily, sha256-checked; `SPLANC_AUTO_UPDATE=0` turns them off). Settings
are in `/etc/splanc-bridge/bridge.env` (the same keys as `splanc-bridge.conf` above) and your
pairing data in `/var/lib/splanc-bridge`. The installer writes:

- `/opt/splanc-bridge/`: a pinned Node.js, the Splanc agent bundle (the current and the previous
  version), and a Python environment for the screens (`luma.oled`, `luma.core` and `segno`,
  pinned by hash in `pi/bridge/display/requirements.lock`; Pillow, gpiozero, lgpio and spidev
  from apt);
- systemd units `splanc-bridge.service`, `splanc-display.service` and
  `splanc-bridge-update.timer`, running as the `splanc` system user;
- `/etc/splanc-bridge/bridge.env` and `/usr/local/bin/splanc-bridge`;
- `/boot/firmware/config.txt`: `dtparam=spi=on`, plus pull-ups on the HAT's key pins
  (`gpio=6,19,5,26,13,21,20,16=pu`), skipped with `--oled off`.

The HDMI page takes over console 8: with a keyboard, <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>F1</kbd>
gets a login prompt and <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>F8</kbd> returns to the page. If a
screen plugged in after boot isn't detected, add `video=HDMI-A-1:1920x1080@60D` to the end of the
line in `/boot/firmware/cmdline.txt`.

Developer notes (the image, the flasher, the bridge contract, tests) are in
[`pi/bridge/README.md`](../pi/bridge/README.md).
