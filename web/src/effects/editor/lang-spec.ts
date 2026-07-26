/**
 * Single source of truth for the effect language's token vocabulary
 * (docs/design/effects-compiler.md §"lang-spec.ts"): keywords, context idents,
 * built-in function signatures, and types — fixed by the AUTHORITATIVE compiler
 * (fx_compiler/src/lib.rs: `emit_builtin`, `emit_namespace`, and the
 * time/dt/frame globals in `primary`).
 *
 * The compiler is the authority on correctness — this module is consumed by the
 * AI system prompt's built-in table, the syntax highlighter (highlight.ts), and
 * the autocomplete engine (completions.ts). Keeping the vocabulary in one place
 * means adding a built-in updates the prompt AND the editor together, and never
 * describes a built-in the compiler doesn't have.
 */

export const KEYWORDS = [
  "uniform",
  "state",
  "buffer",
  "texture",
  "struct",
  "void",
  "vec2",
  "vec3",
  "vec4",
  "float",
  "int",
  "bool",
  "if",
  "else",
  "for",
  "return",
] as const;

/** One-line docstrings for the control/declaration keywords, for completion
 * detail. Type-name keywords are documented richly in TYPES instead. */
export const KEYWORD_DOCS: Record<string, string> = {
  uniform: "declare a live, user-tweakable parameter with a range + default",
  state: "declare a value persisted across frames (written in update())",
  buffer: "declare a hidden per-LED buffer that persists across frames: `buffer vec3 trail;` then read/write `trail[i]` (i an int LED index)",
  texture: "declare a hidden WxH 2D texture: `texture vec3 img(64, 64);` then `sample(img, uv)` (bilinear) / `paint(img, uv, c)` / flat `img[i]`",
  struct: "declare a composite type: struct Name { float a; vec3 b; };",
  void: "the return type of update() — produces no value",
  return: "return a value from shade() (or exit update())",
  if: "conditional branch",
  else: "the alternative branch of an if",
  for: "bounded loop (compile-time trip count; per-frame budget applies)",
};

/**
 * Global read-only contexts and their members (member access via `.`). Member
 * types + docstrings are verified against fx_compiler `emit_namespace`. `time`,
 * `dt`, `frame` are leaf globals (zero members) from `primary()`.
 */
export const CONTEXTS: {
  name: string;
  doc: string;
  members: { name: string; type: string; doc: string }[];
}[] = [
  { name: "time", doc: "seconds since effect start (float)", members: [] },
  { name: "dt", doc: "seconds since last frame (float)", members: [] },
  { name: "frame", doc: "frame counter (int)", members: [] },
  {
    name: "led",
    doc: "the per-LED input struct (also the shade() parameter)",
    members: [
      { name: "pos", type: "vec3", doc: "LED position in the gravity-leveled, roughly unit-box map frame" },
      { name: "idx", type: "int", doc: "this LED's index" },
      { name: "count", type: "int", doc: "total LED count" },
      { name: "seg", type: "int", doc: "topology segment id, -1 if none" },
      { name: "s", type: "float", doc: "0..1 arclength along the LED's segment" },
      { name: "dist", type: "float", doc: "0..1 geodesic distance from the current source (the topology root by default; call flood_from(node) in update() to re-source it, e.g. to flood from a random endpoint)" },
      { name: "branch", type: "bool", doc: "true at a junction/branch point" },
      { name: "uv", type: "vec2", doc: "per-LED texture coord in 0..1 (this LED's XY position normalized over the map bounds — a top-down projection); feed sample(tex, led.uv)" },
    ],
  },
  {
    name: "imu",
    doc: "inertial context when present",
    members: [
      { name: "accel", type: "vec3", doc: "accelerometer, m/s^2 (when present)" },
      { name: "gyro", type: "vec3", doc: "gyroscope, rad/s (when present)" },
    ],
  },
];

/**
 * Built-in functions with signatures (verbatim into the AI prompt) and a
 * one-line docstring. Covers every function `emit_builtin` accepts.
 */
export const BUILTINS: { sig: string; doc: string }[] = [
  // unary math (UN_MATH)
  { sig: "sin(x)", doc: "sine of x (radians)" },
  { sig: "cos(x)", doc: "cosine of x (radians)" },
  { sig: "tan(x)", doc: "tangent of x (radians)" },
  { sig: "abs(x)", doc: "absolute value" },
  { sig: "floor(x)", doc: "largest integer <= x" },
  { sig: "ceil(x)", doc: "smallest integer >= x" },
  { sig: "fract(x)", doc: "fractional part, x - floor(x)" },
  { sig: "sqrt(x)", doc: "square root" },
  { sig: "exp(x)", doc: "e raised to the power x" },
  { sig: "log(x)", doc: "natural logarithm" },
  { sig: "sign(x)", doc: "-1, 0, or 1 by the sign of x" },
  // binary math (BIN_MATH) — component-wise, equal widths
  { sig: "min(a, b)", doc: "component-wise minimum" },
  { sig: "max(a, b)", doc: "component-wise maximum" },
  { sig: "pow(x, y)", doc: "x raised to the power y" },
  { sig: "mod(x, y)", doc: "modulo (x - y*floor(x/y))" },
  { sig: "step(edge, x)", doc: "0 if x < edge, else 1" },
  { sig: "atan2(y, x)", doc: "angle of the vector (x, y) in radians" },
  // ternary
  { sig: "clamp(x, lo, hi)", doc: "constrain x to the range [lo, hi]" },
  { sig: "mix(a, b, t)", doc: "linear interpolation a*(1-t) + b*t (t scalar)" },
  { sig: "smoothstep(lo, hi, x)", doc: "smooth Hermite 0..1 ramp between lo and hi" },
  // vector
  { sig: "length(v)", doc: "Euclidean length of v" },
  { sig: "distance(a, b)", doc: "distance between points a and b" },
  { sig: "dot(a, b)", doc: "dot product (scalar)" },
  { sig: "cross(a, b)", doc: "cross product of two vec3s" },
  { sig: "normalize(v)", doc: "v scaled to unit length" },
  // hashing / color
  { sig: "hash(x)", doc: "deterministic float hash in [0,1); accepts a float or a vec3" },
  { sig: "hsv2rgb(h, s, v)", doc: "HSV to linear RGB (vec3); also accepts a single vec3" },
  { sig: "palette0(t)", doc: "sample built-in palette 0 at t (vec3)" },
  { sig: "palette1(t)", doc: "sample built-in palette 1 at t (vec3)" },
  { sig: "palette2(t)", doc: "sample built-in palette 2 at t (vec3)" },
  // topology graph queries (agentic/graph-walking effects; args are int indices)
  { sig: "seg_count()", doc: "number of topology segments (int)" },
  { sig: "seg_len(seg)", doc: "arclength of segment `seg` in meters (float)" },
  { sig: "seg_node(seg, side)", doc: "endpoint node id of `seg` (side 0=a, 1=b; int, -1 if free)" },
  { sig: "node_deg(node)", doc: "number of segments incident to `node` (int)" },
  { sig: "node_seg(node, k)", doc: "k-th segment incident to `node` (int segment id) — pick a branch" },
  { sig: "node_side(node, k)", doc: "which end (0=a,1=b) of that k-th segment touches `node` (int)" },
  { sig: "term_count()", doc: "number of termini — degree-1 endpoints of the topology (int)" },
  { sig: "term(k)", doc: "the k-th terminus node id (int, -1 if out of range); pick a random one to flood/spawn from" },
  { sig: "flood_from(node)", doc: "set the geodesic source: `led.dist` then reports distance from `node` (0..1). Call once per cycle in update() — lets Flood/agents start from any endpoint. void" },
  // 2D textures (declare with `texture <elem> name(w, h);`)
  { sig: "sample(tex, uv)", doc: "bilinearly sample 2D texture `tex` at uv (vec2, 0..1, edge-clamped); returns the texture's element type" },
  { sig: "paint(tex, uv, color)", doc: "write `color` to the nearest texel of `tex` at uv (vec2, 0..1); a void statement" },
];

/** Value types accepted by the language, with docstrings for completion. */
export const TYPES: { name: string; doc: string }[] = [
  { name: "float", doc: "32-bit floating point (the default numeric type)" },
  { name: "int", doc: "native 32-bit integer — fast, no soft-float" },
  { name: "fixed", doc: "Q16.16 fixed-point number" },
  { name: "bool", doc: "boolean (true/false)" },
  { name: "vec2", doc: "2-component vector (x, y)" },
  { name: "vec3", doc: "3-component vector (x, y, z / r, g, b)" },
  { name: "vec4", doc: "4-component vector (x, y, z, w / r, g, b, a)" },
  { name: "void", doc: "no value — the return type of update()" },
  { name: "Led", doc: "the per-LED input struct passed to shade()" },
];
