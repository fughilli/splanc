/**
 * Agent feedback on the agent side (docs/design/agent-feedback.md):
 *
 * - the relay's private store: not configured -> 503; intake (validated,
 *   scrubbed again, signature recomputed), an idempotent retry, a conflicting
 *   id; admin-only listing / reading / status; the reporter's status and
 *   deletion with the receipt; per-IP limits;
 * - file_bug submit="private" on the hub: a draft with this session's tool
 *   calls first, sent to the private store only once the user confirmed, and
 *   never a public link when it can't be sent;
 * - triage: grouping, rendering, and REPLAY of a recorded in-app trace against
 *   the FakePlayer (the "claimed Pushed, nothing was sent" case), plus the
 *   divergence check across runs, and the committed regression fixture.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { TurnRecorder, buildFeedbackReport, type FeedbackReport } from "../../web/src/feedback/agentTrace";
import { groupReports, readReportFile, renderReplay, renderReport, replayReport, summaryOf } from "../src/feedback";
import { hubCaller } from "../src/feedbackCli";
import { loadFxHost } from "../src/fxhost";
import { Hub } from "../src/hub";
import { RelayHost } from "../src/relayHost";
import { createServer } from "../src/server";
import { FIXTURES, FakePlayer, yFixture } from "./fakePlayer";

const WASM_ROOT = resolve(process.env["AGENT_WASM_ROOT"] ?? "wasm");
const SCRATCH = mkdtempSync(join(tmpdir(), "splanc-feedback-test-"));
process.env["SPLANC_CACHE_DIR"] = join(SCRATCH, "cache");
process.env["SPLANC_CONFIG_DIR"] = join(SCRATCH, "config");

const ADMIN = "test-feedback-admin-token";
const EFFECT = "vec3 shade(Led led) { return vec3(0.0, 0.0, 1.0); }\n";

let host: RelayHost;
let bareHost: RelayHost;
let relay = "";
let bare = "";

before(async () => {
  await loadFxHost(WASM_ROOT);
  host = new RelayHost({ trustProxy: true, bugs: { FEEDBACK_ADMIN_TOKEN: ADMIN } });
  relay = await host.listen();
  bareHost = new RelayHost({ trustProxy: true });
  bare = await bareHost.listen();
});

after(async () => {
  await host.close();
  await bareHost.close();
});

/** The in-app trace of the motivating failure: set_script compiled, the app said
 * NOT SENT (no fixture connected), and the reply claimed "Pushed". */
function claimedPushedReport(id = "fbtest0000001"): FeedbackReport {
  let t = 0;
  const r = new TurnRecorder({ turn: 1, ask: "make it blue", sourceBefore: "", now: () => t });
  r.onPrompt({ system: "system prompt v1", tools: ["set_script"] });
  r.onTrace({ kind: "round", round: 1 });
  r.onTrace({ kind: "tool_call", name: "set_script", input: { source: EFFECT, summary: "blue" } });
  t += 80;
  r.onTrace({ kind: "tool_result", name: "set_script", text: "Compile result: OK — 0 uniforms\n\nDevice: NOT SENT: no fixture is connected.", isError: false });
  r.onTrace({ kind: "round", round: 2 });
  r.onTrace({ kind: "out", text: "Pushed! It's playing on your fixture now." });
  const turn = r.finish({ reply: "Pushed! It's playing on your fixture now.", outcome: "complete", sourceAfter: EFFECT });
  return buildFeedbackReport({
    id,
    surface: "web-editor",
    reasons: ["false_claim", "not_sent"],
    note: "said pushed, lamp unchanged. my wifi password: hunter2",
    turn: 1,
    turns: [turn],
    conversation: [
      { role: "user", text: "make it blue" },
      { role: "assistant", text: turn.reply },
    ],
    app: { version: "1.14.0", commit: "abc1234", browser: "Chrome 131 on Android" },
    ai: { kind: "cloud", vendor: "anthropic", model: "test-model" },
    devices: [{ board: "esp32c6", firmware: "1.14.0", features: ["effects"], channels: 1, led_count: 64 }],
    applog: [],
  });
}

let ipSeq = 0;
const post = async (base: string, body: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(`${base}/feedback`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `198.51.100.${++ipSeq}`, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
};
const admin = { authorization: `Bearer ${ADMIN}` };

describe("the relay's private feedback store", () => {
  test("not configured: 503, nothing stored", async () => {
    const r = await post(bare, claimedPushedReport());
    assert.equal(r.status, 503);
    assert.equal(r.json["error"], "not_configured");
  });

  test("intake, retry, conflict, admin reads, reporter status + delete", async () => {
    const rep = claimedPushedReport("fbtest0000002");
    const a = await post(relay, rep);
    assert.equal(a.status, 201, JSON.stringify(a.json));
    const receipt = String(a.json["receipt"]);
    assert.ok(receipt.length > 10);
    // The same report again (a retry): same receipt, no second record.
    const again = await post(relay, rep);
    assert.equal(again.status, 200);
    assert.equal(again.json["receipt"], receipt);
    // A different report with that id: refused.
    assert.equal((await post(relay, { ...rep, note: "other" })).status, 409);

    // Stored scrubbed (the client scrubbed already; the relay does again).
    const stored = JSON.stringify(host.storageOf("directory", "global")?.get("fb:fbtest0000002"));
    assert.ok(stored && !stored.includes("hunter2"));

    // Listing / reading needs the admin token.
    assert.equal((await fetch(`${relay}/feedback`)).status, 401);
    assert.equal((await fetch(`${relay}/feedback`, { headers: { authorization: "Bearer nope" } })).status, 401);
    const list = (await (await fetch(`${relay}/feedback`, { headers: admin })).json()) as { items: { id: string; signature: string; via: string; from: string }[] };
    const row = list.items.find((i) => i.id === "fbtest0000002")!;
    assert.equal(row.signature, rep.signature);
    assert.equal(row.via, "anonymous");
    assert.ok(!row.from.includes("198.51.100"), "never the IP");
    const one = (await (await fetch(`${relay}/feedback?id=fbtest0000002`, { headers: admin })).json()) as { report: FeedbackReport };
    assert.deepEqual(one.report.flags, ["claimed_sent_not_sent"]);

    // The reporter's view, with the receipt only.
    const status = (h: Record<string, string>) => fetch(`${relay}/feedback/status?id=fbtest0000002`, { headers: h });
    assert.equal((await status({})).status, 401);
    assert.equal((await status({ "x-splanc-receipt": "forged" })).status, 401);
    assert.equal(((await (await status({ "x-splanc-receipt": receipt })).json()) as { status: string }).status, "received");
    const set = await fetch(`${relay}/feedback/status`, {
      method: "POST",
      headers: { ...admin, "content-type": "application/json" },
      body: JSON.stringify({ id: "fbtest0000002", status: "fixed", fixed_in: "1.15.0", message: "thanks!" }),
    });
    assert.equal(set.status, 200);
    const s2 = (await (await status({ "x-splanc-receipt": receipt })).json()) as Record<string, string>;
    assert.deepEqual([s2["status"], s2["fixed_in"], s2["message"]], ["fixed", "1.15.0", "thanks!"]);
    // Setting a status is admin-only.
    const notAdmin = await fetch(`${relay}/feedback/status`, { method: "POST", headers: { "x-splanc-receipt": receipt }, body: JSON.stringify({ id: "fbtest0000002", status: "wontfix" }) });
    assert.equal(notAdmin.status, 401);

    // Deletion on request: the receipt is enough.
    const del = await fetch(`${relay}/feedback?id=fbtest0000002`, { method: "DELETE", headers: { "x-splanc-receipt": receipt } });
    assert.equal(del.status, 200);
    assert.equal((await status({ "x-splanc-receipt": receipt })).status, 404);
    assert.equal(host.storageOf("directory", "global")?.get("fb:fbtest0000002"), undefined);
  });

  test("invalid reports are refused; anonymous callers are rate limited per IP", async () => {
    assert.equal((await post(relay, "{nope")).status, 400);
    assert.equal((await post(relay, { ...claimedPushedReport(), reasons: [] })).status, 400);
    const ip = { "x-forwarded-for": "203.0.113.77" };
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) codes.push((await post(relay, claimedPushedReport(`fbratelimit${i}0`), ip)).status);
    assert.deepEqual(codes.slice(0, 6), [201, 201, 201, 201, 201, 201]);
    assert.equal(codes[6], 429);
  });
});

// -- the hub's file_bug submit=private -----------------------------------------------------

describe("file_bug submit=private (MCP side)", () => {
  let player: FakePlayer;
  let hub: Hub;
  before(async () => {
    player = new FakePlayer({ name: "Kitchen Lamp" });
    player.bundle = yFixture();
    await player.start();
    player.serveManifest();
    hub = new Hub({ root: WASM_ROOT, hosts: [player.host], mdns: false, config: { players: {}, groups: {}, poses: {} }, persist: () => undefined, registryDeps: { sweepHosts: () => [] } });
  });
  after(async () => {
    hub.close();
    await player.stop();
  });

  async function client(relayBase: string): Promise<Client> {
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createServer(hub, { bugs: { surface: "mcp", relay: relayBase, duplicates: async () => ({ candidates: [] }) } }).connect(a);
    const c = new Client({ name: "feedback-test", version: "0" });
    await c.connect(b);
    return c;
  }
  const call = async (c: Client, name: string, args: Record<string, unknown>) => {
    const r = (await c.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { isError: r.isError === true, text: r.content[0]?.text ?? "" };
  };
  const ARGS = { title: "Said it deployed, nothing changed", description: "the agent said the effect was live", severity: "medium", reasons: ["false_claim"] };

  test("a draft with this session's tool calls; sent privately only after the user agreed", async () => {
    const c = await client(relay);
    const dep = await call(c, "deploy_effect", { effect_id: "blue", source: EFFECT });
    assert.equal(dep.isError, false, dep.text);
    const draft = JSON.parse((await call(c, "file_bug", { ...ARGS, submit: "private" })).text) as { status: string; report: FeedbackReport };
    assert.equal(draft.status, "draft");
    assert.equal(draft.report.surface, "mcp");
    const tools = draft.report.sections.trace![0]!.tools;
    assert.deepEqual(tools.map((t) => t.name), ["deploy_effect"]);
    assert.equal(tools[0]!.delivery, "sent");
    const s = JSON.stringify(draft.report);
    assert.ok(!s.includes("Kitchen Lamp") && !s.includes(player.mac), "no player name or MAC");

    const sent = JSON.parse((await call(c, "file_bug", { ...ARGS, submit: "private", user_confirmed: true })).text) as { status: string; id: string; receipt: string };
    assert.equal(sent.status, "sent_privately", JSON.stringify(sent));
    assert.ok(host.storageOf("directory", "global")?.get(`fb:${sent.id}`));
    await c.close();
  });

  test("can't be sent privately: no public link, the report is handed back", async () => {
    const c = await client(bare);
    const r = JSON.parse((await call(c, "file_bug", { ...ARGS, submit: "private", user_confirmed: true })).text) as Record<string, unknown>;
    assert.equal(r["status"], "not_sent");
    assert.equal(r["reason"], "not_configured");
    assert.equal(r["submit_url"], undefined);
    assert.ok(r["report"]);
    await c.close();
  });
});

// -- triage + replay -----------------------------------------------------------------------

describe("triage", () => {
  test("groups by signature and renders a report", () => {
    const a = claimedPushedReport("fbgroup00001");
    const b = claimedPushedReport("fbgroup00002");
    const groups = groupReports([summaryOf(a), summaryOf(b)]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0]!.count, 2);
    assert.equal(groups[0]!.tool, "set_script");
    const text = renderReport(a);
    assert.match(text, /set_script .*NOT SENT/);
    assert.match(text, /claimed_sent_not_sent/);
  });

  test("replay against the FakePlayer: the effect the app reported NOT SENT is accepted by a fresh fixture", async () => {
    const player = new FakePlayer();
    player.bundle = yFixture();
    await player.start();
    player.serveManifest();
    const hub = new Hub({ root: WASM_ROOT, hosts: [player.host], mdns: false, config: { players: {}, groups: {}, poses: {} }, persist: () => undefined, registryDeps: { sweepHosts: () => [] } });
    try {
      const call = await hubCaller(hub);
      const uploads = () => player.received.filter((m) => m.type === "submit_effect").length;
      const res = await replayReport(claimedPushedReport(), 3, { call, uploads });
      assert.equal(res.steps.length, 1);
      assert.equal(res.steps[0]!.call?.name, "deploy_effect");
      assert.deepEqual(res.runs.map((r) => r.outcomes[0]), ["ok/ok/sent", "ok/ok/sent", "ok/ok/sent"]);
      assert.equal(res.failingStep, 0);
      assert.equal(res.reproduced, 0, "the tool path doesn't reproduce: the fault was the app's connection + the model's claim");
      assert.equal(res.divergesAt, -1);
      assert.equal(res.differsFromRecordingAt, 0);
      assert.deepEqual(res.runs.map((r) => r.uploads), [1, 1, 1]);
      const text = renderReplay(res);
      assert.match(text, /fresh fixture accepted/);
      assert.match(text, /false claim is the model's/);
    } finally {
      hub.close();
      await player.stop();
    }
  });

  test("runs that disagree are reported as a divergence", async () => {
    let n = 0;
    const res = await replayReport(claimedPushedReport(), 4, {
      call: async () => (n++ % 2 ? { isError: true, text: "nothing deployed: upload timed out" } : { isError: false, text: "{}" }),
    });
    assert.equal(res.divergesAt, 0);
    assert.equal(res.reproduced, 2);
    assert.ok(res.findings.some((f) => /diverge at step 1/.test(f)));
  });

  test("the committed regression fixture replays as its expected outcome", async () => {
    const path = join(FIXTURES, "feedback", "claimed-pushed-not-sent.json");
    const [rep] = readReportFile(path);
    const fixture = JSON.parse((await import("node:fs")).readFileSync(path, "utf8")) as { expect: { failing_step: number; failing_step_outcome: string } };
    const player = new FakePlayer();
    player.bundle = yFixture();
    await player.start();
    player.serveManifest();
    const hub = new Hub({ root: WASM_ROOT, hosts: [player.host], mdns: false, config: { players: {}, groups: {}, poses: {} }, persist: () => undefined, registryDeps: { sweepHosts: () => [] } });
    try {
      const res = await replayReport(rep!, 1, { call: await hubCaller(hub) });
      assert.equal(res.failingStep, fixture.expect.failing_step);
      assert.equal(res.runs[0]!.outcomes[res.failingStep], fixture.expect.failing_step_outcome);
    } finally {
      hub.close();
      await player.stop();
    }
  });
});
