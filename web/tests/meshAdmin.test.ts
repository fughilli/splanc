/**
 * Mesh administration from the app (mesh M7 wire, the M8 UI): the grant and rotation order
 * byte for byte against the Rust reference (firmware/mesh tool `mesh_admin_tool`), the
 * WebCrypto signer, the admin key store (no plaintext secrets at rest), the operations over
 * a simulated fixture, and the device sheet's Mesh section model.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { decodeClient, encodeClient } from "../src/net/proto";
import { meshAdminMessage, type MeshAdminOp, type MeshAdminResultInfo, type MeshResultInfo, type MeshStateInfo } from "../src/net/mesh";
import {
  adminSignerFromSecret,
  fromHex,
  grantSignedBytes,
  keyHash,
  keysHash,
  signGrant,
  signRekeyOrder,
  toHex,
  verifyAdminSignature,
  GRANT_LEN,
  ORDER_LEN,
} from "../src/net/meshKeys";
import { MemoryMeshBackend, MeshStore } from "../src/store/meshStore";
import {
  ensureUnlocked,
  isMemberOf,
  MeshAdminFailure,
  provisionFixture,
  revocationReplaces,
  revokeMembers,
  REV_REPLACE,
  unlockFixture,
  unlockedSession,
  waitForMember,
} from "../src/net/meshAdmin";
import { meshSectionModel, nodeLabel } from "../src/ui/screens/meshModel";
import { flowSteps, provisionFailureText } from "../src/ui/screens/meshFlowModel";

// Reference vectors from `mesh_admin_tool` (firmware/mesh/tool/main.rs) with a throwaway
// admin secret 000102…0f, mesh id 5e1f00d1:
//   pubkey 000102…0f 5e1f00d1
//   grant  000102…0f 5e1f00d1 7 3a41 <GK> 3600
//   keyhash <GK>
//   rekey  000102…0f 5e1f00d1 2 1 0011223344556677
const ADMIN_PK = fromHex(
  "04c882530d916498946920c10b9f048b0312eee19bf5684f2bf8c9de2350003bd2baa0ab9fe5df66d64a705ebef5b9ade6e9fdcd3e4cafb90dfbd9b07d772dfc18",
);
const GK = fromHex(
  "04982e4e877f382ea003f5360c5d4669e9ad1f3ca7f6d85b6bbbeae650d5529adf6befef4c20297b7293a7ac7f180d3e8fa3f8d4d7fb1a2b345047d857e3d6188a",
);
const RUST_GRANT = fromHex(
  "405e1f00d1000000073a4104982e4e877f382ea003f5360c5d4669e9ad1f3ca7f6d85b6bbbeae650d5529adf6befef4c20297b7293a7ac7f180d3e8fa3f8d4d7fb1a2b345047d857e3d6188a00000e1079f95c29a6fd0ad689985229b7e9ff99341f28f50dfb201120f017605e996605ac5aafbc474341f0eb79b06e0ac414f383180153e9786363cb519f8f4e5728c2",
);
const RUST_ORDER = fromHex(
  "5e1f00d102fc152fa86bd836980a757d8e9df17f5100010100112233445566770000000000000000000000000000000000000000000000008756a766da707cdba9fb3eb5b590b59d88bc4e56905ae1e1e9c18af5951ff8d7d443e8ec3162cd015317c8b456053435ef1b56cb0dedb8a36abbd729a2884255",
);
const RUST_MK = fromHex("1532f3918ea5649d54549fc9549ecd10");
const RUST_SS = fromHex("f5540cf168ae585e5cffc929aeefb0825a9ce95b8db3e2b49bdbc5123a8c81e2");

const GRANT_FIELDS = { meshId: 0x5e1f00d1, session: 7, gateway: 0x3a41, gatewayKey: GK, notAfter: 3600 };

test("grant: the Rust tool's signed bytes and signature verify under WebCrypto", async () => {
  assert.equal(RUST_GRANT.length, GRANT_LEN);
  const signed = grantSignedBytes(GRANT_FIELDS);
  assert.equal(signed.length, 87);
  assert.equal(new TextDecoder().decode(signed.subarray(0, 8)), "SMgrant1");
  // The wire is 0x40 ‖ the signed fields (without the tag) ‖ the signature.
  assert.deepEqual(RUST_GRANT.subarray(1, 80), signed.subarray(8));
  assert.ok(await verifyAdminSignature(ADMIN_PK, signed, RUST_GRANT.subarray(80)));
  assert.equal(await verifyAdminSignature(ADMIN_PK, grantSignedBytes({ ...GRANT_FIELDS, notAfter: 3601 }), RUST_GRANT.subarray(80)), false);
});

test("grant: the app's own grant has the Rust layout and its signature verifies", async () => {
  const store = new MeshStore();
  store.setBackend(new MemoryMeshBackend());
  const rec = await store.create("Test", { meshId: 0x5e1f00d1 });
  const signer = await store.signer(rec.meshId);
  assert.equal(signer.publicKey.length, 65);
  assert.equal(signer.publicKey[0], 4);
  const g = await signGrant(signer, GRANT_FIELDS);
  assert.equal(g.length, GRANT_LEN);
  assert.deepEqual(g.subarray(0, 80), RUST_GRANT.subarray(0, 80));
  assert.ok(await verifyAdminSignature(rec.adminPublic, grantSignedBytes(GRANT_FIELDS), g.subarray(80)));
});

test("key hashes and the rotation order match the Rust tool", async () => {
  assert.equal(toHex(await keyHash(GK)), "a5dc3949bc4eecfc");
  assert.equal(RUST_ORDER.length, ORDER_LEN);
  assert.deepEqual(await keysHash(RUST_MK, RUST_SS), RUST_ORDER.subarray(5, 21));
  // The Rust order's signature verifies over "SMrekey1" ‖ the order's fields.
  const signed = new Uint8Array(64);
  signed.set(new TextEncoder().encode("SMrekey1"));
  signed.set(RUST_ORDER.subarray(0, 56), 8);
  assert.ok(await verifyAdminSignature(ADMIN_PK, signed, RUST_ORDER.subarray(56)));
  // The app's order: same bytes up to the signature for the same keys and revocations.
  const store = new MeshStore();
  store.setBackend(new MemoryMeshBackend());
  const rec = await store.create("Test", { meshId: 0x5e1f00d1 });
  const signer = await store.signer(rec.meshId);
  const o = await signRekeyOrder(signer, {
    meshId: 0x5e1f00d1,
    epoch: 2,
    meshKey: RUST_MK,
    siteSecret: RUST_SS,
    revVersion: 1,
    revoked: [fromHex("0011223344556677")],
  });
  assert.equal(o.length, ORDER_LEN);
  assert.deepEqual(o.subarray(0, 56), RUST_ORDER.subarray(0, 56));
  assert.ok(await verifyAdminSignature(rec.adminPublic, signed, o.subarray(56)));
});

test("mesh_admin with bytes survives the proto boundary", () => {
  const grant = new Uint8Array(144).fill(9);
  const back = decodeClient(encodeClient(meshAdminMessage({ unlock: { grant } }))) as unknown as { unlock: { grant: string } };
  assert.equal(back.unlock.grant, Buffer.from(grant).toString("base64"));
  const site = new Uint8Array(32).fill(7);
  const p = decodeClient(
    encodeClient(meshAdminMessage({ provision: { meshId: 5, siteSecret: site, adminKey: ADMIN_PK } })),
  ) as unknown as { provision: { siteSecret: string; adminKey: string } };
  assert.equal(p.provision.siteSecret, Buffer.from(site).toString("base64"));
  assert.equal(p.provision.adminKey, Buffer.from(ADMIN_PK).toString("base64"));
});

test("the store keeps no plaintext site or admin secret", async () => {
  const be = new MemoryMeshBackend();
  const store = new MeshStore();
  store.setBackend(be);
  const rec = await store.create("  Living room  ");
  assert.equal(rec.name, "Living room");
  assert.notEqual(rec.meshId, 0);
  const site = await store.siteSecret(rec.meshId);
  assert.equal(site.length, 32);
  const raw = be.m.get(`mesh:${rec.meshId}`) as { adminPrivate?: CryptoKey; admin: { ct: Uint8Array }; site: { ct: Uint8Array } };
  assert.equal(raw.adminPrivate, undefined, "no device-bound key (D-442: the admin secret, sealed)");
  const hay = toHex(raw.site.ct);
  assert.ok(!hay.includes(toHex(site)), "the site secret is sealed");
  const backup = await store.exportBackup(rec.meshId);
  const admin = JSON.parse(atob(backup.slice("splanc-mesh-1:".length))).admin as string;
  assert.ok(!toHex(raw.admin.ct).includes(admin), "the admin secret is sealed");
  const wrap = be.m.get("wrap-key") as CryptoKey;
  assert.equal(wrap.extractable, false);
  // A fresh store over the same backend sees the mesh (persistence), but no secrets.
  const again = new MeshStore();
  again.setBackend(be);
  const list = await again.list();
  assert.equal(list.length, 1);
  assert.equal(Object.keys(list[0]!).some((k) => k === "site" || k === "admin" || k === "adminPrivate"), false);
  assert.deepEqual(await again.siteSecret(rec.meshId), site);
  // Roster bookkeeping, and a rotation replaces the secret.
  await again.putMember(rec.meshId, { deviceId: "d1", label: "Desk", node: 0x10, keyHash: "aa".repeat(8) });
  await again.putMember(rec.meshId, { deviceId: "d1", label: "Desk", node: 0x11, keyHash: "ab".repeat(8) });
  assert.deepEqual((await again.get(rec.meshId))!.members.map((m) => m.node), [0x11]);
  const next = new Uint8Array(32).fill(3);
  const r = await again.rotated(rec.meshId, { keyEpoch: 2, revVersion: 1, siteSecret: next, revoked: ["ab".repeat(8)], nodes: [0x11] });
  assert.equal(r.members.length, 0);
  assert.deepEqual(r.revoked, ["ab".repeat(8)]);
  assert.deepEqual(await again.siteSecret(rec.meshId), next);
  await again.forget(rec.meshId);
  assert.equal((await again.list()).length, 0);
});

/** A fixture as the firmware answers (mesh_gw.rs), enough for the app's flows. */
class FakeFixture {
  state: MeshStateInfo = { on: false };
  ops: MeshAdminOp[] = [];
  deviceKey = GK;
  node = 0x3a41;
  adminKey: Uint8Array | null = null;
  grants: Uint8Array[] = [];
  answer: Partial<Record<string, MeshAdminResultInfo>> = {};
  async getMesh(): Promise<MeshStateInfo> {
    return { ...this.state };
  }
  async meshAdmin(op: MeshAdminOp): Promise<MeshAdminResultInfo> {
    this.ops.push(op);
    const kind = Object.keys(op)[0]!;
    const forced = this.answer[kind];
    if (forced) return forced;
    if ("provision" in op) {
      if (this.adminKey && !this.state.session) return { op: 1, error: "MESH_ADMIN_LOCKED" };
      this.adminKey = op.provision.adminKey ?? null;
      this.state = { on: true, member: true, phase: 3, node: this.node, meshId: op.provision.meshId, adminKey: true, siteSecret: true, deviceKey: this.deviceKey, keyEpoch: 1, meshS: 100, sync: 2 };
      return { op: 1, error: "MESH_ADMIN_OK", provisionerToken: new Uint8Array(16).fill(0x5a) };
    }
    if ("unlock" in op) {
      const g = op.unlock.grant;
      this.grants.push(g);
      const fields = { meshId: this.state.meshId!, session: new DataView(g.buffer, g.byteOffset).getUint32(5), gateway: this.node, gatewayKey: this.deviceKey, notAfter: new DataView(g.buffer, g.byteOffset).getUint32(76) };
      const ok = await verifyAdminSignature(this.adminKey!, grantSignedBytes(fields), g.subarray(80));
      if (!ok) return { op: 2, error: "MESH_ADMIN_BAD_GRANT" };
      this.state = { ...this.state, session: fields.session, gateway: true };
      return { op: 2, value: fields.session };
    }
    return { op: 3 };
  }
}

test("provision, unlock on connect, and a refused re-provision", async () => {
  const store = new MeshStore();
  store.setBackend(new MemoryMeshBackend());
  const rec = await store.create("Home");
  const fx = new FakeFixture();
  const site = await store.siteSecret(rec.meshId);
  const res = await provisionFixture(fx, rec, site);
  assert.equal(res.member.node, 0x3a41);
  assert.equal(res.member.keyHash, "a5dc3949bc4eecfc");
  assert.deepEqual(res.provisionerToken, new Uint8Array(16).fill(0x5a));
  // Kept sealed, read back for a later leave.
  await store.putMember(rec.meshId, { deviceId: "d", label: "D", ...res.member }, res.provisionerToken);
  assert.deepEqual(await store.provisionerToken(rec.meshId, res.member.node), new Uint8Array(16).fill(0x5a));
  const prov = (fx.ops[0] as { provision: { siteSecret: Uint8Array; adminKey: Uint8Array; meshId: number } }).provision;
  assert.deepEqual(prov.adminKey, rec.adminPublic);
  assert.deepEqual(prov.siteSecret, site);
  assert.ok(isMemberOf(await waitForMember(fx, rec.meshId, { timeoutMs: 10 }), rec.meshId));

  const lookup = async (id: number) => (id === rec.meshId ? { signer: await store.signer(id) } : null);
  assert.equal(await ensureUnlocked(fx, lookup), true);
  assert.equal(fx.grants.length, 1);
  const held = unlockedSession(fx)!;
  assert.equal(held.session, fx.state.session);
  assert.equal(held.notAfter, 100 + 8 * 3600);
  // Live session: no second grant.
  assert.equal(await ensureUnlocked(fx, lookup), true);
  assert.equal(fx.grants.length, 1);
  // Near expiry: renewed.
  fx.state.meshS = held.notAfter - 60;
  assert.equal(await ensureUnlocked(fx, lookup), true);
  assert.equal(fx.grants.length, 2);
  // A mesh this app doesn't hold: nothing sent.
  const other = new FakeFixture();
  other.state = { on: true, member: true, meshId: 99, adminKey: true, node: 1, deviceKey: GK };
  assert.equal(await ensureUnlocked(other, lookup), false);
  assert.equal(other.grants.length, 0);

  // Someone else's mesh refuses the provision; the app words it.
  const foreign = new FakeFixture();
  foreign.adminKey = new Uint8Array(65);
  await assert.rejects(provisionFixture(foreign, rec, site), (e: unknown) => e instanceof MeshAdminFailure && e.code === "MESH_ADMIN_LOCKED");
  assert.match(provisionFailureText("MESH_ADMIN_LOCKED", ""), /another phone/);
  assert.match(provisionFailureText("MESH_ADMIN_NO_MEMORY", ""), /enough free memory/);
});

test("waitForMember rides out a poll that times out while the mesh turns on", async () => {
  let calls = 0;
  const slow = {
    async getMesh() {
      calls += 1;
      if (calls === 1) {
        const e = new Error("timed out after 5000 ms waiting for mesh");
        e.name = "RequestTimeoutError";
        throw e;
      }
      return { on: true, member: true, meshId: 7, node: 0x9878, phase: 3 };
    },
  } as unknown as Parameters<typeof waitForMember>[0];
  const s = await waitForMember(slow, 7, { timeoutMs: 1000, intervalMs: 1 });
  assert.equal(calls, 2);
  assert.ok(isMemberOf(s, 7));
});

test("waitForMember passes on other errors", async () => {
  const broken = {
    async getMesh() {
      throw new Error("socket closed");
    },
  } as unknown as Parameters<typeof waitForMember>[0];
  await assert.rejects(waitForMember(broken, 7, { timeoutMs: 1000 }), /socket closed/);
});


test("a grant from another admin key is refused", async () => {
  const store = new MeshStore();
  store.setBackend(new MemoryMeshBackend());
  const a = await store.create("A");
  const b = await store.create("B");
  const fx = new FakeFixture();
  await provisionFixture(fx, a, null);
  await assert.rejects(unlockFixture(fx, await store.signer(b.meshId), a.meshId), /grant was refused/);
});

test("revoke: the next epoch and revocation version, the excluded node, a verifiable order", async () => {
  const store = new MeshStore();
  store.setBackend(new MemoryMeshBackend());
  const rec = await store.create("Home");
  const fx = new FakeFixture();
  fx.state = { on: true, member: true, meshId: rec.meshId, keyEpoch: 255, node: 1, deviceKey: GK };
  const r = await revokeMembers(fx, await store.signer(rec.meshId), rec, [{ node: 0x7c02, keyHash: "0011223344556677" }], fx.state);
  assert.equal(r.keyEpoch, 1, "epochs wrap past 255 and skip 0");
  assert.equal(r.revVersion, 1);
  const op = (fx.ops[0] as { revoke: { order: Uint8Array; meshKey: Uint8Array; siteSecret: Uint8Array; exclude: number[] } }).revoke;
  assert.deepEqual(op.exclude, [0x7c02]);
  assert.equal(op.order.length, ORDER_LEN);
  assert.deepEqual(op.order.subarray(24, 32), fromHex("0011223344556677"));
  assert.deepEqual(op.siteSecret, r.siteSecret);
  assert.ok(op.meshKey.every((x) => x === 0), "the mesh key is zeroed once sent");
  const signed = new Uint8Array(64);
  signed.set(new TextEncoder().encode("SMrekey1"));
  signed.set(op.order.subarray(0, 56), 8);
  assert.ok(await verifyAdminSignature(rec.adminPublic, signed, op.order.subarray(56)));
});

test("D-442: the admin key derives from its exportable secret exactly as mesh_admin_tool's", async () => {
  const secret = Uint8Array.from({ length: 16 }, (_, i) => i);
  const signer = await adminSignerFromSecret(secret, 0x5e1f00d1);
  assert.deepEqual(signer.publicKey, ADMIN_PK);
  const msg = new TextEncoder().encode("SMgrant1 test");
  assert.ok(await verifyAdminSignature(ADMIN_PK, msg, await signer.sign(msg)));
});

test("D-442: a mesh backup moves the admin key and site secret to another phone", async () => {
  const a = new MeshStore();
  a.setBackend(new MemoryMeshBackend());
  const rec = await a.create("Home");
  const text = await a.exportBackup(rec.meshId);
  assert.match(text, /^splanc-mesh-1:/);
  const b = new MeshStore();
  b.setBackend(new MemoryMeshBackend());
  const got = await b.importBackup(text);
  assert.equal(got.meshId, rec.meshId);
  assert.equal(got.name, "Home");
  assert.deepEqual(got.adminPublic, rec.adminPublic);
  assert.deepEqual(await b.siteSecret(rec.meshId), await a.siteSecret(rec.meshId));
  const msg = new TextEncoder().encode("x");
  assert.ok(await verifyAdminSignature(rec.adminPublic, msg, await (await b.signer(rec.meshId)).sign(msg)));
  await assert.rejects(b.importBackup("hello"), /not a Splanc mesh backup/);
  await assert.rejects(b.importBackup("splanc-mesh-1:@@@"), /damaged/);
});

test("D-443: near capacity, a block starts a fresh revocation list", async () => {
  assert.equal(revocationReplaces(0, 1), false);
  assert.equal(revocationReplaces(5, 1), false);
  assert.equal(revocationReplaces(6, 1), true, "fewer than two free slots: replace");
  const store = new MeshStore();
  store.setBackend(new MemoryMeshBackend());
  const rec = await store.create("Home");
  const full = { ...rec, revVersion: 6, revoked: ["01", "02", "03", "04", "05", "06"].map((x) => x.repeat(8)) };
  const fx = new FakeFixture();
  fx.state = { on: true, member: true, meshId: rec.meshId, keyEpoch: 3, node: 1, deviceKey: GK, revoked: 6 };
  const r = await revokeMembers(fx, await store.signer(rec.meshId), full, [{ node: 0x7c02, keyHash: "0011223344556677" }], fx.state);
  assert.equal(r.replaced, true);
  assert.equal(r.revVersion, 7, "the stored version has no flag");
  const order = (fx.ops[0] as { revoke: { order: Uint8Array } }).revoke.order;
  assert.equal((order[21]! << 8) | order[22]!, 7 | REV_REPLACE, "the order carries the replace flag");
});

test("the Mesh section model", () => {
  const none = meshSectionModel({ on: false }, undefined, "Desk");
  assert.equal(none.kind, "none");
  assert.equal(meshSectionModel({ on: true, phase: 2 }, undefined, "Desk").kind, "joining");
  const rec = {
    meshId: 5,
    name: "Home",
    createdAt: "",
    adminPublic: ADMIN_PK,
    keyEpoch: 1,
    revVersion: 0,
    members: [{ deviceId: "b", label: "Hall lamp", node: 0x7c02, keyHash: "aa".repeat(8) }],
    revoked: [],
  };
  const s: MeshStateInfo = {
    on: true,
    member: true,
    node: 0x3a41,
    meshId: 5,
    adminKey: true,
    sync: 2,
    session: 0,
    members: [
      { node: 0x7c02, rssi: -41, sync: 2, fps: 80 },
      { node: 0x91e4, sync: 1 },
    ],
    pending: [{ node: 0x22, keyHash: new Uint8Array(8) }],
  };
  const locked = meshSectionModel(s, rec, "Desk");
  assert.equal(locked.kind, "admin");
  assert.equal(locked.meshName, "Home");
  assert.equal(locked.canControl, false, "no session yet");
  assert.deepEqual(locked.members.map((m) => m.name), ["Desk", "Hall lamp", nodeLabel(0x91e4)]);
  assert.equal(locked.members[1]!.detail, "Time synced · -41 dBm · 80 fps");
  assert.equal(locked.members[1]!.keyHash, "aa".repeat(8));
  assert.equal(locked.members[2]!.keyHash, null);
  assert.equal(locked.pending.length, 1);
  assert.equal(locked.status, "3 fixtures · time synced");
  assert.equal(meshSectionModel({ ...s, session: 9 }, rec, "Desk").canControl, true);
  const foreign = meshSectionModel({ ...s, session: 9 }, undefined, "Desk");
  assert.equal(foreign.kind, "foreign");
  assert.equal(foreign.canControl, false);
  assert.equal(foreign.pending.length, 0);
  const dev = meshSectionModel({ ...s, adminKey: false }, undefined, "Desk");
  assert.equal(dev.kind, "dev");
  assert.equal(dev.canControl, true);
});

test("the flow: one step per screen", () => {
  assert.deepEqual(flowSteps("new"), ["intro", "pick", "name", "setup", "joined"]);
  assert.deepEqual(flowSteps("add"), ["pick", "setup", "joined"]);
});

test("whole-mesh control: small changes wrap, effect programs go to the effect sharer, others stay direct", async () => {
  const { meshRoute } = await import("../src/net/mesh");
  const m = (x: Record<string, unknown>) => x as unknown as import("@ledmapper/protocol").ClientMessage;
  assert.equal(meshRoute(m({ type: "set_brightness", brightness: 0.5 }), encodeClient).kind, "wrap");
  assert.equal(meshRoute(m({ type: "get_mesh" }), encodeClient).kind, "direct");
  const big = meshRoute(m({ type: "submit_effect", effectId: "fx", fxb: new Uint8Array(400).fill(1), activate: true }), encodeClient);
  assert.equal(big.kind, "large");
  assert.ok(big.kind === "large" && big.inner.length > 400);
});

test("per-member results: which fixtures got a whole-mesh change", async () => {
  const { meshResultSummary } = await import("../src/ui/screens/meshModel");
  const names: Record<number, string> = { 2: "Desk Lamp", 3: "Hall Lamp" };
  const all = meshResultSummary(
    { complete: true, gatewayStatus: 0, members: [{ node: 2, status: "MESH_MEMBER_OK", latencyMs: 41 }, { node: 3, status: 0 }] },
    (n) => names[n] ?? nodeLabel(n),
    { node: 1, name: "Living Room" },
  );
  assert.equal(all.line, "Reached all 3 fixtures");
  assert.ok(all.allOk);
  assert.deepEqual(all.rows.map((r) => [r.name, r.text]), [["Living Room", "Got it"], ["Desk Lamp", "Got it in 41 ms"], ["Hall Lamp", "Got it"]]);
  const some = meshResultSummary(
    { complete: true, members: [{ node: 2, status: "MESH_MEMBER_MISSING" }, { node: 3, status: 3 }, { node: 9, status: "MESH_MEMBER_OK" }] },
    (n) => names[n] ?? nodeLabel(n),
  );
  assert.equal(some.line, "Reached 1 of 3 fixtures");
  assert.deepEqual(some.rows.filter((r) => !r.ok).map((r) => [r.name, r.text]), [["Desk Lamp", "Didn't answer in time"], ["Hall Lamp", "Couldn't apply it"]]);
  assert.equal(some.rows[2]!.name, nodeLabel(9));
  assert.equal(meshResultSummary({ complete: false, members: [{ node: 2 }] }, () => "x").partial, true);
});

test("a large relayed effect is shared with the other members (M6, skipGateway)", async () => {
  await import("../src/store/meshSession"); // registers the sharer
  const { meshLargeSender, meshRoute } = await import("../src/net/mesh");
  const sharer = meshLargeSender();
  assert.ok(sharer, "the app registers the M6 sharer");
  const calls: { id: string; n: number; opts: Record<string, unknown> }[] = [];
  const client = {
    async meshShareEffect(id: string, fxb: Uint8Array, opts: Record<string, unknown>) {
      calls.push({ id, n: fxb.length, opts });
      return {};
    },
  };
  const msg = { type: "submit_effect", effectId: "big", fxb: new Uint8Array(3000).fill(2), activate: true, deck: 1 } as unknown as import("@ledmapper/protocol").ClientMessage;
  const route = meshRoute(msg, encodeClient);
  assert.equal(route.kind, "large");
  sharer!.share(client, msg, route.kind === "large" ? route.inner : new Uint8Array());
  assert.deepEqual(calls, [{ id: "big", n: 3000, opts: { activate: true, deck: 1, skipGateway: true } }]);
});

test("unlock on connect: one subscription per client, an unlock on every (re)connect", async () => {
  const { unlockMeshOnConnect, lastMeshResult } = await import("../src/store/meshSession");
  let subs = 0;
  let reads = 0;
  let current = true;
  const fns: ((r: MeshResultInfo) => void)[] = [];
  const c = {
    meshState: null,
    onMeshResult(fn: (r: MeshResultInfo) => void) {
      subs++;
      fns.push(fn);
      return () => undefined;
    },
    async getMesh(): Promise<MeshStateInfo> {
      reads++;
      return {}; // not in a mesh: nothing to unlock
    },
    async meshAdmin(): Promise<MeshAdminResultInfo> {
      return {};
    },
  };
  unlockMeshOnConnect(c, () => current); // the first connect
  unlockMeshOnConnect(c, () => current); // a background reconnect of the same client
  current = false; // the connection is gone: no renewal timer outlives the test
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(subs, 1, "results are collected once per client");
  assert.equal(reads, 2, "each (re)connect checks the session again");
  for (const fn of fns) fn({ opId: 7, members: [{ node: 2, latencyMs: 30 }] });
  assert.equal(lastMeshResult(c)?.opId, 7);
});
