---
name: splanc
description: Drive Splanc LED players (mapped, 3-D LED fixtures — one or a whole house of them) through the splanc-agent hub — set moods with uniforms, write and deploy FX-engine effects, preview them on the real maps, keep them within each device's frame budget, and treat several fixtures as one room. Use when the user asks to change, create or tune what their Splanc lights are doing.
---

# Driving Splanc players

A Splanc player is an ESP32-C6 (or Pi) running LEDs whose **3-D positions are
known**: a camera mapping pass measured every LED, in meters, and the player stores
that map plus a topology (segments, branch points). Every show is an **FX-engine
effect**: a small shader-like program the player runs once per LED per frame. The
`splanc-agent` hub is your connection to EVERY player on the LAN: it finds them
(mDNS, players remembered from earlier runs, a LAN sweep), opens one connection
per player on first use, and fans each tool out to the players you pick.

## Authoring rule: rate knobs are integrated, never multiplied by `time`

`fract(led.s - time * speed)` looks fine in a preview, but moving the `speed`
slider rescales all the elapsed time, so the effect jumps (by Δspeed × time:
whole cycles after a few minutes of uptime). Keep a `state` phase per rate and
advance it in `update()`: `ph = fract(ph + dt * speed);`, then use `ph` in
`shade()`. Details and the oscillator / scroll / fixed-point forms:
`effect-language.md` § Rate controls. `compile_effect` warns when it sees the
pattern; fix the warning like an error. Plain `time` (`fract(led.s - time)`,
`sin(time * 0.7)`) is fine when no knob scales it.

## Which players

Every device tool takes `players`: a player name, its id (MAC), a room name,
`"all"`, or a list. Without it, a tool targets the only player — or all of them
when they form one room — and asks you to choose when there are several rooms.
With several targets the result is one entry per player (`ok`, `result` or
`error`); a failure on one never hides the others' results, so report it.

## First, look

1. `list_players` (or the `splanc://players` resource): names, rooms, firmware.
   It is fast and trusts what the hub remembers (`checked` says how each player
   was confirmed); `refresh_players` looks again thoroughly. No players → ask the
   user for the player's address and `add_player`. Players are tracked by device
   id: one that rebooted onto a new IP is found again by itself (it shows
   `checked: "unreachable"` with the reason until then), so there's no need to
   `add_player` it again. A player with
   `tls: CHANGED…` is refused: its certificate differs from the one first seen
   for it. Tell the user; call `trust_player` only if they confirm they
   factory-reset that player (otherwise another device may be answering as it).
2. Several players and no rooms, and the user speaks of rooms ("the living
   room", "the shelf")? Ask which fixture is where — `identify_player` blinks one
   so they can tell — then `set_room {room, players}`, and `set_fixture_pose` to
   place each fixture in the room (metres, +Y up; ask, don't guess). Rooms and
   poses persist in the hub.
3. Read `splanc://fixture/summary` (one player) or `splanc://room/<room>` (every
   fixture in the room's shared frame: per-fixture and combined bounding boxes).
   Read `splanc://player/<id>/fixture/map` / `topology` only when an effect needs
   the actual geometry (see `geometry.md`). If the user wants the map in other
   show software, `export_map {format: "csv"|"lxf"}` returns a TouchDesigner
   CSV or a Chromatik `.lxf` (filename + content) to save for them.
   To SEE a fixture (or a whole room with its poses), `plot_fixture` returns one
   PNG with front / side / top / isometric views (+Y up, LED index hints, mapped
   dots vs interpolated rings) plus the numbers. Use it to check a map, or poses
   after `set_fixture_pose`, before writing geometry-dependent effects.
4. Read `splanc://effect/active` (or call `list_uniforms`): which effect is
   running and what its knobs are.

## Changing the mood — prefer uniforms

Most requests ("warmer", "calmer", "more rain") are a **uniform change on the
effect already running**, not a new effect. Uniforms are addressed by NAME; the
bridge checks width and range and tells you the declared names if you miss.

- `set_uniforms {values: {tint: [1, 0.5, 0.2]}}` — instant.
- `ramp_uniforms {targets: {rain: 0.8}, seconds: 20}` — a smooth glide; the bridge
  streams the steps and commits the end value once. Use this for anything a person
  will watch change. With several players they all glide together.
- `commit: true` persists values across reboots — only when the user wants the
  change to stick (flash wear).
- `set_brightness {level}` is global output brightness (runtime-only).

## Saved looks: keypoints

A **keypoint** is a named set of uniform values for one effect: a look the user
(or you) liked, stored ON the player, so the Splanc app's Show Mode and every
agent see the same ones. The player itself moves between them in parameter space:
numbers glide, colours blend (`color_mode: "hsv"` keeps them saturated — red to
blue passes through magenta, not grey), and toggles/dropdowns snap to the
heaviest look.

- **"Save the look as a keypoint"** → `save_keypoint {name: "dusk"}` stores the
  CURRENT values. Pass `values` to store a look without showing it first. A name
  that already exists is overwritten, so `list_keypoints` first and ask before
  replacing one you didn't make. Max 16 per effect, names up to 32 bytes.
- **"Go back to dusk"** → `recall_keypoint {name: "dusk", seconds: 10}`. Prefer
  a morph (`seconds` > 0) for anything a person watches; 0 jumps.
- **"Morph between moods"** / "somewhere between calm and storm" →
  `blend_keypoints {weights: {calm: 0.7, storm: 0.3}, seconds: 15}`: a position
  between known-good looks — safer than inventing new values, because every
  input is a look someone approved. Weights are normalised; up to 4 keypoints.
- Start a mood request by reading `splanc://effect/active` (it lists the
  effect's `keypoints`): if a saved look matches the ask, recall or blend it
  instead of hand-setting uniforms.
- Blends and recalls are live-only; `commit: true` makes the result survive a
  reboot. A blend never creates a keypoint — save explicitly when the user likes
  the result.
- `stale: true` marks a look saved against an older build of the effect; it
  still recalls by uniform name (renamed or removed uniforms are skipped).
- `delete_keypoint` only when the user asks; keypoints are theirs.
- Older firmware without the `keypoints` feature answers with a clear error: fall
  back to `ramp_uniforms`.

## A new scene or mood: the effects library first

The installation keeps a library of effects that worked before (what each looks
like, tags, its uniforms), and it grows with every deploy. Before writing an
effect:

- `search_effects {query: "slow warm cosy fireplace"}` — keywords for the look,
  mood, colours and motion (add synonyms); no query lists everything, most used
  first. Rows are compact; `get_effect {id}` reads one in full (source, uniforms,
  measured frame cost).
- **One fits** → `deploy_effect {library_id}`, then tune it with uniforms.
- **One is close** → `duplicate_effect {id, name}`, adapt the source (preview it),
  deploy it, and `update_effect {id: <copy>, source, description, tags}`. Reading
  entries is also how to reuse a technique, a palette or a motion that worked.
- **Nothing fits** → write a new one (below), and give the deploy (or a
  `save_effect`) a rich `description` — what it looks like, the mood, when to use
  it — and `tags`: that is what the next search matches. Deploys without one are
  kept with `needs_description`; fill those in with `update_effect`.
- `delete_effect` only when the user asks; the library is theirs.

## Motion sensor (players with an IMU; feature `sensors`)

- `read_sensors` says whether the player has a motion sensor (`status`:
  `running` / `absent` / ...) and, when running, its orientation (`euler_deg`,
  `tilt_deg`), the `gravity_down` vector, `shake` and tap/shake counters.
  `samples: 20, interval_ms: 100` gives a 2 s series (e.g. "shake it now").
- Effects get the same values as uniforms bound BY NAME: declare
  `uniform vec3 imu_gravity = 0.0, -1.0, 0.0;` (unit down, map frame, +Y up),
  `imu_quat` (vec4 w,x,y,z), `imu_euler` (vec3 roll,pitch,yaw rad),
  `imu_lin_accel` / `imu_accel` (vec3, g), `imu_gyro` (vec3 rad/s),
  `imu_shake` (0..1), `imu_tap` / `imu_shake_count` (counters: react when the
  value changes, in `update()`). Without a sensor they are plain knobs, so the
  effect previews and can be driven by hand. See `examples/imu_tilt.fx`.
- `calibrate_sensors level` when the user says "this is upright"; `gyro_bias`
  after the fixture has sat still a few seconds. Both need it held still: ask
  first.

## Other I2C sensors: write a driver (feature `drivers`)

- `scan_i2c` lists the addresses that answer on the player's sensor bus. Match
  them to a part (and ask the user which module they wired), then read its
  datasheet.
- `deploy_driver {source, interval_ms}` loads a DRIVER: the effect language with
  `void poll()` instead of `shade()` and `export float|vecN name "unit";` outputs.
  `i2c_write(addr, reg, val)`, `i2c_read8/i2c_read16/i2c_read16s(addr, reg)` (all
  int; a read returns -1 on a bus error) talk to the part. Configure it once
  (guard with a `state` flag), then read and convert to physical units into the
  exports. Every export drives any effect uniform OF THE SAME NAME, live — name
  them for the effect (`lamp_temp`, `ambient_lux`).
- Poll slow sensors slowly (100–1000 ms); one driver runs at a time;
  `driver_state` shows its live exports and errors; `remove_driver` stops it.
- An IMU (MPU-6050) is driven natively — don't write a driver for it.

## Writing a new effect

1. Write the source (language: `effect-language.md`; knobs: `uniforms-and-ui.md`;
   using the fixture's shape: `geometry.md`; starting points: `examples/`).
2. `compile_effect {source}` — fix every diagnostic; check the uniform list. Each
   player compiles with the compiler matching ITS firmware (the hub fetches that
   firmware's bundle when it differs from its own).
3. `preview_effect {source, times: [0, 1.5, 3]}` — renders on the REAL map with the
   device's own VM; LOOK at the images. Is the effect visible across the fixture?
   Does it animate (compare frames)? Is anything clipped to black or white? With
   several players (or a room) you get ONE image per time of every fixture in the
   room frame, plus per-fixture stats.
4. `deploy_effect {effect_id, source, description, tags}` — estimates each player's frame cost
   first and deploys nowhere if any would overrun (`force: true` overrides;
   the estimate is uncalibrated, so still measure), then uploads and activates
   everywhere. A player holds one effect at a time; the hub remembers the
   previous one per player.
5. `measure_effect {seconds: 5, rollback_on_overrun: true}` — on-device frame cost
   vs budget (mean/max ms and per-window means) and `current_fps`: the player
   autoscales each effect between 25 and 80 fps (cheaper = smoother). An effect
   slower than 25 fps runs at whatever rate it achieves (`lagging: true`,
   `achieved_fps`); the player never parks it. Over budget → it lags (and
   `rollback_on_overrun` rolls it back); simplify (see "Performance" in
   `effect-language.md`) and repeat from 2 if smoothness matters.
   Optimizing: iterate offline with `estimate_effect {source}` (instant, touches
   nothing), then deploy + `measure_effect` to confirm — when they disagree, trust
   the measurement.
6. Report what you changed and which uniforms the user can now tweak.

`rollback_effect` restores whatever ran before your last deploy;
`set_effect {effect_id: "off"}` blacks out the effect.

## Changing effect without a hard cut — crossfade

When the user is watching (a mood change, a show), switch effects with
`crossfade_to {effect_id, source, seconds: 8}` (or `{library_id}` for a library
entry) instead of `deploy_effect`: the
new effect is loaded on the player's idle FX deck and the device blends into it
(`curve`: ease (default) / linear / ease_in / ease_out; `color_mode`: rgb or hsv).
Several players fade together on one clock. It checks frame cost like
`deploy_effect`; both effects render during the fade. The outgoing effect stays
loaded, so `rollback_effect {seconds: 3}` fades back to it — even one the user
started from the app. `list_decks` tells you which deck is live; uniform and
keypoint tools follow it. Deck B doesn't survive a reboot (deck A's effect comes
back), so for a permanent change finish with `deploy_effect`, or say so.

## Without MCP: the CLI

The same hub runs one tool per invocation and prints JSON (exit 1 on an error
or when every targeted player failed, 2 when only some did):
`splanc-agent list-players`, `splanc-agent ramp-uniforms rain=0.8 --seconds 20
--players living`, `splanc-agent preview-effect --file fx.fx --out /tmp/p`,
`splanc-agent deploy-effect calm --file calm.fx`, `splanc-agent save-keypoint
dusk`, `splanc-agent recall-keypoint dusk --seconds 10`, `splanc-agent
blend-keypoints calm=0.7 storm=0.3`, `splanc-agent skill <file>`;
`splanc-agent help` lists the commands, `splanc-agent tools` every tool. No
players found → pass `--host <ip>` (repeatable; it also skips the discovery
wait). Progress lines go to stderr, the JSON to stdout. (Not installed: `npx -y
https://splanc.io/agent/splanc-agent.tgz <command>` — but npx re-downloads the
bundle on every call, so for more than a couple of calls install it once with
`npm i -g https://splanc.io/agent/splanc-agent.tgz`.) The hub remembers players
it reached, so after the first call each one costs a single connection (~1 s on
the player's small chip); `list-players` from memory costs none.

**From the cloud.** If your Splanc tools come from a connector (a remote MCP
server at a relay URL ending in `/mcp`) rather than a local command, you are
reaching the user's lights through their Splanc bridge: a computer on their
network running the same hub. The tools and resources are the same; players are
what the bridge sees; `add_player` takes addresses as seen from the user's LAN.
An error saying the bridge is offline means the bridge isn't running or has no
internet: tell the user, don't retry in a loop. A user without a bridge can set
one up: docs/guides/cloud-agent.md in the Splanc repository.

## Textures

Effects that declare `texture vec3 img(W, H);` can be fed live frames:
`list_textures`, then `stream_texture {tex_index, source: {kind: "gradient", ...}}`
(solid / gradient / noise / raw RGBA frames), and `stop_texture` when done.

## Limits and etiquette

- The bridge cannot rewire, re-map or recalibrate the fixture (LED counts, GPIOs,
  colour correction, mapping) — that is the user's job in the Splanc app. Say so
  instead of looking for a workaround.
- `set_device_name` renames the player (and its Bluetooth name). Only after the
  user explicitly asks; pass `confirm: true`.
- There is no LAN authentication: anyone on the network can drive the player.
  Don't advertise the bridge beyond the user's machine.
- Room-frame poses are kept by the hub until the firmware can hold them
  (`fixture_pose` feature): previews and room summaries use them, but on older
  firmware an effect still sees `led.pos` in its own fixture's frame — design
  room-spanning effects per fixture there, and say so.
- A multi-player deploy puts the players on one effect clock when their firmware
  supports it (`time_base`); otherwise the result says "time base unsupported" and
  their animations drift apart — fine for ambient looks, not for chases that run
  across fixtures.
- An error naming the firmware version (`doesn't support this`) means the player
  is older than the feature; tell the user to update the firmware in the app.
