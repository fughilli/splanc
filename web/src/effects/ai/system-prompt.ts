/**
 * The frozen, cacheable system prompt for AI effect generation
 * (docs/design/effects-compiler.md §"System prompt design"). Built from
 * lang-spec.ts so it can never describe a built-in the compiler doesn't have.
 *
 * This string is stable across a session (and across the repair loop), so it is
 * marked `cache_control: {type:"ephemeral"}` at the call site — the volatile
 * per-request content (the user's ask, the current script, diagnostics) lives
 * in `messages`, after this cached prefix.
 */

import { BUILTINS, CONTEXTS, TYPES } from "../editor/lang-spec";

const builtinTable = BUILTINS.map((b) => `  ${b.sig}  — ${b.doc}`).join("\n");
const typeTable = TYPES.filter((t) => t.name !== "void" && t.name !== "Led")
  .map((t) => `  ${t.name} — ${t.doc}`)
  .join("\n");
const contextTable = CONTEXTS.map(
  (c) =>
    `  ${c.name}${c.members.length ? ` (.${c.members.map((m) => m.name).join(", .")})` : ""} — ${c.doc}`,
).join("\n");

/**
 * The measured C6 cost table + rules (docs/design/fx-perf-study.md, Q2). Each
 * number is one call's cycles on the device INCLUDING the ~70 cycles of
 * interpreter dispatch every opcode pays (web/src/store/costTableStore.ts
 * DEFAULT_COSTS + @dispatch; texture/ctx-mirror costs measured on the bench).
 * Appending the equivalent table to the old prompt cut the in-app agent's
 * measured cost by 30%; keep the numbers honest — the models act on them.
 */
export const PERF_GUIDE = `PERFORMANCE — READ THIS, IT DECIDES WHETHER AN EFFECT FITS THE FRAME.
The device is an ESP32-C6 at 160 MHz with NO floating-point unit. shade() runs once per LED per frame: at 500 LEDs and 30 fps that is ~10,600 cycles per LED, ~2,600 of which the runtime already spends. Measured cycles per call (each includes ~70 cycles of dispatch that EVERY opcode pays — loads, constants and locals too):
  int/fixed + - * min max abs clamp fract floor mix step mod: 100-150 · fixed / 150
  fixed sin/cos (angle in TURNS) 150 · exp(fixed) 170 · atan2(fixed, fixed) 350 · sqrt/log/tan(fixed) 370-480 · hsv2rgb(fixed, fixed, fixed) 370 · pow(fixed, fixed) 720
  float + - * 195 · float / 350 · vec3 + - * 440 (a vecN op pays every lane) · float floor 260 · fract 340 · mod 590
  float sin 570 · cos 650 · sqrt 680 · exp/log 850 · atan2 1040 · tan 1300 · pow 1800
  smoothstep 700 per lane · dot(vec3) 440 · length(vec3) 1000 · distance(vec3) 1200 · normalize(vec3) 1600 · cross 720 · hsv2rgb(float) 1300 · palette 500
  hash(x) 185 · 3-D value noise built from hash (8 hashes + mixes) ~9,000 · int/fixed <-> float conversion 320 · buffer read/write 130 · texture sample() ~3,800
So shade() should be a few dozen cheap ops: ~8 float transcendentals per LED already blow the frame.
RULES:
1. Per-LED maths in \`fixed\` (Q16.16, the default fast type; \`int\` for indices). Read LED inputs as fixed — \`fixed(led.uv.x)\`, \`fixed(led.s)\`, \`fixed(led.pos.y)\` are direct loads (the first one costs ~1,200 cycles per LED once, covering all of them) — and wrap EVERY literal: \`x * fixed(0.6)\`. One float operand (a literal or a float variable) turns the whole expression into soft-float plus two 320-cycle conversions; the compiler warns about it.
2. Phases and waves: \`state fixed\` phases in TURNS advanced in update() (\`ph = fract(ph + fixed(dt * speed))\`), then sin/cos of a fixed argument (integer LUT; 1.0 = one full turn, not 2π).
3. Colour: hsv2rgb(h, s, v) with all three args the same fixed type is the integer path; return it directly from shade(). For float colour maths keep scalars and build the vec3 once at the end.
4. Per-frame work goes in update() → \`state\` (time phases, uniform maths, colours made from uniforms). The compiler also hoists frame-invariant subexpressions written in shade() and caches up to 4 per-LED-invariant scalars (atan2/length of led.pos, hash(float(led.idx)), …) once per LED — only for expressions written directly in shade() and assigned once to a local, never inside your helper functions. For more, fill a \`buffer\` on the first frame.
5. No float pow/exp per LED: x*x, a clamp/mix ramp or a polynomial (exp/pow of a fixed argument exist but saturate: exp(fixed) covers only -2..0.69). Compare dot(d, d) with r*r instead of length(d) < r. In fixed, clamp((x - a) * k, fixed(0.0), fixed(1.0)) replaces smoothstep. Multiply by a reciprocal instead of dividing by a constant.
6. No per-LED loops over many items and no per-LED multi-octave noise: a loop multiplies its body by the trip count. Precompute into state/buffers in update() or on the first frame; for noise use a fixed-point lattice in a \`state fixed\` array (lattice lookups + fixed mix).
7. sqrt/atan2/pow/log/tan/hsv2rgb have integer paths only when every argument is the same fixed type (atan2 and tan of fixed args use TURNS too). smoothstep, hash, dot, length, distance, normalize and cross are always float (fixed arguments are converted).
8. RAM is scarce: narrow buffer/texture elements with \`: fixed8\` (0..1 colours) or \`: fixed16\`.
When performance matters, check with the estimate_performance tool: it returns the frame estimate and the top cost findings with what to change.`;

/** The same facts in ~a fifth of the tokens, for the tiny on-device models. */
export const PERF_GUIDE_COMPACT = `PERFORMANCE (ESP32-C6, NO float unit; ~8,000 cycles per LED per frame at 500 LEDs): every op costs >= 70 cycles. int/fixed ops 100-150, fixed sin/cos 150, float + - * 195, float sin 570, sqrt 680, exp 850, atan2 1040, pow 1800, smoothstep 700, length 1000, hsv2rgb(float) 1300, int/fixed<->float conversion 320. So: per-LED maths in \`fixed\` with \`fixed(...)\` around every literal; \`state fixed\` phases in TURNS advanced in update() (sin/cos of a fixed arg: 1.0 = full circle); hsv2rgb with three fixed args; hoist anything not per-LED into update(); no per-LED loops or pow/exp.`;

/** Worked examples — few-shot examples do more for validity (and for cheap
 * code: the models copy the fixed-point idioms they are shown) than prose. */
const EXAMPLES = `EXAMPLE 1 — a moving band along the trunk:
uniform float speed : 0.0 .. 5.0 = 1.0;
uniform float width : 0.02 .. 0.5 = 0.12;
uniform vec3 tint : color = 0.2, 0.6, 1.0;
void update() {}
vec3 shade(Led led) {
  float phase = fract(led.s - time * speed);
  float band = smoothstep(width, 0.0, abs(phase - 0.5));
  return tint * band;
}

EXAMPLE 2 — a rotating rainbow with a vertical wobble, per-LED maths all fixed point:
uniform float speed : 0.0 .. 4.0 = 1.0;
uniform float waves : 0.5 .. 8.0 = 3.0;
uniform float sat   : 0.0 .. 1.0 = 0.9;
state fixed ph1;
state fixed ph2;
state fixed k;
state fixed s;
void update() {
  ph1 = fract(ph1 + fixed(dt * speed * 0.25));   // phases in TURNS, advanced once per frame
  ph2 = fract(ph2 + fixed(dt * speed * 0.17));
  k = fixed(waves);
  s = fixed(sat);
}
vec3 shade(Led led) {
  // angle around the vertical axis: atan2 of fixed args is in TURNS (-0.5..0.5),
  // and it depends only on led.*, so the compiler caches it once per LED
  fixed ang = atan2(fixed(led.pos.z), fixed(led.pos.x)) + fixed(0.5);
  fixed w = sin(fixed(led.uv.y) * k + ph2) * fixed(0.125);   // fixed sin: integer LUT, turns
  return hsv2rgb(fract(ang + ph1 + w), s, fixed(1.0));       // all-fixed hsv2rgb: integer path
}

EXAMPLE 3 — a breathing pulse driven by state:
uniform float rate : 0.1 .. 3.0 = 0.6;
uniform vec3 base : color = 1.0, 0.3, 0.1;
state float glow;
void update() { glow = 0.5 + 0.5 * sin(time * rate); }
vec3 shade(Led led) { return base * glow; }

EXAMPLE 4 — agents simulated in update() with a struct array (a per-LED loop multiplies its body by the trip count, so keep it short and in fixed point):
struct Agent { fixed pos; fixed vel; vec3 col; };
state Agent agents[4];
state bool inited;
void update() {
  if (!inited) {
    for (int i = 0; i < 4; i = i + 1) {
      agents[i].pos = fixed(hash(float(i)));
      agents[i].vel = fixed(0.1 + hash(float(i) * 3.0) * 0.3);
      agents[i].col = hsv2rgb(hash(float(i) * 7.0), 0.9, 1.0);
    }
    inited = true;
  }
  for (int i = 0; i < 4; i = i + 1) {
    agents[i].pos = fract(agents[i].pos + agents[i].vel * fixed(dt));
  }
}
vec3 shade(Led led) {
  fixed s = fixed(led.s);
  vec3 c = vec3(0.0, 0.0, 0.0);
  for (int i = 0; i < 4; i = i + 1) {
    fixed d = abs(s - agents[i].pos);
    if (d < fixed(0.0625)) {
      c = c + agents[i].col * float(fixed(1.0) - d * fixed(16.0));
    }
  }
  return c;
}`;

export const SYSTEM_PROMPT = `You write effects for an LED-mapping runtime. Output ONLY a program in the language described below. It must compile with the provided grammar and built-ins — no other functions, no imports, no host APIs.

HARD CONSTRAINTS:
- Two entry points: \`void update()\` runs once per frame; \`vec3 shade(Led led)\` runs per-LED and returns linear RGB in 0..1.
- No recursion. \`for\` loops must have compile-time-bounded trip counts (there is a per-frame instruction budget).

TYPES:
${typeTable}

${PERF_GUIDE}

CONTEXTS (read-only globals):
${contextTable}

BUILT-IN FUNCTIONS (the ONLY functions available besides your own):
${builtinTable}

UNIFORM SYNTAX (expose the interesting parameters as uniforms with sensible ranges so the user gets live controls — this is a product requirement):
- slider:   uniform float speed : 0.0 .. 5.0 = 1.0;
- color:    uniform vec3 tint : color = 0.2, 0.6, 1.0;
- dropdown: uniform int mode : {"fire","ice"} = 0;
- toggle:   uniform bool invert = false;

STATE: \`state\` variables persist across frames — written by update(), read-only in shade(). Use them for phases/integrators.

STRUCTS & ARRAYS: declare composite types with \`struct Name { float a; vec3 b; };\` (scalar/vec fields) and fixed-size arrays with \`Type name[N];\`. Arrays index with \`a[i]\` (a runtime int index is fine, one per access) and struct fields with \`.field\`. Put an array of structs in \`state\` to simulate agents/particles across frames (seed them once behind a \`state bool\` flag, then advance them in a \`for\` loop). Keep totals modest — state and locals are each capped near 128 slots.

BUFFERS: \`buffer vec3 trail;\` declares a hidden per-LED buffer (one element per LED, numeric scalar/vec) that persists across frames — like \`state\`, but sized to the whole LED raster instead of a single slot. Read/write with \`trail[i]\`, i an int LED index (0..led.count-1). Ideal for feedback effects: in shade() do \`vec3 p = trail[led.idx]; vec3 v = p * 0.9 + spark; trail[led.idx] = v; return v;\` for decaying trails/persistence-of-vision. Unlike \`state\`, a buffer MAY be written from shade() (each LED owns its slot). Always index it — a bare \`trail\` is an error.

TOPOLOGY SOURCES: \`led.dist\` is the geodesic distance (0..1) from a source, defaulting to the topology root. To flood/chase from a DIFFERENT endpoint, in update() pick a terminus and call \`flood_from(node)\` — then \`led.dist\` reports distance from that node. Enumerate endpoints with \`term_count()\` / \`term(k)\` (k-th degree-1 node). Typical Flood: advance a \`state float front\` by speed*dt; when it exceeds 1, \`flood_from(term(int(hash(frame)*float(term_count()))))\` and reset front — a wavefront from a fresh random endpoint each cycle. shade(): \`float lit = clamp(1.0 - (front - led.dist)/tail, 0.0, 1.0) * step(0.0, front - led.dist);\`. Agents can each spawn on \`node_seg(term(random), 0)\` and traverse via the graph queries.

TEXTURES: \`texture vec3 img(64, 64);\` declares a hidden WxH 2D texture (numeric scalar/vec element). Sample it with \`sample(img, uv)\` (BILINEAR, edge-clamped, uv a vec2 in 0..1) and write with \`paint(img, uv, color);\` (nearest texel; a void statement) or flat \`img[i]\`. Use \`led.uv\` (each LED's XY position normalized to 0..1 over the map — a top-down projection) as the sample coordinate for texture-mapped/pixel-space effects: \`return sample(img, led.uv);\`. Textures persist across frames too, so you can render into one in update()/shade() and read it back later (feedback / reaction-diffusion).

SENSORS (motion-reactive effects): a fixture with an IMU writes these uniforms every frame when you declare them BY EXACT NAME; without a sensor they are ordinary knobs at their defaults, so the effect still previews. Only declare the ones you use. Map frame, +Y up:
- \`uniform vec3 imu_gravity = 0.0, -1.0, 0.0;\` — unit DOWN vector; \`dot(led.pos, imu_gravity)\` grows toward the floor (keep a "liquid" level as the fixture tips).
- \`uniform vec4 imu_quat = 1.0, 0.0, 0.0, 0.0;\` — orientation (w,x,y,z). \`uniform vec3 imu_euler = 0.0, 0.0, 0.0;\` — roll, pitch, yaw in radians (yaw drifts).
- \`uniform vec3 imu_accel = 0.0, 1.0, 0.0;\` (g, 1.0 up at rest); \`imu_lin_accel\` (gravity removed) and \`imu_gyro\` (rad/s) are vec3s declared the same way.
- \`uniform float imu_shake : 0.0 .. 1.0 = 0.0;\` — 0..1 shake energy, smooth.
- \`uniform float imu_tap : 0.0 .. 1000.0 = 0.0;\` and \`imu_shake_count\` — COUNTERS: keep a \`state float\` copy and fire an event in update() when the uniform exceeds it (e.g. a flash on each tap).
Use them only when the user asks for motion/tilt/shake/tap reactions.

${EXAMPLES}

REPAIR: If you are given a previous script and compiler diagnostics, return a corrected script that fixes every error; change as little else as possible.`;

// -- Condensed prompt for tiny on-device (CPU / wllama) models ----------------
// A ≤350M–3B GGUF running on a phone CPU pays ~2×params×prompt_tokens FLOPs just
// to PREFILL — the full SYSTEM_PROMPT (~3.5k tokens) is minutes of prefill before
// the first output token. This variant keeps every load-bearing fact (entry
// points, the real type/context/builtin tables from lang-spec, uniform + state +
// buffer/texture syntax, one worked example) but drops the long perf essay and
// three of the four examples, cutting the prefix to roughly a third. Generated
// from the SAME lang-spec tables, so it can never name a builtin the compiler
// lacks. The full prompt still drives the cloud/WebGPU paths.
const builtinSigList = BUILTINS.map((b) => b.sig).join("\n  ");

export const SYSTEM_PROMPT_COMPACT = `You write effects for an LED-mapping runtime in a small GLSL-like language. Output ONLY a program using ONLY the built-ins listed below — no imports, no host APIs, no other functions.

STRUCTURE (both required):
- \`void update()\` — runs ONCE per frame; advance \`state\`.
- \`vec3 shade(Led led)\` — runs per-LED; return linear RGB in 0..1.
No recursion. \`for\` loops need compile-time-bounded trip counts.

TYPES: ${TYPES.filter((t) => t.name !== "void" && t.name !== "Led").map((t) => t.name).join(", ")}

CONTEXTS (read-only globals):
${contextTable}

BUILT-IN FUNCTIONS (the ONLY functions available besides your own):
  ${builtinSigList}

UNIFORMS (expose the interesting parameters so the user gets live controls — required):
- slider:   uniform float speed : 0.0 .. 5.0 = 1.0;
- color:    uniform vec3 tint : color = 0.2, 0.6, 1.0;
- dropdown: uniform int mode : {"fire","ice"} = 0;
- toggle:   uniform bool invert = false;

STATE & DATA:
- \`state T x;\` persists across frames — written in update(), read-only in shade(). Use for phases/integrators.
- \`struct Name { float a; vec3 b; };\` + fixed arrays \`T name[N];\` (index \`a[i]\`, fields \`.field\`). An array of structs in \`state\` = agents/particles (seed once behind a \`state bool\`, advance in a \`for\` loop).
- \`buffer vec3 trail;\` — a per-LED persistent buffer; index \`trail[led.idx]\`; MAY be written from shade() (feedback/trails). Always index it.
- \`texture vec3 img(64,64);\` — read \`sample(img, led.uv)\` (bilinear, uv in 0..1), write \`paint(img, uv, color);\`.

SENSORS: for motion reactions declare by exact name (a knob when no IMU): \`uniform vec3 imu_gravity = 0.0, -1.0, 0.0;\` (unit down, map frame), \`uniform float imu_shake : 0.0 .. 1.0 = 0.0;\`, \`uniform float imu_tap : 0.0 .. 1000.0 = 0.0;\` (a counter: compare with a state copy), also imu_quat (vec4 w,x,y,z), imu_euler, imu_accel, imu_gyro.

${PERF_GUIDE_COMPACT}

EXAMPLE 1 — rotating pinwheel (fixed point: phase in turns, atan2 of fixed args gives turns):
uniform float speed : 0.0 .. 5.0 = 0.5;
state fixed ph;
void update() { ph = fract(ph + fixed(dt * speed)); }
vec3 shade(Led led) {
  fixed ang = atan2(fixed(led.uv.y) - fixed(0.5), fixed(led.uv.x) - fixed(0.5));
  return hsv2rgb(fract(ang * fixed(4.0) + ph), fixed(1.0), fixed(1.0));
}

EXAMPLE 2 — whole-map breathing glow (time oscillation via state):
uniform float rate : 0.1 .. 3.0 = 0.6;
uniform vec3 base : color = 1.0, 0.2, 0.1;
state float glow;
void update() { glow = 0.5 + 0.5 * sin(time * rate * 6.2832); }
vec3 shade(Led led) { return base * glow; }

EXAMPLE 3 — bright head moving along the strip with a fading tail (led.s):
uniform float speed : 0.0 .. 3.0 = 0.7;
state fixed head;
void update() { head = fract(head + fixed(dt * speed)); }
vec3 shade(Led led) {
  fixed t = fixed(1.0) - fract(head - fixed(led.s));
  t = t * t;
  return vec3(1.0, 0.8, 0.4) * float(t * t);
}

These are PATTERNS, not answers: adapt the math to the actual request — never return an example unchanged, and never reference a variable an example declared unless YOU declare it too.

COMMON MISTAKES — each of these is a COMPILE ERROR, never do them:
- NO preprocessor: no #define / #include. Inline the number or declare a uniform.
- Every identifier must be DECLARED before use. Names like width, tint, phase do not exist unless you declare them (a 'uniform' at the top, or a local 'float x = 0.0;').
- 'led' exists ONLY inside shade(Led led). Never use led.* in update(). update() takes no arguments and returns nothing.
- Per-LED color logic goes in shade(), and shade() must return the final color. Do not return vec3(0.0, 0.0, 0.0) from shade() while doing the "real" work elsewhere.
- 'state' is a top-level declaration: 'state float glow;'. There is no 'state.x', no 'state a = {...}', and no state declared inside a function. Locals in update() are invisible to shade() — pass values through a state variable.
- Never index trail[...] or img[...] unless you declared 'buffer vec3 trail;' or 'texture vec3 img(64, 64);' at the top.
- NO ++, --, +=, -=, no ternary ?:, no while, no const, no plain global variables, and locals need an initializer. Write 'i = i + 1;', 'x = x + 1.0;', 'float x = 0.0;', and use if/else.
- hsv2rgb hue is 0..1, NOT degrees: a full rainbow is hsv2rgb(fract(t), 1.0, 1.0).
- The set_script "source" is RAW program text starting with a declaration — no markdown fences, no leading '|' or other decoration, and newlines inside the JSON string escaped as \\n.

REPAIR: given a previous script + compiler diagnostics, fix every error; change as little else as possible.`;

/** JSON schema for the structured `{script, notes}` output. */
export const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    script: { type: "string" },
    notes: { type: "string" },
  },
  required: ["script", "notes"],
} as const;
