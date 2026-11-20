/**
 * Opt-in device metrics (docs/design/device-metrics.md), relay side:
 *
 * - the shared upload validator: structure errors refuse, unknown fields and
 *   fields of categories the user didn't enable are DROPPED, never forwarded;
 * - POST /metrics: off without Grafana (or with the kill switch), lines to
 *   Grafana carry only allowlisted fields (PII planted everywhere never
 *   survives; the IP never appears), per-install / per-IP rate limits;
 * - "delete my data": a Loki delete request when a delete token is set, the
 *   owner's queue otherwise, and a tombstone that refuses later uploads;
 * - the Device health dashboard only names events / fields the schema has.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import deviceHealth from "../../ops/grafana/business/dashboards/device-health.json";
import {
  DEVICE_FIELDS,
  METRIC_CATEGORIES,
  USAGE_FIELDS,
  deviceFieldsFromReply,
  installFromSecret,
  validateMetricsUpload,
  type MetricsUpload,
} from "../../web/src/metrics/metricsSchema";
import { lokiDeleteUrl, metricsEndpoint } from "../relay/src/deviceMetrics";
import { Directory } from "../relay/src/directory";
import { OPS_SCHEMA } from "../relay/src/ops";
import type { Env } from "../relay/src/platform";
import { namespace } from "./billingFakes";

const GRAFANA = { GRAFANA_LOKI_PUSH_URL: "https://logs.example/loki/api/v1/push", GRAFANA_LOKI_USER: "42", GRAFANA_LOKI_TOKEN: "glc_test_token_not_real_000" };
const IP = "198.51.100.7";
const SECRET = "s3cr3t-s3cr3t-s3cr3t-s3cr3t-s3cr3t-0001";
const PII = { name: "Alice Example", ssid: "HomeNet-5G", mac: "AA:BB:CC:DD:EE:FF", email: "someone@example.com", ip: IP, note: "porch lights" };

async function upload(over: Partial<MetricsUpload> = {}): Promise<MetricsUpload> {
  return {
    schema: 1,
    install: await installFromSecret(SECRET),
    app: "1.20.0",
    platform: "web",
    categories: ["performance", "reliability"],
    devices: [
      {
        dev: "dev0123456789ab",
        fw: "1.9.0",
        board: "esp32c6",
        transport: "wss",
        age_s: 30,
        fps_achieved: 58,
        fps_lagging: false,
        heap_min_free: 54000,
        uptime_s: 3600,
        reset_reason: 1,
        wifi_rssi_dbm: -61,
        mesh_mode: 1, // mesh is not enabled: dropped
      },
    ],
    ...over,
  };
}

function harness(extra: Record<string, unknown> = {}) {
  let t = Date.UTC(2026, 10, 20, 12);
  const env = {} as Env;
  Object.assign(env, { ...GRAFANA, FEEDBACK_ADMIN_TOKEN: "admin-token-test-0001", HOST: { now: () => t }, DIRECTORY: namespace((s) => new Directory(s, env)), ...extra });
  const lines: { stream: Record<string, string>; line: Record<string, unknown> }[] = [];
  const calls: { url: string; method: string }[] = [];
  const fetchImpl = (async (u: string, init: RequestInit) => {
    calls.push({ url: u, method: String(init.method) });
    if (u.endsWith("/push")) {
      const p = JSON.parse(String(init.body)) as { streams: { stream: Record<string, string>; values: [string, string][] }[] };
      for (const s of p.streams) for (const [, l] of s.values) lines.push({ stream: s.stream, line: JSON.parse(l) as Record<string, unknown> });
    }
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  const ctx = {
    json: (o: unknown, status = 200, h: Record<string, string> = {}) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", ...h } }),
    clientIp: IP,
    opsFetch: fetchImpl,
  };
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    metricsEndpoint(new Request(`https://relay${path}`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) }), env, ctx, path);
  return { env, ctx, lines, calls, post, advance: (ms: number) => (t += ms) };
}

describe("the upload validator", () => {
  test("refuses bad structure", async () => {
    assert.equal(validateMetricsUpload("nope").ok, false);
    assert.equal(validateMetricsUpload(JSON.stringify({ ...(await upload()), schema: 2 })).ok, false);
    assert.equal(validateMetricsUpload(JSON.stringify({ ...(await upload()), install: "a b" })).ok, false);
    assert.equal(validateMetricsUpload(JSON.stringify({ ...(await upload()), categories: [] })).ok, false);
    assert.equal(validateMetricsUpload(JSON.stringify({ ...(await upload()), platform: "symbian" })).ok, false);
    const many = await upload({ devices: Array.from({ length: 33 }, (_, i) => ({ dev: `dev${String(i).padStart(12, "0")}`, fw: "1", board: "c6", transport: "wss", age_s: 0 })) });
    assert.equal(validateMetricsUpload(JSON.stringify(many)).ok, false);
    assert.equal(validateMetricsUpload("x".repeat(25 * 1024)).ok, false);
  });

  test("drops what isn't allowed or wasn't opted into", async () => {
    const u = await upload();
    (u.devices[0] as Record<string, unknown>)["ssid"] = PII.ssid;
    (u.devices[0] as Record<string, unknown>)["heap_free"] = "lots";
    (u.devices[0] as Record<string, unknown>)["fps_achieved"] = 1e9; // out of range
    (u as unknown as Record<string, unknown>)["email"] = PII.email;
    u.usage = { sessions: 3 }; // usage not enabled
    const v = validateMetricsUpload(JSON.stringify(u));
    assert.ok(v.ok);
    const d = v.upload.devices[0]!;
    assert.equal(d["ssid"], undefined);
    assert.equal(d["heap_free"], undefined);
    assert.equal(d["fps_achieved"], undefined);
    assert.equal(d["mesh_mode"], undefined);
    assert.equal(d["heap_min_free"], 54000);
    assert.equal(d["wifi_rssi_dbm"], -61);
    assert.equal(v.upload.usage, undefined);
    assert.equal(v.dropped, 6);
    assert.ok(!JSON.stringify(v.upload).includes(PII.email));
  });

  test("a reply maps to snake_case fields of the enabled categories; no mesh -> no mesh fields", () => {
    const reply = { fpsAchieved: 60, fpsLagging: true, uptimeS: 10, meshMode: 0, meshMembers: 0, wifiRssiDbm: -50, junk: "x" };
    assert.deepEqual(deviceFieldsFromReply(reply, new Set(["performance"])), { fps_achieved: 60, fps_lagging: true });
    assert.deepEqual(deviceFieldsFromReply(reply, new Set(["reliability", "mesh"])), { uptime_s: 10, wifi_rssi_dbm: -50 });
    assert.deepEqual(deviceFieldsFromReply({ meshMode: 2, meshMembers: 20 }, new Set(["mesh"])), { mesh_mode: 2, mesh_members: 20 });
  });

  test("every field has a category, a label and a unique name", () => {
    const names = new Set<string>();
    for (const f of [...DEVICE_FIELDS, ...USAGE_FIELDS]) {
      assert.ok(METRIC_CATEGORIES.includes(f.category), f.name);
      assert.ok(f.label.length > 5, f.name);
      assert.ok(!names.has(f.name), f.name);
      names.add(f.name);
      assert.ok(!/(name|ssid|mac|ip|email|location|lat|lon)$/i.test(f.name) || f.name === "fps_min", f.name);
    }
  });
});

describe("POST /metrics", () => {
  test("off without the Grafana push, and with the kill switch", async () => {
    const h = harness({ GRAFANA_LOKI_TOKEN: undefined });
    assert.equal((await h.post("/metrics", await upload())).status, 503);
    const k = harness({ DEVICE_METRICS: "off" });
    assert.equal((await k.post("/metrics", await upload())).status, 503);
    assert.equal(k.lines.length, 0);
  });

  test("accepted: allowlisted lines only, no IP, no PII", async () => {
    const h = harness();
    const u = await upload({ categories: ["performance", "reliability", "usage"], usage: { sessions: 2, players: 1 } });
    Object.assign(u.devices[0]!, PII);
    const r = await h.post("/metrics", u);
    assert.equal(r.status, 202);
    const evs = h.lines.map((l) => l.line["ev"]);
    assert.deepEqual(evs, ["dm_upload", "dm_device", "dm_usage"]);
    for (const l of h.lines) {
      assert.equal(l.stream["component"], "device-metrics");
      const text = JSON.stringify(l);
      for (const v of Object.values(PII)) assert.ok(!text.includes(v), `${String(l.line["ev"])} leaked ${v}`);
      for (const k of Object.keys(l.line)) if (k !== "ev") assert.ok(k in OPS_SCHEMA[String(l.line["ev"])]!.fields, k);
    }
    const dev = h.lines[1]!.line;
    assert.equal(dev["fps_achieved"], 58);
    assert.equal(dev["install"], u.install);
    assert.equal(dev["mesh_mode"], undefined);
    assert.equal(h.lines[2]!.line["sessions"], 2);
  });

  test("rate limited per install", async () => {
    const h = harness();
    const u = await upload();
    for (let i = 0; i < 12; i++) assert.equal((await h.post("/metrics", u)).status, 202);
    const r = await h.post("/metrics", u);
    assert.equal(r.status, 429);
    assert.equal(r.headers.get("retry-after"), "3600");
    assert.equal(h.lines.at(-1)!.line["ev"], "dm_rate_limited");
    assert.equal(h.lines.at(-1)!.line["by"], "install");
  });
});

describe("delete my data", () => {
  test("with a delete token: Loki delete request for this install, then a tombstone", async () => {
    const h = harness({ GRAFANA_LOKI_DELETE_TOKEN: "glc_delete_not_real" });
    const install = await installFromSecret(SECRET);
    assert.equal((await h.post("/metrics", await upload())).status, 202);
    const r = await h.post("/metrics/delete", { secret: SECRET });
    assert.equal(r.status, 202);
    assert.equal(((await r.json()) as { status: string }).status, "deleted");
    const del = h.calls.find((c) => c.url.includes("/loki/api/v1/delete"))!;
    assert.ok(del, "a delete request");
    assert.ok(decodeURIComponent(del.url).includes(`"install\\":\\"${install}\\"`));
    assert.equal((await h.post("/metrics", await upload())).status, 410);
    // The queue stays empty (nothing for the owner to do).
    const q = await metricsEndpoint(new Request("https://relay/metrics/deletions", { headers: { authorization: "Bearer admin-token-test-0001" } }), h.env, h.ctx, "/metrics/deletions");
    assert.deepEqual(((await q.json()) as { items: unknown[] }).items, []);
  });

  test("without one: queued for the owner, cleared by the admin, tombstone expires with retention", async () => {
    const h = harness();
    const install = await installFromSecret(SECRET);
    const r = await h.post("/metrics/delete", { secret: SECRET });
    assert.equal(((await r.json()) as { status: string }).status, "queued");
    const admin = { authorization: "Bearer admin-token-test-0001" };
    const list = async () =>
      ((await (await metricsEndpoint(new Request("https://relay/metrics/deletions", { headers: admin }), h.env, h.ctx, "/metrics/deletions")).json()) as { items: { install: string }[] }).items;
    assert.deepEqual((await list()).map((i) => i.install), [install]);
    assert.equal((await metricsEndpoint(new Request("https://relay/metrics/deletions"), h.env, h.ctx, "/metrics/deletions")).status, 401);
    assert.equal((await h.post("/metrics/deletions", { install }, admin)).status, 200);
    assert.deepEqual(await list(), []);
    assert.equal((await h.post("/metrics", await upload())).status, 410);
    h.advance(91 * 86400_000);
    const dir = (h.env.DIRECTORY as unknown as { objects: Map<string, { obj?: unknown; state: { storage: { map: Map<string, unknown> } } }> }).objects;
    const d = [...dir.values()][0]!;
    await (d as unknown as { obj: Directory }).obj.alarm();
    assert.equal([...d.state.storage.map.keys()].filter((k) => k.startsWith("dm")).length, 0);
    assert.equal((await h.post("/metrics", await upload())).status, 202);
  });

  test("a bad secret is refused; the secret never reaches Grafana", async () => {
    const h = harness();
    assert.equal((await h.post("/metrics/delete", { secret: "short" })).status, 400);
    await h.post("/metrics/delete", { secret: SECRET });
    assert.ok(!JSON.stringify(h.lines).includes(SECRET));
  });

  test("the delete URL targets the push host's delete API", () => {
    const u = lokiDeleteUrl("https://logs-prod-1.grafana.net/loki/api/v1/push", "abcdefghijklmnop", Date.UTC(2026, 10, 20));
    assert.ok(u.startsWith("https://logs-prod-1.grafana.net/loki/api/v1/delete?query="));
    assert.ok(/&start=\d+&end=\d+$/.test(u));
  });
});

describe("the Device health dashboard", () => {
  test("names only device-metrics events and their fields", () => {
    const text = JSON.stringify(deviceHealth);
    const evs = [...text.matchAll(/event=\\"(dm_[a-z_]+)\\"/g)].map((m) => m[1]!);
    assert.ok(evs.length > 5);
    for (const e of evs) assert.ok(e in OPS_SCHEMA, e);
    for (const m of text.matchAll(/unwrap ([a-z_]+)/g)) assert.ok(Object.values(OPS_SCHEMA).some((s) => s.component === "device-metrics" && m[1]! in s.fields), m[1]);
  });
});
