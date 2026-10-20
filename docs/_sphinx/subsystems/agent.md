# The agent bridge (`agent/`)

Splanc can be driven by an AI agent. `agent/` is an **MCP server** (stdio) and a
**one-shot CLI** over the same tools, and both run on a hub that finds and drives
**every** Splanc player on the LAN. It ships as a self-contained npm-style tarball,
so a fresh agent needs nothing installed beyond Node.js 20 or later:

```sh
claude mcp add splanc -- npx -y https://splanc.io/agent/splanc-agent.tgz   # MCP
npx -y https://splanc.io/agent/splanc-agent.tgz list-players                 # CLI
```

Or just tell an agent with a shell: _"Use splanc.io to set the mood of the
room."_ splanc.io serves `/AGENTS.md` (install, the first-contact flow and the
rules), `/llms.txt`, `/.well-known/mcp/server.json` and the agent skill, all
rendered from the same bundle they describe.

```{mermaid}
flowchart LR
    agent["AI agent<br/>(MCP or CLI)"]
    site["splanc.io<br/>AGENTS.md · llms.txt · bundle"]
    subgraph hub["splanc-agent hub (agent/)"]
        reg["registry<br/>mDNS · remembered · /24 sweep"]
        tc["per-firmware toolchain<br/>compiler + VM wasm"]
        room["rooms · poses · time base"]
    end
    p1["player A<br/>/.well-known/splanc.json · wss"]
    p2["player B"]
    agent -. "reads" .-> site
    agent --> hub
    reg --> p1
    reg --> p2
    hub -- "effects · uniforms · pose · epoch" --> p1
    hub --> p2
```

## What the hub does

- **Discovery.** It browses `_splanc._tcp` over mDNS and remembers players it
  has seen (`~/.config/splanc/hub.json`). If neither turns anything up, it
  sweeps the local /24 for `/.well-known/splanc.json`. Players are deduplicated
  by MAC. `--host` adds players that discovery can't see.
- **Sessions.** It opens one lazily-created wss socket per player (the device
  serves one at a time), pinned to the manifest's cert SHA-256. Requests are
  serialized per player and run in parallel across players. A fan-out returns a
  result for each player, and a partial failure is never hidden.
- **Version matching.** It compiles and previews with the compiler and VM wasm
  that match each player's firmware. A player outside this bundle's range gets
  the bundle named in its own manifest, which is sha256-checked and cached.
- **Budgets.** `deploy_effect` checks every target's frame budget first (the
  app's fleet estimator) and refuses an overrun unless forced.
- **Rooms.** `set_room` / `set_fixture_pose` place fixtures in one room frame.
  Effects that read `led.room` then span the room, and `preview_effect` renders
  all fixtures in one image.
- **Shared time.** It estimates each player's clock offset (min-RTT time sync)
  and sends every player the same room epoch in its own clock
  (`set_time_base`), so identical effects stay in step. The target is under
  20 ms of skew, which the `time_base_skew` HITL test measures.
- **Saved looks.** `list_keypoints`, `save_keypoint`, `recall_keypoint`
  (`seconds` > 0 morphs), `blend_keypoints` (up to four weighted keypoints) and
  `delete_keypoint` drive the device's uniform keypoints, gated on the
  `keypoints` feature. The skill maps "save the look as a keypoint" and "morph
  between moods" onto them.
- **Performance.** `estimate_effect` runs the offline cost model and touches
  nothing; `measure_effect` reads a few seconds of the device's perf stream.
  The skill says to iterate with the first and confirm with the second.

Uniforms are addressed **by name**, with the `doc`, `min`, `max` and `unit`
that the compiler extracts from the effect's source comments. Ramps stream
uncommitted (`set_uniforms.commit=false`) and persist once at the end.

Deliberately absent: rewiring, remapping, calibration, JIT and hardware
configuration, all of which the bridge refuses at the wire. There is **no LAN
authentication**. Anyone on the network can drive the lights, and the agent's
instructions say so.

## Release and the website

- **The bundle.** `release.yaml` builds `//agent:bundle` for every
  `firmware-v*` tag as `splanc-agent-<ver>.tgz` plus `.tgz.sha256`. The
  tarball is reproducible: entries are sorted, mtimes are zero and gzip has no
  timestamp. It carries `bundle.json`, `package.json` (the `splanc-agent` bin),
  `proto/`, `mcp/`, `compiler/`, `simulator/`, `skill/` and `site/`.
- **The website.** The splanc.io repo (Studio-Fug/splanc.io) stages the newest
  release that carries a bundle. It serves the bundle at the stable
  `/agent/splanc-agent.tgz` and copies the bundle's `site/` tree to the site
  root. It runs on a schedule, and only deploys when the newest app or agent
  release has moved.

## Key files and targets

- `agent/src/hub.ts` (fan-out, rooms, time base), `registry.ts` (discovery),
  `session.ts` (wire behaviour and safety guard), `server.ts` (MCP surface) and
  `cli.ts` (MCP or CLI entry).
- `agent/skill/`: the skill the agent reads (`SKILL.md`, the effect language,
  uniforms, geometry and examples).
- `agent/site/*.tmpl`: AGENTS.md, llms.txt and server.json.

```sh
bazel test //agent:all                     # fake TLS players: bridge, hub, CLI, site, stdio
bazel build //agent:bundle                 # splanc-agent-0.0.0-dev.tgz
```

Full reference: `agent/README.md`. Design:
{doc}`../docs/design/agent-multi-fixture`.
