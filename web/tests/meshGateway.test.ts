/**
 * The mesh gateway, app side (src/net/mesh.ts): what goes over the mesh and how, through
 * the real proto boundary, and the firmware's hand-encoded result (mesh_gw.rs golden).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { ClientMessage } from "@ledmapper/protocol";
import { decodeClient, decodeServer, encodeClient } from "../src/net/proto";
import {
  MESH_LEAD_MS,
  meshPeers,
  meshResultError,
  meshSummary,
  wrapForMesh,
  type MeshInfoMessage,
} from "../src/net/mesh";

const msg = (m: Record<string, unknown>): ClientMessage => m as unknown as ClientMessage;
const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (h: string): Uint8Array => new Uint8Array(h.match(/../g)!.map((x) => parseInt(x, 16)));

test("discrete changes are scheduled ahead; live moves go on arrival", () => {
  const b = wrapForMesh(msg({ type: "set_brightness", brightness: 0.5 }), encodeClient) as unknown as Record<string, unknown>;
  assert.equal(b["type"], "mesh_send");
  assert.equal(b["leadMs"], MESH_LEAD_MS);
  const wire = decodeClient(encodeClient(b as unknown as ClientMessage)) as unknown as Record<string, unknown>;
  assert.equal(wire["type"], "mesh_send");
  assert.equal(wire["leadMs"], MESH_LEAD_MS);
  // The inner is the message itself, byte for byte.
  const inner = encodeClient(msg({ type: "set_brightness", brightness: 0.5 }));
  assert.equal(hex(b["inner"] as Uint8Array), hex(inner));

  const live = wrapForMesh(msg({ type: "set_uniforms", values: [{ slot: 1, value: [0.2] }], seq: 3, commit: false }), encodeClient);
  assert.equal((live as unknown as Record<string, unknown>)["leadMs"], undefined);
  const xf = wrapForMesh(msg({ type: "set_crossfade", position: 0.4, seq: 9 }), encodeClient);
  assert.equal((xf as unknown as Record<string, unknown>)["leadMs"], undefined, "a crossfade drag");
  // Already scheduled by the caller: left alone.
  const at = wrapForMesh(msg({ type: "set_effect", effectId: "x", applyAtMs: 5000 }), encodeClient);
  assert.equal((at as unknown as Record<string, unknown>)["leadMs"], undefined);
});

test("only the relay allow-list, and only what fits one mesh packet", () => {
  assert.equal(wrapForMesh(msg({ type: "set_device_name", name: "x" }), encodeClient), null);
  assert.equal(wrapForMesh(msg({ type: "set_wifi_policy", mode: "auto" }), encodeClient), null);
  assert.equal(wrapForMesh(msg({ type: "ota_begin" }), encodeClient), null);
  const small = wrapForMesh(msg({ type: "submit_effect", effectId: "tiny", fxb: new Uint8Array(40), activate: true }), encodeClient);
  assert.notEqual(small, null);
  const big = wrapForMesh(msg({ type: "submit_effect", effectId: "big", fxb: new Uint8Array(400), activate: true }), encodeClient);
  assert.equal(big, null, "effects that big wait for M6");
});

test("the firmware's hand-encoded result decodes (mesh_gw.rs golden)", () => {
  const m = decodeServer(unhex("ba031a0a1808091a040811200c1a0908221002181b20ac02200128d209")) as unknown as MeshInfoMessage;
  assert.equal(m.type, "mesh");
  const r = m.result!;
  assert.equal(r.opId, 9);
  assert.equal(r.complete, true);
  assert.equal(r.applyAtMs, 1234);
  assert.equal(meshResultError(r), null);
  assert.deepEqual(
    r.members!.map((x) => [x.node, x.status, x.code, x.latencyMs]),
    [
      [0x11, "MESH_MEMBER_OK", 0, 12],
      [0x22, "MESH_MEMBER_REFUSED", 27, 300],
    ],
  );
});

test("gateway errors and the card's summary", () => {
  assert.equal(meshResultError({ error: "MESH_SEND_NOT_ALLOWED" }), "that change cannot be sent over the mesh");
  assert.equal(meshResultError({ error: 3 }), "too big to send over the mesh");
  assert.equal(meshResultError({ error: "MESH_SEND_OK" }), null);
  const s = { on: true, member: true, node: 1, sync: 2, members: [{ node: 2 }, { node: 3 }] };
  assert.equal(meshPeers(s).length, 2);
  assert.equal(meshSummary(s), "Meshed with 2 other fixtures · time synced");
  assert.equal(meshSummary({ on: true, member: true, node: 1, members: [] }), null);
  assert.equal(meshSummary({ on: false }), null);
  assert.equal(meshSummary({ on: true, member: true, node: 1, sync: 0, members: [{ node: 4 }] }), "Meshed with 1 other fixture · time not synced yet");
});
