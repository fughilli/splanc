// fx_agent_eval: variant=app model=claude-opus-5-5 prompt=p13 status=ok calls=1
// request: starfield twinkle
// Starfield twinkle: sparse stars that twinkle at their own rates and phases, over a dim night sky.
uniform float density : 0.02 .. 1.0 = 0.25;
uniform float speed : 0.0 .. 3.0 = 0.6;
uniform float sharpness : 1.0 .. 3.0 = 2.0;
uniform float floorGlow : 0.0 .. 0.6 = 0.08;
uniform vec3 coolStar : color = 0.55, 0.7, 1.0;
uniform vec3 warmStar : color = 1.0, 0.8, 0.5;
uniform vec3 sky : color = 0.0, 0.004, 0.015;

state fixed ph;
state fixed densF;
state fixed sharpMix;
state float acc;

void update() {
  // Keep a wrapped accumulator so speed changes stay smooth.
  acc = fract(acc + dt * speed * 0.25);
  ph = fixed(acc);
  densF = fixed(density * 1000.0);
  sharpMix = fixed(clamp(sharpness - 1.0, 0.0, 2.0) * 0.5);
}

vec3 shade(Led led) {
  int i = led.idx;
  // Cheap integer per-LED hashes.
  int h1 = (i * 7919 + 1237) % 1000;
  int h2 = (i * 4561 + 911) % 997;
  int h3 = (i * 2903 + 77) % 991;

  // Decide whether this LED is a star.
  fixed star = step(fixed(h1), densF);

  // Use integer rate multiples so the twinkle stays continuous when the phase wraps.
  fixed rate = fixed(1 + h2 % 6);
  fixed phase = fract(ph * rate + fixed(h3) / fixed(991));
  fixed s = sin(phase) * fixed(0.5) + fixed(0.5);

  // Sharpen the peaks: blend between s^2 and s^4.
  fixed s2 = s * s;
  fixed tw = mix(s2, s2 * s2, sharpMix);

  // Give each star its own magnitude.
  fixed mag = fixed(0.3) + fixed(0.7) * fixed(h2 % 100) / fixed(100);
  fixed b = star * mag * mix(fixed(floorGlow), fixed(1.0), tw);

  fixed warmth = fixed(h3 % 100) / fixed(100);
  vec3 col = mix(coolStar, warmStar, float(warmth));
  return sky + col * float(b);
}
