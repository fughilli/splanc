/**
 * Full-frame capture (net/frameCapture.ts): gzip framing + the bounded,
 * snapshotting upload sink. No GL here — the readback is device territory;
 * the compression/transport is not.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { FrameSink, frameUrlFromTraceUrl, gzip } from "../src/net/frameCapture";

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("gzip");
  const w = ds.writable.getWriter();
  void w.write(bytes as unknown as BufferSource);
  void w.close();
  const chunks: Uint8Array[] = [];
  const r = ds.readable.getReader();
  for (;;) {
    const { done, value } = await r.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

test("gzip round-trips losslessly and compresses mostly-dark frames", async () => {
  // A mostly-black RGBA frame with a few bright pixels (an LED scene).
  const rgba = new Uint8Array(64 * 64 * 4);
  for (let i = 0; i < 8; i++) rgba[i * 4 * 137] = 255;
  const gz = await gzip(rgba);
  assert.ok(gz.length < rgba.length / 4, "mostly-dark frame compresses hard");
  assert.deepEqual(Array.from(await gunzip(gz)), Array.from(rgba));
});

test("frameUrlFromTraceUrl swaps /trace for /frame", () => {
  assert.equal(frameUrlFromTraceUrl("https://host:8444/trace"), "https://host:8444/frame");
  assert.equal(frameUrlFromTraceUrl("https://host:8444/trace/"), "https://host:8444/frame");
});

test("capture uploads gzipped bytes with seq/w/h and snapshots the buffer", async () => {
  const posts: { url: string; body: Uint8Array }[] = [];
  const fakeFetch = (async (url: string, init: { body: Uint8Array }) => {
    posts.push({ url, body: init.body });
    return { ok: true } as Response;
  }) as unknown as typeof fetch;

  const sink = new FrameSink("https://host/frame", "sess-1", 3, 1e9, fakeFetch);
  const rgba = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  sink.capture(7, 2, 1, rgba); // returns immediately; upload happens in the drain
  // The detector reuses the buffer next frame — mutate it now; the RAM-cached
  // snapshot must be unaffected.
  rgba.fill(0);
  await sink.finish();

  assert.equal(posts.length, 1);
  assert.equal(posts[0]!.url, "https://host/frame?session=sess-1&seq=7&w=2&h=1");
  assert.deepEqual(Array.from(await gunzip(posts[0]!.body)), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(sink.sentCount, 1);
});

test("no frame is dropped for backpressure; finish() drains them all", async () => {
  // Every upload is slow, so capture must never block or drop — the frames
  // buffer in RAM and finish() drains them after the (simulated) capture ends.
  const fakeFetch = (async () => {
    await new Promise((r) => setTimeout(r, 1));
    return { ok: true } as Response;
  }) as unknown as typeof fetch;

  const sink = new FrameSink("https://host/frame", "s", 2, 1e9, fakeFetch);
  for (let i = 0; i < 20; i++) sink.capture(i, 1, 1, new Uint8Array(4));
  assert.equal(sink.droppedCount, 0, "no drops under backpressure");
  await sink.finish();
  assert.equal(sink.sentCount, 20, "every buffered frame uploaded");
  assert.equal(sink.droppedCount, 0);
  assert.equal(sink.queuedCount, 0);
});

test("the RAM cap drops frames instead of OOMing", () => {
  const hang = (() => new Promise(() => undefined)) as unknown as typeof fetch; // uploads never resolve
  const sink = new FrameSink("https://host/frame", "s", 1, 10, hang); // 10-byte cap, 1 worker
  sink.capture(0, 1, 1, new Uint8Array(8)); // drained-in-flight (ram back to 0)
  sink.capture(1, 1, 1, new Uint8Array(8)); // buffered (8 ≤ 10)
  sink.capture(2, 1, 1, new Uint8Array(8)); // 8+8 > 10 → dropped
  assert.equal(sink.droppedCount, 1);
});
