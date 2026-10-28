// FX debugger HITL gate: a bounded loop, hash noise, an array state and pow —
// more opcodes for the JIT to compile and the replay to match.
state float acc[4];
void update() {
  for (int k = 0; k < 4; k = k + 1) {
    acc[k] = fract(acc[k] + dt * (0.3 + 0.2 * float(k)));
  }
}
vec3 shade(Led led) {
  float s = 0.0;
  for (int k = 0; k < 4; k = k + 1) {
    s = s + sin(led.pos.x * (3.0 + float(k)) + acc[k] * 6.2831);
  }
  float n = hash(led.pos * 7.0 + vec3(acc[0], acc[1], acc[2]));
  float v = pow(clamp(0.5 + 0.25 * s, 0.0, 1.0), 1.5);
  return vec3(v, n * 0.5, 1.0 - v);
}
