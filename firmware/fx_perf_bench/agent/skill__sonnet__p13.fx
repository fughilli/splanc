// fx_agent_eval: variant=skill model=claude-sonnet-4-6 prompt=p13 status=ok calls=3
// request: starfield twinkle
// Starfield twinkle — each LED is an independent star that pulses in and out
// at its own random rate, spending most of its time near-black between flashes.

uniform float density : 0.0 .. 1.0 = 0.70;        // fraction of LEDs that are active stars
uniform float speed   : 0.1 .. 4.0 = 0.9;         // overall twinkle cadence
uniform float shimmer : 0.0 .. 1.0 = 0.35;        // depth of rapid secondary flicker on each peak
uniform vec3  cool    : color = 0.72, 0.86, 1.0;  // blue-white star tint
uniform vec3  warm    : color = 1.00, 0.90, 0.50; // warm-white star tint
uniform float warmth  : 0.0 .. 1.0 = 0.20;        // fraction of warm stars (0 = all cool)
uniform float glow    : 0.0 .. 0.05 = 0.005;      // faint deep-sky background level

vec3 shade(Led led) {
  float idx = float(led.idx);

  // Three independent per-LED random values (cheap integer hash)
  float r0 = hash(idx);              // density gate & primary phase offset
  float r1 = hash(idx + 500.0);      // individual rate & shimmer phase
  float r2 = hash(idx + 1000.0);     // colour type

  // Sky: near-black with a faint blue tint
  vec3 sky = vec3(glow * 0.4, glow * 0.5, glow);

  // Most LEDs are empty sky — early out keeps the budget low
  if (r0 > density) { return sky; }

  // Each star has its own rate in [0.5 .. 2.0] × speed
  float rate = speed * (0.5 + r1 * 1.5);

  // Main twinkle: cosine oscillator raised to the 4th power → narrow bright peak,
  // star spends most of its period near zero  (two cheap multiplications, no pow)
  float osc = 0.5 + 0.5 * cos((time * rate + r0) * 6.28318);
  float b   = osc * osc;
  b         = b * b;

  // Shimmer: a faster secondary cosine fidgets the peak subtly
  float flick = 0.5 + 0.5 * cos((time * rate * 5.3 + r1) * 6.28318);
  b = b * (1.0 - shimmer * 0.4 * (1.0 - flick));

  // Colour: blue-white or warm-white, fixed per LED
  vec3 col = mix(cool, warm, step(1.0 - warmth, r2));

  return col * b + sky;
}
