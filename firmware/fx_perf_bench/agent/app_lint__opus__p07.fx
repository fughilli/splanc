// fx_agent_eval: variant=app_lint model=claude-opus-5-5 prompt=p07 status=ok calls=1 revised
// request: fireflies blinking at random
// Fireflies: each LED is a potential firefly that blinks on its own random
// rhythm. Every cycle it randomly decides whether to flash, so the pattern
// never repeats. Per-LED math is all int/fixed with integer hashing and no
// branches; all constants are hoisted fixed state (no float round-trips).

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
state fixed densK;     // density scaled to 0..1024 for integer-hash compare
state fixed kOne;
state fixed k16;
state fixed kInv1024;
// colour A and (B - A), plus ambient, per channel in fixed
state fixed aR;
state fixed aG;
state fixed aB;
state fixed dR;
state fixed dG;
state fixed dB;
state fixed mR;
state fixed mG;
state fixed mB;

void update() {
  float t = time * speed;
  float ft = floor(t);
  cyc = int(ft);
  phase = fixed(t - ft);
  invDuty = fixed(1.0 / duty);
  densK = fixed(density * 1024.0);
  kOne = fixed(1.0);
  k16 = fixed(16.0);
  kInv1024 = fixed(0.0009765625);
  vec3 cA = glow * bright;
  vec3 cD = glow2 * bright - cA;
  vec3 amb = night * ambient;
  aR = fixed(cA.x); aG = fixed(cA.y); aB = fixed(cA.z);
  dR = fixed(cD.x); dG = fixed(cD.y); dB = fixed(cD.z);
  mR = fixed(amb.x); mG = fixed(amb.y); mB = fixed(amb.z);
}

vec3 shade(Led led) {
  int i = led.idx;

  // Static per-LED randomness: phase offset, integer rate multiplier, and hue.
  int h1 = abs(i * 1103515245 + 12345);
  fixed off = fixed((h1 / 65536) % 1024) * kInv1024;
  int rate = 1 + (h1 / 16) % 3;

  // Per-LED cycle position. An integer rate keeps the phase continuous.
  fixed q = phase * fixed(rate) + off;
  fixed fq = floor(q);
  int cid = cyc * rate + int(fq);
  fixed p = q - fq;

  // Per-cycle random decision on whether this firefly flashes.
  int h2 = abs((i * 7919 + cid * 104729) * 1103515245 + 12345);
  fixed on = step(fixed((h2 / 65536) % 1024), densK);

  // Smooth flash envelope inside the duty window: (4u(1-u))^2.
  fixed u = min(p * invDuty, kOne);
  fixed b = u - u * u;
  b = b * b * k16 * on;

  // Colour varies per firefly between the two tints (all fixed per channel).
  fixed r = mR + (aR + dR * off) * b;
  fixed g = mG + (aG + dG * off) * b;
  fixed bl = mB + (aB + dB * off) * b;
  return vec3(float(r), float(g), float(bl));
}
