/**
 * Revocable access (docs/design/share-links.md; firmware admin.rs Delegation, #655): the
 * owner's app certifies a delegate key; the delegate's app unlocks with a delegated grant
 * and its certificate; revoking rotates the keys with the delegate on the revocation list,
 * and later fresh lists carry it while it could still sign.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decodeDelegation,
  DELEGATION_LEN,
  delegationSignedBytes,
  fromHex,
  GRANT_LEN_DELEGATED,
  grantSignedBytes,
  keyHash,
  NO_EXPIRY,
  ORDER_REVOKED,
  toHex,
  verifyAdminSignature,
} from "../src/net/meshKeys";
import { revokeMembers, unlockFixture } from "../src/net/meshAdmin";
import type { MeshAdminOp, MeshAdminResultInfo, MeshStateInfo } from "../src/net/mesh";
import { keepRevoked, MemoryMeshBackend, MeshStore } from "../src/store/meshStore";

const MESH = 0x5e1f00d1;
const GK = fromHex(
  "04982e4e877f382ea003f5360c5d4669e9ad1f3ca7f6d85b6bbbeae650d5529adf6befef4c20297b7293a7ac7f180d3e8fa3f8d4d7fb1a2b345047d857e3d6188a",
);

function store(): MeshStore {
  const s = new MeshStore();
  s.setBackend(new MemoryMeshBackend());
  return s;
}

/** A gateway that checks a delegated unlock the way admin.rs AdminGate::unlock does. */
class Gateway {
  ops: MeshAdminOp[] = [];
  constructor(
    private readonly adminPublic: Uint8Array,
    public state: MeshStateInfo = { on: true, member: true, node: 0x3a41, meshId: MESH, adminKey: true, deviceKey: GK, keyEpoch: 1, meshS: 1_000 },
  ) {}
  async getMesh(): Promise<MeshStateInfo> {
    return { ...this.state };
  }
  async meshAdmin(op: MeshAdminOp): Promise<MeshAdminResultInfo> {
    this.ops.push(op);
    if (!("unlock" in op)) return { op: 4, error: "MESH_ADMIN_OK" };
    const g = op.unlock.grant;
    const dv = new DataView(g.buffer, g.byteOffset);
    const fields = { meshId: dv.getUint32(1), session: dv.getUint32(5), gateway: dv.getUint16(9), gatewayKey: g.slice(11, 76), notAfter: dv.getUint32(76) };
    let signer = this.adminPublic;
    if (g[0] === 0x44) {
      const d = op.unlock.delegation ? decodeDelegation(op.unlock.delegation) : null;
      if (!d || !(await verifyAdminSignature(this.adminPublic, delegationSignedBytes(d), d.sig))) return { op: 2, error: "MESH_ADMIN_BAD_GRANT" };
      if (toHex(await keyHash(d.key)) !== toHex(g.slice(144))) return { op: 2, error: "MESH_ADMIN_BAD_GRANT" };
      if (d.notAfter !== NO_EXPIRY && fields.notAfter > d.notAfter) return { op: 2, error: "MESH_ADMIN_BAD_GRANT" };
      signer = d.key;
    }
    const ok = await verifyAdminSignature(signer, grantSignedBytes(fields), g.subarray(80, 144));
    return ok ? { op: 2, value: fields.session } : { op: 2, error: "MESH_ADMIN_BAD_GRANT" };
  }
}

test("a certificate has the firmware's layout and verifies under the owner's admin key", async () => {
  const owner = store();
  const rec = await owner.create("Home", { meshId: MESH });
  const issued = await owner.issueDelegate(MESH, { label: "Sam", notAfter: 5_000, expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
  const cert = fromHex(issued.body.delegation!);
  assert.equal(cert.length, DELEGATION_LEN);
  assert.equal(cert[0], 0x45);
  const d = decodeDelegation(cert)!;
  assert.equal(d.meshId, MESH);
  assert.equal(d.notAfter, 5_000);
  const signed = delegationSignedBytes(d);
  assert.equal(new TextDecoder().decode(signed.subarray(0, 8)), "SMdeleg1");
  assert.deepEqual(signed.subarray(8), cert.subarray(1, 74), "the wire is the tag ‖ the signed fields ‖ the signature");
  assert.ok(await verifyAdminSignature(rec.adminPublic, signed, d.sig));
  assert.equal(issued.keyHash, toHex(await keyHash(d.key)));
  assert.equal(issued.body.tokens, undefined, "a delegate gets no provisioner tokens");
  // Nothing is listed until the link goes out.
  assert.equal((await owner.get(MESH))!.delegates.length, 0);
  await issued.commit();
  assert.deepEqual((await owner.get(MESH))!.delegates.map((x) => x.label), ["Sam"]);
});

test("the delegate's phone holds the mesh as a delegate, unlocks with its certificate, and can't share it on", async () => {
  const owner = store();
  const rec = await owner.create("Home", { meshId: MESH });
  const issued = await owner.issueDelegate(MESH, { label: "Sam", notAfter: 3_000, expiresAt: new Date(Date.now() + 86_400_000).toISOString() });

  const sam = store();
  const got = await sam.importBody(issued.body);
  assert.equal(got.role, "delegate");
  assert.deepEqual(got.adminPublic, rec.adminPublic, "fixtures hold the owner's key; the delegate keeps it too");
  assert.ok(got.delegateUntil);
  assert.equal(await sam.exportable(MESH), false);
  await assert.rejects(sam.exportBody(MESH), /can't be shared/);
  await assert.rejects(sam.issueDelegate(MESH, { label: "x", notAfter: 0 }));

  const gw = new Gateway(rec.adminPublic);
  const cert = await sam.delegation(MESH);
  const u = await unlockFixture(gw, await sam.signer(MESH), MESH, undefined, { delegation: cert });
  const op = (gw.ops[0] as { unlock: { grant: Uint8Array; delegation?: Uint8Array } }).unlock;
  assert.equal(op.grant.length, GRANT_LEN_DELEGATED);
  assert.equal(op.grant[0], 0x44);
  assert.deepEqual(op.delegation, cert);
  assert.equal(u.notAfter, 3_000, "the grant never outlives the certificate");

  // An expired certificate doesn't even try.
  gw.state = { ...gw.state, meshS: 3_000 };
  await assert.rejects(unlockFixture(gw, await sam.signer(MESH), MESH, undefined, { delegation: cert }), /expired/);
});

test("a delegate link can't downgrade a phone that owns the mesh, and a forged certificate is refused", async () => {
  const owner = store();
  await owner.create("Home", { meshId: MESH });
  const issued = await owner.issueDelegate(MESH, { label: "Sam", notAfter: 0 });
  await assert.rejects(owner.importBody(issued.body), /already administers/);
  const other = store();
  await other.create("Other", { meshId: MESH });
  const forged = { ...issued.body, adminPublic: toHex((await other.get(MESH))!.adminPublic) };
  await assert.rejects(store().importBody(forged), /damaged/);
});

test("revoking a delegate rotates with its key hash, excludes no fixture, and a fresh list keeps it", async () => {
  const owner = store();
  const rec = await owner.create("Home", { meshId: MESH });
  const gw = new Gateway(rec.adminPublic);
  const r = await revokeMembers(gw, await owner.signer(MESH), rec, [{ node: 0, keyHash: "aabbccddeeff0011" }], gw.state);
  const op = (gw.ops[0] as { revoke: { order: Uint8Array; exclude: number[] } }).revoke;
  assert.deepEqual(op.exclude, []);
  assert.deepEqual(op.order.subarray(24, 32), fromHex("aabbccddeeff0011"));
  assert.deepEqual(r.revoked, ["aabbccddeeff0011"]);

  // A nearly full list starts fresh (D-443): live revoked delegates go along again.
  const full = { ...rec, revoked: Array.from({ length: 6 }, (_, i) => `0${i}`.padEnd(16, "0")) };
  const keep = ["1111111111111111", "2222222222222222"];
  const gw2 = new Gateway(rec.adminPublic);
  const r2 = await revokeMembers(gw2, await owner.signer(MESH), full, [{ node: 0x7c02, keyHash: "0011223344556677" }], gw2.state, keep);
  assert.equal(r2.replaced, true);
  assert.deepEqual(r2.revoked, ["0011223344556677", ...keep]);
  await assert.rejects(
    revokeMembers(gw2, await owner.signer(MESH), full, [{ node: 1, keyHash: "0011223344556677" }], gw2.state, Array.from({ length: ORDER_REVOKED }, (_, i) => `${i}`.repeat(16))),
    /at most/,
  );
});

test("only revoked people who could still sign are kept", () => {
  const now = Date.parse("2026-11-24T00:00:00Z");
  const keep = keepRevoked(
    {
      delegates: [
        { keyHash: "a", label: "A", issuedAt: "", revoked: true },
        { keyHash: "b", label: "B", issuedAt: "", revoked: true, expiresAt: "2026-11-23T00:00:00Z" },
        { keyHash: "c", label: "C", issuedAt: "", revoked: true, expiresAt: "2026-12-01T00:00:00Z" },
        { keyHash: "d", label: "D", issuedAt: "" },
      ],
    },
    now,
  );
  assert.deepEqual(keep, ["a", "c"]);
});
