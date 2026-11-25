/**
 * A few simulated mesh fixtures for the `?demo=meshsim` / `meshadmin` / `meshall` scenarios
 * (release clips and screenshots of the mesh UI without hardware). Each one answers
 * `get_mesh` and `mesh_admin` the way the M7 firmware does, closely enough for the app's
 * real flows (create a mesh, admit a joiner, remove or block a member, share an effect):
 *
 *   provision (with the site secret) → in the mesh, time synced a moment later
 *   provision (no site secret)       → waiting to be admitted (the gateway lists it)
 *   unlock / admit / eject / leave / revoke → what the gateway's admin session does
 *
 * Nothing is verified (grants and rotation orders are accepted as signed); the app's own
 * crypto still runs. Demo mode only: lazy-imported from demo/init.ts.
 */

import { appState } from "../ui/app/state";
import { deviceStore, type KnownDevice } from "../store/deviceStore";
import { meshStore } from "../store/meshStore";
import { unlockMeshOnConnect } from "../store/meshSession";
import { keyHash } from "../net/meshKeys";
import { provisionFixture } from "../net/meshAdmin";
import type { MeshAdminOp, MeshAdminResultInfo, MeshResultInfo, MeshStateInfo } from "../net/mesh";
import { setMeshFixtureOpener, type MeshFlowClient } from "../ui/screens/meshFlow";

interface SimFixture {
  name: string;
  at: [number, number, number];
  node: number;
  rssi: number;
  deviceKey: Uint8Array;
  keyHash: Uint8Array;
  on: boolean;
  meshId: number;
  /** 2 waiting to be admitted, 3 member. */
  phase: number;
  memberSince: number;
  session: number;
  blocked: boolean;
}

const FIXTURES: [string, string, number, number, [number, number, number]][] = [
  // [name, wss url, mesh node, signal at the gateway, room position (m)]
  ["Living Room", "wss://living-room.local:8443/ws", 0x3a41, -38, [0, 0.9, 0]],
  ["Kitchen", "wss://kitchen.local:8443/ws", 0x7c02, -44, [2.4, 1.1, -0.6]],
  ["Porch Arch", "wss://porch-arch.local:8443/ws", 0x91e4, -57, [0.3, 2.2, -2.8]],
  ["Stair Rail", "wss://stair-rail.local:8443/ws", 0x52c7, -63, [-1.8, 1.4, -1.5]],
];

const sims: SimFixture[] = [];
let keyEpoch = 1;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function makeSim(name: string, node: number, rssi: number, at: [number, number, number]): Promise<SimFixture> {
  // A device key shaped like an uncompressed P-256 point (only its hash matters here).
  const deviceKey = new Uint8Array(65);
  deviceKey[0] = 4;
  for (let i = 1; i < 65; i++) deviceKey[i] = (node * 31 + i * 17) & 0xff;
  return { name, at, node, rssi, deviceKey, keyHash: await keyHash(deviceKey), on: false, meshId: 0, phase: 0, memberSince: 0, session: 0, blocked: false };
}

function syncOf(f: SimFixture): number {
  return Date.now() - f.memberSince < 900 ? 1 : 2;
}

function stateOf(f: SimFixture): MeshStateInfo {
  if (!f.on) return { on: false, phase: 0, deviceKey: f.deviceKey };
  const member = f.phase === 3;
  const peers = sims.filter((o) => o !== f && o.on && o.phase === 3 && o.meshId === f.meshId);
  return {
    on: true,
    member,
    node: f.node,
    meshId: f.meshId,
    channel: 6,
    gateway: member,
    phase: f.phase,
    adminKey: true,
    siteSecret: member,
    deviceKey: f.deviceKey,
    keyEpoch,
    session: f.session,
    meshS: Math.floor(Date.now() / 1000),
    sync: member ? syncOf(f) : 0,
    timeErrUs: 38,
    members: member ? peers.map((o) => ({ node: o.node, rssi: o.rssi, seenMsAgo: 400, fps: 80, sync: syncOf(o), timeErrUs: 41 })) : [],
    pending: member && f.session
      ? sims.filter((o) => o.on && o.phase === 2 && o.meshId === f.meshId).map((o) => ({ node: o.node, keyHash: o.keyHash, heardBy: f.node }))
      : [],
  };
}

/** `get_mesh{topology}`: every member placed in the room, with its radio neighbours (signal
 * falls off with distance). */
function topologyOf(f: SimFixture): MeshStateInfo {
  const s = stateOf(f);
  if (!s.member) return s;
  const inMesh = sims.filter((o) => o.on && o.phase === 3 && o.meshId === f.meshId);
  const pose = (o: SimFixture) => ({ room: "Living Room", translation: o.at, rotation: [0, 0, 0, 1] });
  const rssi = (a: SimFixture, b: SimFixture): number => Math.round(-34 - 7 * Math.hypot(a.at[0] - b.at[0], a.at[1] - b.at[1], a.at[2] - b.at[2]));
  const nbs = (o: SimFixture) => inMesh.filter((x) => x !== o).map((x) => ({ node: x.node, rssi: rssi(o, x), txOkPct: 97 + (x.node % 3) }));
  return {
    ...s,
    pose: pose(f),
    poseState: "MESH_POSE_SET",
    neighbours: nbs(f),
    members: (s.members ?? []).map((m) => {
      const o = inMesh.find((x) => x.node === m.node)!;
      return { ...m, hops: 1, pose: pose(o), poseState: "MESH_POSE_SET", neighbours: nbs(o), topologyMsAgo: 2100, firmware: 0x5e1f, uptimeS: 7260, heapFree: 61_000, heapMin: 38_000, brightness: 255 };
    }),
  };
}

async function admin(f: SimFixture, op: MeshAdminOp): Promise<MeshAdminResultInfo> {
  await sleep(250);
  if ("provision" in op) {
    if (f.blocked) return { error: "MESH_ADMIN_REVOKED" };
    f.on = true;
    f.meshId = op.provision.meshId >>> 0;
    f.phase = op.provision.siteSecret ? 3 : 2;
    f.memberSince = Date.now();
    const tok = new Uint8Array(16);
    crypto.getRandomValues(tok);
    return { provisionerToken: tok };
  }
  if ("unlock" in op) {
    f.session = (Math.random() * 0xffffffff) >>> 0 || 1;
    return { value: f.session };
  }
  const byNode = (n: number): SimFixture | undefined => sims.find((o) => o.node === n && o.on && o.meshId === f.meshId);
  if ("admit" in op) {
    const o = byNode(op.admit.node);
    if (!o || o.phase !== 2) return { error: "MESH_ADMIN_NOT_FOUND" };
    o.phase = 3;
    o.memberSince = Date.now();
    return {};
  }
  if ("eject" in op) {
    const o = byNode(op.eject.node);
    if (o) o.on = false;
    return {};
  }
  if ("leave" in op) {
    f.on = false;
    f.session = 0;
    return {};
  }
  if ("revoke" in op) {
    await sleep(500);
    for (const n of op.revoke.exclude ?? []) {
      const o = byNode(n);
      if (o) {
        o.on = false;
        o.blocked = true;
      }
    }
    keyEpoch = (keyEpoch + 1) & 0xff || 1;
    return {};
  }
  return {};
}

/** A stand-in connection to one simulated fixture (the flow's opener for the ones the app
 * isn't connected to). */
function simClient(f: SimFixture): MeshFlowClient {
  return {
    welcome: { features: ["mesh"] },
    getMesh: async () => {
      await sleep(60);
      return stateOf(f);
    },
    meshAdmin: (op) => admin(f, op),
  };
}

/** `meshsim`: Living Room (the demo's connected controller), Kitchen, Porch Arch and Stair Rail,
 * all on mesh firmware and in no mesh. `meshadmin`: Living Room, Kitchen and Porch Arch are
 * already in a mesh this app created ("Home mesh"), and Stair Rail is asking to join it.
 * `meshall`: those three only (no joiner), with "Control the whole mesh" on: effect changes
 * report every member's answer. Both answer the mesh map's topology read. */
export async function setupMeshSim(opts: { admin: boolean; all: boolean }): Promise<void> {
  const client = appState.client;
  if (!client) return;
  for (const [name, , node, rssi, at] of FIXTURES) sims.push(await makeSim(name, node, rssi, at));
  const devs: KnownDevice[] = FIXTURES.map(([name, url], i) => (i === 0 ? deviceStore.get(deviceStore.activeId() ?? "") : null) ?? deviceStore.upsert(url, name));
  // The others are on the network (mDNS), so the device list shows them as reachable.
  const { discovery } = await import("../net/discovery");
  devs.forEach((d, i) => {
    if (i === 0) return;
    const mac = `AA:BB:CC:5E:1F:${(0x10 + i).toString(16).toUpperCase()}`;
    const host = new URL(d.wssUrl).host;
    deviceStore.applyWelcome(d.id, { mac, deviceName: d.label });
    discovery.report({ source: "mdns", seenAt: Date.now(), fw: "1.21.0", key: mac, id: mac, name: d.label, host, url: d.wssUrl });
  });
  const simFor = (dev: KnownDevice): SimFixture | undefined => sims[devs.findIndex((d) => d.id === dev.id)];
  const gw = sims[0]!;

  // The connected controller is the first simulated fixture.
  const base = client.welcome;
  const welcome = { ...base, features: [...(base?.features ?? []), "mesh"] };
  Object.defineProperty(client, "welcome", { configurable: true, get: () => welcome });
  const c = client as unknown as Record<string, unknown>;
  c["getMesh"] = async () => {
    await sleep(60);
    const s = stateOf(gw);
    c["meshState_"] = s;
    return s;
  };
  c["getMeshTopology"] = async () => {
    await sleep(60);
    const s = topologyOf(gw);
    c["meshState_"] = s;
    return s;
  };
  c["meshAdmin"] = (op: MeshAdminOp) => admin(gw, op);
  setMeshFixtureOpener(async (dev) => {
    if (dev.id === deviceStore.activeId()) return { client: client as unknown as MeshFlowClient, release: () => undefined };
    const f = simFor(dev);
    if (!f) throw new Error("Couldn't reach it on Wi-Fi. Is it on?");
    return { client: simClient(f), release: () => undefined };
  });

  // Whole-mesh effect changes (mesh M6): every member answers after its fetch + switch.
  const submit = c["submitEffect"] as ((...a: unknown[]) => Promise<unknown>) | undefined;
  c["submitEffect"] = async (effectId: string, ...rest: unknown[]) => {
    if (!client.meshAll) return submit ? submit.call(client, effectId, ...rest) : { type: "result_ready", id: effectId };
    await sleep(250);
    const peers = sims.filter((o) => o !== gw && o.on && o.phase === 3 && o.meshId === gw.meshId);
    setTimeout(() => {
      const r: MeshResultInfo = { opId: 1, complete: true, gatewayStatus: 0, members: peers.map((o, i) => ({ node: o.node, status: "MESH_MEMBER_OK", latencyMs: 160 + 45 * i })) };
      for (const fn of c["meshSubs"] as Set<(r: MeshResultInfo) => void>) fn(r);
    }, 450);
    return { type: "result_ready", id: effectId };
  };
  unlockMeshOnConnect(client, () => appState.client === client);

  if (!opts.admin) return;
  const rec = await meshStore.create("Home mesh");
  // With whole-mesh control on (`meshall`), nobody is waiting to join.
  for (let i = 0; i < (opts.all ? 3 : 4); i++) {
    const f = sims[i]!;
    const conn = i === 0 ? (client as unknown as MeshFlowClient) : simClient(f);
    // Stair Rail gets only the admin key: it asks to join and the gateway lists it.
    const site = i < 3 ? await meshStore.siteSecret(rec.meshId) : null;
    try {
      const res = await provisionFixture(conn, rec, site);
      if (i < 3) await meshStore.putMember(rec.meshId, { deviceId: devs[i]!.id, label: f.name, ...res.member }, res.provisionerToken);
    } finally {
      site?.fill(0);
    }
    f.memberSince -= 5000;
  }
  if (opts.all) client.setMeshAll(true);
  // The app's view of the connection's mesh (the device card, the effect sheet's status).
  await client.getMesh();
}
