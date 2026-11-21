/**
 * P4 demo page: the OSC streamer (osc.OscStreamer's rules: ≤120 Hz, latest value
 * wins, keep-alives, due values share a bundle) on a fake clock.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { decode } from "../src/p4demo/osc";
import { OscStreamer } from "../src/p4demo/streamer";

function rig(opts: { maxHz?: number; keepaliveHz?: number } = {}) {
  const sent: { t: number; msgs: { address: string; args: (number | string)[] }[] }[] = [];
  let now = 100;
  const st = new OscStreamer((p) => sent.push({ t: now, msgs: decode(p) }), { ...opts, clock: () => now });
  return {
    st,
    sent,
    at: (t: number) => {
      now = t;
      return st.step(t);
    },
  };
}

test("a changed value goes out at once, then at most maxHz (latest wins)", () => {
  const { st, sent, at } = rig({ maxHz: 120 });
  st.set("/plane", [0, 0, 1, 1]);
  assert.equal(at(100), 1);
  st.set("/plane", [0, 0, 1, 1.1]);
  st.set("/plane", [0, 0, 1, 1.2]);
  assert.equal(at(100.004), 0, "inside 1/120 s: held");
  assert.equal(at(100.009), 1);
  assert.equal(sent.length, 2);
  assert.ok(Math.abs((sent[1]!.msgs[0]!.args[3] as number) - 1.2) < 1e-6, "the latest value");
});

test("never more than 120 datagrams a second under a flood", () => {
  const { st, sent, at } = rig();
  for (let i = 0; i < 1000; i++) {
    st.set("/plane", [0, 0, 1, i]);
    at(100 + i * 0.001); // 1 kHz of changes for 1 s
  }
  assert.ok(sent.length <= 121, `${sent.length} sends`);
  assert.ok(sent.length >= 110, `${sent.length} sends`);
});

test("rejects a cap above 120 Hz", () => {
  assert.throws(() => new OscStreamer(() => {}, { maxHz: 240 }));
});

test("an unchanged value is not re-sent until its keep-alive", () => {
  const { st, sent, at } = rig({ keepaliveHz: 10 });
  st.set("/plane", [0, 0, 1, 1]);
  at(100);
  st.set("/plane", [0, 0, 1, 1]); // same value: not dirty
  assert.equal(at(100.05), 0);
  assert.equal(at(100.1), 1, "keep-alive at 10 Hz");
  assert.equal(sent.length, 2);
});

test("settings keep their own 1 s keep-alive and ride along with the shape", () => {
  const { st, sent, at } = rig({ keepaliveHz: 10 });
  st.set("/plane", [0, 0, 1, 1]);
  st.set("/width", [0.01], { keepalive: 1 });
  at(100);
  assert.deepEqual(sent[0]!.msgs.map((m) => m.address).sort(), ["/plane", "/width"], "both due: one bundle");
  // Keep-alives of the shape alone for the next ~0.9 s.
  for (let k = 1; k <= 8; k++) assert.equal(at(100 + k * 0.11), 1);
  assert.ok(sent.slice(1).every((s) => s.msgs.length === 1 && s.msgs[0]!.address === "/plane"));
  // /width is due at 101.0; within one shape period of that, it rides along.
  assert.equal(at(100.99), 1);
  assert.deepEqual(sent[sent.length - 1]!.msgs.map((m) => m.address).sort(), ["/plane", "/width"]);
});

test("clear stops an address; resend sends everything again", () => {
  const { st, sent, at } = rig();
  st.set("/plane", [0, 0, 1, 1]);
  st.set("/pick", [-1], { keepalive: 1 });
  at(100);
  st.clear("/plane");
  assert.equal(st.has("/plane"), false);
  st.resend();
  at(100.01);
  assert.deepEqual(sent[1]!.msgs.map((m) => m.address), ["/pick"]);
});

test("nextDelay: due keep-alive, or the cap when something changed", () => {
  const { st, at } = rig({ keepaliveHz: 10 });
  st.set("/plane", [1, 0, 0, 0]);
  at(100);
  assert.ok(Math.abs(st.nextDelay(100) - 0.1) < 1e-9);
  st.set("/plane", [1, 0, 0, 1]);
  assert.ok(Math.abs(st.nextDelay(100.002) - (1 / 120 - 0.002)) < 1e-9);
});

test("timer loop: start() sends via the injected scheduler", () => {
  const queue: { fn: () => void; ms: number }[] = [];
  let now = 0;
  const out: number[] = [];
  const st = new OscStreamer(() => out.push(now), {
    clock: () => now,
    schedule: (fn, ms) => {
      const h = { fn, ms };
      queue.push(h);
      return h;
    },
    cancel: (h) => {
      const i = queue.indexOf(h as { fn: () => void; ms: number });
      if (i >= 0) queue.splice(i, 1);
    },
  }).start();
  st.set("/glow", [1, 0.4, 0.1], { keepalive: 1 });
  // Run timers in order for 3 s of fake time.
  while (now < 3 && queue.length) {
    const h = queue.shift()!;
    now += h.ms / 1000;
    h.fn();
  }
  st.stop();
  assert.ok(out.length >= 3 && out.length <= 5, `${out.length} sends in 3 s at a 1 s keep-alive`);
});
