/**
 * Cheap authoring (docs/design/fx-perf-study.md, Q2): the cost findings that
 * estimate_effect returns point at the real cost and its cheaper form, the
 * compiler's perf warnings fire on float literals in fixed maths, and every
 * example the agents are shown — the skill's examples and the in-app prompt's —
 * compiles without warnings and is cheap on the 500-LED reference fixture.
 * Real compiler wasm + the shipped C6 cost table.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { before, test } from "node:test";

import { SYSTEM_PROMPT, SYSTEM_PROMPT_COMPACT } from "../../web/src/effects/ai/system-prompt";
import { costFor, DISPATCH_FEATURE, estimateFrameTime } from "../../web/src/effects/costModel";
import { findingsToLines, perfFindings } from "../../web/src/effects/perfFindings";
import { defaultCostTable } from "../../web/src/store/costTableStore";
import { compile, loadFxHost } from "../src/fxhost";

const WASM_ROOT = process.env["AGENT_WASM_ROOT"] ?? "wasm";
const EXAMPLES = process.env["AGENT_EXAMPLES"] ?? join(process.cwd(), "skill/examples");
const table = defaultCostTable();
const LEDS = 500;

before(async () => {
  await loadFxHost(WASM_ROOT);
});

async function findings(src: string) {
  const c = await compile(src);
  assert.equal(c.ok, true, JSON.stringify(c.diagnostics));
  return { c, f: perfFindings(c.fxb, { table, source: src, warnings: c.warnings, max: 10 }) };
}

/** One execution of `feature` under the shipped table (dispatch + compute). */
const cyc = (feature: string): number =>
  (table.costs[DISPATCH_FEATURE] ?? 0) + costFor(table.costs, feature, table.fallbackCost);

const frameMs = (fxb: Uint8Array): number => {
  const e = estimateFrameTime({ bytecode: fxb, ledCount: LEDS, table });
  return e.phaseSplit.updateMs + e.phaseSplit.shadeMs;
};

test("float trig per LED: the top finding is the fixed-phase rewrite, with its line", async () => {
  const src = [
    "uniform float speed : 0.0 .. 4.0 = 1.0;",
    "vec3 shade(Led led) {",
    "  float a = sin(led.uv.x * 9.0 + time * speed);",
    "  float b = sin(led.uv.y * 7.0 - time);",
    "  float c = cos((led.uv.x + led.uv.y) * 5.0 + a);",
    "  return vec3(a * b, b * c, c * a);",
    "}",
  ].join("\n");
  const { f } = await findings(src);
  // Every trig call here depends on time (a also on the uniform, c on a): none
  // of them is LED-invariant, so caching one in a buffer would freeze the effect.
  assert.ok(!f.some((x) => x.rule === "led_invariant_heavy"), JSON.stringify(f));
  const trig = f.find((x) => x.rule === "float_trig_in_shade");
  assert.ok(trig, JSON.stringify(f));
  assert.equal(f[0], trig, JSON.stringify(f));
  assert.match(trig.message, /^float sin\(\) ×2 per LED/);
  assert.match(trig.message, /TURNS/);
  assert.deepEqual(trig.lines, [3, 4]);
  // The saving is both float sin() calls minus their fixed form, priced with
  // the shipped table (so a re-fitted table moves the number, not the verdict).
  const sin = cyc("UnMath:sin");
  const want = 2 * (sin - cyc("SinFix") - 0.5 * cyc("F2Fix"));
  assert.ok(want > 0.3 * 2 * sin, `the fixed form saves ${want} of ${2 * sin}`);
  assert.ok(Math.abs(trig.cyclesPerLed - want) <= 1, `${trig.cyclesPerLed} != ${want}`);
  const cos = f.find((x) => x.rule === "float_trig_in_shade" && /^float cos\(\) per LED/.test(x.message));
  assert.ok(cos, JSON.stringify(f));
  // Ranked: most cycles saved first.
  for (let i = 1; i < f.length; i++) assert.ok(f[i - 1]!.cyclesPerLed >= f[i]!.cyclesPerLed);
  const lines = findingsToLines(f.slice(0, 1), LEDS, table.cpuHz);
  assert.match(lines[0]!, /saves up to ~[\d,]+ cycles\/LED \(~[\d.]+ ms at 500 LEDs\)$/);
});

test("pow, exp and a float hsv2rgb per LED each get their cheap form", async () => {
  const src = [
    "vec3 shade(Led led) {",
    "  float d = led.uv.y - fract(led.uv.x + led.s + time);",
    "  float g = pow(d, 2.7) + exp(-4.0 * d);",
    "  return hsv2rgb(fract(g), 0.9, 1.0);",
    "}",
  ].join("\n");
  const { f } = await findings(src);
  const rules = f.map((x) => x.rule);
  for (const r of ["pow_per_led", "exp_per_led"]) assert.ok(rules.includes(r), rules.join(","));
  // Findings under 100 cycles/LED are dropped. Since #350 the float hsv2rgb saves less than
  // that on the shipped table, so only check the rewrite when the finding is due.
  const color = f.find((x) => x.rule === "float_color_per_led");
  if (color) assert.match(color.message, /hsv2rgb\(h, fixed\(0\.9\), fixed\(1\.0\)\)/);
});

test("a float literal in fixed maths: compiler warning + a round-trip finding on the warned line", async () => {
  const src = [
    "state fixed ph;",
    "void update() { ph = fract(ph + fixed(dt)); }",
    "vec3 shade(Led led) {",
    "  fixed x = fixed(led.s) + ph;",
    "  fixed y = fixed(x * 0.6) + fixed(x * 1.7);",
    "  return hsv2rgb(fract(y), fixed(0.9), fixed(1.0));",
    "}",
  ].join("\n");
  const { c, f } = await findings(src);
  assert.equal(c.warnings.length, 2, JSON.stringify(c.warnings));
  assert.equal(c.warnings[0]!.line, 5);
  assert.match(c.warnings[0]!.msg, /fixed\(0\.6\)/);
  const lit = f.find((x) => x.rule === "float_literal_in_fixed");
  assert.ok(lit, JSON.stringify(f));
  assert.deepEqual(lit.lines, [5]);
});

test("per-LED-invariant work: cached by the compiler in shade(), flagged inside a helper", async () => {
  const inShade = "vec3 shade(Led led) {\n  float a = atan2(led.pos.z, led.pos.x);\n  return vec3(fract(a + time), 0.0, 0.0);\n}\n";
  const cached = await findings(inShade);
  assert.ok(!cached.f.some((x) => x.rule === "led_invariant_heavy" || x.rule === "atan2_per_led"), JSON.stringify(cached.f));
  const helper =
    "float ang(vec3 p) { return atan2(p.z, p.x); }\nvec3 shade(Led led) {\n  return vec3(fract(ang(led.pos) + time), 0.0, 0.0);\n}\n";
  const { f } = await findings(helper);
  const inv = f.find((x) => x.rule === "led_invariant_heavy");
  assert.ok(inv, JSON.stringify(f));
  assert.match(inv.message, /atan2\(\) per LED depends only on led\.\*/);
  assert.deepEqual(inv.lines, [1]);
});

test("led_invariant_heavy: led.*-only maths in a helper is flagged (fused const operands stay LED-only)", async () => {
  const src = [
    "float wave(vec2 p) { return sin(p.x * 9.0) * cos(p.y * 7.0); }",
    "vec3 shade(Led led) {",
    "  float w = wave(led.uv);",
    "  return vec3(fract(w + time), 0.0, 0.0);",
    "}",
  ].join("\n");
  const { f } = await findings(src);
  const inv = f.filter((x) => x.rule === "led_invariant_heavy");
  assert.ok(inv.some((x) => /^sin\(\) per LED depends only on led\.\*/.test(x.message)), JSON.stringify(f));
  assert.ok(inv.some((x) => /^cos\(\) per LED depends only on led\.\*/.test(x.message)), JSON.stringify(f));
  for (const x of inv) assert.deepEqual(x.lines, [1]);
});

// Each per-frame input reaches the trig through a different path: a fused
// operand (BinTop/BinPair on a uniform, state or hoisted state), a LoadCtx, a
// helper argument. None of these calls may be called LED-invariant.
const frameSources: [string, string, string][] = [
  ["time", "", "time"],
  ["dt", "", "dt"],
  ["frame", "", "float(frame)"],
  ["a uniform", "uniform float speed : 0.0 .. 4.0 = 1.0;", "speed"],
  ["time * a uniform", "uniform float speed : 0.0 .. 4.0 = 1.0;", "time * speed"],
  ["a state", "state float ph;\nvoid update() { ph = fract(ph + dt); }", "ph"],
];
for (const [what, decl, expr] of frameSources) {
  test(`led_invariant_heavy: a sin() that also depends on ${what} is not LED-invariant`, async () => {
    const direct = [
      decl,
      "vec3 shade(Led led) {",
      `  float a = sin(led.uv.x * 9.0 + ${expr});`,
      "  return vec3(a, a, a);",
      "}",
    ];
    const helper = [
      decl,
      "float wave(vec2 p, float t) { return sin(p.x * 9.0 + t) * cos(p.y * 7.0 - t); }",
      "vec3 shade(Led led) {",
      `  float a = wave(led.uv, ${expr});`,
      "  return vec3(a, a, a);",
      "}",
    ];
    for (const src of [direct, helper]) {
      const { f } = await findings(src.join("\n"));
      assert.ok(!f.some((x) => x.rule === "led_invariant_heavy"), `${src.join("\n")}\n${JSON.stringify(f)}`);
      assert.ok(f.some((x) => x.rule === "float_trig_in_shade"), `${src.join("\n")}\n${JSON.stringify(f)}`);
    }
  });
}

test("the first-frame buffer fill doesn't count as per-LED work", async () => {
  const src = [
    "buffer float ang : fixed16;",
    "state bool started;",
    "state bool ready;",
    "void update() { ready = started; started = true; }",
    "vec3 shade(Led led) {",
    "  if (!ready) { ang[led.idx] = atan2(led.pos.z, led.pos.x) * 0.159 + 0.5; }",
    "  return hsv2rgb(fract(fixed(ang[led.idx]) + fixed(time)), fixed(0.9), fixed(1.0));",
    "}",
  ].join("\n");
  const { f } = await findings(src);
  assert.ok(!f.some((x) => /atan2/.test(x.message)), JSON.stringify(f));
});

test("a per-LED loop is reported with its trip count", async () => {
  const src = [
    "uniform float speed : 0.0 .. 2.0 = 0.5;",
    "vec3 shade(Led led) {",
    "  float c = 0.0;",
    "  for (int i = 0; i < 12; i = i + 1) {",
    "    c = c + smoothstep(0.1, 0.0, abs(led.s - fract(time * speed + float(i) * 0.083)));",
    "  }",
    "  return vec3(c, c, c);",
    "}",
  ].join("\n");
  const { f } = await findings(src);
  const loop = f.find((x) => x.rule === "loop_per_led");
  assert.ok(loop, JSON.stringify(f));
  assert.match(loop.message, /runs 12 times per LED/);
  assert.deepEqual(loop.lines, [4]);
});

const exampleFiles = readdirSync(EXAMPLES).filter((f) => f.endsWith(".fx"));

/** The `EXAMPLE n — …:` programs embedded in a prompt. */
function promptExamples(prompt: string): [string, string][] {
  const out: [string, string][] = [];
  const re = /EXAMPLE (\d+) — [^\n]*\n([\s\S]*?)(?=\n\nEXAMPLE \d+ —|\n\n[A-Z][A-Za-z ]+[:—]|\n\nThese are PATTERNS|$)/g;
  for (const m of prompt.matchAll(re)) out.push([`EXAMPLE ${m[1]}`, m[2]!]);
  return out;
}

test("the prompts carry fixed-point examples", () => {
  assert.ok(promptExamples(SYSTEM_PROMPT).length >= 4);
  assert.ok(promptExamples(SYSTEM_PROMPT_COMPACT).length >= 3);
  for (const p of [SYSTEM_PROMPT, SYSTEM_PROMPT_COMPACT]) {
    assert.ok(promptExamples(p).some(([, s]) => /state fixed/.test(s) && /fixed\(led\./.test(s)));
    // The false claims the study found are gone.
    assert.doesNotMatch(p, /further ~2×|FLOAT-ONLY/);
  }
  const skill = readFileSync(join(process.cwd(), "skill/effect-language.md"), "utf8");
  assert.doesNotMatch(skill, /cheap LUTs|integer mix \(cheap\)/);
  assert.ok(exampleFiles.filter((f) => /state fixed/.test(readFileSync(join(EXAMPLES, f), "utf8"))).length >= 3);
});

const cases: [string, string][] = [
  ...exampleFiles.map((f): [string, string] => [`skill/examples/${f}`, readFileSync(join(EXAMPLES, f), "utf8")]),
  ...promptExamples(SYSTEM_PROMPT).map(([n, s]): [string, string] => [`SYSTEM_PROMPT ${n}`, s]),
  ...promptExamples(SYSTEM_PROMPT_COMPACT).map(([n, s]): [string, string] => [`SYSTEM_PROMPT_COMPACT ${n}`, s]),
];
for (const [name, src] of cases) {
  test(`${name} compiles without perf warnings and fits a 500-LED frame`, async () => {
    const c = await compile(src);
    assert.equal(c.ok, true, JSON.stringify(c.diagnostics));
    assert.deepEqual(c.warnings, []);
    // A per-LED loop is priced at its worst branch arm by the estimator, so the
    // struct-array example gets headroom; everything else must fit 33 ms.
    const cap = /for \(int i/.test(src.slice(src.indexOf("shade("))) ? 45 : 33.3;
    assert.ok(frameMs(c.fxb) < cap, `${frameMs(c.fxb).toFixed(1)} ms`);
  });
}
