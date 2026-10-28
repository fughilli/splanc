# Cloud relay + LAN bridge

Status: implemented (relay Worker `agent/relay/`, bridge `agent/src/bridge/`, Node host
`agent/src/relayHost.ts`). Tests: `//agent:relay_test`, `//agent:lanbridge_test`,
`//agent:relay_e2e_test`.

## Problem

Hosted agents (claude.ai, ChatGPT, Claude Code on the web, other cloud agent products) run in
someone else's datacenter. They can't see the user's LAN, so they can't reach a Splanc player,
and they can't run `splanc-agent` next to it. The player can't be exposed directly either: it
serves a self-signed certificate, it has no auth on its LAN socket, and it sits behind NAT.

The relay lets such an agent add Splanc as a **remote MCP server** (a "custom connector") and
drive the user's fixtures, with no inbound ports, no port forwarding, no account, and no
hosting bill.

## Shape

```text
 cloud agent ──HTTPS (MCP Streamable HTTP, Bearer token)──▶ relay (Cloudflare Worker)
                                                              │  one Durable Object per bridge
                                                              ▼
                              bridge's OUTBOUND WebSocket (wss, signed with its Ed25519 key)
                                                              │
                                                              ▼
 bridge (Raspberry Pi or any LAN host: `splanc-agent bridge`)
   └─ the hub (agent/src/hub.ts: discovery, one TLS /ws session per player, pinned certs)
        └─ Splanc players on the LAN
```

- **Bridge** (`splanc-agent bridge [--relay <url>]`; the relay defaults to `$SPLANC_RELAY`, then
  the built-in `DEFAULT_RELAY_URL` in `agent/src/bridge/relayLink.ts`, which is set to the
  deployed Worker's URL, `https://splanc.pages.dev`; with none configured the bridge stays up with `state: "error"`): the
  existing hub plus `LanBridge`. Its identity lives in `$SPLANC_BRIDGE_STATE_DIR`, else systemd's
  `$STATE_DIRECTORY`, else `~/.local/state/splanc`. The Pi appliance (`pi/bridge/`) runs it from
  `splanc-bridge.service` with `/etc/splanc-bridge/bridge.env`. It keeps
  one outbound WebSocket to the relay (`RelayLink`: register once, connect with a signed
  timestamp, reconnect with capped exponential backoff and jitter, liveness pings). Each HTTP
  request the relay tunnels is handed to the MCP SDK's own Streamable HTTP server transport
  (`WebStandardStreamableHTTPServerTransport`), one transport + `McpServer` per MCP session, all
  sharing one `Hub`, so the device rule "one socket per player" holds no matter how many cloud
  sessions there are. TLS to the players and certificate pinning stay on the LAN. Like the stdio
  server, it discovers and opens every player's session in the background at startup
  (`Hub.warm`), so a cloud agent's first call finds them open, and tools' progress
  notifications and log messages go to the calling cloud session. Players are remembered in
  `$SPLANC_CONFIG_DIR/hub.json` (default `~/.config/splanc/hub.json`): under systemd, point it
  at the unit's `StateDirectory` so a headless restart reconnects without rediscovery.
- **Relay** (`agent/relay/src`): a Worker (thin router; the free plan gives it 10 ms CPU per
  request) and two SQLite-backed Durable Object classes:
  - `BridgeObject`, one per bridge (named by bridge id): the bridge's public key, its one
    WebSocket (Hibernation API), its credentials (hashed), and the tunnel.
  - `Directory`, one global instance: pairing code → bridge, rate-limit counters, and the HMAC
    key for stateless OAuth client ids. It is touched on pairing and OAuth steps only, never on
    MCP calls.
- The relay **stores no device secrets** and sees only MCP traffic: it forwards JSON-RPC bodies
  without interpreting them (except the few messages the [effects library](#effects-library)
  needs), and a client's relay credential is never passed to the bridge.

Why a tunnel of HTTP rather than relaying JSON-RPC messages: the MCP transport (sessions,
protocol-version headers, JSON vs SSE replies, error codes) is implemented once, by the SDK, on
the bridge. When MCP revises the transport again (2026-07-28 dropped sessions and the GET
stream), upgrading the bridge's SDK is enough; the relay doesn't change.

## The relay's HTTP surface

| Path | Purpose |
| --- | --- |
| `POST /mcp`, `DELETE /mcp` | The MCP endpoint (Streamable HTTP). The bearer token names the bridge. |
| `GET /mcp` | `405` (no standalone SSE stream: it would keep a Durable Object awake). |
| `/.well-known/oauth-protected-resource[/mcp]` | RFC 9728 metadata: resource `<relay>/mcp`, AS `<relay>`. |
| `/.well-known/oauth-authorization-server` | RFC 8414 metadata (also at `openid-configuration`). |
| `POST /register` | RFC 7591 dynamic client registration (stateless, HMAC-signed client id). |
| `GET/POST /authorize` | Consent page: "enter the code on your bridge's screen". |
| `POST /token` | `authorization_code` (PKCE S256 required) and `refresh_token` grants. |
| `POST /revoke` | RFC 7009: revokes the token's whole grant. |
| `GET/POST /pair` | Pairing code → a personal bearer token, for clients that take a header. |
| `POST /bridge/register` | `{public_key, ts, sig}` → `{bridge_id}`. |
| `GET /bridge/connect?id=` | The bridge's WebSocket upgrade (header `x-splanc-bridge-auth`). |
| `GET /live` | An app's live (VJ) WebSocket, bearer token in the subprotocol list, passed through to the bridge ([live-vj-relay.md](live-vj-relay.md)). |
| `POST /bugs` | An agent files a bug on the Splanc repo with the Worker's `GITHUB_ISSUES_TOKEN` secret; per-bridge / per-IP rate limits; `503 not_configured` without the secret ([agent-bug-reports.md](agent-bug-reports.md)). |
| `GET /healthz` | `{"ok":true}`. |

`/mcp` answers `401` with `WWW-Authenticate: Bearer resource_metadata="<relay>/.well-known/
oauth-protected-resource/mcp"` when there's no valid token; a malformed or missing token is
refused by the Worker itself, without waking a Durable Object. A browser `Origin` that isn't
https (or local) is refused with `403`; bearer tokens aren't ambient credentials, so no
allow-list is needed beyond that. CORS is open so browser-based MCP clients work.

## Bridge socket protocol

`agent/relay/src/protocol.ts` (shared by both sides). One JSON object per WebSocket text message.

Connect: `GET <relay>/bridge/connect?id=<bridge_id>` with header
`x-splanc-bridge-auth: <unix seconds>.<b64url Ed25519 sig of "splanc-bridge-connect\n<id>\n<ts>">`.
The timestamp must be within ±300 s of the relay's clock. Refusals happen before the upgrade:
`404` = unknown bridge (the bridge registers again), `401` = bad or stale signature. A newer
connection for the same bridge replaces the older one (closed with `4001`). A bridge that hears
`4001` knows another live process holds its identity (a half-open old socket of its own would
never hear the close), so it backs off 5 min doubling to 1 h instead of 1 s: two copies of one
`bridge.json` would otherwise evict each other about once a second, a billed connect each time
(~80 k requests/day).

Registration: `POST /bridge/register {public_key, ts, sig}` where `public_key` is the raw 32-byte
Ed25519 key (base64url) and `sig` signs `"splanc-bridge-register\n<public_key>\n<ts>"` (proof of
possession). The relay picks a random 20-character base32 bridge id.

| Direction | Frame | Meaning |
| --- | --- | --- |
| relay → bridge | `{"t":"hello","v":1,"bridge_id","relay","mcp_url","credentials","pairing"}` | Sent on connect. |
| relay → bridge | `{"t":"state","credentials","pairing","reason"}` | Credentials or pairing changed. |
| relay → bridge | `{"t":"req","id","method","headers","body"}` | One tunnelled HTTP request. |
| relay → bridge | `{"t":"cancel","id"}` | The client went away (or the 10 min timeout hit). |
| relay → bridge | `{"t":"error","for","message"}` | A bridge request failed (e.g. `new_code` rate-limited). |
| bridge → relay | `{"t":"res","id","status","headers","body","end":true}` | A whole reply in ONE message. |
| bridge → relay | `{"t":"res",...}` then `{"t":"chunk","id","data"}`… `{"t":"end","id"}` | A streamed (SSE) reply. |
| bridge → relay | `{"t":"new_code"}` / `{"t":"revoke_all"}` | Pairing control from the bridge's local API. |
| bridge → relay | `ping` (plain text) | Liveness fallback; auto-answered `pong` without waking the object. |
| bridge → relay | `{"t":"caps","live":1}` | After `hello`: this bridge speaks the live protocol (else `/live` answers `501`). |
| both | `{"t":"live","c","d"}` / `{"t":"live_close","c",…}` | One live-protocol message for app connection `c`, verbatim / its end ([live-vj-relay.md](live-vj-relay.md)). |
| relay → bridge | `{"t":"live_open","c","label","grant"}` / `{"t":"revoked","grants"}` | An app opened a live session (re-sent after a reconnect) / these grants were revoked. |

Tunnelled request headers: `accept`, `content-type`, `last-event-id`, `mcp-session-id`,
`mcp-protocol-version`, `mcp-method`, `mcp-name`, `mcp-param-*`. `Authorization` is never
forwarded (no token passthrough). Response headers back: `content-type`, `mcp-session-id`,
`mcp-protocol-version`, `allow`, `cache-control`. The bridge's transport answers with SSE, so
progress notifications and log messages from long tools reach the cloud client as they happen.
Incoming messages are what the Durable Object is billed for, so the bridge coalesces: a reply
whose stream ends within 400 ms (most of them) goes out as ONE `res` frame with the whole SSE
body; a slower one switches to `res` + `chunk`s + `end`, forwarded live (the relay sets
`x-accel-buffering: no`). Request bodies are capped at 4 MiB; at most 32 requests in flight per
bridge. When the bridge drops (or the 10 min timeout hits) with requests in flight, a reply not
started yet gets a `502`/`504` JSON-RPC error; a streamed reply already under way gets one last
SSE event, a JSON-RPC error for each request id in its body, and ends, so the client fails the
call at once instead of waiting out its own timeout.

Session ids are the SDK's: an unknown `mcp-session-id` (the bridge restarted) gets `404`, and
the client initializes again, as the spec says. Sessions idle for 30 min are closed.

Liveness: the bridge sends a WebSocket protocol ping every 30 s (free: answered by the runtime);
if nothing has come back for 60 s it also sends the text `ping` (auto-response, answered without
waking the object); after 90 s of silence it reconnects. Backoff: 1 s doubling to 60 s, ±20 %
jitter, reset by a successful `hello`.

## Pairing

Bridges pair headlessly with a short code shown on the bridge's display.

- **Code**: 8 symbols from a 32-symbol alphabet without `0 O 1 I` (40 bits), shown as
  `ABCD-EFGH`, valid 10 minutes, single use, one live code per bridge (a new code replaces the
  old). Input is case- and separator-insensitive.
- **When codes appear**: an unpaired bridge asks for a code by itself as soon as it connects and
  again when one expires, for its first hour of uptime; after that (or once paired, or once a
  code has been redeemed) a code comes only on request: the display's button, or
  `splanc-agent bridge-ctl new-code`. (Redeeming clears the code a moment before the credential
  exists; a bridge that asked again in that gap would end up paired and still showing a code.)
- **Redeeming**, either way:
  1. **OAuth connector (preferred)**. The user adds `<relay>/mcp` as a custom connector. The
     client discovers the authorization server (RFC 9728 → RFC 8414), registers (Client ID
     Metadata Document, or dynamic registration), and opens `/authorize`. The consent page shows
     the client's name and where it will redirect, and asks for the code. The code identifies
     the bridge; the relay issues an authorization code bound to the client, redirect URI,
     PKCE challenge and resource, and the client exchanges it at `/token`. No account, no
     password, nothing to copy.
  2. **Bearer token** for clients that only take headers: `/pair` (code → `spl_pt_…`), shown
     once, never expires, revocable. With `Accept: application/json` it answers
     `{token, mcp_url}`, and errors as `{error, error_description}` (`invalid_request`,
     `invalid_grant`, `slow_down`).
- **Tokens**: `spl_<kind>_<bridge id>_<43-char secret>`; kinds `at` (access, 24 h), `rt`
  (refresh, 90 days, rotated on every use), `pt` (personal), `ac` (authorization code, 5 min,
  single use). The relay stores only `SHA-256(secret)`. The bridge id in the token routes the
  request to the right Durable Object; the hash is checked there.
- **Refresh reuse detection**: a rotated-out refresh token is remembered (as a hash); if it is
  ever presented again, the whole grant is revoked (someone holds a copy).
- **Revocation**: `POST /revoke` (one grant), or `revoke_all` from the bridge (every credential
  for that bridge; the display's "revoke all" button). Live MCP sessions on the bridge are
  dropped too.

Client registration is stateless: a DCR client id is
`dcr.<b64url {redirect_uris, name, auth method}>.<HMAC>`; a confidential client's secret is an
HMAC of its id. Registration spam costs no storage. A `client_id` that is an https URL is
treated as a Client ID Metadata Document: fetched (≤ 16 KiB, 5 s, no redirects, cached 5 min),
it must name itself and list the redirect URI. Redirect URIs must be https or loopback http
(any port on loopback, RFC 8252).

## Display contract (fixed; the Pi/display image codes against it)

The bridge writes the status file **atomically** (temp file in the same directory + rename):

- path `/run/splanc-bridge/status.json`, overridable with `SPLANC_BRIDGE_STATUS` (or
  `--status`); when the default directory isn't writable (not running as a service), the bridge
  falls back to `$XDG_RUNTIME_DIR/splanc-bridge/status.json` and logs it;
- rewritten on every change and at least every 30 s (`updated_at` is a heartbeat: a display
  can treat a status older than ~90 s as "bridge not running").

```json
{"v":1,"state":"starting|offline|unpaired|pairing|paired|error","relay":"<url>","bridge_id":"…",
 "pairing":{"code":"ABCD-EFGH","expires_at":<unix s>,"url":"<redeem url>"}|null,
 "clients":<int connected cloud sessions>,"players":[{"name":"…","host":"…","ok":true, …details}],
 "lan_ip":"…","error":"…"|null,"updated_at":<unix s>}
```

| Field | Meaning |
| --- | --- |
| `state` | `starting`: first connection attempt in progress. `offline`: relay not reachable (or the bridge stopped; see `error`). `unpaired`: connected, no credentials, no live code. `pairing`: a live code is in `pairing`. `paired`: connected, at least one credential. `error`: fatal, see `error`. |
| `relay` | The relay URL the bridge was started with. The MCP endpoint is `<relay>/mcp`. |
| `bridge_id` | Assigned by the relay; `""` before registration. |
| `pairing` | Only while connected and unexpired. `url` is `<relay>/pair?code=<code>` (good for a QR code). |
| `clients` | MCP sessions active in the last 10 minutes. |
| `players` | Every player the hub knows; `ok` = a session is open or it answered discovery in the last 15 min. |
| `players[]` details | Optional, omitted when unknown (still contract v1; the OLED's fixture screens read them): `id` (MAC), `fw`, `room`, `seen` (unix s of the last message or discovery answer), `session` (`live`, `reconnecting`, `none`), `error` (why it's unreachable or refused), `leds` + `leds_src` (`configured`, or `map` when no channel count is set: the stored map's count, as `agent/src/channels.ts`), `effect` (the running effect's id when the bridge knows it), `perf` (`fps`, `budget_used`, `overruns`, `lagging`, `heap_free`, `at`: the newest perf report / fps_state the bridge holds, from `measure_effect` or the player's own pushes). The bridge reads each player's hardware config once per session for `leds` (plus its stored map only when no channel is configured); everything else is what it already holds. No certificate pins or tokens. |
| `lan_ip` | The bridge's first non-loopback IPv4 address. |
| `error` | Last connection error while `offline`, the fatal error in `error`, else `null`. |
| `updated_at` | Unix seconds of this write. |

Control socket: a unix stream socket at `/run/splanc-bridge/control.sock` (override
`SPLANC_BRIDGE_CONTROL` or `--control`; same fallback as the status file), mode `0660` (put the
display service in the bridge user's group). Newline-delimited JSON, one reply line per command:

| Command | Reply |
| --- | --- |
| `{"cmd":"new_pairing_code"}` | `{"ok":true,"pairing":{"code","expires_at","url"}}`; `{"ok":false,"error"}` when offline or rate-limited. |
| `{"cmd":"revoke_all"}` | `{"ok":true,"revoked":<n>}` once the relay confirms; live sessions are dropped. |
| `{"cmd":"identify"}` | Blinks every known fixture (brightness dips 3×, then restored): `{"ok":true,"players":<n>,"results":[…]}`. |
| `{"cmd":"status"}` | `{"ok":true,"status":<the status object>}` (extra; same as the file). |
| anything else | `{"ok":false,"error":"unknown cmd …"}` |

`splanc-agent bridge-ctl new-code|revoke-all|identify|status` is a CLI over the same socket.

## Effects library

A private library of effect programs per installation (per bridge), so an agent asked for a new
scene or mood can find an effect that already worked instead of writing it again, read and copy
one to reuse its ideas, and the library grows as the user asks for more. Code:
`agent/relay/src/library.ts` (entries, validation, search, the tools; no runtime imports),
`agent/relay/src/mcpLibrary.ts` (the relay's JSON-RPC handling), `agent/src/libraryLocal.ts`
(the agent's file store and zod schemas).

**Entry**: `id` (`fx_` + 8 base32 chars, stable), `name`, `description` (what it looks like, the
mood, when to use it), `tags`, `source`, `uniforms` (the compiler's manifest minus slots: name,
width, ui, default, min, max, unit, doc), `lang` (effect language version, 1), `compiler` (when
known), `hash` (sha256 of the normalized source), `bytes`, `created_at`, `updated_at`, `uses`
(successful deploys), `last_used_at`, `parent_id` (duplicates), `origin` (`saved`, `auto` = kept
from a deploy, `seed` = a built-in example), `needs_description`, `perf` (`estimate` per fixture
from deploy_effect, `measured` from the next measure_effect).

**Tools** (annotated: search/get read-only; update/delete destructive; all `openWorldHint:
false`):

| Tool | |
| --- | --- |
| `search_effects {query?, tags?, limit?}` | Compact rows (id, name, truncated description, tags, uniform names, uses, last_used), ranked. No query: the whole index, most used first (default 100 rows, max 500). |
| `get_effect {id}` | The full entry, source included. |
| `save_effect {name, description, source, tags?, uniforms?, perf?}` | New entry, or (same source hash) the existing entry's metadata updated; an `auto` entry saved this way becomes `saved`. |
| `duplicate_effect {id, name?, description?}` | A copy with `parent_id` set, full source returned, to adapt and `update_effect`. |
| `update_effect {id, …}` | Name, description, tags, source (uniforms re-read), uniforms, perf. |
| `delete_effect {id}` | Gone for good. |
| `deploy_effect {library_id}` | Deploys an entry in one call; `effect_id` defaults to a slug of its name. `name`/`description`/`tags` on any deploy describe it for the library. |

The tool descriptions and the MCP `instructions` give the agent the workflow: `search_effects`
first for any new scene or mood; reuse (deploy by `library_id`, tune uniforms) or duplicate and
adapt; otherwise author, then `save_effect` with a rich description and tags.

**Accumulation**: every successful `deploy_effect` with a source is kept: a use of the entry with
the same source (or `library_id`), else a new `auto` entry named after the effect id, with a
placeholder description and `needs_description` (search reports how many; the deploy result's
second text block says `update_effect` it). A failed deploy (compile error, over budget, every
player failed) isn't kept.

**Limits**: source ≤ 64 KB, description ≤ 2 KB, name ≤ 80, ≤ 16 tags, ≤ 64 uniforms, perf ≤ 4
KB; ≤ 500 entries and ≤ 8 MB of source per installation. To make room, `auto` and `seed`
entries are evicted least recently used first (the save's result lists them); `saved` entries
never are: a save that would need that is refused with the reason, and a deploy still succeeds
(its result says it wasn't kept).

**Search**: word tokens (lower case, a light stemmer, stop words dropped) over name (weight 5),
tags (4), uniform names (2) and description (1, not placeholders); exact or prefix (≥ 3 chars)
matches, weighted by rarity (idf), scaled by how much of the query matched, plus a small boost
for use. SQLite FTS5 is available in Durable Object SQLite, but the relay keeps its Durable
Object state through the storage KV API so the same code runs on the Node host (self-hosted
relay, tests) and in the agent's file store; at ≤ 500 metadata rows, scoring in memory is
microseconds, and the index is read once per wake period.

**Where it lives**:

- *Behind the relay* the library is in the bridge's `BridgeObject` storage: `fx:<id>` = an
  entry's metadata (the search index), `fxs:<id>` = its source (read by id only), `fxk:<name>` =
  flags (`seeded`, `last_deploy`). New keys in the existing class: no Durable Object migration,
  nothing changes for paired bridges. The relay serves it itself, so it is fast and works while
  the bridge is offline:
  - `tools/call` of a library tool is answered by the Durable Object; nothing crosses the
    bridge socket.
  - `tools/list` and `initialize` are forwarded and the reply's response event rewritten: the
    library tools appended (a bridge tool of the same name replaced), `deploy_effect`'s schema
    given the library arguments, the library guidance appended to `instructions`. JSON replies
    stay JSON; SSE replies stay streams (progress events pass straight through; only the event
    with the response for that request id waits).
  - `deploy_effect {library_id}`: the relay puts the entry's source and an `effect_id` in the
    call and strips the library arguments, so any bridge version deploys it. After a successful
    deploy (and a `measure_effect`), the library is updated and a note added to the result.
  - Bridge offline: `tools/list` answers the library tools; `initialize` gets a relay session
    (`Mcp-Session-Id: relay-…`, `serverInfo.name: splanc-relay`, instructions saying the bridge
    is offline) serving the library, `ping` and notifications (`202`); other calls on it get a
    JSON-RPC error. Once the bridge is back, that session gets `404` for anything but library
    calls, so the client initializes again onto the bridge (the spec's session-expiry path).
    Other calls while offline keep the `503`.
  - Batches and anything unparseable are tunnelled untouched.
- *Without the relay* (stdio, the one-shot CLI) the agent serves the same tools from
  `<state dir>/effects-library.json` (`$SPLANC_BRIDGE_STATE_DIR`, else `$STATE_DIRECTORY`, else
  `~/.local/state/splanc`), with the same `deploy_effect {library_id}` and accumulation. The
  bridge (`splanc-agent bridge`) registers no library tools: the relay's library is the one in
  use (and a self-hosted `splanc-agent relay` keeps it in its data file).

**Seed**: a new library starts with the skill's examples (`agent/skill/examples/*.fx`, copied
into `librarySeed.ts`; `library_test` checks they match) with descriptions and tags, once.
Uniform manifests are read from the source's `uniform` declarations the way `fx_compiler`
parses them (the relay has no compiler); `library_test` checks that against the compiler for
every example. An agent can pass the compiler's manifest instead.

**Later: a shared library.** This one is private on purpose. An opt-in shared/community library
(publish an entry; search others') would need moderation (effect source is arbitrary text an
agent reads: prompt injection, spam, offensive names), per-account quotas, attribution and
licensing, and takedown. It would live in its own Durable Object class (not in any bridge's), with
publishing as an explicit user action and results marked as third-party content.

## Free-tier budget

Workers Free plan limits (Cloudflare docs, checked 2026-10): Worker requests 100,000/day (10 ms
CPU each); Durable Objects 100,000 requests/day, 13,000 GB-s/day duration, SQLite 5 M rows
read/day, 100 k rows written/day, 5 GB stored; incoming WebSocket messages bill 20:1 as
requests; outgoing messages, protocol pings and auto-responses are free; idle hibernated objects
bill no duration. Exceeding a limit makes further operations fail until 00:00 UTC; a free account
is never charged.

Costs per action:

| Action | Worker req | DO req | Rows R / W |
| --- | --- | --- | --- |
| One MCP message (`POST /mcp`) | 1 | 1 + 1/20 (the bridge's reply) | ≤ 1 / 0 |
| Unauthenticated `/mcp` probe | 1 | 0 | 0 / 0 |
| Bridge connect | 1 | 1 | 2 + #tokens / 0–1 |
| Idle bridge, per day | 0 | ~0 (pings are free; reconnects 1 each) | 0 / 0 |
| New pairing code | 0 | 1/20 + 1 | 4 / 3 |
| Full OAuth connect (register, authorize ×2, token) | 4 | ~6 | ~10 / ~8 |
| Token refresh (daily per client) | 1 | 2 | 3 / 3 |
| Library tool call (search, get, save, …) | 1 | 1 (no bridge message) | first per wake: #entries; then 0–1 / 0–2 |
| Library bookkeeping on a deploy / measure through the relay | 0 (same request) | 0 | first per wake: #entries / 1–3 |

Duration is the binding limit: a Durable Object is billed at 128 MB for every second it is
awake (while a request is in flight, plus ~10 s before it hibernates). One isolated tool call ≈
10–15 s awake ≈ 1.3–1.9 GB-s; calls in a burst share the wake period. 13,000 GB-s/day ≈ 28
object-hours/day, which is about:

- ~7,000 isolated tool calls/day, or ~28 hours of continuous back-to-back agent activity,
  spread over all bridges;
- by requests: ~95,000 MCP messages/day. A typical session (initialize, list tools, ~20 calls)
  is ~25 messages, so ~3,800 sessions/day if they were short and dense.

For a household doing a few sessions a day (~40 GB-s), one free account serves a few hundred
bridges. The design choices that keep it there: quick replies coalesced into one message, `405` on
`GET /mcp`,
hibernatable bridge sockets with free pings, `401`s answered without a Durable Object, no
per-request storage writes, and token checks cached per wake period. The effects library adds
no Worker requests and no socket messages: its calls are answered inside the one Durable Object
request, its index (≤ 500 small rows) is read once per wake, and a save writes two rows.

## Hosting

- Cloudflare: `agent/relay/wrangler.toml` deploys Worker `splanc-relay` to
  `https://splanc-relay.<account subdomain>.workers.dev` (`agent/relay/deploy.sh`, or the
  "Deploy cloud relay" workflow). splanc.io's DNS stays where it is; no custom domain is needed.
- Public address: `https://splanc.pages.dev`. The splanc Pages project has a service binding
  `RELAY` → `splanc-relay`, and `web/_worker.js` forwards the relay's paths (`RELAY_PATHS`:
  `/mcp`, `/pair`, the OAuth endpoints and metadata, `/bridge/*`) through it with the URL
  unchanged, so the relay's issuer and MCP URLs come out as `splanc.pages.dev`. The workers.dev
  address keeps working and names itself. The binding lives in the Pages project settings
  (not in the repo); a deploy without it answers those paths with `503 relay not bound`.
  The token needs Account → Workers Scripts → Edit (the Pages-only deploy token can't).
- Self-hosted: `splanc-agent relay` runs the same Worker code on Node (`RelayHost`: Durable
  Object storage in memory, persisted to a JSON file; sockets never hibernate). Expose it with
  `tailscale funnel` or `tailscale serve`; see [the Tailscale guide](../guides/relay-tailscale.md).

The retired app origin: `splanc.pages.dev` (Cloudflare Pages, `web/_worker.js`) now `301`s
every non-API path to `https://splanc.io/app/<path>` (agent files `AGENTS.md`, `llms.txt`,
`/agent/`, `/.well-known/` go to the splanc.io root), serves a self-unregistering service worker
at `/sw.js` so installed copies let go, and keeps `/gh-asset` and `/api/demo-ai/…` working.

## Threat model

Assets: control of the user's fixtures (effects, brightness, uniforms, names; never re-flash,
re-map or rewire: `FORBIDDEN_TYPES` in `session.ts` is enforced on the bridge); the LAN the
bridge sits on; the bridge's identity key; the relay's free-tier budget.

| Threat | Mitigation | Residual |
| --- | --- | --- |
| Guessing a pairing code | 40-bit codes, 10 min, single use; ≤ 10 failures per IP per 10 min; ≤ 300 failures per 10 min globally, checked before lookup | With N live codes, a guesser at the global ceiling wins with probability 300·N/2⁴⁰ per 10 min (N = 10: ~10⁻⁴ per year) |
| Burning the global failure budget | — | A determined attacker can block pairing for everyone in 10-min windows (retry later; self-host) |
| Someone near the display reads the code | Codes show only while unpaired (first hour) or on a button press; `clients` on the display; revoke-all button | Physical presence + 10 min = can pair; that is the trust model of a code on a screen |
| Consent phishing (attacker sends the user an authorize link for the attacker's client) | Consent page names the client and the redirect host, warns on loopback redirects; the user has to type a code from their own device | Like any device-code flow, a user who types the code into an attacker's page grants the attacker access |
| Stolen access token | 24 h lifetime; hashes only at rest; revocable per grant or all at once | Valid until revoked or expired |
| Stolen refresh token | Rotation on every use; reuse of a rotated token revokes the grant | The thief wins if they use it first and the user never refreshes again |
| Stolen personal token | Never expires by design (headers-only clients); revoke-all | User-managed |
| Token passthrough / confused deputy | Tokens are audience-bound to `<relay>/mcp` (RFC 8707 `resource` checked); `Authorization` is never forwarded to the bridge | — |
| Bridge impersonation | Ed25519 key on the bridge (file mode 0600); signed timestamps (±300 s) on connect | A captured connect header (TLS makes that hard) replays for 5 min, which only reconnects the real bridge |
| Relay operator / Cloudflare | The relay holds no device keys, Wi-Fi credentials or certificate pins; it sees MCP traffic: tool arguments and results (effect source, fixture maps, player names and LAN addresses) | A malicious relay can drive the lights as any connected agent could. Self-host to remove it |
| Bridge as a LAN pivot | The bridge speaks only the hub's MCP tools; no arbitrary HTTP | `add_player` / `refresh_players` make the bridge TCP-probe :443 and GET `/.well-known/splanc.json` on hosts an agent names, and sweep its local /24s |
| Prompt-injected or careless cloud agent | The tool surface is bounded (no re-flash/re-map; `set_device_name` and `delete_keypoint` are confirm-gated by the skill) | Lights can be set to anything the effect engine can do |
| Local users | Control socket mode 0660; status file world-readable (no secrets in it) | Anyone in the bridge's group can mint codes and revoke |
| Consent page injection / clickjacking | Every value escaped; CSP `default-src 'none'`, `frame-ancestors 'none'`; no scripts | — |
| SSRF via Client ID Metadata Documents | Only https URLs with a path; 5 s, 16 KiB, no redirects; Workers can't reach private networks | The relay can be made to fetch public URLs (rate-bound by `/authorize` use) |
| Library abuse (a paired agent filling it) | Size caps per entry and per installation (500 entries, 8 MB); private per bridge, so nothing one user stores reaches another | A paired agent can fill or delete its own user's library |
| Prompt injection through library entries | Entries are private: only this installation's own agents wrote them | Content an agent saved earlier is read back as data by the next agent |
| Free-tier exhaustion (DoS) | Unauthenticated requests stop at the Worker; registrations rate-limited per IP and globally | 100 k Worker requests/day is a hard ceiling an attacker can spend; the relay then fails closed until 00:00 UTC |

Not covered: the LAN itself (players have no LAN auth; anything on the LAN can already drive
them), and the bridge host's own security.

## Testing

- `//agent:relay_test`: the Worker under the Node host: metadata, registration (rate limit,
  proof of possession), signed connect (bad/stale signature, unknown bridge → re-register),
  codes (replacement, single use, expiry, per-IP and global limits), the OAuth flow (consent
  page, PKCE, single-use codes, confidential clients, tampered client ids, CIMD), refresh
  rotation + reuse detection, `/pair`, RFC 7009, revoke-all, offline `503`, `405` GET, in-flight
  requests failing fast when the bridge drops, no token passthrough, hashes-only storage.
- `//agent:library_test`: the library on its own and in the stdio/CLI server: validation and
  caps, search ranking, LRU eviction (saved entries never), dedupe by source hash, duplicate
  lineage, deploy accumulation and perf, the seed examples, the uniform reader against the real
  compiler, the relay's DO store and the agent's file store giving identical tool results, the
  server's tools and schemas matching the relay's.
- `//agent:relay_library_test`: the relay serving it: library calls answered without a bridge
  frame, `tools/list`/`initialize` merged over SSE replies, `deploy_effect {library_id}` inlined
  (and stripped of library arguments), deploys saved and failures not, measurements attached,
  the offline relay session (a real SDK client) and its `404` once the bridge is back, one
  library per bridge. `relay_e2e_test` deploys a library entry through the real bridge.
- `//agent:lanbridge_test`: the display contract (every field, states, atomic writes), every
  control command, reconnect after a dropped socket, `offline` during a relay outage, recovery
  with the same bridge id and credentials after a relay restart.
- `//agent:relay_e2e_test`: the MCP SDK's Streamable HTTP client (as a connector) → relay →
  bridge → hub → two fake players; the pairing code read from the status file; tools, resources,
  fan-out; `404` for a stale session after a bridge restart; idle liveness. Set
  `SPLANC_E2E_RELAY=<url>` to run it against `wrangler dev` (workerd) or the deployed relay.
