/**
 * Share links (src/net/shareLink.ts, src/store/shareAccess.ts; docs/design/share-links.md):
 * the link round-trips with the key in it or behind a code, a wrong code or a damaged link
 * fails plainly, and opening a mesh or fixture link changes the receiving phone's stores as
 * the design says.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatCode,
  makeShareLink,
  needsCode,
  normalizeCode,
  openShare,
  parseShareLink,
  ShareLinkError,
  SHARE_ROUTE,
  type ShareEnvelope,
} from "../src/net/shareLink";
import { MemoryMeshBackend, MeshStore } from "../src/store/meshStore";
import { acceptShare, fixtureShareBody, meshShareBody, previewShare, type FixtureShareBody, type ShareDeps } from "../src/store/shareAccess";
import { CertPinStore } from "../src/net/deviceTrust";
import { toHex } from "../src/net/meshKeys";

const BASE = "https://splanc.io/app/";

function memStorage(): Pick<Storage, "getItem" | "setItem"> {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
}

function phone(): ShareDeps & { meshes: MeshStore; added: { url: string; label?: string }[] } {
  const meshes = new MeshStore();
  meshes.setBackend(new MemoryMeshBackend());
  const added: { url: string; label?: string }[] = [];
  const st = memStorage();
  return {
    meshes,
    added,
    devices: {
      upsert: (url, label) => {
        added.push(label === undefined ? { url } : { url, label });
        return { id: `dev-${added.length}` };
      },
    },
    pins: new CertPinStore(() => st),
  };
}

test("a link with its key opens by itself, and only the fragment holds anything", async () => {
  const m = await makeShareLink({ kind: "fixture", title: "Lamp", body: { hello: "world" } }, { base: BASE });
  assert.equal(m.code, null);
  const u = new URL(m.url);
  assert.equal(u.origin + u.pathname, BASE);
  assert.equal(u.search, "");
  assert.ok(u.hash.startsWith(`#${SHARE_ROUTE}?s=1.`));
  assert.ok(!m.url.includes("world"), "the body is sealed");
  const p = parseShareLink(m.url)!;
  assert.equal(needsCode(p), false);
  const env = await openShare(p);
  assert.equal(env.kind, "fixture");
  assert.equal(env.title, "Lamp");
  assert.deepEqual(env.body, { hello: "world" });
});

test("a link with a code needs that code, typed loosely, and refuses another", async () => {
  const m = await makeShareLink({ kind: "mesh", title: "Home", body: { n: 1 } }, { base: BASE, withCode: true });
  assert.ok(m.code && m.code.length === 10);
  assert.ok(!m.url.includes("k="));
  const p = parseShareLink(m.url)!;
  assert.equal(needsCode(p), true);
  await assert.rejects(openShare(p), (e: unknown) => e instanceof ShareLinkError && e.reason === "code");
  const wrong = m.code!.startsWith("0") ? `1${m.code!.slice(1)}` : `0${m.code!.slice(1)}`;
  await assert.rejects(openShare(p, wrong), (e: unknown) => e instanceof ShareLinkError && e.reason === "code");
  const typed = ` ${formatCode(m.code!).toLowerCase()} `;
  assert.deepEqual((await openShare(p, typed)).body, { n: 1 });
});

test("codes fold the look-alikes people mistype", () => {
  assert.equal(normalizeCode("abcde-fghij"), "ABCDEFGH1J");
  assert.equal(normalizeCode("o0 Il"), "0011");
});

test("a damaged or newer link says so; text that isn't a link is not one", async () => {
  const m = await makeShareLink({ kind: "fixture", body: {} }, { base: BASE });
  assert.equal(parseShareLink("https://splanc.io/app/#/effects"), null);
  const flipped = m.url.replace(/s=1\.(.)/, (_x, c: string) => `s=1.${c === "A" ? "B" : "A"}`);
  await assert.rejects(openShare(parseShareLink(flipped)!), (e: unknown) => e instanceof ShareLinkError && e.reason === "damaged");
  assert.throws(() => parseShareLink(m.url.replace("s=1.", "s=9.")), (e: unknown) => e instanceof ShareLinkError && e.reason === "version");
  assert.throws(() => parseShareLink(m.url.replace(/&k=.*/, "")), (e: unknown) => e instanceof ShareLinkError && e.reason === "damaged");
  // The router hands the screen the fragment's query alone.
  const q = new URLSearchParams(m.url.split("?")[1]);
  assert.ok(parseShareLink(q.toString()));
});

test("a mesh link gives the receiver the mesh, its tokens, and its signer", async () => {
  const a = phone();
  const rec = await a.meshes.create("Kitchen");
  const tok = new Uint8Array(16).fill(7);
  await a.meshes.putMember(rec.meshId, { deviceId: "d1", label: "Lamp", node: 0x5fc8, keyHash: "00".repeat(8) }, tok);
  const m = await makeShareLink({ kind: "mesh", title: rec.name, body: await meshShareBody(rec.meshId, a) }, { base: BASE });

  const b = phone();
  const env = await openShare(parseShareLink(m.url)!);
  const pv = await previewShare(env, b);
  assert.equal(pv.title, "Kitchen");
  assert.equal(pv.blocked, undefined);
  const r = await acceptShare(env, b);
  assert.deepEqual(r, { kind: "mesh", name: "Kitchen" });
  const got = await b.meshes.get(rec.meshId);
  assert.ok(got);
  assert.deepEqual(got.adminPublic, rec.adminPublic);
  assert.equal(toHex((await b.meshes.provisionerToken(rec.meshId, 0x5fc8))!), toHex(tok));
  assert.deepEqual((await b.meshes.signer(rec.meshId)).publicKey, (await a.meshes.signer(rec.meshId)).publicKey);
});

test("an old mesh link can't roll back a mesh whose keys changed since", async () => {
  const a = phone();
  const rec = await a.meshes.create("Kitchen");
  const env: ShareEnvelope = { v: 1, kind: "mesh", at: "", body: await meshShareBody(rec.meshId, a) };
  const b = phone();
  await acceptShare(env, b);
  await b.meshes.rotated(rec.meshId, { keyEpoch: 2, revVersion: 1, siteSecret: new Uint8Array(32), revoked: [], nodes: [] });
  const pv = await previewShare(env, b);
  assert.match(pv.blocked ?? "", /older/);
  await assert.rejects(acceptShare(env, b), /older/);
});

test("a fixture link adds the fixture, its pin where none is known, and its token", async () => {
  const a = phone();
  const rec = await a.meshes.create("Kitchen");
  const tok = new Uint8Array(16).fill(9);
  await a.meshes.putMember(rec.meshId, { deviceId: "d1", label: "Lamp", node: 0x9878, keyHash: "11".repeat(8) }, tok);
  a.pins.set("98:a3:16:81:98:7a", "ab".repeat(32));
  const body = await fixtureShareBody(
    { label: "PixieLamp2", wssUrl: "wss://192.168.1.209/ws", mac: "98:a3:16:81:98:7a", mesh: { meshId: rec.meshId, node: 0x9878, name: "Kitchen" } },
    a,
  );
  assert.equal(body.mac, "98:A3:16:81:98:7A");
  assert.equal(body.cert, "ab".repeat(32));
  assert.equal(body.mesh?.token, toHex(tok));

  const b = phone();
  const env: ShareEnvelope<FixtureShareBody> = { v: 1, kind: "fixture", at: "", body };
  const pv = await previewShare(env, b);
  assert.match(pv.lines.join(" "), /take it out of its mesh/);
  const r = await acceptShare(env, b);
  assert.equal(r.deviceId, "dev-1");
  assert.deepEqual(b.added, [{ url: "wss://192.168.1.209/ws", label: "PixieLamp2" }]);
  assert.equal(b.pins.get("98:A3:16:81:98:7A"), "ab".repeat(32));
  // The receiver doesn't hold the mesh: the token waits beside it ...
  assert.equal(await b.meshes.get(rec.meshId), undefined);
  assert.equal(toHex((await b.meshes.provisionerToken(rec.meshId, 0x9878))!), toHex(tok));
  // ... and moves into the mesh's record if the mesh is shared later.
  await acceptShare({ v: 1, kind: "mesh", at: "", body: { ...(await meshShareBody(rec.meshId, a)), tokens: {} } }, b);
  assert.equal(toHex((await b.meshes.provisionerToken(rec.meshId, 0x9878))!), toHex(tok));
});

test("a fixture link never replaces a certificate the receiver already pinned", async () => {
  const b = phone();
  b.pins.set("AA:BB:CC:DD:EE:FF", "cd".repeat(32));
  const env: ShareEnvelope<FixtureShareBody> = {
    v: 1,
    kind: "fixture",
    at: "",
    body: { label: "Lamp", wssUrl: "wss://10.0.0.2/ws", mac: "AA:BB:CC:DD:EE:FF", cert: "ab".repeat(32) },
  };
  assert.match((await previewShare(env, b)).note ?? "", /different security certificate/);
  await acceptShare(env, b);
  assert.equal(b.pins.get("AA:BB:CC:DD:EE:FF"), "cd".repeat(32));
});

test("the old backup text still imports, and carries the tokens now", async () => {
  const a = phone();
  const rec = await a.meshes.create("Den");
  await a.meshes.putMember(rec.meshId, { deviceId: "", label: "L", node: 3, keyHash: "22".repeat(8) }, new Uint8Array(16).fill(1));
  const b = phone();
  await b.meshes.importBackup(await a.meshes.exportBackup(rec.meshId));
  assert.ok(await b.meshes.provisionerToken(rec.meshId, 3));
});
