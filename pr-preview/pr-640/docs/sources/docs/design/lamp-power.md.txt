# Lamp power: on/off, ON/OFF transitions, touch sensor

Status: implemented (firmware feature `"power"`, protocol arms `set_power` 130,
`get_power` 131, `set_power_config` 132, reply/push `power_state` 70; driver
GPIO intrinsics and `trigger` uniforms in the fx language).

A Splanc lamp (the COIL lamp first) has a real on/off state. A capacitive touch
sensor under the lid toggles it, the app and the Splanc Agent can set it, and
every change is pushed to each open session so a lid tap shows up in the app and,
later, in a smart home (`docs/design/smart-home-integrations.md` Phase 0).

## What "off" means

- LEDs dark. The strip is blanked once and then nothing is transmitted.
- The effect is paused: no `update()`/`shade()` runs, so effect time stops and the
  render task sleeps ~50 ms per pass (about 0 % CPU).
- Everything else keeps running: Wi-Fi, BLE, the wss session, the agent, mDNS,
  sensors, OTA. Mapping capture and the counting probe still take over the strip
  (they are deliberate, transient device takeovers).
- Off is a user state, not a fault. The "effects keep running" rule
  (never reboot, never park) still holds when the lamp is on.

## State machine

`firmware/power` (no_std, host-tested) holds the pure logic:

- `Phase`: `Off`, `On`, `TurningOn`, `TurningOff`. `target()` is on for `On` and
  `TurningOn`.
- A request (`set_power`, a tap) starts the configured transition towards the
  target. A request mid-transition reverses smoothly: the new transition is a
  fade that starts from the current light level, so there is never a jump.
- Each render frame asks `Machine::frame(now)` for `{render, level_q8,
  crossfade, power, progress, settled}`:
  - `render` false only when settled off;
  - `level_q8` (0..256) scales the output (on top of `set_brightness`);
  - `crossfade` (EFFECT style only) drives the deck crossfade between the show
    (deck A) and the transition effect (deck B);
  - `power` / `progress` feed the transition effect's `power` and `transition`
    uniforms.

### Transition styles (`PowerTransition.style`)

| style | ON | OFF |
| --- | --- | --- |
| 0 CUT | instant | instant |
| 1 FADE (default) | level 0 -> 1 (smoothstep) | level 1 -> 0 |
| 2 EFFECT | level 0 -> 1 over the first 15 %, the transition effect alone until 70 %, then crossfade into the show | crossfade show -> effect over the first 30 %, the effect alone, level 1 -> 0 over the last 15 % |

EFFECT plays the effect stored with `submit_effect{power_slot}` on deck B, with
the slot-addressed `uniforms` preset (e.g. a keypoint's look) applied when it
starts. It can declare `uniform float power;` (the lamp's light level: 0 -> 1
turning on, 1 -> 0 turning off; so one "bloom" effect serves both directions) and
`uniform float transition;` (0 -> 1 progress). Without a stored effect, or while
deck B is live in a crossfade (position > 0), EFFECT falls back to FADE so a
show's mix is never clobbered. Deck B is cleared when the transition settles.

Durations: 0 = default (700 ms on, 900 ms off), clamped to 100..30000 ms.
`set_power.duration_ms` overrides one change; `instant` cuts.

## Persistence

- The target state is saved to NVS (`pw_on`) once it settles, coalesced, so a
  burst of taps writes once.
- The config (boot mode, both transitions incl. uniform presets) is a small
  record in `/lfs/power.cfg` (`ledmapper_power::encode_config`), written
  atomically on change.
- The transition effects are their `submit_effect` frames, `/lfs/pw_on.pb` and
  `/lfs/pw_off.pb`, replayed onto deck B when a transition starts.
- Boot (`PowerConfig.boot`): 0 = restore the last state (default), 1 = always
  on, 2 = always off. A lamp that boots on plays its ON transition once the
  first frame renders; one that boots off stays dark.

## Touch sensor: a driver-VM driver (owner decision D-185)

The ESP32-C6 has no touch peripheral. The sensor is a module with a digital
output (the kit uses DAOKI TTP223 boards, ASIN B07X87GX6G: 15 x 11 mm, round
pad, 3-pin GND / I/O / VCC header, 2.5-5.5 V), read as a GPIO input by a **driver running in the
driver VM**, the same host that runs I2C (QWIIC) drivers
(`docs/design/sensor-core.md` §8). There is no dedicated firmware input path.

- **GPIO intrinsics.** `gpio_mode(pin, mode)` (0 input, 1 input + pull-up,
  2 input + pull-down; returns 1 when applied) and `gpio_read(pin)` (0 / 1, -1
  when refused). The compiler aims them at the I2C ops with the pseudo device
  address `0x80` (`GPIO_DEV`; no 7-bit address reaches it), so the VM, the
  optimizer and the JIT are unchanged; the driver host (`driver_ffi.rs`
  `DrvBus`) routes that address to `LmDrvHost.gpio_read/gpio_mode`
  (`sensor_bus.cpp`). The host refuses pins with another duty: the LED outputs,
  the I2C bus pins, USB-Serial-JTAG (12/13) and flash (18/19, 24..30). A GPIO
  failure is the driver's answer, never a bus error. A driver no longer needs an
  I2C bus to load (a GPIO-only driver has none).
- **Driver time.** poll() now gets `dt` (s since the last poll) and a `time`
  that wraps every 1024 s (f32 keeps ~0.1 ms resolution); timers accumulate `dt`.
- **Trigger type.** `export trigger touch_tap;` in a driver, `fire(touch_tap);`
  bumps it (a float counter). Effects declare `uniform trigger touch_tap;`
  (manifest `ui.kind = "trigger"`) and ask `fired(touch_tap)` in update(): true
  once per change of the count (a reset counts too), compiled to a compare with a
  hidden last-seen state slot. Triggers are bound BY NAME through the uniform
  pool, like every driver export, so wiring a sensor to an effect is choosing the
  same name. `fired()` is update()-only; `fire()` needs an `export trigger`.
- **Power wiring.** `set_power_config.toggle_trigger` names a pool trigger; each
  increment toggles the lamp (`ledmapper_power::trigger_step`: first sight and a
  reset are adopted, not taken as a fire). Persisted in the config record.
- **The driver** (`firmware/sensor/drivers/ttp223_touch.fx`; the app and agent
  fill in the same template, `web/src/power/touchDriver.ts`): configures the pin
  once with the pull toward idle (an unwired module never reads as touched),
  ignores the first 1 s (the TTP223 recalibrates for ~0.5 s after power-up), debounces
  25 ms, ignores a "touched" level until it was seen released (a wrong polarity
  never fires), fires on each press (momentary) or each OUT change (toggle /
  self-lock), with a 150 ms lockout. Polled every 10 ms.
- **Known limit.** The driver polls on the loop task; a press shorter than a loop
  stall (the ~0.8 s TLS handshake when a client connects) can be missed. The
  TTP223 holds OUT for the whole touch, so ordinary taps (>= 100 ms) are seen.
- Only ONE driver runs at a time (FUG-107's slot); a lamp that also needs an
  IMU driver uses the native IMU path.
- **HITL hook.** `set_power_config.sim_gpio/sim_pull` overrides a pin's internal
  pull so the real driver -> trigger -> power path runs on a rig DUT with nothing
  wired. A wired module's push-pull output overrides the weak pull.

### Why the driver VM (and not the earlier dedicated input)

The first draft read the pin natively with an edge interrupt. The owner chose
the driver VM (D-185): one way to add any sensor module, the agent can write and
wire it, and the trigger type is general (any sensor can drive any effect's
`update()`). The cost: polling at 10 ms on the loop task (a few hundred VM ops
per poll, a 6-7 KB heap slot while loaded) instead of an interrupt.

## Wiring (TTP223 module to an ESP32-C6 SuperMini)

```
TTP223 module            ESP32-C6 SuperMini
(header: GND / I/O / VCC)
  VCC  ----------------  3V3      (NOT 5V: I/O would then swing to 5 V)
  GND  ----------------  GND
  I/O  ----------------  GPIO 3   (any free "recommended" pin: 0-3, 10, 11, 22, 23)
```

Target setting: **active-high, momentary**, the boards' as-shipped default
(solder pads A = 0, B = 0, i.e. both open). Check the module before mounting it:

| A | B | OUT behaviour | driver setting |
| --- | --- | --- | --- |
| open | open | momentary, active-high (default) | default |
| open | bridged | toggle (self-lock), active-high | mode toggle (works, but momentary is preferred: a toggle module's level says nothing about the lamp's state) |
| bridged | open | momentary, active-low | active-low |
| bridged | bridged | toggle, active-low | active-low + toggle |

Or meter I/O against GND: ~0 V idle and ~3.3 V only while touched = the
default; stays at 3.3 V after a touch = toggle; 3.3 V idle = active-low.

Mount the pad under the lid, flat against the lid's inside (up to ~3 mm of
plastic or wood). The TTP223 recalibrates for ~0.5 s after power-up (the driver ignores the
first second): don't touch the lid while the lamp powers on.

## Protocol

See `shared/protocol/proto/ledmapper.proto` ("Lamp power"). Additive: new arms
130-132 / 70 and `SubmitEffect.power_slot` (7). Old firmware ignores `power_slot` and parks
the effect on deck B (clients send deck 1, activate false); clients gate on the
`"power"` feature.

`power_state` is pushed to every session that has sent any power arm (a
`get_power` after `hello` subscribes; a subscription ends with its connection,
so old clients never see the new arm) on every change: phase changes (start and settle),
config changes, a new transition effect, a trigger toggle, brightness changes.
`seq` increases on every change so a client can drop a stale push.

## Costs

Static RAM: the machine and the config (with two 8-value uniform presets and
the trigger name), about 0.6 KB (see the PR for the
measured `.bss`/`.data` delta). Flash: the power crate + handlers. Render cost
when on and settled: one branch and a byte multiply per frame.
