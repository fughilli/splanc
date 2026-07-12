/**
 * Trace sink batching + payload shaping (the parts that run without a
 * browser); the fetch transport is injected.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Blob } from "../src/cv/types";
import { rgbaToB64, toTraceBlob, TraceSink } from "../src/net/trace";

test("toTraceBlob keeps stats fields, rounds, and omits absent ones", () => {
  const plain: Blob = { u: 10, v: 20, area: 30, intensity: 0.5 };
  assert.deepEqual(toTraceBlob(plain), { u: 10, v: 20, area: 30, intensity: 0.5 });

  const full: Blob = {
    u: 1, v: 2, area: 3, intensity: 0.5,
    r: 0.123456, g: 0.5, b: 0.9,
    cr: 0.111111, cg: 0.2, cb: 0.8, peak: 0.999, satFrac: 0.33333,
  };
  const t = toTraceBlob(full);
  assert.equal(t.r, 0.123); // rounded to 3 places
  assert.equal(t.cr, 0.111);
  assert.equal(t.satFrac, 0.333);
  assert.equal(t.peak, 0.999);
});

test("rgbaToB64 round-trips through the standard decoder", () => {
  const bytes = new Uint8Array([0, 127, 255, 1, 2, 3, 4, 5]);
  const b64 = rgbaToB64(bytes);
  const back = Uint8Array.from(Buffer.from(b64, "base64"));
  assert.deepEqual(Array.from(back), Array.from(bytes));
});

function frame(t: number) {
  return { t, tServer: t, frameIndex: t % 14, blobs: [] };
}

test("push signals a flush at the batch size; flush POSTs header once", async () => {
  const posts: unknown[] = [];
  const fakeFetch = (async (_url: string, init: { body: string }) => {
    posts.push(JSON.parse(init.body));
    return { ok: true } as Response;
  }) as unknown as typeof fetch;

  const sink = new TraceSink("https://trace/local", 3, fakeFetch);
  sink.begin({
    sessionId: "s1", startedAt: "2026-01-01T00:00:00Z", ledCount: 64,
    wsUrl: "ws://x/ws", userAgent: "test", codeParams: { symbols: 2 },
  });

  assert.equal(sink.push(frame(1)), false);
  assert.equal(sink.push(frame(2)), false);
  assert.equal(sink.push(frame(3)), true, "flush due at batch size 3");
  await sink.flush();
  assert.equal(sink.pending, 0);

  // Second batch: header already sent, so it rides null.
  sink.push(frame(4));
  await sink.flush();

  assert.equal(posts.length, 2);
  const first = posts[0] as { header: { sessionId: string }; frames: unknown[] };
  const second = posts[1] as { header: unknown; frames: unknown[] };
  assert.equal(first.header.sessionId, "s1");
  assert.equal(first.frames.length, 3);
  assert.equal(second.header, null);
  assert.equal(second.frames.length, 1);
});

test("a failed POST drops the batch instead of stalling", async () => {
  const failing = (async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;
  const sink = new TraceSink("https://trace/local", 10, failing);
  sink.push(frame(1));
  await sink.flush(); // must not throw
  assert.equal(sink.pending, 0);
});
