// fx_agent_eval: variant=skill model=claude-opus-5-5 prompt=p13 status=ok calls=1
// request: starfield twinkle
// Starfield twinkle: a night sky wrapped around the lamp. A sparse set of LEDs
// are stars; each one slowly fades in, twinkles with its own rhythm and colour
// temperature, then fades out and is reborn elsewhere in time, so the sky
// keeps changing. Everything is per-LED hash, so it suits any shape and stays
// cheap (no smoothstep/pow in the hot path).

uniform float density    : 0.0 .. 1.0 = 0.22;        // share of LEDs that are stars at a time
uniform float twinkle    : 0.0 .. 4.0 = 1.2;         // twinkle speed (Hz-ish)
uniform float depth      : 0.0 .. 1.0 = 0.7;         // how deep each twinkle dips
uniform float lifetime   : 1.0 .. 30.0 = 9.0;        // seconds a star lives before re-seeding
uniform vec3  warm       : color = 1.0, 0.78, 0.5;   // warm star colour
uniform vec3  cool       : color = 0.6, 0.75, 1.0;   // cool star colour
uniform vec3  night      : color = 0.01, 0.015, 0.06; // sky between the stars
uniform float sky        : 0.0 .. 1.0 = 0.5;         // sky glow amount
uniform float brightness : 0.0 .. 1.0 = 1.0;         // overall star brightness

state float tw;
state float lt;
state float skyBreath;

void update() {
  tw = time * twinkle * 6.2832;
  lt = time / lifetime;
  skyBreath = sky * (0.85 + 0.15 * sin(time * 0.2));
}

vec3 shade(Led led) {
  float id = float(led.idx);
  float h1 = hash(id * 1.37 + 0.5);
  float h2 = hash(id * 7.13 + 2.1);
  float h3 = hash(id * 3.71 + 9.4);

  // Life cycle: each LED runs its own slow cycle; every new generation
  // re-rolls whether it is a star.
  float cyc = lt * (0.6 + 0.8 * h2) + h1;
  float gen = floor(cyc);
  float p = cyc - gen;
  float on = step(hash(id + gen * 17.3), density);
  float env = sin(p * 3.14159);
  env = env * env;

  // Twinkle: per-star rate and phase, squared for sharper glints.
  float f = 0.5 + 0.5 * sin(tw * (0.5 + h3) + h1 * 6.2832);
  f = f * f;

  float b = on * env * (1.0 - depth + depth * f) * (0.35 + 0.65 * h3);
  vec3 sc = mix(warm, cool, h2);

  return night * skyBreath + sc * (b * brightness);
}
