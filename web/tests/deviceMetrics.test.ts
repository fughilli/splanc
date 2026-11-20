/**
 * "Send feedback to Fug Studio" (docs/design/device-metrics.md), app side:
 * off by default and inert while off; per-category gating at collection AND in
 * the payload; the literal next upload; upload backoff (relay down, 429
 * retry-after, 503); pseudonym rotation; a deleted pseudonym (410) starts over;
 * "Delete my data" covers every pseudonym still known and switches sending off.
 */

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { MetricsCollector, ROTATE_EVERY_MS, SAMPLE_EVERY_MS, UPLOAD_EVERY_MS, usageScreenFor, type MetricsPlayer } from "../src/metrics/collector";
import { installFromSecret, validateMetricsUpload, type MetricsUpload } from "../src/metrics/metricsSchema";

class Mem {
  map = new Map<string, string>();
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}

const REPLY = {
  type: "device_metrics",
  version: 1,
  board: "esp32c6",
  fpsAchieved: 58,
  fpsLagging: false,
  heapMinFree: 54000,
  uptimeS: 3600,
  resetReason: 1,
  wifiRssiDbm: -61,
  bleDrops: 2,
  meshMode: 0,
};

function rig(opts: { reply?: Record<string, unknown>; status?: number; headers?: Record<string, string> } = {}) {
  let t = Date.UTC(2026, 10, 20, 12);
  const storage = new Mem();
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  let reads = 0;
  const state = { status: opts.status ?? 202, deleteStatus: "deleted", down: false };
  const player: MetricsPlayer = {
    key: "AA:BB:CC:DD:EE:FF",
    fw: "1.9.0",
    transport: "wss",
    supports: true,
    read: async () => {
      reads++;
      return opts.reply ?? REPLY;
    },
  };
  const players = [player];
  let rnd = 0;
  const m = new MetricsCollector({
    storage,
    now: () => t,
    random: (n) => new Uint8Array(n).fill(++rnd),
    players: () => players,
    app: () => "1.20.0",
    platform: () => "web",
    relay: "https://relay.test",
    schedule: false,
    fetch: async (url, init) => {
      if (state.down) throw new Error("offline");
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      sent.push({ url, body });
      if (url.endsWith("/metrics/delete")) return new Response(JSON.stringify({ status: state.deleteStatus, message: "ok" }), { status: 202 });
      return new Response(JSON.stringify({ accepted: 1 }), { status: state.status, headers: opts.headers ?? {} });
    },
  });
  return { m, storage, sent, state, players, reads: () => reads, advance: (ms: number) => (t += ms), now: () => t };
}

describe("off by default", () => {
  test("nothing is read, counted, stored or sent until switched on", async () => {
    const r = rig();
    assert.equal(r.m.settings().enabled, false);
    r.m.countUsage("sessions");
    assert.equal(await r.m.sampleNow(true), 0);
    await r.m.tick();
    assert.equal(r.reads(), 0);
    assert.equal(r.sent.length, 0);
    assert.equal(await r.m.nextUpload(), null);
    assert.equal(r.storage.map.size, 0);
  });

  test("switching on picks every category once; off drops the pending batch", async () => {
    const r = rig();
    r.m.setEnabled(true);
    assert.deepEqual(r.m.settings().categories, { performance: true, reliability: true, mesh: true, usage: true });
    await r.m.sampleNow();
    assert.ok(await r.m.nextUpload());
    r.m.setEnabled(false);
    r.m.stop();
    assert.equal(await r.m.nextUpload(), null);
  });
});

describe("categories", () => {
  test("only the enabled categories' fields are read into a sample", async () => {
    const r = rig();
    r.m.setEnabled(true);
    r.m.setCategory("reliability", false);
    r.m.setCategory("usage", false);
    r.m.stop();
    await r.m.sampleNow();
    const u = (await r.m.nextUpload())!;
    assert.deepEqual(u.categories, ["performance", "mesh"]);
    const d = u.devices[0]!;
    assert.equal(d["fps_achieved"], 58);
    assert.equal(d["heap_min_free"], 54000);
    assert.equal(d["uptime_s"], undefined);
    assert.equal(d["wifi_rssi_dbm"], undefined);
    assert.equal(d["mesh_mode"], undefined, "no mesh: no mesh fields");
    assert.equal(u.usage, undefined);
    assert.equal(d.board, "esp32c6");
    assert.equal(d.fw, "1.9.0");
    // What the app would send is exactly what the relay accepts, nothing dropped.
    const v = validateMetricsUpload(JSON.stringify(u));
    assert.ok(v.ok && v.dropped === 0, JSON.stringify(v));
  });

  test("turning a category off prunes what it already collected", async () => {
    const r = rig();
    r.m.setEnabled(true);
    r.m.stop();
    await r.m.sampleNow();
    r.m.countUsage("screen_editor");
    r.m.setCategory("performance", false);
    r.m.setCategory("usage", false);
    r.m.stop();
    const u = (await r.m.nextUpload())!;
    assert.equal(u.devices[0]!["fps_achieved"], undefined);
    assert.equal(u.devices[0]!["uptime_s"], 3600);
    assert.equal(u.usage, undefined);
  });

  test("the payload carries no player key, MAC or name", async () => {
    const r = rig({ reply: { ...REPLY, deviceName: "Porch", ssid: "HomeNet" } });
    r.m.setEnabled(true);
    r.m.stop();
    await r.m.sampleNow();
    const text = JSON.stringify(await r.m.nextUpload());
    for (const bad of ["AA:BB", "Porch", "HomeNet"]) assert.ok(!text.includes(bad), bad);
  });

  test("usage: counts sessions / screens / deploys and the player count", async () => {
    const r = rig();
    r.m.setEnabled(true);
    r.m.stop();
    r.m.countUsage("sessions");
    r.m.countUsage("screen_play");
    r.m.countUsage("screen_play");
    r.m.countUsage("effects_deployed");
    const u = (await r.m.nextUpload())!;
    assert.deepEqual(u.usage, { sessions: 1, screen_play: 2, effects_deployed: 1, players: 1 });
    assert.equal(usageScreenFor("#/effects/edit/abc"), "editor");
    assert.equal(usageScreenFor("#/map/xyz"), "maps");
    assert.equal(usageScreenFor("#/settings/privacy"), "settings");
    assert.equal(usageScreenFor("#/about"), undefined);
  });
});

describe("sampling and upload", () => {
  test("one sample per player per 15 min; older firmware is skipped", async () => {
    const r = rig();
    r.m.setEnabled(true);
    r.m.stop();
    await r.m.sampleNow();
    await r.m.sampleNow();
    assert.equal(r.reads(), 1);
    r.advance(SAMPLE_EVERY_MS);
    await r.m.sampleNow();
    assert.equal(r.reads(), 2);
    r.players[0]!.supports = false;
    r.advance(SAMPLE_EVERY_MS);
    await r.m.sampleNow();
    assert.equal(r.reads(), 2);
  });

  test("uploads the literal preview, then waits 6 h", async () => {
    const r = rig();
    r.m.setEnabled(true);
    r.m.stop();
    await r.m.sampleNow();
    const preview = await r.m.nextUpload();
    r.advance(11 * 60_000);
    await r.m.tick();
    assert.equal(r.sent.length, 1);
    assert.equal(r.sent[0]!.url, "https://relay.test/metrics");
    const body = r.sent[0]!.body as unknown as MetricsUpload;
    assert.deepEqual({ ...body, devices: body.devices.map((d) => ({ ...d, age_s: 0 })) }, { ...preview!, devices: preview!.devices.map((d) => ({ ...d, age_s: 0 })) });
    assert.equal(body.install, await installFromSecret(r.m.settings().secrets[0]!.s));
    assert.ok(r.m.settings().lastSent);
    assert.equal(await r.m.nextUpload(), null, "the batch is cleared");
    r.advance(SAMPLE_EVERY_MS);
    await r.m.tick();
    assert.equal(r.sent.length, 1, "not before 6 h");
    r.advance(UPLOAD_EVERY_MS);
    await r.m.tick();
    assert.equal(r.sent.length, 2);
  });

  test("backoff: offline doubles from 1 h, retry-after wins, 503 waits a day", async () => {
    const r = rig({ status: 429, headers: { "retry-after": "7200" } });
    r.m.setEnabled(true);
    r.m.stop();
    await r.m.sampleNow();
    r.state.down = true;
    await r.m.uploadNow();
    assert.equal(r.m.settings().nextAttemptAt - r.now(), 3600_000);
    await r.m.uploadNow();
    assert.equal(r.m.settings().nextAttemptAt - r.now(), 7200_000);
    r.state.down = false;
    await r.m.uploadNow(); // 429, retry-after 2 h, 3rd failure = 4 h
    assert.equal(r.m.settings().nextAttemptAt - r.now(), 4 * 3600_000);
    r.state.status = 503;
    await r.m.uploadNow();
    assert.equal(r.m.settings().nextAttemptAt - r.now(), 24 * 3600_000);
    assert.ok(await r.m.nextUpload(), "kept for the retry");
  });

  test("a deleted pseudonym (410) starts a new one", async () => {
    const r = rig({ status: 410 });
    r.m.setEnabled(true);
    r.m.stop();
    const before = r.m.settings().secrets[0]!.s;
    await r.m.sampleNow();
    await r.m.uploadNow();
    const s = r.m.settings();
    assert.equal(s.secrets.length, 1);
    assert.notEqual(s.secrets[0]!.s, before);
  });

  test("the pseudonym rotates every 30 days and keeps at most four", async () => {
    const r = rig();
    r.m.setEnabled(true);
    r.m.stop();
    for (let i = 0; i < 6; i++) {
      r.advance(ROTATE_EVERY_MS);
      await r.m.tick();
    }
    const s = r.m.settings();
    assert.ok(s.secrets.length <= 4);
    assert.ok(s.secrets.every((x) => r.now() - x.since < 120 * 86400_000));
  });
});

describe("delete my data", () => {
  test("deletes under every known pseudonym and switches sending off", async () => {
    const r = rig();
    r.m.setEnabled(true);
    r.m.stop();
    r.advance(ROTATE_EVERY_MS);
    await r.m.tick();
    const secrets = r.m.settings().secrets.map((x) => x.s);
    assert.equal(secrets.length, 2);
    const res = await r.m.deleteMyData();
    assert.equal(res.status, "deleted");
    const dels = r.sent.filter((x) => x.url.endsWith("/metrics/delete")).map((x) => x.body["secret"]);
    assert.deepEqual(dels, secrets);
    const s = r.m.settings();
    assert.equal(s.enabled, false);
    assert.deepEqual(s.secrets, []);
    assert.equal(s.lastSent, undefined);
    assert.equal(s.deletion?.status, "deleted");
  });

  test("offline: nothing forgotten, the user can retry", async () => {
    const r = rig();
    r.m.setEnabled(true);
    r.m.stop();
    r.state.down = true;
    const res = await r.m.deleteMyData();
    assert.equal(res.status, "failed");
    assert.equal(r.m.settings().secrets.length, 1);
    assert.equal(r.m.settings().enabled, true);
  });

  test("never sent: nothing to delete", async () => {
    const r = rig();
    assert.equal((await r.m.deleteMyData()).status, "nothing");
    assert.equal(r.sent.length, 0);
  });
});
