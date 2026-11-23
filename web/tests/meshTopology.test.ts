/**
 * The mesh map (#/mesh/topology): the firmware's hand-encoded topology through the real
 * proto boundary (mesh_gw.rs golden), the paged get_mesh{topology} read, the map model
 * (links, hops, health, older firmware) and the force-directed layout for unplaced fixtures.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { decodeServer, encodeClient } from "../src/net/proto";
import {
  mergeTopologyPages,
  meshPoseState,
  meshTopologyRequest,
  readMeshTopology,
  type MeshInfoMessage,
  type MeshMemberInfo,
  type MeshStateInfo,
} from "../src/net/mesh";
import { layoutTopology, meshTopoModel, nodeDetails, restLength, signalBand, type TopoNode } from "../src/ui/screens/meshTopoModel";

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (h: string): Uint8Array => new Uint8Array(h.match(/../g)!.map((x) => parseInt(x, 16)));

/** mesh_gw.rs MEMBER_TOPO_GOLDEN: MeshMember{node 0x1234, hops 2, pose{"Hall", [1.5, 0, -2],
 * 90° about y}, neighbours [{0x2001, -41, 97 %}, {0x2002, -70}], topology_ms_ago 1500,
 * pose_state SET}. */
const MEMBER_TOPO_GOLDEN =
  "08b42470029001027a260a0448616c6c120c0000c03f00000000000000c01a10000000006a05353f000000007c04353f82010708814010511861820106088240108b018801dc0b";

function varint(n: number): string {
  const out: number[] = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out.map((x) => x.toString(16).padStart(2, "0")).join("");
}

test("the firmware's member topology decodes (mesh_gw.rs golden)", () => {
  // ServerMessage{mesh(55){state(2){on, member, node 0x3a41, members(11)[golden]}}}.
  const member = MEMBER_TOPO_GOLDEN;
  const state = "0801" + "1001" + "18" + varint(0x3a41) + "5a" + varint(member.length / 2) + member;
  const info = "12" + varint(state.length / 2) + state;
  const frame = "ba03" + varint(info.length / 2) + info;
  const m = decodeServer(unhex(frame)) as unknown as MeshInfoMessage;
  assert.equal(m.type, "mesh");
  const s = m.state!;
  assert.equal(s.node, 0x3a41);
  const mm = s.members![0]!;
  assert.equal(mm.node, 0x1234);
  assert.equal(mm.hops, 2);
  assert.equal(meshPoseState(mm.poseState), "MESH_POSE_SET");
  assert.equal(mm.pose?.room, "Hall");
  assert.deepEqual(mm.pose?.translation, [1.5, 0, -2]);
  const q = mm.pose!.rotation!;
  assert.ok(Math.abs(q[1]! - Math.SQRT1_2) < 1e-3 && Math.abs(q[3]! - Math.SQRT1_2) < 1e-3, `${q}`);
  assert.deepEqual(
    mm.neighbours?.map((n) => [n.node, n.rssi, n.txOkPct]),
    [
      [0x2001, -41, 97],
      [0x2002, -70, undefined],
    ],
  );
  assert.equal(mm.topologyMsAgo, 1500);
  // Older firmware's member (no topology): the fields are simply absent.
  // ServerMessage{mesh{state{on, members [{node 2, rssi -44}]}}}.
  const old = decodeServer(unhex("ba030a1208" + "0801" + "5a0408021057")) as unknown as MeshInfoMessage;
  const om = old.state!.members![0]!;
  assert.deepEqual([om.node, om.rssi, om.hops ?? 0, om.pose, om.topologyMsAgo], [2, -44, 0, undefined, undefined]);
  assert.ok(!om.neighbours?.length);
  assert.equal(meshPoseState(om.poseState), "MESH_POSE_UNKNOWN");
});

test("get_mesh{topology} is what the firmware parses (mesh_gw.rs get_mesh_topology_flag)", () => {
  assert.equal(hex(encodeClient(meshTopologyRequest(0))), "a206020801");
  assert.equal(hex(encodeClient(meshTopologyRequest(5))), "a20604080110" + "05");
});

test("topology pages merge into one state", async () => {
  const base = { on: true, member: true, node: 1, sync: 2 };
  const row = (node: number, topo: boolean): MeshMemberInfo =>
    topo ? { node, fps: 80, hops: 1, poseState: "MESH_POSE_NONE", neighbours: [{ node: 1, rssi: -50 }], topologyMsAgo: 10 } : { node, fps: 80 };
  const pages: MeshStateInfo[] = [
    { ...base, members: [row(2, true), row(3, true), row(4, false)], topologyNext: 2, neighbours: [{ node: 2, rssi: -40 }] },
    { ...base, members: [row(2, false), row(3, false), row(4, true)], topologyNext: 0, neighbours: [{ node: 2, rssi: -41 }] },
  ];
  const asked: number[] = [];
  const s = await readMeshTopology(async (from) => {
    asked.push(from);
    return pages[asked.length - 1]!;
  });
  assert.deepEqual(asked, [0, 2]);
  assert.equal(s.topologyNext, undefined);
  assert.deepEqual(
    s.members!.map((m) => [m.node, m.hops, m.neighbours?.length]),
    [
      [2, 1, 1],
      [3, 1, 1],
      [4, 1, 1],
    ],
  );
  assert.equal(s.neighbours![0]!.rssi, -41, "the last page's own state");
  // A firmware that ignores the flag (older): one page, nothing to merge.
  let calls = 0;
  const old = await readMeshTopology(async () => {
    calls++;
    return { ...base, members: [{ node: 2, rssi: -44 }] };
  });
  assert.equal(calls, 1);
  assert.equal(old.members![0]!.rssi, -44);
  // A page that never moves on stops (no loop).
  calls = 0;
  await readMeshTopology(async () => {
    calls++;
    return { ...base, topologyNext: 0 };
  });
  assert.equal(calls, 1);
  assert.equal(mergeTopologyPages([]).on, undefined);
});

function state(): MeshStateInfo {
  const pose = (t: number[]) => ({ room: "Hall", translation: t });
  return {
    on: true,
    member: true,
    node: 0x10,
    sync: 2,
    poseState: "MESH_POSE_SET",
    pose: pose([0, 1, 0]),
    neighbours: [
      { node: 0x20, rssi: -45, txOkPct: 100 },
      { node: 0x30, rssi: -70 },
    ],
    members: [
      { node: 0x20, rssi: -45, seenMsAgo: 300, fps: 80, sync: 2, hops: 1, poseState: 2, pose: pose([3, 1, 0]), neighbours: [{ node: 0x10, rssi: -47, txOkPct: 96 }], topologyMsAgo: 1000 },
      { node: 0x30, rssi: -72, seenMsAgo: 300, fps: 80, sync: 1, hops: 1, poseState: "MESH_POSE_NONE", neighbours: [{ node: 0x10, rssi: -71 }, { node: 0x40, rssi: -80 }], topologyMsAgo: 2000 },
      // Two hops out, unplaced, reports nothing about hops (BFS fills it in).
      { node: 0x40, seenMsAgo: 20_000, fps: 0, firmware: 7, sync: 2, poseState: "MESH_POSE_NONE", neighbours: [{ node: 0x30, rssi: -82 }], topologyMsAgo: 3000, lastError: 27 },
      // Older firmware: no topology at all, but the gateway hears it.
      { node: 0x50, rssi: -66, seenMsAgo: 500, fps: 80, sync: 2 },
      // A neighbour that is not a member is ignored.
    ],
  };
}

test("the map model: links from both ends, hops, health, older firmware", () => {
  const names = new Map([[0x20, "Desk Lamp"]]);
  const m = meshTopoModel(state(), (n) => names.get(n), "Living Room");
  assert.deepEqual(
    m.nodes.map((n) => [n.name, n.self, n.placed, n.hops, n.health, n.noTopology]),
    [
      ["Living Room", true, "room", 0, "ok", false],
      ["Desk Lamp", false, "room", 1, "ok", false],
      ["Fixture 0030", false, "layout", 1, "warn", false],
      ["Fixture 0040", false, "layout", 2, "bad", false],
      ["Fixture 0050", false, "layout", 1, "ok", true],
    ],
  );
  assert.equal(m.noTopology, 1);
  assert.ok(m.anyPosed);
  const link = (a: number, b: number) => m.links.find((l) => l.a === a && l.b === b);
  assert.deepEqual([link(0x10, 0x20)!.rssiAB, link(0x10, 0x20)!.rssiBA, link(0x10, 0x20)!.rssi, link(0x10, 0x20)!.txOkPct], [-45, -47, -47, 96]);
  assert.equal(link(0x30, 0x40)!.rssi, -82);
  assert.equal(link(0x30, 0x40)!.hops, 2);
  // The old-firmware fixture's only link is the gateway's reading of it.
  assert.deepEqual([link(0x10, 0x50)!.rssiAB, link(0x10, 0x50)!.rssiBA], [-66, null]);
  assert.equal(m.links.length, 4);
  const n40 = m.nodes.find((n) => n.node === 0x40)!;
  assert.match(n40.healthText, /not rendering · not heard for 20 s · last change failed \(code 27\)/);
  const rows = new Map(nodeDetails(n40, m, (n) => m.nodes.find((x) => x.node === n)!.name));
  assert.equal(rows.get("Route"), "2 hops away");
  assert.match(rows.get("Room position")!, /localize the room/);
  assert.match(rows.get("Link to Fixture 0030")!, /^Weak · -82 dBm/);
  const n20 = m.nodes.find((n) => n.node === 0x20)!;
  assert.match(new Map(nodeDetails(n20, m, String)).get("Room position")!, /^Hall · x 3.00 m, y 1.00 m, z 0.00 m/);
  // Not in a mesh: nothing to draw.
  assert.equal(meshTopoModel({ on: true, member: false }, () => undefined, "x").nodes.length, 0);
});

test("signal bands and rest lengths", () => {
  assert.deepEqual([-40, -60, -61, -75, -76, 0].map((r) => signalBand(r)), ["strong", "strong", "fair", "fair", "weak", "unknown"]);
  assert.equal(signalBand(null), "unknown");
  assert.ok(restLength(-40) < restLength(-70) && restLength(-70) < restLength(-95));
  assert.equal(restLength(-200), 4);
});

test("the layout places unplaced fixtures from their links, posed ones stay put", () => {
  const m = meshTopoModel(state(), () => undefined, "Living Room");
  const at = (node: number): TopoNode => m.nodes.find((n) => n.node === node)!;
  assert.deepEqual(at(0x10).pos, [0, 1, 0]);
  assert.deepEqual(at(0x20).pos, [3, 1, 0]);
  for (const n of m.nodes) assert.ok(n.pos.every(Number.isFinite), `${n.node}: ${n.pos}`);
  // Unplaced fixtures sit on the posed fixtures' floor plane, near what they link to,
  // and apart from each other.
  for (const n of m.nodes.filter((x) => x.placed === "layout")) assert.equal(n.pos[1], 1);
  const d = (a: number, b: number) => Math.hypot(at(a).pos[0] - at(b).pos[0], at(a).pos[2] - at(b).pos[2]);
  assert.ok(d(0x30, 0x10) < 4, `0x30 near the gateway: ${d(0x30, 0x10)}`);
  assert.ok(d(0x40, 0x30) < d(0x40, 0x10), "0x40 hangs off 0x30");
  for (const a of m.nodes) for (const b of m.nodes) if (a !== b) assert.ok(d(a.node, b.node) > 0.4, `${a.node} vs ${b.node}`);
  // Deterministic.
  const again = meshTopoModel(state(), () => undefined, "Living Room");
  assert.deepEqual(again.nodes.map((n) => n.pos), m.nodes.map((n) => n.pos));
  // Nobody posed: the connected fixture is the origin and the rest spread around it.
  const s = state();
  delete s.pose;
  s.poseState = "MESH_POSE_NONE";
  for (const x of s.members!) {
    delete x.pose;
    x.poseState = "MESH_POSE_NONE";
  }
  const u = meshTopoModel(s, () => undefined, "Living Room");
  assert.equal(u.anyPosed, false);
  assert.deepEqual(u.nodes[0]!.pos, [0, 0, 0]);
  assert.ok(u.nodes.slice(1).every((n) => Math.hypot(n.pos[0], n.pos[2]) > 0.4));
  // Nothing to place: untouched.
  const posedOnly = m.nodes.filter((n) => n.placed === "room").map((n) => ({ ...n, pos: [...n.pos] as typeof n.pos }));
  layoutTopology(posedOnly, []);
  assert.deepEqual(posedOnly.map((n) => n.pos), [
    [0, 1, 0],
    [3, 1, 0],
  ]);
});
