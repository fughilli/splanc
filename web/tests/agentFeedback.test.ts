/**
 * Agent feedback (docs/design/agent-feedback.md): the turn recorder and its
 * automatic findings, the report (redaction, per-section opt-out, size bounds,
 * the grouping signature), intake validation, the offline outbox (queue, send,
 * backoff, rejection, receipts, status) and the relay client.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  FEEDBACK_LIMITS,
  TRACE_SCHEMA,
  TurnHistory,
  TurnRecorder,
  buildFeedbackReport,
  deliveryOf,
  errorClass,
  feedbackSignal,
  feedbackSignature,
  newFeedbackId,
  validateFeedbackReport,
  type FeedbackInput,
  type TurnTrace,
} from "../src/feedback/agentTrace";
import { RECEIPT_HEADER, deleteFeedback, fetchFeedbackStatus, submitFeedback } from "../src/feedback/feedbackClient";
import { FeedbackQueue, QUEUE_LIMITS, backoffMs, receiptStatusText, type KeyValue, type SubmitResult } from "../src/feedback/feedbackQueue";

// -- helpers ---------------------------------------------------------------------------

function clock(start = 0) {
  let t = start;
  return { now: () => t, tick: (ms: number) => (t += ms) };
}

/** One recorded turn: set_script → NOT SENT, then a reply claiming it was pushed. */
function falseClaimTurn(turn = 1): TurnTrace {
  const c = clock();
  const r = new TurnRecorder({ turn, ask: "make it blue", sourceBefore: "vec3 shade(Led l){return vec3(1.0);}", now: c.now, date: () => new Date("2026-11-18T10:00:00Z") });
  r.onPrompt({ system: "You are the Splanc effect assistant.", tools: ["set_script", "estimate_performance"] });
  r.onTrace({ kind: "round", round: 1 });
  r.onTrace({ kind: "in", text: "Current editor script…" });
  r.onTrace({ kind: "tool_call", name: "set_script", input: { source: "vec3 shade(Led l){return vec3(0,0,1);}", summary: "blue" } });
  c.tick(120);
  r.onTrace({
    kind: "tool_result",
    name: "set_script",
    text: "Compile result: OK — 0 uniforms\n\nDevice: NOT SENT: no fixture is connected. Nothing new is playing on the lights.",
    isError: false,
  });
  r.onTrace({ kind: "round", round: 2 });
  c.tick(900);
  r.onTrace({ kind: "out", text: "Pushed! Your fixture is now playing a calm blue." });
  return r.finish({ reply: "Pushed! Your fixture is now playing a calm blue.", outcome: "complete", sourceAfter: "vec3 shade(Led l){return vec3(0,0,1);}" });
}

function input(over: Partial<FeedbackInput> = {}): FeedbackInput {
  const t = falseClaimTurn();
  return {
    id: "fb_test_0001",
    createdAt: "2026-11-18T10:01:00Z",
    surface: "web-editor",
    reasons: ["false_claim"],
    note: "it said pushed but my lamp didn't change",
    turn: 1,
    turns: [t],
    conversation: [
      { role: "user", text: "make it blue" },
      { role: "tool", text: "compiled" },
      { role: "assistant", text: t.reply },
    ],
    app: { version: "1.14.0", commit: "abc1234", browser: "Chrome 131 on Android" },
    ai: { kind: "cloud", vendor: "anthropic", model: "claude-x", key: "sk-ant-should-never-appear-0000000000" },
    devices: [{ board: "esp32c6", firmware: "1.14.0", features: ["perf", "decks"], channels: 1, led_count: 300 }],
    applog: [{ t: "2026-11-18T09:59:00Z", kind: "conn", msg: "connected to dev#1a2b3c4d" }],
    ...over,
  };
}

function memKv(): KeyValue & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k) };
}

// -- the recorder -------------------------------------------------------------------------

describe("TurnRecorder", () => {
  test("records rounds, tool calls, delivery, timings and the prompt hash (not the prompt)", () => {
    const t = falseClaimTurn();
    assert.equal(t.rounds.length, 2);
    assert.equal(t.tools.length, 1);
    const call = t.tools[0]!;
    assert.equal(call.name, "set_script");
    assert.equal(call.delivery, "not_sent");
    assert.equal(call.compile, "ok");
    assert.equal(call.durationMs, 120);
    assert.equal(t.rounds[1]!.out, "Pushed! Your fixture is now playing a calm blue.");
    assert.ok(t.system && /^[0-9a-f]{8}$/.test(t.system.hash));
    assert.equal(t.system?.chars, "You are the Splanc effect assistant.".length);
    assert.ok(!JSON.stringify(t).includes("You are the Splanc effect assistant."));
    assert.equal(t.durationMs, 1020);
  });

  test("flags a reply that claims a push when no tool reported SENT", () => {
    assert.deepEqual(falseClaimTurn().flags, ["claimed_sent_not_sent"]);
  });

  test("no false-claim flag when a tool reported SENT, or the reply says it wasn't sent", () => {
    const r = new TurnRecorder({ turn: 1, ask: "x", sourceBefore: "" });
    r.onTrace({ kind: "round", round: 1 });
    r.onTrace({ kind: "tool_call", name: "set_script", input: {} });
    r.onTrace({ kind: "tool_result", name: "set_script", text: "Compile result: OK\n\nDevice: SENT: uploaded and now playing on Lamp.", isError: false });
    assert.deepEqual(r.finish({ reply: "Pushed it.", outcome: "complete", sourceAfter: "" }).flags, []);
    const r2 = new TurnRecorder({ turn: 1, ask: "x", sourceBefore: "" });
    assert.deepEqual(r2.finish({ reply: "It's ready in the preview but was not sent to the fixture.", outcome: "complete", sourceAfter: "" }).flags, []);
  });

  test("flags withholding on an uncalibrated estimate, failed compiles, tool errors, exhaustion, errors", () => {
    const r = new TurnRecorder({ turn: 3, ask: "faster", sourceBefore: "" });
    r.onTrace({ kind: "round", round: 1 });
    r.onTrace({ kind: "tool_call", name: "estimate_performance", input: {} });
    r.onTrace({ kind: "tool_result", name: "estimate_performance", text: "No estimate: this board's cost model is UNCALIBRATED, so…", isError: false });
    r.onTrace({ kind: "tool_call", name: "set_script", input: {} });
    r.onTrace({ kind: "tool_result", name: "set_script", text: "Compile result: line 3: unknown function foo", isError: false });
    r.onTrace({ kind: "tool_call", name: "capture_preview", input: {} });
    r.onTrace({ kind: "tool_result", name: "capture_preview", text: "tool error: canvas lost", isError: true });
    const t = r.finish({ reply: "I held it back: it would be over budget on your fixture.", outcome: "exhausted", error: "boom", sourceAfter: "" });
    assert.deepEqual(t.flags.sort(), ["compile_failed", "exhausted", "held_on_uncalibrated_estimate", "tool_error", "turn_error"]);
    assert.equal(t.tools[0]!.estimateCalibrated, false);
  });

  test("a tool result with no matching call is still recorded; recording never throws", () => {
    const r = new TurnRecorder({ turn: 1, ask: "", sourceBefore: "" });
    r.onTrace({ kind: "tool_result", name: "set_live_uniforms", text: "set", isError: false });
    r.onTrace(null as never);
    const t = r.finish({ reply: "", outcome: "complete", sourceAfter: "" });
    assert.equal(t.tools.length, 1);
    assert.equal(t.tools[0]!.input, null);
  });

  test("deliveryOf reads SENT / NOT SENT", () => {
    assert.equal(deliveryOf("Device: SENT: uploaded"), "sent");
    assert.equal(deliveryOf("Device: NOT SENT: auto-push is off"), "not_sent");
    assert.equal(deliveryOf("Compile result: OK"), null);
  });

  test("TurnHistory keeps the last N turns", () => {
    const h = new TurnHistory(2);
    for (const n of [1, 2, 3]) h.push(falseClaimTurn(n));
    assert.deepEqual(h.upTo().map((t) => t.turn), [2, 3]);
    assert.deepEqual(h.upTo(2).map((t) => t.turn), [2]);
    assert.equal(h.get(1), undefined);
  });
});

// -- the report ----------------------------------------------------------------------------

describe("buildFeedbackReport", () => {
  test("carries the reasons, findings, signal and every section by default", () => {
    const r = buildFeedbackReport(input());
    assert.equal(r.schema, TRACE_SCHEMA);
    assert.deepEqual(r.reasons, ["false_claim"]);
    assert.deepEqual(r.flags, ["claimed_sent_not_sent"]);
    assert.equal(r.signal.tool, "set_script");
    assert.deepEqual(Object.keys(r.sections).sort(), ["applog", "conversation", "device", "source", "trace"]);
    // Tool rows of the visible transcript are not conversation.
    assert.deepEqual(r.sections.conversation?.map((m) => m.role), ["user", "assistant"]);
    assert.equal(r.sections.trace?.[0]?.tools[0]?.delivery, "not_sent");
    assert.match(r.sections.source!.after, /vec3\(0,0,1\)/);
    assert.deepEqual(r.omitted, []);
  });

  test("never includes provider keys; masks names, addresses, Wi-Fi secrets, tokens", () => {
    const t = falseClaimTurn();
    t.tools[0]!.result += "\nwifi_password=hunter2 ssid: MyHomeNet ws://192.168.1.20:8443/ws mac AA:BB:CC:11:22:33";
    const r = buildFeedbackReport(
      input({
        turns: [t],
        note: "my Living Room Lamp at 192.168.1.20, key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123",
        conversation: [{ role: "user", text: "ghp_abcdefghijklmnopqrstuvwxyz0123456789 Living Room Lamp" }],
        known: { "Living Room Lamp": "dev#1a2b3c4d" },
      }),
    );
    const s = JSON.stringify(r);
    for (const bad of ["hunter2", "MyHomeNet", "192.168.1.20", "AA:BB:CC:11:22:33", "Living Room Lamp", "sk-ant-", "ghp_", "should-never-appear"]) {
      assert.ok(!s.includes(bad), `report leaks ${bad}`);
    }
    assert.ok(s.includes("dev#1a2b3c4d"));
    assert.ok(!("key" in r.ai));
    assert.ok(r.redactions >= 5, `redactions ${r.redactions}`);
  });

  test("drops inline images from tool results", () => {
    const t = falseClaimTurn();
    t.tools[0]!.result = `Live preview rendered: data:image/png;base64,${"A".repeat(5000)}`;
    const r = buildFeedbackReport(input({ turns: [t] }));
    assert.match(r.sections.trace![0]!.tools[0]!.result, /\[image omitted\]/);
  });

  test("per-section opt-out leaves the section out (and effect source out of tool inputs)", () => {
    const r = buildFeedbackReport(input({ omit: ["conversation", "source", "applog"] }));
    assert.equal(r.sections.conversation, undefined);
    assert.equal(r.sections.source, undefined);
    assert.equal(r.sections.applog, undefined);
    assert.deepEqual(r.omitted, ["conversation", "source", "applog"]);
    const inp = r.sections.trace![0]!.tools[0]!.input as Record<string, string>;
    assert.match(inp["source"]!, /effect source omitted/);
    // The signature does not depend on what the user left out.
    assert.equal(r.signature, buildFeedbackReport(input()).signature);
  });

  test("stays under the size limit, noting what it cut", () => {
    const big = "x".repeat(3900);
    const turns: TurnTrace[] = [];
    for (let n = 1; n <= 5; n++) {
      const t = falseClaimTurn(n);
      t.tools = Array.from({ length: 40 }, () => ({ ...t.tools[0]!, result: big, input: { source: big } }));
      turns.push(t);
    }
    const r = buildFeedbackReport(
      input({
        turn: 5,
        turns,
        conversation: Array.from({ length: 60 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: big }) as const),
        applog: Array.from({ length: 300 }, (_, i) => ({ t: "2026-11-18T09:00:00Z", kind: "info" as const, msg: `event ${i} ${"y".repeat(400)}` })),
      }),
    );
    assert.ok(JSON.stringify(r).length <= FEEDBACK_LIMITS.report, `report is ${JSON.stringify(r).length}`);
    assert.ok(r.truncated.length > 0);
    assert.ok(r.sections.trace!.length >= 1);
    assert.equal(r.sections.trace![r.sections.trace!.length - 1]!.turn, 5, "the reported turn survives");
  });

  test("source is capped", () => {
    const t = falseClaimTurn();
    t.sourceAfter = "a".repeat(FEEDBACK_LIMITS.source * 2);
    const r = buildFeedbackReport(input({ turns: [t] }));
    assert.ok(r.sections.source!.after.length <= FEEDBACK_LIMITS.source);
    assert.ok(r.truncated.some((x) => x.startsWith("source after")));
  });
});

describe("signature", () => {
  test("same failure, same versions → same group; a different firmware or reason → another", () => {
    const sig = (fw: string, reasons: string[]) => feedbackSignature(feedbackSignal(falseClaimTurn(), fw), reasons, "1.14.0");
    assert.equal(sig("1.14.0", ["false_claim"]), sig("1.14.0", ["false_claim"]));
    assert.notEqual(sig("1.14.0", ["false_claim"]), sig("1.13.0", ["false_claim"]));
    assert.notEqual(sig("1.14.0", ["false_claim"]), sig("1.14.0", ["false_claim", "not_sent"]));
  });

  test("error classes ignore numbers, ids and quoted text", () => {
    assert.equal(errorClass('line 12: unknown identifier "foo"'), errorClass("line 3: unknown identifier 'barbaz'"));
    assert.equal(errorClass("upload failed after 3021 ms (deadbeef12)"), "upload failed after # ms (#)");
  });
});

describe("validateFeedbackReport (relay intake)", () => {
  test("accepts a report, re-scrubs it, and recomputes the signature", () => {
    const r = buildFeedbackReport(input());
    const tampered = { ...r, signature: "00000000", note: "password: hunter2" };
    const v = validateFeedbackReport(JSON.stringify(tampered));
    assert.ok(v.ok);
    if (!v.ok) return;
    assert.equal(v.report.signature, r.signature);
    assert.ok(!v.report.note.includes("hunter2"));
  });

  test("refuses the wrong schema, a bad id, no reason, unknown sections, oversize", () => {
    const r = buildFeedbackReport(input());
    const bad = (o: unknown) => validateFeedbackReport(typeof o === "string" ? o : JSON.stringify(o));
    assert.equal((bad("{") as { status: number }).status, 400);
    assert.equal((bad({ ...r, schema: "x" }) as { status: number }).status, 400);
    assert.equal((bad({ ...r, id: "../../etc" }) as { status: number }).status, 400);
    assert.equal((bad({ ...r, reasons: ["nope"] }) as { status: number }).status, 400);
    assert.equal((bad({ ...r, sections: { secrets: {} } }) as { status: number }).status, 400);
    assert.equal((bad({ ...r, note: "z".repeat(FEEDBACK_LIMITS.report + 5000) }) as { status: number }).status, 413);
  });

  test("ids are URL-safe and unique", () => {
    const a = newFeedbackId();
    assert.match(a, /^[a-z0-9]{8,40}$/);
    assert.notEqual(a, newFeedbackId());
  });
});

// -- the outbox ----------------------------------------------------------------------------

describe("FeedbackQueue", () => {
  const report = (id: string) => ({ ...buildFeedbackReport(input()), id });

  test("queue → send → receipt; the report body is dropped once accepted", async () => {
    const kv = memKv();
    const q = new FeedbackQueue(kv, () => 1000);
    assert.ok(q.enqueue(report("fb_aaaaaaaa")));
    const o = await q.flush(async (r) => ({ ok: true, id: r.id, receipt: "rcpt", status: "received" }), "https://relay.example");
    assert.deepEqual(o.sent, ["fb_aaaaaaaa"]);
    assert.equal(q.outbox().length, 0);
    assert.equal(q.receipts()[0]?.receipt, "rcpt");
    assert.ok(![...kv.map.values()].some((v) => v.includes("my lamp didn't change")), "no report text kept after sending");
  });

  test("offline: stays queued with backoff, retried when due, one outage stops the batch", async () => {
    const c = clock(10_000);
    const q = new FeedbackQueue(memKv(), c.now);
    q.enqueue(report("fb_aaaaaaaa"));
    q.enqueue(report("fb_bbbbbbbb"));
    let calls = 0;
    const down = async (): Promise<SubmitResult> => {
      calls++;
      return { ok: false, reason: "unavailable", message: "offline" };
    };
    let o = await q.flush(down, "r");
    assert.equal(calls, 1, "stops after the first outage");
    assert.equal(o.waiting, 2);
    assert.equal(q.due().length, 0);
    c.tick(backoffMs(1));
    assert.equal(q.due().length, 2);
    o = await q.flush(async (r) => ({ ok: true, id: r.id, receipt: `r-${r.id}`, status: "received" }), "r");
    assert.equal(o.sent.length, 2);
  });

  test("rate limits honour retry-after; rejections are kept but never retried", async () => {
    const c = clock(0);
    const q = new FeedbackQueue(memKv(), c.now);
    q.enqueue(report("fb_aaaaaaaa"));
    await q.flush(async () => ({ ok: false, reason: "rate_limited", message: "slow down", retryAfterS: 3600 }), "r");
    assert.equal(q.outbox()[0]!.nextAt, 3600_000);
    q.retryNow();
    await q.flush(async () => ({ ok: false, reason: "rejected", message: "bad" }), "r");
    assert.equal(q.outbox()[0]!.rejected, true);
    c.tick(1e9);
    assert.equal(q.due().length, 0);
  });

  test("a submit that throws counts as unavailable", async () => {
    const q = new FeedbackQueue(memKv(), () => 0);
    q.enqueue(report("fb_aaaaaaaa"));
    const o = await q.flush(async () => {
      throw new Error("TypeError: Failed to fetch");
    }, "r");
    assert.equal(o.waiting, 1);
    assert.match(q.outbox()[0]!.lastError!, /Failed to fetch/);
  });

  test("bounded: at most N waiting reports (oldest dropped); an oversize report is refused", () => {
    const q = new FeedbackQueue(memKv(), () => 0);
    for (let i = 0; i < QUEUE_LIMITS.reports + 3; i++) q.enqueue(report(`fb_${String(i).padStart(8, "0")}`));
    assert.equal(q.outbox().length, QUEUE_LIMITS.reports);
    assert.equal(q.outbox()[0]!.report.id, "fb_00000003");
    const huge = { ...report("fb_huge0000"), note: "n".repeat(FEEDBACK_LIMITS.report + 10_000) };
    assert.equal(q.enqueue(huge), false);
  });

  test("storage that refuses writes or holds junk doesn't throw", () => {
    const kv = memKv();
    kv.setItem("splanc.feedback.outbox.v1", "{not json");
    const q = new FeedbackQueue({ ...kv, getItem: kv.getItem, setItem: () => { throw new Error("QuotaExceededError"); } }, () => 0);
    assert.deepEqual(q.outbox(), []);
    assert.equal(q.enqueue(report("fb_aaaaaaaa")), false);
  });

  test("status refresh and the reporter's status text", async () => {
    const q = new FeedbackQueue(memKv(), () => 0);
    q.enqueue(report("fb_aaaaaaaa"));
    await q.flush(async (r) => ({ ok: true, id: r.id, receipt: "x", status: "received" }), "r");
    const after = await q.refresh(async () => ({ status: "fixed", fixedIn: "1.15.0" }));
    assert.equal(after[0]!.status, "fixed");
    assert.equal(receiptStatusText(after[0]!), "Fixed in version 1.15.0");
    assert.equal(receiptStatusText({ status: "received" }), "Received");
  });
});

// -- the client ----------------------------------------------------------------------------

describe("feedbackClient", () => {
  const fake = (status: number, body: unknown, headers: Record<string, string> = {}) => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const f = async (url: string, init?: RequestInit) => {
      calls.push({ url, ...(init ? { init } : {}) });
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
    };
    return { f, calls };
  };
  const rep = buildFeedbackReport(input());

  test("submit: 201 → id + receipt; the credential header is passed through", async () => {
    const { f, calls } = fake(201, { id: rep.id, receipt: "r1", status: "received" });
    const r = await submitFeedback("https://relay.example/", rep, { fetch: f, headers: { authorization: "Bearer spl_at_x" } });
    assert.deepEqual(r, { ok: true, id: rep.id, receipt: "r1", status: "received" });
    assert.equal(calls[0]!.url, "https://relay.example/feedback");
    assert.equal((calls[0]!.init!.headers as Record<string, string>)["authorization"], "Bearer spl_at_x");
  });

  test("submit: not configured / rate limited / rejected / down", async () => {
    assert.equal(((await submitFeedback("r", rep, { fetch: fake(503, { error: "not_configured" }).f })) as { reason: string }).reason, "not_configured");
    const rl = (await submitFeedback("r", rep, { fetch: fake(429, {}, { "retry-after": "120" }).f })) as { reason: string; retryAfterS: number };
    assert.deepEqual([rl.reason, rl.retryAfterS], ["rate_limited", 120]);
    assert.equal(((await submitFeedback("r", rep, { fetch: fake(400, { message: "no" }).f })) as { reason: string }).reason, "rejected");
    assert.equal(((await submitFeedback("r", rep, { fetch: fake(502, {}).f })) as { reason: string }).reason, "unavailable");
    const throwing = async () => {
      throw new Error("offline");
    };
    assert.equal(((await submitFeedback("r", rep, { fetch: throwing })) as { reason: string }).reason, "unavailable");
  });

  test("status and delete send the receipt; a 404 reads as deleted", async () => {
    const s = fake(200, { status: "reproduced" });
    assert.deepEqual(await fetchFeedbackStatus({ relay: "https://r", id: "fb_1", receipt: "rc" }, { fetch: s.f }), { status: "reproduced" });
    assert.equal((s.calls[0]!.init!.headers as Record<string, string>)[RECEIPT_HEADER], "rc");
    assert.deepEqual(await fetchFeedbackStatus({ relay: "https://r", id: "fb_1", receipt: "rc" }, { fetch: fake(404, {}).f }), { status: "deleted" });
    const d = fake(200, { ok: true });
    assert.equal(await deleteFeedback({ relay: "https://r", id: "fb_1", receipt: "rc" }, { fetch: d.f }), true);
    assert.equal(d.calls[0]!.init!.method, "DELETE");
  });
});
