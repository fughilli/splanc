/**
 * The bridge in the mesh (src/bridge/mesh.ts, issue #697): pimesh's status as the agent
 * reads it, joining by approval and leaving with the provisioner token pimesh issued, the
 * delegate key and the app's certificate for it (refused for any other key), the control
 * socket's line protocol, and the live session's `mesh` query.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { BRIDGE_FIRMWARE, BridgeMesh, meshSummary, parseMemberStatus, PimeshClient, type MemberStatus } from "../src/bridge/mesh";
import { LiveMux, type LiveConn } from "../src/bridge/live";
import type { Hub } from "../src/hub";
import { BRIDGE_FIRMWARE as WEB_BRIDGE_FIRMWARE } from "../../web/src/net/mesh";
import { exportPublicKey, fromHex, signDelegation, toHex, webCryptoSigner } from "../../web/src/net/meshKeys";

const SCRATCH = mkdtempSync(join(tmpdir(), "splanc-bridgemesh-"));
after(() => rmSync(SCRATCH, { recursive: true, force: true }));

const MESH = 0x5350_4c42;

function status(over: Partial<MemberStatus> = {}): Record<string, unknown> {
  return {
    v: 1,
    node: 0x2002,
    phase: "member",
    member: true,
    mesh_id: MESH,
    admin_key: true,
    key_hash: "0011223344556677",
    device_key: "04" + "ab".repeat(64),
    firmware: BRIDGE_FIRMWARE,
    channel: 6,
    heard_channel: 6,
    channel_ok: true,
    sync: 2,
    neighbours: [
      { node: 0x1001, rssi: -48, tx_ok_pct: 100 },
      { node: 0x1002, rssi: -63 },
    ],
    members_heard: 2,
    via: "nl80211",
    uptime_s: 12,
    stats: { controls: 0 },
    log: ["member id=2002"],
    ...over,
  };
}

/** pimesh, faked: records the lines, answers like pi/mesh_radio/src/bridge.rs. */
class FakePimesh {
  lines: string[] = [];
  st: Record<string, unknown> = status({ phase: "off", member: false, mesh_id: 0, admin_key: false });
  token = "a1".repeat(16);
  async call(line: string): Promise<Record<string, unknown>> {
    this.lines.push(line);
    const w = line.split(" ");
    if (w[0] === "provision") {
      if (this.st["admin_key"] === true && w[4] !== this.token) return { ok: false, error: "locked: give its provisioner token" };
      this.st = status({ phase: "joining", member: false, mesh_id: parseInt(w[1]!, 16), admin_key: w[2] !== "-" });
      return { ok: true, token: this.token, node: 0x2002 };
    }
    if (w[0] === "leave") {
      if (this.st["admin_key"] === true && w[1] !== this.token) return { ok: false, error: "locked" };
      this.st = status({ phase: "off", member: false, mesh_id: 0, admin_key: false });
      return { ok: true };
    }
    return this.st;
  }
  async status(): Promise<MemberStatus> {
    return parseMemberStatus(await this.call("status"))!;
  }
}

async function adminSigner() {
  const kp = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"])) as CryptoKeyPair;
  return webCryptoSigner(kp.privateKey, await exportPublicKey(kp.publicKey));
}

describe("member status", () => {
  test("the marker agrees with the app's and pimesh's", () => {
    // pi/mesh_radio/src/bridge.rs marker_is_the_fnv1a_of_splanc_bridge pins the same value.
    assert.equal(BRIDGE_FIRMWARE, WEB_BRIDGE_FIRMWARE);
    let h = 2166136261;
    for (const c of new TextEncoder().encode("splanc-bridge")) h = Math.imul(h ^ c, 16777619) >>> 0;
    assert.equal(h, BRIDGE_FIRMWARE);
  });

  test("parses pimesh's status and refuses anything else", () => {
    const s = parseMemberStatus(status())!;
    assert.equal(s.node, 0x2002);
    assert.equal(s.phase, "member");
    assert.deepEqual(s.neighbours, [
      { node: 0x1001, rssi: -48, tx_ok_pct: 100 },
      { node: 0x1002, rssi: -63 },
    ]);
    assert.equal(parseMemberStatus({ v: 2 }), null);
    assert.equal(parseMemberStatus({ v: 1, node: 1, phase: "dancing" }), null);
    assert.equal(parseMemberStatus(null), null);
  });

  test("the summary says what to do next, and never carries keys", () => {
    assert.equal(meshSummary(null, false).available, false);
    const off = meshSummary(parseMemberStatus(status({ phase: "off" })), false);
    assert.match(off.text, /add the bridge from the app/);
    assert.match(meshSummary(parseMemberStatus(status({ phase: "joining" })), false).text, /waiting for approval/);
    const m = meshSummary(parseMemberStatus(status()), true);
    assert.equal(m.text, "Mesh: member, 2 radio neighbours");
    assert.equal(m.delegated, true);
    assert.ok(!JSON.stringify(m).includes("abab"), "no device key in the summary");
    const wrong = meshSummary(parseMemberStatus(status({ channel: 36, heard_channel: 6, channel_ok: false })), false);
    assert.match(wrong.text, /channel 36, the lamps are on 6: put the bridge on their 2.4 GHz Wi-Fi/);
  });
});

describe("BridgeMesh", () => {
  test("joins by approval, keeps the token (0600) and leaves with it", async () => {
    const dir = join(SCRATCH, "join");
    const fake = new FakePimesh();
    const m = new BridgeMesh({ stateDir: dir, client: fake });
    const admin = await adminSigner();
    const s = await m.join(MESH, admin.publicKey);
    assert.equal(s?.phase, "joining");
    assert.equal(fake.lines[0], `provision ${MESH.toString(16)} ${toHex(admin.publicKey)} 0`, "no site secret, ever");
    assert.equal(statSync(join(dir, "mesh.json")).mode & 0o777, 0o600);
    // A restart: the token is still there, so a re-join and a leave pass it.
    const m2 = new BridgeMesh({ stateDir: dir, client: fake });
    await m2.join(MESH, admin.publicKey, 6);
    assert.equal(fake.lines.at(-2), `provision ${MESH.toString(16)} ${toHex(admin.publicKey)} 6 ${fake.token}`);
    await m2.leave();
    assert.equal(fake.lines.at(-2), `leave ${fake.token}`);
    assert.equal(m2.member?.phase, "off");
    await assert.rejects(m2.join(0, null), /bad mesh id/);
    await assert.rejects(m2.join(MESH, new Uint8Array(33)), /65 bytes/);
  });

  test("a refusal from pimesh is the tool's error", async () => {
    const fake = new FakePimesh();
    fake.st = status();
    fake.token = "ff".repeat(16);
    const m = new BridgeMesh({ stateDir: join(SCRATCH, "refuse"), client: fake });
    await assert.rejects(m.leave(), /refused: locked/);
  });

  test("takes the app's certificate for its own delegate key only", async () => {
    const fake = new FakePimesh();
    fake.st = status();
    const dir = join(SCRATCH, "deleg");
    const m = new BridgeMesh({ stateDir: dir, client: fake });
    await m.poll();
    const admin = await adminSigner();
    const mine = await m.delegateKey();
    assert.equal(mine.length, 65);
    assert.deepEqual(await new BridgeMesh({ stateDir: dir, client: fake }).delegateKey(), mine, "the same key after a restart");
    assert.equal(m.delegated, false);
    const other = await adminSigner();
    const wrong = await signDelegation(admin, { meshId: MESH, key: other.publicKey, notAfter: 0 });
    await assert.rejects(m.setDelegation(wrong), /another key/);
    await assert.rejects(m.setDelegation(new Uint8Array(10)), /not a delegation/);
    const cert = await signDelegation(admin, { meshId: MESH, key: mine, notAfter: 0 });
    await m.setDelegation(cert);
    assert.equal(m.delegated, true);
    const d = await m.delegateFor(MESH);
    assert.deepEqual(d?.delegation, cert);
    assert.equal(await m.delegateFor(MESH + 1), null, "only for its mesh");
    // The delegate signs: the signature verifies against its key.
    const sig = await d!.signer.sign(new Uint8Array([1, 2, 3]));
    const pub = await crypto.subtle.importKey("raw", mine as BufferSource, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    assert.ok(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, sig as BufferSource, new Uint8Array([1, 2, 3])));
    // Holding an admin key and no token (another app provisioned it): it stays put.
    await assert.rejects(m.join(MESH + 1, admin.publicKey), /locked/);
    // Joining another mesh drops the certificate.
    fake.st = status({ admin_key: false });
    await m.join(MESH + 1, admin.publicKey);
    assert.equal(await m.delegateFor(MESH), null);
  });
});

test("PimeshClient: one line out, one JSON line back", async () => {
  const path = join(SCRATCH, "pm.sock");
  const got: string[] = [];
  const srv = net.createServer((c) => {
    c.setEncoding("utf8");
    c.on("data", (d: string) => {
      got.push(d);
      // In two writes, as a slow reader might see it.
      const r = JSON.stringify(status());
      c.write(r.slice(0, 20));
      setTimeout(() => c.write(`${r.slice(20)}\n`), 5);
    });
  });
  await new Promise<void>((r) => srv.listen(path, r));
  try {
    const s = await new PimeshClient(path).status();
    assert.equal(s.node, 0x2002);
    assert.deepEqual(got, ["status\n"]);
    await assert.rejects(new PimeshClient(join(SCRATCH, "nope.sock")).status());
  } finally {
    srv.close();
  }
});

test("live: the app joins the bridge to its mesh and certifies it", async () => {
  const fake = new FakePimesh();
  const mesh = new BridgeMesh({ stateDir: join(SCRATCH, "live"), client: fake });
  const hub = { registry: { list: () => [] }, config: { groups: {} }, ready: async () => undefined, openSession: () => undefined } as unknown as Hub;
  const mux = new LiveMux({ hub, bridgeId: () => "b1", mesh, pollMs: 60_000 });
  const sent: Record<string, unknown>[] = [];
  const conn: LiveConn = { id: "c1", via: "lan", label: "phone", grant: "g1", send: (t) => sent.push(JSON.parse(t) as Record<string, unknown>), close: () => undefined };
  mux.attach(conn);
  try {
    await mux.message("c1", JSON.stringify({ t: "hello", v: 1, client_id: "abcdefgh12345678", name: "Phone" }));
    const welcome = sent.find((m) => m["t"] === "welcome")!;
    assert.equal((welcome["mesh"] as { available: boolean }).available, false, "not polled yet");
    const admin = await adminSigner();
    await mux.message("c1", JSON.stringify({ t: "q", id: 1, op: "mesh", action: "join", mesh_id: MESH, admin_key: toHex(admin.publicKey) }));
    const r1 = sent.find((m) => m["t"] === "r" && m["id"] === 1)!;
    assert.equal(r1["ok"], true, JSON.stringify(r1));
    const d1 = r1["data"] as Record<string, unknown>;
    assert.equal(d1["phase"], "joining");
    const dk = fromHex(d1["delegate_key"] as string);
    const cert = await signDelegation(admin, { meshId: MESH, key: dk, notAfter: 0 });
    await mux.message("c1", JSON.stringify({ t: "q", id: 2, op: "mesh", action: "delegate", cert: toHex(cert) }));
    const r2 = sent.find((m) => m["t"] === "r" && m["id"] === 2)!;
    assert.equal(r2["ok"], true, JSON.stringify(r2));
    assert.equal((r2["data"] as Record<string, unknown>)["delegated"], true);
    await mux.message("c1", JSON.stringify({ t: "q", id: 3, op: "mesh", action: "dance" }));
    assert.equal(sent.find((m) => m["t"] === "r" && m["id"] === 3)!["ok"], false);
  } finally {
    mux.close();
  }
});
