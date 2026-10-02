/**
 * Detection batches outlive a device outage (PR-31).
 *
 * A capture streams its detections to the device in small batches while the
 * user walks. When the device link drops mid-walk — a long outage, possibly
 * with reconnect attempts that fail before the handshake completes (the player
 * rebooting) — those batches are the user's work: the client must keep every
 * one queued, never hand one to a socket that has not completed `welcome`, and
 * deliver all of them, in order, once the device is back. A batch whose write
 * throws on a dying socket must stay queued too.
 *
 * Every test carries exactly one requirement: PR-31.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { DetectionRecord, ServerMessage } from "@ledmapper/protocol";
import { LedMapperClient, type SocketLike } from "../src/net/client";
import { decodeClient, encodeServer } from "../src/net/proto";

class DeviceSocket implements SocketLike {
  readyState = 0;
  binaryType?: string;
  /** Set when the TCP connection died but the browser has not closed it yet. */
  writesFail = false;
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
    if (this.readyState !== 1 || this.writesFail) throw new Error("socket is dead");
    if (!(data instanceof Uint8Array)) throw new Error("expected binary frame");
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  /** Detection batches this socket carried, as lists of LED ids. */
  batches(): number[][] {
    return this.sent
      .map((s) => decodeClient(s) as unknown as { type: string; batch?: DetectionRecord[] })
      .filter((m) => m.type === "detections")
      .map((m) => (m.batch ?? []).map((d) => d.ledId));
  }
}

const CODE_PARAMS = {
  ledCount: 64,
  bits: 12,
  encoding: "hue",
  symbols: 2,
  bitPeriodMs: 100,
  syncPattern: "on_off",
  cycleFrames: 14,
};

function welcome(s: DeviceSocket): void {
  s.receive({ type: "welcome", sessionId: "s", codeParams: CODE_PARAMS, solverBenchMs: null });
}

function det(ledId: number): DetectionRecord {
  return {
    ledId,
    tCaptureMs: ledId,
    u: 10,
    v: 20,
    imgW: 1280,
    imgH: 720,
    K: [900, 900, 640, 360],
    pose: null,
    confidence: 1,
  };
}

async function connectedClient(): Promise<{
  client: LedMapperClient;
  sockets: DeviceSocket[];
  /** Run the most recently scheduled callback (the pending reconnect). */
  fireReconnect: () => void;
}> {
  const sockets: DeviceSocket[] = [];
  const scheduled: Array<() => void> = [];
  const client = new LedMapperClient("ws://player.test/ws", {
    socketFactory: () => {
      const s = new DeviceSocket();
      sockets.push(s);
      return s;
    },
    now: () => 1000,
    schedule: (fn) => {
      scheduled.push(fn);
    },
  });
  const p = client.connect();
  sockets[0]!.open();
  welcome(sockets[0]!);
  await p;
  return { client, sockets, fireReconnect: () => scheduled[scheduled.length - 1]!() };
}

test("detections captured through a long outage with failed reconnects all reach the device once it is back [rr:PR-31]", async () => {
  const { client, sockets, fireReconnect } = await connectedClient();
  client.sendDetections([det(0)]);
  assert.deepEqual(sockets[0]!.batches(), [[0]]);

  sockets[0]!.close(); // the device drops mid-walk
  for (let i = 1; i <= 40; i++) client.sendDetections([det(i)]);
  assert.equal(client.pendingBatchCount, 40);

  // The player is rebooting: a reconnect opens, then dies before `welcome`.
  fireReconnect();
  sockets[1]!.open();
  sockets[1]!.close();
  assert.deepEqual(sockets[1]!.batches(), [], "nothing is handed to a socket that never welcomed");
  assert.equal(client.pendingBatchCount, 40, "a failed reconnect loses no batch");

  // The device is back.
  fireReconnect();
  sockets[2]!.open();
  welcome(sockets[2]!);
  await Promise.resolve();
  assert.deepEqual(
    sockets[2]!.batches(),
    Array.from({ length: 40 }, (_, i) => [i + 1]),
    "every queued batch, in capture order",
  );
  assert.equal(client.pendingBatchCount, 0);
});

test("a batch whose write fails on a dying socket stays queued instead of being dropped [rr:PR-31]", async () => {
  const { client, sockets, fireReconnect } = await connectedClient();
  sockets[0]!.writesFail = true; // TCP is gone, onclose has not fired yet
  client.sendDetections([det(7)]);
  client.sendDetections([det(8)]);
  assert.equal(client.pendingBatchCount, 2, "failed writes keep their batches");

  sockets[0]!.close();
  fireReconnect();
  sockets[1]!.open();
  welcome(sockets[1]!);
  await Promise.resolve();
  assert.deepEqual(sockets[1]!.batches(), [[7], [8]]);
  assert.equal(client.pendingBatchCount, 0);
});
