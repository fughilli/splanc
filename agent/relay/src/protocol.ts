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
  message: string;
}

export type RelayFrame = HelloFrame | StateFrame | ReqFrame | CancelFrame | ErrorFrame;

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

export type BridgeFrame = ResFrame | ChunkFrame | EndFrame | NewCodeFrame | RevokeAllFrame;
