/**
 * Business observability (docs/design/ops-grafana.md), all offline:
 *
 * - the allowlist (ops.ts): only schema fields reach Grafana, each type-checked;
 *   account / request / session ids, IPs, emails, error text, prompts and notes
 *   are dropped, malformed tokens too, and an unknown event is never pushed;
 * - the Loki push: labels, off without the three settings, never throws;
 * - agent feedback: a received report and a triage status change push counts
 *   and labels only (no note, conversation, trace, source, device or sender);
 * - the alert rules (ops/grafana/business/alerts.json) and the dashboards
 *   (ops/grafana/business/dashboards/*.json) only name events, components and
 *   fields the schema has, so a renamed field can't silently blank a panel.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import alerts from "../../ops/grafana/business/alerts.json";
import aiSpend from "../../ops/grafana/business/dashboards/ai-spend.json";
import demo from "../../ops/grafana/business/dashboards/demo.json";
import feedbackBoard from "../../ops/grafana/business/dashboards/feedback.json";
import revenue from "../../ops/grafana/business/dashboards/revenue.json";
import { buildFeedbackReport, type FeedbackReport } from "../../web/src/feedback/agentTrace";
import { BillingAccount } from "../relay/src/billing/account";
import { Directory } from "../relay/src/directory";
import { feedbackEndpoint } from "../relay/src/feedback";
import { OPS_EVENTS, OPS_SCHEMA, lokiPayload, opsLine, opsPush } from "../relay/src/ops";
import type { Env } from "../relay/src/platform";
import { namespace } from "./billingFakes";

const GRAFANA = { GRAFANA_LOKI_PUSH_URL: "https://logs.example/loki/api/v1/push", GRAFANA_LOKI_USER: "42", GRAFANA_LOKI_TOKEN: "glc_test_token_not_real_000" };

/** Values that must never reach Grafana, whatever field they hide in. */
const PII = {
  account: "acct_abcdefghijklmnopqrst",
  id: "req0123456789abcdef",
  session: "cs_test_a1b2c3",
  email: "someone@example.com",
  ip: "198.51.100.7",
  prompt: "make my porch lights spooky",
  note: "my wifi password is hunter2",
  detail: "Error: fetch failed for someone@example.com",
  body: '{"error":{"message":"prompt: make my porch lights spooky"}}',
  name: "Alice Example",
  card: "4242 4242 4242 4242",
};

function capture() {
  const pushes: { stream: Record<string, string>; line: Record<string, unknown> }[] = [];
  const fetchImpl = (async (_u: string, init: RequestInit) => {
    const p = JSON.parse(String(init.body)) as { streams: { stream: Record<string, string>; values: [string, string][] }[] };
    for (const s of p.streams) for (const [, l] of s.values) pushes.push({ stream: s.stream, line: JSON.parse(l) as Record<string, unknown> });
    return new Response("", { status: 204 });
  }) as unknown as typeof fetch;
  return { pushes, fetchImpl };
}

describe("ops allowlist", () => {
  test("every schema event keeps only its fields; PII never survives", () => {
    for (const ev of OPS_EVENTS) {
      const line = opsLine({ ev, alert: true, ...PII, reason: PII.email, model: PII.prompt, sku: PII.card });
      assert.ok(line, ev);
      const text = JSON.stringify(line);
      for (const [k, v] of Object.entries(PII)) {
        assert.ok(!text.includes(v), `${ev}: ${k} leaked`);
        if (!(k in OPS_SCHEMA[ev]!.fields)) assert.ok(!(k in line), `${ev}: ${k} kept`);
      }
      assert.equal(line["alert"], true);
    }
  });

  test("types: numbers finite, booleans real, tokens short and pattern-bound, enums closed", () => {
    const l = opsLine({ ev: "ai_settled", list_usd: Number.NaN, credits_charged: "5", estimated: "true", model: "claude-sonnet-5-5", paying: true })!;
    assert.deepEqual(l, { ev: "ai_settled", model: "claude-sonnet-5-5", paying: true });
    assert.equal(opsLine({ ev: "ai_refused", reason: "x".repeat(65) })!["reason"], undefined);
    assert.equal(opsLine({ ev: "ai_refused", reason: "has space" })!["reason"], undefined);
    assert.equal(opsLine({ ev: "ai_refund", kind: "fraud" })!["kind"], undefined);
    assert.equal(opsLine({ ev: "fb_received", app: "1.6.0-rc1+abc123" })!["app"], "1.6.0-rc1+abc123");
    assert.equal(opsLine({ ev: "fb_received", app: "1.6.0 (Chrome on Android)" })!["app"], undefined);
    assert.equal(opsLine({ ev: "ai_reconcile_usage", day: "2026-11-18" })!["day"], "2026-11-18");
  });

  test("unknown events are dropped; prototype names are not events", () => {
    assert.equal(opsLine({ ev: "user_signed_up", email: PII.email }), null);
    assert.equal(opsLine({ ev: "__proto__" }), null);
    assert.equal(opsLine({ ev: "constructor" }), null);
    assert.equal(lokiPayload([{ ev: "nope" }, { ev: "fb_duplicate" }], "production", 0).streams.length, 1);
  });

  test("no schema field is an identifier", () => {
    for (const [ev, spec] of Object.entries(OPS_SCHEMA)) {
      for (const f of Object.keys(spec.fields)) {
        assert.ok(!/^(account|acct|id|ip|email|session|user|name|note|prompt|reply|detail|body|txid|transaction|receipt|from)$/i.test(f), `${ev}.${f}`);
      }
    }
  });

  test("the push: labels, env override, off without config, a failing endpoint is reported not thrown", async () => {
    const { pushes, fetchImpl } = capture();
    await opsPush({}, [{ ev: "fb_duplicate" }], { fetchImpl });
    assert.equal(pushes.length, 0);
    await opsPush({ ...GRAFANA, OPS_ENV: "synthetic" }, [{ ev: "demo_request", outcome: "ok" }, { ev: "fb_duplicate" }], { fetchImpl });
    assert.deepEqual(
      pushes.map((p) => p.stream),
      [
        { service: "splanc-pages", component: "demo-relay", env: "synthetic", event: "demo_request", alert: "false" },
        { service: "splanc-relay", component: "feedback", env: "synthetic", event: "fb_duplicate", alert: "false" },
      ],
    );
    await opsPush({ ...GRAFANA, OPS_ENV: "Prod Env!" }, [{ ev: "fb_duplicate" }], { fetchImpl });
    assert.equal(pushes.at(-1)!.stream["env"], "unknown");
    const fails: number[] = [];
    await opsPush(GRAFANA, [{ ev: "fb_duplicate" }], { fetchImpl: (async () => new Response("", { status: 401 })) as unknown as typeof fetch, onFail: (s) => fails.push(s) });
    await opsPush(GRAFANA, [{ ev: "fb_duplicate" }], {
      fetchImpl: (async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch,
      onFail: (s) => fails.push(s),
    });
    assert.deepEqual(fails, [401, 0]);
  });

  test("the demo relay's JS twin pushes the same demo_request fields", () => {
    // web/_worker.js DEMO_OPS_FIELDS (checked there by demoAiWorker.test.mjs).
    assert.deepEqual(Object.keys(OPS_SCHEMA["demo_request"]!.fields).sort(), ["attempts", "images", "model", "ms", "outcome", "status"]);
  });
});

// -- feedback ------------------------------------------------------------------------

const ADMIN = "test-feedback-admin-token-0001";

function report(id: string): FeedbackReport {
  return buildFeedbackReport({
    id,
    surface: "web-editor",
    reasons: ["false_claim", "not_sent"],
    note: PII.note,
    turn: 1,
    turns: [],
    conversation: [{ role: "user", text: PII.prompt }],
    app: { version: "1.14.0", commit: "abc1234", browser: "Chrome 131 on Android" },
    ai: { kind: "cloud", vendor: "anthropic", model: "test-model" },
    devices: [{ board: "esp32c6", firmware: "1.14.0", features: ["effects"], channels: 1, led_count: 64 }],
    applog: [],
  });
}

describe("feedback ops events", () => {
  test("received + status change: counts and labels only", async () => {
    let t = Date.UTC(2026, 10, 18, 12);
    const env = {} as Env;
    Object.assign(env, {
      ...GRAFANA,
      FEEDBACK_ADMIN_TOKEN: ADMIN,
      HOST: { now: () => t },
      DIRECTORY: namespace((s) => new Directory(s, env)),
      BILLING: namespace((s) => new BillingAccount(s, env)),
    });
    const { pushes, fetchImpl } = capture();
    const ctx = {
      json: (o: unknown, status = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", ...extra } }),
      clientIp: PII.ip,
      verify: async () => false,
      opsFetch: fetchImpl,
    };
    const rep = report("fbops00000001");
    const post = () => feedbackEndpoint(new Request("https://relay/feedback", { method: "POST", body: JSON.stringify(rep) }), env, ctx, "/feedback");
    assert.equal((await post()).status, 201);
    assert.equal((await post()).status, 200); // a retry: fb_duplicate, not counted twice
    t += 5 * 3_600_000;
    const st = await feedbackEndpoint(
      new Request("https://relay/feedback/status", { method: "POST", headers: { authorization: `Bearer ${ADMIN}` }, body: JSON.stringify({ id: rep.id, status: "reproduced" }) }),
      env,
      ctx,
      "/feedback/status",
    );
    assert.equal(st.status, 200);
    await new Promise((r) => setTimeout(r, 5));

    const evs = pushes.map((p) => p.line);
    assert.deepEqual(
      evs.map((e) => e["ev"]),
      ["fb_received", "fb_reason", "fb_reason", "fb_duplicate", "fb_status"],
    );
    const got = evs[0]!;
    assert.equal(got["surface"], "web-editor");
    assert.equal(got["reasons"], "false_claim,not_sent");
    assert.equal(got["app"], "1.14.0");
    assert.equal(got["signature"], rep.signature);
    assert.deepEqual(
      evs.filter((e) => e["ev"] === "fb_reason").map((e) => e["reason"]),
      ["false_claim", "not_sent"],
    );
    const status = evs.at(-1)!;
    assert.equal(status["status"], "reproduced");
    assert.equal(status["prev"], "received");
    assert.equal(status["age_h"], 5);
    const all = JSON.stringify(pushes);
    for (const bad of [PII.note, PII.prompt, PII.ip, rep.id, "hunter2", "Chrome 131", "esp32c6"]) assert.ok(!all.includes(bad), bad);
  });
});

// -- alerts + dashboards vs the schema -------------------------------------------------

/** Every (component, events, fields) a LogQL query names. */
function refs(expr: string) {
  const out: { component: string; events: string[]; fields: string[] }[] = [];
  // Each selector `{...}` followed by its pipeline up to the range `[`.
  for (const m of expr.matchAll(/\{([^}]*)\}([^[]*)\[/g)) {
    const sel = m[1]!;
    const pipe = m[2]!;
    const component = /component="([^"]+)"/.exec(sel)?.[1] ?? "";
    const ev = /event=~?"([^"]+)"/.exec(sel)?.[1];
    const events = ev ? ev.split("|") : OPS_EVENTS.filter((e) => OPS_SCHEMA[e]!.component === component);
    const fields = [...pipe.matchAll(/\|\s*(?:unwrap\s+)?([a-z_]+)\s*(?:[!=]~?|>|<|$|\s)/g)].map((x) => x[1]!).filter((f) => f !== "json" && f !== "unwrap");
    out.push({ component, events, fields });
  }
  const by = [...expr.matchAll(/by \(([a-z_, ]+)\)/g)].flatMap((x) => x[1]!.split(",").map((s) => s.trim()));
  return { sels: out, by };
}

function checkExpr(where: string, expr: string) {
  const { sels, by } = refs(expr);
  assert.ok(sels.length > 0, `${where}: no selector in ${expr}`);
  for (const s of sels) {
    for (const ev of s.events) {
      const spec = OPS_SCHEMA[ev];
      assert.ok(spec, `${where}: unknown event ${ev}`);
      assert.equal(spec.component, s.component, `${where}: ${ev} is not in ${s.component}`);
      for (const f of s.fields) assert.ok(f === "alert" || f in spec.fields, `${where}: ${ev} has no field ${f}`);
    }
  }
  for (const f of by) {
    if (["level", "env", "event", "component", "service"].includes(f)) continue;
    assert.ok(
      sels.some((s) => s.events.every((ev) => f in OPS_SCHEMA[ev]!.fields)),
      `${where}: grouped by ${f}, which its events don't carry`,
    );
  }
}

describe("alerts + dashboards name only real events and fields", () => {
  test("the parser sees through a query", () => {
    const r = refs('sum by (model) (sum_over_time({service="splanc-relay", component="ai-billing", env=~"$env", event="ai_settled"} | json | paying="true" | unwrap list_usd [1d]))');
    assert.deepEqual(r.sels, [{ component: "ai-billing", events: ["ai_settled"], fields: ["paying", "list_usd"] }]);
    assert.deepEqual(r.by, ["model"]);
    assert.throws(() => checkExpr("t", '{component="ai-billing", event="ai_settled"} | json | unwrap no_such_field [1h]'));
    assert.throws(() => checkExpr("t", '{component="feedback", event="ai_settled"} [1h]'));
  });

  test("alert rules", () => {
    const rules = (alerts as { rules: { uid: string; component: string; queries: Record<string, string> }[] }).rules;
    assert.ok(rules.length >= 14);
    for (const r of rules) for (const [k, e] of Object.entries(r.queries)) checkExpr(`${r.uid}/${k}`, e);
    // The owner's asks are all there.
    for (const uid of [
      "biz-org-spend-80",
      "biz-org-spend-stop",
      "biz-anthropic-errors",
      "biz-reconcile-mismatch",
      "biz-dispute",
      "biz-refund-spike",
      "biz-feedback-spike",
      "biz-demo-429-spike",
    ]) {
      assert.ok(rules.some((r) => r.uid === uid), uid);
    }
  });

  test("dashboards", () => {
    type Panel = { title?: string; type: string; targets?: { expr: string }[] };
    for (const d of [revenue, aiSpend, feedbackBoard, demo] as { uid: string; panels: Panel[] }[]) {
      for (const p of d.panels) for (const t of p.targets ?? []) checkExpr(`${d.uid}/${p.title}`, t.expr);
    }
  });
});
