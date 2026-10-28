/**
 * The FX debugger tools (pause_fx / step_fx / snapshot_fx / compare_with_preview /
 * resume_fx) end to end through the MCP server, against a fake player that
 * emulates the firmware's debugger (fxdbg.rs) on the REAL VM wasm: positions are
 * stored as the device's 24-bit floats, LEDs are indexed by id, frames step at an
 * exact time / dt, and snapshots are served in chunks. So:
 *
 *   - a faithful device replays bit-exactly (no ENGINE divergence), and the F24
 *     position rounding shows up as an INPUTS difference against the preview;
 *   - an injected per-LED fault (what a JIT / firmware bug looks like) is pinned
 *     to its LED with the VM locals that differ — named, since this session
 *     deployed the source;
 *   - the brightness shows as an OUTPUT STAGE finding;
 *   - firmware without the "fx_debug" feature gets a clear error.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { before, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  encodeLedRecord,
  FRAME_CTX_BYTES,
  LED_CTX_BYTES,
  outputStage,
  type FxReplayWasm,
  type ReplayVm,
} from "../../web/src/fx/fxDebug";
import { deriveLedTopology } from "../../web/src/fx/preview";
import { loadFxHost, replayVm } from "../src/fxhost";
import { createServer } from "../src/server";
import { DeviceSession } from "../src/session";
import { nodeSocketFactory } from "../src/socket";
import { FakePlayer, TEST_CERT_SHA256, yFixture } from "./fakePlayer";

const WASM_ROOT = resolve(process.env["AGENT_WASM_ROOT"] ?? "wasm");
const SCRATCH = mkdtempSync(join(tmpdir(), "splanc-fxdebug-test-"));
process.env["SPLANC_CACHE_DIR"] = join(SCRATCH, "cache");
process.env["SPLANC_CONFIG_DIR"] = join(SCRATCH, "config");

const EFFECT = `
uniform float speed : 0.0 .. 4.0 = 1.5;
state float phase;
buffer vec3 trail;
void update() { phase = fract(phase + dt * speed); }
vec3 shade(Led led) {
  float h = fract(led.dist + phase);
  vec3 c = hsv2rgb(h, 0.9, 0.5 + 0.5 * led.s);
  vec3 t = mix(trail[led.idx], c, 0.5);
  trail[led.idx] = t;
  return t;
}
`;

type Msg = Record<string, unknown> & { type: string };
const b64 = (b: Uint8Array): string => Buffer.from(b).toString("base64");

/** f32 -> the device's F24 (fx ffi.rs: drop the low mantissa byte, rounded). */
function f24(v: number): number {
  const u = new Uint32Array(new Float32Array([v]).buffer)[0]!;
  const exp = u & 0x7f800000;
  const r = exp === 0x7f800000 ? u : (u + 0x80) >>> 0;
  return new Float32Array(new Uint32Array([r & 0xffffff00]).buffer)[0]!;
}

/** The firmware's FX debugger, emulated on the real VM for one deck-A effect. */
class DebugDevice {
  vm: FxReplayWasm | null = null;
  fxb: Uint8Array | null = null;
  uniforms = new Float32Array(128);
  paused = false;
  frame = 0;
  time = 0;
  dt = 1 / 30;
  output: Uint8Array;
  recs: Uint8Array;
  graph: Uint32Array;
  /** Injected fault: LED -> added to its red channel (a "JIT bug"). */
  fault = new Map<number, number>();
  constructor(
    readonly p: FakePlayer,
    readonly replay: ReplayVm,
  ) {
    const b = p.bundle!;
    const n = b.map.ledCount;
    const topo = deriveLedTopology(b.map, b.topology);
    const pos = b.map.leds.map((l) => l.xyz.map(f24));
    const mn = [0, 1].map((k) => Math.min(...pos.map((q) => q[k]!)));
    const mx = [0, 1].map((k) => Math.max(...pos.map((q) => q[k]!)));
    this.recs = new Uint8Array(n * LED_CTX_BYTES);
    b.map.leds.forEach((l, i) => {
      const q = pos[i]!;
      const uv = [0, 1].map((k) => Math.min(1, Math.max(0, Math.fround((q[k]! - mn[k]!) * Math.fround(1 / (mx[k]! - mn[k]!))))));
      this.recs.set(
        encodeLedRecord({
          pos: [q[0]!, q[1]!, q[2]!],
          s: f24(topo.s[i]!),
          dist: f24(topo.dist[i]!),
          uv: [uv[0]!, uv[1]!],
          room: [0, 0, 0],
          seg: topo.seg[i]!,
          branch: topo.branch[i] !== 0,
          hasEntry: true,
          measured: true,
        }),
        l.id * LED_CTX_BYTES,
      );
    });
    this.graph = new Uint32Array(1 + topo.segLen.length * 3);
    this.graph[0] = topo.segLen.length;
    topo.segLen.forEach((len, k) => {
      this.graph[1 + 3 * k] = new Uint32Array(new Float32Array([len]).buffer)[0]!;
      this.graph[2 + 3 * k] = topo.segA[k]! >>> 0;
      this.graph[3 + 3 * k] = topo.segB[k]! >>> 0;
    });
    this.output = new Uint8Array(n * 3);
    for (const [type, fn] of [
      ["fx_debug_control", (m: Msg) => this.control(m)],
      ["get_fx_snapshot", (m: Msg) => this.snapshot(m)],
      ["debug_fx_led", (m: Msg) => this.debugLed(m)],
    ] as const) {
      p.handlers.set(type, fn);
    }
  }
  get n(): number {
    return this.p.bundle!.map.ledCount;
  }
  /** (Re)load when the fake player's deck A changed. */
  sync(): void {
    const e = this.p.effect;
    if (!e?.fxb) return;
    if (this.fxb !== e.fxb) {
      this.vm?.free();
      this.fxb = e.fxb;
      this.vm = new this.replay.FxReplay(e.fxb);
      this.vm.set_graph_words(this.graph);
      const fxb = e.fxb;
      const mlen = fxb[8]! | (fxb[9]! << 8);
      for (const u of JSON.parse(new TextDecoder().decode(fxb.subarray(18, 18 + mlen))) as { slot: number; default: number[] }[]) {
        this.uniforms.set(u.default, u.slot);
      }
      this.vm.set_arena(new Uint8Array(4 * 3 * Math.max(512, this.n)));
      this.frame = 0;
      this.time = 0;
    }
    for (const c of e.current) this.uniforms.set(c.value, c.slot);
    this.vm!.set_uniforms(this.uniforms);
  }
  frameCtx(): Uint8Array {
    const ctx = new Uint8Array(FRAME_CTX_BYTES);
    const dv = new DataView(ctx.buffer);
    dv.setFloat32(0, this.time, true);
    dv.setFloat32(4, this.dt, true);
    dv.setUint32(8, this.frame, true);
    dv.setUint32(12, this.n, true);
    dv.setInt32(40, Math.trunc(Math.fround(this.time) * 65536), true);
    dv.setInt32(44, Math.trunc(Math.fround(this.dt) * 65536), true);
    return ctx;
  }
  render(): void {
    this.sync();
    const vm = this.vm!;
    this.time = Math.fround(this.time + this.dt);
    this.frame++;
    vm.set_frame(this.frameCtx());
    vm.update();
    for (let i = 0; i < this.n; i++) {
      const o = vm.shade(this.recs.subarray(i * LED_CTX_BYTES, (i + 1) * LED_CTX_BYTES), i);
      const raw = [Math.min(255, o[0]! + (this.fault.get(i) ?? 0)), o[1]!, o[2]!];
      this.output.set(outputStage(raw, null, Math.round(this.p.brightness * 255)), i * 3);
    }
  }
  state(): Msg {
    return {
      type: "fx_debug",
      state: {
        paused: this.paused,
        stepsPending: 0,
        holdRemainingMs: this.paused ? 120000 : 0,
        time: this.time,
        dt: this.dt,
        frame: this.frame,
        ledCount: this.n,
        decks: this.fxb
          ? [{ deck: 0, effectId: this.p.effect!.id, fxbHash: fnv(this.fxb), fxbBytes: this.fxb.length, renders: true, flags: this.fxb[5], jitBlocks: 0, arenaBytes: this.vm!.arena().length, stateSlots: 128, uniformSlots: 128, morphRunning: false }]
          : [],
        crossfade: 0,
        crossfadeMode: 0,
        currentFps: 30,
        targetFps: 0,
        brightness: Math.round(this.p.brightness * 255),
        lut: false,
        colorOrder: b64(Uint8Array.from([1, 0, 2, 1, 0, 2])),
        channel0Leds: this.n,
        channel1Leds: 0,
        frameCtx: b64(this.frameCtx()),
        lastUpdateOutcome: 0,
        budget: 100000,
        timeBase: false,
        resumeReason: "",
        layoutVersion: 1,
      },
    };
  }
  control(m: Msg): Msg {
    if (!this.p.effect?.fxb) return { type: "error", code: "no_effect", message: "no effect is rendering" };
    if (!this.vm) this.render();
    const a = m["action"] as string;
    if (a === "ACTION_PAUSE") this.paused = true;
    if (a === "ACTION_RESUME") this.paused = false;
    if (a === "ACTION_STEP") {
      this.paused = true;
      if (m["dt"] !== undefined) this.dt = m["dt"] as number;
      for (let k = 0; k < ((m["frames"] as number) || 1); k++) this.render();
    }
    return this.state();
  }
  section(s: string): Uint8Array {
    const vm = this.vm!;
    switch (s) {
      case "SECTION_OUTPUT":
        return this.output;
      case "SECTION_WIRE":
        return this.output.map((_, i) => this.output[i - (i % 3) + [1, 0, 2][i % 3]!]!);
      case "SECTION_PROGRAM":
        return this.fxb!;
      case "SECTION_UNIFORMS":
        return new Uint8Array(this.uniforms.slice().buffer);
      case "SECTION_STATE":
        return new Uint8Array(vm.state().slice().buffer);
      case "SECTION_ARENA":
        return vm.arena();
      case "SECTION_GRAPH":
        return new Uint8Array(this.graph.slice().buffer);
      case "SECTION_LED_CONTEXT":
        return this.recs;
      default:
        return new Uint8Array(0);
    }
  }
  snapshot(m: Msg): Msg {
    if (!this.vm) this.render();
    const all = this.section(m["section"] as string);
    const off = Math.min((m["offset"] as number) ?? 0, all.length);
    const len = Math.min((m["maxLen"] as number) || 768, 1536);
    return {
      type: "fx_debug",
      chunk: { section: m["section"], deck: 0, totalLen: all.length, offset: off, data: b64(all.subarray(off, off + len)), frame: this.frame, paused: this.paused },
    };
  }
  debugLed(m: Msg): Msg {
    if (!this.paused) return { type: "error", code: "not_paused", message: "pause first" };
    const i = m["led"] as number;
    const rec = this.recs.subarray(i * LED_CTX_BYTES, (i + 1) * LED_CTX_BYTES);
    const vm = this.vm!;
    // fxdbg.rs handle_debug_led: the normal path then the interpreter, each from
    // the LED's paused buffer elements (restored after each run).
    const jit = vm.shade_isolated(rec, i);
    const o = vm.shade_debug(rec, i);
    const locals = Array.from(vm.locals()).map((v) => (Number.isNaN(v) ? "NaN" : v));
    // The injected "JIT" fault: the normal path differs from the interpreter.
    const f = this.fault.get(i) ?? 0;
    return {
      type: "fx_debug",
      led: {
        led: i,
        deck: 0,
        rgb: b64(o.subarray(0, 3)),
        rgbJit: b64(Uint8Array.from([Math.min(255, jit[0]! + f), jit[1]!, jit[2]!])),
        output: b64(this.output.subarray(i * 3, i * 3 + 3)),
        outcome: o[3],
        locals,
        ledContext: b64(rec),
        instructions: new DataView(o.buffer, o.byteOffset).getUint32(5, true),
        stackMax: 4,
      },
    };
  }
}

function fnv(b: Uint8Array): number {
  let h = 0x811c9dc5;
  for (const x of b) h = Math.imul(h ^ x, 0x01000193) >>> 0;
  return h;
}

let replay: ReplayVm;
before(async () => {
  await loadFxHost(WASM_ROOT);
  const r = await replayVm();
  assert.ok(r, "the bundle's VM has the FX debugger replay");
  replay = r!;
});

async function rig(features = ["effects", "perf", "stored_map", "fx_debug"]) {
  const p = new FakePlayer();
  p.features = features;
  p.bundle = yFixture();
  await p.start();
  p.serveManifest();
  const s = new DeviceSession({ url: `wss://${p.host}/ws`, socketFactory: nodeSocketFactory({ pinSha256: TEST_CERT_SHA256 }) });
  await s.connect();
  const server = createServer(s);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    return { error: !!r.isError, text: r.content[0]!.text, json: () => JSON.parse(r.content[0]!.text) as Record<string, any> };
  };
  const close = async () => {
    await client.close();
    s.close();
    await p.stop();
  };
  return { p, s, call, close };
}

test("compare_with_preview: a faithful device replays bit-exactly; F24 positions show as inputs", async () => {
  const { p, call, close } = await rig();
  try {
    const dev = new DebugDevice(p, replay);
    const d = await call("deploy_effect", { effect_id: "trails", source: EFFECT });
    assert.equal(d.error, false, d.text);
    for (let k = 0; k < 5; k++) dev.render();
    const r = (await call("compare_with_preview", {})).json();
    assert.equal(r["engine"].mismatched_leds, 0, JSON.stringify(r["findings"]));
    assert.deepEqual(r["engine"].state, { "deck 0": [] });
    assert.deepEqual(r["engine"].buffers, { "deck 0": null });
    assert.ok(dev.paused, "left paused");
    assert.ok(r["inputs"].differing_leds > 0, "F24 positions differ from the preview's map");
    assert.ok(r["inputs"].leds.every((l: { fields: string[] }) => l.fields.every((f) => ["pos", "s", "dist", "uv"].includes(f))));
    assert.ok(r["findings"].some((f: string) => f.includes("24-bit floats")), JSON.stringify(r["findings"]));
    assert.match(r["findings"].at(-1), /wire colour order is GRB/);

    // The snapshot tools on the paused frame: named state, uniforms, one LED's locals.
    const snap = (await call("snapshot_fx", { led: 7, count: 4, include: ["uniforms", "state", "leds", "inputs", "buffers"] })).json();
    assert.equal(snap["engine"].paused, true);
    assert.equal(snap["uniforms"].speed, 1.5);
    assert.ok(Object.keys(snap["state"]).some((k) => k.startsWith("phase")), JSON.stringify(snap["state"]));
    assert.equal(snap["leds"].length, 4);
    assert.ok(snap["leds"][0].buffers.trail, "buffer values by name");
    const locals = snap["led_debug"].locals as Record<string, number>;
    assert.ok(Object.keys(locals).some((k) => k.startsWith("shade:h")), JSON.stringify(locals));
    assert.deepEqual(snap["led_debug"].rgb_interpreter, snap["led_debug"].rgb_normal_path);

    // Step: time advances by exactly dt; resume ends it.
    const before = (await call("snapshot_fx", { include: [] })).json()["engine"].time as number;
    const st = (await call("step_fx", { frames: 2, dt: 0.05 })).json();
    assert.equal(st["frame"], dev.frame);
    assert.ok(Math.abs(st["time"] - (before + 0.1)) < 1e-5);
    assert.equal((await call("resume_fx")).json()["paused"], false);
  } finally {
    await close();
  }
});

test("compare_with_preview pins an engine fault to its LED, with named locals and the JIT disagreement", async () => {
  const { p, call, close } = await rig();
  try {
    const dev = new DebugDevice(p, replay);
    assert.equal((await call("deploy_effect", { effect_id: "trails", source: EFFECT })).error, false);
    for (let k = 0; k < 3; k++) dev.render();
    dev.fault.set(11, 40);
    p.brightness = 0.5;
    const r = (await call("compare_with_preview", { debug_leds: 2, resume: true })).json();
    assert.equal(r["verdict"], "mixed");
    assert.equal(r["engine"].first_divergent_led, 11);
    assert.equal(r["engine"].mismatched_leds, 1);
    assert.match(r["findings"][0], /^ENGINE: 1\/30 LEDs differ/);
    assert.ok(r["findings"].some((f: string) => f.startsWith("JIT: LED 11")), JSON.stringify(r["findings"]));
    assert.ok(r["findings"].some((f: string) => f.startsWith("OUTPUT STAGE: ") && f.includes("brightness 128/255")));
    const l = r["locals"].find((x: { led: number }) => x.led === 11);
    assert.equal(l.kind, "device interpreter vs host replay");
    assert.deepEqual(l.differing, [], "the interpreter agrees: only the normal (JIT) path is off");
    assert.equal(dev.paused, false, "resume: true");
  } finally {
    await close();
  }
});

test("firmware without the fx_debug feature gets a clear error", async () => {
  const { call, close } = await rig(["effects", "perf", "stored_map"]);
  try {
    const r = await call("pause_fx");
    assert.equal(r.error, true);
    assert.match(r.text, /no FX debugger/);
  } finally {
    await close();
  }
});
