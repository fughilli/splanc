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

- **Bridge** (`splanc-agent bridge --relay <url>`): the existing hub plus `LanBridge`. It keeps
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
  without interpreting them, and a client's relay credential is never passed to the bridge.

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
connection for the same bridge replaces the older one (closed with `4001`).

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

Tunnelled request headers: `accept`, `content-type`, `last-event-id`, `mcp-session-id`,
`mcp-protocol-version`, `mcp-method`, `mcp-name`, `mcp-param-*`. `Authorization` is never
forwarded (no token passthrough). Response headers back: `content-type`, `mcp-session-id`,
`mcp-protocol-version`, `allow`, `cache-control`. The bridge's transport answers with SSE, so
progress notifications and log messages from long tools reach the cloud client as they happen.
Incoming messages are what the Durable Object is billed for, so the bridge coalesces: a reply
whose stream ends within 400 ms (most of them) goes out as ONE `res` frame with the whole SSE
body; a slower one switches to `res` + `chunk`s + `end`, forwarded live (the relay sets
`x-accel-buffering: no`). Request bodies are capped at 4 MiB; at most 32 requests in flight per
bridge.

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
  again when one expires, for its first hour of uptime; after that (or once paired) a code comes
  only on request: the display's button, or `splanc-agent bridge-ctl new-code`.
- **Redeeming**, either way:
  1. **OAuth connector (preferred)**. The user adds `<relay>/mcp` as a custom connector. The
     client discovers the authorization server (RFC 9728 → RFC 8414), registers (Client ID
     Metadata Document, or dynamic registration), and opens `/authorize`. The consent page shows
     the client's name and where it will redirect, and asks for the code. The code identifies
     the bridge; the relay issues an authorization code bound to the client, redirect URI,
     PKCE challenge and resource, and the client exchanges it at `/token`. No account, no
     password, nothing to copy.
  2. **Bearer token** for clients that only take headers: `/pair` (code → `spl_pt_…`), shown
     once, never expires, revocable.
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
 "clients":<int connected cloud sessions>,"players":[{"name":"…","host":"…","ok":true}],
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
per-request storage writes, and token checks cached per wake period.

## Hosting

- Cloudflare: `agent/relay/wrangler.toml` deploys Worker `splanc-relay` to
  `https://splanc-relay.<account subdomain>.workers.dev` (`agent/relay/deploy.sh`, or the
  "Deploy cloud relay" workflow). splanc.io's DNS stays where it is; no custom domain is needed.
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
- `//agent:lanbridge_test`: the display contract (every field, states, atomic writes), every
  control command, reconnect after a dropped socket, `offline` during a relay outage, recovery
  with the same bridge id and credentials after a relay restart.
- `//agent:relay_e2e_test`: the MCP SDK's Streamable HTTP client (as a connector) → relay →
  bridge → hub → two fake players; the pairing code read from the status file; tools, resources,
  fan-out; `404` for a stale session after a bridge restart; idle liveness. Set
  `SPLANC_E2E_RELAY=<url>` to run it against `wrangler dev` (workerd) or the deployed relay.
