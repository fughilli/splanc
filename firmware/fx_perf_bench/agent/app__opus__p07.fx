// fx_agent_eval: variant=app model=claude-opus-5-5 prompt=p07 status=ok calls=1
// request: fireflies blinking at random
// Fireflies: each LED is a potential firefly that blinks on its own random
// rhythm. Every cycle it randomly decides whether to flash, so the pattern
// never repeats. Per-LED math is all int/fixed with integer hashing and no
// branches.

uniform float speed   : 0.05 .. 1.0 = 0.22;   // base blink cycles per second
uniform float duty    : 0.03 .. 0.4 = 0.12;   // fraction of a cycle spent glowing
uniform float density : 0.0 .. 1.0 = 0.3;     // chance a firefly flashes each cycle
uniform float bright  : 0.0 .. 1.0 = 1.0;
uniform vec3 glow     : color = 1.0, 0.85, 0.15;
uniform vec3 glow2    : color = 0.55, 1.0, 0.1;
uniform float ambient : 0.0 .. 0.1 = 0.006;
uniform vec3 night    : color = 0.02, 0.05, 0.12;

state fixed phase;
state int cyc;
state fixed invDuty;
state fixed dens;
state vec3 cA;
state vec3 cB;
state vec3 amb;

void update() {
  float t = time * speed;
  float ft = floor(t);
  cyc = int(ft);
  phase = fixed(t - ft);
  invDuty = fixed(1.0 / duty);
  dens = fixed(density);
  cA = glow * bright;
  cB = glow2 * bright;
  amb = night * ambient;
}

vec3 shade(Led led) {
  int i = led.idx;

  // Static per-LED randomness: phase offset, integer rate multiplier, and hue.
  int h1 = abs(i * 1103515245 + 12345);
  fixed off = fixed((h1 / 65536) % 1024) * 0.0009765625;
  int rate = 1 + (h1 / 16) % 3;

  // Per-LED cycle position. An integer rate keeps the phase continuous.
  fixed q = phase * fixed(rate) + off;
  fixed fq = floor(q);
  int cid = cyc * rate + int(fq);
  fixed p = q - fq;

  // Per-cycle random decision on whether this firefly flashes.
  int h2 = abs((i * 7919 + cid * 104729) * 1103515245 + 12345);
  fixed r = fixed((h2 / 65536) % 1024) * 0.0009765625;
  fixed on = step(r, dens);

  // Smooth flash envelope inside the duty window.
  fixed u = min(p * invDuty, 1.0);
  fixed b = u * (1.0 - u) * 4.0;
  b = b * b * on;

  // Colour varies per firefly between the two tints.
  vec3 col = mix(cA, cB, float(off));
  return amb + col * float(b);
}
