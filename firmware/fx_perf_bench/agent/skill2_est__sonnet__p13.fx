// fx_agent_eval: variant=skill2_est model=claude-sonnet-4-6 prompt=p13 status=ok calls=0 within_budget
// request: starfield twinkle
// Starfield twinkle: each LED is an independent star, dark most of the time
// with brief flares. Per-LED hashes give unique phases and twinkle rates;
// fixed-point sin (integer LUT, ~150 cycles) keeps the per-LED cost low.
// Inactive LEDs return black immediately, further halving average work.

uniform float speed   : 0.1 .. 4.0 = 1.2;   // master twinkle rate
uniform float density : 0.1 .. 1.0 = 0.65;  // fraction of LEDs that are stars
uniform float depth   : 0.0 .. 1.0 = 0.85;  // twinkle swing (0=steady glow, 1=full blink)
uniform float spread  : 0.0 .. 1.0 = 0.30;  // colour spread cool→warm
uniform vec3  cold    : color = 0.72, 0.82, 1.0;   // blue-white star
uniform vec3  warm    : color = 1.0,  0.75, 0.38;  // warm-orange star

state fixed t;

void update() {
  // Advance a shared 0..1 phase; each LED multiplies it by its own rate,
  // giving independent twinkle speeds without storing 500 phases.
  t = fract(t + fixed(dt * speed * 0.08));
}

vec3 shade(Led led) {
  // Three per-LED randoms — compiler caches hash(float(led.idx)) variants.
  float h0 = hash(float(led.idx));              // on/off seed + phase
  float h1 = hash(float(led.idx) * 1.618);      // individual rate
  float h2 = hash(float(led.idx) * 2.718);      // colour tint

  // Early-out for the (~35 %) dark gaps between stars.
  if (h0 > density) { return vec3(0.0, 0.0, 0.0); }

  // Individual twinkle rate 0.2 .. 1.0× base speed.
  fixed rate  = fixed(0.2) + fixed(h1) * fixed(0.8);
  // Phase offset so every star is out of sync with its neighbours.
  fixed phase = fixed(h0);
  fixed angle = fract(t * rate + phase);

  // sin in turns (-1..1) → 0..1; squaring pushes most values near zero
  // and keeps peaks sharp — the star flares briefly then dims again.
  fixed s     = sin(angle) * fixed(0.5) + fixed(0.5);
  fixed b     = s * s;

  // depth=0: constant glow; depth=1: full on/off swing.
  fixed out_b = fixed(1.0) - fixed(depth) + b * fixed(depth);

  // Colour: smooth spread between cool and warm star tones.
  float tint = h2 * spread;
  return mix(cold, warm, tint) * float(out_b);
}
