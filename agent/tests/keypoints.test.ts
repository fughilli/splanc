/**
 * Uniform keypoints through the bridge (docs/design/uniform-keypoints.md): the
 * session's save/list/get/recall/blend/delete against the fake player, the
 * feature gate (firmware without "keypoints" → a clear tool error), keypoints in
 * splanc://effect/active, and the MCP tools end to end. Skipped as a whole when
 * this bundle's protocol predates the keypoint arms (KEYPOINTS_IN_PROTO).
 */

import assert from "node:assert/strict";
import { afterEach, before, beforeEach, describe, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { loadFxHost } from "../src/fxhost";
import { createServer } from "../src/server";
import { DeviceSession, KEYPOINTS_IN_PROTO } from "../src/session";
import { nodeSocketFactory } from "../src/socket";
import { FakePlayer, TEST_CERT_SHA256, yFixture } from "./fakePlayer";

const WASM_ROOT = process.env["AGENT_WASM_ROOT"] ?? "wasm";
const skip = KEYPOINTS_IN_PROTO ? false : "this bundle's protocol has no keypoint arms yet";

const EFFECT = `
uniform float rain : 0.0 .. 1.0 = 0.2;
uniform vec3 tint : color = 0.2, 0.6, 1.0;
vec3 shade(Led led) { return tint * (0.5 + 0.5 * rain); }
`;

let player: FakePlayer;
let session: DeviceSession;

async function connect(features: string[]): Promise<DeviceSession> {
  const s = new DeviceSession({
    url: `wss://${player.host}/ws`,
    socketFactory: nodeSocketFactory({ pinSha256: TEST_CERT_SHA256 }),
    features,
  });
  await s.connect();
  return s;
}

const settle = () => new Promise((r) => setTimeout(r, 50));

before(async () => {
  await loadFxHost(WASM_ROOT);
});

beforeEach(async () => {
  player = new FakePlayer();
  player.bundle = yFixture();
  await player.start();
  session = await connect(["keypoints"]);
});

afterEach(async () => {
  session.close();
  await player.stop();
});

describe("keypoints", { skip }, () => {
  test("save the look, recall it later, blend between looks", async () => {
    await session.deployEffect("rain1", EFFECT, true);
    await session.setUniforms({ rain: 0.1, tint: [0, 0, 1] });
    await settle();
    const saved = await session.saveKeypoint("calm");
    assert.deepEqual(saved["keypoints"], [{ name: "calm" }]);
    // Save by name without touching the live look.
    await session.saveKeypoint("storm", { rain: 1, tint: [1, 1, 1] });
    assert.deepEqual((await session.listKeypoints()).keypoints, [{ name: "calm" }, { name: "storm" }]);
    assert.deepEqual((await session.getKeypoint("storm"))["values"], { rain: 1, tint: [1, 1, 1] });

    const r = await session.blendKeypoints({ storm: 1 }, { seconds: 5 });
    assert.deepEqual(r, { weights: { storm: 1 }, seconds: 5, color_mode: "rgb", committed: false, curve: "smoothstep" });
    const last = player.blends.at(-1)!;
    assert.equal(last["seconds"], 5);
    assert.deepEqual(last["weights"], [{ name: "storm", weight: 1 }]);
    const lu = (await session.listUniforms()) as { uniforms: { name: string; current: unknown }[] };
    assert.deepEqual(lu.uniforms.find((u) => u.name === "rain")!.current, [1]);

    const mix = await session.blendKeypoints({ calm: 3, storm: 1, ignored: 0 }, { colorMode: "hsv", commit: true });
    assert.deepEqual(mix["weights"], { calm: 0.75, storm: 0.25 });
    const m = player.blends.at(-1)!;
    assert.equal(m["colorMode"], 1);
    assert.equal(m["commit"], true);
    assert.equal((m["weights"] as unknown[]).length, 2, "zero weights are not sent");

    await assert.rejects(session.blendKeypoints({ nope: 1 }), /no_keypoint/);
    await assert.rejects(session.blendKeypoints({ calm: 0 }), /positive weight/);
    await assert.rejects(session.blendKeypoints({ a: 1, b: 1, c: 1, d: 1, e: 1 }), /at most 4/);
    await assert.rejects(session.saveKeypoint("x".repeat(33)), /1\.\.32 bytes/);

    await session.deleteKeypoint("calm");
    assert.deepEqual((await session.listKeypoints()).keypoints, [{ name: "storm" }]);
    const res = await session.effectResource();
    assert.deepEqual(res["keypoints"], [{ name: "storm" }]);
  });

  test("firmware without keypoints: a clear error, and the resource says so", async () => {
    session.close();
    session = await connect([]);
    await session.deployEffect("rain1", EFFECT, true);
    await assert.rejects(session.listKeypoints(), /doesn't store uniform keypoints/);
    await assert.rejects(session.saveKeypoint("calm"), /doesn't store uniform keypoints/);
    assert.match(String((await session.effectResource())["keypoints"]), /doesn't store/);
    assert.equal(player.types().filter((t) => t.includes("keypoint")).length, 0, "nothing sent");
  });

  test("MCP: save_keypoint / recall_keypoint / blend_keypoints / list / delete", async () => {
    const server = createServer(session);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const t of [
      "list_keypoints",
      "save_keypoint",
      "recall_keypoint",
      "blend_keypoints",
      "get_keypoint",
      "delete_keypoint",
    ]) {
      assert.ok(names.includes(t), t);
    }
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await client.callTool({ name, arguments: args });
      const text = (r.content as { text: string }[])[0]!.text;
      return { error: r.isError === true, body: r.isError ? text : JSON.parse(text) };
    };
    assert.equal((await call("save_keypoint", { name: "calm" })).error, true, "no effect yet");
    await session.deployEffect("rain1", EFFECT, true);
    await call("save_keypoint", { name: "calm", values: { rain: 0 } });
    await call("save_keypoint", { name: "storm", values: { rain: 1 } });
    assert.deepEqual((await call("list_keypoints", {})).body.keypoints, [{ name: "calm" }, { name: "storm" }]);
    const rec = await call("recall_keypoint", { name: "storm", seconds: 20 });
    assert.equal(rec.body.seconds, 20);
    const bl = await call("blend_keypoints", { weights: { calm: 1, storm: 1 }, color_mode: "hsv" });
    assert.deepEqual(bl.body.weights, { calm: 0.5, storm: 0.5 });
    assert.equal((await call("recall_keypoint", { name: "nope" })).error, true);
    await call("delete_keypoint", { name: "calm" });
    assert.deepEqual((await call("list_keypoints", {})).body.keypoints, [{ name: "storm" }]);
    await client.close();
  });
});
