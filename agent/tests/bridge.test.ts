/**
 * The bridge against a fake player (tests/fakePlayer.ts): discovery + TLS pin,
 * each tool's wire behaviour, error mapping, rollback, ramp/commit semantics and
 * the safety exclusions; plus the MCP surface end to end over an in-memory
 * transport.
 */

import assert from "node:assert/strict";
import { afterEach, before, beforeEach, describe, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { resolveTarget, checkSamePlayer } from "../src/discovery";
import { compile, loadFxHost } from "../src/fxhost";
import { createServer } from "../src/server";
import { COMMIT_IN_PROTO, DeviceSession, FORBIDDEN_TYPES, ToolError, sniffType } from "../src/session";
import { nodeSocketFactory } from "../src/socket";
import { FakePlayer, TEST_CERT_SHA256, yFixture } from "./fakePlayer";

const WASM_ROOT = process.env["AGENT_WASM_ROOT"] ?? "wasm";

const EFFECT = `
uniform float rain : 0.0 .. 1.0 = 0.2;
uniform vec3 tint : color = 0.2, 0.6, 1.0;
uniform int mode : {"calm","storm"} = 0;
vec3 shade(Led led) { return tint * (0.5 + 0.5 * rain); }
`;
const EFFECT_B = `
uniform float speed : 0.0 .. 4.0 = 1.0;
vec3 shade(Led led) { return vec3(fract(time * speed), 0.0, 0.0); }
`;

let player: FakePlayer;
let session: DeviceSession;
const noSleep = async () => undefined;

async function connect(features: string[] = []): Promise<DeviceSession> {
  const s = new DeviceSession({
    url: `wss://${player.host}/ws`,
    socketFactory: nodeSocketFactory({ pinSha256: TEST_CERT_SHA256 }),
    features,
  });
  await s.connect();
  return s;
}

before(async () => {
  await loadFxHost(WASM_ROOT);
});

beforeEach(async () => {
  player = new FakePlayer();
  player.bundle = yFixture();
  await player.start();
  session = await connect();
});

afterEach(async () => {
  session.close();
  await player.stop();
});

describe("discovery", () => {
  test("reads the manifest and takes the TLS pin from it", async () => {
    player.manifest = {
      schema: "splanc-agent/1",
      device: { id: player.mac, name: player.name },
      firmware: { version: "1.6.0" },
      protocol: { ws_path: "/ws", features: ["effects", "perf"] },
      tls: { cert_sha256: TEST_CERT_SHA256 },
    };
    const t = await resolveTarget(player.host);
    assert.equal(t.manifest?.schema, "splanc-agent/1");
    assert.equal(t.tls.pinSha256, TEST_CERT_SHA256);
    assert.equal(t.wsUrl, `wss://${player.host}/ws`);
    assert.equal(checkSamePlayer(t.manifest, session.welcome), null);
    assert.match(
      String(checkSamePlayer({ ...t.manifest!, device: { id: "AA:BB:CC:DD:EE:FF" } }, session.welcome)),
      /describes AA:BB/,
    );

  });

  test("falls back to Welcome when the route is missing (older firmware)", async () => {
    const t = await resolveTarget(player.host);
    assert.equal(t.manifest, null);
    assert.match(t.manifestError ?? "", /HTTP 404/);
    assert.equal(session.fwVersion, "1.6.0");

  });

  test("a wrong pin refuses the connection", async () => {
    const s = new DeviceSession({
      url: `wss://${player.host}/ws`,
      socketFactory: nodeSocketFactory({ pinSha256: "00".repeat(32) }),
    });
    await assert.rejects(s.connect());
    s.close();
    player.manifest = { schema: "splanc-agent/1" };
    const t = await resolveTarget(player.host, { pin: "00".repeat(32) });
    assert.equal(t.manifest, null);
    assert.match(t.manifestError ?? "", /pin mismatch/);

  });
});

describe("resources", () => {
  test("device", async () => {
    const d = await session.device();
    assert.equal(d["name"], player.name);
    assert.equal(d["id"], player.mac);
    assert.equal(d["board"], "ESP32-C6 SuperMini");
    assert.equal(d["max_leds"], 512);

  });

  test("fixture summary from the pulled MappingBundle (cached)", async () => {
    const s = await session.fixtureSummary();
    assert.equal(s["led_count"], 30);
    assert.equal(s["up_axis"], "+y");
    assert.deepEqual(s["topology"], { segments: 3, total_length_m: 3, branch_points: 1, associated_leds: 30 });
    const pulls = player.types().filter((t) => t === "get_stored_map").length;
    await session.fixtureSummary();
    assert.equal(player.types().filter((t) => t === "get_stored_map").length, pulls, "cached");

  });
});

describe("effects", () => {
  test("deploy then set uniforms by name", async () => {
    const r = await session.deployEffect("rain1", EFFECT, true);
    assert.deepEqual(r.uniforms, ["rain", "tint", "mode"]);
    assert.equal(player.effect?.id, "rain1");
    const sent = await session.setUniforms({ rain: 0.9, mode: "storm", tint: [1, 0, 0] });
    // rain = slot 0; tint (vec3) = slots 1..3; mode = slot 4 — in the order given.
    assert.deepEqual(
      sent.map((v) => v.slot),
      [0, 4, 1],
    );
    await new Promise((r) => setTimeout(r, 50));
    const last = player.received.filter((m) => m.type === "set_uniforms").pop()!;
    assert.deepEqual(last["values"], [
      { slot: 0, value: [Math.fround(0.9)] }, // float32 on the wire
      { slot: 4, value: [1] },
      { slot: 1, value: [1, 0, 0] },
    ]);
    assert.equal("commit" in last && last["commit"] === true, false, "no commit field without uniform_commit");
    await assert.rejects(session.setUniforms({ rain: 2 }), /outside 0\.\.1/);
    await assert.rejects(session.setUniforms({ wind: 1 }), /unknown uniform "wind"/);
    await assert.rejects(session.setUniforms({ tint: [1, 0] }), /expected 3 value/);

  });

  test("uniform_commit advertised but not in this proto: sets still go out, without commit", async () => {
    session.close();
    session = await connect(["uniform_commit"]);
    assert.ok(session.has("uniform_commit"));
    await session.deployEffect("rain1", EFFECT, true);
    await session.rampUniforms({ rain: 1 }, 0.2, { hz: 10, sleep: noSleep });
    await new Promise((r) => setTimeout(r, 50));
    const sets = player.received.filter((m) => m.type === "set_uniforms");
    assert.equal(sets.length, 2);
    if (!COMMIT_IN_PROTO) for (const m of sets) assert.ok(!m["commit"], "no commit field on the wire");
    else assert.equal(sets.at(-1)!["commit"], true);
  });

  test("ramp streams uncommitted steps, then one final set of the targets", async () => {
    await session.deployEffect("rain1", EFFECT, true);
    const before = player.received.length;
    const r = await session.rampUniforms({ rain: 1 }, 1, { hz: 10, sleep: noSleep });
    assert.equal(r.steps, 10);
    await new Promise((res) => setTimeout(res, 50));
    const sets = player.received.slice(before).filter((m) => m.type === "set_uniforms");
    assert.equal(sets.length, 10, "9 interpolated steps + the final set");
    const vals = sets.map((m) => (m["values"] as { value: number[] }[])[0]!.value[0]!);
    for (let i = 1; i < vals.length; i++) assert.ok(vals[i]! >= vals[i - 1]! - 1e-6, "monotonic");
    assert.equal(vals[vals.length - 1], 1);

  });

  test("compile errors and device rejections become tool errors", async () => {
    await assert.rejects(session.deployEffect("bad", "vec3 shade(Led led) { return nope; }", true), /doesn't compile/);
    player.nextUploadError = { code: "effect_too_large", message: "4 KiB max" };
    await assert.rejects(session.deployEffect("big", EFFECT, true), (e: Error) => {
      assert.ok(e instanceof ToolError);
      assert.match(e.message, /too large/);
      return true;
    });
    player.refuse.set("set_brightness", { code: "unsupported", message: "no brightness" });
    await assert.rejects(session.setBrightness(0.5), /firmware \(1\.6\.0\) doesn't support this/);

  });

  test("rollback re-deploys the previous effect", async () => {
    await session.deployEffect("a", EFFECT, true);
    await session.deployEffect("b", EFFECT_B, true);
    assert.equal(player.effect?.id, "b");
    const r = await session.rollback();
    assert.equal(r["restored"], "a");
    assert.equal(player.effect?.id, "a");
    const r2 = await session.rollback();
    assert.equal(r2["restored"], null);
    assert.equal(player.effect, null, "nothing earlier: turned off");

  });

  test("set_effect off clears the effect", async () => {
    await session.deployEffect("a", EFFECT, true);
    const r = await session.setEffect("off");
    assert.equal(r["active_effect"], null);

  });

  test("measure_effect: within budget, then over budget", async () => {
    await session.deployEffect("a", EFFECT, true);
    const m = await session.measureEffect(1, { sleep: noSleep });
    assert.equal(m["verdict"], "within budget");
    assert.equal(m["budget_cycles"], 5_333_333);
    assert.equal(player.types().at(-1), "set_perf");
    assert.equal(player.received.at(-1)!["mode"], "OFF");
    player.perf.overruns = 3;
    player.perf.frameCyclesMax = 9_000_000;
    const m2 = await session.measureEffect(1, { sleep: noSleep });
    assert.match(String(m2["verdict"]), /over budget/);

  });

  test("textures: list + stream + stop", async () => {
    await session.deployEffect("tex", EFFECT, true);
    player.effect!.textures = [{ index: 0, width: 8, height: 4, elem: 3 }];
    assert.deepEqual(await session.listTextures(), [{ index: 0, width: 8, height: 4, elem: 3 }]);
    await session.streamTexture(0, { kind: "gradient", from: [1, 0, 0], to: [0, 0, 1] }, 30, { maxFrames: 3 });
    await new Promise((r) => setTimeout(r, 300));
    const frames = player.received.filter((m) => m.type === "set_texture");
    assert.equal(frames.length, 3);
    assert.equal(frames[0]!["width"], 8);
    assert.deepEqual(session.stopTexture(0), { stopped: false, frames: 0 }, "already stopped at maxFrames");
    await assert.rejects(session.streamTexture(5, { kind: "noise" }, 10), /no texture 5/);

  });
});

describe("safety", () => {
  test("the wire guard refuses every forbidden arm", async () => {
    // The client swallows the throw and reports a failed send; the guard records it.
    await assert.rejects(session.client.setHardwareConfig({ channel: 0, gpio: 9 } as never));
    assert.deepEqual(session.blockedTypes, ["set_hardware_config"]);
    assert.ok(!player.types().includes("set_hardware_config"), "never reached the wire");
    await session.deployEffect("a", EFFECT, true);
    await session.setUniforms({ rain: 0.5 });
    for (const t of session.sentTypes) assert.ok(!FORBIDDEN_TYPES.has(t), t);
    assert.equal(sniffType(new Uint8Array([0])), "field_0");
    await assert.rejects(session.setDeviceName("x", false), /confirm: true/);
    assert.equal(await session.setDeviceName("Kitchen", true), "Kitchen");

  });
});

describe("mcp", () => {
  test("lists the spec's tools (no set_playback) and runs compile/preview", async () => {
    const server = createServer(session);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    for (const want of [
      "compile_effect",
      "deploy_effect",
      "list_textures",
      "list_uniforms",
      "measure_effect",
      "preview_effect",
      "ramp_uniforms",
      "set_brightness",
      "set_effect",
      "set_uniforms",
      "stop_texture",
      "stream_texture",
    ]) {
      assert.ok(names.includes(want), want);
    }
    assert.ok(!names.includes("set_playback"));
    const resources = (await client.listResources()).resources.map((r) => r.uri).sort();
    const id = encodeURIComponent(player.mac);
    // The spec URIs (aliasing the default player), plus the hub's per-player,
    // players and room resources.
    assert.deepEqual(resources, [
      "splanc://device",
      "splanc://effect/active",
      "splanc://fixture/map",
      "splanc://fixture/summary",
      "splanc://fixture/topology",
      `splanc://player/${id}/device`,
      `splanc://player/${id}/effect/active`,
      `splanc://player/${id}/fixture/map`,
      `splanc://player/${id}/fixture/summary`,
      `splanc://player/${id}/fixture/topology`,
      "splanc://players",
      "splanc://room/all",
    ]);
    const c = await client.callTool({ name: "compile_effect", arguments: { source: EFFECT } });
    const parsed = JSON.parse((c.content as { text: string }[])[0]!.text);
    assert.equal(parsed.ok, true);
    const p = await client.callTool({ name: "preview_effect", arguments: { source: EFFECT, times: [0, 0.5] } });
    const content = p.content as { type: string; mimeType?: string; data?: string; text?: string }[];
    assert.equal(content.filter((x) => x.type === "image").length, 2);
    assert.equal(Buffer.from(content[1]!.data!, "base64").subarray(1, 4).toString(), "PNG");
    const bad = await client.callTool({ name: "set_uniforms", arguments: { values: { rain: 1 } } });
    assert.equal(bad.isError, true, "no effect loaded yet");
    await client.close();

  });

  test("compile_effect reports diagnostics for broken source", async () => {
    const c = await compile("vec3 shade(Led led) { return undefined_thing; }");
    assert.equal(c.ok, false);
    assert.ok(c.diagnostics.length > 0);

  });
});
