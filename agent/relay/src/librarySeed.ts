/**
 * The built-in examples (agent/skill/examples/*.fx, the skill's starting points)
 * a new effects library starts with, so search_effects is useful from day one.
 * The sources are verbatim copies: library_test checks them against the files.
 * Their uniform manifests are read from the source (library.ts uniformsFromSource).
 */

export interface SeedEffect {
  file: string;
  name: string;
  description: string;
  tags: string[];
  source: string;
}

export const SEED_EFFECTS: SeedEffect[] = [
  {
    file: "solid_fill.fx",
    name: "Solid fill",
    description:
      "One warm colour over the whole fixture, optionally breathing slowly (brightness swells and dims). A calm, steady base: reading light, cosy evening, a single accent colour, or 'just make it orange'.",
    tags: ["calm", "solid", "static", "breathing", "warm", "simple"],
    source: "// Solid fill: one colour everywhere, with an optional gentle breathing.\nuniform vec3  color   : color = 1.0, 0.55, 0.2;\nuniform float breathe : 0.0 .. 1.0 = 0.0;\nuniform float rate    : 0.05 .. 2.0 = 0.25;\n\nstate float ph;     // breathing phase, in turns (0..1)\nstate float level;\n\nvoid update() {\n  // rate is radians/s: advance by rate / 2π turns per second.\n  ph = fract(ph + dt * rate * 0.159155);\n  level = 1.0 - breathe * (0.5 - 0.5 * cos(ph * 6.283185));\n}\n\nvec3 shade(Led led) {\n  return color * level;\n}\n",
  },
  {
    file: "height_gradient.fx",
    name: "Height gradient",
    description:
      "A two-colour vertical gradient up the fixture (bottom colour to top colour), with a gentle sideways drift. Sunset or sunrise skies (orange to blue), ocean depth, fire at the base fading to smoke; works on any fixture shape.",
    tags: ["gradient", "sunset", "sky", "vertical", "calm", "warm", "cool"],
    source: "// Height gradient: bottom colour to top colour, up the fixture (+Y).\n// led.uv.y is the LED's height normalized over the map (0 = lowest LED, 1 =\n// highest), so this fits any fixture without knowing its bounding box.\nuniform vec3  bottom : color = 0.9, 0.25, 0.05;\nuniform vec3  top    : color = 0.1, 0.2, 0.8;\nuniform float lo     : 0.0 .. 1.0 = 0.0;\nuniform float hi     : 0.0 .. 1.0 = 1.0;\nuniform float drift  : 0.0 .. 1.0 = 0.3;\n\nvec3 shade(Led led) {\n  float h = clamp((led.uv.y - lo) / max(hi - lo, 0.01), 0.0, 1.0);\n  float w = 0.15 * drift * sin(time * 0.7 + led.pos.x * 3.0);\n  return mix(bottom, top, clamp(h + w, 0.0, 1.0));\n}\n",
  },
  {
    file: "noise_field.fx",
    name: "Noise field",
    description:
      "Slowly drifting value noise (across and up the fixture) blended between two colours: organic, cloudy, always-changing patches; fixed point, so it is cheap on the device. A base for fire, water, aurora, lava or forest-canopy moods; tune scale for blob size and speed for calm vs lively.",
    tags: ["noise", "organic", "aurora", "water", "fire", "ambient", "slow"],
    source: "// Noise field: slowly drifting value noise over the fixture (led.uv: across and\n// up), blended between two colours. A good base for \"fire\", \"water\", \"aurora\"\n// moods. Fixed point: an 8x8 lattice of random values is built ONCE in update()\n// (stored 9x9 so the right/top neighbours need no wrap), and each LED does four\n// lattice lookups and three fixed mixes: under 40% of the cost of 3-D float\n// value noise from hash() (~9,000 cycles per LED on its own).\nuniform float scale : 1.0 .. 7.0 = 4.0;   // lattice cells across the fixture\nuniform float speed : 0.0 .. 2.0 = 0.3;\nuniform vec3  low   : color = 0.0, 0.05, 0.2;\nuniform vec3  high  : color = 0.1, 0.9, 0.6;\n\nstate fixed lat[81];\nstate bool seeded;\nstate fixed ox;\nstate fixed oy;\nstate fixed k;\n\nvoid update() {\n  if (!seeded) {\n    for (int i = 0; i < 81; i = i + 1) {\n      int c = (i % 9) % 8;\n      int r = (i / 9) % 8;\n      lat[i] = fixed(hash(float(r * 8 + c) * 1.37));\n    }\n    seeded = true;\n  }\n  // Integrate the drift (never `ox = time * speed`: moving the speed slider would\n  // jump the whole field), wrapped to the lattice.\n  ox = mod(ox + fixed(dt * speed), fixed(8.0));\n  oy = mod(oy + fixed(dt * speed * 0.6), fixed(8.0));\n  k = fixed(scale);\n}\n\nvec3 shade(Led led) {\n  fixed x = mod(fixed(led.uv.x) * k + ox, fixed(8.0));\n  fixed y = mod(fixed(led.uv.y) * k + oy, fixed(8.0));\n  int i = int(x) + int(y) * 9;\n  fixed fx = fract(x);\n  fixed fy = fract(y);\n  fixed a = mix(lat[i], lat[i + 1], fx);\n  fixed b = mix(lat[i + 9], lat[i + 10], fx);\n  return mix(low, high, float(mix(a, b, fy)));\n}\n",
  },
  {
    file: "segment_pulses.fx",
    name: "Segment pulses",
    description:
      "Bright pulses with fading tails racing along every strip segment, each segment with its own phase and hue (tint to rainbow). Energetic and rhythmic: party, chase lights, data flowing, festive.",
    tags: ["pulses", "chase", "energetic", "party", "rainbow", "motion"],
    source: "// Pulses along segments: bright heads with fading tails run along every strip\n// (led.s, 0..1 per segment); each segment gets its own phase and hue.\nuniform float speed   : 0.0 .. 3.0 = 0.6;\nuniform float tail    : 0.02 .. 0.6 = 0.2;\nuniform float pulses  : 1.0 .. 4.0 = 1.0;\nuniform float rainbow : 0.0 .. 1.0 = 0.5;\nuniform vec3  tint    : color = 0.3, 0.8, 1.0;\n\nstate float run;   // how far the pulses have run, in cycles (0..1)\n\nvoid update() {\n  // A rate knob is integrated, never `time * speed` (that jumps when it moves).\n  run = fract(run + dt * speed);\n}\n\nvec3 shade(Led led) {\n  float seg = float(led.seg);\n  float phase = fract(led.s * pulses - run + hash(seg));\n  float v = smoothstep(1.0 - tail, 1.0, phase);\n  vec3 hue = hsv2rgb(hash(seg * 3.0), 0.8, 1.0);\n  return mix(tint, hue, rainbow) * v;\n}\n",
  },
  {
    file: "texture_sampler.fx",
    name: "Texture sampler",
    description:
      "Shows a 32x32 texture top-down on the fixture (led.uv), fed live with stream_texture (solid, gradient, noise or your own frames); a faint base colour shows until frames arrive. For images, video-like animations or externally generated content.",
    tags: ["texture", "stream", "image", "video", "external"],
    source: "// Texture sampler: show a 32x32 texture on the fixture (top-down, led.uv).\n// Feed it with stream_texture {tex_index: 0, source: ...}. Until frames arrive\n// the texture is black, so a faint base colour shows the fixture is alive.\ntexture vec3 img(32, 32) : fixed8;\nuniform float gain : 0.0 .. 2.0 = 1.0;\nuniform vec3  base : color = 0.02, 0.02, 0.04;\n\nvec3 shade(Led led) {\n  return max(sample(img, led.uv) * gain, base);\n}\n",
  },
  {
    file: "rainbow_spin.fx",
    name: "Rainbow spin",
    description:
      "A full rainbow wrapped around the fixture that slowly rotates, with a gentle vertical wobble; saturation adjustable. Colourful, cheerful, festive: parties, kids' rooms, pride, celebrations. Written in fixed point (cheap on the device).",
    tags: ["rainbow", "spin", "rotating", "colourful", "festive", "party", "motion"],
    source: "// Rotating rainbow with a vertical wobble — the fixed-point pattern for cheap\n// per-LED maths: phases are `state fixed` in TURNS (1.0 = one revolution),\n// advanced once per frame in update(); shade() reads the LED as fixed and uses\n// the integer sin and hsv2rgb. About 20 ops per LED; a float version of the same\n// look costs ~1.5x as much.\nuniform float speed : 0.0 .. 4.0 = 1.0;\nuniform float waves : 0.5 .. 8.0 = 3.0;\nuniform float sat   : 0.0 .. 1.0 = 0.9;\n\nstate fixed ph1;\nstate fixed ph2;\nstate fixed k;\nstate fixed s;\n\nvoid update() {\n  ph1 = fract(ph1 + fixed(dt * speed * 0.25));\n  ph2 = fract(ph2 + fixed(dt * speed * 0.17));\n  k = fixed(waves);\n  s = fixed(sat);\n}\n\nvec3 shade(Led led) {\n  // Angle around the vertical axis: atan2 of fixed args is in turns (-0.5..0.5).\n  // It depends only on led.*, so the compiler computes it once per LED and\n  // caches it.\n  fixed ang = atan2(fixed(led.pos.z), fixed(led.pos.x)) + fixed(0.5);\n  // Every literal is wrapped in fixed(): a bare 0.125 would make this float.\n  fixed w = sin(fixed(led.uv.y) * k + ph2) * fixed(0.125);\n  return hsv2rgb(fract(ang + ph1 + w), s, fixed(1.0));\n}\n",
  },
  {
    file: "plasma_fixed.fx",
    name: "Plasma",
    description:
      "Classic demo-scene plasma: three travelling sine waves summed across the fixture and mapped to flowing hues. Psychedelic, trippy, lively colour fields: music, parties, retro vibes. Written in fixed point (cheap on the device).",
    tags: ["plasma", "psychedelic", "trippy", "waves", "colourful", "lively", "retro"],
    source: "// Plasma: three travelling sine waves summed over the fixture and mapped to a\n// hue — the classic \"trig-heavy\" look, written in fixed point. Each sin() takes\n// a fixed angle in TURNS (an integer LUT, ~150 cycles) instead of float radians\n// (~570), the phases advance once per frame in update(), and the colour is the\n// integer hsv2rgb. ~2.5x cheaper than the float version.\nuniform float speed : 0.0 .. 4.0 = 1.0;\nuniform float scale : 0.5 .. 4.0 = 1.5;   // waves across the fixture\nuniform float sat   : 0.0 .. 1.0 = 0.85;\n\nstate fixed p1;\nstate fixed p2;\nstate fixed p3;\nstate fixed k;\nstate fixed s;\n\nvoid update() {\n  p1 = fract(p1 + fixed(dt * speed * 0.16));\n  p2 = fract(p2 - fixed(dt * speed * 0.21));\n  p3 = fract(p3 + fixed(dt * speed * 0.11));\n  k = fixed(scale);\n  s = fixed(sat);\n}\n\nvec3 shade(Led led) {\n  fixed x = fixed(led.uv.x) * k;\n  fixed y = fixed(led.uv.y) * k;\n  fixed v = sin(x + p1) + sin(y * fixed(0.8) + p2) + sin((x + y) * fixed(0.7) + p3);\n  return hsv2rgb(fract(v * fixed(0.25) + p1), s, fixed(1.0));\n}\n",
  },
];
