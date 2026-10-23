/**
 * The Wi-Fi rejoin policy tools through the bridge (docs/design/wifi-rejoin-
 * policy.md): get_wifi_policy shaping, set_wifi_policy sending only the fields
 * given, NEVER force unless the caller set it, the ota_pending refusal reported
 * with a clear note, the MCP tool path, and the feature gate. Skipped as a whole
 * when this bundle's protocol predates the arms.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer } from "../src/server";
import { DeviceSession, WIFI_POLICY_IN_PROTO } from "../src/session";
import { nodeSocketFactory } from "../src/socket";
import { FakePlayer, TEST_CERT_SHA256 } from "./fakePlayer";

const skip = WIFI_POLICY_IN_PROTO ? false : "this bundle's protocol has no Wi-Fi policy arms yet";

let player: FakePlayer;

async function connect(features: string[]): Promise<DeviceSession> {
  const s = new DeviceSession({
    url: `wss://${player.host}/ws`,
    socketFactory: nodeSocketFactory({ pinSha256: TEST_CERT_SHA256 }),
    features,
  });
  await s.connect();
  return s;
}

beforeEach(async () => {
  player = new FakePlayer();
  await player.start();
});

afterEach(async () => {
  await player.stop();
});

const sets = (): Record<string, unknown>[] => player.received.filter((m) => m.type === "set_wifi_policy");

test("get_wifi_policy: mode, state, timings, status line", { skip }, async () => {
  const s = await connect(["wifi_policy"]);
  const r = await s.getWifiPolicy();
  assert.equal(r["status"], "joined (Venue1)");
  assert.equal(r["mode"], "auto");
  assert.equal(r["state"], "joined");
  assert.equal(r["scan_cap_s"], 60);
  assert.equal(r["decay_after_h"], 24);
  assert.equal(r["ota_pending"], false);
  assert.equal("refused" in r, false);
  s.close();
});

test("set_wifi_policy sends only the given fields and never force by default", { skip }, async () => {
  const s = await connect(["wifi_policy"]);
  const r = await s.setWifiPolicy({ mode: "fixed", intervalS: 120 });
  assert.equal(r["mode"], "fixed");
  assert.equal(r["interval_s"], 120);
  const sent = sets()[0]!;
  assert.equal(sent["mode"], "WIFI_MODE_FIXED");
  assert.equal(sent["intervalS"], 120);
  assert.equal("scanCapS" in sent, false);
  assert.equal(sent["force"] ?? false, false);
  s.close();
});

test("offline while an update is unconfirmed: refused with a note; force only when asked", { skip }, async () => {
  player.otaPending = true;
  const s = await connect(["wifi_policy"]);
  const r = await s.setWifiPolicy({ mode: "offline" });
  assert.equal(r["refused"], "ota_pending");
  assert.equal(r["applied"], false);
  assert.match(String(r["note"]), /not yet confirmed/);
  assert.equal(r["mode"], "auto");
  assert.equal(sets()[0]!["force"] ?? false, false);
  assert.equal(player.wifi["mode"], "WIFI_MODE_AUTO");

  const forced = await s.setWifiPolicy({ mode: "offline", force: true });
  assert.equal(forced["mode"], "offline");
  assert.equal(forced["radio_on"], false);
  assert.match(String(forced["offline_note"]), /credentials are kept/);
  assert.equal(sets()[1]!["force"], true);
  s.close();
});

test("rejoin_now alone keeps the mode", { skip }, async () => {
  player.wifi = { ...player.wifi, mode: "WIFI_MODE_MANUAL", state: "WIFI_LINK_IDLE" };
  const s = await connect(["wifi_policy"]);
  const r = await s.setWifiPolicy({ rejoinNow: true });
  assert.equal(r["mode"], "manual");
  assert.equal(r["state"], "searching");
  const sent = sets()[0]!;
  assert.equal("mode" in sent, false);
  assert.equal(sent["rejoinNow"], true);
  s.close();
});

test("MCP tools: set_wifi_policy without force is refused, not overridden", { skip }, async () => {
  player.otaPending = true;
  const session = await connect(["wifi_policy"]);
  const server = createServer(session);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const tools = (await client.listTools()).tools;
  const desc = tools.find((t) => t.name === "set_wifi_policy")!.description ?? "";
  for (const want of [/confirm any pending firmware/i, /credentials are KEPT/, /Bluetooth/, /console/]) {
    assert.match(desc, want);
  }
  const res = await client.callTool({ name: "set_wifi_policy", arguments: { mode: "manual" } });
  const body = JSON.parse((res.content as { text: string }[])[0]!.text);
  assert.equal(body.refused, "ota_pending", JSON.stringify(body));
  assert.equal(sets()[0]!["force"] ?? false, false);
  const got = await client.callTool({ name: "get_wifi_policy", arguments: {} });
  assert.equal(JSON.parse((got.content as { text: string }[])[0]!.text).ota_pending, true);
  await client.close();
  session.close();
});

test("firmware without the feature gets a clear error", { skip }, async () => {
  const s = await connect([]);
  await assert.rejects(s.getWifiPolicy(), /no configurable Wi-Fi rejoin policy/);
  await assert.rejects(s.setWifiPolicy({ mode: "offline" }), /no configurable Wi-Fi rejoin policy/);
  assert.equal(sets().length, 0);
  s.close();
});
