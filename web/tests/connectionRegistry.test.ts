import assert from "node:assert/strict";
import { test } from "node:test";

import { LedMapperClient, type SocketLike } from "../src/net/client";
import { connectionRegistry, deviceHostKey } from "../src/net/connectionRegistry";
import { probeDevice } from "../src/net/deviceProber";
import { encodeServer } from "../src/net/proto";
import type { ServerMessage } from "@ledmapper/protocol";

const CODE_PARAMS = {
  ledCount: 64,
  bits: 6,
  encoding: "hue",
  symbols: 2,
  bitPeriodMs: 100,
  syncPattern: "on_off",
  cycleFrames: 8,
};

class FakeSocket implements SocketLike {
  readyState = 0;
  binaryType?: string;
  onopen: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(msg: ServerMessage): void {
    this.onmessage?.({ data: encodeServer(msg) });
  }
  send(): void {}
  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

/** A client with `sockets` exposed so a test can drive it to `welcome`. */
function makeClient(url: string) {
  const sockets: FakeSocket[] = [];
  const client = new LedMapperClient(url, {
    socketFactory: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    schedule: () => {}, // no reconnect timers in these tests
  });
  return { client, sockets };
}

function welcomed(url: string, extra: Record<string, unknown> = {}) {
  const { client, sockets } = makeClient(url);
  void client.connect();
  sockets[0]!.open();
  sockets[0]!.receive({
    type: "welcome",
    sessionId: "s-1",
    codeParams: CODE_PARAMS,
    solverBenchMs: null,
    mac: "",
    deviceName: "",
    ...extra,
  } as unknown as ServerMessage);
  return { client, sockets };
}

test("deviceHostKey keys by host — path/query collapse, distinct hosts don't", () => {
  assert.equal(deviceHostKey("wss://192.168.1.5/ws"), "192.168.1.5");
  assert.equal(deviceHostKey("wss://192.168.1.5/other?x=1"), "192.168.1.5");
  assert.equal(deviceHostKey("wss://dev.local:8443/ws"), "dev.local:8443");
  assert.notEqual(deviceHostKey("wss://192.168.1.5/ws"), deviceHostKey("wss://dev.local/ws"));
});

test("registry: clientFor matches by host across URL spellings; unregister is owner-scoped", () => {
  const { client } = welcomed("wss://dev.a/ws");
  connectionRegistry.register(client);
  assert.equal(connectionRegistry.clientFor("wss://dev.a/some/other?q=1"), client);
  // A stale unregister of a DIFFERENT client for the same host must not evict the
  // live one (protects a reconnect that already re-registered).
  const other = welcomed("wss://dev.a/ws").client;
  connectionRegistry.unregister(other);
  assert.equal(connectionRegistry.clientFor("wss://dev.a/ws"), client);
  connectionRegistry.unregister(client);
  assert.equal(connectionRegistry.clientFor("wss://dev.a/ws"), undefined);
});

test("probeDevice multiplexes onto a live client — no parallel socket", async () => {
  const { client } = welcomed("wss://dev.b/ws", {
    mac: "F0:F5:BD:2C:E7:F2",
    deviceName: "FugWidget",
    fwGitCommit: "abc1234",
    fwGitDirty: true,
    fwVersion: "1.2.0",
  });
  connectionRegistry.register(client);
  // node has no global WebSocket, so the transient-probe fallback could NOT
  // produce a welcome — a returned identity proves the prober read the live
  // comms client instead of opening a second handshake. The multiplex path must
  // also surface the firmware build info (fwGitCommit/fwGitDirty/fwVersion), same as the
  // transient path, so the device sheet shows the build without a 2nd handshake.
  const info = await probeDevice("wss://dev.b/ws");
  assert.deepEqual(info, {
    mac: "F0:F5:BD:2C:E7:F2",
    deviceName: "FugWidget",
    fwGitCommit: "abc1234",
    fwGitDirty: true,
    fwVersion: "1.2.0",
  });
  connectionRegistry.unregister(client);
});

test("probeDevice reports unknown (no competing socket) while the owner is mid-handshake", async () => {
  const { client, sockets } = makeClient("wss://dev.c/ws");
  void client.connect();
  sockets[0]!.open(); // hello sent, but NO welcome yet — owner mid-handshake
  connectionRegistry.register(client);
  const info = await probeDevice("wss://dev.c/ws");
  assert.equal(info, null); // unknown, not a probe that raced the owner
  assert.equal(sockets.length, 1); // owner still holds exactly one socket
  connectionRegistry.unregister(client);
});
