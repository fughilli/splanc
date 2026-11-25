/**
 * The FX editor's Watch (D-541 PR 11; host preview only, D-550): decoding the
 * watch build's raw words, re-finding watched text after an edit, the history
 * ring, the watch session's lockstep run + pause / step / scrub replay (on a
 * fake VM with state, a per-LED buffer and a uniform), and the Watch pane:
 * "selection is not an expression", values, remove, pause / step.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { asFake, installFakeDom, textOf } from "./fakeDom";

installFakeDom();

import {
  WatchHistory,
  WatchSession,
  decodeWord,
  formatValue,
  ledSummary,
  plotRange,
  readWatch,
  relocate,
  watchRanges,
  type WatchInfo,
  type WatchVm,
} from "../src/fx/watch";
import { installFxModules } from "../src/fx/preview";
import { WatchController, type WatchHost } from "../src/effects/editor/watch-panel";

const f32bits = (v: number): number => new Uint32Array(new Float32Array([v]).buffer)[0]!;

function info(p: Partial<WatchInfo>): WatchInfo {
  return {
    error: null,
    ty: "float",
    width: 1,
    decode: "f32",
    class: "frame",
    func: "update",
    store: "state",
    state_slot: 0,
    buffers: [],
    line: 1,
    col: 1,
    ...p,
  };
}

test("raw VM words decode per type", () => {
  assert.equal(decodeWord(f32bits(0.375), "f32"), 0.375);
  assert.equal(decodeWord(-7 >>> 0, "i32"), -7);
  assert.equal(decodeWord(0x18000, "q16"), 1.5);
  assert.equal(decodeWord(-32 >>> 0, "q6"), -0.5);
  assert.equal(decodeWord(1 << 13, "q14"), 0.5);
  assert.equal(decodeWord(f32bits(1), "bool"), 1);
  assert.equal(decodeWord(f32bits(-0), "bool"), 0);
  assert.equal(decodeWord(200, "u8"), 200);
});

test("values format for their type", () => {
  assert.equal(formatValue("float", [0.123456]), "0.1235");
  assert.equal(formatValue("int", [42]), "42");
  assert.equal(formatValue("bool", [1]), "true");
  assert.equal(formatValue("vec3", [1, 0.5, -0.25]), "(1, 0.5, -0.25)");
  assert.equal(formatValue("mat3", [1, 0, 0, 0, 1, 0, 0, 0, 1]), "(1, 0, 0) (0, 1, 0) (0, 0, 1)");
  assert.equal(formatValue("float", []), "–");
});

test("a watch is re-found after an edit, or dropped when its text is gone", () => {
  const w = { text: "sin(time)", start: 10, end: 19 };
  const src = "float a = sin(time) * 2.0;";
  assert.deepEqual(relocate(src, w), { start: 10, end: 19 });
  // Text inserted before it: the nearest occurrence.
  assert.deepEqual(relocate("// hi\n" + src, w), { start: 16, end: 25 });
  const two = "x = sin(time); y = sin(time);";
  assert.deepEqual(relocate(two, { text: "sin(time)", start: 18, end: 27 }), { start: 19, end: 28 });
  assert.equal(relocate("float a = cos(time);", w), null);
  assert.deepEqual([...watchRanges([{ start: 1, end: 4 }, { start: 7, end: 9 }])], [1, 4, 7, 9]);
});

test("per-frame and per-LED values read back from state and buffers", () => {
  const state = new Uint32Array(8);
  state[2] = f32bits(0.5);
  state[3] = f32bits(-1);
  const v = readWatch(info({ ty: "vec2", width: 2, state_slot: 2 }), { state, buffer: () => new Uint8Array(0) }, 3);
  assert.deepEqual(v.frame, [0.5, -1]);
  // A vec2 per LED in one buffer (2 words per LED), 3 LEDs.
  const buf = new Uint8Array(3 * 2 * 4);
  const dv = new DataView(buf.buffer);
  for (let i = 0; i < 3; i++) {
    dv.setUint32(i * 8, f32bits(i), true);
    dv.setUint32(i * 8 + 4, f32bits(i * 10), true);
  }
  const l = readWatch(info({ ty: "vec2", width: 2, store: "led", buffers: [4] }), { state, buffer: (id) => (id === 4 ? buf : new Uint8Array(0)) }, 3);
  assert.deepEqual([...l.leds!], [0, 0, 1, 10, 2, 20]);
  assert.deepEqual(ledSummary(l.leds!, 2, 1), { value: [1, 10], min: [0, 0], max: [2, 20] });
  // An error watch reads nothing.
  assert.deepEqual(readWatch(info({ error: "x" }), { state, buffer: () => buf }, 3), { frame: null, leds: null });
});

test("the history ring keeps the newest frames in order", () => {
  const h = new WatchHistory(3);
  for (let f = 0; f < 5; f++) h.push({ frame: f, time: f / 60, values: [[f]], min: [null], max: [null] });
  assert.equal(h.length, 3);
  assert.deepEqual([0, 1, 2].map((i) => h.at(i)?.frame), [2, 3, 4]);
  assert.equal(h.find(3)?.frame, 3);
  assert.equal(h.find(1), undefined);
  const r = plotRange(h, 0);
  assert.ok(r.lo < 2 && r.hi > 4);
  h.clear();
  assert.equal(h.length, 0);
});

/**
 * A fake watch-build VM: update() does `state[0] += dt * u0`, shade() writes
 * `state[0] + idx` into per-LED buffer 0 and colours LED i with frame % 256.
 * state[1] is a watch slot (the program never reads it).
 */
class FakeVm implements WatchVm {
  st = new Float32Array(4);
  u = [1];
  buf = new Float32Array(0);
  frameNo = 0;
  setUniform(slot: number, vals: number[]): void {
    this.u[slot] = vals[0] ?? 0;
  }
  tick(_time: number, dt: number, frame: number, ledCount: number): void {
    this.frameNo = frame;
    this.st[0] = (this.st[0] ?? 0) + dt * (this.u[0] ?? 0);
    this.st[1] = this.st[0] ?? 0;
    if (this.buf.length !== ledCount) {
      const b = new Float32Array(ledCount);
      b.set(this.buf.subarray(0, ledCount));
      this.buf = b;
    }
  }
  shadeAll(positions: Float32Array): Uint8Array {
    const n = positions.length / 3;
    for (let i = 0; i < n; i++) this.buf[i] = (this.st[0] ?? 0) + i;
    return new Uint8Array(n * 3).fill(this.frameNo % 256);
  }
  state(): Uint32Array {
    return new Uint32Array(this.st.slice().buffer);
  }
  setState(words: Uint32Array): void {
    this.st = new Float32Array(new Uint32Array(words.slice(0, 4)).buffer);
    if (this.st.length < 4) {
      const s = new Float32Array(4);
      s.set(this.st);
      this.st = s;
    }
  }
  arena(): Uint8Array {
    return new Uint8Array(this.buf.slice().buffer);
  }
  setArena(bytes: Uint8Array): void {
    this.buf = new Float32Array(bytes.slice().buffer);
  }
  buffer(_id: number, ledCount: number): Uint8Array {
    return new Uint8Array(this.buf.slice(0, ledCount).buffer);
  }
}

const WATCHES = [info({ state_slot: 1 }), info({ store: "led", buffers: [0], class: "dynamic", func: "shade" })];
const POS = new Float32Array(3 * 4);

test("the session runs in lockstep and scrubs back exactly", () => {
  const vm = new FakeVm();
  const s = new WatchSession(vm, WATCHES, { maxFrames: 50, keyEvery: 8 });
  s.syncFrom({ state: new Uint32Array(4), arena: new Uint8Array(0) }, [[0, [1]]]);
  const seen: number[] = [];
  for (let f = 0; f < 40; f++) {
    if (f === 20) s.setUniform(0, [2]); // speed doubles from frame 20
    const out = s.frame(f / 10, 0.1, f, 4, POS);
    seen.push(out.values[0]!.frame![0]!);
    assert.ok(Math.abs(out.values[1]!.leds![3]! - (out.values[0]!.frame![0]! + 3)) < 1e-5);
  }
  assert.ok(s.atHead());
  // Back to frame 5 and 25 (after the uniform change): the same values.
  for (const f of [5, 25, 13, 39]) {
    const back = s.seek(f)!;
    assert.equal(back.frame, f);
    assert.ok(Math.abs(back.values[0]!.frame![0]! - seen[f]!) < 1e-5, `frame ${f}`);
    assert.equal(back.colors[0], f);
  }
  assert.equal(s.currentFrame(), 39);
  s.seek(10);
  assert.equal(s.atHead(), false);
  // The next live frame first returns to the head, then runs on.
  const next = s.frame(4.0, 0.1, 40, 4, POS);
  assert.ok(Math.abs(next.values[0]!.frame![0]! - (seen[39]! + 0.2)) < 1e-5);
  assert.ok(s.atHead());
});

test("the session log is bounded and keeps a keyframe at its start", () => {
  const vm = new FakeVm();
  const s = new WatchSession(vm, WATCHES, { maxFrames: 30, keyEvery: 10 });
  s.syncFrom({ state: new Uint32Array(4), arena: new Uint8Array(0) }, []);
  const seen: number[] = [];
  for (let f = 0; f < 200; f++) seen.push(s.frame(f, 0.1, f, 4, POS).values[0]!.frame![0]!);
  assert.ok(s.length >= 30 && s.length <= 40, `${s.length}`);
  const first = s.firstFrame()!;
  assert.ok(Math.abs(s.seek(first)!.values[0]!.frame![0]! - seen[first]!) < 1e-4);
});

test("syncing from the live preview clears the watch slots", () => {
  const vm = new FakeVm();
  const s = new WatchSession(vm, WATCHES);
  const live = new Uint32Array([f32bits(3), f32bits(99), 0, 0]);
  s.syncFrom({ state: live, arena: new Uint8Array(0) }, []);
  assert.equal(vm.st[0], 3, "the program's state comes from the live preview");
  assert.equal(vm.st[1], 0, "the watch slot starts clear");
});

// -- the pane -------------------------------------------------------------------

class FakePreviewWasm {
  vm = new FakeVm();
  set_uniform(slot: number, vals: Float32Array): void {
    this.vm.setUniform(slot, [...vals]);
  }
  set_topology(): void {}
  set_graph(): void {}
  set_texture(): void {}
  update(time: number, dt: number, frame: number, n: number): void {
    this.vm.tick(time, dt, frame, n);
  }
  shade_all(p: Float32Array): Uint8Array {
    return this.vm.shadeAll(p);
  }
  state(): Uint32Array {
    return this.vm.state();
  }
  set_state(w: Uint32Array): void {
    this.vm.setState(w);
  }
  arena(): Uint8Array {
    return this.vm.arena();
  }
  set_arena(b: Uint8Array): void {
    this.vm.setArena(b);
  }
  buffer(id: number, n: number): Uint8Array {
    return this.vm.buffer(id, n);
  }
  free(): void {}
}
installFxModules({ vm: { FxPreview: FakePreviewWasm as never } });

const SRC = "state float x;\nvoid update() { x = x + dt * speed; }\nvec3 shade(Led led) { return vec3(x + led.idx); }";

function host(log: string[]): WatchHost {
  return {
    compileWatch: async (src, ranges) => {
      const watches: WatchInfo[] = [];
      for (let i = 0; i < ranges.length; i += 2) {
        const text = src.slice(ranges[i], ranges[i + 1]);
        if (text === "x + dt * speed") watches.push(info({ state_slot: 1 }));
        else if (text === "x + led.idx") watches.push(info({ store: "led", buffers: [0], func: "shade", class: "dynamic" }));
        else watches.push(info({ error: "selection is not an expression" }));
      }
      return { result: { ok: true, bytecode: new Uint8Array([1]), uniforms: [], diagnostics: [] }, watches };
    },
    live: () => null,
    uniforms: () => [{ slot: 0, value: [1] }],
    topology: () => null,
    showColors: (c) => log.push(c ? `show ${c[0]}` : "show live"),
    stepLive: () => log.push("step"),
    pausedChanged: (p) => log.push(p ? "paused" : "resumed"),
    selectCode: (a, b) => log.push(`select ${a}-${b}`),
  };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

test("the pane adds expressions, rejects non-expressions, shows values", async () => {
  const log: string[] = [];
  const toasts: string[] = [];
  const w = new WatchController(host(log));
  document.body.append(w.node);
  w.compiled(SRC);
  await tick();
  assert.match(textOf(w.node), /Add to Watch/, "the empty hint says how to add one");

  // Not an expression: refused with the compiler's message, nothing added.
  const a = SRC.indexOf("dt * speed");
  const okBad = await w.add(SRC, a - 4, a + 2); // "x + dt"
  assert.equal(okBad, false);
  assert.equal(w.watches().length, 0);
  void toasts;

  // Two good ones (whitespace around the selection is ignored).
  const s1 = SRC.indexOf("x + dt * speed");
  assert.equal(await w.add(SRC, s1 - 1, s1 + "x + dt * speed".length), true);
  const s2 = SRC.indexOf("x + led.idx");
  assert.equal(await w.add(SRC, s2, s2 + "x + led.idx".length), true);
  await tick();
  assert.deepEqual(w.watches().map((x) => x.expr.text), ["x + dt * speed", "x + led.idx"]);
  const text = textOf(w.node);
  assert.match(text, /float/);
  assert.match(text, /Frame/);
  assert.match(text, /Dynamic/);
  assert.match(text, /shade\(\) · line 1/);

  // Frames: values appear (state watch + LED 2's per-LED value).
  for (let f = 0; f < 3; f++) w.liveFrame(f * 0.5, 0.5, f, 4, POS);
  const vals = asFake(w.node).querySelectorAll(".fxwatch-value").map((e) => textOf(e));
  assert.equal(vals[0], "1.5");
  assert.match(vals[1] ?? "", /^LED 0: 1.5 · all LEDs 1.5 … 4.5$/);

  // Pause + step: the editor is asked to step the live preview.
  w.setPaused(true);
  w.step();
  assert.deepEqual(log.slice(-2), ["paused", "step"]);
  // Scrub back to frame 0: the pane shows that frame's colours + values.
  w.seek(0);
  assert.equal(log[log.length - 1], "show 0");
  assert.equal(asFake(w.node).querySelectorAll(".fxwatch-value").map((e) => textOf(e))[0], "0.5");
  w.setPaused(false);
  assert.equal(log[log.length - 1], "resumed");

  // Remove one.
  const rm = asFake(w.node).querySelectorAll(".fxwatch-rm")[0]!;
  rm.click();
  await tick();
  assert.deepEqual(w.watches().map((x) => x.expr.text), ["x + led.idx"]);
  w.dispose();
});
