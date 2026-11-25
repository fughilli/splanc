# Splanc tracker demo

A Vive Tracker 3.0 drives a Splanc LED fixture. You place a virtual plane in a 3D
workspace, and the app streams that plane to the fixture over OSC (`/plane ,ffff`, in the
fixture's map frame F). The fixture's `plane_slice` effect then lights the LEDs where it
crosses the plane. The app also runs the tracker↔fixture calibration from
`splanc-tracker-api.md` §5: rub fit, LED-touch correspondences with `led_pick`, then
mount and record `T_TF`.

Python 3.11 with numpy and scipy, plus a three.js page (pinned CDN, the same pattern as
`tools/vive/pose_server`). The server binds to 127.0.0.1 only.

The same directory has the other tracker demos: the stylus as a flashlight
(`flashlight.py`) and a scavenger hunt (`effects/hot_spots_pose.glsl`). They moved here
from fughilli/indoor_localization (`lighthouse/demos/splanc`, `swarm/tools/vive_web`).
The tracking itself, lhd, comes from [fughilli/lighthouse](https://github.com/fughilli/lighthouse)
through the `@lighthouse` module that the ESP32-P4 player also uses.

## Quick start

Every demo reads poses from the pose server, `tools/vive/pose_server`. It runs lhd on the
Watchman dongle (or a wired tracker) and serves a 3D viewer and an SSE stream at
<http://127.0.0.1:8765>. Switch every base station on, and the slave synced, **before**
starting it: lhd solves the stations when it starts.

```sh
bazel run -c opt //tools/vive/pose_server -- --no-open
```

The demos run from this directory with python3 (Apple's `/usr/bin/python3` has Local
Network access, see [Running](#running)), or with `bazel run //tools/vive/demos:<demo>`.
Mounts, sessions and LED maps are local files here (`mounts/*.json`, `*.csv`), not in git.
Deploy each demo's effect to the fixture first (Splanc MCP `deploy_effect`, or
`splanc-agent call deploy_effect`).

| Demo           | Effect                           | Run                                                                                                                          |
| -------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Flashlight     | `effects/flashlight_pose.glsl`   | `python3 flashlight.py --stylus <serial> --fixture <lamp IP>`                                                                |
| Plane / sphere | `effects/tracker_demo_pose.glsl` | `python3 app.py --p4 --map pixielamp.csv --stylus <serial> --fixture <lamp IP>`, then **Go live** on <http://127.0.0.1:8770> |
| Scavenger hunt | `effects/hot_spots_pose.glsl`    | No driver: the spots are uniforms. Keep `app.py --p4` running (idle) so a P4 fixture gets lhd's stations                     |

Healthy pose server log lines: `locked=True type=timing`, a `type=station` line,
`calibrated (FirstStations)`, `tracking started`. No timing lock at all means no light is
reaching the tracker (stations not sweeping, or the tracker needs a power cycle).

## Files

| File                                                              | What                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `frames.py`                                                       | Quaternions, similarity transforms, `plane_to_fixture` (§2), pose mean and spread, Umeyama.                                                                                                                                            |
| `ledmap.py`                                                       | Loads the LED map CSV (§4), computes outward normals and the local-quadric signed distance surface.                                                                                                                                    |
| `calib.py`                                                        | Joint robust fit, next-LED choice, hold detector, convergence, `T_TF` and the mount JSON.                                                                                                                                              |
| `osc.py`                                                          | OSC encode/decode, `OscStreamer` (≤120 Hz cap, ≥5 Hz keep-alive), UDP, dry-run log and callback transports.                                                                                                                            |
| `poses.py`                                                        | `PoseSource` interface: `SseSource` (pose server `/events`), `ReplaySource` (POSE lines), `SyntheticSource`.                                                                                                                           |
| `synth.py`                                                        | Fake cylinder lamp, hidden truth, simulated tracker (rubs, touches, mount), `FakeFixture` (decodes OSC).                                                                                                                               |
| `app.py`                                                          | HTTP server, state machine and CLI.                                                                                                                                                                                                    |
| `static/index.html`                                               | The workspace UI.                                                                                                                                                                                                                      |
| `effects/plane_slice.glsl`, `effects/led_pick.glsl`               | The two effect sources from the API doc, to deploy with Splanc MCP.                                                                                                                                                                    |
| `effects/sphere_shell.glsl`                                       | Like `plane_slice`, for a sphere: lights LEDs within `width` of its surface. Streamed as `/sphere ,ffff` (centre xyz, radius; metres, frame F).                                                                                        |
| `effects/tracker_demo_pose.glsl`                                  | `--p4` only: the whole demo in one effect (LED pick, outline, plane or sphere in the world frame, the pose from the P4's uniform pool). `/pick` says what to show, `/shape` which shape. Deploy it once; the demo never needs another. |
| `effects/plane_slice_pose.glsl`, `effects/sphere_shell_pose.glsl` | The single-purpose `--p4` versions (world-frame shape, pool `pose`).                                                                                                                                                                   |
| `effects/hot_spots_pose.glsl`                                     | A hot-and-cold game: four coloured spots in the world; the fixture glows towards each and blinks inside one. Its spots and colours are plain uniforms (set from the app or `set_uniforms`).                                            |
| `flashlight.py`, `effects/flashlight_pose.glsl`                   | The stylus as a flashlight (below).                                                                                                                                                                                                    |
| `splanc_mcp.py`                                                   | The page's Deploy button: deploys the effect for the current mode through the Splanc MCP server, by library id once it's in the library.                                                                                               |
| `tests/`                                                          | `test_units.py` (maths, map, hold, OSC, sources), `test_calib_synth.py` (calibration against the hidden truth), `test_app_synthetic.py` (whole app over HTTP).                                                                         |

The maths (`frames`, `ledmap`, `calib`) has no server or UI code in it.

## Frames (read this before touching the maths)

| Frame | Convention                                                                                                                                                                                                                                                                                                          |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **W** | libsurvive's world, as `tools/vive/pose_server/server.py` streams it: gravity-aligned, right-handed, metres, **+Z up**. This is _not_ SteamVR's +Y up. If a source's world is +Y up, it converts with `frames.STEAMVR_TO_W` (a +90° turn about X: (x, y, z) → (x, −z, y)) before handing poses on (`--world-up y`). |
| **T** | The tracker's reporting frame, libsurvive's "head": origin at the 1/4" mount on the base, **+Z points out of the base** (in the tracker config the sensors all sit at z < 0). So the contact face's outward normal is +Z_T, and the initial contact point is `c = (0, 0, 0)`.                                       |
| **F** | The Splanc LED map frame: metres, **+Y up**.                                                                                                                                                                                                                                                                        |

- Fixture pose: `x_W = s·R·p + t` (`T_WF`, a similarity, where `s` is the map scale).
- Live: `T_WF = T_WT · T_TF`.
- Plane: `n_F = Rᵀ n_W`, `d_F = (d_W − n_W·t)/s` (`frames.plane_to_fixture`).
- The up axes only matter in two places. The initial guess for `T_WF` assumes the
  fixture stands upright (F +Y → W +Z), trying 8 yaws. From 3 touches on, a Umeyama
  start with no orientation assumption is also tried. The UI draws in W with +Z up.

## Running

```sh
cd tools/vive/demos

# 1. Fully offline: simulated tracker + simulated fixture. Nothing goes on the network
#    (OSC goes to the simulated fixture and the dry-run log, osc-dry-run.log).
python3 app.py --synthetic            # open http://127.0.0.1:8770

# 2. Live poses, dry run: reads tools/vive/pose_server (http://127.0.0.1:8765/events,
#    read-only; start it yourself). OSC is decoded and logged, not sent.
python3 app.py --map pixielamp.csv

# 3. The real fixture: OSC to <ip>:9000. Only the address you give is used; nothing is discovered.
python3 app.py --map pixielamp.csv --fixture 192.168.1.42 --mount-name lamp-top [--dry-run to also log]
```

On macOS, sending to the fixture needs Local Network access (System Settings → Privacy &
Security → Local Network). Homebrew's Python runs from its own `Python.app` bundle, which
is checked separately and may never be prompted; a send then fails with
`No route to host` (the app prints it once). Apple's `/usr/bin/python3` is covered by the
launching app's permission and runs the demo (3.9 with numpy and scipy is enough).

Other options:

- `--device T20` follows a specific tracker. The default is the first one seen, or the
  device named in the mount file.
- `--source file.txt|.gz` replays `<t> <dev> POSE x y z qw qx qy qz` lines, for example a
  `captures/vive/*.rec.gz` that contains them.
- `--exclude 0-12,240` never picks these LED indices for touches (e.g. coiled inside the
  controller housing). LEDs the tracker's flat base can't sit on (a waist between two
  bulges; `ledmap.BASE_RADIUS`, `BASE_CLEARANCE`) are left out automatically. Both are
  drawn dimmed purple.
- `--scale auto|on|off --s 1.0` sets the map scale handling.
- `--mount path.json` loads a specific mount record.
- `--max-hz` sets the OSC rate cap (≤120, default 120). `--keepalive-hz` sets the
  keep-alive rate (≥5, default 10) for the shape (`/plane` or `/sphere`). `/width`, `/halo`
  and `/glow` go out on change and once a second.
- **Shape:** the page's shape selector streams either the plane (`/plane`, deploy
  `plane_slice`) or a sphere centred on the handle (`/sphere`, deploy `sphere_shell`),
  with its radius slider. `x_F = Rᵀ(x_W − t)/s`, `r_F = r_W/s` (`frames.sphere_to_fixture`).

With `--mount-name NAME`, `mounts/NAME.json` is loaded at startup if it exists, and a
new mount record is saved there.

## Tracker button

The tracker's system button can run the whole wizard (live sources only: the pose server batch
carries a running press count per tracker). The page shows what the next press does.

| Step                | Press                                               | Double press |
| ------------------- | --------------------------------------------------- | ------------ |
| idle                | start rubbing                                       |              |
| rub                 | stop & fit; the fit then starts the touches         |              |
| touch, LED blinking | confirm the touch                                   | skip the LED |
| touch, converged    | mount mode                                          |              |
| mount               | record: hold still 1 s once the tracker is stuck on |              |

- A confirm uses the poses from 0.7 s to 0.15 s _before_ the press, so the click's own jolt
  isn't in it. It is rejected (low beep, reason on the page) if the contact point moved more
  than 2 mm or the tracker turned more than 1.5° in that window.
- The first press switches the touches to button control: a still hold no longer accepts by
  itself.
- A double press is two presses within 0.45 s, so a single press acts after that delay.
- Keep presses short: holding the system button down for a few seconds turns the tracker off.

## Calibration (the wizard follows §5)

**The fixture must not move from the first rub until the mount is recorded.**

1. **Rub** (_Start rub_). Sweep the tracker's flat base over the whole fixture surface,
   at many orientations. A few thousand samples is plenty. _Stop & fit_ runs the
   surface-only fit: robust (Cauchy) loss, with the signed distance taken to the k
   nearest LEDs' local surfaces (outward PCA normals, MST-oriented, plus a fitted
   curvature term so curved fixtures aren't biased), and multi-start over yaw. On a
   symmetric fixture this fit is rough; that is expected.
2. **Touch** (_Start touches_). The app picks the most informative LED: far from the
   ones already touched and on a different side of the fixture. It sends `/pick <index>`
   and draws that LED (and its predicted position) in the workspace.
   - Put the contact point on the LED and hold still. The app accepts the touch after
     1 s with < 1 mm position spread and < 0.5° rotation spread, then beeps and re-fits
     rubs and touches together.
   - The tracker has to move 1 cm away before the next hold counts. From the fourth
     touch on, a hold more than 3 cm from the predicted LED position is rejected (low
     beep), so a tracker set down on the table isn't taken as a touch.
   - The table shows each touch's residual and its tilt. Use _drop_ or _redo_ on
     outliers. Over 1 cm usually means a wrong `c`, a wrong scale, or the fixture moved.
   - _Skip LED_ covers LEDs you can't reach. _Accept now_ forces a touch.
   - **Vary the tilt between touches**, or `c` can't be separated from `T_WF`.
3. **Converged** when all of these hold:

   - at least 4 touches,
   - the last re-fit moved the LEDs < 0.5 mm, the rotation < 0.2° and `c` < 0.5 mm,
   - the touch RMS is < 3 mm,
   - in `auto` scale mode, the scale is being estimated. `s` is only estimated once the
     touched LEDs span at least half the map's extent along every principal axis.
     Before that, a wrong fixed scale hides in t, c and o with deceptively small
     residuals. The synthetic runs show this.

   It typically takes 6–7 touches in simulation.

4. **Mount** (_Mount mode_, then _Record now_). Attach the tracker to the fixture
   without moving the fixture, then hold still for 1 s. The app computes
   `T_TF = T_WT⁻¹ · T_WF` and saves it to `mounts/<name>.json`, then goes live.
5. **Live.** Each tracker sample gives `T_WF = T_WT · T_TF`, which is turned into
   `/plane n_F d_F`. `/width`, `/halo` and `/glow` come from the panel.

_Save session_ writes the raw rubs and touches to `sessions/` for offline debugging.

Mount record (`mounts/<name>.json`):

- `T_TF` is a 4×4 similarity with `s` folded into its 3×3 block; `s`, `R_TF`,
  `q_TF_wxyz` and `t_TF` are also stored separately.
- It also holds the device, the map summary (with a sha256 prefix of the CSV, and a
  warning if a different map is loaded later), the fit (`c_T`, `o`, `T_WF`, residuals)
  and the touches.

## OSC (§3)

- `/plane ,ffff`, `/width ,f`, `/halo ,f`, `/glow ,fff` in live mode.
- `/pick ,f <CSV index>` in the calibration modes. Only that mode's addresses are
  streamed.
- The latest value wins, capped at ≤120 Hz, and every value is re-sent at the
  keep-alive rate.
- Several messages due at once go out as one `#bundle`.
- Dry-run lines look like `<time> /plane 0.12 0.98 0.05 0.061`.

## `--p4`: a Splanc P4 player with its own tracker

The fixture tracks itself (its tracker wired to the P4) and the stylus calibrates it:

- lhd's base stations go to the P4 as `/lh/station` every second, so it tracks in lhd's
  world. After moving the base stations, recalibrate lhd from a clean start (move
  `~/.config/lighthouse/calibration.json` aside and restart the viewer: `/recalibrate`
  reuses the scenes it holds, old ones included), then set the stylus down still in
  several places both stations see.
- The P4's tracker (`/lh/pose` back from it) is the fixture tracker while probing, so the
  fit is the mount itself (P4 tracker <- map); it goes to the P4 as `/lh/mount`, which
  saves it. The fixture may move between touches.
- Run `effects/tracker_demo_pose.glsl` on the fixture throughout. The demo streams
  `/pick` (an LED index to blink, -1 the live shape, -2 a faint outline; once a second,
  since the effect keeps the last value) and, live, `/shape` (0 plane, 1 sphere) with
  `/plane` or `/sphere` in the world frame. The lamp shows the outline whenever the P4
  isn't tracking.
- The P4 predicts the pose to when each frame will light, and logs photon-to-photon
  latency per stage on its console every 5 s (Splanc `docs/design/p4-c6-split.md`
  §4.2.1). To compare, send it OSC on udp/9000:
  - `/lh/predict ,f 0` (or 1) turns prediction off (or on);
  - `/lh/lead ,f <ms>` predicts further ahead;
  - `/lh/stream ,f 0` (or 1) sends sweeps whole (or streams them).

## Scavenger hunt

`effects/hot_spots_pose.glsl` puts four coloured spots in lhd's world (`spot0`..`spot3`,
metres, +Z up; `color0`..`color3`). The fixture glows in a spot's colour within `range`
(0.4 m), brighter as it gets closer, and blinks in that colour when its centre is within
`radius` (5 cm). Move spots with `set_uniforms`, for example
`{"values": {"spot0": [-0.15, -0.15, 1.2]}}`. lhd's world origin isn't the floor, so the
quickest way to place a spot is to hold the fixture there and read its position (the
demo's `/state`, `T_WF`). There is no page for the spots yet.

## Flashlight: the stylus lights the fixtures

`flashlight.py` turns the stylus into a flashlight. A cone of light from its tip, along its
axis, lights the LEDs of every fixture inside it, on `effects/flashlight_pose.glsl`.

```sh
/usr/bin/python3 flashlight.py --stylus LHR-10F97524 --fixture <lamp IP> [--fixture <another> ...]
```

- **Tip and axis**: from the stylus pivot calibration the main demo saves
  (`mounts/stylus-<serial>.json`). Run the demo's Pivot step once per stylus.
- **The stylus button** cycles five modes:

  - **colour**: rolling the stylus about its own axis turns the hue, one turn round the
    wheel;
  - **saturation**: rolling goes from white (0) to full colour (1, the default), one
    turn for the whole range;
  - **width**: rolling widens or narrows the beam, ×3 per turn, 2° to 60° half-angle;
  - **persistence**: rolling sets how long the beam's trail lasts. Each LED keeps the
    brighter of the beam and its own fading glow (time constant ×3 per turn, up to
    20 s). At the short end (0.05 s) the trail is off, the default;
  - **fixed**: rolling does nothing.

  Only the roll counts. Pointing the stylus around changes nothing but where the beam
  goes.

- **Fixtures in one world**: the beam is in lhd's world. A P4 player tracks itself, so it
  must have adopted lhd's stations (run the demo without `--no-p4-stations`). Any other
  fixture needs its room pose set in lhd's world (`set_fixture_pose`); the effect lights
  it by `led.room`.
- **OSC**: `/origin`, `/dir` (world, metres), `/width` (the half-angle, rad), `/color`,
  `/decay` (the trail's time constant, s; 0 = none), and the stylus gate below:
  `/stylus_ok`, `/stylus_seq`, `/stale_after`.
- **No live stylus, no beam.** The stylus's validity is its own signal, separate from a
  fixture's `tracker_ok` (that one only says the _fixture_ knows where it is).
  `/stylus_ok` is 1 while the newest stylus pose is younger than `--stale` (default
  **0.5 s**) and 0 otherwise. `/stylus_seq` is a heartbeat that changes with every
  pose; the effect drops the beam by itself when it hasn't changed for `/stale_after`
  (sent as the same `--stale`), so a dead driver, network or viewer drops it too.
  - Without a live stylus (at startup before the first pose, or after the stale
    threshold) the fixtures show the **inactive state**: no beam, a dim, slow blue
    breathing on every LED (`idle_color`, `idle_level`; `idle_level` 0 makes it dark).
    It never shows the effect's default downward beam.
  - The console says what's wrong and what to check: `NO STYLUS` (no pose yet) or
    `STYLUS LOST` (last pose N s ago), with the reason it can see: the pose server
    source down, the viewer reporting the stylus's tracking lost, poses arriving only
    from other trackers (a wrong `--stylus`?), or no poses at all. State changes get
    their own line; `LIVE ...` is the healthy status.
  - When poses resume the beam comes back by itself; nothing needs redeploying. The
    roll baseline restarts, so a gap never counts as a roll.
  - There is no stationary-beam mode: a beam on the fixtures always means fresh
    stylus poses.
  - Tests: `tests/test_flashlight.py` (the driver: startup, loss, recovery, other
    trackers only) and `tests/flashlight_effect_check.mjs` (the effect on Splanc's own
    VM; give it the `@splanc/agent` package directory, which carries the compiler and
    the simulator, or it prints SKIP).

## What the user (or a Splanc-connected agent) has to do

This session had no Splanc MCP tools, so none of these have been run.

1. **Find the fixture.** Run `list_players` to get the fixture's name, IP and firmware
   (expected: 1.12.7). The fixture needs a DHCP lease on the same 2.4 GHz LAN as this
   machine. A `169.254.x.x` address ignores OSC.
2. **Export the map.** Run `export_map {format: "csv"}` for that fixture, save the file
   (e.g. `pixielamp.csv`) and pass it with `--map`. Don't commit it.
3. **Deploy `led_pick` once.** Optionally run `compile_effect` on the source first.

   ```text
   deploy_effect {source: <effects/led_pick.glsl>, activate: true, players: [<fixture>],
                  name: "Tracker calibration: LED pick",
                  description: "Blinks the LED at index `pick` (OSC /pick ,f), dims the rest. For tracker↔fixture calibration.",
                  tags: ["tracker", "calibration", "osc"]}
   ```

   Note the returned `library_id`. Run `measure_effect` to confirm it fits. Use
   `force: true` only if the estimator refuses and `measure_effect` shows it really fits.

4. **Deploy `plane_slice` the same way.**

   ```text
   deploy_effect {source: <effects/plane_slice.glsl>, activate: true, players: [<fixture>],
                  name: "Tracker plane slice",
                  description: "Lights LEDs within `width` of a plane streamed over OSC /plane ,ffff (unit normal + offset, metres, map frame).",
                  tags: ["tracker", "plane", "osc"]}
   ```

5. **Switch effects** between calibration and live by deploying again by id:
   `deploy_effect {library_id: <id>, activate: true, players: [<fixture>]}`. Don't paste
   the source again; that fills the library with copies.
   - **Never use `crossfade_to` on 1.12.7.** OSC only drives deck A, and a crossfade
     leaves the effect on deck B, where it stops responding. If one happened, a plain
     `deploy_effect` restores deck A; `list_decks` shows which deck is visible.
6. **Rules from the doc:**
   - Keep the library private; don't copy library entries into this repo.
   - Don't `update_effect` / `delete_effect` entries you didn't create.
   - Don't `commit: true` uniforms while streaming.
   - Don't use `update_firmware`, `set_device_name`, `trust_player` or `forget_player`
     without asking.
7. **Run the app** with `--fixture <ip>` and do the physical calibration above.
   Use `led_pick` while rubbing and touching, then `plane_slice` before _Go live_.

## Tests

```sh
bazel test //tools/vive/...           # all of the below, the pose server's test, and the flashlight effect on the real VM
```

Or one at a time from this directory:

```sh
python3 tests/test_units.py          # ~1 s: frames/plane maths, map surface, hold, OSC (rate cap, keep-alive, UDP loopback), sources
python3 tests/test_calib_synth.py -v # ~45 s: calibration vs hidden truth (T_WF, c, o, s), 3 seeds, lift-offs, a wrong touch
python3 tests/test_app_synthetic.py  # ~45 s: the whole app over HTTP in --synthetic mode, through mount and live
python3 tests/test_buttons.py        # ~10 s: the tracker-button wizard on simulated time, rub through mount
python3 tests/test_flashlight.py     # <1 s: the beam follows the tip, button modes, roll-only adjustment
python3 tests/test_deploy.py         # ~2 s: the Deploy button against a fake Splanc MCP server
```

The synthetic fixture is a 300-LED helix on a 0.12 m × Ø0.08 m cylinder. The map has
0.3 mm noise, and 20 rows are `mapped=0` with 5× the noise. The hidden truth has a
diffuser offset of `o = 3 mm`, a 3 % map scale error, an off-centre contact point, and
yaw and tilt.

The simulated tracker adds 0.2 mm / 0.03° noise and 6 % lift-off outliers (20 % in the
robustness test). Typical recovery:

- LEDs placed to ≤ 1 mm in W (rotation ≤ 0.2°),
- `c` to ≤ 1.2 mm,
- `o` to ≤ 1.2 mm,
- `s` to ≤ 1 %,
  in 6–7 touches.

`s` comes out about 0.3–0.5 % low on average. This is a selection effect, not a model
error: the next-LED choice prefers extreme LEDs, and map noise pushes those outward.
With a noise-free map the bias disappears (−0.04 %).
