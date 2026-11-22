/**
 * DetectPipeline (cv/detect.ts, D-177): pipelined detection must deliver every
 * submitted frame exactly once, in submission order, tagged with ITS frame;
 * shed (not block) when the GPU is behind; read anyway once a fence is stalled;
 * and flush everything on collect(true). Driven against a fake WebGL2 context
 * whose fences signal when the test says so, and a fake detector whose "detect
 * buffer" carries the frame number through the pixel-pack buffer.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { connectedComponents } from "../src/cv/ccl";
import { DetectPipeline, type DetectorGL, planDetectDownscale, PIPELINE_STALL_MS } from "../src/cv/detect";

const W = 4;
const H = 2;

class FakeGl {
  readonly PIXEL_PACK_BUFFER = 1;
  readonly RGBA = 2;
  readonly UNSIGNED_BYTE = 3;
  readonly FLOAT = 4;
  readonly SYNC_GPU_COMMANDS_COMPLETE = 5;
  readonly ALREADY_SIGNALED = 6;
  readonly CONDITION_SATISFIED = 7;
  readonly TIMEOUT_EXPIRED = 8;
  readonly STREAM_READ = 9;
  readonly FRAMEBUFFER = 10;
  readonly FRAMEBUFFER_BINDING = 11;
  readonly VIEWPORT = 12;
  /** Frame number the fake detector last "rendered". */
  current = -1;
  private bound: { data: number } | null = null;
  private nextSync = 0;
  readonly signaled = new Set<number>();
  readonly blockingReads: number[] = [];
  buffers = 0;
  getParameter(p: number): unknown {
    return p === this.VIEWPORT ? new Int32Array([0, 0, 1, 1]) : null;
  }
  bindFramebuffer(): void {}
  viewport(): void {}
  flush(): void {}
  createBuffer(): { data: number } {
    this.buffers++;
    return { data: -1 };
  }
  deleteBuffer(): void {
    this.buffers--;
  }
  bufferData(): void {}
  bindBuffer(_t: number, b: { data: number } | null): void {
    this.bound = b;
  }
  readPixels(): void {
    if (this.bound) this.bound.data = this.current;
  }
  fenceSync(): { id: number } {
    return { id: this.nextSync++ };
  }
  clientWaitSync(s: { id: number }): number {
    return this.signaled.has(s.id) ? this.ALREADY_SIGNALED : this.TIMEOUT_EXPIRED;
  }
  deleteSync(): void {}
  getBufferSubData(_t: number, _o: number, dst: Uint8Array | Float32Array): void {
    // Reading a buffer whose fence hasn't signaled is a blocking read.
    if (dst instanceof Uint8Array) {
      dst.fill(0);
      dst[0] = this.bound!.data;
    }
  }
  signal(id: number): void {
    this.signaled.add(id);
  }
}

function fakeDetector(gl: FakeGl): DetectorGL {
  const det = {
    downscale: 2,
    flipV: false,
    lastProfile: null,
    stats: 0,
    renderDetect(tex: { frame: number }) {
      gl.current = tex.frame;
      // Every 4th frame refreshes the noise statistics.
      return { fbo: {}, w: W, h: H, stats: tex.frame % 4 === 3 ? { fbo: {}, w: 1, h: 1 } : null };
    },
    renderMeasure() {
      return { fbo: {}, w: 1, h: 1 };
    },
    acceptStats() {
      det.stats++;
    },
    acceptMeasure() {
      return { meanLuma: 0.5, p95Luma: 0.9, clipFrac: 0 };
    },
    measureFrame() {
      return { meanLuma: 0.25, p95Luma: 0.5, clipFrac: 0 };
    },
    blobsFromBuffer(buf: Uint8Array) {
      return [{ u: buf[0]!, v: 0, intensity: 1, area: 1 }];
    },
  };
  return det as unknown as DetectorGL;
}

function setup(depth = 2) {
  const gl = new FakeGl();
  const det = fakeDetector(gl);
  let now = 0;
  const pipe = new DetectPipeline<number>(gl as unknown as WebGL2RenderingContext, det, depth, () => now);
  const frame = (n: number) => ({ texture: { frame: n } as unknown as WebGLTexture, imgW: 2 * W, imgH: 2 * H });
  return { gl, det, pipe, frame, advance: (ms: number) => (now += ms) };
}

test("frames come back in order, each with its own tag and its own pixels, one frame late", () => {
  const { gl, pipe, frame } = setup();
  const got: [number, number][] = [];
  for (let n = 0; n < 10; n++) {
    assert.ok(pipe.submit(frame(n), n));
    // The previous frame's fence has signaled by the time the next arrives.
    if (n > 0) gl.signal(n - 1);
    for (const d of pipe.collect()) got.push([d.tag, d.blobs[0]!.u]);
  }
  for (const d of pipe.collect(true)) got.push([d.tag, d.blobs[0]!.u]);
  assert.deepEqual(
    got,
    Array.from({ length: 10 }, (_, i) => [i, i]),
  );
});

test("a GPU that falls behind sheds new frames instead of blocking, and loses none it took", () => {
  const { gl, pipe, frame } = setup(2);
  assert.ok(pipe.submit(frame(0), 0));
  assert.ok(pipe.submit(frame(1), 1));
  // Two in flight, the oldest unfinished: the third is shed, nothing blocks.
  assert.equal(pipe.submit(frame(2), 2), false);
  assert.equal(pipe.shed, 1);
  assert.deepEqual(pipe.collect(), []);
  gl.signal(0);
  // Oldest done: the next frame is accepted, and frame 0 is delivered.
  assert.ok(pipe.submit(frame(3), 3));
  assert.deepEqual(
    pipe.collect().map((d) => d.tag),
    [0],
  );
  gl.signal(1);
  gl.signal(2);
  assert.deepEqual(
    pipe.collect().map((d) => d.tag),
    [1, 3],
  );
  assert.equal(pipe.submitted, 3);
  assert.equal(pipe.inFlight, 0);
});

test("a fence that never reports is read anyway after the stall timeout", () => {
  const { pipe, frame, advance } = setup();
  pipe.submit(frame(0), 0);
  assert.deepEqual(pipe.collect(), []);
  advance(PIPELINE_STALL_MS + 1);
  assert.deepEqual(
    pipe.collect().map((d) => d.tag),
    [0],
  );
});

test("noise statistics and the measure pass ride along with their frame", () => {
  const { gl, det, pipe, frame } = setup(8);
  for (let n = 0; n < 8; n++) pipe.submit(frame(n), n, { measure: n === 5 });
  for (let n = 0; n < 8; n++) gl.signal(n);
  const out = pipe.collect();
  assert.equal(out.length, 8);
  assert.equal((det as unknown as { stats: number }).stats, 2); // frames 3 and 7
  assert.deepEqual(
    out.map((d) => d.scene !== undefined),
    [false, false, false, false, false, true, false, false],
  );
});

test("pre-reduced (native) frames need no GPU and are ready at once", () => {
  const { pipe } = setup();
  const reduced = { detect: new Uint8Array(W * H * 4), w: W, h: H, truncated: false, measure: new Uint8Array(4), measureW: 1, measureH: 1 };
  reduced.detect[0] = 42;
  pipe.submit({ texture: null, imgW: 2 * W, imgH: 2 * H, reduced }, 7, { measure: true });
  const [d] = pipe.collect();
  assert.equal(d!.tag, 7);
  assert.equal(d!.blobs[0]!.u, 42);
  assert.equal(d!.scene!.meanLuma, 0.25);
});

test("pixel-pack buffers are recycled, not leaked", () => {
  const { gl, pipe, frame } = setup();
  for (let n = 0; n < 50; n++) {
    pipe.submit(frame(n), n);
    gl.signal(n);
    pipe.collect();
  }
  assert.ok(gl.buffers <= 6, `${gl.buffers} live buffers`);
  pipe.dispose();
  assert.equal(gl.buffers, 0);
});

test("planDetectDownscale walks 2 -> 3 -> 4 only while the GPU sheds frames", () => {
  assert.equal(planDetectDownscale(2, { submitted: 60, shed: 2 }), null);
  assert.equal(planDetectDownscale(2, { submitted: 40, shed: 20 }), 3);
  assert.equal(planDetectDownscale(3, { submitted: 40, shed: 20 }), 4);
  assert.equal(planDetectDownscale(4, { submitted: 40, shed: 20 }), null);
  // Too few frames to judge.
  assert.equal(planDetectDownscale(2, { submitted: 5, shed: 5 }), null);
});

test("CCL word scan: a pixel with colour but zero weight is still background", () => {
  // The fast path skips all-zero RGBA words; a non-zero word with alpha 0 must
  // still be checked on its weight byte, exactly like the per-byte scan.
  const w = 8;
  const h = 4;
  const buf = new Uint8Array(w * h * 4);
  const set = (x: number, y: number, rgba: number[]) => buf.set(rgba, (y * w + x) * 4);
  set(1, 1, [200, 0, 0, 0]); // colour, no weight
  set(2, 1, [255, 0, 0, 200]);
  set(3, 1, [255, 0, 0, 200]);
  set(6, 2, [0, 0, 255, 100]);
  const blobs = connectedComponents(buf, w, h, 4, 3, { colorBase: 0 });
  assert.equal(blobs.length, 2);
  assert.deepEqual(
    blobs.map((b) => b.area),
    [2, 1],
  );
  // And the same through a misaligned view (no word path).
  const big = new Uint8Array(buf.length + 1);
  big.set(buf, 1);
  const off = connectedComponents(big.subarray(1), w, h, 4, 3, { colorBase: 0 });
  assert.deepEqual(off, blobs);
});
