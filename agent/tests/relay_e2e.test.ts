/**
 * End to end: an MCP client (the SDK's Streamable HTTP client, as a cloud
 * agent's connector) -> relay -> bridge (outbound WebSocket) -> hub -> two fake
 * players. The client gets its token the way a connector does (dynamic client
 * registration, consent page + the pairing code from the bridge's status file,
 * PKCE token exchange).
 *
 * The relay is the in-process Node host by default. Set SPLANC_E2E_RELAY to run
 * the same test against another relay: `wrangler dev` (http://127.0.0.1:8787) or
 * the deployed Worker.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { SERVER_INSTRUCTIONS, TOOL_ANNOTATIONS } from "../src/annotations";
import { LanBridge, type BridgeStatus } from "../src/bridge/lanBridge";
import { RelayLink } from "../src/bridge/relayLink";
import { Hub } from "../src/hub";
import { RelayHost } from "../src/relayHost";
import { FakePlayer, yFixture } from "./fakePlayer";
import { connectorFlow, tempIdentity, until } from "./relayHelpers";

const SCRATCH = mkdtempSync(join(tmpdir(), "splanc-relay-e2e-"));
process.env["SPLANC_CONFIG_DIR"] = join(SCRATCH, "config");
process.env["SPLANC_CACHE_DIR"] = join(SCRATCH, "cache");
const STATUS = join(SCRATCH, "status.json");
const EXTERNAL = process.env["SPLANC_E2E_RELAY"];

let host: RelayHost | null = null;
let relay = "";
let players: FakePlayer[] = [];
let hub: Hub;
let bridge: LanBridge;
let link: RelayLink;

const status = () => JSON.parse(readFileSync(STATUS, "utf8")) as BridgeStatus;

type Text = { type: string; text?: string };

async function connect(token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${relay}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const c = new Client({ name: "e2e-cloud-agent", version: "0" });
  // (The SDK's own types disagree under exactOptionalPropertyTypes: sessionId?: string.)
  await c.connect(transport as unknown as Parameters<Client["connect"]>[0]);
  return c;
}

async function call(c: Client, name: string, args: Record<string, unknown> = {}) {
  const r = (await c.callTool({ name, arguments: args })) as { isError?: boolean; content: Text[] };
  return { isError: r.isError === true, json: JSON.parse(r.content.find((x) => x.type === "text")?.text ?? "null") as any };
}

before(async () => {
  if (EXTERNAL) relay = EXTERNAL.replace(/\/+$/, "");
  else {
    host = new RelayHost();
    relay = await host.listen();
  }
  for (const [i, name] of ["Kitchen", "Hall"].entries()) {
    const p = new FakePlayer({ name, mac: `CC:FD:49:00:01:0${i}` });
    p.bundle = yFixture();
    await p.start();
    p.serveManifest();
    players.push(p);
  }
  hub = new Hub({
    root: "",
    hosts: players.map((p) => p.host),
    mdns: false,
    config: { players: {}, groups: {}, poses: {} },
    persist: () => undefined,
    registryDeps: { sweepHosts: () => [] },
  });
  const { identity } = tempIdentity();
  link = new RelayLink({ relay, identity, backoff: { baseMs: 100, maxMs: 2000 } });
  bridge = new LanBridge({ link, hub, statusPath: STATUS, controlPath: join(SCRATCH, "control.sock"), refreshMs: 0 });
  await bridge.start();
});

after(async () => {
  await bridge.stop();
  hub.close();
  for (const p of players) await p.stop();
  await host?.close();
  players = [];
});

test("cloud agent -> relay -> bridge -> players", async () => {
  // The person reads the code off the bridge's display (here: its status file).
  const s = await until(() => {
    const x = status();
    return x.state === "pairing" && x.players.length === 2 ? x : null;
  }, "bridge showing a pairing code", 20_000);
  const { tokens } = await connectorFlow(relay, s.pairing!.code);
  await until(() => status().state === "paired", "paired");

  const c = await connect(tokens["access_token"]!);
  try {
    const tools = await c.listTools();
    assert.ok(tools.tools.some((t) => t.name === "set_brightness"));
    // Annotations + instructions come from the bridge's agent, unchanged by the relay.
    for (const t of tools.tools) assert.deepEqual(t.annotations, TOOL_ANNOTATIONS[t.name], t.name);
    assert.equal(c.getInstructions(), SERVER_INSTRUCTIONS);
    const list = await call(c, "list_players");
    assert.equal(list.isError, false);
    assert.deepEqual(
      (list.json.players as { name: string }[]).map((p) => p.name).sort(),
      ["Hall", "Kitchen"],
    );
    const set = await call(c, "set_brightness", { level: 0.4, players: "all" });
    assert.equal(set.isError, false, JSON.stringify(set.json));
    assert.deepEqual(
      players.map((p) => p.brightness),
      [0.4, 0.4],
    );
    // A long tool's progress notifications cross the relay while it runs (SSE).
    const seen: string[] = [];
    const m = (await c.callTool({ name: "measure_effect", arguments: { seconds: 1, players: "Kitchen" } }, undefined, {
      onprogress: (p: { message?: string | undefined }) => void (p.message && seen.push(p.message)),
    })) as { isError?: boolean };
    assert.equal(m.isError, undefined);
    assert.ok(seen.some((x) => /measuring for 1 s/.test(x)), `progress seen: ${JSON.stringify(seen)}`);
    const res = await c.readResource({ uri: "splanc://players" });
    assert.match((res.contents[0] as { text: string }).text, /Kitchen/);
    await until(() => status().clients === 1, "status counts the cloud session");
  } finally {
    await c.close();
  }

  // A bridge restart loses its MCP sessions: the old session id gets 404 (the
  // client re-initializes), a fresh connection works straight away.
  const c2 = await connect(tokens["access_token"]!);
  const sid = (c2.transport as StreamableHTTPClientTransport).sessionId!;
  await bridge.stop();
  bridge = new LanBridge({ link, hub, statusPath: STATUS, controlPath: join(SCRATCH, "control.sock"), refreshMs: 0 });
  await bridge.start();
  await until(() => link.online, "bridge back");
  const stale = await fetch(`${relay}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${tokens["access_token"]}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": sid,
      "mcp-protocol-version": "2025-11-25",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }),
  });
  assert.equal(stale.status, 404);
  const c3 = await connect(tokens["access_token"]!);
  assert.equal((await call(c3, "list_players")).isError, false);
  await c3.close();
});

test("liveness: pings are answered, so an idle link stays up (no reconnect churn)", async () => {
  const { identity } = tempIdentity();
  const idle = new RelayLink({ relay, identity, pingMs: 250, backoff: { baseMs: 100, maxMs: 1000 } });
  idle.start();
  try {
    await until(() => idle.online, "idle link online");
    // > 3 ping intervals: a link whose pings went unanswered would have been torn down.
    await new Promise((r) => setTimeout(r, 2000));
    assert.equal(idle.online, true);
    assert.equal(idle.connects, 1);
  } finally {
    idle.stop();
  }
});
