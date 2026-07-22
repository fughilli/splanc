/**
 * Single source of truth for the effect language's token vocabulary
 * (docs/design/effects-compiler.md §"lang-spec.ts"): keywords, context idents,
 * and built-in function signatures fixed by docs/design/effects-runtime.md.
 *
 * The compiler is the authority on correctness — this is used only to build the
 * AI system prompt's built-in table (and, later, syntax highlighting +
 * autocomplete). Keeping it in one module means adding a built-in updates the
 * prompt and the editor together, and never describes a built-in the compiler
 * doesn't have.
 */

export const KEYWORDS = [
  "uniform",
  "state",
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

/** Global read-only contexts and their members (member access via `.`). */
export const CONTEXTS: { name: string; members: string[]; doc: string }[] = [
  { name: "time", members: [], doc: "seconds since effect start (float)" },
  { name: "dt", members: [], doc: "seconds since last frame (float)" },
  { name: "frame", members: [], doc: "frame counter (int)" },
  {
    name: "led",
    members: ["pos", "idx", "count", "seg", "s", "branch"],
    doc: "per-LED context: pos (vec3, gravity-leveled unit-ish box), idx, count, seg, s (arclength), branch",
  },
  {
    name: "imu",
    members: ["accel", "gyro"],
    doc: "inertial context when present: accel (vec3), gyro (vec3)",
  },
];

/** Built-in functions with signatures (verbatim into the AI prompt). */
export const BUILTINS: { sig: string; doc: string }[] = [
  { sig: "sin(x)", doc: "sine" },
  { sig: "cos(x)", doc: "cosine" },
  { sig: "tan(x)", doc: "tangent" },
  { sig: "abs(x)", doc: "absolute value" },
  { sig: "floor(x)", doc: "round down" },
  { sig: "ceil(x)", doc: "round up" },
  { sig: "fract(x)", doc: "fractional part" },
  { sig: "mod(x, y)", doc: "modulo" },
  { sig: "min(a, b)", doc: "minimum" },
  { sig: "max(a, b)", doc: "maximum" },
  { sig: "clamp(x, lo, hi)", doc: "clamp x to [lo, hi]" },
  { sig: "mix(a, b, t)", doc: "linear interpolation" },
  { sig: "step(edge, x)", doc: "0 if x < edge else 1" },
  { sig: "smoothstep(lo, hi, x)", doc: "smooth Hermite interpolation" },
  { sig: "length(v)", doc: "vector length" },
  { sig: "distance(a, b)", doc: "distance between points" },
  { sig: "dot(a, b)", doc: "dot product" },
  { sig: "cross(a, b)", doc: "cross product (vec3)" },
  { sig: "normalize(v)", doc: "unit vector" },
  { sig: "pow(x, y)", doc: "x to the power y" },
  { sig: "exp(x)", doc: "e^x" },
  { sig: "log(x)", doc: "natural log" },
  { sig: "sqrt(x)", doc: "square root" },
  { sig: "sign(x)", doc: "-1, 0, or 1" },
  { sig: "hash11(x)", doc: "float->float hash in [0,1)" },
  { sig: "hash31(v)", doc: "vec3->float hash in [0,1)" },
  { sig: "hsv2rgb(h, s, v)", doc: "HSV to linear RGB (vec3)" },
  { sig: "palette_lookup(t)", doc: "sample the built-in palette at t in [0,1] (vec3)" },
];
