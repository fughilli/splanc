# splanc-agent — MCP bridge + agent bundle

Implements the bridge side of the _Splanc Agent Discovery & MCP Bundle Spec_: an
MCP server (stdio) that lets an AI agent drive ONE Splanc player over its `/ws`
protocol, plus the release bundle that ships it with the matching compiler,
simulator and skill.

```text
agent/
  src/cli.ts         entry: --host / mDNS browse -> manifest -> /ws -> MCP stdio
  src/discovery.ts   _splanc._tcp browse, GET /.well-known/splanc.json, Welcome check
  src/socket.ts      Node `ws` adapter for web/src/net/client (TLS policy + cert pin)
  src/session.ts     serialized device session: tools' wire behaviour, error mapping,
                     safety guard, rollback, MappingBundle cache, feature detection
  src/server.ts      MCP resources + tools (zod schemas)
  src/uniforms.ts    name -> slot resolution, width/range checks, ramp interpolation
  src/fxhost.ts      host compile + preview (the editor's compiler + VM wasm), PNG render
  skill/             SKILL.md, effect-language.md, uniforms-and-ui.md, geometry.md, examples/*.fx
  tests/             fake TLS player; bridge, examples, shipped-.mjs-over-stdio tests
```

The /ws client is the web app's own `LedMapperClient` (`web/src/net/client.ts`,
exposed as `//web:agent_reuse_srcs`), bundled by relative import — not a copy.

## Running it

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

Flags: `--host <name|ip[:port]>` (omit to browse mDNS and use the only player
found; `--list` prints what mDNS sees), `--pin <sha256>` (TLS pin; default: the
manifest's `tls.cert_sha256`), `--stream-hz <n>` (ramp stream rate, default 20),
`--bundle-root <dir>` (where `compiler/` + `simulator/` live; default: the bundle).

## Surface

Resources: `splanc://device`, `splanc://fixture/summary`, `splanc://fixture/map`,
`splanc://fixture/topology`, `splanc://effect/active`.

Tools: `set_brightness`, `list_uniforms`, `set_uniforms`, `ramp_uniforms`,
`compile_effect`, `preview_effect`, `deploy_effect`, `set_effect`,
`measure_effect`, `list_textures`, `stream_texture`, `stop_texture`, plus
`rollback_effect` and a confirm-gated `set_device_name`.

Deliberately absent: `set_playback` / `splanc://playback` (native pulse/flood
was removed; every show is an FX effect), and anything that sends
SetHardwareConfig, SetLedCount, SetColorCorrection, the mapping arms or SetJit —
`session.ts` refuses those at the wire (`FORBIDDEN_TYPES`, pinned by a test).

## Decisions on the spec's open questions

- **TLS.** `/ws` is TLS with the player's self-signed cert: chain verification
  is off; the cert is PINNED when a pin is known (`--pin`, else the manifest's
  `tls.cert_sha256`). A pin mismatch refuses the connection.
- **One bridge per player.** Multi-player is out of scope for v1: run one bridge
  per player. (Open: a single bridge with a `player` argument per tool, or MCP
  resources namespaced per device, once the agent UX for it is clear.)
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
safety guard, MCP surface), `examples_test` (every skill example compiles and
previews, non-black, animated), `stdio_test` (the shipped `.mjs` over stdio vs
the fake player), `typecheck_test`.
