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
      "Slowly moving 3-D value noise blended between two colours: organic, cloudy, always-changing patches. A base for fire, water, aurora, lava or forest-canopy moods; tune scale for blob size and speed for calm vs lively.",
    tags: ["noise", "organic", "aurora", "water", "fire", "ambient", "slow"],
    source: "// Noise field: slowly moving value noise over 3-D position (meters), mapped\n// between two colours. A good base for \"fire\", \"water\", \"aurora\" moods.\nuniform float scale    : 0.5 .. 10.0 = 3.0;\nuniform float speed    : 0.0 .. 2.0 = 0.3;\nuniform vec3  low      : color = 0.0, 0.05, 0.2;\nuniform vec3  high     : color = 0.1, 0.9, 0.6;\nuniform float contrast : 0.5 .. 3.0 = 1.5;\n\nstate float z;\n\nvoid update() {\n  // Integrate the drift (never `z = time * speed`: moving the speed slider would\n  // jump the whole field). Noise isn't periodic, so z isn't wrapped.\n  z = z + dt * speed;\n}\n\nvec3 shade(Led led) {\n  vec3 p = led.pos * scale + vec3(0.0, z, z * 0.5);\n  vec3 i = floor(p);\n  vec3 f = fract(p);\n  vec3 u = f * f * (3.0 - 2.0 * f);\n  float a = mix(hash(i), hash(i + vec3(1.0, 0.0, 0.0)), u.x);\n  float b = mix(hash(i + vec3(0.0, 1.0, 0.0)), hash(i + vec3(1.0, 1.0, 0.0)), u.x);\n  float c = mix(hash(i + vec3(0.0, 0.0, 1.0)), hash(i + vec3(1.0, 0.0, 1.0)), u.x);\n  float d = mix(hash(i + vec3(0.0, 1.0, 1.0)), hash(i + vec3(1.0, 1.0, 1.0)), u.x);\n  float n = mix(mix(a, b, u.y), mix(c, d, u.y), u.z);\n  float t = clamp((n - 0.5) * contrast + 0.5, 0.0, 1.0);\n  return mix(low, high, t);\n}\n",
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
];
