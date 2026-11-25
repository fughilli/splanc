// effects/flashlight_pose.glsl on the real Splanc effect VM (its wasm preview build):
// the stylus validity gate, frame by frame. Needs the Splanc agent package (it carries
// the compiler and the simulator), e.g. the one `npx @splanc/agent` unpacks:
//
//   node tools/vive/demos/tests/flashlight_effect_check.mjs <@splanc/agent dir>
//
// (or SPLANC_AGENT=<dir>). Without one it prints SKIP and exits 0, unless
// SPLANC_AGENT_REQUIRED is set (bazel test //tools/vive:flashlight_effect_test, which
// passes //agent:wasm).
//
// Scenarios: startup with no stylus pose; poses arriving; the heartbeat stopping
// while stylus_ok is still 1 (driver/network gone); recovery with no redeploy;
// stylus_ok dropped by the driver; a healthy fixture tracker with an absent stylus.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const agentArg = process.argv[2] || process.env.SPLANC_AGENT;
const agent = agentArg && resolve(agentArg);
if (!agent || !existsSync(join(agent, "simulator", "fx_vm_wasm_pkg.js"))) {
  const required = Boolean(process.env.SPLANC_AGENT_REQUIRED);
  console.log(`${required ? "FAIL" : "SKIP"}: no Splanc agent package at ${agent} (pass its directory, or set SPLANC_AGENT)`);
  process.exit(required ? 1 : 0);
}

async function load(dir, name) {
  const m = await import(join(dir, `${name}.js`));
  m.initSync({ module: readFileSync(join(dir, `${name}_bg.wasm`)) });
  return m;
}
const comp = await load(join(agent, "compiler"), "fx_compiler_wasm_pkg");
const vm = await load(join(agent, "simulator"), "fx_vm_wasm_pkg");

const src = readFileSync(join(HERE, "..", "effects", "flashlight_pose.glsl"), "utf8");
const r = comp.fx_compile(src);
if (!r.ok) {
  console.error("compile failed:", JSON.stringify(r.diagnostics));
  process.exit(1);
}
const manifest = typeof r.manifest === "string" ? JSON.parse(r.manifest) : r.manifest;
const slot = Object.fromEntries(manifest.map(u => [u.name, u.slot]));

// Four LEDs: two right under the default beam apex (0, 0, 2) and two well off to the side.
// The preview's led.room is led.pos (unposed), so the beam lights by position.
const positions = new Float32Array([0, 0, 0, 0.05, 0, 0, 3, 0, 0, 3, 0.05, 0]);
const N = 4;
const fx = new vm.FxPreview(r.bytecode);
const set = (name, ...v) => fx.set_uniform(slot[name], new Float32Array(v));
// The VM starts with zeroed uniforms; the host (app, firmware) applies the defaults.
for (const u of manifest) if (u.default != null) fx.set_uniform(u.slot, new Float32Array([].concat(u.default)));
set("color", 1.0, 0.6, 0.1);          // amber, as on the demo night
set("idle_color", 0.2, 0.35, 1.0);    // the inactive state's own (blue) colour

const DT = 1 / 60;
let t = 0, frame = 0, seq = 0;
function run(seconds, { beat = false } = {}) {
  let out;
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    if (beat) set("stylus_seq", (seq = seq % 999 + 1));
    fx.update(t, DT, frame++, N);
    t += DT;
    out = fx.shade_all(positions);
  }
  return out;
}
const rgb = (out, i) => [out[3 * i], out[3 * i + 1], out[3 * i + 2]];
const beam = out => { const [r, g, b] = rgb(out, 0); return r > 100 && r > b; };     // amber, bright
const idle = out => {
  const [r, g, b] = rgb(out, 0), [r2, , b2] = rgb(out, 2);
  return b > r && b > 0 && b < 60 && b2 > r2 && b2 > 0;  // dim blue, everywhere
};

let failures = 0;
function check(what, ok, out) {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}  led0=${rgb(out, 0)} led2=${rgb(out, 2)}`);
  if (!ok) failures++;
}

// Startup, the default origin/dir in place and no stylus pose yet: inactive, no beam.
let out = run(0.5);
check("startup without a stylus pose: inactive state, not the default beam", idle(out) && !beam(out), out);

// A healthy fixture tracker does not make the stylus valid.
set("tracker_ok", 1.0);
out = run(0.5);
check("fixture tracker_ok=1, stylus absent: still inactive", idle(out) && !beam(out), out);
set("tracker_ok", 0.0);

// Fresh poses: the driver asserts stylus_ok and bumps the heartbeat every pose.
set("stylus_ok", 1.0);
out = run(0.5, { beat: true });
check("fresh stylus poses: the beam", beam(out), out);
const side = rgb(out, 2);
check("fresh stylus poses: no glow outside the beam", side.every(c => c === 0), out);

// The heartbeat stops but stylus_ok stays 1 (the driver, the network or the viewer died).
out = run(0.3);
check("heartbeat stale 0.3 s (< stale_after 0.5 s): beam held", beam(out), out);
out = run(0.8);
check("heartbeat stale 1.1 s: beam dropped to the inactive state", idle(out) && !beam(out), out);

// Poses resume: the beam comes back with no redeploy.
out = run(0.5, { beat: true });
check("poses resume: beam recovered without a redeploy", beam(out), out);

// The driver drops stylus_ok (its own stale threshold) while the heartbeat value lingers.
set("stylus_ok", 0.0);
out = run(0.6);
check("driver sets stylus_ok=0: inactive", idle(out) && !beam(out), out);
set("stylus_ok", 1.0);
out = run(0.5, { beat: true });
check("stylus_ok back to 1 with fresh poses: beam", beam(out), out);

fx.free();
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
