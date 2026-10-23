/**
 * The slice of the Cloudflare Workers runtime the relay uses, typed locally (no
 * @cloudflare/workers-types dependency) so the same code also runs under the
 * Node host (agent/relay/node/host.ts: self-hosting, and the tests).
 *
 * Durable Objects are written in the classic `constructor(state, env)` + `fetch`
 * style (no `cloudflare:workers` import) and use the WebSocket Hibernation API:
 * `state.acceptWebSocket` + `webSocketMessage`/`webSocketClose` handlers.
 */

export interface DOStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  get<T = unknown>(keys: string[]): Promise<Map<string, T>>;
  put<T>(key: string, value: T): Promise<void>;
  put<T>(entries: Record<string, T>): Promise<void>;
  delete(key: string): Promise<boolean>;
  delete(keys: string[]): Promise<number>;
  list<T = unknown>(opts?: { prefix?: string; limit?: number }): Promise<Map<string, T>>;
  getAlarm(): Promise<number | null>;
  setAlarm(at: number): Promise<void>;
}

/** A hibernatable server-side WebSocket. */
export interface HSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  /** Survives hibernation (Cloudflare: structured clone, <= 2 KiB). */
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

export interface DOState {
  storage: DOStorage;
  acceptWebSocket(ws: HSocket, tags?: string[]): void;
  getWebSockets(tag?: string): HSocket[];
  setWebSocketAutoResponse?(pair: unknown): void;
}

export interface DOStub {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}

export interface DONamespace {
  idFromName(name: string): unknown;
  get(id: unknown): DOStub;
}

/** What a host other than Cloudflare provides (the Node host); absent on Workers. */
export interface HostHooks {
  /** Accept a WebSocket upgrade into `state` (tags as acceptWebSocket's). */
  upgrade(state: DOState, tags: string[]): Upgraded;
  /** Auto-respond `request` with `response` without waking the object. */
  autoResponse(state: DOState, request: string, response: string): void;
  /** Clock (ms), for tests. */
  now?(): number;
}

export interface Env {
  BRIDGE: DONamespace;
  DIRECTORY: DONamespace;
  /** Canonical public origin (no trailing slash) when the request URL isn't it
   * (behind a proxy such as `tailscale funnel`). */
  PUBLIC_URL?: string;
  /** Worker secret: a fine-grained GitHub PAT with Issues: write on the bug
   * repository only, for POST /bugs (docs/design/agent-bug-reports.md). Unset =
   * direct bug filing is "not configured" and agents hand out a link instead. */
  GITHUB_ISSUES_TOKEN?: string;
  /** owner/repo bugs are filed in (default fughilli/splanc). */
  GITHUB_ISSUES_REPO?: string;
  /** GitHub API base (default https://api.github.com; tests point it at a mock). */
  GITHUB_API_URL?: string;
  /** Present under the Node host. */
  HOST?: HostHooks;
}

export const now = (env: Env) => (env.HOST?.now ? env.HOST.now() : Date.now());

export interface Upgraded {
  /** Return this from fetch. */
  response: Response;
  /** The accepted server end (send on it right away; it is buffered). */
  socket: HSocket;
}

/** Accept a WebSocket upgrade: Cloudflare's WebSocketPair, or the host's. */
export function upgrade(env: Env, state: DOState, tags: string[], headers: Record<string, string> = {}): Upgraded {
  // (The Node host negotiates the subprotocol itself: `ws` picks the first offered.)
  if (env.HOST) return env.HOST.upgrade(state, tags);
  const Pair = (globalThis as unknown as { WebSocketPair: new () => [HSocket, HSocket] }).WebSocketPair;
  const pair = new Pair();
  state.acceptWebSocket(pair[1], tags);
  return { response: new Response(null, { status: 101, webSocket: pair[0], headers } as ResponseInit), socket: pair[1] };
}

export function autoResponse(env: Env, state: DOState, request: string, response: string): void {
  if (env.HOST) return env.HOST.autoResponse(state, request, response);
  const Pair = (globalThis as unknown as { WebSocketRequestResponsePair?: new (a: string, b: string) => unknown })
    .WebSocketRequestResponsePair;
  if (Pair && state.setWebSocketAutoResponse) state.setWebSocketAutoResponse(new Pair(request, response));
}
