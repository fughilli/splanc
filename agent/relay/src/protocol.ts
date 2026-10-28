/**
 * The relay <-> bridge wire (docs/design/cloud-relay.md, "Bridge socket").
 *
 * One WebSocket per bridge, opened OUTBOUND by the bridge to
 * `<relay>/bridge/connect?id=<bridge_id>`. Every frame is one JSON text message.
 * The relay tunnels each HTTP request a cloud agent sends to the bridge's MCP
 * endpoint as a `req` frame; the bridge answers with `res` (and, for a streamed
 * reply, `chunk`s then `end`). The relay never parses MCP bodies beyond routing
 * them: the bridge runs the MCP SDK's Streamable HTTP transport itself.
 *
 * Shared by the Worker (agent/relay/src) and the bridge (agent/src/bridge): no
 * runtime imports, types and constants only.
 */

export const WIRE_VERSION = 1;

/** Liveness: the bridge sends this exact text; the relay's auto-response answers
 * PONG without waking a hibernated Durable Object (and without billing it). */
export const PING = "ping";
export const PONG = "pong";

/** Close codes the relay uses on the bridge socket. */
export const CLOSE_REPLACED = 4001; // another connection for the same bridge took over
export const CLOSE_PROTOCOL = 4002; // malformed frame

/** HTTP statuses the connect upgrade can be refused with (before the socket opens). */
export const CONNECT_UNKNOWN_BRIDGE = 404; // re-register
export const CONNECT_BAD_SIGNATURE = 401; // clock skew or wrong key

/** Header carrying the bridge's signed connect proof: `<unix seconds>.<b64url sig>`. */
export const BRIDGE_AUTH_HEADER = "x-splanc-bridge-auth";

/** The message the bridge signs to connect (Ed25519). */
export const connectMessage = (bridgeId: string, ts: number) => `splanc-bridge-connect\n${bridgeId}\n${ts}`;
/** The message the bridge signs to register its key (proof of possession). */
export const registerMessage = (publicKey: string, ts: number) => `splanc-bridge-register\n${publicKey}\n${ts}`;

/** Header carrying a bridge's signed bug report (POST /bugs, docs/design/agent-bug-reports.md):
 * `<bridge id>.<unix seconds>.<b64url sig>` over bugReportMessage. */
export const BUG_AUTH_HEADER = "x-splanc-bridge-bug";
/** The message a bridge signs to file a bug as itself (per-bridge rate limits). */
export const bugReportMessage = (bridgeId: string, ts: number, bodySha256: string) =>
  `splanc-bug-report\n${bridgeId}\n${ts}\n${bodySha256}`;
/** How far a signed timestamp may be from the relay's clock. */
export const SIGNATURE_WINDOW_S = 300;

/** Request headers tunnelled to the bridge (lower case). Authorization is NOT among them:
 * the relay's credential stays at the relay (no token passthrough). */
export const FORWARD_REQUEST_HEADERS = [
  "accept",
  "content-type",
  "last-event-id",
  "mcp-session-id",
  "mcp-protocol-version",
  "mcp-method",
  "mcp-name",
];
/** Plus every `mcp-param-*` header (2026-07-28 custom headers). */
export const FORWARD_REQUEST_PREFIX = "mcp-param-";

/** Response headers tunnelled back to the cloud agent. */
export const FORWARD_RESPONSE_HEADERS = ["content-type", "mcp-session-id", "mcp-protocol-version", "allow", "cache-control"];

export interface Pairing {
  /** `ABCD-EFGH`. */
  code: string;
  /** Unix seconds. */
  expires_at: number;
  /** Where a person redeems it by hand (the relay's /pair page). */
  url: string;
}

// -- relay -> bridge -----------------------------------------------------------------

/** One paired client as the relay tells its bridge (docs/design/cloud-relay.md,
 * "Paired clients"): a grant, i.e. every token one pairing produced. No secrets. */
export interface GrantInfo {
  /** The grant id (opaque, stable): what `revoke_grant` names. */
  id: string;
  /** The OAuth client's name, the app's device name, or the personal token's label. */
  label: string;
  /** `connector` = an OAuth (custom connector) client; `app` = the Splanc app;
   * `token` = a personal bearer token from /pair. */
  kind: GrantKind;
  /** Unix seconds. */
  created_at: number;
  /** Unix seconds of the last MCP call, live session or refresh through the relay
   * (written at most once a minute per grant); null = not used since the relay
   * started keeping it. */
  last_used_at: number | null;
}

export type GrantKind = "connector" | "app" | "token";

export interface HelloFrame {
  t: "hello";
  v: number;
  bridge_id: string;
  relay: string;
  /** The MCP endpoint cloud agents add as a connector. */
  mcp_url: string;
  /** Live credentials (OAuth grants + personal tokens) for this bridge. */
  credentials: number;
  pairing: Pairing | null;
  /** Every paired client (a relay with per-client management; an older relay
   * leaves it out, and a bridge then says the list needs a relay update). */
  grants?: GrantInfo[];
}

export interface StateFrame {
  t: "state";
  credentials: number;
  pairing: Pairing | null;
  /** What changed, for the bridge's log. */
  reason?: string;
}

export interface ReqFrame {
  t: "req";
  id: number;
  method: string;
  headers: Record<string, string>;
  body: string;
}

export interface CancelFrame {
  t: "cancel";
  id: number;
}

export interface ErrorFrame {
  t: "error";
  /** The bridge request this answers, if any. */
  for?: string;
  /** For `revoke_grant`: the grant it named. */
  grant?: string;
  message: string;
}

/** relay -> bridge: the paired clients, after `caps` with `grants: 1`, on a
 * `list_grants`, and whenever the list changes (a pairing, a revoke, a refresh
 * token reuse) or a client's last-used time is written (at most once a minute
 * per client). Never sent to a bridge that didn't ask for it in `caps`. */
export interface GrantsFrame {
  t: "grants";
  grants: GrantInfo[];
  /** What changed, for the bridge's log. */
  reason?: string;
}

// -- live sessions (docs/design/live-vj-relay.md) --------------------------------------
// An app (the Splanc PWA) opens `GET <relay>/live` as a WebSocket, authenticated by
// its bearer token in the subprotocol list. The relay authenticates it and passes
// every text message through verbatim, both ways, tagged with a connection id; the
// bridge speaks the live protocol (agent/src/bridge/liveProtocol.ts) with the app.

/** The subprotocol a live socket negotiates (the relay and the bridge's LAN port). */
export const LIVE_SUBPROTOCOL = "splanc-live.v1";
/** The credential rides in the subprotocol list (browsers can't set headers on a
 * WebSocket): `["splanc-live.v1", "bearer.<token>"]`. */
export const LIVE_BEARER_PREFIX = "bearer.";
/** At most this many live sockets per bridge (each keeps the object awake while busy). */
export const MAX_LIVE_CLIENTS = 8;
/** A live message larger than this is refused (an effect's source fits easily). */
export const MAX_LIVE_MESSAGE = 256 * 1024;
/** Per live socket: a sustained rate above this many messages/s is dropped (the
 * app coalesces controls to <= 30 Hz; this protects the free-tier budget). */
export const LIVE_MAX_RATE_HZ = 60;
/** Close codes on a live socket. */
export const LIVE_CLOSE_REVOKED = 4003; // the credential was revoked
export const LIVE_CLOSE_TOO_MANY = 4004; // MAX_LIVE_CLIENTS
export const LIVE_CLOSE_BRIDGE = 4005; // the bridge closed this session

/** relay -> bridge: an app opened a live session (also re-sent for every open live
 * socket after the bridge reconnects). */
export interface LiveOpenFrame {
  t: "live_open";
  c: string;
  /** The credential's label / client name, for the bridge's log and lock owner. */
  label: string;
  /** The credential's grant id (opaque), so the bridge can tie LAN tickets to it. */
  grant: string;
}

/** Either direction: one live-protocol message for connection `c`, verbatim. */
export interface LiveFrame {
  t: "live";
  c: string;
  d: string;
}

/** Either direction: connection `c` ended (relay -> bridge: the app went away;
 * bridge -> relay: close the app's socket). */
export interface LiveCloseFrame {
  t: "live_close";
  c: string;
  code?: number;
  reason?: string;
}

/** relay -> bridge: these grants were revoked (their live sessions and LAN tickets end). */
export interface RevokedFrame {
  t: "revoked";
  /** Grant ids, or ["*"] for every credential. */
  grants: string[];
}

export type RelayFrame =
  | HelloFrame
  | StateFrame
  | ReqFrame
  | CancelFrame
  | ErrorFrame
  | LiveOpenFrame
  | LiveFrame
  | LiveCloseFrame
  | RevokedFrame
  | GrantsFrame;

// -- bridge -> relay -----------------------------------------------------------------

export interface ResFrame {
  t: "res";
  id: number;
  status: number;
  headers: Record<string, string>;
  /** The whole body when `end` (one message per JSON reply: incoming messages are billed). */
  body?: string;
  end?: boolean;
}

export interface ChunkFrame {
  t: "chunk";
  id: number;
  data: string;
}

export interface EndFrame {
  t: "end";
  id: number;
}

export interface NewCodeFrame {
  t: "new_code";
}

export interface RevokeAllFrame {
  t: "revoke_all";
}

/** bridge -> relay, once per connection right after `hello`: what this bridge speaks
 * beyond the MCP tunnel. A relay that never hears it treats the bridge as MCP-only
 * (an older bridge), and answers `/live` with 501. */
export interface CapsFrame {
  t: "caps";
  live?: number;
  /** 1 = this bridge keeps the paired-client list: send it `grants` frames. */
  grants?: number;
}

/** bridge -> relay: send the paired-client list now (a `grants` frame). */
export interface ListGrantsFrame {
  t: "list_grants";
}

/** bridge -> relay: revoke one paired client: all its tokens (access, refresh,
 * personal), its live sessions and (on the bridge) its LAN tickets, the same as
 * `POST /revoke` with one of its tokens. Answered by `revoked` {grants: [grant]}
 * then a `grants` frame, or `error` {for: "revoke_grant", grant} when unknown. */
export interface RevokeGrantFrame {
  t: "revoke_grant";
  grant: string;
}

export type BridgeFrame =
  | ResFrame
  | ChunkFrame
  | EndFrame
  | NewCodeFrame
  | RevokeAllFrame
  | CapsFrame
  | ListGrantsFrame
  | RevokeGrantFrame
  | LiveFrame
  | LiveCloseFrame;
