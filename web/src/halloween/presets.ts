/**
 * The Halloween effect pack for play mode (contract: HALLOWEEN_PRESETS). Each
 * preset is effect source the app compiles and deploys to deck A, its default
 * uniforms, and the 1-2 uniforms play mode shows as sliders.
 *
 * Written for the installs' fixtures: an LED curtain draped over pumpkins on
 * channel 0 and an LED rope snaked on the ground on channel 1, each camera-mapped
 * on site. So the looks never assume a clean grid:
 *   - spatial looks use height (`led.uv.y`, 0 = lowest LED .. 1 = highest) and
 *     ~10-30 cm 3D cells of `led.pos` (patches), never a column/row index, and
 *     horizontal motion uses `led.pos.x + led.pos.z` (heading-independent enough);
 *   - curtain vs rope uses the CHANNEL SPLIT: CH1 (the rope) starts at LED n0 =
 *     channel 0's LED count. The effect language has no channel input, so every
 *     preset declares `uniform float rope_start` (ROPE_START_UNIFORM) and the app
 *     sets it from Hardware Setup's channel 0 count when it deploys the preset
 *     (see ropeStartFor). 0 (the default) = no rope: everything is curtain.
 *
 * Cost (C6 cost model, 432-LED curtain + 120-LED rope): 27-36 ms per frame, i.e.
 * ~28-37 fps, above the autoscaler's 25 fps floor; phases are integrated in
 * update() so the sliders never jump. Sources are compiled + linted by
 * //fx_compiler:halloween_presets_test.
 */

export interface HalloweenPreset {
  id: string;
  name: string;
  emoji: string;
  /** Effect source (compiled by the app before deploy). */
  source: string;
  /** Default uniform values by name (the source's own defaults; rope_start is
   * filled in at deploy time, see ropeStartFor). */
  uniforms: Record<string, number | number[]>;
  /** Uniform names play mode shows as sliders (1-2). */
  sliders: string[];
  /** The calm show the fixture returns to when idle (kiosk attract). */
  attract?: boolean;
}

/** The uniform every preset reads to tell the rope (CH1) from the curtain (CH0). */
export const ROPE_START_UNIFORM = "rope_start";

/** rope_start for a device's channel config: channel 0's LED count when channel
 * 1 has LEDs (the rope starts right after the curtain), else 0 (no rope). Pass
 * the `channels` of get_hardware_config's hardware_config_state. */
export function ropeStartFor(channels: ReadonlyArray<{ channel: number; ledCount: number }>): number {
  const n = (ch: number): number => Math.max(0, channels.find((c) => c.channel === ch)?.ledCount ?? 0);
  return n(1) > 0 ? n(0) : 0;
}

/** A preset's uniforms with rope_start set for this device. */
export function presetUniforms(
  p: HalloweenPreset,
  ropeStart: number,
): Record<string, number | number[]> {
  return { ...p.uniforms, [ROPE_START_UNIFORM]: ropeStart };
}

export const HALLOWEEN_PRESETS: HalloweenPreset[] = [
  {
    id: "pumpkin-candles",
    name: "Pumpkin Candles",
    emoji: "🕯️",
    sliders: ["speed", "warmth"],
    uniforms: { speed: 1, warmth: 0.4 },
    source: `// Jack-o'-lantern candles: warm orange flicker in patches, like candles inside pumpkins.
// The rope glows like embers.
uniform float speed : 0.2 .. 3.0 = 1.0;
uniform float warmth : 0.0 .. 1.0 = 0.4;
// First LED of channel 1 (the rope). The app sets it from Hardware Setup; 0 = no rope.
uniform float rope_start : 0.0 .. 2048.0 = 0.0;
state fixed ph;
state fixed ph2;
state fixed hue;
state int rope_i;
void update() {
  ph = fract(ph + fixed(dt * speed * 1.3));
  ph2 = fract(ph2 + fixed(dt * speed * 0.41));
  hue = fixed(0.025 + warmth * 0.08);
  rope_i = int(rope_start);
  if (rope_i <= 0) { rope_i = 1000000; }
}
vec3 shade(Led led) {
  // a flame "patch" id from the LED's 3D cell (~25 cm), cached once per LED
  fixed r = fixed(hash(floor(led.pos.x * 4.0) + floor(led.pos.y * 4.0) * 17.0 + floor(led.pos.z * 4.0) * 131.0));
  fixed j = fixed(hash(float(led.idx)));
  fixed h = fixed(led.uv.y);
  fixed f = sin(ph + r) * fixed(0.22) + sin(ph2 * fixed(3.0) + r * fixed(2.0)) * fixed(0.14) + fixed(0.62) + j * fixed(0.1);
  fixed v = clamp(f * (fixed(1.0) - h * fixed(0.45)), fixed(0.0), fixed(1.0));
  if (led.idx >= rope_i) { v = v * fixed(0.45); }
  return hsv2rgb(hue + j * fixed(0.025), fixed(1.0), v * v);
}
`,
  },
  {
    id: "graveyard-fog",
    name: "Graveyard Fog",
    emoji: "🌫️",
    sliders: ["speed", "green"],
    uniforms: { speed: 0.3, green: 0.5 },
    source: `// Graveyard fog: purple and green fog banks rolling low across the curtain; the rope is the ground mist.
uniform float speed : 0.05 .. 1.0 = 0.3;
uniform float green : 0.0 .. 1.0 = 0.5;
// First LED of channel 1 (the rope). The app sets it from Hardware Setup; 0 = no rope.
uniform float rope_start : 0.0 .. 2048.0 = 0.0;
state fixed ph;
state fixed ph2;
state fixed g;
state int rope_i;
void update() {
  ph = fract(ph + fixed(dt * speed * 0.5));
  ph2 = fract(ph2 + fixed(dt * speed * 0.23));
  g = fixed(green);
  rope_i = int(rope_start);
  if (rope_i <= 0) { rope_i = 1000000; }
}
vec3 shade(Led led) {
  fixed u = fixed((led.pos.x + led.pos.z) * 0.7);
  fixed r = fixed(hash(floor(led.pos.x * 3.0) + floor(led.pos.y * 3.0) * 17.0 + floor(led.pos.z * 3.0) * 131.0));
  fixed h = fixed(led.uv.y);
  fixed w = sin(u + h * fixed(0.3) - ph + r * fixed(0.15)) * fixed(0.5) + fixed(0.5);
  fixed w2 = sin(ph2 - u * fixed(0.6) + h * fixed(0.4)) * fixed(0.5) + fixed(0.5);
  fixed hue = mix(fixed(0.79), fixed(0.36), clamp(w2 * g * fixed(2.0), fixed(0.0), fixed(1.0)));
  fixed v = (w * fixed(0.75) + fixed(0.1)) * (fixed(1.05) - h * fixed(0.6));
  if (led.idx >= rope_i) { v = w * fixed(0.5) + fixed(0.2); }
  return hsv2rgb(hue, fixed(0.85), v * v);
}
`,
  },
  {
    id: "thunderstorm",
    name: "Thunderstorm",
    emoji: "⚡",
    sliders: ["storm", "power"],
    uniforms: { storm: 0.45, power: 1 },
    source: `// Thunderstorm: a dark stormy blue sky, then lightning strikes that flash and re-flicker across the curtain.
uniform float storm : 0.1 .. 1.0 = 0.45;
uniform float power : 0.2 .. 1.0 = 1.0;
// First LED of channel 1 (the rope). The app sets it from Hardware Setup; 0 = no rope.
uniform float rope_start : 0.0 .. 2048.0 = 0.0;
state float wait;
state float flash;
state float re;
state float bolt;
state fixed fl;
state fixed bx;
state fixed ph;
state int rope_i;
void update() {
  wait = wait - dt;
  if (wait <= 0.0) {
    flash = power;
    re = 0.12 + hash(time * 3.1) * 0.15;
    bolt = hash(time * 7.3);
    wait = 0.5 + hash(time * 1.7) * 5.0 / storm;
  }
  if (re > 0.0) {
    re = re - dt;
    if (re <= 0.0) { flash = power * 0.8; }
  }
  flash = max(flash - dt * 4.0 * flash - dt * 0.2, 0.0);
  fl = fixed(flash);
  bx = fixed(bolt);
  ph = fract(ph + fixed(dt * 0.07));
  rope_i = int(rope_start);
  if (rope_i <= 0) { rope_i = 1000000; }
}
vec3 shade(Led led) {
  fixed r = fixed(hash(floor(led.pos.x * 5.0) + floor(led.pos.y * 5.0) * 17.0 + floor(led.pos.z * 5.0) * 131.0));
  fixed h = fixed(led.uv.y);
  // the bolt's reach: brighter high up and in this strike's random patch set
  fixed reach = clamp(h * fixed(0.8) + fixed(0.5) - abs(r - bx) * fixed(1.6), fixed(0.0), fixed(1.0));
  fixed s = fl * reach;
  fixed amb = (sin(ph + r * fixed(0.5)) * fixed(0.5) + fixed(0.5)) * fixed(0.06) + fixed(0.03);
  if (led.idx >= rope_i) { s = fl * fixed(0.4); }
  fixed v = clamp(amb + s, fixed(0.0), fixed(1.0));
  return hsv2rgb(fixed(0.64), fixed(0.9) - s * fixed(0.85), v);
}
`,
  },
  {
    id: "ghost-wisps",
    name: "Ghost Wisps",
    emoji: "👻",
    sliders: ["speed", "ghosts"],
    uniforms: { speed: 0.35, ghosts: 0.5 },
    source: `// Ghost wisps: pale ghosts drift up the curtain and fade; faint violet spirits slide along the rope.
uniform float speed : 0.05 .. 1.0 = 0.35;
uniform float ghosts : 0.1 .. 1.0 = 0.5;
// First LED of channel 1 (the rope). The app sets it from Hardware Setup; 0 = no rope.
uniform float rope_start : 0.0 .. 2048.0 = 0.0;
state fixed ph;
state fixed amt;
state int rope_i;
state fixed inv_len;
void update() {
  ph = fract(ph + fixed(dt * speed * 0.5));
  amt = fixed(ghosts);
  rope_i = int(rope_start);
  if (rope_i <= 0) { rope_i = 1000000; }
}
vec3 shade(Led led) {
  fixed r = fixed(hash(floor((led.pos.x + led.pos.z) * 6.0) + floor(led.pos.z * 4.0) * 31.0));
  fixed h = fixed(led.uv.y);
  fixed y = fract(ph - h * fixed(0.7) - r);
  fixed v = clamp(fixed(1.0) - y * fixed(5.0), fixed(0.0), fixed(1.0));
  v = v * v * step(r * fixed(1.4), amt + fixed(0.2));
  fixed sat = fixed(0.25);
  if (led.idx >= rope_i) {
    fixed q = fract(ph * fixed(2.0) - fixed(float(led.idx) * 0.03));
    v = clamp(fixed(1.0) - q * fixed(4.0), fixed(0.0), fixed(1.0)) * fixed(0.6);
    sat = fixed(0.6);
  }
  return hsv2rgb(fixed(0.55) + v * fixed(0.2), sat, v + fixed(0.02));
}
`,
  },
  {
    id: "toxic-ooze",
    name: "Toxic Ooze",
    emoji: "🧪",
    sliders: ["speed", "glow"],
    uniforms: { speed: 0.3, glow: 0.8 },
    source: `// Toxic ooze: radioactive green slime drips down the curtain into a bubbling pool on the rope.
uniform float speed : 0.05 .. 1.0 = 0.3;
uniform float glow : 0.2 .. 1.0 = 0.8;
// First LED of channel 1 (the rope). The app sets it from Hardware Setup; 0 = no rope.
uniform float rope_start : 0.0 .. 2048.0 = 0.0;
state fixed ph;
state fixed ph2;
state fixed gl;
state int rope_i;
void update() {
  ph = fract(ph + fixed(dt * speed * 0.35));
  ph2 = fract(ph2 + fixed(dt * 0.4));
  gl = fixed(glow);
  rope_i = int(rope_start);
  if (rope_i <= 0) { rope_i = 1000000; }
}
vec3 shade(Led led) {
  // drip column: a ~10 cm horizontal cell; its rate (1..3 drips per cycle) and offset
  fixed r = fixed(hash(floor((led.pos.x + led.pos.z) * 9.0)));
  fixed k = floor(r * fixed(3.0)) + fixed(1.0);
  fixed h = fixed(led.uv.y);
  fixed d = fract(ph * k + r * fixed(7.0));
  fixed head = fixed(1.0) - d * fixed(1.2);
  fixed t = h - head;
  fixed drip = clamp(fixed(1.0) - t * fixed(3.0), fixed(0.0), fixed(1.0)) * step(fixed(0.0), t);
  fixed slime = clamp((h - fixed(0.82)) * fixed(6.0), fixed(0.0), fixed(1.0)) * (sin(ph2 + r) * fixed(0.3) + fixed(0.7));
  fixed v = max(drip, slime);
  if (led.idx >= rope_i) { v = sin(ph2 * fixed(3.0) + r * fixed(2.0)) * fixed(0.3) + fixed(0.6); }
  return hsv2rgb(fixed(0.3) - v * fixed(0.06), fixed(1.0), (v * fixed(0.95) + fixed(0.05)) * gl);
}
`,
  },
  {
    id: "eyes-in-the-dark",
    name: "Eyes in the Dark",
    emoji: "👀",
    sliders: ["eyes", "blink"],
    uniforms: { eyes: 0.5, blink: 0.6 },
    source: `// Eyes in the dark: pairs of glowing eyes open in the curtain, blink, and vanish; the rope smoulders red.
uniform float eyes : 0.1 .. 1.0 = 0.5;
uniform float blink : 0.1 .. 2.0 = 0.6;
// First LED of channel 1 (the rope). The app sets it from Hardware Setup; 0 = no rope.
uniform float rope_start : 0.0 .. 2048.0 = 0.0;
state fixed ep;
state fixed bl;
state fixed amt;
state fixed ph;
state int rope_i;
void update() {
  ep = fract(ep + fixed(dt * 0.05));
  bl = fract(bl + fixed(dt * blink * 0.5));
  amt = fixed(eyes * 0.5);
  ph = fract(ph + fixed(dt * 0.2));
  rope_i = int(rope_start);
  if (rope_i <= 0) { rope_i = 1000000; }
}
vec3 shade(Led led) {
  // a creature cell ~30 cm wide x 20 cm tall; its eyes are the upper-left/right quarters
  float cu = (led.pos.x + led.pos.z) * 3.3;
  float cv = led.pos.y * 5.0;
  fixed r = fixed(hash(floor(cu) + floor(cv) * 57.0));
  fixed eye = fixed(step(0.4, fract(cv)) * step(abs(fract(cu) - 0.5), 0.42) * step(0.08, abs(fract(cu) - 0.5)));
  fixed life = fract(ep + r * fixed(3.0));
  fixed open = clamp(fixed(1.0) - abs(life - amt * fixed(0.5)) / (amt * fixed(0.5) + fixed(0.01)), fixed(0.0), fixed(1.0));
  fixed bk = step(fixed(0.06), fract(bl + r * fixed(5.0)));
  fixed v = clamp(open * fixed(3.0), fixed(0.0), fixed(1.0)) * bk * eye;
  fixed hue = r * fixed(0.18);
  if (led.idx >= rope_i) {
    v = (sin(ph + r) * fixed(0.25) + fixed(0.35));
    hue = fixed(0.0);
  }
  return hsv2rgb(hue, fixed(1.0), max(v, fixed(0.015)));
}
`,
  },
  {
    id: "rope-snake",
    name: "Rope Snake",
    emoji: "🐍",
    sliders: ["speed", "length"],
    uniforms: { speed: 0.6, length: 0.2 },
    source: `// Rope snake: a green serpent slithers along the rope while the curtain breathes a slow purple.
uniform float speed : 0.1 .. 2.0 = 0.6;
uniform float length : 0.05 .. 0.6 = 0.2;
// First LED of channel 1 (the rope). The app sets it from Hardware Setup; 0 = no rope.
uniform float rope_start : 0.0 .. 2048.0 = 0.0;
state fixed ph;
state fixed ph2;
state fixed il;
state int rope_i;
state fixed inv_n;
state fixed start;
void update() {
  ph = fract(ph + fixed(dt * speed * 0.25));
  ph2 = fract(ph2 + fixed(dt * 0.12));
  il = fixed(1.0 / length);
  rope_i = int(rope_start);
  start = fixed(rope_start);
  inv_n = fixed(1.0 / max(float(led.count) - rope_start, 1.0));
  if (rope_i <= 0) { rope_i = 1000000; }
}
vec3 shade(Led led) {
  fixed h = fixed(led.uv.y);
  fixed r = fixed(hash(float(led.idx)));
  if (led.idx >= rope_i) {
    fixed s = (fixed(led.idx) - start) * inv_n;
    fixed d = fract(ph - s);
    fixed v = clamp(fixed(1.0) - d * il, fixed(0.0), fixed(1.0));
    fixed scales = sin(s * fixed(25.0)) * fixed(0.25) + fixed(0.75);
    return hsv2rgb(fixed(0.3) + v * fixed(0.05), fixed(1.0), v * scales + fixed(0.02));
  }
  fixed b = sin(ph2 + h * fixed(0.5) + r * fixed(0.2)) * fixed(0.5) + fixed(0.5);
  return hsv2rgb(fixed(0.77), fixed(0.9), b * b * fixed(0.5) + fixed(0.04));
}
`,
  },
  {
    id: "haunted-glow",
    name: "Haunted Glow",
    emoji: "🎃",
    sliders: ["speed", "level"],
    uniforms: { speed: 0.25, level: 0.8 },
    attract: true,
    source: `// Haunted glow (attract show): calm, slowly shifting pumpkin orange, witchy purple and slime green; embers drift along the rope.
uniform float speed : 0.05 .. 1.0 = 0.25;
uniform float level : 0.2 .. 1.0 = 0.8;
// First LED of channel 1 (the rope). The app sets it from Hardware Setup; 0 = no rope.
uniform float rope_start : 0.0 .. 2048.0 = 0.0;
state fixed ph;
state fixed ph2;
state fixed lv;
state int rope_i;
void update() {
  ph = fract(ph + fixed(dt * speed * 0.08));
  ph2 = fract(ph2 + fixed(dt * speed * 0.3));
  lv = fixed(level);
  rope_i = int(rope_start);
  if (rope_i <= 0) { rope_i = 1000000; }
}
vec3 shade(Led led) {
  fixed r = fixed(hash(floor(led.pos.x * 3.0) + floor(led.pos.y * 3.0) * 17.0 + floor(led.pos.z * 3.0) * 131.0));
  fixed h = fixed(led.uv.y);
  // three-colour cycle: orange 0.06 -> purple 0.78 -> green 0.33, picked by a slow wave
  fixed w = fract(ph + h * fixed(0.25) + r * fixed(0.08));
  fixed hue = fixed(0.06);
  if (w > fixed(0.333)) { hue = fixed(0.78); }
  if (w > fixed(0.667)) { hue = fixed(0.36); }
  fixed b = sin(ph2 + r * fixed(0.6) + h * fixed(0.3)) * fixed(0.3) + fixed(0.7);
  if (led.idx >= rope_i) {
    hue = fixed(0.05);
    b = sin(ph2 * fixed(4.0) - fixed(led.idx) * fixed(0.05)) * fixed(0.4) + fixed(0.5);
  }
  return hsv2rgb(hue, fixed(0.95), b * b * lv);
}
`,
  },
];
