// Sparkle (from the #328 memo tests): per-LED random phase and rate from a hash
// of the LED index, a sharpened sine twinkle via pow.
uniform float rate : 0.1 .. 4.0 = 1.0;
state float t;
void update() { t = t + dt * rate; }
vec3 shade(Led led) {
  float ph = hash(float(led.idx) * 7.31 + 0.5);
  float sp = 0.6 + 0.8 * hash(float(led.idx) * 3.7 + 1.3);
  float b = pow(0.5 + 0.5 * sin((t * sp + ph) * 6.2831853), 8.0);
  return vec3(b, b, b);
}
