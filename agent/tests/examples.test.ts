/**
 * Host compile + preview: every skill example compiles with the real compiler
 * wasm and renders on a fixture with the real VM wasm (non-black, a PNG per
 * time, animated where the example animates). Also pins the preview harness:
 * per-LED colours in map order, uniform overrides applied.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { before, test } from "node:test";

import { FxPreview } from "../../web/src/fx/preview";
import { compile, lintWarnings, loadFxHost, preview } from "../src/fxhost";
import { yFixture } from "./fakePlayer";

const WASM_ROOT = process.env["AGENT_WASM_ROOT"] ?? "wasm";
const EXAMPLES = process.env["AGENT_EXAMPLES"] ?? join(process.cwd(), "skill/examples");
const ANIMATED = new Set(["segment_pulses.fx", "noise_field.fx", "height_gradient.fx"]);

before(async () => {
  await loadFxHost(WASM_ROOT);
});

const files = readdirSync(EXAMPLES).filter((f) => f.endsWith(".fx"));

test("there are examples", () => {
  assert.ok(files.length >= 5, files.join(","));
});

for (const f of files) {
  test(`example ${f} compiles and previews`, async () => {
    const src = readFileSync(join(EXAMPLES, f), "utf8");
    const c = await compile(src);
    assert.equal(c.ok, true, JSON.stringify(c.diagnostics));
    // Teaching material never shows the rate-times-time anti-pattern (or any lint).
    assert.deepEqual(c.warnings, [], JSON.stringify(c.warnings));
    assert.ok(c.uniforms.length > 0, "examples expose knobs");
    const frames = await preview({ fxb: c.fxb, manifest: c.uniforms, bundle: yFixture(), times: [0, 0.7, 2.3] });
    assert.equal(frames.length, 3);
    for (const fr of frames) {
      assert.equal(fr.colors.length, 30);
      assert.equal(fr.png.subarray(1, 4).toString(), "PNG");
    }
    const lit = frames.some((fr) => fr.colors.some(([r, g, b]) => r + g + b > 10));
    assert.ok(lit, "renders something visible");
    if (ANIMATED.has(f)) {
      const a = JSON.stringify(frames[0]!.colors);
      assert.ok(frames.slice(1).some((fr) => JSON.stringify(fr.colors) !== a), "animates");
    }
  });
}

test("uniform overrides reach the VM", async () => {
  const src = readFileSync(join(EXAMPLES, "solid_fill.fx"), "utf8");
  const c = await compile(src);
  const [red] = await preview({ fxb: c.fxb, manifest: c.uniforms, bundle: yFixture(), times: [0], uniforms: { color: [1, 0, 0] } });
  for (const [r, g, b] of red!.colors) {
    assert.ok(r > 200 && g < 10 && b < 10, `${r},${g},${b}`);
  }
  await assert.rejects(
    preview({ fxb: c.fxb, manifest: c.uniforms, bundle: yFixture(), times: [0], uniforms: { nope: 1 } }),
    /unknown uniform/,
  );
});

// -- rate controls: the lint reaches the agent; integrators are smooth in the preview --

const RATE_BAD = `uniform float speed : 0.0 .. 4.0 = 0.2;
vec3 shade(Led led) {
  float p = fract(led.s - time * speed);
  return vec3(p, p, p);
}
`;
const RATE_GOOD = `uniform float speed : 0.0 .. 4.0 = 0.2;
state float ph;
void update() { ph = fract(ph + dt * speed); }
vec3 shade(Led led) {
  float a = atan2(led.pos.y, led.pos.x);
  return vec3(ph, fract(a * 0.15 + ph), 0.0);
}
`;

test("compile + lintWarnings flag a rate uniform times time, by line", async () => {
  const c = await compile(RATE_BAD);
  assert.equal(c.ok, true);
  assert.equal(c.warnings?.length, 1, JSON.stringify(c.warnings));
  assert.equal(c.warnings![0]!.line, 3);
  assert.match(c.warnings![0]!.msg, /^warning: .*`speed`.*fract\(speed_phase \+ dt \* speed\)/s);
  assert.deepEqual(await lintWarnings(RATE_GOOD), []);
});

test("the preview keeps an integrator's phase continuous when the knob moves", async () => {
  // The editor/agent preview (web/src/fx/preview.ts FxPreview over the real VM
  // wasm): ten minutes in, speed 0.2 -> 2.0 mid-run. The integrated phase (red,
  // every LED) may only advance speed*dt per frame; time*speed would jump.
  const c = await compile(RATE_GOOD); // also installs the host wasm modules
  const sim = await FxPreview.create(c.fxb);
  try {
    const fx = yFixture();
    const leds = fx.map!.leds;
    const pos = new Float32Array(leds.length * 3);
    leds.forEach((l, i) => pos.set(l.xyz, i * 3));
    const slot = c.uniforms.find((u) => u.name === "speed")!.slot;
    sim.setUniform(slot, [0.2]);
    const dt = 1 / 30;
    const reds: number[] = [];
    for (let f = 0; f < 40; f++) {
      if (f === 20) sim.setUniform(slot, [2.0]);
      sim.tick(600 + f * dt, dt, f, leds.length);
      const rgb = sim.shadeAll(pos);
      for (let i = 0; i < leds.length; i++) assert.equal(rgb[i * 3], rgb[0], "one phase per frame, every LED");
      reds.push(rgb[0]!);
    }
    const steps = reds.slice(1).map((r, i) => {
      const d = Math.abs(r - reds[i]!);
      return Math.min(d, 256 - d); // on the circle: a wrap is a small step
    });
    const bound = Math.floor((255 * 2.0) / 30) + 2;
    assert.ok(Math.max(...steps) <= bound, `jumped: ${JSON.stringify(steps)}`);
    assert.ok(Math.max(...steps.slice(20)) > Math.max(...steps.slice(0, 19)), "speeds up after the change");
  } finally {
    sim.dispose();
  }
});
