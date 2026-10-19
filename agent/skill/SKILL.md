---
name: splanc
description: Drive a Splanc LED player (a mapped, 3-D LED fixture) through the splanc-agent MCP bridge — set moods with uniforms, write and deploy FX-engine effects, preview them on the real map, and keep them within the device's frame budget. Use when the user asks to change, create or tune what their Splanc lights are doing.
---

# Driving a Splanc player

A Splanc player is an ESP32-C6 (or Pi) running LEDs whose **3-D positions are
known**: a camera mapping pass measured every LED, in meters, and the player stores
that map plus a topology (segments, branch points). Every show is an **FX-engine
effect**: a small shader-like program the player runs once per LED per frame. The
`splanc-agent` MCP server is your connection to ONE player.

## First, look

1. Read `splanc://device` (name, firmware, features) and
   `splanc://fixture/summary` (LED count, bounding box in meters, segments, up
   axis = +Y). Read `splanc://fixture/map` / `topology` only when an effect needs
   the actual geometry (see `geometry.md`).
2. Read `splanc://effect/active` (or call `list_uniforms`): which effect is
   running and what its knobs are.

## Changing the mood — prefer uniforms

Most requests ("warmer", "calmer", "more rain") are a **uniform change on the
effect already running**, not a new effect. Uniforms are addressed by NAME; the
bridge checks width and range and tells you the declared names if you miss.

- `set_uniforms {values: {tint: [1, 0.5, 0.2]}}` — instant.
- `ramp_uniforms {targets: {rain: 0.8}, seconds: 20}` — a smooth glide; the bridge
  streams the steps and commits the end value once. Use this for anything a person
  will watch change.
- `commit: true` persists values across reboots — only when the user wants the
  change to stick (flash wear).
- `set_brightness {level}` is global output brightness (runtime-only).

## Writing a new effect

1. Write the source (language: `effect-language.md`; knobs: `uniforms-and-ui.md`;
   using the fixture's shape: `geometry.md`; starting points: `examples/`).
2. `compile_effect {source}` — fix every diagnostic; check the uniform list.
3. `preview_effect {source, times: [0, 1.5, 3]}` — renders on the REAL map with the
   device's own VM; LOOK at the images. Is the effect visible across the fixture?
   Does it animate (compare frames)? Is anything clipped to black or white?
4. `deploy_effect {effect_id, source}` — uploads and activates. The player holds
   one effect at a time; the bridge remembers the previous one.
5. `measure_effect {seconds: 5, rollback_on_overrun: true}` — on-device frame cost
   vs budget. Over budget → it rolls back; simplify (see "Performance" in
   `effect-language.md`) and repeat from 2.
6. Report what you changed and which uniforms the user can now tweak.

`rollback_effect` restores whatever ran before your last deploy;
`set_effect {effect_id: "off"}` blacks out the effect.

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
- One bridge per player. To drive several players, the user runs one bridge per
  player (`splanc-agent --host <player>`).
- An error naming the firmware version (`doesn't support this`) means the player
  is older than the feature; tell the user to update the firmware in the app.
