/**
 * FX debugger host side (src/fx/fxDebug.ts, docs/design/fx-debugger.md): the
 * new protocol arms round-trip the wire boundary; snapshot sections reassemble
 * from any chunk size over a single-flight link; the FX_LED_V1 / FX_FRAME_V1
 * layouts and the output stage match the firmware; and the replay/compare
 * logic classifies a divergence as ENGINE (device != host replay), INPUTS (the
 * preview's map / LED order differs from the device's) or OUTPUT STAGE
 * (brightness / LUT), against a fake device + a stub VM. The real VM's
 * bit-exactness is pinned by //firmware/player_app:fx_debug_test (device side)
 * and the agent's compare_with_preview test (wasm).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  compareWithPreview,
  decodeFrameCtx,
  decodeLedRecord,
  diffLedInputs,
  encodeLedRecord,
  FRAME_CTX_BYTES,
  FxDebugger,
  LED_CTX_BYTES,
  MAX_STATE,
  MAX_UNIFORM_SLOTS,
  outputStage,
  previewLedInputs,
  type FxDebugLink,
  type FxReplayWasm,
  type LedInputs,
  type ReplayVm,
} from "../src/fx/fxDebug";
import {
  decodeClient,
  decodeServer,
  encodeClient,
  encodeServer,
  FX_SECTION,
  type FxDebugMessage,
  type FxDebugStateFlat,
  type MappingBundle,
} from "../src/net/proto";
import type { ClientMessage, ServerMessage } from "@ledmapper/protocol";

const b64 = (b: Uint8Array): string => Buffer.from(b).toString("base64");

test("fx debugger arms round-trip the protobuf boundary", () => {
  const c = decodeClient(
    encodeClient({ type: "fx_debug_control", action: 3, frames: 2, dt: 0.025, holdMs: 5000 } as unknown as ClientMessage),
  ) as unknown as Record<string, unknown>;
  assert.equal(c["type"], "fx_debug_control");
  assert.equal(c["action"], "ACTION_STEP");
  assert.equal(c["frames"], 2);
  assert.equal(c["dt"], Math.fround(0.025));
  const g = decodeClient(
    encodeClient({ type: "get_fx_snapshot", section: FX_SECTION.ledContext, deck: 1, offset: 88, maxLen: 440 } as unknown as ClientMessage),
  ) as unknown as Record<string, unknown>;
  assert.deepEqual([g["section"], g["deck"], g["offset"], g["maxLen"]], ["SECTION_LED_CONTEXT", 1, 88, 440]);

  const ctx = new Uint8Array(FRAME_CTX_BYTES).map((_, i) => i);
  const reply = decodeServer(
    encodeServer({
      type: "fx_debug",
      state: { paused: true, frame: 7, time: 1.5, colorOrder: b64(Uint8Array.from([1, 0, 2, 2, 0, 1])), frameCtx: b64(ctx), decks: [{ deck: 0, effectId: "e", renders: true }] },
    } as unknown as ServerMessage),
  ) as unknown as FxDebugMessage;
  assert.equal(reply.type, "fx_debug");
  assert.equal(reply.state?.frame, 7);
  assert.equal(reply.state?.decks[0]?.effectId, "e");
  assert.equal(Buffer.from(reply.state!.frameCtx, "base64").length, FRAME_CTX_BYTES);
  const led = decodeServer(
    encodeServer({ type: "fx_debug", led: { led: 3, locals: [1.5, -2, "NaN"], rgb: b64(Uint8Array.from([1, 2, 3])) } } as unknown as ServerMessage),
  ) as unknown as FxDebugMessage;
  assert.equal(led.led?.led, 3);
  assert.deepEqual(led.led?.locals, [1.5, -2, "NaN"], "proto3 JSON spells a NaN local as a string");
});

test("FX_LED_V1 and FX_FRAME_V1 decode like the firmware writes them", () => {
  const l: LedInputs = {
    pos: [0.25, -1.5, 3],
    s: 0.5,
    dist: 0.75,
    uv: [0.125, 1],
    room: [0, 0, 0],
    seg: 4,
    branch: true,
    hasEntry: true,
    measured: false,
  };
  const rec = encodeLedRecord(l);
  assert.equal(rec.length, LED_CTX_BYTES);
  assert.deepEqual(decodeLedRecord(rec), l);
  assert.equal(rec[43], 1, "has an entry, interpolated");
  const none = encodeLedRecord({ ...l, hasEntry: false });
  assert.equal(new DataView(none.buffer).getInt16(40, true), -1);

  const ctx = new Uint8Array(FRAME_CTX_BYTES);
  const dv = new DataView(ctx.buffer);
  dv.setFloat32(0, 2.5, true);
  dv.setFloat32(4, 0.04, true);
  dv.setUint32(8, 99, true);
  dv.setUint32(12, 300, true);
  dv.setUint32(72, 1, true);
  dv.setFloat32(76, -1, true);
  const f = decodeFrameCtx(ctx)!;
  assert.equal(f.time, 2.5);
  assert.equal(f.dt, Math.fround(0.04));
  assert.equal(f.frame, 99);
  assert.equal(f.ledCount, 300);
  assert.equal(f.roomPosed, true);
  assert.equal(f.roomMin[0], -1);
  assert.equal(decodeFrameCtx(ctx.subarray(0, 10)), null);
});

test("the output stage is main.cpp cc_apply: LUT, then nscale8 unless 255", () => {
  assert.deepEqual(outputStage([10, 200, 255], null, 255), [10, 200, 255]);
  assert.deepEqual(outputStage([10, 200, 255], null, 128), [5, 100, 127]);
  const lut = new Uint8Array(768);
  for (let c = 0; c < 3; c++) for (let v = 0; v < 256; v++) lut[c * 256 + v] = 255 - v;
  assert.deepEqual(outputStage([0, 100, 255], lut, 255), [255, 155, 0]);
  assert.deepEqual(outputStage([0, 100, 255], lut, 200), [199, 121, 0]);
});

// -- a fake device + a stub VM ---------------------------------------------------

/** The stub "VM": update() bumps state[0] by uniforms[0]; shade() returns
 * (pos.x * 100 + state[0], idx, seg + 1) clamped to a byte. Deterministic, so
 * the fake device and the host agree unless the test injects a fault. */
class StubReplay implements FxReplayWasm {
  u = new Float32Array(MAX_UNIFORM_SLOTS);
  s = new Uint32Array(MAX_STATE + 98);
  a = new Uint8Array(0);
  loc = new Float32Array(128);
  constructor(readonly fxb: Uint8Array) {}
  set_budget(): void {}
  set_uniforms(v: Float32Array): void {
    this.u.set(v.subarray(0, MAX_UNIFORM_SLOTS));
  }
  set_state(w: Uint32Array): void {
    this.s = Uint32Array.from(w);
  }
  state(): Uint32Array {
    return Uint32Array.from(this.s);
  }
  set_graph_words(): void {}
  set_arena(b: Uint8Array): void {
    this.a = Uint8Array.from(b);
  }
  arena(): Uint8Array {
    return Uint8Array.from(this.a);
  }
  set_frame(): boolean {
    return true;
  }
  update(): number {
    const f = new Float32Array(this.s.buffer, 0, 1);
    f[0] = Math.fround(f[0]! + this.u[0]!);
    return 0;
  }
  shade(rec: Uint8Array, idx: number): Uint8Array {
    const l = decodeLedRecord(rec);
    if (!l.hasEntry) return Uint8Array.from([0, 0, 0, 0, 0]);
    const s0 = new Float32Array(this.s.buffer, 0, 1)[0]!;
    const v = Math.max(0, Math.min(255, Math.floor(l.pos[0] * 100 + s0)));
    this.loc[0] = l.pos[0];
    this.loc[1] = s0;
    this.loc[2] = v;
    return Uint8Array.from([v, idx & 255, (l.seg + 1) & 255, 0, 1]);
  }
  shade_isolated(rec: Uint8Array, idx: number): Uint8Array {
    return this.shade(rec, idx);
  }
  shade_debug(rec: Uint8Array, idx: number): Uint8Array {
    this.loc.fill(0);
    const o = this.shade(rec, idx);
    return Uint8Array.from([...o, 9, 0, 0, 0, 3, 0]);
  }
  locals(): Float32Array {
    return Float32Array.from(this.loc);
  }
  free(): void {}
}

const stubVm: ReplayVm = {
  FxReplay: StubReplay,
  fx_blend_rgb8: (a, b, t) => Uint8Array.from([0, 1, 2].map((k) => Math.floor(a[k]! + t * (b[k]! - a[k]!) + 0.5))),
};

/** A fake player emulating fxdbg.rs on the stub VM: N LEDs on deck 0. */
class FakeDevice implements FxDebugLink {
  paused = false;
  steps = 0;
  frame = 10;
  time = 1;
  dt = 0.033;
  brightness = 255;
  lut: Uint8Array | null = null;
  vm = new StubReplay(Uint8Array.from([1, 2, 3, 4]));
  ctx: LedInputs[];
  output: Uint8Array;
  /** Fault injection: LED -> a value added to its red channel after shading. */
  corrupt = new Map<number, number>();
  inFlight = 0;
  calls: string[] = [];
  constructor(readonly n: number) {
    this.vm.u[0] = 2;
    this.ctx = Array.from({ length: n }, (_, i) => ({
      pos: [Math.fround(i * 0.1 + 0.003), 0, 0] as [number, number, number],
      s: 0,
      dist: 0,
      uv: [0, 0] as [number, number],
      room: [0, 0, 0] as [number, number, number],
      seg: i % 3,
      branch: false,
      hasEntry: true,
      measured: true,
    }));
    this.output = new Uint8Array(n * 3);
    this.render();
  }
  render(): void {
    this.vm.update();
    for (let i = 0; i < this.n; i++) {
      const o = this.vm.shade(encodeLedRecord(this.ctx[i]!), i);
      const c = outputStage([Math.min(255, o[0]! + (this.corrupt.get(i) ?? 0)), o[1]!, o[2]!], this.lut, this.brightness);
      this.output.set(c, i * 3);
    }
    this.frame++;
    this.time += this.dt;
  }
  private state(): FxDebugStateFlat {
    const ctx = new Uint8Array(FRAME_CTX_BYTES);
    const dv = new DataView(ctx.buffer);
    dv.setFloat32(0, this.time, true);
    dv.setFloat32(4, this.dt, true);
    dv.setUint32(8, this.frame - 1, true);
    dv.setUint32(12, this.n, true);
    return {
      paused: this.paused,
      stepsPending: this.steps,
      holdRemainingMs: 1000,
      time: this.time,
      dt: this.dt,
      frame: this.frame - 1,
      ledCount: this.n,
      decks: [
        { deck: 0, effectId: "stub", fxbHash: 42, fxbBytes: 4, renders: true, flags: 0, jitBlocks: 0, arenaBytes: 0, stateSlots: 128, uniformSlots: 128, morphRunning: false },
      ],
      crossfade: 0,
      crossfadeMode: 0,
      currentFps: 30,
      targetFps: 0,
      brightness: this.brightness,
      lut: this.lut !== null,
      colorOrder: b64(Uint8Array.from([1, 0, 2, 1, 0, 2])),
      channel0Leds: this.n,
      channel1Leds: 0,
      frameCtx: b64(ctx),
      lastUpdateOutcome: 0,
      budget: 100000,
      timeBase: false,
      resumeReason: "",
      layoutVersion: 1,
    };
  }
  private async enter<T>(name: string, fn: () => T): Promise<T> {
    assert.equal(this.inFlight, 0, "requests are single-flight");
    this.inFlight++;
    this.calls.push(name);
    await new Promise((r) => setTimeout(r, 0));
    this.inFlight--;
    return fn();
  }
  fxDebugControl(m: { action: number; frames?: number }): Promise<FxDebugMessage> {
    return this.enter("control", () => {
      if (this.steps > 0) {
        this.steps--;
        this.render();
      }
      if (m.action === 1) this.paused = true;
      if (m.action === 2) this.paused = false;
      if (m.action === 3) {
        this.paused = true;
        this.steps = m.frames ?? 1;
      }
      return { type: "fx_debug", state: this.state() } as FxDebugMessage;
    });
  }
  section(s: number): Uint8Array {
    switch (s) {
      case FX_SECTION.output:
        return this.output;
      case FX_SECTION.program:
        return this.vm.fxb;
      case FX_SECTION.uniforms:
        return new Uint8Array(this.vm.u.buffer.slice(0));
      case FX_SECTION.state:
        return new Uint8Array(this.vm.s.buffer.slice(0));
      case FX_SECTION.arena:
        return new Uint8Array(0);
      case FX_SECTION.graph:
        return new Uint8Array(4);
      case FX_SECTION.lut:
        return this.lut ?? new Uint8Array(0);
      case FX_SECTION.ledContext: {
        const out = new Uint8Array(this.n * LED_CTX_BYTES);
        this.ctx.forEach((c, i) => out.set(encodeLedRecord(c), i * LED_CTX_BYTES));
        return out;
      }
      default:
        return new Uint8Array(0);
    }
  }
  getFxSnapshot(m: { section: number; offset: number; maxLen?: number }): Promise<FxDebugMessage> {
    return this.enter("snapshot", () => {
      const all = this.section(m.section);
      const len = Math.min(m.maxLen || 768, 1536);
      const off = Math.min(m.offset, all.length);
      const data = all.subarray(off, Math.min(all.length, off + len));
      return {
        type: "fx_debug",
        chunk: { section: m.section, deck: 0, totalLen: all.length, offset: off, data: b64(data), frame: this.frame, paused: this.paused },
      } as FxDebugMessage;
    });
  }
  debugFxLed(m: { led: number }): Promise<FxDebugMessage> {
    return this.enter("led", () => {
      const rec = encodeLedRecord(this.ctx[m.led]!);
      this.vm.shade(rec, m.led);
      const o = this.vm.shade_debug(rec, m.led);
      const locals = Array.from(this.vm.locals());
      if (this.corrupt.has(m.led)) locals[2] = locals[2]! + this.corrupt.get(m.led)!;
      return {
        type: "fx_debug",
        led: { led: m.led, deck: 0, rgb: b64(o.subarray(0, 3)), rgbJit: b64(o.subarray(0, 3)), output: b64(this.output.subarray(m.led * 3, m.led * 3 + 3)), outcome: 0, locals, ledContext: b64(rec), instructions: 9, stackMax: 3 },
      } as FxDebugMessage;
    });
  }
}

test("snapshot sections reassemble from any chunk size, one request at a time", async () => {
  const dev = new FakeDevice(37);
  for (const chunk of [64, 100, 768, 1536]) {
    const dbg = new FxDebugger(dev, { chunkBytes: chunk });
    const [ctx, out, part] = await Promise.all([
      dbg.readSection("ledContext"),
      dbg.readSection("output"),
      dbg.readSection("ledContext", 0, 5 * LED_CTX_BYTES, 7 * LED_CTX_BYTES),
    ]);
    assert.deepEqual(ctx, dev.section(FX_SECTION.ledContext));
    assert.deepEqual(out, dev.output);
    assert.deepEqual(part, dev.section(FX_SECTION.ledContext).subarray(5 * LED_CTX_BYTES, 12 * LED_CTX_BYTES));
  }
});

test("step waits for the device to render the frames", async () => {
  const dev = new FakeDevice(4);
  const dbg = new FxDebugger(dev);
  const f0 = (await dbg.pause()).frame;
  const st = await dbg.step({ frames: 3 });
  assert.equal(st.stepsPending, 0);
  assert.equal(st.frame, f0 + 3);
  assert.ok(st.paused);
});

const bundleFor = (dev: FakeDevice, mutate?: (ids: number[]) => number[]): MappingBundle => {
  const ids = mutate ? mutate(dev.ctx.map((_, i) => i)) : dev.ctx.map((_, i) => i);
  return {
    map: {
      mapId: "m",
      createdAt: "",
      units: "meters",
      frame: "gravity_leveled",
      ledCount: dev.n,
      leds: ids.map((id) => ({ id, xyz: [id * 0.1 + 0.003, 0, 0], confidence: 1, nViews: 2, rmsReprojPx: 0, parallaxDeg: 0 })),
      unmapped: [],
      stats: { rmsReprojPxGlobal: 0, medianParallaxDeg: 0 },
    },
    topology: null as unknown as MappingBundle["topology"],
  } as MappingBundle;
};

test("a faithful device: compare_with_preview says MATCH", async () => {
  const dev = new FakeDevice(12);
  // The device's segs are i % 3; give the preview no topology -> seg -1 differs,
  // so drop the stub's seg dependence for this case.
  dev.ctx.forEach((c) => (c.seg = -1));
  const r = await compareWithPreview(new FxDebugger(dev), stubVm, { bundle: bundleFor(dev) });
  assert.equal(r.verdict, "match", JSON.stringify(r.findings));
  assert.equal(r.engine.mismatched, 0);
  assert.ok(dev.paused, "left paused for inspection");
  assert.equal(r.inputs?.differing, 0);
});

test("an engine divergence is pinned to its LED with the VM locals that differ", async () => {
  const dev = new FakeDevice(12);
  dev.ctx.forEach((c) => (c.seg = -1));
  dev.corrupt.set(5, 7);
  const r = await compareWithPreview(new FxDebugger(dev), stubVm, { bundle: bundleFor(dev), resume: true });
  assert.equal(r.verdict, "engine");
  assert.equal(r.engine.firstDivergent, 5);
  assert.equal(r.engine.mismatched, 1);
  const l = r.locals.find((x) => x.led === 5)!;
  assert.deepEqual(l.differing.map((d) => d.slot), [2]);
  assert.match(r.findings[0]!, /^ENGINE: 1\/12 LEDs differ/);
  assert.ok(!dev.paused, "resume: true");
});

test("inputs: a sparse/reordered preview map and the output stage are called out", async () => {
  const dev = new FakeDevice(10);
  // The preview lists LEDs in a different order than the device's ids, and the
  // device's segments (i % 3) aren't in the preview (no topology).
  dev.brightness = 128;
  const r = await compareWithPreview(new FxDebugger(dev), stubVm, {
    bundle: bundleFor(dev, (ids) => [...ids.slice(5), ...ids.slice(0, 5)]),
  });
  assert.equal(r.engine.mismatched, 0, "the engine itself is faithful");
  assert.equal(r.verdict, "mixed");
  assert.ok(r.inputs!.differing > 0);
  assert.ok(r.inputs!.colourChanging > 0);
  assert.ok(r.findings.some((f) => f.includes("led.idx and buffers line up differently")));
  assert.ok(r.findings.some((f) => f.startsWith("OUTPUT STAGE: 10/10 LEDs")), JSON.stringify(r.findings));
  assert.deepEqual(r.outputStage.colorOrder, ["GRB", "GRB"]);
  const probe = r.locals.find((l) => l.inputDriven && l.inputDriven.length > 0);
  assert.ok(probe, "the input-driven locals of a changed LED are reported");
});

test("diffLedInputs flags F24-sized position deltas and missing map entries", () => {
  const dev = new FakeDevice(4);
  const pv = previewLedInputs(bundleFor(dev));
  const devIn = dev.ctx.map((c, i) => ({ ...c, seg: -1, pos: [i === 1 ? c.pos[0] + 1e-6 : c.pos[0], 0, 0] as [number, number, number], hasEntry: i !== 3 }));
  const d = diffLedInputs(devIn, 0, pv, false);
  assert.deepEqual(d.map((x) => [x.led, x.fields]), [
    [1, ["pos"]],
    [3, ["no_device_map_entry"]],
  ]);
});
