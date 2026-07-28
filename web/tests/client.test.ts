/**
 * M7 client state machine against a fake socket: handshake, clock sync,
 * request/response, and the acceptance-relevant property — no detection-batch
 * loss across a reconnect.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { DetectionRecord, ServerMessage } from "@ledmapper/protocol";
import { certApprovalUrl, LedMapperClient, type SocketLike } from "../src/net/client";
import { decodeClient, encodeServer } from "../src/net/proto";

class FakeSocket implements SocketLike {
  readyState = 0; // CONNECTING
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

  /** Deliver a server message: encoded through the SAME wire boundary the
   * real server uses (binary protobuf frames). */
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

  lastSent(): { type: string } & Record<string, unknown> {
    return decodeClient(this.sent[this.sent.length - 1]!) as unknown as {
      type: string;
    } & Record<string, unknown>;
  }

  allSent(): Array<{ type: string } & Record<string, unknown>> {
    return this.sent.map(
      (s) => decodeClient(s) as unknown as { type: string } & Record<string, unknown>,
    );
  }
}

const CODE_PARAMS = {
  ledCount: 64,
  bits: 6,
  encoding: "hue",
  symbols: 2,
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
  s.receive({ type: "welcome", sessionId: "s-1", codeParams: CODE_PARAMS, solverBenchMs: null });
  const welcome = await p;
  assert.equal(welcome.sessionId, "s-1");
  assert.ok(client.isConnected);
});

test("a socket that never opens times out, reports attempts, and retries", async () => {
  const { client, sockets, scheduled } = makeClient();
  const attempts: number[] = [];
  client.events = { onConnecting: (attempt) => attempts.push(attempt) };

  const p = client.connect();
  p.catch(() => undefined); // the first attempt rejects when it's force-closed
  const s0 = sockets[0]!;
  assert.equal(s0.readyState, 0, "still CONNECTING (never opened)");

  // The open-timeout is the first scheduled callback; firing it force-closes
  // the stuck socket instead of waiting out the browser's TCP timeout.
  assert.equal(scheduled.length, 1);
  scheduled[0]!();
  assert.equal(s0.readyState, 3, "timeout closed the stuck socket");

  // onclose scheduled a backoff reconnect; fire it -> a fresh socket connects.
  scheduled[scheduled.length - 1]!();
  const s1 = sockets[1]!;
  s1.open();
  s1.receive({ type: "welcome", sessionId: "s-2", codeParams: CODE_PARAMS, solverBenchMs: null });
  await Promise.resolve();

  assert.ok(client.isConnected);
  assert.deepEqual(attempts, [1, 2], "one onConnecting per attempt");
});

test("a cert-trust wss that never welcomes stops retrying (no cert-page starvation)", async () => {
  // Cross-origin wss => certApprovalUrl is non-null => needsTrust. Stub the page
  // origin so the client sees a different host than the target.
  const saved = (globalThis as unknown as { location?: unknown }).location;
  (globalThis as unknown as { location: unknown }).location = { host: "app.test" };
  try {
    const sockets: FakeSocket[] = [];
    const scheduled: Array<() => void> = [];
    let trustNeeded = 0;
    const client = new LedMapperClient("wss://device.test/ws", {
      socketFactory: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
      now: () => 1000,
      schedule: (fn) => {
        scheduled.push(fn);
      },
    });
    client.events = { onCertTrustNeeded: () => void trustNeeded++ };

    const p = client.connect();
    p.catch(() => undefined);
    // Only the open-timeout is queued so far.
    assert.equal(scheduled.length, 1);
    // Fire it: the stuck socket is force-closed → onclose runs. Because the
    // target needs cert trust and never welcomed, it must NOT schedule a
    // reconnect — it surfaces onCertTrustNeeded and waits for the user.
    scheduled[0]!();
    assert.equal(trustNeeded, 1, "surfaced cert-trust-needed");
    assert.equal(scheduled.length, 1, "no backoff reconnect scheduled");
    assert.equal(sockets.length, 1, "did not open a second socket");
  } finally {
    (globalThis as unknown as { location?: unknown }).location = saved;
  }
});

test("the open-timeout is a no-op once welcomed", async () => {
  const { client, sockets, scheduled } = makeClient();
  const p = client.connect();
  const s = sockets[0]!;
  s.open();
  s.receive({ type: "welcome", sessionId: "s-1", codeParams: CODE_PARAMS, solverBenchMs: null });
  await p;
  // Fire the queued open-timeout: connected, so it must NOT close the socket.
  scheduled[0]!();
  assert.ok(client.isConnected);
  assert.equal(s.readyState, 1);
});

test("syncClock keeps the min-RTT sample", async () => {
  const { client, sockets, setNow } = makeClient();
  const p = client.connect();
  const s = sockets[0]!;
  s.open();
  s.receive({ type: "welcome", sessionId: "s-1", codeParams: CODE_PARAMS, solverBenchMs: null });
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
  s.receive({ type: "welcome", sessionId: "s-1", codeParams: CODE_PARAMS, solverBenchMs: null });
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

test("getFrameTiming drains the player's rendered-frame log", async () => {
  const { client, sockets } = makeClient();
  const p = client.connect();
  const s = sockets[0]!;
  s.open();
  s.receive({ type: "welcome", sessionId: "s-1", codeParams: CODE_PARAMS, solverBenchMs: null });
  await p;

  const timingP = client.getFrameTiming();
  assert.deepEqual(s.lastSent(), { type: "get_frame_timing" });
  s.receive({
    type: "frame_timing",
    patternClockEpochMs: 1000,
    bitPeriodUs: 100000,
    cycleFrames: 8,
    dropped: 2,
    ticks: [
      { seq: 0, tMonoUs: 1000000 },
      { seq: 1, tMonoUs: 1101000 },
    ],
  });
  const ft = await timingP;
  assert.equal(ft.patternClockEpochMs, 1000);
  assert.equal(ft.dropped, 2);
  assert.equal(ft.ticks.length, 2);
  assert.deepEqual(ft.ticks[1], { seq: 1, tMonoUs: 1101000 });
});

test("a server error rejects the pending request", async () => {
  const { client, sockets } = makeClient();
  const p = client.connect();
  const s = sockets[0]!;
  s.open();
  s.receive({ type: "welcome", sessionId: "s-1", codeParams: CODE_PARAMS, solverBenchMs: null });
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
  s0.receive({ type: "welcome", sessionId: "s-1", codeParams: CODE_PARAMS, solverBenchMs: null });
  await p;

  client.sendDetections([det(1)]);
  assert.equal(s0.lastSent().type, "detections");

  // Socket dies; batches queued while down.
  s0.close();
  assert.ok(!client.isConnected);
  client.sendDetections([det(2)]);
  client.sendDetections([det(3)]);
  assert.equal(client.pendingBatchCount, 2);

  // connect() scheduled a (now-harmless, since welcomed) open-timeout; the
  // socket close scheduled the backoff reconnect. Fire the reconnect (latest).
  assert.equal(scheduled.length, 2);
  scheduled[scheduled.length - 1]!();
  const s1 = sockets[1]!;
  s1.open();
  s1.receive({ type: "welcome", sessionId: "s-2", codeParams: CODE_PARAMS, solverBenchMs: null });
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
  s.receive({ type: "welcome", sessionId: "s-1", codeParams: CODE_PARAMS, solverBenchMs: null });
  await p;

  // The client is the configuration authority (§7.1): the measured scene's
  // alphabet + rate ride along in start_mapping options.
  const startP = client.startMapping(64, { symbols: 4, bitPeriodMs: 200 });
  assert.deepEqual(s.lastSent(), {
    type: "start_mapping",
    options: { ledCount: 64, symbols: 4, bitPeriodMs: 200 },
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
  s.receive({ type: "welcome", sessionId: "s-1", codeParams: CODE_PARAMS, solverBenchMs: null });
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
  // Nulls are proto-unset on the wire: decoded reports omit them.
  const { iso: _i, exposureTimeMs: _e, ambientIntensity: _a, ...present } = report;
  assert.deepEqual(s.lastSent()["report"], present);

  // Disconnected: reports are stale snapshots, not evidence — no queueing.
  const sentBefore = s.sent.length;
  s.close();
  client.sendExposureReport(report);
  assert.equal(s.sent.length, sentBefore);
});

test("getSolveStatus polls the final solve's progress", async () => {
  const { client, sockets } = makeClient();
  const p = client.connect();
  const s = sockets[0]!;
  s.open();
  s.receive({ type: "welcome", sessionId: "s-1", codeParams: CODE_PARAMS, solverBenchMs: null });
  await p;

  const statusP = client.getSolveStatus();
  assert.deepEqual(s.lastSent(), { type: "get_solve_status" });
  s.receive({
    type: "solve_status",
    running: true,
    progress: 0.55,
    rmsPx: 3.2,
    leds: [{ id: 1, xyz: [0.1, 0.2, 0.3] }],
    trajectory: [[0, 0, 0], [0.1, 0, 0]],
  });
  const st = await statusP;
  assert.equal(st.running, true);
  assert.equal(st.progress, 0.55);
  assert.equal(st.leds![0]!.id, 1);
  assert.equal(st.trajectory!.length, 2);
});

test("welcome exposes the host solver benchmark score", async () => {
  const { client, sockets } = makeClient();
  const p = client.connect();
  const s = sockets[0]!;
  s.open();
  s.receive({ type: "welcome", sessionId: "s-1", codeParams: CODE_PARAMS, solverBenchMs: 187.5 });
  await p;
  assert.equal(client.hostSolverBenchMs, 187.5);
});

test("stopMappingNoSolve stops without a host solve (solver placement)", async () => {
  const { client, sockets } = makeClient();
  const p = client.connect();
  const s = sockets[0]!;
  s.open();
  s.receive({ type: "welcome", sessionId: "s-1", codeParams: CODE_PARAMS, solverBenchMs: null });
  await p;

  const stopP = client.stopMappingNoSolve();
  assert.deepEqual(s.lastSent(), { type: "stop_mapping", solveOnHost: false });
  s.receive({ type: "mapping_stopped", detections: 420, imuSamples: 360 });
  const stopped = await stopP;
  assert.equal(stopped.detections, 420);
  assert.equal(stopped.imuSamples, 360);
});

test("submitMap uploads a phone-solved map and resolves on result_ready", async () => {
  const { client, sockets } = makeClient();
  const p = client.connect();
  const s = sockets[0]!;
  s.open();
  s.receive({ type: "welcome", sessionId: "s-1", codeParams: CODE_PARAMS, solverBenchMs: null });
  await p;

  const map = {
    mapId: "phone-map-1",
    createdAt: "2026-07-09T00:00:00Z",
    units: "meters" as const,
    frame: "gravity_leveled" as const,
    ledCount: 2,
    leds: [
      { id: 0, xyz: [0.1, 0.2, 0.3] as [number, number, number], confidence: 0.9, nViews: 12, rmsReprojPx: 0.6, parallaxDeg: 21 },
    ],
    unmapped: [1],
    trajectory: [[0, 0, 0], [0.05, 0.01, -0.02]] as [number, number, number][],
    stats: { rmsReprojPxGlobal: 0.7, medianParallaxDeg: 19 },
  };
  const submitP = client.submitMap(map);
  const sent = s.lastSent() as { type: string; map: { mapId: string } };
  assert.equal(sent.type, "submit_map");
  assert.equal(sent.map.mapId, "phone-map-1");
  s.receive({ type: "result_ready", mapId: "phone-map-1" });
  const ack = await submitP;
  assert.equal(ack.mapId, "phone-map-1");
});

test("certApprovalUrl points cross-origin wss targets at the player origin", () => {
  const page = { host: "ledmapper.pages.dev" };
  // Hosted-app flow: the player's origin is the certificate-approval stop.
  assert.equal(
    certApprovalUrl("wss://esp32.local/ws", page),
    "https://esp32.local/",
  );
  assert.equal(
    certApprovalUrl("wss://192.168.1.20:8443/ws", page),
    "https://192.168.1.20:8443/",
  );
  // Same-origin: loading the page already took the approval.
  assert.equal(certApprovalUrl("wss://ledmapper.pages.dev/ws", page), null);
  // Non-wss targets have no certificate to approve; garbage is not a URL.
  assert.equal(certApprovalUrl("ws://esp32.local/ws", page), null);
  assert.equal(certApprovalUrl("not a url", page), null);
});
