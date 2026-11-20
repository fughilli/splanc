# Build a Vive-tracked lamp (the flashlight demo)

This guide shows how to build a Splanc lamp that knows where it is in the room, and how to use a
second tracker as a flashlight that lights the lamp's LEDs wherever its beam hits them. It's the
setup from the demo videos. The lamp has a Vive tracker wired into it and tracks itself. A
handheld tracker (the stylus) is tracked by a computer, which streams the beam to the lamp over
OSC.

```text
 base station(s) ──light──► lamp tracker ──USB──► ESP32-P4 player ──► LEDs
        │                                              ▲
        └──light──► stylus ──radio──► dongle ──USB──► computer: lhd ─► flashlight.py ─OSC─┘
```

The host side lives in two public repositories:

- [fughilli/lighthouse](https://github.com/fughilli/lighthouse): `lhd`, the Lighthouse tracking
  daemon. The P4 runs the same tracking kernel.
- [fughilli/indoor_localization](https://github.com/fughilli/indoor_localization): the pose
  server (`swarm/tools/vive_web`) and the demos (`lighthouse/demos/splanc`). The demos' own
  [README](https://github.com/fughilli/indoor_localization/blob/master/lighthouse/demos/splanc/README.md)
  is the full reference. This guide is the shortest path through it.

## What you need

- **An ESP32-P4 player**: an ESP32-P4 board with an ESP32-C6 on SDIO for Wi-Fi, such as the
  Waveshare ESP32-P4-WIFI6, driving your LEDs. See [the P4 design](../design/p4-c6-split.md).
- **Two Vive Tracker 3.0s**:
  - one fixed to the lamp and wired to the P4's high-speed USB OTG port;
  - one as the **stylus**, with a pointed tip attached, paired to its Watchman USB dongle.
- **Lighthouse 1.0 base stations**. One works. Two give steadier tracking: set them to channels
  **B and C** (C syncs optically to B, so they must see each other), or to A and B with a sync
  cable.
- **A computer** (macOS or Linux) on the same LAN as the lamp, with the dongle plugged in. It
  needs Bazel (Bazelisk) and Python 3.9 or later with numpy and scipy.
- Something for the stylus tip to pivot in while it's calibrated: a small dimple in a block of
  wood or plastic is enough.

## 1. Flash the lamp with the tracker built in

The tracker module is off by default. Build the P4 player with `--//firmware/p4:tracker` and
flash it over USB:

```sh
bazel run -c opt --//firmware/p4:tracker //firmware/player_app:flash_esp32p4_player_c6 -- --port <serial port>
```

If you leave the flag out, you get a working lamp with no tracker, and nothing warns you. Then
set the lamp up like any other player: provision Wi-Fi from the Splanc app and map its LEDs.
Afterwards the player's uniform pool carries `tracker_pos`, `tracker_quat` and `tracker_ok`.

Opening the P4's USB serial port resets the board on some boards. Keep one serial logger open
instead of reopening the port.

## 2. Run the tracking daemon

```sh
git clone https://github.com/fughilli/indoor_localization && cd indoor_localization
bazel build -c opt @lighthouse//daemon:lhd
python3 swarm/tools/vive_web/server.py --source lhd --no-open     # http://127.0.0.1:8765
```

- **Turn on every base station before starting the server.** lhd solves the stations from
  scratch at start and locks onto the ones it sees then. After you add a station or change a
  channel, restart the server instead of waiting for lhd to notice.
- The server finds lhd in `bazel-bin`. If you skip the build, it fails with
  `TypeError: expected str ... not NoneType`.
- Healthy log lines in the page or in `/events`: `locked=True type=timing`, a `type=station`
  line, `calibrated (FirstStations)`, then `<serial> tracking started`.
- If the dongle doesn't show up as a USB device, try another cable. Charge-only USB-C cables are
  a common cause.

## 3. Calibrate once: the stylus tip and the lamp's mount

The flashlight needs to know where the stylus tip is. It also needs the lamp's tracker-to-LED
transform (the **mount**). You do both once, with the main demo. Find the lamp's address and the
stylus's serial (`LHR-…`, it's in the pose server's log), then:

```sh
cd lighthouse/demos/splanc
# The lamp's LED map: export it from Splanc (the agent's export_map, format csv).
python3 app.py --p4 --stylus <stylus serial> --map <lamp map>.csv --fixture <lamp IP>   # http://127.0.0.1:8770
```

Deploy `effects/tracker_demo_pose.glsl` to the lamp first. The page's Deploy button does it, or
see step 4. Then on the page:

1. **Pivot** (once per stylus, saved in `mounts/stylus-<serial>.json`). Put the tip in the
   pivot dimple, rock the stylus around it, then press _Pivot done_.
2. **Probe LEDs.** The lamp blinks one LED at a time. Touch each one with the tip and hold
   still. The stylus button works too. The fit becomes the lamp's mount, and the P4 saves it,
   so the lamp keeps it across reboots.

While this runs, the demo sends lhd's base stations to the P4 (`/lh/station`), so both share one
world. The flashlight driver keeps doing this.

With the lamp calibrated, the same page runs the other demos from the videos: a plane or a
sphere that slices through the lamp (`--p4` live mode), and `effects/hot_spots_pose.glsl`.

## 4. Run the flashlight

Deploy the effect to the lamp. One way, with the published agent CLI:

```sh
npx -y https://splanc.io/agent/splanc-agent.tgz call deploy_effect \
  "$(python3 -c 'import json,sys; print(json.dumps({"source": open(sys.argv[1]).read(), "activate": True, "players": sys.argv[2]}))' \
     effects/flashlight_pose.glsl '<lamp name>')" --host <lamp IP>
```

From an agent connected to Splanc, deploy `effects/flashlight_pose.glsl` the same way
(`deploy_effect` with the source and `activate: true`). After the first time, deploy it again
by its library id. Pasting the source again adds a copy to the library each time.

With no live stylus, the lamp shows a dim, slow blue breathing. Start the driver:

```sh
python3 flashlight.py --stylus <stylus serial> --fixture <lamp IP>    # repeat --fixture for more lamps
```

It reconnects to the pose server by itself, so the start order doesn't matter. `LIVE mode color
width 12.0 deg …` is the healthy status line. Point the stylus at the lamp.

- **The stylus button** cycles through five modes: colour, saturation, beam width, trail
  persistence and fixed. Rolling the stylus about its own axis adjusts the current mode. Pointing
  only moves the beam.
- **No live stylus, no beam.** If no pose arrives for 0.5 s, the beam goes off and the lamp
  goes back to the blue breathing. It comes back by itself when poses resume.
- Other fixtures can join the beam if their room pose is set in lhd's world
  (`set_fixture_pose`). The effect lights them by `led.room`.

## Troubleshooting

| Symptom                                            | Check                                                                                                                                                                                                   |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NO STYLUS` / `STYLUS LOST` in the driver          | The driver says why. The pose server may be down, the stylus may have lost sight of the stations, the `--stylus` serial may be wrong, or no poses are arriving at all.                                  |
| `tracking lost (Drifted)` again and again          | The stylus is turning its sensors away from a single station. Add a second station, or keep the stylus facing the one you have.                                                                         |
| No `locked=True type=timing` for minutes           | No station light is reaching the trackers. A channel-C station blinks until it has synced to B. Check that the stylus points at the stations, not face-down on the table.                               |
| The beam lands in the wrong place on the lamp      | The stations changed since the lamp's mount was probed. Re-run step 3's _Probe LEDs_. Don't hand-edit lhd's calibration file.                                                                           |
| macOS: `No route to host` when sending to the lamp | Python needs Local Network access (System Settings → Privacy & Security → Local Network). Homebrew's Python may never be prompted; Apple's `/usr/bin/python3` is covered by your terminal's permission. |
| The lamp has no `tracker_*` uniforms               | It was flashed without `--//firmware/p4:tracker` (step 1).                                                                                                                                              |
| You can't find the lamp after moving networks      | Its address changed. Look it up again (`list_players`, or mDNS `_splanc._tcp`).                                                                                                                         |
