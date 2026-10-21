# Live VJ through the bridge (and the relay)

Status: first version implemented. Bridge: `agent/src/bridge/live.ts` (multiplexer),
`liveLan.ts` (direct LAN endpoint), `lanCert.ts` (its certificate). Relay: `/live` in
`agent/relay/src/index.ts` + `bridgeObject.ts`. App: `web/src/net/liveProtocol.ts`
(the protocol, shared with the bridge), `web/src/net/bridgeLive.ts` (client),
`web/src/ui/screens/bridgeLive.ts` (the **Live via bridge** screen, `#/bridge`).
Tests: `//agent:relay_live_test`, `//agent:live_e2e_test`, `//web:bridgeLive_test`.

## Problem

A Splanc player (ESP32-C6, netstack firmware) serves **one** TLS/wss session at a time. The
app connects to one fixture directly, so a show with five fixtures means five phones, or
hopping between them. The bridge (`splanc-agent bridge`, usually the Pi appliance) already
holds one session to every player on its LAN for cloud agents. Live VJ reuses it: the app
connects to the bridge once and drives every fixture from there — from anywhere through the
cloud relay, or directly on the LAN when it can reach the bridge.

## Shape

```text
 app (PWA / iOS) ──wss /live──▶ relay Worker ─▶ BridgeObject ──(bridge's outbound ws)──┐
        │                         (pass-through, hibernatable)                          ▼
        └───────────wss://<bridge LAN IP>:8443/live (direct, preferred) ──────▶ bridge: LiveMux
                                                                                │ one /ws per player
                                                                                ▼ (shared with MCP agents)
                                                                         players on the LAN
```

The **same live protocol** runs on both paths. The relay never parses it: it
authenticates the socket, then passes each text message through verbatim, tagged with a
connection id, inside the bridge socket it already has.

## Decisions

### Transport

| | Through the relay | Direct on the LAN |
| --- | --- | --- |
| URL | `wss://splanc.pages.dev/live` (or the workers.dev / self-hosted relay) | `wss://<bridge LAN IP>:8443/live` |
| Works from | anywhere | the bridge's network |
| TLS | Cloudflare's public cert | the bridge's self-signed P-256 cert (`<state dir>/live-tls.json`, 397 days, auto-renewed) |
| Auth | relay credential (`spl_pt_…`) in the subprotocol list | LAN ticket (`spl_lt_…`) minted by the bridge over the relay |
| Billing | Durable Object messages (see budget) | none |
| App tick | 33 ms (~30 Hz) | 16 ms (~60 Hz) |

- **Why a WebSocket through the BridgeObject** rather than tunnelled HTTP like `/mcp`:
  a slider is many tiny one-way messages. Over HTTP each would be a Worker request **and** a
  DO request (100 k/day each); over a hibernatable WebSocket an incoming message costs 1/20
  of a DO request, outgoing ones are free, and the upgrade is the only Worker request.
- **Credential in the subprotocol list** (`["splanc-live.v1", "bearer.<token>"]`): browsers
  can't set headers on a WebSocket, and a query-string token ends up in logs. The server
  answers with `Sec-WebSocket-Protocol: splanc-live.v1` only.
- **Direct path and the PWA's constraints.** The app is served over https
  (`splanc.io/app`), so it may only open `wss://` (mixed content blocks `ws://`). The bridge
  therefore serves TLS with its own certificate, exactly like a player does, and the same
  trust-on-first-use step applies: a browser needs the user to open
  `https://<ip>:8443/` once and accept the certificate (the screen links it, and shows the
  SHA-256 the bridge vouched for over the relay so it can be compared). The native (iOS)
  wrapper can instead pin that SHA-256 — it comes over the authenticated relay channel
  before the LAN is ever dialed — which is strictly better than TOFU. Chrome's Local Network
  Access permission (public origin → private IP) applies here as it already does for the
  app's direct player connections.
- **Path selection.** With a stored LAN ticket the client tries direct first (3 s timeout),
  else the relay; after a relay welcome it tries direct in the background and **switches**
  (closing the relay socket, so a direct session costs the relay nothing). A browser can't
  tell "untrusted certificate" from "not on that network", so the screen says both.

### Protocol

A small JSON envelope (`web/src/net/liveProtocol.ts`), not raw `ledmapper.proto`
`ClientMessage` frames addressed to a player:

- the bridge owns the device sessions and their **single-flight reply waiters**
  (`LedMapperClient`); forwarding raw frames and replies from another client would
  race them (a fire-and-forget `set_crossfade`'s `welcome` echo can satisfy someone else's
  pending `set_brightness`);
- fan-out (`to`: ids, names, rooms, `"all"`), coalescing and arbitration are bridge-level
  ideas with no protobuf arm;
- uniforms go **by name** and are resolved per player against that player's own manifest
  (slots can differ across firmware versions);
- an allow-list by construction: there is no way to express re-flash, re-map or wiring
  (`FORBIDDEN_TYPES` stays enforced at the bridge's wire guard too);
- the relay bills per message, not per byte, so JSON costs nothing extra.

No `ledmapper.proto` change, so no field-number collisions with other branches.

| app → bridge | |
| --- | --- |
| `hello {v, client_id, name}` | first; `client_id` is stable per install (lock ownership) |
| `c {to, deck?, u?, commit?, xf?, bri?, kb?}` | continuous controls, fire-and-forget, last value wins |
| `q {id, op, to?, …}` | `players`, `effect`, `deploy`, `set_effect`, `keypoints`, `align`, `lock`, `probe`, `identify` → one `r` |
| `ping {id}` | → `pong` (app ⇄ bridge round trip) |

| bridge → app | |
| --- | --- |
| `welcome {bridge, via, lan, lan_token?, players, rooms, tick_ms}` | `lan_token` only via the relay |
| `players {players, rooms}` | pushed only when the list changed (2 s poll) |
| `r {id, ok, results[per player] \| data \| error}` | |
| `err {code, message, player?}` | a control that couldn't be applied; ≤ 1/s per (player, code) |
| `relay {bridge: offline\|online}` / `relay {error}` | from the relay itself |

Nothing acknowledges a control: acks would be billed relay messages.

### Coalescing and rate limits

- **App:** one `c` frame per tick at most, leading edge (the first move after a quiet
  tick goes at once), carrying every control that changed (all sliders, crossfade,
  brightness), last value wins. A slider's release flushes immediately with
  `commit: true` (uncommitted while dragging: no flash wear on firmware with
  `uniform_commit`). Measured in `//web:bridgeLive_test`: 50 moves in one tick → 1 frame.
- **Relay:** > 60 messages/s on one socket are dropped (with one notice per second): a
  runaway client can't burn the account's daily budget. ≤ 8 live sockets per bridge;
  messages ≤ 256 KiB (an effect's source).
- **Bridge:** per player, pending controls merge; a flush loop sends at most one frame per
  kind per 16 ms, through the player's serialized session queue (so they interleave safely
  with agents' tool calls). Uniforms are truly fire-and-forget (`set_uniforms` has no
  reply); crossfade, brightness and keypoint blends await their echo (see Protocol), which
  coalesces them naturally to one per device round trip.

### Free-tier cost (Workers Free, checked 2026-10)

DO incoming WebSocket messages bill at 20:1 as requests (100 k/day); outgoing and
auto-responses are free; duration is billed while the object is awake (128 MB × wall time,
13,000 GB-s/day); a hibernated object with open sockets costs nothing.

| Per hour of VJing via the relay | Messages in | DO requests | Duration | Share of the daily free tier |
| --- | --- | --- | --- | --- |
| Worst case: some control moving the whole hour (30 frames/s) | 108,000 | 5,400 | 450 GB-s | 5.4 % requests, 3.5 % duration |
| Typical set (controls moving ~25 % of the time, object awake throughout) | ~27,000 | ~1,350 | 450 GB-s | 1.4 % / 3.5 % |
| Connected but idle (keepalive `ping` every 25 s: auto-answered) | 0 billed | 0 | 0 (hibernated) | 0 |
| Direct LAN path | 0 | 0 | 0 | 0 |

Plus per session: 1 Worker request for the upgrade, and app pings for the latency readout
(one per 15 s: 480 messages/h → 24 DO requests). So one free account covers ~18 hours/day
of non-stop 30 Hz control (requests bind), ~28 hours/day of awake time (duration binds,
across every bridge on the account, shared with MCP traffic). Bridge → app traffic is
`players` pushes on change, query replies and rate-limited errors: negligible.

### Latency

Target: slider → LED **≤ 50 ms** direct on the LAN (a fader feels attached), **≤ 150 ms**
via the relay. Budget, via the relay:

| Stage | Direct | Via relay |
| --- | --- | --- |
| App coalescing (leading edge; else ≤ 1 tick) | 0–16 ms | 0–33 ms |
| App → bridge | LAN hop, ~2–5 ms | app → CF edge → DO (pinned near the bridge's first connect) → bridge: ≈ ½ relay RTT |
| Bridge queue (min gap per player) | 0–16 ms | 0–16 ms |
| Bridge → player wss (C6 over Wi-Fi) | ~5–20 ms | same |
| Player applies at its next frame (~60 fps) | 0–17 ms | same |

Measured: see [Measurements](#measurements).

### Auth

Pairing is exactly the agent flow: the user reads the code off the bridge's screen and the
app redeems it at `POST /pair` (`Accept: application/json`, `label` = the device name the
user typed) for a personal token `spl_pt_…` — revocable, hashed at the relay, and the
same credential works for `/mcp`. Per-client: every install has its own token (its own
grant). The relay checks it on the upgrade (a malformed one is refused by the Worker
without waking a Durable Object) and tells the bridge the grant id with `live_open`.

The LAN ticket (`spl_lt_<43>`) is minted by the bridge for the relay-authenticated client,
stored as SHA-256 in `<state dir>/live-clients.json` (mode 0600), one per `client_id`,
30-day expiry, re-minted on every relay hello. Revocation:

- **Forget this bridge** in the app → `POST /revoke` → the relay closes that grant's live
  sockets (`4003`) and sends the bridge `{"t":"revoked","grants":[…]}` → the bridge closes
  its LAN sessions of that grant and deletes their tickets;
- the bridge's **revoke-all** (display button / `bridge-ctl revoke-all`) → every live
  session ends, every ticket is deleted, even if the relay is unreachable;
- residual: the relay tells the bridge about a revocation only while the bridge is
  connected; a credential revoked while the bridge is offline from the relay keeps its LAN
  ticket until the ticket expires (30 days) or a revoke-all. Acceptable on a LAN whose
  players have no auth of their own; a follow-up can have the bridge re-validate tickets'
  grants with the relay on reconnect.

### Arbitration (multiple apps + MCP agents on one bridge)

- The bridge is the only client of each player; every writer (live apps, MCP sessions)
  goes through the player's serialized `DeviceSession` queue, so device traffic never
  interleaves mid-request.
- Default: **last writer wins** per control.
- **Show Mode lock** (`q lock {on}`, the screen's switch): the holder's commands pass;
  every other writer is refused with the holder's name — other live apps get
  `err locked`, MCP tools get a ToolError ("… is being performed live (Show Mode lock held
  by "Kevin's iPhone") …") from `DeviceSession.assertUnlocked`, which every mutating method
  calls. Reads (list, effect, perf, preview) still work. A lock outlives its holder's
  disconnect by 30 s (a phone switching from Wi-Fi to cellular reclaims it with its
  `client_id`), then releases.

- **Framerate autoscaler (FUG-82).** The bridge never flushes controls to a player faster
  than it renders (gap = max(16 ms, 1000 / its current fps)), each player in the list carries
  `fps {current, target, auto, aborted}` (changes ride the 2 s `players` push), and an
  `fps_state{aborted}` — the player parked the effect because it can't hold the floor or a
  pinned rate — is pushed to every app at once as `{"t":"fps",…}`; the screen says so and
  marks the fixture.

### Multi-fixture sync

- A deploy to more than one player runs `Hub.alignTime` afterwards (one shared effect-clock
  epoch via `set_time_base`; the reply carries `skew_bound_ms`), and **Sync clocks** does
  it on demand. Effects are time-driven, so aligned fixtures stay in phase.
- One `c` frame fans out to every selected player in the same event-loop turn; skew between
  fixtures is the difference of their bridge → player hops (LAN, a few ms), not the
  app → bridge path.

### When things drop

| Event | What happens |
| --- | --- |
| A fixture drops | Its chip greys out (`players` push within 2 s); controls for it get `err offline` (rate-limited) and are dropped, not queued; the session reconnects with backoff, and the mux re-dials a player down > 20 s. Effect state is the device's (re-cue if it rebooted blank). |
| The bridge loses the relay | The relay keeps the app's socket and tells it `bridge offline`; app messages meanwhile get the same notice. When the bridge reconnects it sends `caps`, the relay re-opens every live session, says `online`, and the app says hello again. Locks wait out the 30 s grace. |
| The bridge restarts | Same, plus in-memory locks are gone; LAN tickets persist. |
| The app loses its network | Reconnects with backoff (0.5 → 15 s), direct first if it has a ticket. |
| Relay over its daily limit | `/live` upgrades fail until 00:00 UTC; the direct path still works. |

### UI

**⋯ → Live via bridge** (`#/bridge`). Unpaired: pairing code + device name (+ relay URL
under Advanced). Paired: a status pill **"Live direct (LAN) · 12 ms"** / **"Live via relay ·
95 ms"** / **"Bridge offline"** (tap = latency probe: app ⇄ bridge and bridge ⇄ each
fixture); when on the relay with a LAN endpoint advertised, a line offering "trust the
bridge once" + **Go direct** with the certificate fingerprint; fixture chips (All, rooms,
each fixture; grey = not connected, 🔒 = locked); brightness; effect picker with **Cue A /
Cue B**; crossfader + HSV switch; "sliders edit deck B"; Show Mode lock; Sync clocks /
Identify / Latency; the uniforms shared by every selected fixture's active effect (sliders,
toggles, colours) and its keypoint pads; **Forget this bridge**.

The existing direct-to-device screens (Show Mode, the editor) are unchanged; when a fixture
is held by the bridge, the app's own direct connection to it can't get a session — use the
bridge screen.

## Relay changes (backward compatible)

- `GET /live` (+ forwarded by `web/_worker.js` `RELAY_PATHS` on splanc.pages.dev).
- `BridgeObject`: app sockets tagged `app` / `app:<id>` with attachment `{app, fam, label}`;
  new frames `live_open`, `live`, `live_close`, `revoked` (relay → bridge) and `caps`,
  `live`, `live_close` (bridge → relay). An older bridge never sends `caps`, so `/live`
  answers `501 bridge_outdated` and nothing else changes for it; an older relay never sends
  live frames to a newer bridge. No storage schema change, no DO migration.

## Measurements

`//agent:live_e2e_test` with `SPLANC_E2E_RELAY` = a throwaway deployment of this Worker
(`splanc-relay-vjtest.*.workers.dev`, i.e. real Cloudflare + workerd; app and bridge both in
one dev container in the US, fake players on loopback), 20 samples each, 2026-10-21:

| Path | App ⇄ bridge ping p50 / p95 | Slider → player receives `set_uniforms` p50 / p95 |
| --- | --- | --- |
| Via the relay | 48 / 78 ms | 24 / 43 ms |
| Direct (LAN endpoint) | 0.4 / 1.5 ms | 1.0 / 1.9 ms |

On hardware (`//pi/hitl/harness:live_bridge`, rig-2 DUT c6-fa0324, netstack firmware
1.8.2-6, throwaway bridge in the dev container reaching the DUT through the rig's ssh tunnel
over the tailnet, so the bridge → C6 hop is longer than a real LAN's), 30 samples each:

| Path | App ⇄ bridge ping p50 / p95 | App → bridge → C6 → back (probe) p50 | Bridge ⇄ C6 RTT p50 / p95 | Est. slider → device |
| --- | --- | --- | --- | --- |
| Via the relay | 31 / 54 ms | 62 ms | 23 / 32 ms | ~27 ms (+ ≤ 17 ms to the next frame) |
| Direct (LAN endpoint) | 0.1 / 0.3 ms | 20 ms | 18 / 22 ms | ~9 ms (+ ≤ 17 ms) |

Also on hardware: deploy through the bridge (compiled by it, 373 B bytecode), a colour
uniform set from the live client read back off the device and off the LED wire (logic
analyzer: green), a 300-move slider burst at 100 Hz → 92 frames at the client's 33 ms tick,
ending on the final value, brightness, and `align` (time base applied, skew bound 7.7 ms).

So the relay adds ≈ ½ its round trip (~24 ms one way here) on top of the LAN path; the
bridge's own overhead (parse, coalesce, resolve the uniform, queue, encode) is ~1 ms.
Add the real bridge → C6 hop and the player's frame (the hardware rows) for
slider → LED. Both targets hold with margin: ~10–35 ms direct, ~35–80 ms via the relay.

Coalescing (same test): a 200-move burst over ~100 ms became ≤ 10 app frames and as many
`set_uniforms` per player, ending on the final value.

## Not done yet / follow-ups

- Show Mode (the direct-to-device screen) and MIDI mapping on top of the bridge client.
- iOS wrapper: pin the bridge certificate's SHA-256 in the native socket (the value is
  already delivered over the relay).
- Texture streaming and the effect-editor's live preview through the bridge.
