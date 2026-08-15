// Probe effect for the uniform-update drop-rate/bandwidth HITL bench
// (pi/hitl/harness/uniform_bench.py). One float uniform in slot 0 so the bench
// can blast set_uniforms at a known slot; shade just paints it as grey.
uniform float amount : 0.0 .. 1.0 = 0.0;
void update() {}
vec3 shade(Led led) {
  return vec3(amount, amount, amount);
}
