# What's new

Notable changes, newest first. Each entry links the PRs and the doc that covers
it in depth. The full history is in the git log and [`WORKLOG.md`](../WORKLOG.md).

## October 2026

### AI agents can drive Splanc ("Use splanc.io to set the mood of the room")

- **Agent bridge + bundle** (#274): `agent/` is an MCP server (stdio) and a
  one-shot CLI over the same tools. It is shipped as `splanc-agent-<ver>.tgz` on
  every `firmware-v*` release, along with the matching compiler and simulator
  wasm, the protocol schema and an agent skill. See
  [`agent/README.md`](../agent/README.md).
- **Multi-fixture hub** (#278): one bridge drives every player on the LAN. It
  covers:

  - mDNS browsing, remembered players and a bounded /24 manifest sweep;
  - one socket per player, with parallel fan-out and per-player results;
  - rooms, fixture poses and a shared time base;
  - per-firmware toolchains fetched from each player's own bundle.

  Design: [agent-multi-fixture.md](design/agent-multi-fixture.md).

- **Device discovery** (#276): `GET /.well-known/splanc.json` (identity,
  firmware, protocol features, `.fxb` format, TLS cert pin, agent bundle), an mDNS
  `_splanc._tcp` responder on the netstack, plus these protocol additions:
  - `Welcome.features` and `fxb_format`;
  - `set_uniforms.commit` (apply a uniform live without persisting it);
  - `list_effects`;
  - a complete `get_effect_uniforms`.
- **Uniform docs:** `doc`, `min`, `max` and `unit` are now in the effect
  manifest (from the uniform's source comment).
- **Room frame and shared time** (#280): `set_fixture_pose` / `set_time_base`,
  the `led.room` / `room.min` / `room.max` effect builtins, and a HITL test that
  measures inter-fixture skew against a 20 ms target. See
  [EFFECTS.md](../EFFECTS.md).
- **splanc.io entry point:** splanc.io serves `/AGENTS.md`, `/llms.txt`,
  `/.well-known/mcp/server.json` and the newest bundle at
  `/agent/splanc-agent.tgz`. The one-liners are:

  ```sh
  claude mcp add splanc -- npx -y https://splanc.io/agent/splanc-agent.tgz
  npx -y https://splanc.io/agent/splanc-agent.tgz list-players
  ```

- **Uniform keypoints and FX blending** _(in progress; the PR succeeds #82)_:
  named sets of uniform values stored on the device, which the app and agents
  can discover, plus blending between them on the two-deck crossfade.

### The C6 player's memory, from 1.6 KiB to ~87 KiB of worst-case headroom

Measured on the `ram_audit` HITL worst case (BLE provisioning → first wss
handshake → 512-LED map and texture effect → loaded handshakes). Detail in
[ram-budget.md](design/ram-budget.md).

- **Zero-copy envelopes** (#262): the board-capabilities reply is spliced in
  encoded form, so the firmware `ServerMessage` shrank from 4,104 B to 656 B.
  Requests dispatch in place, and task stacks are sized from a static bound
  (loopTask 48 → 20 KiB).
- **pbview** (#265): zero-copy `no_std` protobuf views (`oss/pbview`), so the
  firmware decodes every request straight from the RX frame.
- **Vendor Wi-Fi residue freed and dead SDK code moved out of IRAM** (#266):
  - ~20 KB of vendor heap freed (no lwIP task, the event loop deleted after the
    scan, no NVS mirror);
  - an `@embedded` `sections.ld` override moves cold vendor code to flash
    (`.iram0.text` 114,910 → 97,512 B).
- **Zero-copy TX** (#267): each outbound frame is built once, in place
  (loopTask 20 → 14 KiB).
- **Native pulse/flood playback removed:** every show is an FX-engine effect.
  `set_playback` accepts only `"off"`, and the render stack went from 8 to
  5 KiB. `firmware/pulse` remains for the web simulator only.
- **Static stack-bound CI gate** (#270): `//tools/stack_bound` over the shipped
  ELF's call graph fails the build when a task's bound, plus margin, outgrows its
  stack.
- **Post-boot heap census** (#271): every allocation after `setup()` is
  attributed to its call site and read over JTAG. See
  [heap-census.md](design/heap-census.md).
- **TLS region** (#272): mbedTLS allocates from its own fixed slots and private
  region, off the shared heap.
- **Unbuffered littlefs** (#273): removes a 4 KB stdio buffer per file open.
- **Memory regions and the mode model** (#263, #269): `firmware/region` (pools,
  slabs, mode unions) and `firmware/sysmode`, a reachability-checked model of
  the device's memory modes, which the firmware now tracks (log-only). See
  [memory-regions.md](design/memory-regions.md).
- **Kani under Bazel** (#264): the region proofs run as hermetic
  `rust_kani_test` targets. See [kani-bazel.md](design/kani-bazel.md).
- **PR-38**: BLE and wss coexist. Making the radios mutually exclusive is not an
  allowed memory lever.

### Tooling, HITL and releases

- **`ram_audit --hang`** (#270): catches a hard hang over JTAG before the
  watchdog erases it. RAM dumps are armed only after provisioning, because a
  ~46 s halt during the Wi-Fi join resets the board.
- **Android flashing** (#268): the USB-JTAG connect resets and reopens the
  port, and the C6 flash-ID probe is fixed.
- **splanc.io/app follows app releases** (#277): every `app-v*` tag now
  publishes `splanc-webapp-<ver>.tar.gz`, and splanc.io stages the newest one.
- **Fleet dashboards** (#279): the Android bench (amd-rig) and the iPhone bench
  (mac-mini) push metrics to Grafana, and the dashboard sync warns loudly
  instead of skipping silently.
- **Docs:** [the Splanc manifesto](manifesto.md), on why the system is built
  the way it is.
