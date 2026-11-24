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
  "shared",
  "export",
  "buffer",
  "texture",
  "struct",
  "void",
  "vec2",
  "vec3",
  "vec4",
  "mat3",
  "mat4",
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
  shared: "qualifies a state: `shared state float phase;` — a fixture that rejoins a mesh takes it from the gateway (plain `state` stays this fixture's own)",
  export: "a driver's output, written by poll(): `export float temperature \"°C\";` or `export trigger tap;` (bumped with fire(tap))",
  buffer: "declare a hidden per-LED buffer that persists across frames: `buffer vec3 trail;` then read/write `trail[i]` (i an int LED index). Pack narrow to save RAM: `buffer fixed8 t;` (1 B/LED) or `buffer vec3 c : fixed8;` (3 B/LED, read/written as float)",
  texture: "declare a hidden WxH 2D texture: `texture vec3 img(64, 64);` then `sample(img, uv)` (bilinear, always float) / `paint(img, uv, c)` / flat `img[i]`. Add `: fixed8` / `: fixed16` to compress storage (e.g. `texture vec3 img(64,64) : fixed8;`)",
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
      { name: "room", type: "vec3", doc: "LED position in the shared room frame (metres; the fixture's room pose applied) — the same space on every fixture" },
    ],
  },
  {
    name: "room",
    doc: "the room frame's bounds over every posed fixture",
    members: [
      { name: "min", type: "vec3", doc: "room-frame minimum corner (metres)" },
      { name: "max", type: "vec3", doc: "room-frame maximum corner (metres)" },
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
  { sig: "sin(x)", doc: "sine of x (radians); on a fixed arg the angle is in TURNS (1.0 = full circle) and it is an integer LUT, ~4x cheaper" },
  { sig: "cos(x)", doc: "cosine of x (radians); on a fixed arg: TURNS, integer LUT" },
  { sig: "tan(x)", doc: "tangent of x (radians); on a fixed arg: TURNS" },
  { sig: "abs(x)", doc: "absolute value" },
  { sig: "floor(x)", doc: "largest integer <= x" },
  { sig: "ceil(x)", doc: "smallest integer >= x" },
  { sig: "fract(x)", doc: "fractional part, x - floor(x)" },
  { sig: "sqrt(x)", doc: "square root" },
  { sig: "exp(x)", doc: "e raised to the power x (a fixed arg is an integer LUT covering only -2..0.69)" },
  { sig: "log(x)", doc: "natural logarithm" },
  { sig: "sign(x)", doc: "-1, 0, or 1 by the sign of x" },
  // binary math (BIN_MATH) — component-wise, equal widths
  { sig: "min(a, b)", doc: "component-wise minimum" },
  { sig: "max(a, b)", doc: "component-wise maximum" },
  { sig: "pow(x, y)", doc: "x raised to the power y" },
  { sig: "mod(x, y)", doc: "modulo (x - y*floor(x/y))" },
  { sig: "step(edge, x)", doc: "0 if x < edge, else 1" },
  { sig: "atan(y)", doc: "arctangent (radians); atan(y, x) is atan2(y, x)" },
  { sig: "atan2(y, x)", doc: "angle of the vector (x, y) in radians; with two args of the same fixed type: in TURNS (-0.5..0.5), integer path" },
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
  { sig: "hash(x)", doc: "deterministic float hash in [0,1); accepts a float or a vec3 (always float maths)" },
  { sig: "hsv2rgb(h, s, v)", doc: "HSV to linear RGB (vec3), hue 0..1; also accepts a single vec3. Three args of the same fixed type take the integer path (return that colour directly from shade())" },
  { sig: "rgb(r, g, b)", doc: "a colour from 3 channels of the same fixed type (e.g. fixed16): returned from shade() with no float round trip" },
  { sig: "rgb8(r, g, b)", doc: "a colour from 3 int channels in 0..255, returned from shade() as is" },
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
  // matrices (mat3 / mat4; also * + - /, m[c] and m[c][r])
  { sig: "transpose(m)", doc: "the transpose of a mat3 or mat4" },
  { sig: "transform(m, p)", doc: "affine point transform: (m * vec4(p, 1)).xyz for (mat4, vec3), or (mat3, vec2) in 2D — cheaper than the full product" },
  // triggers (`uniform trigger tap;`, fed by a driver's `export trigger`)
  { sig: "fired(tap)", doc: "true once per change of a `uniform trigger` (update() only): react to a tap or button press" },
  { sig: "paint(tex, uv, color)", doc: "write `color` to the nearest texel of `tex` at uv (vec2, 0..1); a void statement" },
];

/**
 * Built-ins only a driver's poll() may call (docs/design/lamp-power.md, FUG-107). Kept
 * out of BUILTINS so the effect prompt never offers them; the editor still highlights
 * them.
 */
export const DRIVER_BUILTINS: { sig: string; doc: string }[] = [
  { sig: "fire(tap)", doc: "bump an `export trigger` (a driver's poll())" },
  { sig: "gpio_read(pin)", doc: "read a GPIO pin: 0 / 1, -1 when unavailable (poll() only)" },
  { sig: "gpio_mode(pin, mode)", doc: "set a pin's mode: 0 input, 1 pull-up, 2 pull-down (poll() only)" },
  { sig: "i2c_write(addr, reg, value)", doc: "write a register over I2C (poll() only)" },
  { sig: "i2c_read8(addr, reg)", doc: "read an 8-bit I2C register (poll() only)" },
  { sig: "i2c_read16(addr, reg)", doc: "read a 16-bit I2C register, unsigned (poll() only)" },
  { sig: "i2c_read16s(addr, reg)", doc: "read a 16-bit I2C register, signed (poll() only)" },
];

/** Value types accepted by the language, with docstrings for completion. */
export const TYPES: { name: string; doc: string }[] = [
  { name: "float", doc: "32-bit floating point (the default numeric type)" },
  { name: "int", doc: "native 32-bit integer — fast, no soft-float" },
  { name: "fixed", doc: "Q16.16 fixed-point number — native integer arithmetic, the fast type for per-LED maths (sin/cos take TURNS on it); literals: x * 0.5fx (= fixed(0.5))" },
  { name: "fixed16", doc: "Q1.14 reduced-precision fixed-point, range [-2, 2) — integer arithmetic like fixed, sin/cos in turns; overflows past ±2; literals: 0.5fx16" },
  { name: "fixed8", doc: "Q1.6 reduced-precision fixed-point, range [-2, 2) — mainly for compact buffer/texture storage (: fixed8); literals: 0.5fx8" },
  { name: "bool", doc: "boolean (true/false)" },
  { name: "vec2", doc: "2-component vector (x, y)" },
  { name: "vec3", doc: "3-component vector (x, y, z / r, g, b)" },
  { name: "vec4", doc: "4-component vector (x, y, z, w / r, g, b, a)" },
  { name: "mat3", doc: "3x3 float matrix, column-major (GLSL): mat3(1.0) is the identity; m * v, m[c], m[c][r], transpose(m)" },
  { name: "mat4", doc: "4x4 float matrix, column-major (GLSL): mat4(1.0) is the identity; m * v, transform(m, p) for points" },
  { name: "trigger", doc: "a press/tap counter: `uniform trigger tap;` then `if (fired(tap))` in update() (a driver feeds it)" },
  { name: "void", doc: "no value — the return type of update()" },
  { name: "Led", doc: "the per-LED input struct passed to shade()" },
];
