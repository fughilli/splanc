# Wall-clock schedules

Status: PR-6 and PR-7 of the real-time effects plan (desk D-559). PR-6: the firmware engine,
the protocol and a HITL lane. PR-7: the app's schedule screen, the MCP tools and the bridge's
live-show hold. Group schedules over the mesh come in PR-8.

"At 07:00 on weekdays, fade up." "Thirty minutes before sunset, crossfade to the evening
effect." Each lamp stores and fires its own rules on its own wall clock, in its own zone
(D-564). The clock is the software RTC (`wall-clock.md`).

## The rule

A `ScheduleRule` (ledmapper.proto) has:

- `id` (1..255; `set_schedule` upserts by id), `disabled`, and `label` (≤ 24 bytes);
- `when`:
  - `LOCAL_TIME` + `minute_of_day`;
  - or `SUNRISE` / `SUNSET` + `offset_min` (±720);
- `days_mask`: bit 0 = Sunday, counted on the local date; 0 means every day;
- one action:
  - `power {on, duration_ms}`: through the power machine, with its configured transition;
  - `brightness {level, ramp_ms}`: a ramp on the device;
  - `effect {effect_id, crossfade_ms}`: a stored effect (`submit_effect{store}`),
    crossfaded in;
  - `trigger {name}`: bumps the uniform-pool counter `name`, so an effect that declares
    `uniform trigger name;` sees `fired(name)`.

A lamp holds 24 rules. The pure logic is the no_std crate `//firmware/schedule`, shared with
`player_rs`:

- `rule.rs`: the model and its wire form, the ScheduleRule message coded by hand;
- `next.rs`: when a rule next fires;
- `sun.rs`: NOAA sunrise and sunset;
- `engine.rs`: the firing table.

## When rules fire

- **Local time across DST.**
  - In a spring-forward gap, a rule fires at the first instant after the gap. On the change
    day, 02:30 becomes 03:00.
  - In a fall-back overlap, a rule fires once, at the first occurrence.
  - Host tests cover both with real zones.
- **Sunrise and sunset (D-565).**
  - The times come from NOAA's equations (Spencer series, a −0.833° horizon, two passes).
    They are good to about a minute between the polar circles. The trig is written in the
    crate, since no_std has no libm.
  - The event is computed for the lamp's **local** date.
  - A date without the event is skipped: polar night or midnight sun.
  - A sun rule never fires until the lamp has a location.
- **The location** comes from `set_clock_config{lat_e4, lon_e4}` in 1e-4 degrees. The app
  sends the phone's geolocation rounded to 0.1°, so no geocoding service and no API key are
  involved.
  - It is persisted in NVS as `clk_loc` and echoed in `clock_state`
    (`has_location`, `lat_e4`, `lon_e4`).
  - Arm 113 is shared with the SNTP and hardware-RTC PRs. Their fields are 1–15 (NTP) and
    16–17 (RTC); the location uses 32–34.
- **Ahead of time.** The loop task polls the engine at 4 Hz with a 2 s horizon. A rule is
  handed out once, with its instant converted to a device due time:
  `millis() + (fire − wall now)`. Its action waits in the scheduled-apply queue (`SCHED`,
  the same queue `apply_at` uses) as an internal frame whose first byte is `0xFF`, which
  is never valid protobuf. The render task applies it at the first frame boundary at or
  after its due time. Every lamp with a synced clock therefore changes on the same frame,
  to clock accuracy.
- **Boot and late clocks (D-566).** The first poll with a valid clock *reconciles*:
  - It applies the state in force now: the latest past power, brightness and effect rule
    within a week, like a thermostat.
  - Momentary trigger rules are never replayed.
  - A forward clock step of 10 minutes or more reconciles too, but it applies only what
    was actually missed.
  - A shorter forward step fires the rules it stepped over, late.
  - A backward step never fires a rule twice, because each rule remembers its last fire.
  - The engine is polled even with no rules. A rule added later therefore never counts as
    "missed", and an edit never causes a surprise catch-up.
- **Live shows (D-567).** A rule is skipped, counted and logged (`last_skip = LIVE`) while a
  live show holds the lamp:
  - live-control traffic arrived in the last 30 s (seq'd `set_uniforms` / `set_crossfade`,
    or OSC);
  - or a `set_schedule{hold_s}` lease is running. The bridge renews this lease while its
    Show Mode lock is held (PR-7), and `release_hold` ends it.
  - Manual changes do not suspend schedules.

## Actions on the device (no blipping)

- **The loop task** owns the engine, the clock and all flash I/O:
  - `main.cpp` reads `/lfs/sched.pb` and the stored effect's record with the player mutex
    released;
  - it hands them to `sched_ffi.rs` under the mutex;
  - it writes a changed rule set with the atomic temp + fsync + rename path, below render's
    priority, and only on an edit.
- **Render** does only the following:
  - applies the queued frames;
  - advances two ramps, a few float ops per frame while one runs:
    - the **brightness ramp**, which writes only when the 1/255 output step changes;
    - the **timed crossfade**, which is new on the device (the bridge's `crossfade_to`
      steps it from outside).
  - A client that moves the brightness or the crossfade itself cancels the ramp, and its
    value wins.
  - While a brightness ramp runs, `main.cpp` neither logs each step nor pushes
    `power_state`. It does both once, at the end.
- **Effects keep running.** An effect rule never blanks the lamp:
  1. The stored effect loads, about 2 s ahead, onto the deck that is **not** showing.
  2. That deck renders at weight 0.
  3. At the due frame, the crossfade ramps to it.
  4. The next effect rule loads onto the other deck and fades back.
  - A deck-A load also becomes the boot effect. A deck-B effect is not persisted, but the
    boot reconcile brings it back.
  - If the effect is already showing (a reconcile after a soft reset), the rule does nothing.
  - If a power transition is using deck B, the rule is skipped (`BUSY`).
  - If the effect is not in the store, the rule is skipped (`NO_EFFECT`).
- **Power** goes through the power machine as `PowerState.source = 3` (SCHEDULE).

## Protocol

| Arm | No. | Reply |
|---|---|---|
| `set_clock_config` (the location) | C 113 | `clock_state` |
| `set_schedule {rules ≤ 4, replace_all, hold_s, release_hold}` | C 114 | `schedule_state` |
| `delete_schedule {id \| all}` | C 115 | `schedule_state` |
| `get_schedule {page}` | C 116 | `schedule_state` |
| `schedule_state` | S 62 | — |

- `schedule_state` carries:
  - the page of rules (4 per page), `page` / `pages` / `count` / `capacity`;
  - `clock_valid` and `has_location`;
  - the next fire and its rule;
  - `fired` / `skipped` and the last of each, with why it was skipped;
  - the hold seconds left;
  - the result of the change it answers (`OK`, `FULL`, `BAD_RULE`, `STORAGE`, `NOT_FOUND`).
- A change is all or nothing: one bad rule refuses the whole frame.
- The feature flag is `schedule`.
- Kiosk:
  - `get_schedule` is Read-class;
  - set, delete and `set_clock_config` belong to the owner (Refuse).
- The firmware profile carries no rules in its by-value envelope. `sched_ffi.rs` encodes
  them zero-copy.

## Log

- `[sched] boot: N rules, location set|none`
- `[sched] fire id= in_ms=`, when a rule is handed out
- `[sched] applied id= at_ms= due_ms= late_ms= unix_ms=`, the frame it landed on and that
  frame's wall time
- `[sched] skip id= why=` (1 LIVE, 2 NO_EFFECT, 3 BUSY)
- `[sched] rules saved (N bytes)`

## RAM and flash

- The engine table is about 0.7 KB of static RAM (24 rules of about 28 B), with no labels
  or names. The label and names stay on flash and are read when a rule is staged.
- Staging allocates transient heap on the loop task: the rules file (≤ 3 KB) and the stored
  effect record.
- The file is at most 3 KB.

## Tests

- `//firmware/schedule:*` (host):
  - the wire form and its validation;
  - DST gaps and overlaps, weekday masks on the local date, the year boundary, sun rules
    (polar, east of Greenwich);
  - NOAA against float64 reference vectors (`tools/gen_sun_vectors.py`) and published
    points;
  - the engine: boot reconcile, 3 h and 30 h outages, forward and backward steps, edits,
    24-rule capacity, ordering.
- `//firmware/player_app:schedule_test`: the arms through the C ABI with main.cpp's file
  handling played by the test:
  - the boot reconcile;
  - fires queued 2 s ahead and applied on their frame (`late_ms=0`);
  - the brightness ramp;
  - the staged stored-effect load onto deck B and the 3 s crossfade;
  - a trigger;
  - the live hold skip;
  - delete and paging, the location.
- HITL `//pi/hitl/harness:schedule_fire_netstack` (one DUT; the pure verdict is in
  `schedule_core`, unit-tested):
  - three rules at the next whole minute must apply within one frame after it on the
    device clock, against the harness's UTC;
  - a held rule is skipped as LIVE;
  - after a soft reset, the reconcile brings the scheduled effect back;
  - render runs with no late frame throughout.

## The app (PR-7)

- **Device sheet:** a "Schedule" card (lamps advertising `schedule`): the rule count, the next
  rule due, and "Open schedule". Rules are never edited on the sheet.
- **`#/device/schedule`** (`web/src/ui/screens/scheduleScreen.ts`): the rules, one line each
  ("07:00 Mon–Fri · Turn on · fade 30 s"), each with an on/off switch; the next rule due; a
  rule skipped for a live show; "Add a rule". The editor is one decision per screen:
  **When** (a time, sunrise, sunset) → **Time** (or the sun offset, ±3 h in the app) →
  **Days** → **Action** (turn on, turn off, brightness, an effect stored on the lamp, a
  trigger) → its **details** (fade, level + ramp, crossfade, trigger name) → **Review** (a
  name, Save; Delete when editing). From the review, "Change …" takes only the steps that
  part needs.
- **The location (D-565).** The first sun rule on a lamp without a location adds one step
  before the review. It says what is sent and why, and offers two ways:
  - "Use this phone's location": the geolocation prompt, only on that tap;
  - "Choose on map" (`ui/screens/mapPicker.ts`): a drag-to-pan map with a centre pin, or
    typed coordinates. It needs no permission, so it is also where a denied or failed
    geolocation lands. The map is OpenStreetMap's keyless raster tiles
    (`tile.openstreetmap.org`, attributed), so no API key reaches the client; the tiles
    reveal only the area looked at. Offline (the lamp's own Wi-Fi), the map says so and
    the typed coordinates still work.
  Either way the spot is rounded to 0.1° (`net/schedule.ts` `locationRequest`) and sent
  with `set_clock_config` just before the rule is saved. Nothing is sent for time-of-day
  rules. "Change location" on the list opens the same step for a lamp that moved. iOS:
  `NSLocationWhenInUseUsageDescription` (`web/ios-config/apply.sh`).
- The wire mapping and the rule text live in `web/src/net/schedule.ts`, shared with the bridge.

## The bridge (PR-7)

- **MCP tools:** `list_schedules`, `set_schedule` and `delete_schedule` (`agent/src/wallSchedule.ts`,
  `DeviceSession.listSchedules / setSchedules / deleteSchedules`). Rules take `when`
  (`time` + `"HH:MM"`, or `sunrise` / `sunset` + `offset_min`), `days` ("weekdays", day
  names…) and an `action` in seconds. A rule without `id` is added with a free id.
- **Ask first:** changing an existing rule (its id) or `replace` is refused unless
  `overwrite: true`, and `delete_schedule` only says what it would delete unless
  `confirmed: true`. The error tells the agent to ask the user; the server instructions say
  so too.
- **Live shows (D-567):** while a live app holds a player's Show Mode lock, the session
  renews `set_schedule{hold_s: 120}` every 45 s (`syncScheduleHold`, from the live mux's
  lock sync). Releasing the lock sends `release_hold`. A bridge that dies mid-show lets the
  rules resume within 2 minutes.

## Not here yet

- **PR-8:** group rules fanned out over the mesh.
- **`player_rs`:** answering the arms by wiring the crate into `pi/player_rs/src/schedule.rs`.
- **The HITL lane** uses one DUT. Two DUTs changing on the same frame (the plan's
  two-analyzer check) waits for the mesh lane (PR-8). Until then the same-frame property
  rests on each lamp landing within one frame of the wall instant.
