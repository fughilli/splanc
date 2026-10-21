# What's new

Notable changes, newest first. Each entry links the PRs and the doc that covers
it in depth. The full history is in the git log and [`WORKLOG.md`](../WORKLOG.md).

## October 2026

### The bridge follows players that come back on a new IP

- **Players are tracked by device id, not by address.** Players that pick a new
  Wi-Fi MAC on every boot get a new IP each time. A bridge that keeps running
  now finds such a player again by itself, through mDNS or a LAN sweep for its
  manifest, and moves it to the new address. You don't need to call
  `add_player`. If you call `add_player` with a known player's new address, that
  player is updated, and its stale old address is dropped. A different
  certificate under a known id is reported as TLS CHANGED.
- **Dead sessions are noticed.** Every player session has a heartbeat. A player
  that vanished fails the call within seconds, with the reason, instead of hanging.
  `list_players` shows each session's state and when the player was last heard.
- **Errors name the cause.** Tool calls the relay or bridge can't complete come
  back as tool errors with the reason (bridge disconnected, offline, timed out,
  `ECONNREFUSED`, a stale PERMANENT ARP entry on the bridge…). Before, MCP clients
  showed only "MCP tool call failed".

### Agents crossfade between effects, and look at your fixtures in 3D

- **`crossfade_to`** fades from the running effect to a new one (its source, or an effects-library
  entry by `library_id`) instead of cutting. The bridge
  loads the new effect onto the player's idle FX deck (the second deck Show Mode uses), then
  glides the crossfade over the seconds you ask for, with a choice of curve (`ease` by default)
  and RGB or HSV blending. With several players or a room, every player fades on one clock, and
  the effects share one time base, so the room changes together.
- **Rollback keeps working.** The effect you faded away from stays loaded on its deck, even
  one the app put there, so `rollback_effect` fades straight back to it (call it again to swap
  forward). `list_decks` shows what is on decks A and B, where the crossfade sits, and which
  deck is live. Uniform and keypoint tools follow the live deck.
- **Deck B is runtime-only**: if a crossfade ends on it, a reboot brings back deck A's effect.
  `deploy_effect` still makes an effect permanent. Both effects render while the fade runs, and
  they share the 24 KB buffer arena, so a too-large pair is refused with that explanation.
- **`plot_fixture`** returns a PNG of a fixture's LED map from the front, side, top and an
  isometric view. It shows metres with +Y up, axes, the bounding box, the wiring order, LED index
  hints and a scale bar. Mapped LEDs are dots and interpolated ones are rings. You can colour the
  LEDs by index, solve confidence, segment, channel or one frame of an effect. A room plots every
  fixture at its pose in one scene. The numbers (mapped vs interpolated, bounds) come with it.
  The image is drawn in plain TypeScript, so it works on the Pi bridge, and stays small enough
  for the cloud relay. The CLI has `crossfade-to`, `list-decks` and `plot-fixture --out <dir>`.

### An effects library that grows with every scene

- **Agents look before they write.** Each installation now keeps a private
  library of effects that worked before: what each looks like, its tags and its
  knobs. Asked for a new scene or mood, the agent searches it first
  (`search_effects`), deploys a match in one call (`deploy_effect {library_id}`)
  or copies and adapts a close one (`duplicate_effect`), and only writes a new
  effect when nothing fits.
- **It fills itself.** Every successful deploy is kept, with its description,
  tags and measured frame cost; the agent is asked to describe any it deployed
  without one. New libraries start with Splanc's example effects.
- **Served by the cloud relay**, so it's fast and still browsable while the
  bridge is off. Without the relay (a local agent over stdio or the CLI) the same
  tools keep it in a file in the agent's state dir. Nothing is shared between
  users. Design: [cloud-relay.md § Effects library](design/cloud-relay.md#effects-library);
  how to use it: [cloud-agent.md](guides/cloud-agent.md#effects-library).

### Splanc works as a ChatGPT plugin

- **Add `https://splanc.pages.dev/mcp`** in ChatGPT as a custom MCP server with OAuth, sign in
  with your bridge's pairing code, and ChatGPT drives your lights. Steps:
  [cloud-agent.md](guides/cloud-agent.md#chatgpt).
- **Every agent tool says what it does**: read-only tools (listing, previews, compiling) run
  without a confirmation prompt in ChatGPT; tools that change the lights ask first, and deleting
  or overwriting your saved things is flagged as destructive. The server also gives agents a
  short "how to use Splanc" note.
- **The relay** advertises `offline_access`, so ChatGPT keeps its sign-in, accepts ChatGPT's
  client metadata document, and ignores scopes it doesn't use (like `openid`) instead of failing.

### Show the Wi-Fi password while you type it

- **An eye button** at the right end of the Wi-Fi password field in the
  add-device sheet shows the password in cleartext, and taps back to hidden.
  It starts hidden, keeps the keyboard open and the cursor where it was, and
  picking a saved network keeps your choice. Phone keyboards no longer
  autocorrect or capitalize the field, and password managers leave it alone.
- **The same button** is on the API key fields in AI settings and on the Splanc
  Bridge Flasher's Wi-Fi password (which had a text "Show" button).

### Every player has its own TLS certificate

Netstack firmware used to serve one shared certificate, and its private key was in
the open-source tree, so any device could be impersonated. Now each player
generates its own EC P-256 key and self-signed certificate on first boot. It keeps
them in littlefs (power-loss-safe) for life: there's no IP in the cert, so DHCP
changes don't rotate it. Only a factory reset (flash erase) makes a new one.
Design, the vendor build's re-issue races it avoids, and the measured cost:
[per-device-cert.md](design/per-device-cert.md).

- **Never serves without a cert.** Generation runs in `setup()` before WiFi
  comes up, and `:443` opens only once the identity is installed. Until then mDNS
  advertises `tls=generating` and the new `get_tls_info` (over BLE too) reports
  `generating`.
- **Trust on first use.**
  - The agent bridge pins each player's certificate by id in `hub.json`. A
    changed certificate is refused (`tls: CHANGED`) until `trust_player`.
  - The app remembers each device's certificate and warns in the device sheet,
    with an "I reset it — trust the new certificate" action.
- **Upgrades are quiet.** A device moving off the old shared certificate is
  re-pinned without a warning.
- **The manifest's `tls` block** now carries `state` and `persisted`.

### Export a map to TouchDesigner or Chromatik

- **Export map** in the mapping workspace downloads the fixture's LED positions,
  one entry per LED in output order. Two formats:

  - a **CSV** laid out as a TouchDesigner Points DAT
    (`index,P(0),P(1),P(2),mapped,confidence,channel,channel_index,segment,arclength`,
    metres, +Y up). Load it in a Table DAT and feed a DAT to SOP, no editing.
  - a **Chromatik `.lxf`** fixture (`points` components per channel, with a
    `Scale` parameter that defaults to centimetres).

  Unmapped LEDs keep their index with `mapped=0` and an interpolated position.
  A Z-up option covers Blender-style tools. On iOS the file goes through the
  share sheet ("Save to Files"). Agents get the same files from the bridge's
  `export_map` tool / `splanc-agent export-map`. See
  [the user guide](user-guide.md#exporting-a-map-to-other-software).

### Splanc bridge SD image + Splanc Bridge Flasher (no terminal)

- **Splanc Bridge Flasher** (macOS, Windows, Linux): a desktop app that writes
  a Splanc bridge microSD card. Pick the Pi model, type the Wi-Fi name and
  password (plus the Wi-Fi country and, optionally, a name for the Pi), pick
  the card. It downloads the newest image, checks its sha256, writes the card,
  reads it back to check every byte, and puts the Wi-Fi settings on it. Boot
  the Pi and the pairing code is on its HDMI screen or OLED HAT. Only removable
  disks are ever offered. Guide:
  [Set up a Splanc bridge on a Raspberry Pi](pi-bridge.md).
- **Splanc bridge SD image** for the Pi 5, Pi 4, Pi 3 and Zero 2 W: a small
  NixOS system that runs the bridge and the screens from power-on, with no
  login. It applies the flasher's settings at boot (and moves the Wi-Fi
  password off the card), and updates the Splanc agent by itself
  (sha256-checked, from splanc.io/agent/latest.json).
- **Own release track:** `pi-bridge-v*` releases carry the images
  (`splanc-bridge-<board>-<ver>.img.zst` + `.sha256`) and the flasher
  installers, built by `.github/workflows/pi-bridge-image.yml`, separate from
  `firmware-v*` and `app-v*`. Details:
  [pi/bridge/README.md](../pi/bridge/README.md).
- The `curl … | sudo sh` installer below stays, for Raspberry Pi OS installs you
  manage yourself.

### A Raspberry Pi as a Splanc bridge

- **One-command Pi bridge appliance:** flash Raspberry Pi OS Lite with Imager
  (Wi-Fi and SSH preset), boot, then run
  `curl -fsSL https://splanc.io/bridge/install.sh | sudo sh`. The Pi runs the
  Splanc cloud bridge headless and starts it on every boot. It updates itself
  daily, checking each release's sha256. Guide:
  [Set up a Splanc bridge on a Raspberry Pi](pi-bridge.md).
- **Status screens:** a full-screen HDMI page (no desktop needed) shows the
  pairing code, a QR code, the fixtures, the clients and the network. A Waveshare
  1.3" OLED HAT shows pages of the same information. Its keys work as follows:
  KEY1 gets a new code, KEY2 identifies fixtures, and holding KEY3 then
  confirming revokes all clients. The joystick pages through the screens.
- **Built in:** the installer and display service live in `pi/bridge/` and ship
  inside the agent bundle (`pi-bridge/`, plus `site/bridge/install.sh`). Details:
  [pi/bridge/README.md](../pi/bridge/README.md).

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

- **Keypoint tools for agents** (#286): `list_keypoints`, `save_keypoint`,
  `recall_keypoint`, `blend_keypoints` and `delete_keypoint`, plus each
  player's keypoints in `splanc://effect/active`. The skill maps "save the look
  as a keypoint" and "morph between moods" onto them. They are gated on the
  `keypoints` feature (see below).

### Saved looks: uniform keypoints, two decks and a crossfade

Supersedes #82 (FUG-110). Design:
[uniform-keypoints.md](design/uniform-keypoints.md).

- **Keypoints** (#285): a keypoint is a named set of uniform values for one
  effect, a known-good position in its parameter space ("dawn", "storm"). They
  are stored on the device in littlefs (power-loss-safe, at most 16 per
  effect), so the app, Show Mode and agents all see the same set. Values are
  stored by uniform name, and a keypoint saved against an older build of the
  effect is flagged `stale`.
- **Morphing on the device:** recall a keypoint over N seconds, or blend up to
  four with weights. The device eases the uniforms itself, once per frame, using
  each uniform's manifest rule (sliders interpolate and clamp to `min`/`max`,
  colours blend in linear RGB or HSV, toggles and dropdowns take the nearest
  source). A live blend never writes flash; saving the blended look is explicit.
- **Two decks + crossfade:** the player runs deck A and deck B at once and
  crossfades their per-LED output (linear RGB or HSV). Deck B shares one memory
  region with the video-texture delta buffer, so **loading deck B ends a video
  stream** on that player. Deck B is interpreted (no JIT) and is not restored
  after a reboot.
- **In the app:** the effect editor and each Show Mode deck (`/show`, from the
  Effects ⋯ menu) carry a keypoint strip: tap a pad to recall it, "＋ Save" to
  store the live uniforms, a morph fader to slide between two pads, long-press
  or right-click to delete. Show Mode's MIDI layer can map the crossfade, blend
  mode, per-deck play/pause and cue, each deck's keypoint morph fader, and
  next / previous / save keypoint.
- **Wire:** `set_crossfade` = 39 and the keypoint arms 40–44 (replies
  `keypoint_list` = 22, `keypoint` = 23), a `deck` field on the effect messages,
  and the `decks`, `crossfade` and `keypoints` features. The full table is in
  [uniform-keypoints.md](design/uniform-keypoints.md#wire-ledmapperv1-additive).
- **Cost:** +6.5 KB of static RAM, and the per-LED shade entry pinned back in
  IRAM (`.iram0.text` 97,512 → 99,704 B). With both decks and a wss session the
  `fx_keypoints` HITL run measured a 72.7 KB minimum free heap. The `sweep16`
  fx_bench golden was re-baselined (42,589 → 50,259 cycles) on evidence that the
  remaining gap is flash-cache layout, not added work; the evidence is on #285.

### Effect authoring: measure on the fixture, not just in the model

- **`measure_on_device`** (#292): the editor's and Acid Mode's AI chat can run
  the current script on the connected fixture with full perf reporting and read
  a few seconds of the device's perf stream (mean / p95 / max frame time, the
  update / shade / show split, budget fraction), next to the offline
  `estimate_performance`. The agent iterates offline and confirms on the device
  before calling a performance goal met; when they disagree it optimizes
  against the measurement. The tool is offered only while a fixture with the
  `perf` feature is connected, and never in the website demo.
- **The hub gained the same pair:** `estimate_effect` (offline, touches nothing)
  and `measure_effect` (windowed on-device stream, now in milliseconds).

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
- **Exact-size topology decode** (#291): a topology upload is decoded in two
  passes (count, then fill exactly), with every polyline in one shared vertex
  array, and the topology arena grew from 8 to 12 KB. A scan needs
  16·J + 24·S + 12·V bytes for J junctions, S segments and V vertices: a
  462-LED scan with 27 / 51 / 206 now takes 4,128 B (it overflowed 8 KB before),
  leaving room for ~880 vertices at that junction and segment count. Beyond
  that the upload fails with `map_too_large`.
- **Memory regions and the mode model** (#263, #269): `firmware/region` (pools,
  slabs, mode unions) and `firmware/sysmode`, a reachability-checked model of
  the device's memory modes, which the firmware now tracks (log-only). See
  [memory-regions.md](design/memory-regions.md).
- **Kani under Bazel** (#264): the region proofs run as hermetic
  `rust_kani_test` targets. See [kani-bazel.md](design/kani-bazel.md).
- **PR-38**: BLE and wss coexist. Making the radios mutually exclusive is not an
  allowed memory lever.

### Tooling, HITL and releases

- **The netstack answers `ping`** (#302): ICMP echo requests to the player's own
  IP get a reply, rate-limited to 10/s (burst 5) so a flood can't starve the
  LEDs or TLS. Broadcast/multicast pings and fragments are ignored; up to 1472
  data bytes (one 1500-byte MTU packet) are echoed.
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
- **Release stamps the agent bundle** (#293): `release.yaml` passes the
  bundle's URL and sha256 into the firmware build, so a released device's
  `/.well-known/splanc.json` names its bundle with a hash.
- **`ffi_test` is one `#[test]` again** (#294): the FFI state is
  process-global, and a second test raced it on the harness's threads.
- **Docs:** [the Splanc manifesto](manifesto.md), on why the system is built
  the way it is.
