/**
 * M7 client state machine against a fake socket: handshake, clock sync,
 * request/response, and the acceptance-relevant property — no detection-batch
 * loss across a reconnect.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { DetectionRecord } from "@ledmapper/protocol";
import { LedMapperClient, type SocketLike } from "../src/net/client";

class FakeSocket implements SocketLike {
  readyState = 0; // CONNECTING
  sent: string[] = [];
  onopen: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  receive(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error("not open");
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  lastSent(): { type: string } & Record<string, unknown> {
    return JSON.parse(this.sent[this.sent.length - 1]!);
  }

  allSent(): Array<{ type: string } & Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s));
  }
}

const CODE_PARAMS = {
  ledCount: 64,
  bits: 6,
  encoding: "gray",
  bitPeriodMs: 100,
  syncPattern: "on_off",
  cycleFrames: 8,
};

function makeClient() {
  const sockets: FakeSocket[] = [];
  const scheduled: Array<() => void> = [];
  let now = 1000;
  const client = new LedMapperClient("ws://test/ws", {
    socketFactory: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    now: () => now,
    schedule: (fn) => {
      scheduled.push(fn);
    },
  });
  return {
    client,
    sockets,
    scheduled,
    setNow: (t: number) => {
      now = t;
    },
  };
}

function det(ledId: number): DetectionRecord {
  return {
    ledId,
    tCaptureMs: 1,
    u: 2,
    v: 3,
    imgW: 100,
    imgH: 100,
    K: [50, 50, 50, 50],
    pose: { p: [0, 0, 0], q: [0, 0, 0, 1] },
    confidence: 1,
  };
}

test("connect sends hello and resolves on welcome", async () => {
  const { client, sockets } = makeClient();
  const p = client.connect();
  const s = sockets[0]!;
  s.open();
  assert.equal(s.lastSent().type, "hello");
  s.receive({ type: "welcome", sessionId: "s-1", codeParams: CODE_PARAMS });
  const welcome = await p;
  assert.equal(welcome.sessionId, "s-1");
  assert.ok(client.isConnected);
});

test("syncClock keeps the min-RTT sample", async () => {
  const { client, sockets, setNow } = makeClient();
  const p = client.connect();
  const s = sockets[0]!;
  s.open();
  s.receive({ type: "welcome", sessionId: "s-1", codeParams: CODE_PARAMS });
  await p;

  setNow(2000);
  const syncP = client.syncClock(2);
  // Round 1: rtt 40, offset 500.
  let ping = s.lastSent();
  setNow(2040);
  s.receive({ type: "time_sync_pong", t0: ping["t0"], t1: 2520, t2: 2520 });
  await Promise.resolve();
  await Promise.resolve();
  // Round 2: rtt 10, offset 100.
  ping = s.lastSent();
  assert.equal(ping.type, "time_sync_ping");
  setNow(2050);
  s.receive({ type: "time_sync_pong", t0: ping["t0"], t1: 2145, t2: 2145 });
  const best = await syncP;
  assert.equal(best.rttMs, 10);
  assert.equal(best.offsetMs, 100);
  assert.equal(client.clock.toServerTime(3000), 3100);
});

test("start/stop/status/pattern request-response", async () => {
  const { client, sockets } = makeClient();
  const p = client.connect();
  const s = sockets[0]!;
  s.open();
  s.receive({ type: "welcome", sessionId: "s-1", codeParams: CODE_PARAMS });
  await p;

  const startP = client.startMapping(64);
  assert.deepEqual(s.lastSent(), { type: "start_mapping", options: { ledCount: 64 } });
  s.receive({ type: "mapping_started", patternClockEpoch: 123.4, codeParams: CODE_PARAMS });
  assert.equal((await startP).patternClockEpoch, 123.4);

  const statusP = client.getStatus();
  s.receive({ type: "status", identified: 5, total: 64, lowParallax: 2 });
  assert.equal((await statusP).identified, 5);

  const patternP = client.getPattern();
  s.receive({ type: "pattern_state", active: true, patternClockEpoch: 123.4, codeParams: CODE_PARAMS });
  assert.equal((await patternP).active, true);

  const stopP = client.stopMapping();
  s.receive({ type: "result_ready", mapId: "m-9" });
  assert.equal((await stopP).mapId, "m-9");
});

test("a server error rejects the pending request", async () => {
  const { client, sockets } = makeClient();
  const p = client.connect();
  const s = sockets[0]!;
  s.open();
  s.receive({ type: "welcome", sessionId: "s-1", codeParams: CODE_PARAMS });
  await p;

  const stopP = client.stopMapping();
  s.receive({ type: "error", code: "no_session", message: "no active capture session" });
  await assert.rejects(stopP, /no_session/);
});

test("detection batches survive a reconnect (M7 acceptance)", async () => {
  const { client, sockets, scheduled } = makeClient();
  const p = client.connect();
  const s0 = sockets[0]!;
  s0.open();
  s0.receive({ type: "welcome", sessionId: "s-1", codeParams: CODE_PARAMS });
  await p;

  client.sendDetections([det(1)]);
  assert.equal(s0.lastSent().type, "detections");

  // Socket dies; batches queued while down.
  s0.close();
  assert.ok(!client.isConnected);
  client.sendDetections([det(2)]);
  client.sendDetections([det(3)]);
  assert.equal(client.pendingBatchCount, 2);

  // Reconnect timer fires -> new socket, handshake, automatic flush.
  assert.equal(scheduled.length, 1);
  scheduled[0]!();
  const s1 = sockets[1]!;
  s1.open();
  s1.receive({ type: "welcome", sessionId: "s-2", codeParams: CODE_PARAMS });
  await Promise.resolve();

  const batches = s1
    .allSent()
    .filter((m) => m.type === "detections")
    .map((m) => (m["batch"] as DetectionRecord[]).map((d) => d.ledId));
  assert.deepEqual(batches, [[2], [3]]);
  assert.equal(client.pendingBatchCount, 0);
});

test("startMapping passes the negotiated config; configure renegotiates", async () => {
  const { client, sockets } = makeClient();
  const p = client.connect();
  const s = sockets[0]!;
  s.open();
  s.receive({ type: "welcome", sessionId: "s-1", codeParams: CODE_PARAMS });
  await p;

  // The client is the configuration authority (§7.1): the measured scene's
  // encoding + rate ride along in start_mapping options.
  const startP = client.startMapping(64, { encoding: "gray-hue", bitPeriodMs: 200 });
  assert.deepEqual(s.lastSent(), {
    type: "start_mapping",
    options: { ledCount: 64, encoding: "gray-hue", bitPeriodMs: 200 },
  });
  s.receive({ type: "mapping_started", patternClockEpoch: 1.0, codeParams: CODE_PARAMS });
  await startP;

  // Mid-capture renegotiation: configure -> pattern_state with the new
  // epoch + params to rebuild the pipeline against.
  const cfgP = client.configure({ bitPeriodMs: 300 });
  assert.deepEqual(s.lastSent(), { type: "configure", options: { bitPeriodMs: 300 } });
  const newParams = { ...CODE_PARAMS, bitPeriodMs: 300 };
  s.receive({ type: "pattern_state", active: true, patternClockEpoch: 999.9, codeParams: newParams });
  const ps = await cfgP;
  assert.equal(ps.patternClockEpoch, 999.9);
  assert.equal(ps.codeParams.bitPeriodMs, 300);
});

test("exposure reports are fire-and-forget and dropped while disconnected", async () => {
  const { client, sockets } = makeClient();
  const p = client.connect();
  const s = sockets[0]!;
  s.open();
  s.receive({ type: "welcome", sessionId: "s-1", codeParams: CODE_PARAMS });
  await p;

  const report = {
    tCaptureMs: 1.0,
    frameIntervalMs: 33.3,
    meanLuma: 0.05,
    p95Luma: 0.2,
    clipFrac: 0.001,
    blobCount: 30,
    detectorThreshold: 0.6,
    iso: null,
    exposureTimeMs: null,
    ambientIntensity: null,
  };
  client.sendExposureReport(report);
  assert.equal(s.lastSent().type, "exposure_report");
  assert.deepEqual(s.lastSent()["report"], report);

  // Disconnected: reports are stale snapshots, not evidence — no queueing.
  const sentBefore = s.sent.length;
  s.close();
  client.sendExposureReport(report);
  assert.equal(s.sent.length, sentBefore);
});
