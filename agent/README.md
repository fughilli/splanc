# splanc-agent — MCP bridge + agent bundle

Implements the bridge side of the _Splanc Agent Discovery & MCP Bundle Spec_: an
MCP server (stdio) — and a one-shot CLI over the same tools — that lets an AI
agent drive EVERY Splanc player on the LAN over their `/ws` protocol (the hub of
[docs/design/agent-multi-fixture.md](../docs/design/agent-multi-fixture.md)),
plus the release bundle that ships it with the matching compiler, simulator,
skill and the website's agent entry point.

```text
agent/
  src/cli.ts         entry: MCP stdio (no command) or one-shot CLI (`<command>`), both over the hub
  src/hub.ts         players: selectors, lazy one-socket-per-player sessions, fan-out, rooms, time base
  src/registry.ts    discovery: --host, remembered, mDNS, bounded /24 manifest sweep; dedupe by MAC;
                     the fast path (cache + TCP check, identify-by-session, early-exit mDNS)
  src/progress.ts    per-call phase progress -> MCP notifications/progress + logs, CLI stderr
  src/config.ts      ~/.config/splanc/hub.json: remembered players, rooms, poses
  src/toolchain.ts   per-firmware compiler/VM: this bundle's, or the player's fetched+sha256-checked bundle
  src/room.ts        room frame: pose transform, side-by-side layout of unposed fixtures, room summary
  src/timesync.ts    clock-offset -> per-player epoch math, skew bound
  src/discovery.ts   _splanc._tcp browse, GET /.well-known/splanc.json, Welcome check
  src/socket.ts      Node `ws` adapter for web/src/net/client (TLS policy + cert pin)
  src/session.ts     serialized device session: tools' wire behaviour, error mapping,
                     safety guard, rollback, MappingBundle cache, feature detection
  src/server.ts      MCP resources + tools (zod schemas)
  src/uniforms.ts    name -> slot resolution, width/range checks, ramp interpolation
  src/fxhost.ts      host compile + preview (the editor's compiler + VM wasm), PNG render
  src/bridge/        `splanc-agent bridge`: the hub served to cloud agents through the relay
                     (relayLink.ts outbound socket + backoff, lanBridge.ts MCP sessions +
                     status file + control socket, identity.ts Ed25519 key)
  src/relayHost.ts   `splanc-agent relay`: the relay Worker on Node (self-hosting, tests)
  relay/             the cloud relay: Cloudflare Worker + Durable Objects (wrangler.toml, deploy.sh)
  skill/             SKILL.md, effect-language.md, uniforms-and-ui.md, geometry.md, examples/*.fx
  site/              AGENTS.md / llms.txt / server.json templates (rendered into the bundle's site/)
  tests/             fake TLS players; bridge, hub (N players), examples, stdio, CLI, site tests
```

The /ws client is the web app's own `LedMapperClient` (`web/src/net/client.ts`,
exposed as `//web:agent_reuse_srcs`), bundled by relative import — not a copy.

## Running it

The stable one-liner (the website serves the newest firmware release's bundle):

```sh
claude mcp add splanc -- npx -y https://splanc.io/agent/splanc-agent.tgz   # MCP
npx -y https://splanc.io/agent/splanc-agent.tgz list-players                 # CLI
```

No `--host` needed: the hub finds players by mDNS, remembers them
(`$SPLANC_CONFIG_DIR`, default `~/.config/splanc/hub.json`), and sweeps the local
/24s for `/.well-known/splanc.json` when nothing else finds one. `--host` (repeatable)
adds players discovery can't see — and skips the mDNS wait and the sweep; `--no-mdns`
skips browsing. Progress goes to stderr (`--quiet` silences it); stdout is the JSON.

### Latency (what a call costs, and why)

The player's chip (heapless TLS on an ESP32-C6) takes ~0.7 s of ECDHE+ECDSA per
TLS handshake, serves one handshake at a time, and has no session resumption; a
SYN that arrives before its listener re-arms after a connection is dropped and
retried by the host 1 s later. So the hub spends handshakes only where a tool needs
them:

- **Remembered player** (every one reached before): identity, TLS pin and manifest
  come from `hub.json` after a bare TCP check (closed gracefully, so the listener
  re-arms before the session's SYN). `list_players` costs no TLS at all; a device
  tool opens ONE session.
- **New host** (`--host`, or an mDNS advert without TXT `id`): identified by opening
  its `/ws` session (Welcome names the MAC and carries the features), which the tool
  then uses — not a manifest GET followed by a second handshake. Its certificate is
  pinned on first use.
- **mDNS** runs only without `--host` (or for `refresh_players`), alongside the known
  players' checks; it returns 300 ms after the last new answer, or 300 ms after every
  known player answered, at most 1.5 s. The /24 sweep starts at once when there is
  nothing to go on (cold, no hosts, nothing remembered) and stops when mDNS answers.
- **Manifest**: read only by the sweep, `refresh_players`, or a compile for firmware
  outside this bundle's range (for its `bundle.url`), then remembered.
- The compiler/VM wasm loads on the first compile/preview, not at startup.

Measured against a real C6 (firmware 1.7.1) through the HITL rig's ssh tunnel (~80 ms
RTT), old and new interleaved, median of 7, direct `node` (no npx): `set-brightness`
cold 3.6 s -> 1.6 s, warm 3.0 s -> 2.0 s, warm without `--host` (mDNS) 6.0 s -> 1.8 s;
`list-players` warm 1.5 s -> 0.65 s. The device's handshake alone was 0.8 s median,
3.2 s p90 (radio retries). The remaining floor is one handshake per player per process; a
long-lived MCP server keeps its sessions, so later tool calls are one round trip.
`npx` adds 0.4–2 s per call on top (it re-fetches the tgz every time, and keeps
running the version it first cached) — for repeated calls install once:
`npm i -g https://splanc.io/agent/splanc-agent.tgz`, then `splanc-agent <command>`.

From a release bundle (`splanc-agent-<ver>.tgz`, attached to `firmware-v<ver>`):

```json
{
  "mcpServers": {
    "splanc": {
      "command": "node",
      "args": ["/path/to/splanc-agent-<ver>/mcp/splanc-agent.mjs", "--host", "led-widget.local"]
    }
  }
}
```

From a checkout: `bazel build //agent:mcp //agent:wasm`, then
`node bazel-bin/agent/dist-mcp/splanc-agent.mjs --bundle-root bazel-bin/agent/wasm --host <player>`.

Flags: `--host <name|ip[:port]>` (repeatable; `--list` prints what mDNS sees), `--pin <sha256>`
(TLS pin; default: the certificate first seen, or the manifest's `tls.cert_sha256`), `--stream-hz <n>`
(ramp stream rate, default 20), `--bundle-root <dir>` (where `compiler/` + `simulator/` live; default:
the bundle), `--quiet` (no progress on stderr).

Progress: every phase (`discovering (2 known + mDNS)…`, `connecting Kitchen (10.0.0.7)…`,
`Kitchen: connected 850 ms (firmware 1.7.1)`, `found 2 players (900 ms)`, deploy/ramp/measure steps)
is reported through `src/progress.ts` (per call, via AsyncLocalStorage): the MCP server sends it as
`notifications/progress` when the call carries a `progressToken` and as `notifications/message` log
lines (it declares the `logging` capability); the CLI prints it to stderr.

## Bug reports

Every surface has `file_bug` (CLI: `splanc-agent file-bug --title … --description … --severity …`):
a scrubbed report with diagnostics, a duplicate check, and a pre-filled GitHub link; with the
user's go-ahead it files directly through the relay's `POST /bugs`, which needs the
`GITHUB_ISSUES_TOKEN` Worker secret ([docs/design/agent-bug-reports.md](../docs/design/agent-bug-reports.md)).

## Cloud agents: bridge + relay

Hosted agents can't see the LAN. `splanc-agent bridge --relay <url>` runs the hub on an
always-on LAN host (a Pi, or anything with Node 20+) and keeps an outbound WebSocket to the
relay, which serves it as a remote MCP endpoint, `<relay>/mcp` (Streamable HTTP, OAuth sign-in
with the pairing code shown on the bridge, or a bearer token from `<relay>/pair`). The bridge
writes `/run/splanc-bridge/status.json` and listens on `/run/splanc-bridge/control.sock` for
its display (`splanc-agent bridge-ctl new-code|revoke-all|identify|status`). `splanc-agent relay`
hosts the relay yourself (e.g. behind `tailscale funnel`). Design, wire protocol, display
contract, threat model and free-tier budget:
[docs/design/cloud-relay.md](../docs/design/cloud-relay.md); user guides:
[cloud agent](../docs/guides/cloud-agent.md), [Tailscale](../docs/guides/relay-tailscale.md).

```sh
claude mcp add --transport http splanc <relay>/mcp     # then /mcp -> Authenticate (pairing code)
```

## Surface

Resources: `splanc://players`, `splanc://room/<room>` (`all` = every player),
per player `splanc://player/<id>/{device,fixture/summary,fixture/map,fixture/topology,effect/active}`;
the spec's un-prefixed URIs (`splanc://device`, …) alias the default target (one
player: its data, as before; several: keyed by player).

Device tools (each takes `players`: name | MAC | room | `"all"` | list; default
the only player, or all of them in one room): `set_brightness`, `list_uniforms`,
`set_uniforms`, `ramp_uniforms`, `compile_effect`, `preview_effect` (several
players: one room-frame image per time), `deploy_effect` (fleet budget check via
`web/src/effects/multiDevice.ts`, refuses an overrun unless `force`; then a shared
time base), `set_effect`, `rollback_effect`, `estimate_effect` (offline cost
model, touches nothing), `measure_effect` (windowed on-device perf stream;
effects slower than 25 fps run at whatever rate they achieve — `lagging`,
`achieved_fps` — the player never parks them),
`list_textures`, `stream_texture`, `stop_texture`, the uniform keypoint tools
`list_keypoints` / `save_keypoint` / `recall_keypoint` / `blend_keypoints` /
`delete_keypoint` (feature `keypoints`; design
[uniform-keypoints.md](../docs/design/uniform-keypoints.md); deck default = the
live deck), `crossfade_to` (features `decks` + `crossfade`: cue the effect on the
idle FX deck, then stream the crossfade on one hub clock for every player, after
re-using/applying the room's time base; the outgoing effect stays loaded as the
rollback target, so `rollback_effect {seconds}` fades back), `list_decks` (both
decks, crossfade position, live deck), `plot_fixture` (a four-view 3D PNG of the
map or a posed room, pure-TS rasteriser `src/plot.ts`, capped at 512 KB; colour by
index / confidence / segment / channel / fixture / an effect frame), `read_sensors` /
`calibrate_sensors` (feature `sensors`: the on-board IMU, design
[sensor-core.md](../docs/design/sensor-core.md)), `export_map`
(the stored map as TouchDesigner CSV or a Chromatik `.lxf`, same serializer as
the app's Export map; see the user guide), a confirm-gated
`set_device_name` (one player).
Effects library tools (a private library per installation: entries with a
description, tags and the uniform manifest; design
[cloud-relay.md § Effects library](../docs/design/cloud-relay.md#effects-library)):
`search_effects`, `get_effect`, `save_effect`, `duplicate_effect`,
`update_effect`, `delete_effect`, and `deploy_effect {library_id}`. Behind the
cloud relay the relay serves them; stdio and the CLI keep the library in
`<state dir>/effects-library.json`.
Hub tools: `list_players`, `refresh_players` (`sweep`), `add_player`,
`forget_player`, `trust_player` (re-trust after a factory reset), `identify_player`
(blinks), `set_room`, `set_fixture_pose`,
`align_time`. One player + no selector keeps #274's flat result shape;
otherwise `{results: [{player, ok, result|error}], summary}`.

CLI: `splanc-agent <command>` runs one tool (dashes for underscores: `list-players`,
`set-uniforms k=v`, `ramp-uniforms k=v --seconds 20` (waits), `deploy-effect <id>
--file f.fx`, `preview-effect --file f.fx --out dir`, `list-keypoints`,
`save-keypoint <name> [k=v...]`, `get-keypoint <name>`, `recall-keypoint <name>
[--seconds s] [--commit]`, `blend-keypoints a=0.7 b=0.3 [--seconds s]`,
`delete-keypoint <name>`, `room`, `skill [file]`, `tools`, `call <tool> '<json>'`,
…; `splanc-agent help`, from `USAGE` in `src/cliArgs.ts`) and prints the JSON
result. Exit status: 0 on success; 1 on a tool error or when every targeted
player failed; 2 when only some did. An empty `list-players` carries a hint to
pass `--host <ip>` (discovery is mDNS + a local /24 sweep).

Deliberately absent: `set_playback` / `splanc://playback` (native pulse/flood
was removed; every show is an FX effect), and anything that sends
SetHardwareConfig, SetLedCount, SetColorCorrection, the mapping arms or SetJit —
`session.ts` refuses those at the wire (`FORBIDDEN_TYPES`, pinned by a test). The one
scoped exemption: the paired app's room localization through the bridge (live
`group_capture` query) may send `start_mapping` / `stop_mapping` for a group
capture, inside `DeviceSession.groupCaptureScope`; no MCP tool or CLI command
enters that scope.

## Decisions on the spec's open questions

- **TLS.** `/ws` is TLS with the player's OWN self-signed cert (each player
  generates its key on first boot and keeps it for life; a rename does not change
  it; docs/design/per-device-cert.md). Chain verification is off; instead the cert
  is pinned per player id (MAC), trust on first use, like SSH `known_hosts`
  (`src/trust.ts`): the fingerprint the first session (or manifest read) actually
  presented is remembered in `hub.json` (`players[id].pin`), never the manifest's
  claim. A different cert for a known id is REFUSED (`list_players` shows
  `tls: CHANGED`) until `trust_player` (CLI `trust-player <id>`) accepts it after
  the user confirms a factory reset; a manifest naming another cert than the
  connection presented is refused as interception. A pin equal to the legacy
  shared cert of pre-per-device firmware re-pins silently. `--pin` overrides all
  of it. A manifest read for a player advertising `tls=generating` (first boot)
  waits for it.
- **One hub, every player** (multi-fixture design doc): one lazily-opened socket per
  player, serialized per player, parallel across players. A player whose firmware
  is outside this bundle's range compiles/previews with ITS bundle (manifest
  `bundle.url`, sha256-checked, cached in `$SPLANC_CACHE_DIR/bundles/<ver>`);
  a dev build uses this bundle's compiler with a note.
- **Poses + time base (device side pending).** `set_fixture_pose` stores poses in
  the hub config and sends SetFixturePose only when the player advertises
  `fixture_pose` AND this build's proto can encode it ("not yet applied on device"
  otherwise). Clock offsets come from TimeSyncPing/Pong; SetTimeBase likewise needs
  `time_base`, else the result says "time base unsupported" and the fan-out still
  happens.
- **Poses from the app.** A pose the device itself reports (welcome.pose, e.g. from
  the app's room localization — docs/design/multi-fixture-localization.md) is used
  when the hub has none of its own, so `splanc://room/…` and `plot_fixture` see it.
  The bridge's live `group_capture` query (prepare / start / stop / set_pose) is how
  the app arms a group capture through the bridge.
- **No LAN auth.** The player has none and the bridge doesn't invent one; anyone
  on the LAN can drive it. Documented in the skill too.
- **Stream rate.** Ramps stream uncommitted at `--stream-hz` (default 20, capped
  at 60, and at the player's own effect framerate once a perf report / fps_state
  has reported it — FUG-82 autoscaling firmware, 25..80 fps).

## Feature detection (pending the device-side PR)

Features come from `Welcome.features` (sent since the manifest route arrived, #276)
merged with a cached manifest's `protocol.features`; everything below falls back on
older firmware:

| Feature             | With it                                        | Without it (today)                                               |
| ------------------- | ---------------------------------------------- | ---------------------------------------------------------------- |
| manifest route      | identity/fw/pin from the manifest              | HTTP 404 -> Welcome.fw_version, no pin                           |
| `uniform_commit`    | ramp steps `commit:false`, final `true`        | stream, then one final set (device persists on its own schedule) |
| `list_effects`      | TODO(list_effects) hook in `effectResource`    | active effect only                                               |
| uniform docs/units  | `doc`/`min`/`max`/`unit` win over UI hints     | ranges from the slider/colour/toggle/dropdown hint               |
| .fxb version        | TODO: `bundle.json` `fxb_format` from compiler | `FXB1` (the container magic today)                               |
| mDNS `_splanc._tcp` | browse finds players                           | pass `--host`                                                    |

`commit` is sent as an extra field only when advertised; it needs the regenerated
TS proto to reach the wire (`TODO(uniform_commit)` in `session.ts`).

## Site files

The bundle carries the website's agent entry point, rendered at bundle build time
from `site/*.tmpl`, the skill and `bundle.json` (so the site can't drift from what
it installs), with `--//agent:site_base` (default `https://splanc.io`) in every URL:

```text
splanc-agent-<ver>/site/
  AGENTS.md                      install + first-contact flow + rules
  llms.txt                       llms.txt index (skill files listed)
  .well-known/mcp/server.json    MCP registry server.json shape (install in _meta)
  agent/latest.json              {version, release, url, asset, sha256: null, install, skill}
  agent/skill/**                 the bundle's skill, verbatim
  bridge/install.sh              the Raspberry Pi bridge installer (= pi-bridge/install.sh)
```

The bundle also carries `pi-bridge/`, the Raspberry Pi bridge appliance (installer,
display service, systemd units; [pi/bridge/README.md](../pi/bridge/README.md)), so
`curl -fsSL https://splanc.io/bridge/install.sh | sudo sh` installs from one
verified bundle.

The site (Studio-Fug/splanc.io, `scripts/stage-agent.mjs`) picks the newest
`firmware-v*` release carrying `splanc-agent-<ver>.tgz` + `.tgz.sha256`, verifies the
sha256, copies `site/` to its root, serves the tgz itself at the stable
`/agent/splanc-agent.tgz`, and fills `latest.json`'s `sha256` (a tgz can't contain
its own hash). `package.json` at the bundle root (bin `splanc-agent`) + the `.mjs`
shebang are what make `npx -y <tgz url>` work. `site_test` checks all of this.

## Release (bundle + firmware handoff)

`release.yaml` (firmware-v\* tags) builds
`bazel build -c opt --//agent:bundle_version=<ver> //agent:bundle` →
`splanc-agent-<ver>.tgz` + `.tgz.sha256` (reproducible: sorted tar, mtime 0,
`gzip -n`), attaches both to the release, and — because it runs BEFORE the
firmware build — exports `AGENT_BUNDLE_URL` / `AGENT_BUNDLE_SHA256` to the job.
The device side's manifest takes them as build settings:

```text
--//firmware/player_app:agent_bundle_url=$AGENT_BUNDLE_URL
--//firmware/player_app:agent_bundle_sha256=$AGENT_BUNDLE_SHA256
```

(those settings belong to the device PR; add the two flags to the flashbundle
step when it lands). No npm publish: the bundle is the distribution. A dev
build (`0.0.0-dev`) has no published bundle; point `--bundle-root` at a checkout.

## Tests

`bazel test //agent:all`: `bridge_test` (fake TLS WS player: discovery + pin,
each tool's wire behaviour, error mapping, rollback, ramp/commit, textures,
safety guard, MCP surface), `hub_test` (N fake players: registry/sweep/dedupe/
remembered, fan-out + partial failure, selectors + rooms, budget-checked deploy,
parallel ramps, poses + room view + room preview, identify, clock-offset math,
per-version toolchain from a fetched fake 9.9.9 bundle + sha256 refusal),
`fastpath_test` (handshakes per call: cold = one /ws, warm list = no TLS, warm tool =
one /ws, no mDNS/sweep with hosts, mDNS cut short, fast unreachable, TOFU pin, MCP
progress notifications),
`examples_test` (every skill example compiles and previews, non-black, animated),
`stdio_test` (the shipped `.mjs` over stdio), `cli_test` (the shipped `.mjs` as a
one-shot CLI vs two fake players), `site_test` (the bundle's site/ files and npm
packaging), `relay_test` (the relay Worker under the Node host: OAuth, pairing codes, rate
limits, revocation, the tunnel), `lanbridge_test` (status file, control socket, reconnect),
`relay_e2e_test` (MCP client -> relay -> bridge -> fake players; `SPLANC_E2E_RELAY=<url>` runs
it against `wrangler dev` or the deployed relay), `typecheck_test`.
