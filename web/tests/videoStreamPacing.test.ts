/**
 * Device video streaming from the editor's Video pane stays at about one frame of
 * latency (src/effects/editor/videoTexture.ts + src/net/videoSender.ts):
 *
 *   - the send cadence is phase-locked (30 fps on a 60 Hz display is every other
 *     vsync, not a 33/50 ms flip-flop on timestamp noise);
 *   - with a device that answers the in-order ping, frames beyond two unconfirmed
 *     ones are dropped as stale instead of queued;
 *   - video sources are captured with createImageBitmap (crop + downscale in the
 *     browser) when available, so the main thread only reads back w×h texels.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { installFakeDom } from "./fakeDom";

const dom = installFakeDom();

import { button, camera, fxb, rig, settle, stats, type Rig } from "./videoPanelRig";
import type { TextureSink } from "../src/effects/editor/videoTexture";
import type { SetTextureMessage } from "../src/net/proto";

let rigs: Rig[] = [];
let now = 1000;
const g = globalThis as Record<string, unknown>;

beforeEach(() => camera.install());
afterEach(() => {
  for (const r of rigs) {
    r.panel.dispose();
    r.panel.node.remove();
  }
  rigs = [];
  dom.flushAnimationFrames();
  camera.restore();
  delete g["createImageBitmap"];
});

async function streaming(sink: TextureSink, fps = 30): Promise<Rig> {
  const r = rig();
  rigs.push(r);
  r.panel.setBytecode(fxb([{ kind: 1, w: 16, h: 8 }]));
  r.panel.setSink(sink);
  (r.panel as unknown as { fps: number }).fps = fps; // the Frame rate select's state
  button(r.panel.node, "Use camera").click();
  await settle();
  button(r.panel.node, "Start streaming").click();
  return r;
}

test("30 fps on a 60 Hz display sends on every other vsync, without flip-flopping", async () => {
  const msgs: SetTextureMessage[] = [];
  await streaming({ isConnected: true, setTexture: (m) => (msgs.push(m), true) });
  // Vsync timestamps with sub-ms noise either side of 16.667 ms.
  const sent: number[] = [];
  for (let i = 1; i <= 60; i++) {
    now += 16.6667 + (i % 2 ? 0.004 : -0.004);
    const before = msgs.length;
    dom.flushAnimationFrames(now);
    if (msgs.length > before) sent.push(now);
  }
  const gaps = sent.slice(1).map((t, i) => t - sent[i]!);
  assert.ok(gaps.length >= 28, `~30 sends, got ${sent.length}`);
  for (const gap of gaps) assert.ok(Math.abs(gap - 33.33) < 1, `gap ${gap.toFixed(2)} ms`);
});

test("a device that confirms slowly gets the newest frame, not a backlog", async () => {
  const msgs: SetTextureMessage[] = [];
  const pongs: (() => void)[] = [];
  const sink: TextureSink = {
    isConnected: true,
    setTexture: (m) => (msgs.push(m), true),
    ping: () => new Promise((resolve) => pongs.push(() => resolve(5))),
  };
  const r = await streaming(sink);
  for (let i = 0; i < 10; i++) dom.flushAnimationFrames((now += 33.34));
  assert.equal(msgs.length, 2, "two unconfirmed frames, then the device must catch up");
  pongs.shift()!();
  await settle();
  assert.equal(msgs.length, 3, "one confirmation lets exactly the newest frame through");
  assert.match(stats(r), /dropped/);
});

test("video frames are cropped + downscaled by createImageBitmap when available", async () => {
  const calls: unknown[][] = [];
  g["createImageBitmap"] = async (...a: unknown[]) => {
    calls.push(a);
    return { width: 16, height: 8, close() {} };
  };
  const msgs: SetTextureMessage[] = [];
  const r = await streaming({ isConnected: true, setTexture: (m) => (msgs.push(m), true) });
  dom.flushAnimationFrames((now += 40));
  assert.equal(msgs.length, 0, "the frame lands once the bitmap resolves");
  await settle();
  assert.equal(msgs.length, 1);
  // 320×240 camera cover-fitted to 16×8: crop the centre 320×160 rows 40..200.
  const [el, sx, sy, sw, sh, opts] = calls[0]!;
  assert.equal(el, r.video);
  assert.deepEqual([sx, sy, sw, sh], [0, 40, 320, 160]);
  assert.deepEqual(opts, { resizeWidth: 16, resizeHeight: 8, resizeQuality: "low" });
  // The canvas only ever reads back the texture size.
  assert.deepEqual(r.reads.at(-1), [16, 8]);
  assert.equal(r.draws.at(-1)!.length, 3, "drawImage(bitmap, 0, 0)");
});
