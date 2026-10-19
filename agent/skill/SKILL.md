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

## Which players

Every device tool takes `players`: a player name, its id (MAC), a room name,
`"all"`, or a list. Without it, a tool targets the only player — or all of them
when they form one room — and asks you to choose when there are several rooms.
With several targets the result is one entry per player (`ok`, `result` or
`error`); a failure on one never hides the others' results, so report it.

## First, look

1. `list_players` (or the `splanc://players` resource): names, rooms, firmware.
   No players → ask the user for the player's address and `add_player`.
2. Several players and no rooms, and the user speaks of rooms ("the living
   room", "the shelf")? Ask which fixture is where — `identify_player` blinks one
   so they can tell — then `set_room {room, players}`, and `set_fixture_pose` to
   place each fixture in the room (metres, +Y up; ask, don't guess). Rooms and
   poses persist in the hub.
3. Read `splanc://fixture/summary` (one player) or `splanc://room/<room>` (every
   fixture in the room's shared frame: per-fixture and combined bounding boxes).
   Read `splanc://player/<id>/fixture/map` / `topology` only when an effect needs
   the actual geometry (see `geometry.md`).
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
4. `deploy_effect {effect_id, source}` — estimates each player's frame cost
   first and deploys nowhere if any would overrun (`force: true` overrides;
   the estimate is uncalibrated, so still measure), then uploads and activates
   everywhere. A player holds one effect at a time; the hub remembers the
   previous one per player.
5. `measure_effect {seconds: 5, rollback_on_overrun: true}` — on-device frame cost
   vs budget (mean/max ms and per-window means). Over budget → it rolls back;
   simplify (see "Performance" in `effect-language.md`) and repeat from 2.
   Optimizing: iterate offline with `estimate_effect {source}` (instant, touches
   nothing), then deploy + `measure_effect` to confirm — when they disagree, trust
   the measurement.
6. Report what you changed and which uniforms the user can now tweak.

`rollback_effect` restores whatever ran before your last deploy;
`set_effect {effect_id: "off"}` blacks out the effect.

## Without MCP: the CLI

The same hub runs one tool per invocation and prints JSON (exit 1 on error):
`splanc-agent list-players`, `splanc-agent ramp-uniforms rain=0.8 --seconds 20
--players living`, `splanc-agent preview-effect --file fx.fx --out /tmp/p`,
`splanc-agent deploy-effect calm --file calm.fx`, `splanc-agent skill <file>`;
`splanc-agent tools` lists everything. (Installed: `npx -y
https://splanc.io/agent/splanc-agent.tgz <command>`.)

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
