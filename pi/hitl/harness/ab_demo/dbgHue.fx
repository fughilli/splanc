// FX debugger HITL gate (hitl_fx_debug.py): float maths, a state integrator, a
// vec3 uniform and smoothstep — replayed bit-exactly on the host.
uniform float speed : 0.0 .. 4.0 = 1.3;
uniform vec3 tint : color = vec3(1.0, 0.7, 0.4);
state float phase;
void update() { phase = fract(phase + dt * speed); }
vec3 shade(Led led) {
  float h = fract(led.pos.x * 2.0 + phase);
  float w = smoothstep(0.2, 0.8, fract(led.pos.y * 3.0 + time * 0.5));
  return hsv2rgb(h, 0.8, 0.3 + 0.7 * w) * tint;
}
