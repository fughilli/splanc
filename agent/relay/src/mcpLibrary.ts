/**
 * The relay's side of the effects library on /mcp (docs/design/cloud-relay.md,
 * "Effects library"): the few JSON-RPC messages the relay reads instead of only
 * tunnelling them.
 *
 * - tools/call of a library tool: answered here, from the bridge's Durable
 *   Object (one Worker request + one DO invocation; nothing crosses the bridge
 *   socket), bridge online or not.
 * - tools/list: the bridge's tools + the library tools (and deploy_effect's
 *   library arguments); the library tools alone while the bridge is offline.
 * - initialize: forwarded, with the library's guidance appended to the
 *   instructions; while the bridge is offline the relay answers it itself with a
 *   relay session (`relay-…`) that serves the library only. Once the bridge is
 *   back, that session gets 404 for anything else, so the client re-initializes
 *   onto the bridge (the spec's session-expiry path).
 * - deploy_effect: `library_id` is resolved to the source here (the bridge never
 *   sees the library), and a successful deploy is kept in the library.
 *
 * Replies keep the bridge's framing: JSON stays JSON, an SSE stream stays a
 * stream (only the event carrying the response for that request id is rewritten;
 * progress events pass straight through).
 */

import { DEPLOY_LIBRARY_KEYS, DEPLOY_LIBRARY_PROPS, LIBRARY_INSTRUCTIONS, LIBRARY_TOOLS, type LibraryToolDef } from "./library";

export const RELAY_SESSION_PREFIX = "relay-";

/** Protocol versions the relay's own initialize accepts (as the MCP SDK the bridge runs). */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"];

export interface RpcRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface RpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  result?: Record<string, unknown>;
  error?: unknown;
  params?: unknown;
}

/** The one JSON-RPC request/notification in a POST body; null for a batch, a
 * response, or anything unparseable (those are tunnelled untouched). */
export function parseSingle(body: string): RpcRequest | null {
  let v: unknown;
  try {
    v = JSON.parse(body);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const m = v as Record<string, unknown>;
  if (m["jsonrpc"] !== "2.0" || typeof m["method"] !== "string") return null;
  if (m["id"] !== undefined && typeof m["id"] !== "string" && typeof m["id"] !== "number") return null;
  if (m["params"] !== undefined && (typeof m["params"] !== "object" || m["params"] === null)) return null;
  return m as unknown as RpcRequest;
}

const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store" };

export function rpcResult(id: string | number, result: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { status: 200, headers: { ...JSON_HEADERS, ...headers } });
}

export function rpcErrorFor(id: string | number | null, code: number, message: string, status = 200): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }), { status, headers: JSON_HEADERS });
}

/** 404 Session not found: the client must initialize again (spec, session management). */
export const sessionGone = () =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Session not found" } }), {
    status: 404,
    headers: JSON_HEADERS,
  });

/** The library tools as tools/list entries. */
export function libraryToolEntries(): Record<string, unknown>[] {
  return LIBRARY_TOOLS.map((t: LibraryToolDef) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: t.annotations,
  }));
}

/** deploy_effect as the relay serves it: + library_id/name/description/tags; source
 * and effect_id become optional (the relay fills them from a library entry). */
export function patchDeployTool(tool: Record<string, unknown>): Record<string, unknown> {
  const schema = { ...((tool["inputSchema"] as Record<string, unknown>) ?? { type: "object" }) };
  const props = { ...((schema["properties"] as Record<string, unknown>) ?? {}) };
  for (const [k, v] of Object.entries(DEPLOY_LIBRARY_PROPS)) props[k] ??= v;
  schema["properties"] = props;
  if (Array.isArray(schema["required"])) {
    schema["required"] = (schema["required"] as string[]).filter((k) => k !== "source" && k !== "effect_id");
  }
  const desc = String(tool["description"] ?? "");
  return {
    ...tool,
    inputSchema: schema,
    description: desc.includes("library_id")
      ? desc
      : `${desc} Pass library_id to deploy a library entry (search_effects) instead of source. Successful deploys are kept in the effects library.`,
  };
}

/** The bridge's tools + the library's (a bridge tool of the same name is replaced:
 * the relay's library is the one in use). */
export function mergeTools(bridgeTools: unknown): Record<string, unknown>[] {
  const lib = libraryToolEntries();
  const names = new Set(lib.map((t) => t["name"]));
  const own = (Array.isArray(bridgeTools) ? (bridgeTools as Record<string, unknown>[]) : [])
    .filter((t) => !names.has(t["name"]))
    .map((t) => (t["name"] === "deploy_effect" ? patchDeployTool(t) : t));
  return [...own, ...lib];
}

export function withLibraryInstructions(instructions: unknown): string {
  const s = typeof instructions === "string" ? instructions : "";
  if (s.includes(LIBRARY_INSTRUCTIONS.slice(0, 40))) return s;
  return s ? `${s}\n\n${LIBRARY_INSTRUCTIONS}` : LIBRARY_INSTRUCTIONS;
}

/** The relay's own initialize result (bridge offline). */
export function relayInitializeResult(params: Record<string, unknown> | undefined, version: string): Record<string, unknown> {
  const asked = typeof params?.["protocolVersion"] === "string" ? (params["protocolVersion"] as string) : "";
  return {
    protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(asked) ? asked : SUPPORTED_PROTOCOL_VERSIONS[0],
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: "splanc-relay", title: "Splanc (bridge offline: effects library only)", version },
    instructions:
      "The Splanc bridge for this connector is offline (the Raspberry Pi or computer running `splanc-agent " +
      "bridge` is off or has no internet), so only the effects library is available; the lights' tools come " +
      "back when you reconnect after the bridge is online.\n\n" +
      LIBRARY_INSTRUCTIONS,
  };
}

/** Strip the library-only arguments of deploy_effect (an older bridge must not see them). */
export function stripDeployArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) if (!DEPLOY_LIBRARY_KEYS.includes(k)) out[k] = v;
  return out;
}

// -- rewriting a reply -------------------------------------------------------------------

const enc = new TextEncoder();

/** Cap on what is buffered while looking for the response (the rest streams on). */
const MAX_HELD = 4 * 1024 * 1024;

type Rewrite = (msg: RpcMessage) => Promise<RpcMessage> | RpcMessage;

function rewriteEvent(event: string, id: string | number, fn: Rewrite): Promise<string> | null {
  const lines = event.split("\n");
  const data = lines.filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, ""));
  if (!data.length) return null;
  let msg: RpcMessage;
  try {
    msg = JSON.parse(data.join("\n")) as RpcMessage;
  } catch {
    return null;
  }
  if (msg.id !== id || msg.method !== undefined) return null;
  return Promise.resolve(fn(msg)).then((m) => {
    const keep = lines.filter((l) => !l.startsWith("data:"));
    return [...keep, `data: ${JSON.stringify(m)}`].join("\n");
  });
}

/**
 * The reply with the response to request `id` passed through `fn` (results and
 * errors alike). JSON replies are read whole; SSE replies stream: every event
 * passes through as it completes, and only the response event waits for `fn`.
 */
export function rewriteReply(res: Response, id: string | number, fn: Rewrite): Response {
  const ct = res.headers.get("content-type") ?? "";
  if (!res.body || res.status !== 200) return res;
  if (ct.startsWith("application/json")) {
    const body = res.text().then(async (text) => {
      try {
        const msg = JSON.parse(text) as RpcMessage;
        if (msg && !Array.isArray(msg) && msg.id === id) return JSON.stringify(await fn(msg));
      } catch {
        // not ours to fix
      }
      return text;
    });
    const stream = new ReadableStream<Uint8Array>({
      async start(c) {
        c.enqueue(enc.encode(await body));
        c.close();
      },
    });
    return new Response(stream, { status: res.status, headers: res.headers });
  }
  if (!ct.startsWith("text/event-stream")) return res;
  const dec = new TextDecoder();
  let buf = "";
  let passthrough = false;
  const flushEvents = async (c: TransformStreamDefaultController<Uint8Array>, final: boolean) => {
    for (;;) {
      const at = buf.search(/\r?\n\r?\n/);
      if (at < 0) break;
      const sep = /\r?\n\r?\n/.exec(buf.slice(at))![0];
      const event = buf.slice(0, at).replace(/\r\n/g, "\n");
      buf = buf.slice(at + sep.length);
      const rewritten = rewriteEvent(event, id, fn);
      c.enqueue(enc.encode(`${rewritten ? await rewritten : event}\n\n`));
    }
    if (final && buf) {
      c.enqueue(enc.encode(buf));
      buf = "";
    }
  };
  const ts = new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, c) {
      if (passthrough) {
        c.enqueue(chunk);
        return;
      }
      buf += dec.decode(chunk, { stream: true });
      await flushEvents(c, false);
      if (buf.length > MAX_HELD) {
        // A pathological event: stop looking, pass the rest through untouched.
        c.enqueue(enc.encode(buf));
        buf = "";
        passthrough = true;
      }
    },
    async flush(c) {
      buf += dec.decode();
      await flushEvents(c, true);
    },
  });
  return new Response(res.body.pipeThrough(ts), { status: res.status, headers: res.headers });
}

/** Text of a tool result's first text content, parsed as JSON when it is. */
export function toolResultJson(result: Record<string, unknown> | undefined): unknown {
  const content = result?.["content"];
  if (!Array.isArray(content)) return null;
  const t = (content as { type?: string; text?: string }[]).find((x) => x.type === "text")?.text;
  if (typeof t !== "string") return null;
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

/** Whether a deploy_effect result deployed anywhere (a deploy result names the
 * bytecode size per player; a refusal or an all-failed fan-out doesn't). */
export function deploySucceeded(result: Record<string, unknown> | undefined): boolean {
  if (!result || result["isError"] === true) return false;
  return JSON.stringify(result["content"] ?? "").includes("bytecode_bytes");
}

/** deploy_effect's per-fixture estimates (multi-player result), for the entry's perf. */
export function deployPerf(result: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const j = toolResultJson(result) as Record<string, unknown> | null;
  const est = j && typeof j === "object" ? j["estimates"] : undefined;
  return est && typeof est === "object" ? { estimate: est as Record<string, unknown> } : undefined;
}
