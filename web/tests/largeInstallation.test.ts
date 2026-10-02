/**
 * Larger installations end to end on the app side (PR-12): batching and
 * scale-aware transfer of a design-scale fixture (1024 LEDs across two
 * channels), plus the topology extraction that runs on every solved map.
 *
 * What a big fixture stresses, each pinned against a fake socket:
 *   - a whole map/topology is far bigger than one small TLS record / BLE frame,
 *     so sendChunked shards it into bounded UploadChunk windows (4 KB on wss,
 *     1 KB on BLE) that reassemble byte-for-byte into the one-shot frame;
 *   - the upload is size-aware: a frame that fits one window is sent whole,
 *     one byte more and it shards;
 *   - flow control: one window in flight, the next only after its chunk_ack,
 *     a mismatched ack aborts, and each upload carries its own upload id;
 *   - reading the stored bundle back is windowed too (get_stored_map), with
 *     progress;
 *   - extracting the topology of a big map yields to the event loop (the page
 *     does not freeze) and can be aborted mid-run when superseded.
 *
 * Every test carries exactly one requirement: PR-12.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { OutputMap, ServerMessage, Topology } from "@ledmapper/protocol";
import { type ClientOptions, LedMapperClient, type SocketLike } from "../src/net/client";
import { BLE_UPLOAD_CHUNK_BYTES } from "../src/net/bleTransport";
import { decodeClient, encodeClient, encodeMappingBundle, encodeServer } from "../src/net/proto";
import { extractTopology } from "../src/topology/extract";

/** The design-scale installation: two 512-LED channels. */
const INSTALL_LEDS = 1024;
const WSS_WINDOW = 4096; // client.ts CHUNK_BYTES

type Sent = { type: string } & Record<string, unknown>;

class WireSocket implements SocketLike {
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
  /** Deliver a server frame through the real binary protobuf boundary. */
  receive(msg: unknown): void {
    this.onmessage?.({ data: encodeServer(msg as ServerMessage) });
  }
  send(data: string | Uint8Array): void {
    if (this.readyState !== 1) throw new Error("not open");
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
  ofType(type: string): Sent[] {
    return this.all().filter((m) => m.type === type);
  }
}

const CODE_PARAMS = {
  ledCount: INSTALL_LEDS,
  bits: 13,
  encoding: "hue",
  symbols: 2,
  bitPeriodMs: 100,
  syncPattern: "on_off",
  cycleFrames: 15,
};

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

async function connected(opts: ClientOptions = {}): Promise<{ client: LedMapperClient; sock: WireSocket }> {
  const socks: WireSocket[] = [];
  const client = new LedMapperClient("wss://player.test/ws", {
    socketFactory: () => {
      const s = new WireSocket();
      socks.push(s);
      return s;
    },
    now: () => 1000,
    schedule: () => undefined,
    coldRetryLimit: 1_000_000,
    ...opts,
  });
  const p = client.connect();
  const sock = socks[0]!;
  sock.open();
  sock.receive({ type: "welcome", sessionId: "s-1", codeParams: CODE_PARAMS, solverBenchMs: null });
  await p;
  return { client, sock };
}

function installationMap(n = INSTALL_LEDS): OutputMap {
  return {
    mapId: `install-${n}`,
    createdAt: "2026-07-09T00:00:00Z",
    units: "meters",
    frame: "gravity_leveled",
    ledCount: n,
    leds: Array.from({ length: n }, (_, i) => ({
      id: i,
      xyz: [Math.cos(i * 0.05) * 0.6, i * 0.0016 - 0.8, Math.sin(i * 0.05) * 0.6] as [number, number, number],
      confidence: 0.9,
      nViews: 12,
      rmsReprojPx: 0.5,
      parallaxDeg: 21,
    })),
    unmapped: [],
    stats: { rmsReprojPxGlobal: 0.7, medianParallaxDeg: 19 },
  };
}

function installationTopology(n = INSTALL_LEDS, segments = 24, pts = 32): Topology {
  return {
    mapId: `install-${n}`,
    branchPoints: Array.from({ length: segments }, (_, i) => ({
      id: i,
      xyz: [i * 0.01, 0.1, -i * 0.01] as [number, number, number],
    })),
    segments: Array.from({ length: segments }, (_, s) => ({
      id: s,
      a: s,
      b: s + 1 < segments ? s + 1 : -1,
      polyline: Array.from({ length: pts }, (_, p) => [p / pts, 0.02 * s, -p / pts] as [number, number, number]),
      length: 1,
    })),
    associations: Array.from({ length: n }, (_, i) => ({
      ledId: i,
      segmentId: i % segments,
      footArclength: i * 0.001,
      dPerp: 0.003,
    })),
  };
}

const b64Bytes = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Play the device side of a sharded upload: ack every NEW non-final window as
 * it arrives, answer the final one with `final`. Returns the windows sent. */
async function serveUpload(sock: WireSocket, final: unknown): Promise<Sent[]> {
  let seen = 0;
  for (let guard = 0; guard < 400; guard++) {
    await tick();
    const windows = sock.ofType("upload_chunk");
    if (windows.length === seen) continue;
    seen = windows.length;
    const w = windows[windows.length - 1]!;
    if (w["last"] === true) {
      sock.receive(final);
      return windows;
    }
    sock.receive({ type: "chunk_ack", uploadId: w["uploadId"], seq: w["seq"] });
  }
  throw new Error("upload never sent its final window");
}

test("a design-scale map uploads as bounded MAP windows that reassemble to the exact submit_map frame [rr:PR-12]", async () => {
  const { client, sock } = await connected();
  const map = installationMap();
  const frame = encodeClient({ type: "submit_map", map });
  assert.ok(frame.length > 10 * WSS_WINDOW, `a 1024-LED map is many windows (${frame.length} B)`);

  const done = client.submitMap(map);
  const windows = await serveUpload(sock, { type: "result_ready", mapId: map.mapId });
  assert.equal((await done).mapId, map.mapId);

  assert.equal(sock.ofType("submit_map").length, 0, "never sent as one oversized frame");
  assert.equal(windows.length, Math.ceil(frame.length / WSS_WINDOW));
  const payloads = windows.map((w) => b64Bytes(w["payload"] as string));
  assert.ok(payloads.every((p) => p.length > 0 && p.length <= WSS_WINDOW), "every window fits one small record");
  windows.forEach((w, i) => {
    assert.equal(w["seq"], i);
    assert.equal(w["kind"], "MAP");
    assert.equal(w["last"], i === windows.length - 1);
    assert.equal(w["uploadId"], windows[0]!["uploadId"]);
  });
  assert.deepEqual(concat(payloads), frame);
});

test("over BLE every window of a design-scale map fits the 1 KB reassembly budget [rr:PR-12]", async () => {
  const { client, sock } = await connected({ uploadChunkBytes: BLE_UPLOAD_CHUNK_BYTES });
  const map = installationMap();
  const frame = encodeClient({ type: "submit_map", map });

  const done = client.submitMap(map);
  const windows = await serveUpload(sock, { type: "result_ready", mapId: map.mapId });
  await done;

  const payloads = windows.map((w) => b64Bytes(w["payload"] as string));
  assert.equal(windows.length, Math.ceil(frame.length / BLE_UPLOAD_CHUNK_BYTES));
  assert.ok(payloads.every((p) => p.length <= BLE_UPLOAD_CHUNK_BYTES));
  assert.deepEqual(concat(payloads), frame);
});

test("a design-scale topology uploads as TOPOLOGY windows that reassemble to the exact frame [rr:PR-12]", async () => {
  const { client, sock } = await connected();
  const topology = installationTopology();
  const frame = encodeClient({ type: "submit_topology", topology });
  assert.ok(frame.length > WSS_WINDOW);

  const done = client.submitTopology(topology);
  const windows = await serveUpload(sock, { type: "result_ready", mapId: topology.mapId });
  assert.equal((await done).mapId, topology.mapId);

  assert.equal(sock.ofType("submit_topology").length, 0);
  assert.ok(windows.every((w) => w["kind"] === "TOPOLOGY"));
  const payloads = windows.map((w) => b64Bytes(w["payload"] as string));
  assert.ok(payloads.every((p) => p.length <= WSS_WINDOW));
  assert.deepEqual(concat(payloads), frame);
});

test("upload is size-aware: a map that fits one window goes whole, one byte more shards [rr:PR-12]", async () => {
  const map = installationMap(64);
  const frameLen = encodeClient({ type: "submit_map", map }).length;

  const exact = await connected({ uploadChunkBytes: frameLen });
  const whole = exact.client.submitMap(map);
  assert.deepEqual(exact.sock.all().slice(1).map((m) => m.type), ["submit_map"]);
  exact.sock.receive({ type: "result_ready", mapId: map.mapId });
  assert.equal((await whole).mapId, map.mapId);

  const under = await connected({ uploadChunkBytes: frameLen - 1 });
  const sharded = under.client.submitMap(map);
  const windows = await serveUpload(under.sock, { type: "result_ready", mapId: map.mapId });
  await sharded;
  assert.deepEqual(
    windows.map((w) => b64Bytes(w["payload"] as string).length),
    [frameLen - 1, 1],
  );
  assert.equal(under.sock.ofType("submit_map").length, 0);
});

test("only one upload window is in flight: the next goes out only after its chunk_ack [rr:PR-12]", async () => {
  const { client, sock } = await connected();
  const map = installationMap();
  const done = client.submitMap(map);

  for (let i = 0; i < 5; i++) await tick();
  assert.equal(sock.ofType("upload_chunk").length, 1, "window 1 waits for window 0's ack");

  const first = sock.ofType("upload_chunk")[0]!;
  sock.receive({ type: "chunk_ack", uploadId: first["uploadId"], seq: 0 });
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(sock.ofType("upload_chunk").length, 2, "the ack releases exactly one more window");

  // Finish the upload so nothing is left pending.
  const second = sock.ofType("upload_chunk")[1]!;
  sock.receive({ type: "chunk_ack", uploadId: second["uploadId"], seq: 1 });
  await serveUpload(sock, { type: "result_ready", mapId: map.mapId });
  await done;
});

test("a chunk_ack for the wrong window aborts the upload instead of streaming on [rr:PR-12]", async () => {
  const { client, sock } = await connected();
  const done = client.submitMap(installationMap());
  await tick();
  const first = sock.ofType("upload_chunk")[0]!;

  sock.receive({ type: "chunk_ack", uploadId: first["uploadId"], seq: 7 });
  await assert.rejects(done, /chunk_ack mismatch/);
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(sock.ofType("upload_chunk").length, 1, "no further windows after a mismatched ack");
});

test("back-to-back large uploads (map, then topology) each use their own upload id [rr:PR-12]", async () => {
  const { client, sock } = await connected();
  const mapDone = client.submitMap(installationMap());
  const mapWindows = await serveUpload(sock, { type: "result_ready", mapId: "install-1024" });
  await mapDone;
  const topoDone = client.submitTopology(installationTopology());
  const all = await serveUpload(sock, { type: "result_ready", mapId: "install-1024" });
  await topoDone;
  const topoWindows = all.slice(mapWindows.length);

  const mapIds = new Set(mapWindows.map((w) => w["uploadId"]));
  const topoIds = new Set(topoWindows.map((w) => w["uploadId"]));
  assert.equal(mapIds.size, 1);
  assert.equal(topoIds.size, 1);
  assert.notEqual([...mapIds][0], [...topoIds][0], "a new id resets the device's accumulator");
  assert.deepEqual(
    topoWindows.map((w) => w["seq"]),
    topoWindows.map((_, i) => i),
    "the second upload restarts at seq 0",
  );
});

test("pullStoredMap reassembles a design-scale stored bundle from bounded windows with progress [rr:PR-12]", async () => {
  const { client, sock } = await connected();
  const bundle = encodeMappingBundle({ map: installationMap(), topology: installationTopology() });
  const chunkLen = 1024;
  const progress: Array<[number, number]> = [];

  let settled = false;
  const pulled = client
    .pullStoredMap((done, total) => progress.push([done, total]), chunkLen)
    .finally(() => {
      settled = true;
    });
  // Play the device: answer each NEW get_stored_map with its byte window.
  let served = 0;
  for (let guard = 0; !settled && guard < 400; guard++) {
    await tick();
    const reqs = sock.ofType("get_stored_map");
    if (reqs.length === served) continue;
    served = reqs.length;
    const req = reqs[reqs.length - 1]!;
    const off = req["offset"] as number;
    const slice = bundle.subarray(off, Math.min(off + (req["maxLen"] as number), bundle.length));
    sock.receive({
      type: "stored_map_chunk",
      totalLen: bundle.length,
      offset: off,
      data: btoa(String.fromCharCode(...slice)),
      hasTopology: true,
    });
  }
  const got = await pulled;

  const reqs = sock.ofType("get_stored_map");
  assert.equal(reqs.length, Math.ceil(bundle.length / chunkLen));
  assert.deepEqual(
    reqs.map((r) => [r["offset"], r["maxLen"]]),
    reqs.map((_, i) => [i * chunkLen, chunkLen]),
  );
  assert.deepEqual(progress[progress.length - 1], [bundle.length, bundle.length]);
  assert.ok(progress.every(([done], i) => i === 0 || done > progress[i - 1]![0]), "progress only grows");
  assert.equal(got.map.leds.length, INSTALL_LEDS);
  assert.equal(got.map.leds[INSTALL_LEDS - 1]!.id, INSTALL_LEDS - 1);
  assert.equal(got.topology.associations.length, INSTALL_LEDS);
});

test("extracting a large map's topology yields to the event loop instead of freezing the page [rr:PR-12]", async () => {
  const map = installationMap(600);
  let timerFired = false;
  let finishedBeforeTimer: boolean | null = null;
  const extraction = extractTopology(map).then((t) => {
    finishedBeforeTimer = !timerFired;
    return t;
  });
  // Queued behind the extraction's first slice: it runs while the extraction is
  // still in progress only if the extraction gives the event loop a turn.
  setTimeout(() => {
    timerFired = true;
  }, 0);
  const topo = await extraction;

  assert.equal(finishedBeforeTimer, false, "a UI timer ran mid-extraction");
  assert.equal(topo.associations.length, map.leds.length);
});

test("a large-map extraction superseded mid-run aborts with no result [rr:PR-12]", async () => {
  const ac = new AbortController();
  const fracs: number[] = [];
  await assert.rejects(
    extractTopology(installationMap(600), {}, {
      signal: ac.signal,
      onProgress: (f) => {
        fracs.push(f);
        if (fracs.length === 1) ac.abort(); // a slider change supersedes this run
      },
    }),
    (e: unknown) => e instanceof DOMException && e.name === "AbortError",
  );
  assert.equal(fracs.length, 1, "no further work reported after the abort");
  assert.ok(fracs[0]! > 0 && fracs[0]! < 1, "the abort landed mid-run");
});
