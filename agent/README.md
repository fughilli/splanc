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
  src/registry.ts    discovery: --host, remembered, mDNS, bounded /24 manifest sweep; dedupe by MAC
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
adds players discovery can't see; `--no-mdns` skips browsing.

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
(TLS pin; default: the manifest's `tls.cert_sha256`), `--stream-hz <n>` (ramp stream rate, default 20),
`--bundle-root <dir>` (where `compiler/` + `simulator/` live; default: the bundle).

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
model, touches nothing), `measure_effect` (windowed on-device perf stream),
`list_textures`, `stream_texture`, `stop_texture`, the uniform keypoint tools
`list_keypoints` / `save_keypoint` / `recall_keypoint` / `blend_keypoints` /
`delete_keypoint` (feature `keypoints`; design
[uniform-keypoints.md](../docs/design/uniform-keypoints.md)), `export_map`
(the stored map as TouchDesigner CSV or a Chromatik `.lxf`, same serializer as
the app's Export map; see the user guide), a confirm-gated
`set_device_name` (one player).
Hub tools: `list_players`, `refresh_players` (`sweep`), `add_player`,
`forget_player`, `identify_player` (blinks), `set_room`, `set_fixture_pose`,
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
`session.ts` refuses those at the wire (`FORBIDDEN_TYPES`, pinned by a test).

## Decisions on the spec's open questions

- **TLS.** `/ws` is TLS with the player's self-signed cert: chain verification
  is off; the cert is PINNED when a pin is known (`--pin`, else the manifest's
  `tls.cert_sha256`). A pin mismatch refuses the connection.
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
- **No LAN auth.** The player has none and the bridge doesn't invent one; anyone
  on the LAN can drive it. Documented in the skill too.
- **Stream rate.** Ramps stream uncommitted at `--stream-hz` (default 20, capped
  at 60). TODO: cap by the measured frame rate once `perf` exposes it per player.

## Feature detection (pending the device-side PR)

Features come from `Welcome.features` merged with the manifest's
`protocol.features`; everything below falls back on today's firmware:

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
```

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
`examples_test` (every skill example compiles and previews, non-black, animated),
`stdio_test` (the shipped `.mjs` over stdio), `cli_test` (the shipped `.mjs` as a
one-shot CLI vs two fake players), `site_test` (the bundle's site/ files and npm
packaging), `typecheck_test`.
