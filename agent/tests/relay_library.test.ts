/**
 * The effects library served by the cloud relay (relay/src/mcpLibrary.ts +
 * bridgeObject.ts), under the Node host: library tool calls answered at the
 * relay (no frame reaches the bridge), tools/list + initialize merging over the
 * bridge's SSE replies, deploy_effect {library_id} inlined for the bridge,
 * successful deploys saved (failed ones not), and the bridge offline: a relay
 * session with the library only, 404 once the bridge is back. A real MCP SDK
 * client checks the offline path is spec-compliant end to end.
 */

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { LIBRARY_TOOLS } from "../relay/src/library";
import { mergeTools, parseSingle, rewriteReply } from "../relay/src/mcpLibrary";
import type { RelayFrame, ReqFrame, StateFrame } from "../relay/src/protocol";
import { RelayLink } from "../src/bridge/relayLink";
import { RelayHost } from "../src/relayHost";
import { mcpPost, tempIdentity, until } from "./relayHelpers";

const host = new RelayHost();
let relay = "";

before(async () => {
  relay = await host.listen();
});
after(async () => {
  await host.close();
});

const BRIDGE_TOOLS = [
  {
    name: "deploy_effect",
    description: "Compile and upload an effect.",
    inputSchema: {
      type: "object",
      properties: { effect_id: { type: "string" }, source: { type: "string" }, players: { type: "string" } },
      required: ["effect_id", "source"],
    },
  },
  { name: "set_brightness", description: "Set brightness.", inputSchema: { type: "object", properties: {} } },
  // An (older/newer) bridge's own library tool: the relay's replaces it.
  { name: "search_effects", description: "BRIDGE'S OWN", inputSchema: { type: "object", properties: {} } },
];

const sse = (msg: unknown) => `event: message\ndata: ${JSON.stringify(msg)}\n\n`;

interface FakeBridge {
  link: RelayLink;
  reqs: ReqFrame[];
  frames: RelayFrame[];
  /** deploy_effect answers: success unless set. */
  deployFails: boolean;
}

/** A bridge speaking MCP the way LanBridge does: SSE replies (progress events
 * first for deploy/measure), a session id on initialize. */
async function fakeBridge(): Promise<FakeBridge> {
  const { identity } = tempIdentity();
  const link = new RelayLink({ relay, identity, backoff: { baseMs: 20, maxMs: 200 } });
  const fb: FakeBridge = { link, reqs: [], frames: [], deployFails: false };
  link.onFrame = (f) => {
    fb.frames.push(f);
    if (f.t !== "req") return;
    fb.reqs.push(f);
    const m = JSON.parse(f.body || "null") as { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
    const head = { t: "res" as const, id: f.id, status: 200, headers: { "content-type": "text/event-stream", "mcp-session-id": "bridge-session-1" } };
    if (m.id === undefined) {
      link.send({ t: "res", id: f.id, status: 202, headers: {}, end: true });
      return;
    }
    let result: unknown;
    if (m.method === "initialize") {
      result = { protocolVersion: "2025-11-25", capabilities: { tools: { listChanged: true } }, serverInfo: { name: "splanc-agent", version: "0" }, instructions: "Bridge instructions." };
    } else if (m.method === "tools/list") {
      result = { tools: BRIDGE_TOOLS };
    } else if (m.method === "tools/call" && m.params?.name === "deploy_effect") {
      // Streamed: a progress event, then (later) the result.
      link.send(head);
      link.send({ t: "chunk", id: f.id, data: sse({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: 1, progress: 1, message: "compiling" } }) });
      const a = m.params.arguments ?? {};
      const res = fb.deployFails
        ? { isError: true, content: [{ type: "text", text: "the effect doesn't compile" }] }
        : {
            content: [
              {
                type: "text",
                text: JSON.stringify({ results: [{ player: { name: "Hall" }, ok: true, result: { effect_id: a["effect_id"], bytecode_bytes: 120 } }], estimates: { Hall: { leds: 30, estimate_ms: 1.5 } } }),
              },
            ],
          };
      setTimeout(() => {
        link.send({ t: "chunk", id: f.id, data: sse({ jsonrpc: "2.0", id: m.id, result: res }) });
        link.send({ t: "end", id: f.id });
      }, 50);
      return;
    } else if (m.method === "tools/call" && m.params?.name === "measure_effect") {
      result = { content: [{ type: "text", text: JSON.stringify({ frame_ms_mean: 2.5, frame_ms_max: 3, budget_used: 0.2, overruns: 0, verdict: "within budget" }) }] };
    } else {
      result = { content: [{ type: "text", text: JSON.stringify({ ok: true, echo: m.params?.name ?? m.method }) }] };
    }
    link.send({ ...head, body: sse({ jsonrpc: "2.0", id: m.id, result }), end: true });
  };
  link.start();
  await until(() => link.online, "bridge online");
  return fb;
}

async function personalToken(fb: FakeBridge): Promise<string> {
  const n = fb.frames.length;
  fb.link.send({ t: "new_code" });
  const f = await until(() => fb.frames.slice(n).find((x): x is StateFrame => x.t === "state" && x.pairing !== null), "pairing code");
  const r = await fetch(`${relay}/pair`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ pairing_code: f.pairing!.code }),
  });
  return ((await r.json()) as { token: string }).token;
}

/** One JSON-RPC response out of a reply (JSON or SSE). */
async function rpc(r: Response, id: number): Promise<{ result?: any; error?: { code: number; message: string } }> {
  const text = await r.text();
  if ((r.headers.get("content-type") ?? "").startsWith("text/event-stream")) {
    for (const ev of text.split("\n\n")) {
      const d = ev.split("\n").find((l) => l.startsWith("data: "));
      if (!d) continue;
      const msg = JSON.parse(d.slice(6));
      if (msg.id === id) return msg;
    }
    throw new Error(`no response ${id} in ${text}`);
  }
  return JSON.parse(text);
}

let nextId = 100;
async function call(token: string, name: string, args: Record<string, unknown>, headers: Record<string, string> = {}) {
  const id = ++nextId;
  const r = await mcpPost(relay, token, { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }, headers);
  assert.equal(r.status, 200, `${name}: HTTP ${r.status}`);
  const msg = await rpc(r, id);
  const content = msg.result?.content as { type: string; text: string }[];
  let json: any = content[0]!.text;
  try {
    json = JSON.parse(content[0]!.text);
  } catch {
    // an error message
  }
  return { isError: msg.result?.isError === true, json, content };
}

const OCEAN = {
  name: "Ocean swell",
  description: "Slow rolling blue waves, calm and relaxing",
  tags: ["calm", "blue", "water"],
  source: "uniform float speed : 0.0 .. 2.0 = 0.5;\nvec3 shade(Led led) { return vec3(0.0, 0.4, 0.8) * sin(time * speed); }\n",
};

describe("pure", () => {
  test("parseSingle: one request or notification; batches and responses pass", () => {
    assert.equal(parseSingle('{"jsonrpc":"2.0","id":1,"method":"tools/list"}')?.method, "tools/list");
    assert.equal(parseSingle('{"jsonrpc":"2.0","method":"notifications/initialized"}')?.id, undefined);
    assert.equal(parseSingle('[{"jsonrpc":"2.0","id":1,"method":"ping"}]'), null);
    assert.equal(parseSingle('{"jsonrpc":"2.0","id":1,"result":{}}'), null);
    assert.equal(parseSingle("nope"), null);
  });

  test("mergeTools: bridge tools + library tools; same names replaced; deploy_effect takes library_id", () => {
    const t = mergeTools(BRIDGE_TOOLS);
    const names = t.map((x) => x["name"]);
    assert.equal(names.filter((n) => n === "search_effects").length, 1);
    assert.notEqual(t.find((x) => x["name"] === "search_effects")!["description"], "BRIDGE'S OWN");
    for (const d of LIBRARY_TOOLS) assert.ok(names.includes(d.name), d.name);
    const dep = t.find((x) => x["name"] === "deploy_effect")!["inputSchema"] as { properties: object; required: string[] };
    assert.ok("library_id" in dep.properties && "description" in dep.properties);
    assert.deepEqual(dep.required, []);
    // The input wasn't mutated.
    assert.deepEqual(BRIDGE_TOOLS[0]!.inputSchema.required, ["effect_id", "source"]);
  });

  test("rewriteReply: SSE events pass through; only the response event is rewritten", async () => {
    const body = sse({ jsonrpc: "2.0", method: "notifications/progress" }) + sse({ jsonrpc: "2.0", id: 7, result: { a: 1 } });
    const res = new Response(body, { headers: { "content-type": "text/event-stream" } });
    const out = await rewriteReply(res, 7, (m) => ({ ...m, result: { a: 2 } })).text();
    assert.equal(out, sse({ jsonrpc: "2.0", method: "notifications/progress" }) + sse({ jsonrpc: "2.0", id: 7, result: { a: 2 } }));
    const j = new Response(JSON.stringify({ jsonrpc: "2.0", id: 3, result: {} }), { headers: { "content-type": "application/json" } });
    assert.deepEqual(JSON.parse(await rewriteReply(j, 3, (m) => ({ ...m, result: { b: 1 } })).text()).result, { b: 1 });
  });
});

describe("relay-served library", () => {
  test("tools/list + initialize are merged; library calls never reach the bridge", async () => {
    const fb = await fakeBridge();
    try {
      const token = await personalToken(fb);
      const init = await mcpPost(relay, token, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
      assert.equal(init.headers.get("mcp-session-id"), "bridge-session-1");
      assert.equal(init.headers.get("content-type"), "text/event-stream");
      const im = await rpc(init, 1);
      assert.match(im.result.instructions, /^Bridge instructions\.\n\nEffects library:/);
      const list = await rpc(await mcpPost(relay, token, { jsonrpc: "2.0", id: 2, method: "tools/list" }), 2);
      const names = (list.result.tools as { name: string }[]).map((t) => t.name);
      assert.deepEqual(names.slice(0, 2), ["deploy_effect", "set_brightness"]);
      for (const d of LIBRARY_TOOLS) assert.ok(names.includes(d.name));
      const searchTool = list.result.tools.find((t: { name: string }) => t.name === "search_effects");
      assert.equal(searchTool.annotations.readOnlyHint, true);
      assert.equal(list.result.tools.find((t: { name: string }) => t.name === "delete_effect").annotations.destructiveHint, true);

      const before = fb.reqs.length;
      const seeded = await call(token, "search_effects", {});
      assert.equal(seeded.isError, false);
      assert.equal(seeded.json.total, 5, "a new library starts with the examples");
      const saved = await call(token, "save_effect", OCEAN);
      assert.equal(saved.json.status, "created");
      assert.deepEqual(saved.json.uniforms, ["speed"]);
      const id = saved.json.id as string;
      const found = await call(token, "search_effects", { query: "calm water" });
      assert.equal(found.json.results[0].id, id);
      const got = await call(token, "get_effect", { id });
      assert.equal(got.json.source, OCEAN.source);
      const dup = await call(token, "duplicate_effect", { id, name: "Stormy sea" });
      assert.equal(dup.json.parent_id, id);
      assert.equal(dup.json.source, OCEAN.source);
      const upd = await call(token, "update_effect", { id: dup.json.id, description: "Grey churning storm sea" });
      assert.equal(upd.json.description, "Grey churning storm sea");
      assert.equal(upd.json.source, undefined);
      assert.equal((await call(token, "delete_effect", { id: dup.json.id })).json.deleted, dup.json.id);
      const bad = await call(token, "get_effect", { id: dup.json.id });
      assert.equal(bad.isError, true);
      const big = await call(token, "save_effect", { ...OCEAN, source: "x".repeat(70_000) });
      assert.equal(big.isError, true);
      assert.match(big.content[0]!.text, /too large/);
      assert.equal(fb.reqs.length, before, "no library call crossed the bridge socket");
      // Stored in the bridge's Durable Object.
      const store = host.storageOf("bridge", fb.link.bridgeId!)!;
      assert.ok(store.has(`fx:${id}`) && store.get(`fxs:${id}`) === OCEAN.source);
    } finally {
      fb.link.stop();
    }
  });

  test("deploy_effect: library_id is inlined for the bridge; deploys are saved; failures aren't", async () => {
    const fb = await fakeBridge();
    try {
      const token = await personalToken(fb);
      const id = (await call(token, "save_effect", OCEAN)).json.id as string;
      const n = fb.reqs.length;
      const dep = await call(token, "deploy_effect", { library_id: id, players: "Hall" });
      assert.equal(dep.isError, false);
      const fwd = JSON.parse(fb.reqs[n]!.body).params.arguments;
      assert.deepEqual(fwd, { source: OCEAN.source, effect_id: "ocean_swell", players: "Hall" }, "library args stripped, source inlined");
      assert.deepEqual(JSON.parse(dep.content[1]!.text).library, { id, status: "used" });
      let e = (await call(token, "get_effect", { id })).json;
      assert.equal(e.uses, 1);
      assert.deepEqual(e.perf.estimate, { Hall: { leds: 30, estimate_ms: 1.5 } });
      // measure_effect after it: the measurement lands on that entry.
      await call(token, "measure_effect", { seconds: 2 });
      e = (await call(token, "get_effect", { id })).json;
      assert.equal(e.perf.measured.frame_ms_mean, 2.5);

      // A deploy with a fresh source (no description): auto-saved, flagged.
      const src = "vec3 shade(Led led) { return vec3(1.0, 0.0, 0.0); }\n";
      const auto = await call(token, "deploy_effect", { effect_id: "red", source: src });
      const note = JSON.parse(auto.content[1]!.text).library;
      assert.equal(note.status, "saved");
      assert.equal(note.needs_description, true);
      const rows = (await call(token, "search_effects", {})).json;
      assert.equal(rows.needs_description, 1);
      assert.equal(rows.results.find((r: { id: string }) => r.id === note.id).origin, "auto");
      // Progress events still stream through ahead of the result.
      const raw = await mcpPost(relay, token, { jsonrpc: "2.0", id: 55, method: "tools/call", params: { name: "deploy_effect", arguments: { effect_id: "red", source: src } } });
      const text = await raw.text();
      assert.ok(text.indexOf("notifications/progress") < text.indexOf('"id":55'));
      assert.equal((await call(token, "get_effect", { id: note.id })).json.uses, 2);

      fb.deployFails = true;
      const before = (await call(token, "search_effects", {})).json.total;
      const failed = await call(token, "deploy_effect", { effect_id: "x", source: "vec3 shade(Led led) { nope }" });
      assert.equal(failed.isError, true);
      assert.equal(failed.content.length, 1);
      assert.equal((await call(token, "search_effects", {})).json.total, before);
      const unknown = await call(token, "deploy_effect", { library_id: "fx_zzzzzzzz" });
      assert.equal(unknown.isError, true);
      assert.match(unknown.content[0]!.text, /no effect/);
    } finally {
      fb.link.stop();
    }
  });

  test("bridge offline: the library still works; initialize gets a relay session; 404 once the bridge is back", async () => {
    const fb = await fakeBridge();
    const token = await personalToken(fb);
    const id = (await call(token, "save_effect", OCEAN)).json.id as string;
    fb.link.stop();
    await until(async () => (await mcpPost(relay, token, { jsonrpc: "2.0", id: 1, method: "ping" })).status === 503, "offline");
    // An existing (bridge) session: library calls + tools/list still answer.
    const list = await rpc(await mcpPost(relay, token, { jsonrpc: "2.0", id: 2, method: "tools/list" }, { "mcp-session-id": "bridge-session-1" }), 2);
    assert.deepEqual(
      (list.result.tools as { name: string }[]).map((t) => t.name),
      LIBRARY_TOOLS.map((t) => t.name),
    );
    assert.equal((await call(token, "get_effect", { id }, { "mcp-session-id": "bridge-session-1" })).json.id, id);
    const dev = await mcpPost(relay, token, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "set_brightness", arguments: { level: 1 } } });
    assert.equal(dev.status, 503);

    // A real MCP client connecting now gets the relay's session: library only.
    const transport = new StreamableHTTPClientTransport(new URL(`${relay}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
    const c = new Client({ name: "offline-agent", version: "0" });
    await c.connect(transport as unknown as Parameters<Client["connect"]>[0]);
    const sid = transport.sessionId!;
    assert.match(sid, /^relay-/);
    assert.match(c.getInstructions() ?? "", /bridge for this connector is offline[\s\S]*search_effects/);
    assert.equal(c.getServerVersion()?.name, "splanc-relay");
    assert.deepEqual(
      (await c.listTools()).tools.map((t) => t.name),
      LIBRARY_TOOLS.map((t) => t.name),
    );
    const r = (await c.callTool({ name: "search_effects", arguments: { query: "ocean" } })) as { content: { text: string }[] };
    assert.equal(JSON.parse(r.content[0]!.text).results[0].id, id);
    await c.ping();
    await assert.rejects(c.callTool({ name: "set_brightness", arguments: {} }), /bridge is offline/);

    // The bridge comes back: the relay session ends (404 -> the client initializes again).
    fb.link.start();
    await until(() => fb.link.online, "back online");
    const stale = await mcpPost(relay, token, { jsonrpc: "2.0", id: 9, method: "tools/list" }, { "mcp-session-id": sid });
    assert.equal(stale.status, 404);
    // Library calls on it still answer (they never needed the bridge).
    assert.equal((await call(token, "get_effect", { id }, { "mcp-session-id": sid })).json.id, id);
    const del = await fetch(`${relay}/mcp`, { method: "DELETE", headers: { authorization: `Bearer ${token}`, "mcp-session-id": sid } });
    assert.equal(del.status, 204);
    await transport.close();
    fb.link.stop();
  });

  test("libraries are per bridge", async () => {
    const a = await fakeBridge();
    const b = await fakeBridge();
    try {
      const ta = await personalToken(a);
      const tb = await personalToken(b);
      const id = (await call(ta, "save_effect", OCEAN)).json.id as string;
      assert.equal((await call(tb, "get_effect", { id })).isError, true);
      const rows = (await call(tb, "search_effects", { query: "ocean swell" })).json.results as { id: string }[];
      assert.ok(!rows.some((r) => r.id === id));
    } finally {
      a.link.stop();
      b.link.stop();
    }
  });
});
