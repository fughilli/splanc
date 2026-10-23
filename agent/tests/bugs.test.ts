/**
 * file_bug end to end on the agent side (docs/design/agent-bug-reports.md), with a
 * mock GitHub API on 127.0.0.1 — nothing reaches github.com:
 *
 * - the relay's POST /bugs: not configured -> 503; filed with the Worker's token,
 *   labels agent-filed + severity, the footer marker, scrubbed again; caps; GitHub
 *   refusing labels -> filed unlabelled; credentials: a relay token or a bridge
 *   signature (per-bridge limit), anonymous (per-IP limit); bad credentials -> 401.
 * - the relay-served file_bug on /mcp: while the bridge is offline, and for a
 *   bridge without its own; a bridge with file_bug gets the call itself.
 * - the hub's file_bug (stdio/CLI/bridge): diagnostics, a link by default, direct
 *   filing through the relay signed as the bridge.
 */

import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { AGENT_FILED_MARKER, buildIssue, parseBugInput, type FileBugResult } from "../../web/src/bugs/bugReport";
import type { RelayFrame, StateFrame } from "../relay/src/protocol";
import { RelayLink } from "../src/bridge/relayLink";
import { bridgeSigner } from "../src/bugs";
import { Hub } from "../src/hub";
import { RelayHost } from "../src/relayHost";
import { createServer } from "../src/server";
import { mcpPost, tempIdentity, until } from "./relayHelpers";

// -- a mock GitHub ---------------------------------------------------------------------

interface Filed {
  auth: string;
  title: string;
  body: string;
  labels?: string[];
}

const gh = {
  filed: [] as Filed[],
  rejectLabels: false,
  searches: [] as string[],
  items: [] as { number: number; title: string; html_url: string }[],
};

const github = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    const send = (status: number, obj: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    const url = new URL(req.url ?? "/", "http://gh");
    if (req.method === "GET" && url.pathname === "/search/issues") {
      gh.searches.push(url.searchParams.get("q") ?? "");
      return send(200, { items: gh.items });
    }
    if (req.method === "POST" && url.pathname === "/repos/fughilli/splanc/issues") {
      const j = JSON.parse(body) as Filed;
      if (gh.rejectLabels && j.labels) return send(422, { message: "Validation Failed" });
      const n = 1000 + gh.filed.length;
      gh.filed.push({ ...j, auth: String(req.headers["authorization"]) });
      return send(201, { number: n, html_url: `https://github.com/fughilli/splanc/issues/${n}` });
    }
    send(404, { message: "Not Found" });
  });
});

let api = "";
let relay = "";
let bare = ""; // a relay without the secret
let host: RelayHost;
let bareHost: RelayHost;

before(async () => {
  await new Promise<void>((r) => github.listen(0, "127.0.0.1", () => r()));
  api = `http://127.0.0.1:${(github.address() as AddressInfo).port}`;
  host = new RelayHost({ trustProxy: true, bugs: { GITHUB_ISSUES_TOKEN: "test-issues-token", GITHUB_API_URL: api } });
  relay = await host.listen();
  bareHost = new RelayHost();
  bare = await bareHost.listen();
});

after(async () => {
  await host.close();
  await bareHost.close();
  await new Promise<void>((r) => github.close(() => r()));
});

const ISSUE = buildIssue(
  parseBugInput({
    title: "Crossfade freezes the strip",
    description: "crossfade_to with 5 s freezes the fixture; wifi_password=hunter2 was in the log",
    severity: "high",
  }),
  { firmware: "1.10.0" },
  "mcp",
);

let ipSeq = 0;
const freshIp = () => `203.0.113.${++ipSeq}`;

async function postBug(base: string, payload: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${base}/bugs`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": freshIp(), ...headers },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}

const payload = (extra: Record<string, unknown> = {}) => ({
  title: ISSUE.title,
  body: ISSUE.body,
  severity: ISSUE.severity,
  surface: "mcp",
  ...extra,
});

// -- a bridge on the relay ------------------------------------------------------------------

interface FakeBridge {
  link: RelayLink;
  calls: string[];
  identity: ReturnType<typeof tempIdentity>["identity"];
  frames: RelayFrame[];
}

async function fakeBridge(tools: { name: string }[]): Promise<FakeBridge> {
  const { identity } = tempIdentity();
  const link = new RelayLink({ relay, identity, backoff: { baseMs: 20, maxMs: 200 } });
  const fb: FakeBridge = { link, calls: [], identity, frames: [] };
  link.onFrame = (f) => {
    fb.frames.push(f);
    if (f.t !== "req") return;
    const m = JSON.parse(f.body || "null") as { id?: number; method: string; params?: { name?: string } };
    if (m.id === undefined) {
      link.send({ t: "res", id: f.id, status: 202, headers: {}, end: true });
      return;
    }
    let result: unknown;
    if (m.method === "tools/list") result = { tools: tools.map((t) => ({ ...t, description: "bridge", inputSchema: { type: "object" } })) };
    else {
      fb.calls.push(m.params?.name ?? m.method);
      result = { content: [{ type: "text", text: JSON.stringify({ bridge: m.params?.name }) }] };
    }
    link.send({ t: "res", id: f.id, status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: m.id, result }), end: true });
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

let rpcId = 0;
async function fileBugAtRelay(token: string, args: Record<string, unknown>): Promise<FileBugResult & { bridge?: string }> {
  const id = ++rpcId;
  const r = await mcpPost(relay, token, { jsonrpc: "2.0", id, method: "tools/call", params: { name: "file_bug", arguments: args } });
  assert.equal(r.status, 200);
  const msg = (await r.json()) as { result: { content: { text: string }[]; isError?: boolean } };
  assert.notEqual(msg.result.isError, true, msg.result.content[0]!.text);
  return JSON.parse(msg.result.content[0]!.text) as FileBugResult & { bridge?: string };
}

const REPORT = { title: "Preview and fixture disagree on hue", description: "The fixture is green where the preview is blue.", severity: "medium" };

// -- POST /bugs ------------------------------------------------------------------------------

describe("POST /bugs", () => {
  test("not configured: 503 not_configured, before anything else", async () => {
    const r = await postBug(bare, payload());
    assert.equal(r.status, 503);
    assert.equal(r.json["error"], "not_configured");
    assert.match(String(r.json["message"]), /GITHUB_ISSUES_TOKEN/);
  });

  test("files with the Worker's token: labels, footer marker, scrubbed again; the token never comes back", async () => {
    const n = gh.filed.length;
    const r = await postBug(relay, payload({ body: "Steps: set password=hunter2 then deploy (device 192.168.4.20)" }));
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal(r.json["number"], 1000 + n);
    assert.match(String(r.json["url"]), /\/issues\/\d+$/);
    const f = gh.filed[n]!;
    assert.equal(f.auth, "Bearer test-issues-token");
    assert.deepEqual(f.labels, ["agent-filed", "severity:high"]);
    assert.ok(f.body.includes(AGENT_FILED_MARKER), "marker footer added");
    assert.doesNotMatch(f.body, /hunter2|192\.168\.4\.20/);
    assert.ok(!JSON.stringify(r.json).includes("test-issues-token"));
  });

  test("caps and validation", async () => {
    assert.equal((await postBug(relay, payload({ body: "x".repeat(30_001) }))).status, 413);
    assert.equal((await postBug(relay, JSON.stringify({ ...payload(), pad: "y".repeat(70_000) }))).status, 413);
    assert.equal((await postBug(relay, payload({ title: "" }))).status, 400);
    assert.equal((await postBug(relay, payload({ severity: "urgent" }))).status, 400);
    assert.equal((await postBug(relay, "not json")).status, 400);
    const get = await fetch(`${relay}/bugs`);
    assert.equal(get.status, 405);
  });

  test("GitHub refusing the labels: filed unlabelled", async () => {
    gh.rejectLabels = true;
    try {
      const n = gh.filed.length;
      const r = await postBug(relay, payload());
      assert.equal(r.status, 201);
      assert.deepEqual(r.json["labels"], []);
      assert.equal(gh.filed[n]!.labels, undefined);
    } finally {
      gh.rejectLabels = false;
    }
  });

  test("anonymous: per-IP limit (3 an hour)", async () => {
    const ip = "198.51.100.77";
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await postBug(relay, payload(), { "x-forwarded-for": ip })).status);
    assert.deepEqual(codes, [201, 201, 201, 429]);
    // Another address is its own bucket.
    assert.equal((await postBug(relay, payload(), { "x-forwarded-for": "198.51.100.78" })).status, 201);
  });

  test("a relay token: per-bridge limit (5 an hour) whatever the IP; a bad token is refused", async () => {
    const fb = await fakeBridge([{ name: "set_brightness" }]);
    try {
      const token = await personalToken(fb);
      const codes: number[] = [];
      for (let i = 0; i < 6; i++) codes.push((await postBug(relay, payload(), { authorization: `Bearer ${token}` })).status);
      assert.deepEqual(codes, [201, 201, 201, 201, 201, 429]);
      const forged = token.replace(/_[A-Za-z0-9_-]{43}$/, `_${"A".repeat(43)}`);
      assert.equal((await postBug(relay, payload(), { authorization: `Bearer ${forged}` })).status, 401);
      assert.equal((await postBug(relay, payload(), { authorization: "Bearer nonsense" })).status, 401);
    } finally {
      fb.link.stop();
    }
  });

  test("a bridge signature: verified against the bridge's key, bound to the body", async () => {
    const fb = await fakeBridge([]);
    try {
      const sign = bridgeSigner(fb.identity, relay);
      const body = JSON.stringify(payload());
      const headers = await sign(body);
      assert.ok(headers["x-splanc-bridge-bug"], "registered bridge signs");
      const ok = await postBug(relay, body, headers);
      assert.equal(ok.status, 201, JSON.stringify(ok.json));
      // The same signature over a different body is refused.
      const other = JSON.stringify(payload({ title: "something else" }));
      assert.equal((await postBug(relay, other, headers)).status, 401);
      // Counted against the bridge, not the IP.
      const bid = fb.identity.bridgeId(relay)!;
      const counted = [...(host.storageOf("directory", "global")?.keys() ?? [])].some((k) => k.startsWith("rl:bugBridge:") && k.endsWith(`:${bid}`));
      assert.ok(counted);
    } finally {
      fb.link.stop();
    }
  });
});

// -- file_bug at the relay ------------------------------------------------------------------

describe("file_bug on the relay's /mcp", () => {
  test("a bridge without file_bug: the relay lists and serves it (link by default, direct when confirmed)", async () => {
    const fb = await fakeBridge([{ name: "set_brightness" }]);
    try {
      const token = await personalToken(fb);
      const list = (await (await mcpPost(relay, token, { jsonrpc: "2.0", id: 1, method: "tools/list" })).json()) as { result: { tools: { name: string; annotations?: { openWorldHint?: boolean } }[] } };
      const fbTool = list.result.tools.find((t) => t.name === "file_bug");
      assert.ok(fbTool, "file_bug listed");
      assert.equal(fbTool.annotations?.openWorldHint, true);

      gh.items = [{ number: 42, title: "Preview and fixture disagree", html_url: "https://github.com/fughilli/splanc/issues/42" }];
      const draft = await fileBugAtRelay(token, REPORT);
      assert.equal(draft.status, "possible_duplicates");
      assert.equal(draft.duplicates[0]!.number, 42);
      assert.match(draft.submit_url!, /^https:\/\/github\.com\/fughilli\/splanc\/issues\/new\?/);
      assert.match(draft.report.body, /"bridge": "online \(too old/);
      assert.ok(gh.searches.at(-1)!.startsWith("repo:fughilli/splanc is:issue is:open"));
      gh.items = [];

      const n = gh.filed.length;
      const filed = await fileBugAtRelay(token, { ...REPORT, submit: "direct", user_confirmed: true });
      assert.equal(filed.status, "filed");
      assert.equal(filed.issue!.number, 1000 + n);
      assert.match(gh.filed[n]!.body, /through Splanc \(relay\)/);
      assert.deepEqual(fb.calls, [], "never reached the bridge");
    } finally {
      fb.link.stop();
    }
  });

  test("a bridge with its own file_bug gets the call (it adds device diagnostics)", async () => {
    const fb = await fakeBridge([{ name: "set_brightness" }, { name: "file_bug" }]);
    try {
      const token = await personalToken(fb);
      const list = (await (await mcpPost(relay, token, { jsonrpc: "2.0", id: 1, method: "tools/list" })).json()) as { result: { tools: { name: string; description: string }[] } };
      assert.equal(list.result.tools.filter((t) => t.name === "file_bug").length, 1);
      assert.equal(list.result.tools.find((t) => t.name === "file_bug")!.description, "bridge");
      const r = await fileBugAtRelay(token, REPORT);
      assert.equal(r.bridge, "file_bug");
      assert.deepEqual(fb.calls, ["file_bug"]);
    } finally {
      fb.link.stop();
    }
  });

  test("bridge offline: file_bug still answers (offline diagnostics)", async () => {
    const fb = await fakeBridge([{ name: "set_brightness" }, { name: "file_bug" }]);
    const token = await personalToken(fb);
    await mcpPost(relay, token, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    fb.link.stop();
    await until(async () => (await mcpPost(relay, token, { jsonrpc: "2.0", id: 2, method: "ping" })).status === 503, "offline");
    const r = await fileBugAtRelay(token, REPORT);
    assert.equal(r.status, "draft");
    assert.match(r.report.body, /"bridge": "offline"/);
  });
});

// -- the hub's file_bug ---------------------------------------------------------------------

describe("file_bug on the hub (stdio / bridge)", () => {
  // No players and nothing to sweep (the diagnostics must not probe the LAN here).
  const emptyHub = () =>
    new Hub({ root: "", mdns: false, config: { players: {}, groups: {}, poses: {} }, persist: () => undefined, registryDeps: { sweepHosts: () => [] } });

  async function client(opts: Parameters<typeof createServer>[1]): Promise<Client> {
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createServer(emptyHub(), opts).connect(a);
    const c = new Client({ name: "bug-test", version: "0" });
    await c.connect(b);
    return c;
  }

  const call = async (c: Client, args: Record<string, unknown>) => {
    const r = (await c.callTool({ name: "file_bug", arguments: args })) as { content: { text: string }[]; isError?: boolean };
    assert.notEqual(r.isError, true, r.content[0]!.text);
    return JSON.parse(r.content[0]!.text) as FileBugResult;
  };

  test("a link by default, with the hub's diagnostics; direct filing signed as the bridge", async () => {
    const fb = await fakeBridge([]);
    try {
      const c = await client({
        bugs: { surface: "bridge", relay, signer: bridgeSigner(fb.identity, relay), duplicates: async () => ({ candidates: [] }) },
      });
      const draft = await call(c, REPORT);
      assert.equal(draft.status, "draft");
      assert.match(draft.report.body, /"agent": \{/);
      assert.match(draft.report.body, /"platform": "/);
      assert.match(draft.report.body, /through Splanc \(bridge\)/);

      const asks = await call(c, { ...REPORT, submit: "direct" });
      assert.equal(asks.direct?.reason, "needs_confirmation");

      const n = gh.filed.length;
      const filed = await call(c, { ...REPORT, submit: "direct", user_confirmed: true });
      assert.equal(filed.status, "filed", JSON.stringify(filed));
      assert.equal(gh.filed.length, n + 1);
      await c.close();
    } finally {
      fb.link.stop();
    }
  });

  test("the relay not configured: direct falls back to the link", async () => {
    const c = await client({ bugs: { surface: "mcp", relay: bare, duplicates: async () => ({ candidates: [] }) } });
    const r = await call(c, { ...REPORT, submit: "direct", user_confirmed: true });
    assert.equal(r.status, "draft");
    assert.equal(r.direct?.reason, "not_configured");
    assert.ok(r.submit_url);
    await c.close();
  });
});
