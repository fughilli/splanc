/**
 * Signed / ranged vector and mat3/mat4 uniforms through the bridge: per-component
 * validation, matrices addressed as 16 numbers column-major, the ≤4-float wire
 * chunking (old firmware keeps working), reassembly of the device's chunked
 * current values, component-wise ramps, and the MCP tools end to end.
 */

import assert from "node:assert/strict";
import { afterEach, before, beforeEach, describe, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { decodeClient, encodeClient } from "../../web/src/net/proto";
import { chunkUniformValues, reassembleUniformValues } from "../../web/src/net/uniformWire";
import { compile, loadFxHost } from "../src/fxhost";
import { createServer } from "../src/server";
import { DeviceSession } from "../src/session";
import { nodeSocketFactory } from "../src/socket";
import {
  coerce,
  componentRanges,
  currentByName,
  describe as describeUniform,
  lerpValues,
  resolve,
  resolveFull,
  UniformError,
  type ManifestUniform,
} from "../src/uniforms";
import { FakePlayer, TEST_CERT_SHA256, yFixture } from "./fakePlayer";

const WASM_ROOT = process.env["AGENT_WASM_ROOT"] ?? "wasm";

const IDENT4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

const EFFECT = `
uniform float gain : -2.0 .. 2.0 = -1.0;
uniform vec4 plane : -5 .. 5 = 0, 1, 0, 0;
uniform vec3 p : vec3(-1, -1, 0) .. vec3(1, 1, 2) = vec3(0);
uniform mat4 pose;
vec3 shade(Led led) {
  vec4 q = pose * vec4(led.pos, 1.0);
  float d = dot(plane.xyz, q.xyz) - plane.w + p.x;
  return vec3(abs(gain) * (0.2 + 0.8 * step(0.0, d)));
}
`;

const MAT: ManifestUniform = {
  name: "pose",
  slot: 4,
  width: 16,
  ui: { kind: "matrix", min: -10, max: 10 },
  default: IDENT4,
  min: -10,
  max: 10,
};
const PVEC: ManifestUniform = {
  name: "p",
  slot: 0,
  width: 3,
  ui: { kind: "slider", min: -1, max: 2, step: 0.01 },
  default: [0, 0, 0],
  min: -1,
  max: 2,
  mins: [-1, -1, 0],
  maxs: [1, 1, 2],
};

describe("uniform values (pure)", () => {
  test("per-component ranges, negatives allowed", () => {
    assert.deepEqual(componentRanges(PVEC), [
      { min: -1, max: 1 },
      { min: -1, max: 1 },
      { min: 0, max: 2 },
    ]);
    assert.deepEqual(coerce(PVEC, [-1, 0.5, 2]), [-1, 0.5, 2]);
    // z's own range is 0..2: -0.5 is out even though the envelope allows it.
    assert.throws(() => coerce(PVEC, [0, 0, -0.5]), (e: unknown) => e instanceof UniformError && /p\[2\]: -0.5 is outside 0..2/.test(e.message));
    assert.throws(() => coerce(PVEC, [1.5, 0, 0]), /p\[0\]/);
  });

  test("matrices: 16 numbers, range-checked; a scalar is s on the diagonal", () => {
    assert.deepEqual(coerce(MAT, IDENT4), IDENT4);
    assert.deepEqual(coerce(MAT, 2), IDENT4.map((x) => x * 2));
    assert.throws(() => coerce(MAT, [1, 2, 3]), /expected 16 value\(s\), got 3 \(a mat4 is 16 numbers, column-major\)/);
    assert.throws(() => coerce(MAT, IDENT4.map((x, i) => (i === 12 ? 11 : x))), /pose\[12\]: 11 is outside -10..10/);
    const d = describeUniform(MAT);
    assert.equal(d["rows"], 4);
    assert.equal(d["layout"], "column-major");
    assert.deepEqual(describeUniform(PVEC)["mins"], [-1, -1, 0]);
  });

  test("resolve chunks wide uniforms into ≤4-float slot runs; resolveFull doesn't", () => {
    const m = [PVEC, MAT];
    const pose = IDENT4.map((x, i) => x + i / 100);
    const wire = resolve(m, { pose, p: [0, 0, 1] });
    assert.deepEqual(
      wire.map((w) => [w.slot, w.value.length]),
      [
        [4, 4],
        [8, 4],
        [12, 4],
        [16, 4],
        [0, 3],
      ],
    );
    assert.deepEqual(wire.flatMap((w) => (w.slot >= 4 ? w.value : [])), pose);
    assert.deepEqual(resolveFull(m, { pose })[0]!.value, pose);
    // The device's chunked current values reassemble by slot range.
    const cur = currentByName(m, [...wire].reverse());
    assert.deepEqual(cur.get("pose"), pose);
    assert.deepEqual(cur.get("p"), [0, 0, 1]);
  });

  test("lerp is component-wise for vectors and matrices", () => {
    const to = IDENT4.map((x) => x * 3);
    assert.deepEqual(lerpValues(MAT, IDENT4, to, 0.5), IDENT4.map((x) => x * 2));
    assert.deepEqual(lerpValues(PVEC, [-1, -1, 0], [1, 1, 2], 0.25), [-0.5, -0.5, 0.5]);
  });

  test("the encoder chunks any >4-float UniformValue (set_uniforms, save_keypoint)", () => {
    const vals = [{ slot: 2, value: Array.from({ length: 9 }, (_, i) => i) }];
    const back = decodeClient(encodeClient({ type: "set_uniforms", values: vals } as never)) as unknown as {
      values: { slot: number; value: number[] }[];
    };
    assert.deepEqual(back.values, chunkUniformValues(vals));
    assert.ok(back.values.every((v) => v.value.length <= 4));
    assert.deepEqual(reassembleUniformValues(back.values, [{ slot: 2, width: 9 }]), vals);
  });
});

let player: FakePlayer;
let session: DeviceSession;

before(async () => {
  await loadFxHost(WASM_ROOT);
});

beforeEach(async () => {
  player = new FakePlayer();
  player.bundle = yFixture();
  await player.start();
  session = new DeviceSession({
    url: `wss://${player.host}/ws`,
    socketFactory: nodeSocketFactory({ pinSha256: TEST_CERT_SHA256 }),
  });
  await session.connect();
});

afterEach(async () => {
  session.close();
  await player.stop();
});

const settle = () => new Promise((r) => setTimeout(r, 50));

function sentValues(): { slot: number; value: number[] }[] {
  return player.received
    .filter((m) => m.type === "set_uniforms")
    .flatMap((m) => m["values"] as { slot: number; value: number[] }[]);
}

describe("wide uniforms on a player", () => {
  test("the compiler's manifest: ranged vectors, per-component ranges, a mat4", async () => {
    const c = await compile(EFFECT);
    assert.ok(c.ok, JSON.stringify(c.diagnostics));
    const by = new Map(c.uniforms.map((u) => [u.name, u]));
    assert.equal(by.get("gain")!.ui.kind, "slider");
    assert.equal(by.get("plane")!.ui.kind, "slider", "a ranged vec4 is not a colour");
    assert.deepEqual(by.get("p")!.mins, [-1, -1, 0]);
    assert.equal(by.get("pose")!.width, 16);
    assert.equal(by.get("pose")!.ui.kind, "matrix");
    assert.deepEqual(by.get("pose")!.default, IDENT4);
  });

  test("deploy, set a mat4 + signed vec, list them back (chunked on the wire)", async () => {
    await session.deployEffect("plane1", EFFECT, true);
    await settle();
    // Activation values: every UniformValue the player saw carries ≤ 4 floats.
    assert.ok(sentValues().length > 0);
    assert.ok(sentValues().every((v) => v.value.length <= 4), JSON.stringify(sentValues()));

    const pose = IDENT4.map((x, i) => (i === 12 ? -2.5 : x)); // translate x by -2.5 (column 3)
    await session.setUniforms({ pose, plane: [0, -1, 0, -4.5], gain: -2 });
    await settle();
    assert.ok(sentValues().every((v) => v.value.length <= 4));
    const lu = (await session.listUniforms()) as { uniforms: Record<string, unknown>[] };
    const get = (n: string) => lu.uniforms.find((u) => u["name"] === n)!;
    assert.deepEqual(get("pose")["current"], pose);
    assert.deepEqual(get("plane")["current"], [0, -1, 0, -4.5]);
    assert.deepEqual(get("gain")["current"], [-2]);
    assert.equal(get("pose")["rows"], 4);

    await assert.rejects(session.setUniforms({ p: [0, 0, -1] }), /p\[2\]: -1 is outside 0..2/);
    await assert.rejects(session.setUniforms({ pose: [1, 0, 0] }), /expected 16/);
  });

  test("ramp a matrix component-wise; the final set is chunked", async () => {
    await session.deployEffect("plane1", EFFECT, true);
    await settle();
    const target = IDENT4.map((x) => x * 3);
    const r = await session.rampUniforms({ pose: target }, 0.1, { hz: 30, sleep: async () => {} });
    assert.ok(r.steps >= 2);
    assert.deepEqual(r.final, [{ slot: r.final[0]!.slot, value: target }]);
    await settle();
    assert.ok(sentValues().every((v) => v.value.length <= 4));
    const lu = (await session.listUniforms()) as { uniforms: Record<string, unknown>[] };
    assert.deepEqual(lu.uniforms.find((u) => u["name"] === "pose")!["current"], target);
  });

  test("MCP set_uniforms with 16 numbers; schema documents column-major", async () => {
    const server = createServer(session);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const tools = (await client.listTools()).tools;
    const set = tools.find((t) => t.name === "set_uniforms")!;
    assert.match(JSON.stringify(set.inputSchema), /column-major/i);
    assert.match(tools.find((t) => t.name === "ramp_uniforms")!.description ?? "", /NOT a rotation interpolation/);

    await session.deployEffect("plane1", EFFECT, true);
    await settle();
    const pose = IDENT4.map((x, i) => (i === 13 ? 1.25 : x));
    const res = (await client.callTool({ name: "set_uniforms", arguments: { values: { pose } } })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    assert.ok(!res.isError, res.content[0]?.text);
    await settle();
    const lu = (await session.listUniforms()) as { uniforms: Record<string, unknown>[] };
    assert.deepEqual(lu.uniforms.find((u) => u["name"] === "pose")!["current"], pose);
    await client.close();
  });
});
