/**
 * Show Mode's timed crossfade (src/effects/crossfadeGlide.ts): on firmware with
 * "ramps" ONE ramp_crossfade and no set_crossfade stream; on older firmware the
 * stepped fallback at <= 25 Hz that still lands exactly; a takeover stops it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { CrossfadeGlide, supportsRamps, type GlideClient } from "../src/effects/crossfadeGlide";
import { rampEaseAt, rampEaseWire, RAMP_EASES, type RampStateMessage } from "../src/net/proto";

function harness(features: string[], refuse = false) {
  let now = 0;
  const frames: (() => void)[] = [];
  const ramps: { position: number; durationMs: number; opts: unknown }[] = [];
  const sends: number[] = [];
  const shown: [number, boolean][] = [];
  const client: GlideClient = {
    isConnected: true,
    welcome: { features },
    rampCrossfade: async (position, durationMs, opts) => {
      if (refuse) throw new Error("bad_ramp");
      ramps.push({ position, durationMs, opts });
      return { type: "ramp_state", id: 0, state: 0, kind: 1, startAtMs: 0, endAtMs: durationMs, active: 1 } as RampStateMessage;
    },
    sendCrossfade: (p) => {
      sends.push(p);
      return true;
    },
  };
  const glide = new CrossfadeGlide({
    show: (p, f) => shown.push([p, f]),
    now: () => now,
    frame: (cb) => frames.push(cb),
    cancelFrame: () => frames.splice(0),
  });
  /** Advance the clock in 16 ms frames until `ms`. */
  const run = (ms: number) => {
    while (now < ms && frames.length) {
      now += 16;
      frames.shift()!();
    }
  };
  return { glide, client, ramps, sends, shown, run, frames };
}

test("eases: wire values and reference curves", () => {
  assert.deepEqual(RAMP_EASES.map(rampEaseWire), [0, 1, 2, 3, 4]);
  for (const e of RAMP_EASES) {
    assert.equal(rampEaseAt(e, 0), 0);
    assert.equal(rampEaseAt(e, 1), 1);
  }
  assert.equal(rampEaseAt("ease", 0.5), 0.5);
  assert.equal(rampEaseAt("ease_in", 0.5), 0.125);
  assert.equal(rampEaseAt("ease_out", 0.5), 0.875);
  assert.equal(supportsRamps({ features: ["ramps"] }), true);
  assert.equal(supportsRamps(null), false);
});

test("ramps firmware: one device request, the fader only animates", async () => {
  const h = harness(["decks", "crossfade", "ramps"]);
  assert.equal(await h.glide.start(h.client, 0, 1, 2, { mode: 1 }), "device");
  assert.equal(h.ramps.length, 1);
  assert.deepEqual(h.ramps[0], { position: 1, durationMs: 2000, opts: { mode: 1, ease: 1 } });
  h.run(5000);
  assert.equal(h.sends.length, 0, "nothing on the wire while the device ramps");
  assert.deepEqual(h.shown.at(-1), [1, true]);
  assert.equal(h.glide.running, false);
});

test("older firmware: stepped set_crossfade at <= 25 Hz, landing exactly", async () => {
  const h = harness(["decks", "crossfade"]);
  assert.equal(await h.glide.start(h.client, 1, 0, 1), "stepped");
  h.run(3000);
  assert.ok(h.sends.length >= 20 && h.sends.length <= 27, `${h.sends.length} steps`);
  assert.equal(h.sends.at(-1), 0);
  for (let i = 1; i < h.sends.length; i++) assert.ok(h.sends[i]! <= h.sends[i - 1]!, "monotonic");
  // A refused ramp falls back to stepping too.
  const r = harness(["ramps"], true);
  assert.equal(await r.glide.start(r.client, 0, 1, 0.5), "stepped");
  r.run(2000);
  assert.equal(r.sends.at(-1), 1);
});

test("a fader move takes over at once", async () => {
  const h = harness(["decks", "crossfade"]);
  await h.glide.start(h.client, 0, 1, 2);
  h.run(500);
  const n = h.sends.length;
  h.glide.stop();
  assert.equal(h.glide.running, false);
  h.run(5000);
  assert.equal(h.sends.length, n, "no more steps after the takeover");
  assert.ok(h.shown.at(-1)![0] < 0.5);
});
