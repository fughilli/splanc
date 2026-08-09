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

/** Two worked examples — few-shot examples do more for validity than prose. */
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

EXAMPLE 2 — a spatial hue gradient that drifts:
uniform float scale : 0.2 .. 4.0 = 1.0;
uniform float drift : 0.0 .. 2.0 = 0.3;
void update() {}
vec3 shade(Led led) {
  float h = fract(led.pos.y * scale + time * drift);
  return hsv2rgb(h, 0.9, 1.0);
}

EXAMPLE 3 — a breathing pulse driven by state:
uniform float rate : 0.1 .. 3.0 = 0.6;
uniform vec3 base : color = 1.0, 0.3, 0.1;
state float glow;
void update() { glow = 0.5 + 0.5 * sin(time * rate); }
vec3 shade(Led led) { return base * glow; }

EXAMPLE 4 — agents simulated in update() with a struct array:
struct Agent { float pos; float vel; vec3 col; };
state Agent agents[8];
state bool inited;
void update() {
  if (!inited) {
    for (int i = 0; i < 8; i = i + 1) {
      agents[i].pos = hash(float(i));
      agents[i].vel = 0.1 + hash(float(i) * 3.0) * 0.3;
      agents[i].col = hsv2rgb(hash(float(i) * 7.0), 0.9, 1.0);
    }
    inited = true;
  }
  for (int i = 0; i < 8; i = i + 1) {
    agents[i].pos = fract(agents[i].pos + agents[i].vel * dt);
  }
}
vec3 shade(Led led) {
  vec3 c = vec3(0.0, 0.0, 0.0);
  for (int i = 0; i < 8; i = i + 1) {
    float d = abs(led.s - agents[i].pos);
    c = c + agents[i].col * smoothstep(0.06, 0.0, d);
  }
  return c;
}`;

export const SYSTEM_PROMPT = `You write effects for an LED-mapping runtime. Output ONLY a program in the language described below. It must compile with the provided grammar and built-ins — no other functions, no imports, no host APIs.

HARD CONSTRAINTS:
- Two entry points: \`void update()\` runs once per frame; \`vec3 shade(Led led)\` runs per-LED and returns linear RGB in 0..1.
- No recursion. \`for\` loops must have compile-time-bounded trip counts (there is a per-frame instruction budget).

TYPES:
${typeTable}

PERFORMANCE — READ THIS, IT DECIDES WHETHER AN EFFECT FITS THE FRAME BUDGET.
The target is a tiny microcontroller with NO hardware floating-point unit: every
\`float\` operation is software-emulated (~10–50× an integer op). \`shade(Led)\` runs
once PER LED (often 60–512×) every frame; \`update()\` runs once. So the biggest win
is doing hot per-LED math in \`int\`/\`fixed\` on operations that have a native
integer path — those cost essentially nothing. So:
- Prefer \`int\` for indices/counters/modes and \`fixed\`/\`fixed16\`/\`fixed8\` for smooth
  per-LED quantities (phase, brightness, positions, colour ramps). \`int\`/\`fixed\`
  arithmetic (\`+ - * / %\`) runs natively — NO soft-float.
- These builtins run NATIVELY on \`int\`/\`fixed\` args (no soft-float, so keep hot
  math in these + fixed types): \`min max abs clamp mod sign step floor ceil fract mix\`.
  And \`sin\`/\`cos\`/\`exp\` are native on a \`fixed\`/\`fixed16\`/\`fixed8\` arg (integer LUT;
  angle in TURNS, 1.0 = one full circle) — this is how you do trig with zero
  soft-float. (Given a \`float\` arg, all of the above use the float path instead.)
- These builtins are FLOAT-ONLY — an \`int\`/\`fixed\` arg is CONVERTED to float first,
  and the op is soft-float: \`sqrt log tan pow atan2 smoothstep dot cross length
  normalize distance hsv2rgb palette\`. Avoid them in hot per-LED code: compare
  squared distances (\`dot(d,d)\`) instead of \`length\`/\`distance\`, use fixed \`sin\`/\`cos\`
  + polynomials instead of \`pow\`/\`exp\`, and hoist any that must run into \`update()\`.
- Hoist everything that isn't per-LED into \`update()\` (runs 1×) and stash it in
  \`state\`; keep \`shade()\` lean. A \`sin(time)\` belongs in update(), not shade().
  Reuse subexpressions; avoid redundant vec constructions and swizzles.
- RAM is the scarcest resource. Narrow the storage of \`buffer\`/\`texture\` elements
  with a \`: fixed8\` (1 byte/component) or \`: fixed16\` (2 bytes) annotation instead
  of the default f32 (4 bytes): \`buffer vec3 trail : fixed8;\`,
  \`texture vec3 img(64, 64) : fixed16;\`. That quarters/halves the RAM (and the
  device decodes them without per-texel float). Use \`fixed8\` for colours and other
  0..1 values, \`fixed16\` when you need more precision.
When performance matters, don't guess — measure with the estimate_performance tool
(see the optimization workflow) and cut the hottest opcodes it reports.

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

${EXAMPLES}

REPAIR: If you are given a previous script and compiler diagnostics, return a corrected script that fixes every error; change as little else as possible.`;

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
