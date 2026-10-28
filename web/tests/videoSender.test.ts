import test from "node:test";
import assert from "node:assert/strict";

import { VideoSender, type VideoTransport } from "../src/net/videoSender";
import type { SetTextureMessage } from "../src/net/proto";

// A fake fixture connection: records frames, and hands out ping markers the
// test resolves (the device "applied" everything before it) or rejects.
class FakeFixture implements VideoTransport {
  isConnected = true;
  frames: SetTextureMessage[] = [];
  markers: { resolve: () => void; reject: () => void }[] = [];
  setTexture(msg: SetTextureMessage): boolean {
    if (!this.isConnected) return false;
    this.frames.push(msg);
    return true;
  }
  ping(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.markers.push({ resolve: () => resolve(1), reject: () => reject(new Error("timeout")) });
    });
  }
  ackOldest(): Promise<void> {
    this.markers.shift()!.resolve();
    return new Promise((r) => setImmediate(r));
  }
  failOldest(): Promise<void> {
    this.markers.shift()!.reject();
    return new Promise((r) => setImmediate(r));
  }
}

function frame(v: number): Uint8Array {
  const rgba = new Uint8Array(4 * 4 * 4);
  rgba.fill(v);
  return rgba;
}

const DELTA = 0x01;

test("bounds in-flight frames and keeps only the newest pending one", async () => {
  const fx = new FakeFixture();
  let now = 0;
  const s = new VideoSender(fx, { texIndex: 0, maxInFlight: 2, keyframeIntervalMs: 0, now: () => now });
  for (let i = 0; i < 6; i++) {
    now += 33;
    s.submit(4, 4, frame(i * 10));
  }
  // Two went out; frames 2..4 were each replaced by the next while waiting, 5 waits.
  assert.equal(fx.frames.length, 2);
  assert.equal(s.stats().inFlight, 2);
  assert.equal(s.stats().dropped, 3);
  await fx.ackOldest();
  assert.equal(fx.frames.length, 3, "a confirmed frame frees a slot for the newest");
  assert.equal(s.stats().acked, 1);
  await fx.ackOldest();
  await fx.ackOldest();
  assert.equal(fx.frames.length, 3, "nothing newer to send");
  assert.equal(s.stats().inFlight, 0);
});

test("a dropped frame never breaks the delta chain", async () => {
  // Decode what the device receives and check it equals the newest frame sent.
  const fx = new FakeFixture();
  const s = new VideoSender(fx, {
    texIndex: 0,
    format: "gray8",
    rle: false,
    maxInFlight: 1,
    keyframeIntervalMs: 0,
  });
  const dev = new Uint8Array(16);
  const apply = (m: SetTextureMessage) => {
    if ((m.flags & DELTA) === 0) dev.fill(0);
    m.data.forEach((b, i) => (dev[i]! ^= b));
  };
  s.submit(4, 4, frame(10)); // sent
  s.submit(4, 4, frame(20)); // pending
  s.submit(4, 4, frame(30)); // replaces 20 (dropped, never encoded)
  await fx.ackOldest();
  s.submit(4, 4, frame(40)); // pending behind 30
  await fx.ackOldest();
  fx.frames.forEach(apply);
  assert.deepEqual(
    fx.frames.map((f) => f.flags & DELTA),
    [0, DELTA, DELTA],
  );
  assert.ok(dev.every((b) => b === 40), "device holds the newest frame exactly");
});

test("a late or lost marker frees the slot without breaking the delta chain", async () => {
  const fx = new FakeFixture();
  const s = new VideoSender(fx, { texIndex: 0, maxInFlight: 1, keyframeIntervalMs: 0 });
  s.submit(4, 4, frame(1));
  s.submit(4, 4, frame(2));
  await fx.failOldest();
  assert.equal(s.stats().timeouts, 1);
  assert.equal(fx.frames.length, 2);
  assert.equal(fx.frames[1]!.flags & DELTA, DELTA, "TCP delivered frame 1: keep deltas");
});

test("the marker timeout adapts to the round trip (min 100 ms, 3x the median)", async () => {
  const timeouts: number[] = [];
  const pending: (() => void)[] = [];
  let now = 0;
  const s = new VideoSender(
    {
      isConnected: true,
      setTexture: () => true,
      ping: (ms) => {
        timeouts.push(ms);
        return new Promise((r) => pending.push(() => r(1)));
      },
    },
    { texIndex: 0, maxInFlight: 1, now: () => now },
  );
  s.submit(4, 4, frame(1));
  assert.equal(timeouts[0], 100);
  for (let i = 0; i < 5; i++) {
    now += 60; // each frame takes 60 ms to confirm
    pending.shift()!();
    await new Promise((r) => setImmediate(r));
    s.submit(4, 4, frame(i + 2));
  }
  assert.equal(timeouts.at(-1), 180);
});

test("periodic keyframes and reset", async () => {
  const fx = new FakeFixture();
  let now = 0;
  const s = new VideoSender(fx, { texIndex: 0, maxInFlight: 1, keyframeIntervalMs: 100, now: () => now });
  for (let i = 0; i < 8; i++) {
    now += 33;
    s.submit(4, 4, frame(i));
    await fx.ackOldest();
  }
  const kinds = fx.frames.map((f) => f.flags & DELTA);
  // keyframes at t=33 and t=165 (the first frame >= 100 ms after the last one)
  assert.deepEqual(kinds, [0, DELTA, DELTA, DELTA, 0, DELTA, DELTA, DELTA]);
  assert.equal(s.stats().keyframes, 2);
  s.reset();
  s.submit(4, 4, frame(9));
  assert.equal(fx.frames.at(-1)!.flags & DELTA, 0);
});

test("disconnected: nothing sent, next frame after reconnect is a keyframe", async () => {
  const fx = new FakeFixture();
  const s = new VideoSender(fx, { texIndex: 0, keyframeIntervalMs: 0 });
  s.submit(4, 4, frame(1));
  await fx.ackOldest();
  fx.isConnected = false;
  s.submit(4, 4, frame(2));
  assert.equal(fx.frames.length, 1);
  fx.isConnected = true;
  s.submit(4, 4, frame(3));
  assert.equal(fx.frames.length, 2);
  assert.equal(fx.frames[1]!.flags & DELTA, 0);
});

test("without a ping transport it degrades to fire-and-forget", () => {
  const frames: SetTextureMessage[] = [];
  const s = new VideoSender(
    { isConnected: true, setTexture: (m) => (frames.push(m), true) },
    { texIndex: 0 },
  );
  for (let i = 0; i < 5; i++) s.submit(4, 4, frame(i));
  assert.equal(frames.length, 5);
  assert.equal(s.stats().dropped, 0);
});
