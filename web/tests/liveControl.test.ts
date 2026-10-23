/**
 * The real-time control channel (docs/design/live-control.md): latest-wins,
 * one-in-flight pacing (LatestWinsSender), the LiveControl message shapes (seq /
 * ControlAck, legacy replies, commit-on-idle), the client wiring, and a
 * discrete-event model of a slow device showing the backlog stays bounded.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ServerMessage } from "@ledmapper/protocol";
import { LatestWinsSender } from "../src/net/liveSender";
import { LiveControl, type LiveHost } from "../src/net/liveControl";
import { LedMapperClient, type SocketLike } from "../src/net/client";
import { decodeClient, encodeServer } from "../src/net/proto";

type Msg = { type: string } & Record<string, unknown>;

/** A virtual clock + timer queue (deterministic; run(ms) advances time). */
class Clock {
  t = 0;
  private q: Array<{ at: number; fn: () => void; id: number }> = [];
  private nextId = 0;
  now = (): number => this.t;
  schedule = (fn: () => void, ms: number): void => {
    this.q.push({ at: this.t + Math.max(0, ms), fn, id: this.nextId++ });
  };
  /** Run every timer due up to t+ms, in time order. */
  run(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      this.q.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.q[0];
      if (!next || next.at > end) break;
      this.q.shift();
      this.t = next.at;
      next.fn();
    }
    this.t = end;
  }
}

/** Let promise continuations (ack resolution) run. */
const flush = () => new Promise<void>((r) => setImmediate(r));

// -- LatestWinsSender ---------------------------------------------------------

test("LatestWinsSender: one batch in flight, latest value wins, final value delivered", async () => {
  const clk = new Clock();
  const batches: Array<Map<string, number>> = [];
  let ack: (() => void) | null = null;
  const s = new LatestWinsSender<string, number>(
    (b) => {
      batches.push(b);
      return new Promise<void>((r) => (ack = r));
    },
    { now: clk.now, schedule: clk.schedule, ackTimeoutMs: 1000 },
  );
  s.push("a", 1);
  assert.equal(batches.length, 1, "the first push goes out at once");
  for (let v = 2; v <= 50; v++) s.push("a", v);
  s.push("b", 7);
  assert.equal(batches.length, 1, "nothing else while the batch is unacknowledged");
  ack!();
  await flush();
  assert.equal(batches.length, 2);
  assert.deepEqual([...batches[1]!], [["a", 50], ["b", 7]], "only the latest value per key");
  assert.equal(s.stats.coalesced, 48);
});

test("LatestWinsSender: an unanswered batch times out, then the next goes", () => {
  const clk = new Clock();
  let n = 0;
  const s = new LatestWinsSender<string, number>(() => (n++, new Promise<void>(() => undefined)), {
    now: clk.now,
    schedule: clk.schedule,
    ackTimeoutMs: 300,
  });
  s.push("a", 1);
  s.push("a", 2);
  clk.run(299);
  assert.equal(n, 1);
  clk.run(1);
  assert.equal(n, 2, "the deadline releases the pending value");
  assert.equal(s.stats.timeouts, 1);
});

test("LatestWinsSender: rate cap and transport gate hold the batch", async () => {
  const clk = new Clock();
  let gate = true;
  const sent: number[] = [];
  const s = new LatestWinsSender<string, number>((b) => (sent.push(b.get("a")!), Promise.resolve()), {
    now: clk.now,
    schedule: clk.schedule,
    minIntervalMs: () => 25,
    canSend: () => gate,
  });
  s.push("a", 1);
  await flush();
  s.push("a", 2);
  await flush();
  assert.deepEqual(sent, [1], "the second waits out the 25 ms interval");
  clk.run(25);
  assert.deepEqual(sent, [1, 2]);
  await flush();
  gate = false;
  clk.run(30);
  s.push("a", 3);
  clk.run(100);
  assert.deepEqual(sent, [1, 2], "held while the transport is busy");
  gate = true;
  clk.run(10);
  assert.deepEqual(sent, [1, 2, 3]);
  await flush();
  await s.settled();
});

// -- LiveControl --------------------------------------------------------------

function fakeHost(features: string[]) {
  const sent: Msg[] = [];
  const host: LiveHost & { open: boolean; buffered: number } = {
    open: true,
    buffered: 0,
    sendFlat: (m) => {
      if (!host.open) return false;
      sent.push(JSON.parse(JSON.stringify(m)) as Msg);
      return true;
    },
    features: () => features,
    renderFps: () => 40,
    bufferedAmount: () => host.buffered,
  };
  return { host, sent };
}

test("LiveControl: seq'd set_uniforms paced on ControlAck, merged per slot", async () => {
  const clk = new Clock();
  const { host, sent } = fakeHost(["control_ack", "uniform_commit"]);
  const live = new LiveControl(host, { now: clk.now, schedule: clk.schedule });
  live.setUniform(0, [0.1]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.type, "set_uniforms");
  assert.equal(sent[0]!.commit, false, "a moving value is not persisted");
  const seq = sent[0]!.seq as number;
  assert.ok(seq > 0);
  for (let i = 0; i < 100; i++) {
    live.setUniform(0, [i / 100]);
    live.setUniform(1, [1 - i / 100]);
  }
  clk.run(100);
  assert.equal(sent.length, 1, "one update in flight");
  // A legacy-looking reply does not release a seq'd batch; the matching ack does.
  live.onServerMessage({ type: "control_ack", seq: seq + 99 });
  clk.run(1);
  assert.equal(sent.length, 1);
  assert.equal(live.onServerMessage({ type: "control_ack", seq }), true, "acks are consumed");
  await flush();
  clk.run(25);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1]!.values, [
    { slot: 0, value: [0.99] },
    { slot: 1, value: [1 - 0.99] },
  ]);
});

test("LiveControl: maxInFlight pipelines seq'd batches; acks release them in any order", async () => {
  const clk = new Clock();
  const { host, sent } = fakeHost(["control_ack", "uniform_commit"]);
  const live = new LiveControl(host, { now: clk.now, schedule: clk.schedule, maxInFlight: 2 });
  live.setUniform(0, [0.1]);
  clk.run(25);
  live.setUniform(0, [0.2]);
  clk.run(25);
  assert.equal(sent.length, 2, "a second batch goes before the first is acked");
  live.setUniform(0, [0.3]);
  clk.run(100);
  assert.equal(sent.length, 2, "never more than maxInFlight unacknowledged");
  // The second batch's ack frees a slot even while the first is still out.
  live.onServerMessage({ type: "control_ack", seq: sent[1]!.seq as number });
  await flush();
  clk.run(1);
  assert.equal(sent.length, 3);
  assert.deepEqual(sent[2]!.values, [{ slot: 0, value: [0.3] }]);
  live.onServerMessage({ type: "control_ack", seq: sent[0]!.seq as number });
  live.onServerMessage({ type: "control_ack", seq: sent[2]!.seq as number });
  await flush();
  await live.settled();
});

test("LiveControl: legacy firmware keeps one batch in flight whatever maxInFlight says", async () => {
  const clk = new Clock();
  const { host, sent } = fakeHost(["uniform_commit"]);
  const live = new LiveControl(host, { now: clk.now, schedule: clk.schedule, maxInFlight: 3 });
  live.setUniform(0, [0.1]);
  clk.run(25);
  live.setUniform(0, [0.2]);
  clk.run(100);
  assert.equal(sent.length, 1, "legacy replies don't name their batch");
  live.onServerMessage({ type: "playback_state" });
  await flush();
  clk.run(1);
  assert.equal(sent.length, 2);
});

test("LiveControl: one batch in flight by default, live_mailbox or not", async () => {
  for (const [feats, want] of [
    [["control_ack", "uniform_commit", "live_mailbox"], 1],
    [["control_ack", "uniform_commit"], 1],
  ] as const) {
    const clk = new Clock();
    const { host, sent } = fakeHost([...feats]);
    const live = new LiveControl(host, { now: clk.now, schedule: clk.schedule });
    for (let i = 0; i < 4; i++) {
      live.setUniform(0, [i / 10]);
      clk.run(25);
    }
    assert.equal(sent.length, want, `${feats.join(",")}: ${want} unacknowledged`);
  }
});

test("LiveControl: the ack timeout adapts to 3x the median round trip (25..400 ms)", async () => {
  const clk = new Clock();
  const { host, sent } = fakeHost(["control_ack", "uniform_commit"]);
  const live = new LiveControl(host, { now: clk.now, schedule: clk.schedule });
  // Five batches answered after 4 ms each.
  for (let i = 0; i < 5; i++) {
    live.setUniform(0, [i / 10]);
    clk.run(4);
    live.onServerMessage({ type: "control_ack", seq: sent[sent.length - 1]!.seq as number });
    await flush();
    clk.run(30);
  }
  assert.equal(sent.length, 5);
  // The sixth batch's ack is lost: the next goes after max(25, 3 x 4) = 25 ms, not 400.
  live.setUniform(0, [0.9]);
  assert.equal(sent.length, 6);
  live.setUniform(0, [0.95]);
  clk.run(24);
  assert.equal(sent.length, 6, "still waiting inside the adaptive timeout");
  clk.run(2);
  await flush();
  clk.run(1);
  assert.equal(sent.length, 7, "the lost ack cost ~25 ms");
  assert.deepEqual(sent[6]!.values, [{ slot: 0, value: [0.95] }]);
});

test("LiveControl: one commit:true with every touched slot once idle", async () => {
  const clk = new Clock();
  const { host, sent } = fakeHost(["control_ack", "uniform_commit"]);
  const live = new LiveControl(host, { now: clk.now, schedule: clk.schedule, commitIdleMs: 600 });
  const ackAll = async () => {
    for (const m of sent) live.onServerMessage({ type: "control_ack", seq: m.seq });
    await flush();
  };
  live.setUniform(0, [0.5]);
  await ackAll();
  clk.run(300);
  live.setUniform(2, [0.25]);
  await ackAll();
  clk.run(599);
  await ackAll();
  assert.ok(sent.every((m) => m.commit === false), "nothing committed while moving");
  clk.run(1);
  await ackAll();
  clk.run(50);
  const commits = sent.filter((m) => m.commit === true);
  assert.equal(commits.length, 1, "exactly one commit");
  assert.deepEqual(commits[0]!.values, [
    { slot: 0, value: [0.5] },
    { slot: 2, value: [0.25] },
  ]);
  // Deck B is never persisted: no commit for it.
  live.setUniform(0, [0.9], 1);
  await ackAll();
  clk.run(2000);
  await ackAll();
  assert.equal(sent.filter((m) => m.commit === true).length, 1);
});

test("LiveControl: legacy firmware — no seq, paced on playback_state / welcome", async () => {
  const clk = new Clock();
  const { host, sent } = fakeHost([]);
  const live = new LiveControl(host, { now: clk.now, schedule: clk.schedule });
  live.setUniform(3, [0.2]);
  live.setCrossfade(0.4);
  live.setCrossfade(0.6, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.seq, undefined);
  assert.equal(sent[0]!.commit, undefined, "no commit field without uniform_commit");
  assert.equal(live.onServerMessage({ type: "playback_state" }), false, "legacy replies are not consumed");
  await flush();
  clk.run(25);
  assert.equal(sent.length, 2);
  assert.deepEqual([sent[1]!.type, sent[1]!.position, sent[1]!.mode], ["set_crossfade", 0.6, 1]);
  live.onServerMessage({ type: "welcome" });
  await flush();
  await live.settled();
});

test("LiveControl: an effect change discards pending moves for that deck", async () => {
  const clk = new Clock();
  const { host, sent } = fakeHost(["control_ack"]);
  const live = new LiveControl(host, { now: clk.now, schedule: clk.schedule });
  live.setUniform(0, [0.1]);
  live.setUniform(0, [0.2]);
  live.setUniform(0, [0.3], 1);
  live.resetDeck(0);
  live.onServerMessage({ type: "control_ack", seq: sent[0]!.seq });
  await flush();
  clk.run(50);
  assert.equal(sent.length, 2);
  assert.equal(sent[1]!.deck, 1, "only deck B's move survives");
});

// -- client wiring ----------------------------------------------------------

class FakeSocket implements SocketLike {
  readyState = 0;
  binaryType?: string;
  bufferedAmount = 0;
  sent: Uint8Array[] = [];
  onopen: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(msg: unknown): void {
    this.onmessage?.({ data: encodeServer(msg as ServerMessage) });
  }
  send(data: string | Uint8Array): void {
    this.sent.push(data as Uint8Array);
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  msgs(): Msg[] {
    return this.sent.map((s) => decodeClient(s) as unknown as Msg);
  }
}

test("client.live: wire round trip with seq + control_ack", async () => {
  const clk = new Clock();
  const socks: FakeSocket[] = [];
  const client = new LedMapperClient("ws://test/ws", {
    socketFactory: () => {
      const s = new FakeSocket();
      socks.push(s);
      return s;
    },
    now: clk.now,
    schedule: clk.schedule,
  });
  void client.connect();
  const s = socks[0]!;
  s.open();
  s.receive({
    type: "welcome",
    sessionId: "s",
    codeParams: { ledCount: 8, bits: 3, encoding: "hue", symbols: 2, bitPeriodMs: 100, syncPattern: "on_off", cycleFrames: 8 },
    solverBenchMs: null,
    features: ["control_ack", "uniform_commit", "decks"],
  });
  for (let i = 0; i <= 20; i++) client.live.setUniform(4, [i / 20]);
  let ups = s.msgs().filter((m) => m.type === "set_uniforms");
  assert.equal(ups.length, 1);
  assert.ok((ups[0]!.seq as number) > 0, "seq rides the wire");
  s.receive({ type: "control_ack", seq: ups[0]!.seq });
  await flush();
  clk.run(30);
  ups = s.msgs().filter((m) => m.type === "set_uniforms");
  assert.equal(ups.length, 2);
  assert.deepEqual(ups[1]!.values, [{ slot: 4, value: [1] }]);
  // Crossfade through the same channel.
  s.receive({ type: "control_ack", seq: ups[1]!.seq });
  await flush();
  clk.run(30);
  assert.equal(client.sendCrossfade(0.5), true);
  const xf = s.msgs().filter((m) => m.type === "set_crossfade");
  assert.equal(xf.length, 1);
  assert.ok((xf[0]!.seq as number) > 0);
});

// -- the backlog model ------------------------------------------------------

/**
 * A device that takes `serviceMs` per message, in order (TCP), with `rttMs/2`
 * each way. MIDI-like input: 4 controls x 100 Hz for `seconds`. Returns the input-to-
 * applied lag (ms) of the newest value, sampled every 100 ms.
 */
async function simulate(mode: "naive" | "live", serviceMs: number, rttMs: number, seconds = 30): Promise<number[]> {
  const clk = new Clock();
  const queue: Array<{ msg: Msg; arrive: number }> = [];
  let busyUntil = 0;
  const applied = new Map<number, { v: number }>();
  const genAt = new Map<number, number>(); // value -> time generated
  let live: LiveControl | null = null;
  const deliverReply = (m: Msg, at: number) =>
    clk.schedule(() => {
      live?.onServerMessage(m.seq ? { type: "control_ack", seq: m.seq } : { type: "playback_state" });
    }, at - clk.t);
  const process = () => {
    while (queue.length && queue[0]!.arrive <= clk.t) {
      const { msg, arrive } = queue.shift()!;
      const start = Math.max(busyUntil, arrive);
      busyUntil = start + serviceMs;
      const done = busyUntil;
      clk.schedule(() => {
        for (const v of msg.values as Array<{ slot: number; value: number[] }>) applied.set(v.slot, { v: v.value[0]! });
      }, done - clk.t);
      deliverReply(msg, done + rttMs / 2);
    }
  };
  const wire = (m: Msg) => {
    queue.push({ msg: m, arrive: clk.t + rttMs / 2 });
    clk.schedule(process, rttMs / 2);
    return true;
  };
  const host: LiveHost = {
    sendFlat: (m) => wire(JSON.parse(JSON.stringify(m)) as Msg),
    features: () => ["control_ack", "uniform_commit"],
    renderFps: () => 40,
    bufferedAmount: () => 0,
  };
  live = new LiveControl(host, { now: clk.now, schedule: clk.schedule });
  let counter = 0;
  const lags: number[] = [];
  for (let t = 0; t < seconds * 1000; t += 2.5) {
    clk.run(2.5);
    const slot = Math.round(t / 2.5) % 4;
    const v = slot === 0 ? ++counter : Math.random();
    if (slot === 0) genAt.set(v, clk.t);
    const values = [{ slot, value: [v] }];
    if (mode === "naive") wire({ type: "set_uniforms", values });
    else live.setUniforms(values);
    await flush();
    if (Math.round(t) % 100 === 0) {
      const cur = applied.get(0)?.v ?? 0;
      // Lag = how long the newest value NOT yet applied has been waiting.
      const nextAt = genAt.get(cur + 1);
      lags.push(nextAt === undefined ? 0 : clk.t - nextAt);
    }
  }
  return lags;
}

function pct(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
}

test("backlog model: naive per-event sends fall behind; the live channel stays bounded", async () => {
  // A heavy effect leaves the C6 ~8 ms per message (125 msg/s) — less than the
  // 400 msg/s a 4-knob MIDI stream produces.
  const naive = await simulate("naive", 8, 20);
  const liveLags = await simulate("live", 8, 20);
  // First vs last 10 s (samples every 100 ms).
  const minute = (xs: number[], last: boolean) => (last ? xs.slice(-100) : xs.slice(5, 105));
  assert.ok(pct(minute(naive, true), 50) > 5_000, `naive lag grows to seconds (${pct(minute(naive, true), 50)} ms)`);
  const p99 = pct(liveLags, 99);
  assert.ok(p99 < 100, `live p99 lag ${p99} ms`);
  assert.ok(
    pct(minute(liveLags, true), 50) <= pct(minute(liveLags, false), 50) + 10,
    "live lag does not grow over time",
  );
});
