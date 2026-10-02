/**
 * Performance budget of the media-driven effect preview (the editor's Video
 * pane, src/effects/editor/videoTexture.ts; FUG-39 / FUG-57). Streaming camera
 * or file video into the preview must never collapse the workspace's frame rate
 * (FUG-57 was exactly that: a mis-parsed texture size made every frame read back
 * ~1 GB and dragged the 3D view to 7 fps). The bounds pinned here, on the REAL
 * panel (videoPanelRig.ts):
 *
 *   - frames are paced to the chosen rate (10–30 fps), not the display refresh;
 *   - each frame is drawn and read back at the TEXTURE's size, however large the
 *     source (a 4K camera costs a 64×64 read-back, not a 4K one);
 *   - nothing runs per frame until streaming starts, Stop cancels the loop, and
 *     switching source / disposing releases the camera, the object URL and the
 *     animation frame.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { installFakeDom, asFake, fire, type FakeDomHandle } from "./fakeDom";

const dom: FakeDomHandle = installFakeDom();

import { button, camera, fxb, rig, settle, type Rig } from "./videoPanelRig";

let rigs: Rig[] = [];
function track(r: Rig): Rig {
  rigs.push(r);
  return r;
}
const realRevoke = URL.revokeObjectURL;
let revoked: string[] = [];

beforeEach(() => {
  camera.install();
  revoked = [];
  URL.revokeObjectURL = (u: string) => {
    revoked.push(u);
    realRevoke(u);
  };
});
afterEach(() => {
  for (const r of rigs) {
    r.panel.dispose();
    r.panel.node.remove();
  }
  rigs = [];
  dom.flushAnimationFrames();
  camera.restore();
  URL.revokeObjectURL = realRevoke;
});

async function streamingRig(tex = { w: 64, h: 64 }): Promise<Rig> {
  const r = track(rig());
  r.panel.setBytecode(fxb([{ kind: 1, w: tex.w, h: tex.h }]));
  r.panel.setPreview(r.preview);
  button(r.panel.node, "Use camera").click();
  await settle();
  return r;
}

test("video preview frames are paced to the chosen frame rate, not the display refresh [rr:PR-33]", async () => {
  const r = await streamingRig();
  const fpsSelect = asFake(r.panel.node.querySelectorAll("select")[2]);
  let t = 10_000;
  for (const fps of [15, 10, 30]) {
    fpsSelect.value = String(fps);
    fire(fpsSelect, "change");
    button(r.panel.node, "Start streaming").click();
    const before = r.preview.frames.length;
    // One second of a 125 Hz display: 125 animation frames.
    for (let i = 0; i < 125; i++) dom.flushAnimationFrames((t += 8));
    const sent = r.preview.frames.length - before;
    assert.ok(sent <= fps, `${fps} fps: ${sent} frames in 1 s`);
    assert.ok(sent >= fps * 0.8, `${fps} fps: only ${sent} frames in 1 s`);
    button(r.panel.node, "Stop").click();
    t += 1000;
  }
});

test("each preview frame is read back at the texture's size, however large the source [rr:PR-33]", async () => {
  const r = await streamingRig({ w: 64, h: 64 });
  r.video["videoWidth"] = 3840; // a 4K camera
  r.video["videoHeight"] = 2160;
  button(r.panel.node, "Start streaming").click();
  dom.flushAnimationFrames(20_000);
  dom.flushAnimationFrames(20_200);
  // The offscreen canvas and every read-back stay at the declared 64×64 (the
  // descriptor's `comp` byte is not misread into a 16384-wide texture).
  assert.deepEqual([r.canvas.width, r.canvas.height], [64, 64]);
  assert.deepEqual(r.reads, [
    [64, 64],
    [64, 64],
  ]);
  assert.ok(r.preview.frames.every((f) => f.rgba.length === 64 * 64 * 4));
  // The 4K frame is scaled down into the 64×64 box (cover-fit), never copied whole.
  const [, , , dw, dh] = r.draws[0] as [unknown, number, number, number, number];
  assert.equal(dh, 64);
  assert.ok(dw > 64 && dw < 120, `drawn ${dw}×${dh}`);

  // A source that hasn't decoded a frame yet costs nothing.
  r.video["videoWidth"] = 0;
  dom.flushAnimationFrames(20_400);
  assert.equal(r.reads.length, 2);
});

test("the video pane runs no per-frame loop until streaming and releases camera, URL and frame loop [rr:PR-33]", async () => {
  const r = await streamingRig();
  // A source is ready, but nothing ticks until Start.
  assert.equal(dom.pendingAnimationFrames, 0);
  button(r.panel.node, "Start streaming").click();
  assert.equal(dom.pendingAnimationFrames, 1);
  button(r.panel.node, "Stop").click();
  assert.equal(dom.pendingAnimationFrames, 0, "Stop cancels the frame loop");

  // Switching to a file source stops the camera's tracks.
  const file = asFake(r.panel.node.querySelector("input.fxvid-file"));
  file["files"] = [new File([new Uint8Array(8)], "clip.mp4", { type: "video/mp4" })];
  fire(file, "change");
  await settle();
  assert.equal(camera.trackStops, 1, "camera released");
  const url = String(r.video.src);
  assert.match(url, /^blob:/);

  // Disposing (leaving the editor) stops the loop and frees the file's URL.
  button(r.panel.node, "Start streaming").click();
  assert.equal(dom.pendingAnimationFrames, 1);
  r.panel.dispose();
  assert.equal(dom.pendingAnimationFrames, 0);
  assert.deepEqual(revoked, [url]);
  assert.equal(r.video.getAttribute("src"), null);
  const sent = r.preview.frames.length;
  dom.flushAnimationFrames(30_000);
  assert.equal(r.preview.frames.length, sent, "no frames after dispose");
});
