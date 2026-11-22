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
  // Per-member answers ("Last change sent to the mesh"): discrete changes and committed
  // values ask for them, each move of a drag does not (the gateway holds few operations).
  assert.equal(b["wantReply"], true, "brightness");
  assert.equal((live as unknown as Record<string, unknown>)["wantReply"], false, "a slider move");
  assert.equal((xf as unknown as Record<string, unknown>)["wantReply"], false, "a crossfade move");
  const done = wrapForMesh(msg({ type: "set_uniforms", values: [{ slot: 1, value: [0.2] }], seq: 4, commit: true }), encodeClient);
  assert.equal((done as unknown as Record<string, unknown>)["wantReply"], true, "the slider let go (commit)");
  const once = wrapForMesh(msg({ type: "set_uniforms", values: [{ slot: 1, value: [0.2] }] }), encodeClient);
  assert.equal((once as unknown as Record<string, unknown>)["wantReply"], true, "a one-shot set");
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

test("the mesh UI is for players that advertise the mesh variant", async () => {
  const { deviceHasMesh } = await import("../src/net/mesh");
  assert.equal(deviceHasMesh({ features: ["effects", "mesh"] }), true);
  assert.equal(deviceHasMesh({ features: ["effects", "ota"] }), false);
  assert.equal(deviceHasMesh(null), false);
});

test("mesh_admin (M7): the wire both ways, and the firmware's answer", async () => {
  const { meshAdminMessage, meshAdminError } = await import("../src/net/mesh");
  const site = new Uint8Array(32).fill(7);
  const key = new Uint8Array(65).fill(4);
  const wire = encodeClient(meshAdminMessage({ provision: { meshId: 0x1234, siteSecret: site, adminKey: key, groups: [3] } }));
  const back = decodeClient(wire) as unknown as { type: string; provision: Record<string, unknown> };
  assert.equal(back.type, "mesh_admin");
  assert.equal(back.provision["meshId"], 0x1234);
  assert.deepEqual(back.provision["groups"], [3]);
  // ServerMessage{mesh{admin{op: UNLOCK, error: BAD_GRANT}}} as mesh_gw.rs encode_admin writes it.
  const m = decodeServer(unhex("ba03061a0408021004")) as unknown as MeshInfoMessage;
  assert.equal(m.type, "mesh");
  assert.equal(m.admin?.op, 2);
  assert.equal(m.admin?.error, "MESH_ADMIN_BAD_GRANT");
  assert.match(meshAdminError(m.admin) ?? "", /grant was refused/);
  assert.equal(meshAdminError({ op: 1, error: "MESH_ADMIN_OK" }), null);
});

test("mesh_admin provisioner token (D-324): issued on provision, presented on leave", async () => {
  const { meshAdminMessage } = await import("../src/net/mesh");
  const tok = new Uint8Array(16).fill(9);
  // proto3 JSON: bytes come back base64.
  const bytes = (v: unknown): number[] =>
    typeof v === "string" ? Array.from(Buffer.from(v, "base64")) : Array.from((v as Uint8Array | undefined) ?? []);
  const back = decodeClient(encodeClient(meshAdminMessage({ leave: { provisionerToken: tok } }))) as unknown as {
    leave: { provisionerToken?: Uint8Array };
  };
  assert.deepEqual(bytes(back.leave.provisionerToken), Array.from(tok));
  // A bare leave still encodes (the old shape).
  assert.ok(encodeClient(meshAdminMessage({ leave: {} })).length > 0);
  // ServerMessage{mesh{admin{op: PROVISION, value: 0, provisioner_token}}} as encode_admin writes it.
  const ans = "ba031a" + "1a18" + "0801" + "1000" + "1800" + "2210" + "09".repeat(16);
  const m = decodeServer(unhex(ans)) as unknown as MeshInfoMessage;
  assert.deepEqual(bytes(m.admin?.provisionerToken), Array.from(tok));
});
