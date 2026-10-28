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
import { EffectLibrary, LIBRARY_INSTRUCTIONS } from "../relay/src/library";
import { SERVER_INSTRUCTIONS, TOOL_ANNOTATIONS } from "../src/annotations";
import { FileLibraryStore } from "../src/libraryLocal";
import { createServer } from "../src/server";
import { COMMIT_IN_PROTO, DeviceSession, FORBIDDEN_TYPES, ToolError, sniffType } from "../src/session";
import { nodeSocketFactory } from "../src/socket";
import { normFingerprint } from "../src/trust";
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
    // First sight of this device id: pinned to the certificate the GET came over.
    assert.equal(t.tls.pinSha256, normFingerprint(TEST_CERT_SHA256));
    assert.equal(t.trust?.kind, "first-sight");
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
    await new Promise((r) => setTimeout(r, 50));
    const before = player.received.length;
    await session.rampUniforms({ rain: 1 }, 0.2, { hz: 10, sleep: noSleep });
    await new Promise((r) => setTimeout(r, 50));
    const sets = player.received.slice(before).filter((m) => m.type === "set_uniforms");
    assert.equal(sets.length, 2);
    if (!COMMIT_IN_PROTO) for (const m of sets) assert.ok(!m["commit"], "no commit field on the wire");
    else assert.equal(sets.at(-1)!["commit"], true);
  });

  test("ramp streams uncommitted steps, then one final set of the targets", async () => {
    await session.deployEffect("rain1", EFFECT, true);
    await new Promise((res) => setTimeout(res, 50)); // the deploy's defaults land first
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

  test("deploy sends the declared defaults right after the submit (the VM starts uniforms at 0)", async () => {
    await session.deployEffect("rain1", EFFECT, true);
    await new Promise((r) => setTimeout(r, 50));
    const types = player.types();
    const submit = types.lastIndexOf("submit_effect");
    assert.ok(submit >= 0);
    assert.equal(types[submit + 1], "set_uniforms", "set_uniforms follows the submit");
    const m = player.received[submit + 1]!;
    assert.deepEqual(m["values"], [
      { slot: 0, value: [Math.fround(0.2)] },
      { slot: 1, value: [Math.fround(0.2), Math.fround(0.6), 1] },
      { slot: 4, value: [0] },
    ]);
    assert.ok(!m["commit"], "defaults go out uncommitted");
    // list_uniforms reflects them (not 0).
    const l = await session.listUniforms();
    const rain = (l["uniforms"] as { name: string; current: unknown }[]).find((u) => u.name === "rain")!;
    assert.deepEqual(rain.current, [Math.fround(0.2)]);
    // A deploy without activate doesn't touch the running effect's uniforms.
    const n = player.types().filter((t) => t === "set_uniforms").length;
    await session.deployEffect("staged", EFFECT_B, false);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(player.types().filter((t) => t === "set_uniforms").length, n);
  });

  test("rollback restores the previous effect's last-known uniforms (defaults where unset)", async () => {
    await session.deployEffect("a", EFFECT, true);
    await session.setUniforms({ rain: 0.9 });
    await session.deployEffect("b", EFFECT_B, true);
    await new Promise((r) => setTimeout(r, 50));
    const before = player.received.length;
    await session.rollback();
    await new Promise((r) => setTimeout(r, 50));
    const after = player.received.slice(before);
    const types = after.map((m) => m.type);
    const submit = types.lastIndexOf("submit_effect");
    assert.equal(types[submit + 1], "set_uniforms");
    assert.deepEqual(after[submit + 1]!["values"], [
      { slot: 0, value: [Math.fround(0.9)] },
      { slot: 1, value: [Math.fround(0.2), Math.fround(0.6), 1] },
      { slot: 4, value: [0] },
    ]);
    assert.deepEqual(player.effect?.current.find((c) => c.slot === 0)?.value, [Math.fround(0.9)]);
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
    assert.equal(typeof m["frame_ms_mean"], "number");
    assert.ok(Array.isArray(m["window_means_ms"]) && (m["window_means_ms"] as unknown[]).length >= 1);
    assert.equal(player.types().at(-1), "set_perf");
    assert.equal(player.received.at(-1)!["mode"], "OFF");
    player.perf.overruns = 3;
    player.perf.frameCyclesMax = 9_000_000;
    const m2 = await session.measureEffect(1, { sleep: noSleep });
    assert.match(String(m2["verdict"]), /over budget/);

  });

  test("measure_effect on autoscaling firmware (FUG-82): live fps, floor verdict, lagging (never parked)", async () => {
    await session.deployEffect("a", EFFECT, true);
    // 25 ms frames at a 35-fps target: overruns while it settles are the
    // autoscaler's business, not "over budget" (the floor is 25 fps).
    player.perf = { budgetCycles: Math.round(160_000_000 / 35), frameCyclesMean: 4_000_000, frameCyclesMax: 4_700_000, overruns: 4, currentFps: 35 };
    const m = await session.measureEffect(1, { sleep: noSleep });
    assert.equal(m["current_fps"], 35);
    assert.match(String(m["verdict"]), /^within budget \(the player runs it at 35 fps\)/);
    assert.equal(m["lagging"], undefined);
    // Mean cost over 95% of the 25-fps period: it can't hold the floor, so it lags
    // (an advisory: it keeps playing).
    player.perf = { budgetCycles: 160_000_000 / 25, frameCyclesMean: 6_200_000, frameCyclesMax: 6_500_000, overruns: 9, currentFps: 25 };
    const m2 = await session.measureEffect(1, { sleep: noSleep });
    assert.match(String(m2["verdict"]), /^over budget \(advisory\): it runs at ~25 fps on this device, below the 25 fps target/);
    assert.match(String(m2["verdict"]), /keeps playing/);
    assert.doesNotMatch(String(m2["verdict"]), /park/);
    // The player reports it lagging (fps_state{lagging}): the achieved rate is reported.
    player.perf = { budgetCycles: 160_000_000 / 25, frameCyclesMean: 8_900_000, frameCyclesMax: 9_100_000, overruns: 9, currentFps: 18 };
    player.lagOnNextPerf = { auto: true, targetFps: 0, achievedFps: 18 };
    const m3 = await session.measureEffect(1, { sleep: noSleep });
    assert.equal(m3["lagging"], true);
    assert.equal(m3["achieved_fps"], 18);
    assert.equal(m3["aborted"], undefined);
    assert.match(String(m3["verdict"]), /runs at ~18 fps on this device, below the 25 fps target — it keeps playing/);
    // A fresh deploy forgets the previous effect's lag report.
    player.perf = { budgetCycles: Math.round(160_000_000 / 60), frameCyclesMean: 900_000, frameCyclesMax: 1_000_000, overruns: 0, currentFps: 60 };
    await session.deployEffect("b", EFFECT, true);
    const m4 = await session.measureEffect(1, { sleep: noSleep });
    assert.equal(m4["lagging"], undefined);
    assert.match(String(m4["verdict"]), /^within budget/);
    // A pinned rate it can't hold names the pin.
    player.lagOnNextPerf = { auto: false, targetFps: 70, achievedFps: 52 };
    assert.match(String((await session.measureEffect(1, { sleep: noSleep }))["verdict"]), /~52 fps on this device, below the pinned 70 fps target/);
    // Pre-lag firmware that still parks (aborted): noted, not mistaken for lagging.
    await session.deployEffect("c", EFFECT, true);
    player.lagOnNextPerf = { auto: true, targetFps: 0, achievedFps: 0, oldAbort: true };
    const m5 = await session.measureEffect(1, { sleep: noSleep });
    assert.equal(m5["aborted"], true);
    assert.equal(m5["lagging"], undefined);
    assert.match(String(m5["note"]), /older firmware stopped the effect/);
    player.perf = { budgetCycles: 5_333_333, frameCyclesMean: 1_000_000, frameCyclesMax: 1_200_000, overruns: 0 };
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
  test("every tool is annotated (ChatGPT confirms any tool not marked read-only); instructions lead with 512 self-contained chars", async () => {
    // With the effects library (stdio/CLI), so its tools are checked too.
    const server = createServer(session, { library: new EffectLibrary(new FileLibraryStore(null)) });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const tools = (await client.listTools()).tools;
    assert.deepEqual(tools.map((t) => t.name).sort(), Object.keys(TOOL_ANNOTATIONS).sort(), "the table and the tools agree");
    for (const t of tools) {
      const a = t.annotations!;
      assert.ok(a, `${t.name} has annotations`);
      assert.equal(typeof a.title, "string", t.name);
      assert.equal(t.title, a.title, t.name);
      for (const k of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) {
        assert.equal(typeof a[k], "boolean", `${t.name}.${k}`);
      }
      assert.equal(a.openWorldHint, t.name === "file_bug", t.name); // file_bug reaches GitHub
      if (a.readOnlyHint) assert.equal(a.destructiveHint, false, t.name);
    }
    const ro = tools.filter((t) => t.annotations!.readOnlyHint).map((t) => t.name).sort();
    assert.deepEqual(ro, [
      "compile_effect",
      "driver_state",
      "estimate_effect",
      "export_map",
      "get_effect",
      "get_keypoint",
      "get_wifi_policy",
      "list_decks",
      "list_keypoints",
      "list_players",
      "list_textures",
      "list_uniforms",
      "plot_fixture",
      "preview_effect",
      "read_sensors",
      "refresh_players",
      "scan_i2c",
      "search_effects",
      "snapshot_fx",
    ]);
    const destructive = tools.filter((t) => t.annotations!.destructiveHint).map((t) => t.name);
    for (const d of ["forget_player", "delete_keypoint", "rollback_effect", "deploy_effect", "crossfade_to", "set_device_name", "trust_player", "delete_effect", "update_effect", "set_wifi_policy"]) {
      assert.ok(destructive.includes(d), d);
    }
    // measure_effect can roll back (rollback_on_overrun): not read-only.
    assert.equal(tools.find((t) => t.name === "measure_effect")!.annotations!.readOnlyHint, false);

    const instructions = client.getInstructions() ?? "";
    assert.equal(instructions, `${SERVER_INSTRUCTIONS}\n\n${LIBRARY_INSTRUCTIONS}`);
    const head = instructions.split("\n\n")[0]!;
    assert.ok(head.length <= 512, `first paragraph is ${head.length} chars`);
    for (const word of ["Splanc", "list_players", "identify_player", "set_brightness", "deploy_effect", "rollback_effect"]) {
      assert.ok(head.includes(word), word);
    }
    for (const name of instructions.match(/\b[a-z]+_[a-z_]+\b/g) ?? []) {
      assert.ok(name in TOOL_ANNOTATIONS, `instructions name a real tool: ${name}`);
    }
    await client.close();
  });

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
    assert.deepEqual(parsed.warnings, []);
    // A rate uniform times `time` in a phase compiles, with a warning naming the line.
    const cb = await client.callTool({ name: "compile_effect", arguments: { source: EFFECT_B } });
    const pb = JSON.parse((cb.content as { text: string }[])[0]!.text);
    assert.equal(pb.ok, true);
    assert.equal(pb.warnings.length, 1, JSON.stringify(pb.warnings));
    assert.equal(pb.warnings[0].line, 3);
    assert.match(pb.warnings[0].msg, /^warning: `time` scaled by the uniform `speed`/);
    // The offline estimate: no device traffic, ms + budget at the player's LED count.
    const before = player.received.length;
    const e = await client.callTool({ name: "estimate_effect", arguments: { source: EFFECT } });
    const est = JSON.parse((e.content as { text: string }[])[0]!.text);
    assert.equal(e.isError ?? false, false, JSON.stringify(est));
    assert.ok(est.estimate_ms > 0 && est.leds > 0, JSON.stringify(est));
    assert.equal(est.band_ms.length, 2);
    assert.ok(
      player.received.slice(before).every((m) => m.type !== "submit_effect" && m.type !== "set_perf"),
      "estimate_effect touches nothing that changes the device",
    );
    const p = await client.callTool({ name: "preview_effect", arguments: { source: EFFECT, times: [0, 0.5] } });
    const content = p.content as { type: string; mimeType?: string; data?: string; text?: string }[];
    assert.equal(content.filter((x) => x.type === "image").length, 2);
    assert.equal(Buffer.from(content[1]!.data!, "base64").subarray(1, 4).toString(), "PNG");
    const bad = await client.callTool({ name: "set_uniforms", arguments: { values: { rain: 1 } } });
    assert.equal(bad.isError, true, "no effect loaded yet");
    await client.close();

  });

  test("export_map returns the fixture as TouchDesigner CSV or a Chromatik .lxf", async () => {
    const server = createServer(session);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const call = async (args: Record<string, unknown>) => {
      const r = await client.callTool({ name: "export_map", arguments: args });
      assert.notEqual(r.isError, true, JSON.stringify(r.content));
      return JSON.parse((r.content as { text: string }[])[0]!.text) as Record<string, unknown>;
    };
    const csv = await call({});
    assert.equal(csv["format"], "csv");
    assert.match(String(csv["filename"]), /\.csv$/);
    const lines = String(csv["content"]).split("\n");
    assert.match(lines[0]!, /^index,P\(0\),P\(1\),P\(2\),mapped/);
    assert.equal(lines.length, 1 + 30);
    const lxf = await call({ format: "lxf" });
    const fx = JSON.parse(String(lxf["content"]));
    assert.equal(fx.components[0].type, "points");
    assert.equal(fx.components[0].coords.length, 30);
    await client.close();

  });

  test("export_map: arclength runs along the strip, segment_arclength along the topology", async () => {
    const server = createServer(session);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const r = await client.callTool({ name: "export_map", arguments: {} });
    const csv = String(JSON.parse((r.content as { text: string }[])[0]!.text)["content"]).split("\n");
    const header = csv[0]!.split(",");
    assert.deepEqual(header.slice(-3), ["segment", "arclength", "segment_arclength"]);
    const s = csv.slice(1).map((l) => Number(l.split(",")[header.indexOf("arclength")]));
    assert.equal(s[0], 0);
    for (let i = 1; i < s.length; i++) assert.ok(s[i]! > s[i - 1]!, `monotonic at ${i}: ${s[i - 1]} -> ${s[i]}`);
    await client.close();
  });

  test("device: an unconfigured channel count (0) reports the stored map's LEDs it renders (#397)", async () => {
    const read = async () => {
      const server = createServer(session);
      const [a, b] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "test", version: "0" });
      await Promise.all([server.connect(a), client.connect(b)]);
      const d = await client.readResource({ uri: "splanc://device" });
      await client.close();
      return JSON.parse((d.contents[0] as { text: string }).text) as {
        channels: { channel: number; ledCount: number; configuredLedCount: number; ledCountSource: string }[];
      };
    };
    player.hwLedCounts = [0, 0];
    const leds = player.bundle!.map!.ledCount;
    assert.ok(leds > 0);
    let d = await read();
    assert.deepEqual(
      d.channels.map((c) => [c.channel, c.ledCount, c.configuredLedCount, c.ledCountSource]),
      [
        [0, leds, 0, "map"],
        [1, 0, 0, "unset"],
      ],
    );
    // A configured count is reported as is (and doesn't need the map).
    player.hwLedCounts = [12, 7];
    d = await read();
    assert.deepEqual(
      d.channels.map((c) => [c.ledCount, c.configuredLedCount, c.ledCountSource]),
      [
        [12, 12, "configured"],
        [7, 7, "configured"],
      ],
    );
  });

  test("compile_effect reports diagnostics for broken source", async () => {
    const c = await compile("vec3 shade(Led led) { return undefined_thing; }");
    assert.equal(c.ok, false);
    assert.ok(c.diagnostics.length > 0);

  });
});
