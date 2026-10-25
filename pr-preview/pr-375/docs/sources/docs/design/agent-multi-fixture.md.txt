# Multi-fixture agent support ("just ask" for a room of players)

Extends the Agent Discovery & MCP Bundle Spec. Goal: an agent with the Splanc MCP
server configured once can be told "make the living room feel like a rainforest" and
it finds every player, treats them as one room, and drives them coherently — no
hostnames, no per-player setup.

## 1. One hub bridge, many players

The bridge becomes a hub. It is launched once (`npx -y <latest bundle url>`, or
`claude mcp add splanc -- npx -y …`) with no arguments.

- **Registry.** It keeps a live set of players:
  - continuous mDNS browse of `_splanc._tcp`;
  - a manifest probe of known hosts;
  - a remembered set in `~/.config/splanc/players.json` (keyed by MAC; last host,
    name, fw, cert pin);
  - an optional `/24` sweep of `GET /.well-known/splanc.json` for networks that
    drop multicast. It is opt-in or automatic only when mDNS finds nothing;
    cheap, bounded and cancellable.

  Explicit `--host` values are added, not exclusive.
- **Identity is the device id, never the host.** Players move: firmware that
  picks a random Wi-Fi MAC per boot gets a new DHCP lease after every reboot.
  A manifest, Welcome or mDNS TXT naming a known id at a new host (discovery,
  the sweep, `add_player`) moves that player's record there and drops its old
  address, including an explicit host that pointed at it. A known player that
  stops answering stays listed as `checked: "unreachable"` with the reason. The
  sweep then looks for it by id (TCP probes of 1 s, generous because a dozing
  ESP32 answers ARP/SYN only at its next DTIM wake-up). A certificate other than
  the one pinned for that id is refused as TLS CHANGED wherever it shows up.
- **Sessions.** They are lazy, one per player: connect on first use, keep alive
  with the device's single wss slot in mind (one socket per device, ever), and
  reconnect with backoff. A player that vanishes never closes its socket, so
  every session has a heartbeat (`agent/src/liveness.ts`). After 20 s of
  silence idle, or 4 s while a call waits on the player, the hub sends a
  `time_sync_ping`. Two unanswered pings, with no other traffic, mean dead.
  A socket that closes and doesn't reconnect within 10 s is also dead. A dead
  session fails its in-flight calls with the reason, is dropped, and its player
  is marked unreachable. A background search then runs (mDNS for its TXT id,
  then a LAN sweep for its manifest), backing off from 2 s to 5 min while any
  remembered player is missing. A session that has been silent for 10 s is
  pinged before a tool uses it, so a call made right after a reboot re-finds
  the player instead of hanging on the dead socket.
- **Version matching.** Each player's manifest names its bundle. The hub carries
  its own compiler and simulator. For a player whose fw falls outside its
  `bundle.json` range, it fetches that player's bundle (url + sha256 from the
  manifest, cached under `~/.cache/splanc/bundles/<ver>`) and loads that bundle's
  compiler and simulator wasm for that player. The protocol code is shared
  (`ledmapper.v1` is additive). Dev/dirty players use the hub's own toolchain
  with a warning.
- **Targeting.** Every device tool takes an optional `players` selector:
  - a name, MAC or group, or a list of them;
  - `"all"`;
  - default: all players if there is one room, else an error asking which.

  Fan-out runs in parallel across players (serialized per player) and returns
  per-player results; partial failure is reported per player, never hidden.
- **New tools:**
  - `list_players`, `refresh_players`;
  - `name_group` / `set_groups`: rooms and groups, persisted in the hub config
    and, when the device supports it, on each device (see §2);
  - `identify_player`: blink one fixture so the user can say which is which.
- **Resources:**
  - `splanc://players`;
  - `splanc://room/<group>`: fixtures, poses, the combined bounding box in the
    room frame, total LEDs, per-player budgets;
  - the per-player `splanc://player/<id>/…` versions of the existing resources;
  - the old un-prefixed URIs alias the only/selected player.

## 2. A room frame: fixture poses

An effect runs on each device over that device's own map (its `led.pos`, in the
map's frame). For one effect to span the room, each device needs its pose in a
shared room frame.

- **Firmware + protocol.** `SetFixturePose { room: string, translation: vec3 (m),
  rotation: quat, scale: float }`, persisted (commit semantics like
  SetColorCorrection), echoed in Welcome or HardwareConfigState as `room` +
  `pose`. The firmware precomputes each LED's room-frame position at map load or
  pose change (a FX_LED_ROOM cache beside FX_LED_POS; budget the RAM — 12 B/LED
  as fixed-point or f32; account it in the sysmode cost table and the stack gate).
- **Compiler + VM.** A new `led.room` builtin (vec3, metres). It equals `led.pos`
  when no pose is set, so effects written for one fixture keep working. The
  fixture bounding box in the room frame is exposed as `room.min`/`room.max`
  builtins (or uniforms the bridge fills), so an effect can normalise across the
  room.
- **Where poses come from:**
  1. The user tells the agent ("the lamp is two metres left of the shelf
     strip"). The skill teaches the agent to turn that into `set_fixture_pose`
     and to confirm with `identify_player`, or a preview rendered in the room
     frame.
  2. Fixtures mapped in the same phone capture session (FUG-112 supplemental
     captures register into one frame) can be posed automatically from the
     capture's frame. This is a follow-up; leave the hook.
  3. The default when nothing is known: fixtures are laid out side by side along
     x in the preview, flagged as unposed, so the agent asks.

## 3. A shared time base

Effects animate on device time (`time` = seconds since effect start), so identical
effects on two devices drift apart.

- **Firmware + protocol.** `SetTimeBase { epoch_ms: int64 }` in the device's own
  clock domain (the player's millis()). The effect's `time` becomes `(now -
  epoch) / 1000`. It is runtime only, and resets to effect start on reboot.
- **Bridge.** It already speaks TimeSyncPing/Pong: it estimates each player's
  clock offset (min-RTT filtered), picks one room epoch in host time, and sends
  each player the epoch converted to that player's clock. It re-syncs
  periodically and on reconnect. Target: under 20 ms skew between fixtures,
  measured on HITL with two DUTs and the LED timing capture.

## 4. Room-level tools

- `deploy_effect` / `set_effect` / `set_uniforms` / `ramp_uniforms` /
  `measure_effect` accept `players` and fan out. `deploy_effect` compiles per
  version, checks every target's budget first (per-player cost estimate via the
  fleet estimator — `web/src/effects/multiDevice.ts` already does exactly this),
  then deploys, then sets one shared time base.
- `ramp_uniforms` across players uses the shared time base, so the ramp is
  simultaneous.
- `preview_effect` with `players`/`room` renders all fixtures in the room frame
  in one image.

## 5. "Just ask" install and first contact

- One line:

  ```
  claude mcp add splanc -- npx -y https://github.com/Studio-Fug/splanc/releases/latest/download/splanc-agent.tgz
  ```

  Also provide an MCP registry `server.json` packages entry (the spec's
  open-question candidate), ready for when the package is published.
- The skill's first-contact flow:
  1. `list_players`.
  2. If there are several and no room exists, offer to group them and to place
     them (asking the user, and using `identify_player`).
  3. Then do what was asked.

  All of it is driven by the resources, so a fresh agent needs no prompt
  engineering beyond the request.

## Constraints

- BLE and wss coexist (PR-38).
- Native playback is gone.
- Never more than one wss socket per device.
- No LAN auth exists (document; out of scope).
- Device RAM is tight: the room cache must be budgeted, and the stack gate and
  sysmode model must stay green.

## 6. A web entry point: "Use splanc.io to set the mood of the room"

A fresh agent with web access and a shell, and no MCP config, must be able to act
from that sentence alone.

- **Static agent files** at the site root, served by the web app's static deploy
  (Cloudflare Pages: splanc.pages.dev today, splanc.io when the domain points
  there; the host must be configurable at build time):
  - `/AGENTS.md`: what Splanc is, the two ways to act (below), the first-contact
    flow, and links to the skill and the bundle. It is short and imperative,
    written for agents.
  - `/llms.txt`: an index in the llms.txt convention pointing at AGENTS.md, the
    skill files and the spec.
  - `/.well-known/mcp/server.json` (and the MCP registry `server.json` packages
    entry): the npx package/tgz and its args.
  - `/agent/skill/…`: the skill, mirrored from the latest release bundle.
  - `/agent/latest.json`: the latest bundle version, url and sha256.

  They are generated from the same sources as the bundle at build time (a
  web-build step, no hand-copied docs), so they can't drift.
- **Two ways to act:**
  1. **MCP.** One line: `claude mcp add splanc -- npx -y <latest tgz>`. This is
     best for repeated use.
  2. **CLI, zero setup.** `npx -y <latest tgz> <command> [--players …] [args]`
     runs the same core as a one-shot CLI with JSON output. Commands mirror the
     tools (`list-players`, `room`, `deploy-effect --file x.fx`,
     `ramp-uniforms --room living --set rain=0.8 --seconds 20`, `preview
     --out room.png`, …), plus `skill` to print the skill. Discovery, per-player
     version matching and the shared time base behave exactly as in the hub. A
     one-shot run must leave the devices in a clean state; ramps and streams
     need either a `--wait` foreground mode or a detached background helper that
     exits when done. Prefer `--wait`, and keep it simple.

  AGENTS.md tells the agent to prefer MCP if it is already configured, and the
  CLI otherwise.
- **Safety.** It is the same tool set and the same exclusions in both modes;
  AGENTS.md states them, so agents don't go looking for raw protocol access.
