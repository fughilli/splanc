/**
 * Effect sharing over the mesh, app side (src/net/meshEffect.ts, mesh M6): the mesh_send
 * that carries a submit_effect of any size, through the real proto boundary.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { decodeClient, encodeClient } from "../src/net/proto";
import { meshEffectMessage, meshLargeShare, meshShareMessage, type MeshShareOptions } from "../src/net/meshEffect";

// Decoded bytes fields come back base64 (the flat JSON form).
const bytes = (v: unknown): number[] => Array.from(typeof v === "string" ? Buffer.from(v, "base64") : (v as Uint8Array));
const fxb = new Uint8Array(3800).map((_, i) => (i * 31) & 0xff);

test("a 3.8 KB effect rides one mesh_send, byte for byte", () => {
  const inner = encodeClient(meshEffectMessage("lava", fxb, { deck: 0 }));
  assert.ok(inner.length > 3800);
  const wire = encodeClient(meshShareMessage(inner, { opId: 42, nodes: [0x1170, 0x1f48], leadMs: 300 }));
  const back = decodeClient(wire) as unknown as Record<string, unknown>;
  assert.equal(back["type"], "mesh_send");
  assert.equal(back["opId"], 42);
  assert.equal(back["wantReply"], true, "results by default");
  assert.equal(back["leadMs"], 300);
  assert.deepEqual((back["targets"] as Record<string, unknown>)["nodes"], [0x1170, 0x1f48]);
  const got = Uint8Array.from(bytes(back["inner"]));
  assert.deepEqual(Array.from(got), Array.from(inner));
  const eff = decodeClient(got) as unknown as Record<string, unknown>;
  assert.equal(eff["type"], "submit_effect");
  assert.equal(eff["effectId"], "lava");
  assert.equal(eff["activate"], true);
  assert.deepEqual(bytes(eff["fxb"]), Array.from(fxb));
});

test("the large-effect hook shares what was sent directly, members only", async () => {
  const calls: [string, number, MeshShareOptions | undefined][] = [];
  const client = {
    meshShareEffect: async (id: string, b: Uint8Array, o?: MeshShareOptions) => {
      calls.push([id, b.length, o]);
      return {};
    },
  };
  assert.equal(meshLargeShare(client, { type: "set_brightness", brightness: 1 } as never), null);
  await meshLargeShare(client, meshEffectMessage("x", fxb, { deck: 1, activate: false }));
  assert.deepEqual(calls, [["x", 3800, { activate: false, deck: 1, skipGateway: true }]]);
  const t = decodeClient(encodeClient(meshShareMessage(new Uint8Array([1]), { skipGateway: true, group: 3 }))) as unknown as Record<string, unknown>;
  const tg = t["targets"] as Record<string, unknown>;
  assert.equal(tg["group"], 3);
  assert.equal(tg["skipGateway"], true);
});
