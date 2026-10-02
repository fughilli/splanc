/**
 * Previewing an effect from camera / video input with NO hardware connected
 * (FUG-39; src/effects/editor/videoTexture.ts). The editor's Video pane used to
 * stream frames only to a connected device; FUG-39 made the offline preview VM a
 * first-class consumer (PreviewSink → FxPreview.setTexture), so "Use camera" /
 * "Pick file" maps live video onto the effect's `texture` in the workspace's 3D
 * preview with nothing plugged in, and a device became an optional extra
 * consumer. This suite drives the REAL panel on the fake DOM (camera, video
 * element and 2D canvas stubbed — videoPanelRig.ts) and pins that contract:
 *
 *   - camera and video-file sources stream into the preview sink with no device;
 *   - each frame is sized to the texture the compiled effect declares (read from
 *     its .fxb, FUG-57) and cover-fitted from the source;
 *   - a connected device additionally gets encoded frames, and losing it never
 *     stops the preview;
 *   - when preview isn't possible (no texture, camera denied/unsupported) the
 *     pane says why instead of failing.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { installFakeDom, asFake, fire, textOf, type FakeDomHandle } from "./fakeDom";

const dom: FakeDomHandle = installFakeDom();

import { button, camera, controls, fxb, hint, pixels, rig, settle, stats, type Rig } from "./videoPanelRig";
import type { TextureSink } from "../src/effects/editor/videoTexture";
import type { SetTextureMessage } from "../src/net/proto";

let rigs: Rig[] = [];
let now = 1000;
const nextFrame = (): number => dom.flushAnimationFrames((now += 100));
function track(r: Rig): Rig {
  rigs.push(r);
  return r;
}

beforeEach(() => camera.install());
afterEach(() => {
  for (const r of rigs) {
    r.panel.dispose();
    r.panel.node.remove();
  }
  rigs = [];
  dom.flushAnimationFrames(); // drop any rAF a test left queued
  camera.restore();
});

test("camera video previews on the effect's texture in the workspace with no device connected [rr:PR-9]", async () => {
  const r = track(rig());
  r.panel.setBytecode(fxb([{ kind: 1, w: 64, h: 32 }]));
  r.panel.setSink(null); // no hardware
  r.panel.setPreview(r.preview);

  // A texture-declaring effect is all it takes: the controls are live.
  assert.equal(controls(r).style.display, "");
  assert.equal(hint(r).style.display, "none");
  const start = button(r.panel.node, "Start streaming");
  assert.equal(start.disabled, true, "pick a source first");

  button(r.panel.node, "Use camera").click();
  await settle();
  assert.deepEqual(camera.calls, [{ video: { facingMode: "environment" } }]);
  assert.equal(r.video["srcObject"], camera.stream);
  assert.equal(start.disabled, false);

  start.click();
  assert.equal(textOf(start), "Stop");
  nextFrame();
  // One frame went to the offline preview: the texture's own size, real pixels,
  // cover-fitted from the 320×240 camera (scale 0.2 → 64×48, centred at y=-8).
  assert.equal(r.preview.frames.length, 1);
  assert.deepEqual(
    r.preview.frames.map((f) => [f.tex, f.width, f.height, f.rgba.length]),
    [[0, 64, 32, 64 * 32 * 4]],
  );
  assert.deepEqual(r.preview.frames[0]!.rgba, [...pixels(64, 32)]);
  assert.deepEqual(r.draws[0], [r.video, 0, -8, 64, 48]);
  assert.equal(stats(r), "1 fps · preview");

  // It keeps streaming at the chosen rate until stopped.
  nextFrame();
  nextFrame();
  assert.equal(r.preview.frames.length, 3);
  start.click();
  assert.equal(textOf(start), "Start streaming");
  assert.ok(r.media.pauses > 0, "the source pauses");
  nextFrame();
  assert.equal(r.preview.frames.length, 3, "no frames after Stop");
});

test("a picked video file streams into the preview at the size of the texture the compiled effect declares [rr:PR-9]", async () => {
  const r = track(rig());
  // An LED-arity buffer first, then two textures: indices 1 and 2 in the table.
  r.panel.setBytecode(
    fxb([
      { kind: 0, w: 0, h: 0 },
      { kind: 1, w: 16, h: 16 },
      { kind: 1, w: 32, h: 8 },
    ]),
  );
  r.panel.setPreview(r.preview);
  const texSelect = asFake(r.panel.node.querySelectorAll("select")[0]);
  assert.deepEqual(texSelect.querySelectorAll("option").map((o) => o.textContent), ["#1 · 16×16", "#2 · 32×8"]);

  const file = asFake(r.panel.node.querySelector("input.fxvid-file"));
  file["files"] = [new File([new Uint8Array(16)], "clip.webm", { type: "video/webm" })];
  fire(file, "change");
  await settle();
  assert.match(String(r.video.src), /^blob:/, "the file plays in the pane");
  assert.ok(r.media.plays > 0);

  texSelect.value = "2";
  fire(texSelect, "change");
  button(r.panel.node, "Start streaming").click();
  nextFrame();
  assert.deepEqual(
    r.preview.frames.map((f) => [f.tex, f.width, f.height, f.rgba.length]),
    [[2, 32, 8, 32 * 8 * 4]],
  );
  assert.deepEqual([r.canvas.width, r.canvas.height], [32, 8]);

  // Recompiling with a resized texture: the next frame follows the new size.
  r.panel.setBytecode(
    fxb([
      { kind: 0, w: 0, h: 0 },
      { kind: 1, w: 16, h: 16 },
      { kind: 1, w: 48, h: 12 },
    ]),
  );
  nextFrame();
  assert.deepEqual(r.preview.frames.map((f) => [f.tex, f.width, f.height]).at(-1), [2, 48, 12]);
});

test("a device is only an extra consumer: frames reach the preview with or without it [rr:PR-9]", async () => {
  const r = track(rig());
  const deviceMsgs: SetTextureMessage[] = [];
  const device: TextureSink & { isConnected: boolean } = {
    isConnected: true,
    setTexture: (m) => {
      deviceMsgs.push(m);
      return true;
    },
  };
  r.panel.setBytecode(fxb([{ kind: 1, w: 16, h: 8 }]));
  r.panel.setPreview(r.preview);
  r.panel.setSink(device);
  button(r.panel.node, "Use camera").click();
  await settle();
  button(r.panel.node, "Start streaming").click();
  nextFrame();
  // Both consumers: raw RGBA to the preview, an encoded frame to the device.
  assert.equal(r.preview.frames.length, 1);
  assert.equal(deviceMsgs.length, 1);
  assert.deepEqual([deviceMsgs[0]!.texIndex, deviceMsgs[0]!.width, deviceMsgs[0]!.height], [0, 16, 8]);
  assert.match(stats(r), /^1 fps · preview \+ device · \d+ B\/frame$/);

  // The device drops off: the preview keeps streaming on its own.
  device.isConnected = false;
  r.panel.setSink(null);
  assert.equal(textOf(button(r.panel.node, "Stop")), "Stop", "still running");
  nextFrame();
  assert.equal(r.preview.frames.length, 2);
  assert.equal(deviceMsgs.length, 1);
  assert.match(stats(r), /· preview$/);

  // With no preview available and no device there is nowhere to stream to.
  r.panel.setPreview(null);
  assert.equal(textOf(button(r.panel.node, "Start streaming")), "Start streaming", "stopped");
  button(r.panel.node, "Start streaming").click();
  nextFrame();
  assert.equal(r.preview.frames.length, 2);
});

test("when a video preview isn't possible the pane says why instead of failing [rr:PR-9]", async () => {
  // No texture in the effect: nothing to map video onto.
  const r = track(rig());
  r.panel.setPreview(r.preview);
  r.panel.setBytecode(fxb([]));
  assert.equal(controls(r).style.display, "none");
  assert.equal(textOf(hint(r)), "Load an effect that declares a `texture` to preview video mapped onto it.");
  // A failed compile (no bytecode) reads the same.
  r.panel.setBytecode(fxb([{ kind: 1, w: 8, h: 8 }]));
  assert.equal(controls(r).style.display, "");
  r.panel.setBytecode(null);
  assert.equal(controls(r).style.display, "none");

  // Camera denied.
  r.panel.setBytecode(fxb([{ kind: 1, w: 8, h: 8 }]));
  camera.install(async () => {
    throw new DOMException("Permission denied", "NotAllowedError");
  });
  button(r.panel.node, "Use camera").click();
  await settle();
  assert.equal(textOf(hint(r)), "Camera access denied or unavailable.");
  assert.equal(hint(r).style.display, "");
  assert.equal(button(r.panel.node, "Start streaming").disabled, true);

  // No camera API at all.
  camera.install(null);
  button(r.panel.node, "Use camera").click();
  await settle();
  assert.equal(textOf(hint(r)), "Camera not supported in this browser.");
});
