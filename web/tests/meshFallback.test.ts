/**
 * "Control the whole mesh" on a fixture whose gateway refuses the mesh send (the shared-mesh
 * report: power worked, effects did nothing). A lone gateway (every other member off) on
 * firmware 1.17.0 answers a wrapped set_effect / set_uniforms / submit_effect with
 * MESH_SEND_NO_MESH and applies nothing, not even on itself; later firmware says
 * MESH_SEND_NO_MEMBERS, and a connection whose session is gone gets MESH_SEND_LOCKED. The
 * app then sends the change to the connected fixture alone and says so; other refusals
 * still fail visibly.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ServerMessage } from "@ledmapper/protocol";
import { LedMapperClient, MESH_DIRECT_BACKOFF_MS, MeshSendRefused, type SocketLike } from "../src/net/client";
import { decodeClient, encodeServer } from "../src/net/proto";
import { MESH_DIRECT_FALLBACK, meshFallbackNotice } from "../src/net/mesh";

type Sent = { type: string } & Record<string, unknown>;

class FakeSocket implements SocketLike {
  readyState = 0;
  binaryType?: string;
  sent: Uint8Array[] = [];
  onopen: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(msg: unknown): void {
    this.onmessage?.({ data: encodeServer(msg as ServerMessage) });
  }
  send(data: string | Uint8Array): void {
    if (!(data instanceof Uint8Array)) throw new Error("expected binary frame");
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  all(): Sent[] {
    return this.sent.map((s) => decodeClient(s) as unknown as Sent);
  }
  last(): Sent {
    return this.all()[this.sent.length - 1]!;
  }
}

const CODE_PARAMS = { ledCount: 64, bits: 6, encoding: "hue", symbols: 2, bitPeriodMs: 100, syncPattern: "on_off", cycleFrames: 8 };

async function meshClient(): Promise<{ client: LedMapperClient; s: FakeSocket; fellBack: string[]; setNow: (t: number) => void }> {
  const sockets: FakeSocket[] = [];
  let now = 1000;
  const client = new LedMapperClient("wss://lamp.test/ws", {
    socketFactory: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    now: () => now,
    schedule: () => {},
  });
  const p = client.connect();
  const s = sockets[0]!;
  s.open();
  s.receive({ type: "welcome", sessionId: "s-1", codeParams: CODE_PARAMS, solverBenchMs: null });
  await p;
  // The connection unlocked as this mesh's gateway (meshSession.unlockMeshOnConnect).
  client.setMeshAll(true);
  const fellBack: string[] = [];
  client.onMeshFallback((c) => fellBack.push(c));
  return { client, s, fellBack, setNow: (t) => void (now = t) };
}

/** The gateway's synchronous refusal of the last mesh_send. */
function refuse(s: FakeSocket, error: string): void {
  const m = s.last();
  assert.equal(m.type, "mesh_send");
  assert.ok((m["opId"] as number) > 0, "the app gives each whole-mesh send its own op id");
  s.receive({ type: "mesh", result: { opId: m["opId"], error } });
}

for (const error of ["MESH_SEND_NO_MESH", "MESH_SEND_NO_MEMBERS", "MESH_SEND_LOCKED"]) {
  test(`a lone or locked gateway (${error}): the effect still switches on the connected fixture`, async () => {
    const { client, s, fellBack, setNow } = await meshClient();
    const p = client.setEffect("rain");
    refuse(s, error);
    // Sent again, to this fixture alone; its own reply answers the request.
    const direct = s.last();
    assert.equal(direct.type, "set_effect");
    assert.equal(direct["effectId"], "rain");
    s.receive({ type: "playback_state", active: true, effect: "rain" });
    assert.equal((await p).type, "playback_state");
    assert.deepEqual(fellBack, [error], "the user is told the change reached this fixture only");

    // A slider move while backing off goes straight to the fixture (no refused round trip)…
    const before = s.sent.length;
    client.setUniforms([{ slot: 1, value: [0.5] }]);
    assert.equal(s.sent.length, before + 1);
    assert.equal(s.last().type, "set_uniforms");
    // …and the mesh is tried again later (a member may be back).
    setNow(1000 + MESH_DIRECT_BACKOFF_MS + 1);
    client.setUniforms([{ slot: 1, value: [0.6] }]);
    assert.equal(s.last().type, "mesh_send");
    // A fire-and-forget refused the same way is re-sent too.
    refuse(s, error);
    assert.equal(s.last().type, "set_uniforms");
    assert.equal(fellBack.length, 2);
  });
}

test("a refused whole-mesh effect program loads on the connected fixture", async () => {
  const { client, s, fellBack } = await meshClient();
  const fxb = new Uint8Array(64);
  const p = client.submitEffect("rain", fxb, true);
  await new Promise((r) => setImmediate(r));
  const share = s.last();
  assert.equal(share.type, "mesh_send");
  // A share's op id is the gateway's: the refusal answers it in order.
  s.receive({ type: "mesh", result: { opId: 0x4000_0001, error: "MESH_SEND_NO_MESH" } });
  await new Promise((r) => setImmediate(r));
  const direct = s.last();
  assert.equal(direct.type, "submit_effect");
  assert.equal(direct["effectId"], "rain");
  s.receive({ type: "result_ready", mapId: "rain" });
  assert.equal((await p).mapId, "rain");
  assert.deepEqual(fellBack, ["MESH_SEND_NO_MESH"]);
});

test("other refusals stay errors: the mesh is there, a local-only change would split it", async () => {
  const { client, s, fellBack } = await meshClient();
  const p = client.setEffect("rain");
  refuse(s, "MESH_SEND_BUSY");
  await assert.rejects(p, (e: unknown) => e instanceof MeshSendRefused && e.reason === "MESH_SEND_BUSY" && /busy/.test(e.message));
  assert.equal(s.last().type, "mesh_send", "not re-sent");
  assert.deepEqual(fellBack, []);
  // A refused fire-and-forget reaches the app's error hook (a toast in the app).
  const errors: string[] = [];
  client.events = { onServerError: (code, m) => errors.push(`${code}: ${m}`) };
  client.setUniforms([{ slot: 1, value: [0.5] }]);
  refuse(s, "MESH_SEND_TOO_BIG");
  assert.deepEqual(errors, ["mesh: too big to send over the mesh"]);
});

test("the notices say what happened, plainly", () => {
  assert.ok(MESH_DIRECT_FALLBACK.has("MESH_SEND_NO_MEMBERS"));
  assert.match(meshFallbackNotice("MESH_SEND_NO_MEMBERS"), /No other fixture in this mesh is online/);
  assert.match(meshFallbackNotice("MESH_SEND_NO_MESH"), /this fixture only/);
  assert.match(meshFallbackNotice("MESH_SEND_LOCKED"), /can't control the whole mesh/);
});
