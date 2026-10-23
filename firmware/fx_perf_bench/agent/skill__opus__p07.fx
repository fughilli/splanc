// fx_agent_eval: variant=skill model=claude-opus-5-5 prompt=p07 status=ok calls=1
// request: fireflies blinking at random
// Fireflies: scattered LEDs light up at random moments with a soft glow,
// then fade back into a dim night. Each LED keeps its own rhythm, and each
// cycle a hash decides whether it flashes, so the pattern never repeats.
uniform float density : 0.0 .. 1.0 = 0.12;     // chance an LED flashes each cycle
uniform float speed   : 0.05 .. 3.0 = 0.6;     // overall pace of the blinking
uniform float glow    : 0.05 .. 0.9 = 0.35;    // flash length, as a share of a cycle
uniform vec3  fly     : color = 0.75, 1.0, 0.15;  // firefly colour
uniform float vary    : 0.0 .. 1.0 = 0.3;      // per-flash colour variation
uniform vec3  night   : color = 0.0, 0.012, 0.03; // background
uniform float bright  : 0.0 .. 1.0 = 1.0;

state float clock;
state float invGlow;

void update() {
  clock = clock + dt * speed;      // accumulated: speed changes don't jump
  invGlow = 1.0 / glow;
}

vec3 shade(Led led) {
  float id = float(led.idx);
  float r1 = hash(id * 1.731 + 0.5);
  float r2 = hash(id * 7.137 + 3.1);

  // Each LED has its own cycle length and phase.
  float t = clock * (0.6 + 0.8 * r1) + r2 * 17.0;
  float k = floor(t);
  float f = fract(t);

  // Does this LED flash in this cycle?
  float roll = hash(id * 0.917 + k * 13.37);
  if (roll >= density) {
    return night;
  }

  // Flash envelope: quick swell, slower fade (offset start within the cycle).
  float start = hash(k * 5.11 + id * 2.3) * (1.0 - glow);
  float x = (f - start) * invGlow;
  if (x <= 0.0 || x >= 1.0) {
    return night;
  }
  float e = sin(x * 3.14159);
  e = e * e;
  // bias toward a fast attack / long tail
  e = e * (1.0 - 0.4 * x);

  // Slight per-flash tint shift toward warm amber or cool green.
  float h = hash(k * 2.71 + id * 0.37) - 0.5;
  vec3 c = fly + vec3(h * 0.4, -abs(h) * 0.2, -h * 0.2) * vary;
  c = clamp(c, 0.0, 1.0);

  return night + c * (e * bright);
}
