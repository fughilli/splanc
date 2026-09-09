/**
 * Template library for the retrieval+modification experiment (exp_template.ts).
 *
 * Sources are the app's KNOWN-GOOD builtin starter effects, lifted from
 * web/src/store/seedEffects.ts (+ web/src/color/colorTestEffect.ts), with
 * explanatory comments trimmed (prompt-token economy; the code is unchanged).
 * exp_template.ts re-verifies every template against the real fx_compile at
 * startup, so a template that drifts out of sync with the compiler fails fast.
 *
 * Retrieval is a hand-tuned keyword heuristic: each template carries honest
 * descriptive keywords (weight 2 for strong signals); the ask is matched by
 * lowercase substring (cheap stemming: "breath" hits breathes/breathing), the
 * highest score wins, ties break by library order, and a zero-score ask falls
 * back to the smallest template (breathing-pulse — least code to mislead).
 * GOLD_RETRIEVAL is the hand-labeled set of acceptable templates per eval task,
 * used to score BOTH retrieval options (heuristic and model-as-picker).
 */

export interface Template {
  id: string;
  name: string;
  /** One-line description of what it renders (shown to the model-as-picker). */
  description: string;
  /** kw → weight; matched as lowercase substrings of the ask. */
  keywords: Record<string, number>;
  source: string;
}

export const TEMPLATES: Template[] = [
  {
    id: "color-test",
    name: "Two-tone gradient",
    description:
      "Static linear gradient blending between two colors across a span of the strip; LEDs outside the span are off.",
    keywords: { gradient: 2, between: 1, blend: 1, "two-tone": 1, span: 1 },
    source: `uniform vec3 colorA : color = 1.0, 0.0, 0.0;
uniform vec3 colorB : color = 0.0, 0.0, 1.0;
uniform float start : 0.0 .. 255.0 = 0.0;
uniform float span : 1.0 .. 256.0 = 10.0;

vec3 shade(Led led) {
  float t = clamp((led.idx - start) / max(span - 1.0, 1.0), 0.0, 1.0);
  float lit = step(start, led.idx) * step(led.idx, start + span - 1.0);
  return mix(colorA, colorB, t) * lit;
}
`,
  },
  {
    id: "rainbow-sweep",
    name: "Rainbow sweep",
    description:
      "Full rainbow of hues spread across the map by position, scrolling/sweeping over time.",
    keywords: { rainbow: 2, sweep: 2, spectrum: 1, hue: 1, colorful: 1 },
    source: `uniform float scale : 0.2 .. 4.0 = 1.0;
uniform float drift : 0.0 .. 2.0 = 0.3;

void update() {}

vec3 shade(Led led) {
  float h = fract(led.pos.y * scale + time * drift);
  return hsv2rgb(h, 0.9, 1.0);
}
`,
  },
  {
    id: "breathing-pulse",
    name: "Breathing pulse",
    description:
      "The whole map glows one warm color whose brightness smoothly pulses brighter and dimmer with a sine of time.",
    keywords: { breath: 2, brighter: 1, dimmer: 1, warm: 1, glow: 1 },
    source: `uniform float rate : 0.1 .. 3.0 = 0.6;
uniform vec3 base : color = 1.0, 0.3, 0.1;
state float glow;

void update() { glow = 0.5 + 0.5 * sin(time * rate); }

vec3 shade(Led led) { return base * glow; }
`,
  },
  {
    id: "comet",
    name: "Comet along the run",
    description:
      "A single bright band of color that travels/wipes along the strip over time, wrapping around to start again.",
    keywords: { comet: 2, travel: 1, moving: 1, wipe: 1, chase: 1 },
    source: `uniform float speed : 0.0 .. 5.0 = 1.0;
uniform float width : 0.02 .. 0.5 = 0.12;
uniform vec3 tint : color = 0.2, 0.6, 1.0;

void update() {}

vec3 shade(Led led) {
  float phase = fract(led.s - time * speed);
  float band = smoothstep(width, 0.0, abs(phase - 0.5));
  return tint * band;
}
`,
  },
  {
    id: "flood",
    name: "Flood",
    description:
      "A wavefront fills the whole structure outward from an endpoint following the wiring, then restarts from another endpoint.",
    keywords: { flood: 2, fill: 1, outward: 1, spread: 1 },
    source: `uniform float speed : 0.05 .. 2.0 = 0.35;
uniform float tail : 0.05 .. 0.6 = 0.25;
uniform vec3 tint : color = 0.2, 0.7, 1.0;
uniform float rainbow : 0.0 .. 1.0 = 0.0;

state float front;
state int started;

void update() {
  if (started == 0) { started = 1; flood_from(term(0)); front = 0.0; }
  front = front + speed * dt;
  if (front > 1.0 + tail) {
    int tc = term_count();
    int k = 0;
    if (tc > 0) { k = int(hash(float(frame) * 0.017) * float(tc)); }
    if (k >= tc) { k = 0; }
    flood_from(term(k));
    front = 0.0;
  }
}

vec3 shade(Led led) {
  float reached = front - led.dist;
  float lit = clamp(1.0 - reached / tail, 0.0, 1.0) * step(0.0, reached);
  vec3 hue = hsv2rgb(led.dist, 0.9, 1.0);
  vec3 col = tint * (1.0 - rainbow) + hue * rainbow;
  return col * lit;
}
`,
  },
  {
    id: "pulse",
    name: "Pulse",
    description:
      "Several evenly staggered glowing wavefronts ripple outward along the strands by distance from the root.",
    keywords: { ripple: 1, wave: 1, wavefront: 1 },
    source: `uniform float speed : 0.05 .. 2.0 = 0.4;
uniform float width : 0.02 .. 0.35 = 0.1;
uniform int agents : 1 .. 6 = 2;
uniform vec3 tint : color = 1.0, 0.4, 0.1;
uniform float rainbow : 0.0 .. 1.0 = 1.0;

state float head;

void update() { head = time * speed; }

vec3 shade(Led led) {
  float v = 0.0;
  float inv = 1.0 / float(agents);
  for (int k = 0; k < 6; k = k + 1) {
    if (k < agents) {
      float p = fract(head + float(k) * inv);
      float d = abs(led.dist - p);
      v = max(v, smoothstep(width, 0.0, d));
    }
  }
  vec3 hue = hsv2rgb(led.dist, 0.9, 1.0);
  vec3 col = tint * (1.0 - rainbow) + hue * rainbow;
  return col * v;
}
`,
  },
  {
    id: "trails",
    name: "Trails",
    description:
      "A moving spark on a mostly dark background leaves a fading, decaying trail behind it (per-LED feedback buffer).",
    keywords: { trail: 2, fad: 1, tail: 1, decay: 1, spark: 1, dark: 1 },
    source: `uniform float decay : 0.5 .. 0.98 = 0.85;
uniform float speed : 0.0 .. 4.0 = 1.2;
uniform float width : 0.02 .. 0.3 = 0.08;
uniform vec3 tint : color = 0.2, 0.8, 1.0;
uniform float rainbow : 0.0 .. 1.0 = 0.6;

buffer float trail;

state float head;

void update() { head = fract(time * speed * 0.2); }

vec3 shade(Led led) {
  float spark = smoothstep(width, 0.0, abs(led.dist - head));
  float v = max(trail[led.idx] * decay, spark);
  trail[led.idx] = v;
  vec3 hue = hsv2rgb(led.dist, 0.85, 1.0);
  vec3 col = tint * (1.0 - rainbow) + hue * rainbow;
  return col * v;
}
`,
  },
  {
    id: "texture-map",
    name: "Texture map",
    description:
      "Bakes a radial two-color pattern into a 2D texture centered on the map and samples it per LED by uv position.",
    keywords: { texture: 2, image: 1, picture: 1, center: 1, radial: 1, circle: 1 },
    source: `texture vec3 tex(24, 24);
state bool baked;
uniform vec3 a : color = 0.1, 0.2, 0.8;
uniform vec3 b : color = 1.0, 0.6, 0.1;

void update() {
  if (!baked) {
    for (int y = 0; y < 24; y = y + 1) {
      for (int x = 0; x < 24; x = x + 1) {
        float fx = float(x) / 23.0;
        float fy = float(y) / 23.0;
        float d = distance(vec2(fx, fy), vec2(0.5, 0.5)) * 2.0;
        tex[y * 24 + x] = a * (1.0 - d) + b * d;
      }
    }
    baked = true;
  }
}

vec3 shade(Led led) { return sample(tex, led.uv); }
`,
  },
];

/** Hand-labeled acceptable retrieval targets per eval task (task id → template
 * ids a reasonable engineer would hand a modifier). Used to score retrieval. */
export const GOLD_RETRIEVAL: Record<string, string[]> = {
  pinwheel: ["rainbow-sweep", "texture-map"], // FAR: no angular template; hue-mapping or uv-center are the sane starts
  "breathing-red": ["breathing-pulse"],
  "rainbow-sweep": ["rainbow-sweep"],
  comet: ["comet", "trails"],
  fire: ["breathing-pulse", "trails"], // FAR: warm base color is the only overlap
  twinkle: ["trails"], // FAR: sparse-bright-on-dark is the only structural overlap
  "color-wipe": ["comet", "color-test"],
  "two-tone-gradient": ["color-test"],
};

/** Deterministic keyword retrieval: weighted substring hits, ties by library
 * order, zero-score fallback = breathing-pulse (smallest template). */
export function heuristicPick(ask: string): string {
  const a = ask.toLowerCase();
  let best: { id: string; score: number } = { id: "breathing-pulse", score: 0 };
  for (const t of TEMPLATES) {
    let score = 0;
    for (const [kw, w] of Object.entries(t.keywords)) if (a.includes(kw)) score += w;
    if (score > best.score) best = { id: t.id, score };
  }
  return best.id;
}
