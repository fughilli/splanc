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

import { compile, loadFxHost, preview } from "../src/fxhost";
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
